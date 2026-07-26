#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only
import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { eq } from 'drizzle-orm';
import {
  enqueueJob,
  files,
  findFileById,
  findJobById,
  findShareByTokenHash,
  listFailedJobs,
  listOpenReports,
  listSharesForFile,
  markFileStatus,
  retryJob,
  revokeAllSharesForFile,
  revokeShareLink,
  setReportStatus,
  countJobsByStatus,
} from '@toran/database';
import { loadConfig } from '@toran/config';
import { extractShareToken, hashShareToken } from '@toran/security';
import { quarantineKeyFor } from '@toran/storage';
import { formatBytes } from '@toran/shared';
import { createWorkerRuntime } from '../context.js';
import { cleanupJobs } from '../jobs/cleanup.js';
import { scanFileJob } from '../jobs/scanFile.js';
import { JobRunner } from '../runner.js';
import { MaintenanceScheduler } from '../scheduler.js';

const USAGE = `
toran-admin - Toran administration CLI

Usage:
  toran-admin <command> [options]

Inspect:
  file <file-id>                 Show a file, its links and its scan result
  link <token-or-url>            Resolve a share link from a raw token
  reports [--limit N]            List open abuse reports
  jobs [--failed] [--limit N]    List queue state or failed jobs

Act (destructive commands require confirmation):
  revoke-link <share-id>         Revoke one share link
  block-file <file-id>           Block a file and revoke every link to it
  delete-file <file-id>          Delete the file record and its storage object
  rescan <file-id>               Queue a fresh malware scan
  retry-job <job-id>             Return a dead job to the queue
  cleanup                        Run every maintenance sweep once, now
  report-status <id> <status>    Set an abuse report to open|actioned|dismissed

Options:
  --yes, -y                      Skip the confirmation prompt (for automation)
  --limit N                      Row limit for list commands (default 25)
  --help, -h                     Show this help

Notes:
  A raw share token is never printed back. 'link' resolves a token you already
  hold and reports only database identifiers.
`.trim();

interface Args {
  readonly command: string;
  readonly positional: string[];
  readonly yes: boolean;
  readonly limit: number;
  readonly failed: boolean;
  readonly help: boolean;
}

function parseArgs(argv: string[]): Args {
  const positional: string[] = [];
  let yes = false;
  let limit = 25;
  let failed = false;
  let help = false;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index] ?? '';
    if (arg === '--yes' || arg === '-y') yes = true;
    else if (arg === '--failed') failed = true;
    else if (arg === '--help' || arg === '-h') help = true;
    else if (arg === '--limit') {
      limit = Number(argv[index + 1] ?? '25');
      index += 1;
    } else positional.push(arg);
  }

  return {
    command: positional[0] ?? '',
    positional: positional.slice(1),
    yes,
    limit: Number.isInteger(limit) && limit > 0 ? Math.min(limit, 500) : 25,
    failed,
    help,
  };
}

/** Destructive operations must be confirmed unless explicitly automated. */
async function confirm(args: Args, action: string): Promise<boolean> {
  if (args.yes) return true;
  if (!stdin.isTTY) {
    console.error(`Refusing to ${action} without a terminal. Pass --yes for automation.`);
    return false;
  }
  const rl = createInterface({ input: stdin, output: stdout });
  try {
    const answer = await rl.question(`About to ${action}. Type "yes" to continue: `);
    return answer.trim().toLowerCase() === 'yes';
  } finally {
    rl.close();
  }
}

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || args.command === '' || args.command === 'help') {
    console.log(USAGE);
    return 0;
  }

  const config = loadConfig();
  const runtime = createWorkerRuntime(config);
  const { db } = runtime.context;

  try {
    switch (args.command) {
      case 'file':
        return await showFile(runtime, args);
      case 'link':
        return await showLink(runtime, args);
      case 'reports':
        return await showReports(runtime, args);
      case 'jobs':
        return await showJobs(runtime, args);
      case 'revoke-link':
        return await doRevokeLink(runtime, args);
      case 'block-file':
        return await doBlockFile(runtime, args);
      case 'delete-file':
        return await doDeleteFile(runtime, args);
      case 'rescan':
        return await doRescan(runtime, args);
      case 'retry-job':
        return await doRetryJob(runtime, args);
      case 'cleanup':
        return await doCleanup(runtime, args);
      case 'report-status':
        return await doReportStatus(runtime, args);
      default:
        console.error(`Unknown command "${args.command}". Run with --help.`);
        return 1;
    }
  } finally {
    await runtime.close();
    void db;
  }
}

type Runtime = ReturnType<typeof createWorkerRuntime>;

