# Toran

Secure file sharing. Users upload files directly to S3-compatible object storage, then
share capability links with optional passwords, expiry, and download limits.

The single idea that explains the rest of the design: file contents must not pass through
the Toran web application. Browsers upload and download directly through short-lived
presigned storage URLs, and Toran only ever authorizes those operations.

See `@README.md` and `@.github/SECURITY.md` for full project details.

## Architecture

Keep these boundaries clear:

- `apps/web/`: Next.js UI and API routes
- `apps/worker/`: Malware scanning, cleanup jobs, and admin CLI
- `packages/config/`: Typed environment configuration and production guards
- `packages/database/`: PostgreSQL schema, migrations, repositories, and job queue
- `packages/observability/`: Logging, redaction, metrics, and tracing
- `packages/security/`: Tokens, Argon2id, grants, rate limiting, and client identity
- `packages/shared/`: Browser-safe domain types, contracts, filenames, and shared utilities
- `packages/storage/`: S3-compatible and in-memory storage providers
- `packages/ui/`: Shared React UI primitives

`packages/shared/` must never depend on anything server-only. It is imported by browser
bundles, so a Node built-in reaching it breaks the client build.

`packages/*/` must never depend on `apps/*/`. The dependency direction is what lets the
worker and the web app share logic without sharing a runtime.

Prefer the existing modular monolith over new services or infrastructure.

Toran runs locally and has no deployment path: no container image, no production
compose file, no hosting configuration. `docker-compose.dev.yml` provisions PostgreSQL,
MinIO and ClamAV for development and nothing else. Do not add deployment artifacts
back without being asked.

The production configuration guards in `packages/config/` stay regardless. They only fire
on `NODE_ENV=production`, so locally they cost nothing, and they are what makes running
this anywhere else a deliberate act rather than an accident.

## Non-Negotiable Style Rules

- Never use em dashes.
- Always use Title Case for user-facing titles and labels, especially frontend content such
  as section headings and button text.
- Never use ternary operators.
- Always use curly braces for `if` statements, even for single statements.

```ts
// Correct
if (ready) {
  return;
}

// Incorrect
if (ready) return;

// Incorrect
const status = ready ? 'Ready' : 'Pending';
```

- Comments must explain **why**, not **what**.

```ts
// Correct: Re-check the limit inside the transaction because two downloads can claim the last slot at once.
await claimDownloadSlot(tx, shareId);

// Incorrect: Claim a download slot.
await claimDownloadSlot(tx, shareId);
```

- Do not use shell scripts or platform-specific shell commands. Development tooling must
  work on Windows, macOS, and Linux.
- Do not run Git commands unless explicitly requested.

## Security

Treat every upload, filename, token, password, header, and API input as untrusted.

- Never log raw share tokens, passwords, credentials, cookies, or presigned URLs.
- Never expose storage credentials to the browser.
- Files become downloadable only after an explicit clean malware-scan verdict.
- Preserve atomic download-limit enforcement and database constraints.
- Preserve origin validation, rate limits, quotas, secure cookies, CSP, and production
  startup guards.
- Keep storage buckets private.
- Use cryptographically secure randomness for tokens and secrets.
- Validate runtime input at trust boundaries. TypeScript types alone are not validation.
- Security-sensitive behavior must have regression tests.
- Do not weaken a security control just to make development or tests easier.

## Engineering Principles

- Use strict TypeScript and avoid `any`.
- Prefer readable control flow over clever or compact code.
- Keep third-party and vendor-specific logic isolated from core domain logic.
- Keep secrets, credentials, tokens, and sensitive data out of source code, logs, stored
  files, and tests.
- Do not add infrastructure, dependencies, interfaces, or abstractions without a concrete
  need. Reuse existing modules first.
- Keep background jobs idempotent and safe to retry.
- Preserve transaction boundaries for concurrent or security-sensitive database operations.
- Keep changes scoped to the task being implemented.
- Update documentation when APIs, architecture, configuration, or user-visible behavior
  changes.
- Do not claim unfinished or unverified functionality is implemented.

## Testing

Add tests for meaningful behavior and failure cases.

Pay particular attention to:

- Upload and download lifecycle
- Multi-file share links
- Expiry, revocation, passwords, and download limits
- Concurrent database operations
- Malware scanning and scan failures
- Cleanup and worker retries
- Filename and input validation
- Token and log redaction
- Production configuration guards

Never remove, skip, or weaken a test merely to make a change pass.

## Before Finishing

Run the relevant repository checks and fix all failures:

```bash
npm run format:check
npm run lint
npm run typecheck
npm test
npm run build
npm run secrets:scan
npm run audit:prod
```

Run integration or end-to-end tests when the change affects database, storage, worker, API,
or user flows:

```bash
npm run test:integration
npm run test:e2e
```

Review the final diff for unnecessary code, unused dependencies, style violations, security
regressions, secrets, stale documentation, and accidental scope expansion.
