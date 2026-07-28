#!/usr/bin/env node
// SPDX-License-Identifier: MIT

/**
 * Fails when a production dependency carries a high or critical advisory that
 * has not been explicitly reviewed and accepted.
 *
 * `npm audit --omit=dev --audit-level=high` on its own is all-or-nothing: one
 * advisory that cannot currently be fixed turns the check permanently red, and
 * a permanently red check is one nobody reads. This wrapper keeps the same
 * severity bar but lets a *named, justified, individually reviewed* advisory be
 * accepted, while anything new still fails the build.
 *
 * The list below is not a way to make the check quiet. Every entry has to say
 * why the vulnerable code path cannot be reached from Toran, and has to be
 * removed as soon as an upgrade exists. Adding an entry is a review decision,
 * visible in the diff.
 */
import { spawn } from 'node:child_process';
import path from 'node:path';

/**
 * Builds an npm invocation that needs no shell.
 *
 * On Windows npm is a `.cmd` shim, which Node refuses to spawn without
 * `shell: true` (the CVE-2024-27980 fix). npm exports its own JS entry point in
 * `npm_execpath`, and this Node binary can run that directly. The fallbacks
 * cover being invoked as `node scripts/audit-production.mjs`, where npm has set
 * nothing.
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
 * Advisories accepted for now. Keyed by GHSA id.
 *
 * `reason` must explain unreachability, not inconvenience.
 * `revisitWhen` must name the concrete event that removes the entry.
 */
const ACCEPTED = {
  'GHSA-qx2v-qp2m-jg93': {
    package: 'postcss',
    reason:
      'XSS via an unescaped </style> in stringify output. Reached only when PostCSS ' +
      'stringifies attacker-controlled CSS. Toran compiles its own Tailwind sources at ' +
      'build time and never runs PostCSS over user input. The vulnerable copy is the one ' +
      'Next.js pins internally (postcss 8.4.31), not the 8.5.x the app itself uses.',
    revisitWhen: 'Next.js depends on postcss >= 8.5.18',
  },
  'GHSA-6g55-p6wh-862q': {
    package: 'postcss',
    reason:
      'Arbitrary file read via an attacker-controlled sourceMappingURL in a CSS comment. ' +
      'Same reachability argument: build-time only, over CSS committed to this repository.',
    revisitWhen: 'Next.js depends on postcss >= 8.5.18',
  },
  'GHSA-r28c-9q8g-f849': {
    package: 'postcss',
    reason:
      'Path traversal in previous-source-map auto-loading. Build-time only, over CSS ' +
      'committed to this repository.',
    revisitWhen: 'Next.js depends on postcss >= 8.5.18',
  },
  'GHSA-f88m-g3jw-g9cj': {
    package: 'sharp',
    reason:
      'libvips CVEs in image decoding. sharp is an optional dependency Next.js loads only ' +
      'to serve the built-in image optimiser. Toran never imports next/image, serves no ' +
      'optimised images, and never passes an uploaded byte to an image decoder - uploads go ' +
      'browser-to-storage and are only ever streamed to ClamAV.',
    revisitWhen: 'Next.js depends on sharp >= 0.35.0',
  },
};

/** `next` itself is only ever flagged through the two packages above. */
const TRANSITIVE_ONLY = new Set(['next']);

function runAudit() {
  return new Promise((resolve) => {
    // npm exits non-zero when it finds anything, so the exit code is not the
    // signal here - the parsed report is.
    const [command, args] = npmCommand(['audit', '--omit=dev', '--json']);
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'], shell: false });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => (stdout += chunk.toString()));
    child.stderr.on('data', (chunk) => (stderr += chunk.toString()));
    child.on('error', (error) => resolve({ stdout: '', stderr: String(error) }));
    child.on('close', () => resolve({ stdout, stderr }));
  });
}

function advisoryIdsFor(vulnerability) {
  const ids = new Set();
  for (const via of vulnerability.via ?? []) {
    if (typeof via === 'object' && typeof via.url === 'string') {
      const match = /GHSA-[a-z0-9-]+/i.exec(via.url);
      if (match) ids.add(match[0]);
    }
  }
  return ids;
}

async function main() {
  const { stdout, stderr } = await runAudit();
  if (stdout.trim() === '') {
    console.error('[toran] npm audit produced no output.');
    if (stderr) console.error(stderr);
    return 1;
  }

  let report;
  try {
    report = JSON.parse(stdout);
  } catch {
    console.error('[toran] could not parse the npm audit report.');
    return 1;
  }

  const unreviewed = [];
  const accepted = [];

  for (const [name, vulnerability] of Object.entries(report.vulnerabilities ?? {})) {
    if (!['high', 'critical'].includes(vulnerability.severity)) continue;

    const ids = advisoryIdsFor(vulnerability);

    // A package flagged purely because a dependency of it is flagged carries no
    // advisory of its own; judging it separately would double-count.
    if (ids.size === 0 && TRANSITIVE_ONLY.has(name)) continue;

    if (ids.size === 0) {
      unreviewed.push({ name, detail: `${vulnerability.severity} advisory with no GHSA id` });
      continue;
    }

    for (const id of ids) {
      if (ACCEPTED[id]) accepted.push({ id, name });
      else unreviewed.push({ name, detail: `${vulnerability.severity} ${id}` });
    }
  }

  for (const entry of accepted) {
    const record = ACCEPTED[entry.id];
    console.log(`accepted  ${entry.id}  ${entry.name} - revisit when ${record.revisitWhen}`);
  }

  // A stale entry is its own problem: it means someone accepted an advisory
  // that no longer applies and the list is drifting out of date.
  const seen = new Set(accepted.map((entry) => entry.id));
  for (const id of Object.keys(ACCEPTED)) {
    if (!seen.has(id)) {
      console.log(`stale     ${id} is no longer reported; remove it from ACCEPTED.`);
    }
  }

  if (unreviewed.length > 0) {
    console.error('\nUnreviewed high or critical advisories in production dependencies:\n');
    for (const entry of unreviewed) {
      console.error(`  ${entry.name}: ${entry.detail}`);
    }
    console.error(
      '\nUpgrade the dependency, or - only if the vulnerable path is genuinely\n' +
        'unreachable from Toran - add it to ACCEPTED in scripts/audit-production.mjs\n' +
        'with a reason that says why.',
    );
    return 1;
  }

  console.log('\nNo unreviewed high or critical advisories in production dependencies.');
  return 0;
}

main()
  .then((code) => process.exit(code))
  .catch((error) => {
    console.error('[toran] production audit failed:', error);
    process.exit(1);
  });
