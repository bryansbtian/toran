#!/usr/bin/env node
// SPDX-License-Identifier: MIT

/**
 * Runs a development instance on this machine's LAN address, so other people on
 * the same network can open a share link.
 *
 * Share URLs are built from `TORAN_APP_URL`, and downloads redirect the browser
 * straight to object storage, so both the app origin and the storage origin have
 * to be addresses a *different* machine can resolve. `localhost` is neither -
 * which is why this, rather than a bare `turbo run dev`, is what `npm run dev`
 * runs. A link you copy out of a `localhost` instance is not a link you can send
 * anyone.
 *
 *   npm run dev                                detect, configure, start
 *   npm run dev -- --address 10.0.0.7          use a specific address
 *   npm run dev -- --revert                    back to localhost
 *
 * With no network to bind to it falls back to localhost rather than refusing to
 * start, so working offline still works. `npm run dev:local` skips all of this
 * and starts the servers against whatever `.env` already says.
 *
 * Development only. It writes http:// URLs and publishes MinIO to the network,
 * both of which production start-up checks reject outright.
 */
import { existsSync } from 'node:fs';
import { copyFile, readFile, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { networkInterfaces } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const envPath = path.join(root, '.env');
const composeFile = 'docker-compose.dev.yml';

const step = (message) => console.log(`\n==> ${message}`);
const ok = (message) => console.log(`    ✓ ${message}`);
const warn = (message) => console.log(`    ! ${message}`);
const fail = (message) => console.error(`    ✗ ${message}`);

/**
 * Builds an npm invocation that needs no shell.
 *
 * On Windows npm is a `.cmd` shim, and Node refuses to spawn one unless
 * `shell: true` (the CVE-2024-27980 fix), which would reintroduce cmd.exe
 * quoting. npm exports its own JS entry point in `npm_execpath`, and this Node
 * binary can run that directly. The fallbacks cover being invoked as
 * `node scripts/dev-lan.mjs`, where npm has set nothing.
 */
function npmCommand(args) {
  const npmCli = process.env.npm_execpath;
  if (npmCli) return [process.execPath, [npmCli, ...args]];
  if (process.platform !== 'win32') return ['npm', args];
  const bundled = path.join(
    path.dirname(process.execPath),
    'node_modules',
    'npm',
    'bin',
    'npm-cli.js',
  );
  return [process.execPath, [bundled, ...args]];
}

/**
 * Runs a command without a shell, so arguments reach the process verbatim and
 * nothing depends on cmd.exe, PowerShell or sh quoting rules.
 */
function run(command, args, { quiet = false } = {}) {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd: root,
      stdio: quiet ? ['ignore', 'pipe', 'pipe'] : 'inherit',
      shell: false,
    });
    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (chunk) => (stdout += chunk.toString()));
    child.stderr?.on('data', (chunk) => (stderr += chunk.toString()));
    child.on('error', (error) => resolve({ code: 1, stdout, stderr: String(error) }));
    child.on('close', (code) => resolve({ code: code ?? 1, stdout, stderr }));
  });
}

/**
 * Adapters that have an address but are never the network you are sharing on.
 * Covers Windows (vEthernet, Hyper-V), Linux (docker0, br-*, veth*, virbr*) and
 * macOS (bridge100, from Internet Sharing and virtualisation).
 */
const VIRTUAL_ADAPTER =
  /loopback|docker|wsl|vethernet|virtualbox|vmware|hyper-v|bluetooth|^br-|^veth|^virbr|^bridge\d/i;
/** Overlay networks: real and routable, but not "the same WiFi". */
const OVERLAY_ADAPTER = /tailscale|zerotier|wireguard|^u?tun\d/i;

function isPrivateAddress(address) {
  return (
    /^192\.168\./.test(address) ||
    /^10\./.test(address) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(address)
  );
}

/**
 * Wireless first, then wired, then anything else still plausible.
 *
 * Windows names the adapter "Wi-Fi"; Linux uses `wlan0` or a predictable name
 * like `wlp2s0`. macOS reports Wi-Fi as `en0`, which lands in the wired tier and
 * is still chosen when it is the only candidate.
 */