async function showFile(runtime: Runtime, args: Args): Promise<number> {
  const fileId = args.positional[0];
  if (!fileId) {
    console.error('Usage: toran-admin file <file-id>');
    return 1;
  }
  const file = await findFileById(runtime.context.db, fileId);
  if (!file) {
    console.error('No file with that id.');
    return 1;
  }
  const shares = await listSharesForFile(runtime.context.db, file.id);

  console.log(`id                  ${file.id}`);
  console.log(`status              ${file.status}`);
  console.log(`filename            ${file.normalizedFilename}`);
  console.log(`content type        ${file.contentType}`);
  console.log(`declared size       ${formatBytes(file.declaredSize)}`);
  console.log(
    `actual size         ${file.actualSize === null ? '(not verified)' : formatBytes(file.actualSize)}`,
  );
  console.log(`scan result         ${file.scanResult ?? '(none)'}`);
  console.log(`storage key         ${file.storageKey}`);
  console.log(`created             ${file.createdAt.toISOString()}`);
  console.log(`expires             ${file.expiresAt?.toISOString() ?? '(never)'}`);
  console.log(`deleted             ${file.deletedAt?.toISOString() ?? '(no)'}`);
  console.log(`\n${shares.length} share link(s):`);
  for (const share of shares) {
    console.log(
      `  ${share.id}  downloads=${share.downloadCount}/${share.maxDownloads ?? '∞'}  ` +
        `password=${share.passwordHash ? 'yes' : 'no'}  ` +
        `expires=${share.expiresAt?.toISOString() ?? 'never'}  ` +
        `revoked=${share.revokedAt ? share.revokedAt.toISOString() : 'no'}`,
    );
  }
  return 0;
}

async function showLink(runtime: Runtime, args: Args): Promise<number> {
  const input = args.positional[0];
  if (!input) {
    console.error('Usage: toran-admin link <token-or-url>');
    return 1;
  }
  const token = extractShareToken(input);
  if (!token) {
    console.error('That does not look like a Toran share token or link.');
    return 1;
  }

  const found = await findShareByTokenHash(runtime.context.db, hashShareToken(token));
  if (!found) {
    console.error('No share link matches that token.');
    return 1;
  }

  // The raw token is deliberately not echoed, so it cannot end up in a shell
  // history dump, a screenshot, or a support ticket.
  console.log(`share link id       ${found.share.id}`);
  console.log(`file id             ${found.file.id}`);
  console.log(`file status         ${found.file.status}`);
  console.log(`filename            ${found.file.normalizedFilename}`);
  console.log(
    `downloads           ${found.share.downloadCount}/${found.share.maxDownloads ?? '∞'}`,
  );
  console.log(`password protected  ${found.share.passwordHash ? 'yes' : 'no'}`);
  console.log(`expires             ${found.share.expiresAt?.toISOString() ?? '(never)'}`);
  console.log(`revoked             ${found.share.revokedAt?.toISOString() ?? '(no)'}`);
  return 0;
}

async function showReports(runtime: Runtime, args: Args): Promise<number> {
  const reports = await listOpenReports(runtime.context.db, args.limit);
  if (reports.length === 0) {
    console.log('No open reports.');
    return 0;
  }
  for (const report of reports) {
    console.log(
      `${report.createdAt.toISOString()}  ${report.id}  ${report.reason.padEnd(11)}  ` +
        `share=${report.shareLinkId ?? '(unresolved)'}`,
    );
    if (report.details) console.log(`    ${report.details.slice(0, 200)}`);
  }
  return 0;
}

async function showJobs(runtime: Runtime, args: Args): Promise<number> {
  if (args.failed) {
    const failed = await listFailedJobs(runtime.context.db, args.limit);
    if (failed.length === 0) {
      console.log('No failed jobs.');
      return 0;
    }
    for (const job of failed) {
      console.log(
        `${job.id}  ${job.type.padEnd(22)}  attempts=${job.attempts}/${job.maxAttempts}  ` +
          `status=${job.status}`,
      );
      if (job.lastError) console.log(`    ${job.lastError}`);
    }
    return 0;
  }

  const counts = await countJobsByStatus(runtime.context.db);
  const statuses = ['queued', 'running', 'succeeded', 'failed', 'dead'];
  for (const status of statuses) {
    console.log(`${status.padEnd(10)} ${counts[status] ?? 0}`);
  }
  return 0;
}

async function doRevokeLink(runtime: Runtime, args: Args): Promise<number> {
  const shareId = args.positional[0];
  if (!shareId) {
    console.error('Usage: toran-admin revoke-link <share-id>');
    return 1;
  }
  if (!(await confirm(args, `revoke share link ${shareId}`))) return 1;

  const revoked = await revokeShareLink(runtime.context.db, shareId, runtime.context.clock.now());
  if (!revoked) {
    console.error('No share link with that id.');
    return 1;
  }
  console.log(`Revoked ${revoked.id} at ${revoked.revokedAt?.toISOString()}.`);
  return 0;
}

