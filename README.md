# Toran

## Introduction

Toran is a secure file-sharing service. Upload one file or several, get a single link,
share it. Set an expiry, a password, and a download limit. Revoke it whenever you want.

The idea that explains the rest of the design: **uploaded file contents never pass through
the application server.** Files move directly between the browser and S3-compatible object
storage using short-lived presigned URLs. Toran only ever handles control operations, which
is who may upload, what a link permits, and when it stops working. That is why the storage
provider is an interface, why the worker is a separate process, and why a file is not
downloadable until a scan says so.

## Development Setup

Prerequisites: Node.js 22+, npm 10+, and Docker with Compose. Give Docker at least 4 GB of
memory, since ClamAV alone needs roughly 1.5 GB.

```bash
npm ci
npm run dev:setup
```

## Run Locally

```bash
npm run dev
npm run dev -- --address 192.168.1.42   # name the interface yourself
npm run dev -- --revert                 # put everything back on loopback
npm run dev:local                       # skip the mechanism, use .env as it stands
```

The LAN exchange is plain http, so anyone on that network can capture share links and link
passwords in flight. It is a development affordance, not a deployment.

## Build

```bash
npm run build
npm run start
```

`npm run build` builds every workspace package and then the Next.js app. Package output
goes to `packages/*/dist`, and the web app builds to `apps/web/.next`.

`npm run start` runs that build against whatever `.env` says, which is still the local
stack. Toran ships no deployment path: there is no production compose file and no container
image, and `docker-compose.dev.yml` brings up PostgreSQL, MinIO and ClamAV only.

## Testing

| Command                    | What it runs                 | Needs              |
| -------------------------- | ---------------------------- | ------------------ |
| `npm test`                 | Unit tests                   | No                 |
| `npm run test:integration` | Database and pipeline suites | PostgreSQL         |
| `npm run test:e2e`         | Playwright browser flows     | The full dev stack |

## Common Commands

| Command                    | What it does                                     |
| -------------------------- | ------------------------------------------------ |
| `npm run dev`              | Run the web app and worker on this machine's LAN |
| `npm run dev:setup`        | Start infrastructure, create the bucket, migrate |
| `npm run dev:local`        | Same servers, against `.env` as it stands        |
| `npm run dev:infra`        | Start PostgreSQL, MinIO and ClamAV only          |
| `npm run dev:infra:down`   | Stop them                                        |
| `npm run build`            | Build for production                             |
| `npm run start`            | Run the build                                    |
| `npm run lint`             | ESLint, warnings treated as errors               |
| `npm run format`           | Format with Prettier                             |
| `npm run format:check`     | Prettier, verification only                      |
| `npm run typecheck`        | `tsc --noEmit` across the workspace              |
| `npm test`                 | The fast suite                                   |
| `npm run test:integration` | Integration suites                               |
| `npm run test:e2e`         | Browser flows                                    |
| `npm run db:generate`      | Generate a migration from schema changes         |
| `npm run db:migrate`       | Apply pending migrations                         |
| `npm run db:seed`          | Insert a demo row, development only              |
| `npm run db:studio`        | Open Drizzle Studio                              |
| `npm run admin`            | Run the administration CLI                       |
| `npm run secrets:scan`     | Check for committed credentials                  |
| `npm run audit:prod`       | Audit shipping dependencies for advisories       |

## Development Notes

Where the code lives:

```text
apps/web/          Next.js UI and API routes
apps/worker/       Malware scanning, cleanup jobs, admin CLI
packages/config/   Typed environment configuration and production guards
packages/database/ Drizzle schema, migrations, repositories, job queue
packages/observability/ Logging, redaction, metrics, tracing
packages/security/ Tokens, Argon2id, grants, rate limiting, client identity
packages/shared/   Browser-safe domain types, contracts, filenames, branding
packages/storage/  S3-compatible and in-memory storage providers
packages/ui/       Shared React UI primitives
```

Things that have to change in more than one place:

- **Schema changes.** Edit `packages/database/src/schema.ts`, then run
  `npm run db:generate` and commit the generated SQL alongside it. CI fails on schema drift
  with no committed migration.
- **New configuration.** Add it to `packages/config/src/schema.ts` with a default. Only a
  setting with no safe default belongs in `.env.example`, and it needs a production guard
  if the example value would be unsafe to run with.
- **Branding.** `packages/shared/src/branding.ts` plus the SVG mark in
  `packages/ui/src/Logo.tsx`. Nothing else hardcodes the product name for display.

Things that need a restart or a regeneration:

- Editing a workspace package requires that package to rebuild before the web app sees it.
  `npm run dev` handles this; a bare `next dev` does not.
- The worker compiles to `dist/` and restarts on change. Without the worker running,
  nothing ever becomes downloadable: the web app looks healthy while every upload sits in
  `scanning`.
- Changing `.env` requires restarting both processes.

Administration is a CLI rather than a dashboard:

```bash
npm run admin -- <command>
```

```text
file <file-id>                 Show a file, its links and its scan result
link <token-or-url>            Resolve a link from a token (never echoes it)
jobs [--failed]                Queue state, or failed jobs
revoke-link <share-id>         Revoke one link
block-file <file-id>           Block a file and revoke every link to it
delete-file <file-id>          Delete the record and the storage object
rescan <file-id>               Queue a fresh malware scan
retry-job <job-id>             Return a dead job to the queue
cleanup                        Run every maintenance sweep now
```

Destructive commands prompt for confirmation. Pass `--yes` for automation.

Security reporting and scope are in [.github/SECURITY.md](.github/SECURITY.md).

## Contribution Rules

- Create a new branch from `main` for every change.
- Do not commit directly to `main`.
- Open a pull request into `main` when the change is ready.
- Keep pull requests small, focused, and easy to review.
- Run `npm run lint` and `npm run build` before opening a pull request.
- Do not create commits unless explicitly asked.
- Before finishing, summarize what changed, what commands were run, what commands could not
  be run, and any remaining risks.
