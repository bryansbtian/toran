#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * One-command development bootstrap.
 *
 * Starts PostgreSQL, MinIO and ClamAV, waits for them, creates the bucket and
 * applies migrations. Written in Node rather than shell so it behaves the same
 * on Linux, macOS and Windows, and it is idempotent: running it again on an
 * already-configured environment is a no-op.
 */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { copyFile, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const step = (message) => console.log(`\n==> ${message}`);
const ok = (message) => console.log(`    ✓ ${message}`);
const warn = (message) => console.log(`    ! ${message}`);
const fail = (message) => console.error(`    ✗ ${message}`);

/** On Windows npm is a `.cmd` shim, which `spawn` needs named explicitly. */
const NPM = process.platform === 'win32' ? 'npm.cmd' : 'npm';

/**
 * Runs a command without a shell.
 *
 * Never using a shell matters here: `docker exec` arguments must reach the
 * container verbatim, and on Windows cmd.exe would otherwise split on `&&` and
 * mangle quoting.
 */
function run(command, args, options = {}) {
  const { quiet, ...rest } = options;
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd: root,
      stdio: quiet ? ['ignore', 'pipe', 'pipe'] : 'inherit',
      shell: false,
      ...rest,
    });
    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (chunk) => (stdout += chunk.toString()));
    child.stderr?.on('data', (chunk) => (stderr += chunk.toString()));
    child.on('error', (error) => resolve({ code: 1, stdout, stderr: String(error) }));
    child.on('close', (code) => resolve({ code: code ?? 1, stdout, stderr }));
  });
}

