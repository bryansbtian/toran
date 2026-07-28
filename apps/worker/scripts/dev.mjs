#!/usr/bin/env node
// SPDX-License-Identifier: MIT

/**
 * Development runner for the worker: compile on change, and run what was
 * compiled.
 *
 * `tsc --watch` on its own only ever produced JavaScript. Nothing executed it,
 * so scan jobs queued forever while the web app looked perfectly healthy and
 * every upload sat in `scanning` - the failure mode docs/TROUBLESHOOTING.md
 * calls "the one people miss". Pairing the compiler with `node --watch` closes
 * that gap: the compiler rewrites `dist/`, and Node restarts the process.
 *
 * Node's watch mode ignores `node_modules`, but workspace packages resolve
 * through their symlinks to `packages/*\/dist`, so edits to a shared package
 * restart the worker too.
 */
import { spawn } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);

const warn = (message) => console.log(`[worker] ! ${message}`);
const fail = (message) => console.error(`[worker] ✗ ${message}`);

/**
 * The compiler's JavaScript entry point.
 *
 * `node_modules/.bin/tsc` is a `.cmd` shim on Windows, and Node refuses to
 * spawn one without `shell: true` (the CVE-2024-27980 fix), which would drag
 * cmd.exe quoting back in. The package's own `bin/tsc` is plain JavaScript that
 * this Node binary runs directly.
 */
function resolveTsc() {
  try {
    // typescript/lib/typescript.js -> typescript/bin/tsc
    return path.join(path.dirname(path.dirname(require.resolve('typescript'))), 'bin', 'tsc');
  } catch {
    return null;
  }
}

const children = new Set();

/**
 * Stops a child and everything it started.
 *
 * Windows has no process groups, so `child.kill()` would leave `tsc` and the
 * worker itself running after the parent is gone. `taskkill /T` walks the tree.
 */
function stopChild(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  if (process.platform === 'win32' && child.pid !== undefined) {
    spawn('taskkill', ['/pid', String(child.pid), '/t', '/f'], { stdio: 'ignore', shell: false });
    return;
  }
  child.kill('SIGTERM');
}

function spawnChild(args, label) {
  const child = spawn(process.execPath, args, { cwd: root, stdio: 'inherit', shell: false });
  children.add(child);
  child.on('error', (error) => {
    fail(`could not start ${label}: ${error.message}`);
    shutdown(1);
  });
  child.on('exit', (code, signal) => {
    children.delete(child);
    // Either half dying leaves a useless session: a compiler with nothing
    // running it, or a process nothing recompiles. Take the whole thing down so
    // Turborepo reports it rather than appearing to still work.
    if (!stopping) {
      fail(`${label} exited (${signal ?? code}); stopping the worker dev session`);
      shutdown(signal ? 0 : (code ?? 1));
    }
  });
  return child;
}

let stopping = false;

function shutdown(code) {
  if (stopping) return;
  stopping = true;
  for (const child of children) stopChild(child);
  process.exit(code);
}

const mtimeOf = (file) => (existsSync(file) ? statSync(file).mtimeMs : 0);

/**
 * Waits for the compiler's first emit.
 *
 * Starting Node against output left over from a previous session would work,
 * but `tsc --watch` rewrites it a second or two later and `node --watch` would
 * restart on top - so the worker announces itself twice at every boot, which
 * reads like something crashed. Waiting for a newer mtime means the process we
 * start is the one that stays.
 */
async function waitForEmit(entry, since, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (mtimeOf(entry) > since) return true;
    await delay(150);
  }
  return false;
}

async function main() {
  const tsc = resolveTsc();
  if (tsc === null || !existsSync(tsc)) {
    fail('could not find the TypeScript compiler. Run `npm install` from the repository root.');
    process.exit(1);
  }

  process.on('SIGINT', () => shutdown(0));
  process.on('SIGTERM', () => shutdown(0));

  const entry = path.join(root, 'dist', 'main.js');
  const before = mtimeOf(entry);
  spawnChild([tsc, '-p', 'tsconfig.json', '--watch', '--preserveWatchOutput'], 'tsc --watch');

  // A cold first compile of the whole workspace is slow, and on a fresh clone
  // there is no `dist/` at all - Turborepo's `dev` task only guarantees that
  // *dependencies* were built.
  if (!(await waitForEmit(entry, before, 180_000))) {
    if (!existsSync(entry)) {
      fail('the worker never compiled, so there is nothing to run. Fix the errors above.');
      shutdown(1);
      return;
    }
    warn('the compiler has not emitted yet; running the output already on disk');
  }

  spawnChild(['--watch', '--enable-source-maps', 'dist/main.js'], 'the worker');
}

main().catch((error) => {
  fail(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