async function doBlockFile(runtime: Runtime, args: Args): Promise<number> {
  const fileId = args.positional[0];
  if (!fileId) {
    console.error('Usage: toran-admin block-file <file-id>');
    return 1;
  }
  if (!(await confirm(args, `block file ${fileId} and revoke every link to it`))) return 1;

  const now = runtime.context.clock.now();
  const file = await markFileStatus(runtime.context.db, { fileId, status: 'blocked', now });
  if (!file) {
    console.error('No file with that id.');
    return 1;
  }
  const revoked = await revokeAllSharesForFile(runtime.context.db, fileId, now);

  if (runtime.context.config.scanning.blockedFileAction === 'quarantine') {
    await runtime.context.storage
      .copyObject(file.storageKey, quarantineKeyFor(file.storageKey))
      .catch(() => console.error('Warning: could not copy the object to quarantine.'));
  }
  await enqueueJob(runtime.context.db, {
    type: 'delete_object',
    payload: { storageKey: file.storageKey, fileId: file.id },
    dedupeKey: `delete_object:${file.id}`,
  });

  console.log(`Blocked ${fileId}, revoked ${revoked} link(s), queued object removal.`);
  return 0;
}

async function doDeleteFile(runtime: Runtime, args: Args): Promise<number> {
  const fileId = args.positional[0];
  if (!fileId) {
    console.error('Usage: toran-admin delete-file <file-id>');
    return 1;
  }
  const file = await findFileById(runtime.context.db, fileId);
  if (!file) {
    console.error('No file with that id.');
    return 1;
  }
  if (!(await confirm(args, `permanently delete file ${fileId} and its storage object`))) return 1;

  const now = runtime.context.clock.now();
  await revokeAllSharesForFile(runtime.context.db, fileId, now);
  await markFileStatus(runtime.context.db, { fileId, status: 'deleted', now });
  await runtime.context.storage.deleteObject(file.storageKey);
  await runtime.context.db.delete(files).where(eq(files.id, fileId));

  console.log(`Deleted ${fileId} and its storage object.`);
  return 0;
}

async function doRescan(runtime: Runtime, args: Args): Promise<number> {
  const fileId = args.positional[0];
  if (!fileId) {
    console.error('Usage: toran-admin rescan <file-id>');
    return 1;
  }
  const file = await findFileById(runtime.context.db, fileId);
  if (!file) {
    console.error('No file with that id.');
    return 1;
  }
  if (
    !(await confirm(args, `re-scan file ${fileId} (it becomes unavailable until the scan ends)`))
  ) {
    return 1;
  }

  await markFileStatus(runtime.context.db, {
    fileId,
    status: 'scanning',
    now: runtime.context.clock.now(),
    onlyFrom: ['ready', 'failed', 'scanning'],
  });
  const job = await enqueueJob(runtime.context.db, {
    type: 'scan_file',
    payload: { fileId },
    dedupeKey: `scan_file:${fileId}`,
  });
  console.log(`Queued scan job ${job.id} for ${fileId}.`);
  return 0;
}

async function doRetryJob(runtime: Runtime, args: Args): Promise<number> {
  const jobId = args.positional[0];
  if (!jobId) {
    console.error('Usage: toran-admin retry-job <job-id>');
    return 1;
  }
  const existing = await findJobById(runtime.context.db, jobId);
  if (!existing) {
    console.error('No job with that id.');
    return 1;
  }
  const job = await retryJob(runtime.context.db, { jobId, now: runtime.context.clock.now() });
  if (!job) {
    console.error(`Job ${jobId} is "${existing.status}" and cannot be retried.`);
    return 1;
  }
  console.log(`Requeued ${job.id} (${job.type}); attempts ${job.attempts}/${job.maxAttempts}.`);
  return 0;
}

async function doCleanup(runtime: Runtime, args: Args): Promise<number> {
  if (!(await confirm(args, 'run every maintenance sweep now'))) return 1;

  const scheduler = new MaintenanceScheduler(runtime.context);
  await scheduler.enqueueDue();

  const runner = new JobRunner({
    context: runtime.context,
    handlers: [scanFileJob, ...cleanupJobs],
    concurrency: 10,
    workerId: 'admin-cli',
  });

  // Drain until nothing is left to claim, bounded so a job that keeps
  // rescheduling itself cannot spin forever.
  let total = 0;
  for (let round = 0; round < 25; round += 1) {
    const stats = await runner.tick();
    total += stats.succeeded + stats.failed + stats.retried;
    if (stats.claimed === 0) break;
  }
  console.log(`Processed ${total} job(s).`);
  return 0;
}

async function doReportStatus(runtime: Runtime, args: Args): Promise<number> {
  const [reportId, status] = args.positional;
  if (!reportId || !status || !['open', 'actioned', 'dismissed'].includes(status)) {
    console.error('Usage: toran-admin report-status <report-id> <open|actioned|dismissed>');
    return 1;
  }
  const updated = await setReportStatus(runtime.context.db, {
    reportId,
    status: status as 'open' | 'actioned' | 'dismissed',
  });
  if (!updated) {
    console.error('No report with that id.');
    return 1;
  }
  console.log(`Report ${updated.id} is now "${updated.status}".`);
  return 0;
}

main()
  .then((code) => process.exit(code))
  .catch((error: unknown) => {
    console.error('[toran-admin]', error instanceof Error ? error.message : 'unknown error');
    process.exit(1);
  });