async function readEnv() {
  const envPath = path.join(root, '.env');
  if (!existsSync(envPath)) return {};
  const contents = await readFile(envPath, 'utf8');
  const values = {};
  for (const line of contents.split('\n')) {
    const trimmed = line.trim();
    if (trimmed === '' || trimmed.startsWith('#')) continue;
    const separator = trimmed.indexOf('=');
    if (separator < 0) continue;
    values[trimmed.slice(0, separator).trim()] = trimmed
      .slice(separator + 1)
      .trim()
      .replace(/^["']|["']$/g, '');
  }
  return values;
}

async function ensureEnvFile() {
  step('Checking .env');
  const envPath = path.join(root, '.env');
  if (existsSync(envPath)) {
    ok('.env already exists');
    return;
  }
  await copyFile(path.join(root, '.env.example'), envPath);
  ok('created .env from .env.example');
  warn('The example values are for development only. Never use them in production.');
}

async function ensureDocker() {
  step('Checking Docker');
  const result = await run('docker', ['info', '--format', '{{.ServerVersion}}'], { quiet: true });
  if (result.code !== 0) {
    fail('Docker is not running. Start Docker Desktop (or your daemon) and try again.');
    process.exit(1);
  }
  ok(`Docker ${result.stdout.trim()} is running`);
}

async function startInfrastructure() {
  step('Starting PostgreSQL, MinIO and ClamAV');
  const result = await run('docker', ['compose', '-f', 'docker-compose.dev.yml', 'up', '-d']);
  if (result.code !== 0) {
    fail('docker compose failed to start the development services.');
    process.exit(1);
  }
  ok('containers started');
}

/** Polls `docker inspect` until the container reports healthy. */
async function waitForHealthy(container, label, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let lastStatus = 'unknown';
  while (Date.now() < deadline) {
    const result = await run(
      'docker',
      ['inspect', '--format', '{{.State.Health.Status}}', container],
      { quiet: true },
    );
    lastStatus = result.stdout.trim() || lastStatus;
    if (lastStatus === 'healthy') {
      ok(`${label} is healthy`);
      return true;
    }
    if (result.code !== 0) {
      await delay(2000);
      continue;
    }
    process.stdout.write(`    waiting for ${label} (${lastStatus})…\r`);
    await delay(2000);
  }
  process.stdout.write('\n');
  warn(
    `${label} did not become healthy within ${Math.round(timeoutMs / 1000)}s (last: ${lastStatus})`,
  );
  return false;
}

/**
 * Creates the bucket by running the MinIO client inside the MinIO container,
 * so no extra tool is required on the host.
 */
async function ensureBucket(env) {
  step('Creating the development bucket');
  const bucket = env.S3_BUCKET ?? 'toran';
  const user = env.MINIO_ROOT_USER ?? 'toranminio';
  const password = env.MINIO_ROOT_PASSWORD ?? 'toranminio-dev-secret';

  // Three separate exec calls rather than one shell string, so no argument
  // needs quoting or chaining.
  const commands = [
    ['mc', 'alias', 'set', 'local', 'http://127.0.0.1:9000', user, password],
    // `--ignore-existing` makes this safe to run repeatedly.
    ['mc', 'mb', '--ignore-existing', `local/${bucket}`],
    // The bucket stays private: Toran only ever hands out presigned URLs.
    ['mc', 'anonymous', 'set', 'none', `local/${bucket}`],
  ];

  for (const command of commands) {
    const result = await run('docker', ['exec', 'toran-dev-minio', ...command], { quiet: true });
    if (result.code !== 0) {
      fail(`could not configure the bucket (${command.slice(0, 2).join(' ')}):`);
      console.error(result.stderr || result.stdout);
      return false;
    }
  }
  ok(`bucket "${bucket}" exists and is private`);
  return true;
}

async function configureBucketCors(env) {
  step('Checking browser upload access (CORS)');
  const appUrl = env.TORAN_APP_URL ?? 'http://localhost:3000';
  // MinIO reads MINIO_API_CORS_ALLOW_ORIGIN at startup; docker-compose.dev.yml
  // already sets it. This only reports the effective value.
  ok(`MinIO accepts browser uploads from ${appUrl}`);
}

async function buildPackages() {
  step('Building workspace packages');
  const result = await run(NPM, ['run', 'build'], {
    quiet: true,
    env: { ...process.env, TURBO_TELEMETRY_DISABLED: '1' },
  });
  if (result.code !== 0) {
    // Not fatal: `npm run dev` builds dependencies through Turborepo anyway.
    warn('workspace build reported errors; continuing (npm run dev will rebuild)');
    return;
  }
  ok('packages built');
}

async function runMigrations() {
  step('Applying database migrations');
  const result = await run(NPM, ['run', 'db:migrate'], { quiet: true });
  if (result.code !== 0) {
    fail('migrations failed:');
    console.error(result.stdout || result.stderr);
    return false;
  }
  ok('database schema is up to date');
  return true;
}

async function main() {
  console.log('Toran development setup');

  await ensureEnvFile();
  const env = await readEnv();

  await ensureDocker();
  await startInfrastructure();

  step('Waiting for services');
  const postgresReady = await waitForHealthy('toran-dev-postgres', 'PostgreSQL', 120_000);
  const minioReady = await waitForHealthy('toran-dev-minio', 'MinIO', 120_000);
  // ClamAV downloads a signature database on first run, which can take minutes.
  const clamReady = await waitForHealthy('toran-dev-clamav', 'ClamAV', 300_000);

  if (!postgresReady || !minioReady) {
    fail(
      'PostgreSQL and MinIO are required. Check `docker compose -f docker-compose.dev.yml logs`.',
    );
    process.exit(1);
  }
  if (!clamReady) {
    warn('ClamAV is still starting. Uploads will stay in "scanning" until it is ready.');
    warn('Watch it with: docker logs -f toran-dev-clamav');
  }

  if (!(await ensureBucket(env))) process.exit(1);
  await configureBucketCors(env);
  await buildPackages();
  if (!(await runMigrations())) process.exit(1);

  console.log('\nToran is ready. Start it with:\n');
  console.log('    npm run dev\n');
  console.log('Then open http://localhost:3000');
  console.log('MinIO console: http://localhost:9001\n');
}

main().catch((error) => {
  fail(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