function rank(name) {
  if (/wi-?fi|wireless|^wl/i.test(name)) return 0;
  if (/ethernet|^e(n|th|m)/i.test(name)) return 1;
  return 2;
}

function candidateAddresses() {
  const found = [];
  for (const [name, addresses] of Object.entries(networkInterfaces())) {
    for (const entry of addresses ?? []) {
      // Node <18.4 reported `family` as a number; both forms appear in the wild.
      const isIPv4 = entry.family === 'IPv4' || entry.family === 4;
      if (!isIPv4 || entry.internal) continue;
      if (/^169\.254\./.test(entry.address)) continue; // link-local, no DHCP
      if (!isPrivateAddress(entry.address)) continue;
      found.push({
        name,
        address: entry.address,
        virtual: VIRTUAL_ADAPTER.test(name),
        overlay: OVERLAY_ADAPTER.test(name),
      });
    }
  }
  return found.sort(
    (a, b) =>
      Number(a.virtual) - Number(b.virtual) ||
      Number(a.overlay) - Number(b.overlay) ||
      rank(a.name) - rank(b.name) ||
      a.address.localeCompare(b.address),
  );
}

/** Replaces the host of an existing URL, keeping whatever port is configured. */
function withHost(currentValue, host, fallbackPort) {
  try {
    const url = new URL(currentValue);
    url.hostname = host;
    return url.origin;
  } catch {
    return `http://${host}:${fallbackPort}`;
  }
}

function readValue(contents, key) {
  const match = contents.match(new RegExp(`^${key}=(.*)$`, 'm'));
  return match ? match[1].trim() : undefined;
}

/** Rewrites a key in place, or appends it when the file predates the setting. */
function setValue(contents, key, value) {
  const pattern = new RegExp(`^${key}=.*$`, 'm');
  if (pattern.test(contents)) return contents.replace(pattern, `${key}=${value}`);
  return `${contents.replace(/\n*$/, '')}\n${key}=${value}\n`;
}

/**
 * A host this script is willing to write into `.env`.
 *
 * The value ends up on a `KEY=value` line, so anything containing a newline
 * would append further settings of the caller's choosing to the file. Keeping
 * it to an IPv4 literal or a plain hostname label also catches the common
 * mistake of passing `--address` with no value.
 */
const VALID_HOST =
  /^(?:\d{1,3}(?:\.\d{1,3}){3}|[a-zA-Z0-9]([a-zA-Z0-9-]*[a-zA-Z0-9])?(?:\.[a-zA-Z0-9]([a-zA-Z0-9-]*[a-zA-Z0-9])?)*)$/;

function assertValidHost(value) {
  if (typeof value !== 'string' || value.length === 0 || value.length > 253) return false;
  if (!VALID_HOST.test(value)) return false;
  // Reject 10.0.0.999 and friends, which pass the shape test.
  if (/^\d/.test(value) && value.includes('.') && /^\d{1,3}(\.\d{1,3}){3}$/.test(value)) {
    return value.split('.').every((octet) => Number(octet) <= 255);
  }
  return true;
}

function parseArgs(argv) {
  const args = { revert: false, address: undefined };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--revert') args.revert = true;
    else if (arg === '--address') args.address = argv[(index += 1)];
    else if (arg.startsWith('--address=')) args.address = arg.slice('--address='.length);
    else {
      fail(`unknown argument: ${arg}`);
      process.exit(1);
    }
  }

  if (args.address !== undefined && !assertValidHost(args.address)) {
    fail(`--address must be an IPv4 address or a hostname, got: ${JSON.stringify(args.address)}`);
    warn('Example: npm run dev -- --address 192.168.1.42');
    process.exit(1);
  }

  return args;
}

/** Polls `docker inspect` until the container reports healthy. */
async function waitForHealthy(container, label, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let lastStatus = 'unknown';
  while (Date.now() < deadline) {
    const result = await run(
      'docker',
      ['inspect', '--format', '{{.State.Health.Status}}', container],
      {
        quiet: true,
      },
    );
    lastStatus = result.stdout.trim() || lastStatus;
    if (lastStatus === 'healthy') {
      ok(`${label} is healthy`);
      return true;
    }
    await delay(2000);
  }
  warn(`${label} did not become healthy in time (last: ${lastStatus})`);
  return false;
}

