#!/usr/bin/env node
// SPDX-License-Identifier: MIT

/**
 * Fails when something that looks like a credential is committed.
 *
 * This is a backstop, not a substitute for GitHub's push protection and
 * secret scanning (see SECURITY.md). It deliberately allows the documented
 * placeholder values in `.env.example`, because those exist precisely so a
 * self-hoster can see what to replace - and `@toran/config` refuses to boot in
 * production if any of them survive.
 */
import { readFile, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const SKIP_DIRECTORIES = new Set([
  'node_modules',
  '.git',
  '.next',
  'dist',
  '.turbo',
  'coverage',
  'playwright-report',
  'test-results',
  '.data',
]);

const SCANNED_EXTENSIONS = new Set([
  '.ts',
  '.tsx',
  '.js',
  '.mjs',
  '.cjs',
  '.json',
  '.yml',
  '.yaml',
  '.md',
  '.sql',
  '.example',
  '.env',
  '.sh',
  '.toml',
]);

/** Files whose whole purpose is to show example values. */
const PLACEHOLDER_FILES = new Set(['.env.example']);

const RULES = [
  { name: 'AWS access key id', pattern: /\bAKIA[0-9A-Z]{16}\b/ },
  { name: 'AWS secret access key', pattern: /aws_secret_access_key\s*=\s*\S{20,}/i },
  { name: 'private key block', pattern: /-----BEGIN (RSA |EC |OPENSSH |PGP )?PRIVATE KEY-----/ },
  { name: 'GitHub token', pattern: /\bgh[pousr]_[A-Za-z0-9]{36,}\b/ },
  { name: 'Slack token', pattern: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/ },
  { name: 'Stripe secret key', pattern: /\bsk_live_[A-Za-z0-9]{16,}\b/ },
  { name: 'Google API key', pattern: /\bAIza[0-9A-Za-z_-]{35}\b/ },
  {
    name: 'JSON web token',
    pattern: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/,
  },
  {
    name: 'database url with a real-looking password',
    pattern:
      /\bpostgres(?:ql)?:\/\/[^:\s/]+:(?![^@\s]*(?:toran|password|changeme|example)\b)[^@\s]{12,}@/i,
  },
];

/** A committed `.env` is always a mistake, whatever it contains. */
const FORBIDDEN_FILES = ['.env', '.env.local', '.env.production', '.env.production.local'];

async function* walk(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (SKIP_DIRECTORIES.has(entry.name)) continue;
      yield* walk(path.join(directory, entry.name));
      continue;
    }
    yield path.join(directory, entry.name);
  }
}

async function main() {
  const findings = [];

  for (const name of FORBIDDEN_FILES) {
    const candidate = path.join(root, name);
    try {
      await stat(candidate);
      // Present on disk is fine for local development; committed is not.
      // This script cannot see git state, so it only warns here. CI runs it on
      // a fresh checkout, where the file's presence means it was committed.
      if (process.env.CI) {
        findings.push({ file: name, rule: 'committed environment file', line: 0 });
      }
    } catch {
      /* absent, which is what we want */
    }
  }

  for await (const file of walk(root)) {
    const relative = path.relative(root, file).split(path.sep).join('/');
    const base = path.basename(file);

    if (base === 'package-lock.json') continue;
    if (base === 'check-secrets.mjs') continue;
    if (PLACEHOLDER_FILES.has(base)) continue;
    if (!SCANNED_EXTENSIONS.has(path.extname(file)) && !base.startsWith('.env')) continue;

    let contents;
    try {
      contents = await readFile(file, 'utf8');
    } catch {
      continue;
    }

    const lines = contents.split('\n');
    for (const rule of RULES) {
      lines.forEach((line, index) => {
        if (rule.pattern.test(line)) {
          findings.push({ file: relative, rule: rule.name, line: index + 1 });
        }
      });
    }
  }

  if (findings.length === 0) {
    console.log('No committed secrets found.');
    return 0;
  }

  console.error('Potential secrets found:\n');
  for (const finding of findings) {
    console.error(`  ${finding.file}:${finding.line}  ${finding.rule}`);
  }
  console.error('\nRemove the value, rotate it, and use an environment variable instead.');
  return 1;
}

main()
  .then((code) => process.exit(code))
  .catch((error) => {
    console.error('[toran] secret scan failed:', error);
    process.exit(1);
  });