async function containerExists(name) {
  const result = await run('docker', ['inspect', '--format', '{{.State.Status}}', name], {
    quiet: true,
  });
  return result.code === 0;
}

/**
 * Stops the dev server and everything it started.
 *
 * Windows has no real POSIX signals, so `child.kill()` terminates only the npm
 * process and leaves Turbo and Next holding port 3000. `taskkill /T` walks the
 * process tree instead, spawned with an argument array so no shell is involved.
 * On Linux and macOS an interactive Ctrl+C already reaches the whole foreground
 * process group, and npm forwards a programmatic signal down the chain.
 */
function stopDevServer(child, signal) {
  if (process.platform === 'win32' && child.pid !== undefined) {
    spawn('taskkill', ['/pid', String(child.pid), '/t', '/f'], { stdio: 'ignore', shell: false });
    return;
  }
  child.kill(signal);
}

/**
 * Starts the web app and the worker in the foreground, mirroring their exit
 * status.
 *
 * `dev:local`, not `dev`: `dev` is this script, so calling it would recurse.
 */
function startDevServer() {
  const [command, args] = npmCommand(['run', 'dev:local']);
  const child = spawn(command, args, { cwd: root, stdio: 'inherit', shell: false });
  let stopping = false;

  const forward = (signal) => {
    if (stopping) return;
    stopping = true;
    stopDevServer(child, signal);
  };
  process.on('SIGINT', () => forward('SIGINT'));
  process.on('SIGTERM', () => forward('SIGTERM'));

  child.on('error', (error) => {
    fail(`could not start the development server: ${error.message}`);
    process.exit(1);
  });
  // Let the child's exit drive ours, so nothing is left running behind us.
  child.on('exit', (code, signal) => process.exit(signal ? 0 : (code ?? 1)));
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  step('Checking .env');
  if (!existsSync(envPath)) {
    await copyFile(path.join(root, '.env.example'), envPath);
    ok('created .env from .env.example');
  } else {
    ok('.env already exists');
  }

  let contents = await readFile(envPath, 'utf8');

  // Plain-http LAN exposure is a development affordance. Refusing here keeps it
  // from being mistaken for a deployment story; see docs/DEPLOYMENT.md.
  if (readValue(contents, 'NODE_ENV') === 'production') {
    fail('NODE_ENV=production in .env. This script only configures development instances.');
    warn('For a real internal deployment use docker-compose.yml with TLS. See docs/DEPLOYMENT.md.');
    process.exit(1);
  }

  let target;
  // Whether we are actually reachable from the network. Drives both the MinIO
  // bind address and how loudly the plain-http caveats are stated at the end.
  let onNetwork = true;
  if (args.revert) {
    step('Reverting to localhost');
    target = 'localhost';
    onNetwork = false;
  } else if (args.address) {
    step(`Using the address you supplied: ${args.address}`);
    target = args.address;
  } else {
    step('Detecting this machine’s LAN address');
    const candidates = candidateAddresses();
    if (candidates.length === 0) {
      // This is what `npm run dev` runs, so an unplugged laptop must still get
      // a working instance rather than a non-zero exit.
      warn('no private IPv4 address found, so this instance will be localhost-only.');
      warn('Connect to a network and re-run to share links, or pass --address.');
      target = 'localhost';
      onNetwork = false;
    } else {
      target = candidates[0].address;
      ok(`${target} (${candidates[0].name})`);
      if (candidates.length > 1) {
        console.log('      other addresses on this machine:');
        for (const other of candidates.slice(1)) {
          console.log(`        ${other.address} (${other.name})`);
        }
        console.log('      wrong one? npm run dev -- --address <addr>');
      }
    }
  }

  step('Updating .env');
  const updates = {
    TORAN_APP_URL: withHost(readValue(contents, 'TORAN_APP_URL'), target, '3000'),
    TORAN_DOWNLOAD_URL: withHost(readValue(contents, 'TORAN_DOWNLOAD_URL'), target, '9000'),
    // Signing endpoint and browser endpoint are set to the same origin on
    // purpose: packages/storage/src/s3.ts skips its post-signing host rewrite
    // when they match, so the SigV4 signature covers the host actually used.
    S3_ENDPOINT: withHost(readValue(contents, 'S3_ENDPOINT'), target, '9000'),
    S3_PUBLIC_ENDPOINT: withHost(readValue(contents, 'S3_PUBLIC_ENDPOINT'), target, '9000'),
    // Only publish storage to the network when there is a network address to
    // share; a localhost-only instance keeps MinIO on loopback.
    MINIO_BIND_ADDRESS: onNetwork ? '0.0.0.0' : '127.0.0.1',
  };

  let changed = false;
  for (const [key, value] of Object.entries(updates)) {
    if (readValue(contents, key) !== value) changed = true;
    contents = setValue(contents, key, value);
    ok(`${key}=${value}`);
  }
  await writeFile(envPath, contents, 'utf8');
  if (!changed) ok('already configured, nothing to change');

  step('Checking Docker');
  const docker = await run('docker', ['info', '--format', '{{.ServerVersion}}'], { quiet: true });
  if (docker.code !== 0) {
    fail('Docker is not running. Start Docker Desktop (or your daemon) and try again.');
    process.exit(1);
  }
  ok(`Docker ${docker.stdout.trim()} is running`);

  const firstRun = !(await containerExists('toran-dev-postgres'));

  step('Starting development infrastructure');
  // `up -d` is idempotent and recreates only the containers whose configuration
  // changed, which is exactly what MinIO needs when its published address or
  // allowed upload origin moves. No --force-recreate required.
  let up = await run('docker', ['compose', '-f', composeFile, 'up', '-d']);
  if (up.code !== 0) {
    // Moving MinIO between loopback and the network recreates it, and Docker can
    // still be releasing the old port binding when the new container starts.
    warn('a container may still have been releasing its port; retrying once');
    await delay(3000);
    up = await run('docker', ['compose', '-f', composeFile, 'up', '-d']);
  }
  if (up.code !== 0) {
    fail('docker compose could not start the development services.');
    fail(`Check: docker compose -f ${composeFile} logs`);
    process.exit(1);
  }
  ok('containers are up to date');

  const postgresReady = await waitForHealthy('toran-dev-postgres', 'PostgreSQL', 120_000);
  const minioReady = await waitForHealthy('toran-dev-minio', 'MinIO', 120_000);
  if (!postgresReady || !minioReady) {
    fail(`PostgreSQL and MinIO are required. Check: docker compose -f ${composeFile} logs`);
    process.exit(1);
  }

  if (firstRun) {
    step('One more step');
    warn('These containers were just created, so the bucket and database schema');
    warn('do not exist yet. Run the one-time bootstrap, then this command again:');
    console.log('\n    npm run dev:setup\n');
    process.exit(1);
  }

  if (args.revert) {
    step('Done');
    ok(`Back to ${updates.TORAN_APP_URL}. MinIO is on loopback only again.`);
    // `dev:local`, not `dev`: `dev` would detect the LAN address and undo this.
    console.log('\n    Start the servers with: npm run dev:local\n');
    return;
  }

  if (onNetwork) {
    warn('Traffic is plain http, so anyone on this network can capture share links');
    warn('and link passwords in flight. Fine for a quick share, not for anything');
    warn('sensitive. Your address can also change when you reconnect, and links');
    warn('made under the old one stop working; re-run this command if that happens.');
  }

  console.log(`\nToran is available at ${updates.TORAN_APP_URL}`);
  if (onNetwork) {
    console.log('Share links will work for devices on this network.');
    console.log('Windows users may need to allow ports 3000 and 9000 through the firewall.');
  } else {
    console.log('This instance is localhost-only, so share links work on this machine only.');
  }
  console.log('\nStarting the web app and the worker. Press Ctrl+C to stop.\n');

  startDevServer();
}

main().catch((error) => {
  fail(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
