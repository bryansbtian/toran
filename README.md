<!-- SPDX-License-Identifier: MIT -->

# Toran

**Share a file. Keep the keys.**

Toran is an open-source, self-hostable file-sharing service. Upload one file or
several, get a single link, share it. Set an expiry, a password, and a download
limit. Revoke it whenever you want.

The part that makes Toran different is architectural: **uploaded file contents
never pass through the application server.** Files move directly between the
browser and your own S3-compatible object storage using short-lived presigned
URLs. Toran only ever handles control operations - who may upload, what the
link permits, and when it stops working.

```text
Control operations go through the Toran API.

File contents move directly between the browser and
S3-compatible object storage using short-lived presigned URLs.
```

> **Project status: MVP.** Toran is feature-complete for its stated scope and
> every documented command works, but it has not yet had an external security
> audit and has not been run at scale. Read [Known limitations](#known-limitations)
> before putting it in front of untrusted users.

**Hosted demo:** No public hosted demo is currently available. Self-host with
[Docker Compose](#self-hosting-with-docker) in about five minutes.

---

## Table of Contents

- [Features](#features)
- [Architecture](#architecture)
- [Quick Start](#quick-start)
- [Contributor Setup](#contributor-setup)
- [Self-Hosting with Docker](#self-hosting-with-docker)
- [Environment Variables](#environment-variables)
- [Storage Configuration](#storage-configuration)
- [Production Deployment](#production-deployment)
- [Security Model](#security-model)
- [Malware Scanning and Its Limits](#malware-scanning-and-its-limits)
- [Backup and Recovery](#backup-and-recovery)
- [Upgrading](#upgrading)
- [Administration](#administration)
- [Troubleshooting](#troubleshooting)
- [Roadmap](#roadmap)
- [Contributing](#contributing)
- [License](#license)

---

## Features

**Sharing**

- Drag-and-drop or file-picker uploads with live progress and cancel.
- **Several files behind one link** - up to 20. The recipient sees them listed
  and picks which to download.
- Each file has its own upload, scan and availability state, so a file that has
  passed its scan is downloadable while a slower sibling is still being checked.
- One-click copy of the generated link, with confirmation.
- Configurable expiry, from one hour up to the server's maximum. A link never
  outlives the earliest expiry among its files.
- Optional password protection (Argon2id), covering the whole link.
- Optional maximum download count, enforced atomically and budgeted **per
  file**.
- Revoke any link instantly; revocation covers every file behind it.
- Clear, specific messages for expired, revoked, exhausted, scanning, blocked
  and unavailable links.

**Security**

- Files never traverse the application server.
- Share tokens carry 192 bits of entropy; only a SHA-256 hash is stored.
- Private buckets, random object keys, short-lived presigned URLs.
- Argon2id password hashing with rate-limited attempts.
- ClamAV malware scanning, enabled by default, that fails closed.
- Strict CSP, `nosniff`, no-referrer, clickjacking protection, origin checks.
- Structured JSON logs that redact tokens, passwords and presigned URLs.
- Refuses to start in production with example credentials or unsafe settings.

**Operations**

- Single Docker Compose command to self-host.
- Database-backed job queue with retries, backoff and crash recovery.
- Automatic cleanup of expired files, links, objects and stale uploads.
- Abuse reporting endpoint and form.
- Command-line administration tool.
- `/api/health` and `/api/ready` for orchestrators.
- OpenTelemetry-compatible instrumentation hooks.

**Experience**

- Responsive, accessible interface (semantic HTML, keyboard navigation,
  visible focus, WCAG AA contrast).
- Light and dark themes, and reduced-motion support.
- No tracking, no analytics, no third-party requests.

---

## Architecture

Toran is a **modular monolith**: one Next.js application, one worker process,
and a set of shared packages. There are no microservices, because nothing here
needs them.

![Toran system architecture showing the browser, web application, object storage, PostgreSQL, worker, and ClamAV](docs/images/architecture.png)

### Upload Flow

One link may serve several files, so the link cannot exist until every file in
the batch has been stored and verified. Creating it is therefore a step of its
own, after the per-file work.

**Per file, in turn:**

1. The browser asks the API for an upload session (`POST /api/uploads`).
2. The API validates the file name, declared size, content type, expiry, rate
   limits and per-client quotas.
3. The API creates a random storage key, a `files` row, an `upload_sessions`
   row, a short-lived presigned `PUT` URL, and a manage grant proving this
   caller owns the file.
4. The browser uploads the bytes **directly to object storage**.
5. The browser reports completion (`POST /api/uploads/{id}/complete`).
6. The API issues a storage `HEAD` and verifies the actual object size against
   the declared size.
7. The file enters `scanning` and a scan job is queued for it. This step
   creates no link.

**Once every file is complete:**

8. The browser calls `POST /api/shares` with the whole set of file ids, their
   manage grants, and the link settings - expiry, password, download limit.
9. Toran mints one link over all of them, in the order given, and returns the
   raw token exactly once.
10. Each file is scanned independently by the worker, which streams the object
    to ClamAV; the file becomes `ready`, `blocked`, or `failed` on its own.
11. The share page shows every file with its own status, and offers a download
    only for the ones that are `ready`.

### Download Flow

1. A visitor opens `/s/{token}`, a client-rendered shell.
2. The page fetches `GET /api/shares/{token}`. Toran hashes the token, resolves
   the set of files behind that link, and returns each with its own status and
   remaining downloads.
3. Link-level controls apply to the whole set: revocation, expiry, and any
   password (exchanged for a link-scoped grant cookie at
   `POST /api/shares/{token}/authorize`).
4. The visitor picks a file. `POST /api/shares/{token}/download` carries its
   `fileId`, which may be omitted only when the link serves exactly one file.
5. Toran re-checks that **this** file is downloadable - ready, not deleted,
   blocked or expired, and with budget left - and reports the file's own
   reason if not. A link can be perfectly usable while one of its files is not.
6. It **atomically** reserves one download slot for that file alone.
7. It signs a short-lived presigned `GET` URL for that one object, with a safe
   filename and a neutralised content type. If signing fails, the reservation
   is released.
8. The browser fetches the file from storage.

Full detail, including every state transition and race condition, is in
[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

### Repository Layout

```text
toran/
├── apps/
│   ├── web/         Next.js application: UI + API routes
│   └── worker/      Job runner, ClamAV scanner, cleanup, admin CLI
├── packages/
│   ├── config/          Typed, validated environment configuration
│   ├── database/        Drizzle schema, migrations, repositories, queue
│   ├── observability/   Structured logging with redaction, OTel hooks
│   ├── security/        Tokens, Argon2id, rate limiting, grants, identity
│   ├── shared/          Domain types, Zod contracts, filename safety, branding
│   ├── storage/         StorageProvider interface + S3 and in-memory impls
│   └── ui/              Accessible React primitives and the logo
├── docker/clamav/       ClamAV configuration notes
├── docs/                Architecture, deployment, API, threat model, ...
├── scripts/             dev-setup, secret scan
├── docker-compose.yml       Production self-hosting stack
└── docker-compose.dev.yml   Development infrastructure only
```

---

## Quick Start

You need **Node.js 22+**, **npm 10+**, and **Docker** with Compose. Give Docker
at least **4 GB of memory**; ClamAV alone needs roughly 1.5 GB.

```bash
git clone https://github.com/bryansbtian/toran.git
cd toran
npm install
npm run dev:setup
npm run dev
```

`npm run dev` ends by printing the address it settled on. Open **that one**:

```text
Toran is available at http://192.168.1.42:3000
Share links will work for devices on this network.
```

`npm run dev:setup` creates `.env` from `.env.example` if you do not have one,
starts PostgreSQL, MinIO and ClamAV, waits for them to be healthy, creates the
development bucket as a **private** bucket, builds the workspace packages, and
applies database migrations. It is safe to run again at any time.

`npm run dev` then starts the web app **and** the background worker that scans
uploads and runs the cleanup jobs. Without the worker nothing ever becomes
downloadable: the web app looks healthy while every upload sits in `scanning`.

ClamAV downloads its signature database on first boot, which takes a few
minutes. Until it is ready, uploads sit in the `scanning` state and the share
page says so. Watch it with `docker logs -f toran-dev-clamav`.

### Sharing Links on Your Local Network

`npm run dev` addresses the instance to this machine's LAN address rather than
`localhost`, because a `localhost` link is not one you can send anyone - it
points at whatever machine opens it. It detects the address, writes it to
`TORAN_APP_URL`, `TORAN_DOWNLOAD_URL`, `S3_ENDPOINT` and `S3_PUBLIC_ENDPOINT`,
publishes MinIO on the network and starts the infrastructure, all before the
servers come up. With no network to bind to it falls back to localhost rather
than refusing to start.

Open the address it prints **rather than `localhost`**: storage only accepts
browser uploads from the origin the instance is configured for, so reaching a
LAN-addressed instance through `localhost` fails at the upload step. Windows
users may need to allow ports 3000 and 9000 through the firewall. Press Ctrl+C
to stop.

If the detection picks a virtual adapter, or you have several networks, name the
one you want. `--revert` puts everything back on loopback, and `dev:local` skips
the whole mechanism and uses whatever `.env` already says:

```bash
npm run dev -- --address 192.168.1.42
npm run dev -- --revert
npm run dev:local
```

For this to work:

- Both devices must be on the **same local network**.
- Ports **3000 and 9000** must both be reachable. Downloads redirect the browser
  straight to object storage, so 9000 matters as much as 3000.
- The first run usually triggers a **firewall prompt**. On Windows, allow both
  ports for Private networks; you may need to add the rules by hand if no prompt
  appears.
- Generated links carry the **detected LAN address**, not `localhost`. That
  address can change when you reconnect, and links made under the old one stop
  working. Re-run the command if that happens.

The exchange is plain http, so anyone on that network can capture share links and
link passwords in flight. That is fine for handing a file to a colleague across
the room, and it is not a deployment. For an office instance people rely on, use
[docs/DEPLOYMENT.md](docs/DEPLOYMENT.md) with a real hostname and a certificate.

---

## Contributor Setup

Every command below is run from the repository root.

| Command                    | What it does                                       |
| -------------------------- | -------------------------------------------------- |
| `npm run dev`              | Start the web app and worker on this machine's LAN |
| `npm run dev:setup`        | Start infrastructure, create the bucket, migrate   |
| `npm run dev:local`        | Same servers, against `.env` as it stands          |
| `npm run dev:lan`          | Alias of `npm run dev`                             |
| `npm run dev:infra`        | Start PostgreSQL, MinIO and ClamAV only            |
| `npm run dev:infra:down`   | Stop them                                          |
| `npm run build`            | Build every workspace package and the app          |
| `npm run start`            | Start the built web app                            |
| `npm run lint`             | ESLint across the workspace                        |
| `npm run format`           | Format with Prettier                               |
| `npm run format:check`     | Verify formatting without writing                  |
| `npm run typecheck`        | TypeScript, no emit                                |
| `npm test`                 | Unit tests (no external services needed)           |
| `npm run test:integration` | Integration tests (needs PostgreSQL)               |
| `npm run test:e2e`         | Playwright tests (needs the full dev stack)        |
| `npm run db:generate`      | Generate a migration from schema changes           |
| `npm run db:migrate`       | Apply pending migrations                           |
| `npm run db:seed`          | Insert a demo row (development only)               |
| `npm run db:studio`        | Open Drizzle Studio                                |
| `npm run admin`            | Run the administration CLI                         |
| `npm run secrets:scan`     | Check for committed credentials                    |
| `npm run audit:prod`       | Audit shipping dependencies for advisories         |

`npm test` runs only unit tests; the integration suites are a separate config
and are never picked up by it. Locally, integration and end-to-end tests skip
themselves with a clear message when the database is unreachable, so nothing
fails just because Docker is not running. In CI, where the services are
provisioned, `TORAN_REQUIRE_INTEGRATION=true` turns that skip into a failure.

Read [CONTRIBUTING.md](CONTRIBUTING.md) before opening a pull request.

---

## Self-Hosting with Docker

1. Clone the repository and create `.env` from `.env.example`.
2. Edit `.env`. Toran refuses to start with the example values.
3. `docker compose up -d`.

```bash
git clone https://github.com/toran-project/toran.git
cd toran
```

Copy the template to `.env` however your shell does that - `cp .env.example .env`
on Linux and macOS, `Copy-Item .env.example .env` in PowerShell - then open it in
an editor and set at minimum:

```dotenv
NODE_ENV=production
TORAN_APP_URL=https://toran.example.com
TORAN_DOWNLOAD_URL=https://files.toran.example.com
TORAN_SECURE_COOKIES=true
TORAN_RATE_LIMIT_BACKEND=postgres

# Replace each of these with a freshly generated value. Never reuse the
# example values, and never write a shell command as a value: an .env file is
# parsed, not executed.
TORAN_SECRET_KEY=paste-a-generated-value-here
POSTGRES_PASSWORD=paste-a-generated-value-here
MINIO_ROOT_USER=paste-a-generated-value-here
MINIO_ROOT_PASSWORD=paste-a-generated-value-here
```

To generate each value, run this in a terminal and copy what it prints:

```bash
node -e "console.log(require('node:crypto').randomBytes(32).toString('base64url'))"
```

`POSTGRES_PASSWORD`, `MINIO_ROOT_USER` and `MINIO_ROOT_PASSWORD` are consumed by
`docker-compose.yml`, which builds `DATABASE_URL` and the S3 credentials for the
containers from them. Then:

```bash
docker compose up -d
```

The stack starts:

| Service            | Purpose                                | Public port                        |
| ------------------ | -------------------------------------- | ---------------------------------- |
| `toran-web`        | Application and API                    | yes (behind your reverse proxy)    |
| `toran-worker`     | Scanning, cleanup, reconciliation      | no                                 |
| `toran-migrate`    | Applies migrations once, then exits    | no                                 |
| `toran-postgres`   | Metadata and job queue                 | no                                 |
| `toran-minio`      | Object storage                         | only if browsers reach it directly |
| `toran-minio-init` | Creates the private bucket, then exits | no                                 |
| `toran-clamav`     | Malware scanning                       | no                                 |

All services have health checks, restart policies, persistent volumes, an
internal network, and example resource limits. Containers run as non-root and
shut down gracefully.

Put a TLS-terminating reverse proxy in front of `toran-web`. Full instructions,
including Caddy and nginx configurations, are in
[docs/DEPLOYMENT.md](docs/DEPLOYMENT.md).

---

## Environment Variables

Every variable is parsed and validated at startup by `@toran/config`. Toran
**refuses to start in production** when a required secret is missing, still set
to an example value, or set to something unsafe. There is no flag that
downgrades those checks to warnings.

`.env.example` is the authoritative, fully commented reference. The essentials:

### Application

| Variable                    | Default                 | Notes                                                                                  |
| --------------------------- | ----------------------- | -------------------------------------------------------------------------------------- |
| `NODE_ENV`                  | `development`           | `development` \| `test` \| `production`                                                |
| `TORAN_APP_URL`             | `http://localhost:3000` | Public origin. Must be HTTPS in production.                                            |
| `TORAN_DOWNLOAD_URL`        | `http://localhost:9000` | Storage origin browsers are sent to. Should differ from `TORAN_APP_URL` in production. |
| `PORT`                      | `3000`                  | Listen port                                                                            |
| `TORAN_SECRET_KEY`          | -                       | **Required.** ≥32 chars. Keys HMACs for grants and client identifiers.                 |
| `TORAN_SECURE_COOKIES`      | `false`                 | Must be `true` in production                                                           |
| `TORAN_TRUSTED_PROXIES`     | empty                   | CIDRs allowed to set `X-Forwarded-For`. Empty means trust none.                        |
| `TORAN_LOG_LEVEL`           | `info`                  | `trace`…`fatal`                                                                        |
| `TORAN_ABUSE_CONTACT_EMAIL` | `abuse@example.invalid` | Shown in the UI                                                                        |

### Database and Storage

| Variable                         | Default     | Notes                                                           |
| -------------------------------- | ----------- | --------------------------------------------------------------- |
| `DATABASE_URL`                   | -           | **Required.** PostgreSQL connection string                      |
| `DATABASE_POOL_MAX`              | `10`        | Pooled connections per process                                  |
| `S3_ENDPOINT`                    | empty       | Leave empty for AWS S3                                          |
| `S3_PUBLIC_ENDPOINT`             | empty       | Origin the browser uses, if different from the signing endpoint |
| `S3_REGION`                      | `us-east-1` |                                                                 |
| `S3_BUCKET`                      | -           | **Required.** Must be private                                   |
| `S3_ACCESS_KEY_ID`               | -           | **Required**                                                    |
| `S3_SECRET_ACCESS_KEY`           | -           | **Required**                                                    |
| `S3_FORCE_PATH_STYLE`            | `true`      | `true` for MinIO, `false` for AWS S3                            |
| `TORAN_UPLOAD_URL_TTL_SECONDS`   | `900`       | Presigned upload lifetime                                       |
| `TORAN_DOWNLOAD_URL_TTL_SECONDS` | `120`       | Presigned download lifetime                                     |

### Limits and Abuse Prevention

| Variable                            | Default               | Notes                                         |
| ----------------------------------- | --------------------- | --------------------------------------------- |
| `TORAN_MAX_FILE_SIZE_BYTES`         | `104857600` (100 MiB) | See [upload size limits](#upload-size-limits) |
| `TORAN_DEFAULT_EXPIRY_SECONDS`      | `86400`               | 1 day                                         |
| `TORAN_MAX_EXPIRY_SECONDS`          | `604800`              | 7 days                                        |
| `TORAN_MAX_DOWNLOAD_LIMIT`          | `1000`                | Largest requestable download cap              |
| `TORAN_MAX_REQUEST_BODY_BYTES`      | `65536`               | JSON body ceiling                             |
| `TORAN_REQUEST_TIMEOUT_MS`          | `15000`               | Per-request server timeout                    |
| `TORAN_ANON_MAX_ACTIVE_FILES`       | `25`                  | Per anonymous identifier                      |
| `TORAN_ANON_MAX_STORAGE_BYTES`      | `1073741824` (1 GiB)  | Per anonymous identifier                      |
| `TORAN_ANON_MAX_CONCURRENT_UPLOADS` | `3`                   | Per anonymous identifier                      |
| `TORAN_RATE_LIMIT_BACKEND`          | `memory`              | **Must be `postgres` in production**          |
| `TORAN_RATE_LIMIT_UPLOAD_CREATE`    | `20/3600`             | `<max>/<windowSeconds>`                       |
| `TORAN_RATE_LIMIT_UPLOAD_COMPLETE`  | `40/3600`             |                                               |
| `TORAN_RATE_LIMIT_DOWNLOAD`         | `120/3600`            |                                               |
| `TORAN_RATE_LIMIT_PASSWORD`         | `10/900`              | Per link **and** per client                   |
| `TORAN_RATE_LIMIT_REPORT`           | `5/3600`              |                                               |

### Scanning and Worker

| Variable                              | Default              | Notes                                        |
| ------------------------------------- | -------------------- | -------------------------------------------- |
| `TORAN_SCANNING_ENABLED`              | `true`               | **Development-only** escape hatch when false |
| `CLAMAV_HOST` / `CLAMAV_PORT`         | `localhost` / `3310` | clamd address                                |
| `CLAMAV_TIMEOUT_MS`                   | `120000`             |                                              |
| `CLAMAV_MAX_SCAN_BYTES`               | `104857600`          | Larger objects fail closed                   |
| `TORAN_BLOCKED_FILE_ACTION`           | `quarantine`         | `delete` \| `quarantine`                     |
| `TORAN_WORKER_CONCURRENCY`            | `2`                  | Jobs claimed per tick                        |
| `TORAN_WORKER_JOB_LOCK_SECONDS`       | `300`                | Lock expiry for crash recovery               |
| `TORAN_WORKER_MAX_ATTEMPTS`           | `5`                  | Retries before a job is dead                 |
| `TORAN_CLEANUP_INTERVAL_SECONDS`      | `300`                | Maintenance cadence                          |
| `TORAN_CLEANUP_BATCH_SIZE`            | `200`                | Rows per sweep                               |
| `TORAN_UPLOAD_SESSION_TTL_SECONDS`    | `3600`               | Abandoned-upload reclaim                     |
| `TORAN_DOWNLOAD_EVENT_RETENTION_DAYS` | `30`                 | Analytics retention                          |

---

## Storage Configuration

Toran talks to any S3-compatible service through one narrow interface. The
bucket **must be private**: Toran never relies on public objects, and a public
bucket would let anyone enumerate and read every file.

### MinIO (Default)

```bash
S3_ENDPOINT=http://minio:9000
S3_PUBLIC_ENDPOINT=https://files.example.com
S3_FORCE_PATH_STYLE=true
S3_REGION=us-east-1
```

`S3_ENDPOINT` is used for signing (in-cluster). `S3_PUBLIC_ENDPOINT` is the
origin the browser is sent to. Only the origin is rewritten, so the signature
stays valid.

### AWS S3

```bash
S3_ENDPOINT=
S3_PUBLIC_ENDPOINT=
S3_FORCE_PATH_STYLE=false
S3_REGION=eu-west-1
S3_BUCKET=my-toran-bucket
```

### Other Providers

Cloudflare R2, Backblaze B2, Wasabi, Ceph RGW and Garage all work: set
`S3_ENDPOINT` to the provider's endpoint and choose path style according to
their documentation.

### CORS

Browsers upload directly to storage, so the bucket must allow `PUT` from your
application origin and expose `ETag`. Provider-specific CORS configuration is
in [docs/STORAGE.md](docs/STORAGE.md).

### Upload Size Limits

The MVP uses **single-request uploads**. One `PUT` carries the whole file, so:

- Practical ceiling is roughly what a browser and your network will hold open
  for the duration; 100 MiB is a comfortable default, and a few GiB works on a
  good connection.
- There is no resume. A dropped connection means starting over.
- AWS S3's hard limit for a single `PUT` is 5 GiB.

The `StorageProvider` interface is deliberately shaped so multipart and
resumable uploads can be added without changing any caller. That work is on the
[roadmap](#roadmap).

---

## Production Deployment

Docker Compose is the **primary supported path**. See
[docs/DEPLOYMENT.md](docs/DEPLOYMENT.md) for:

- Reverse proxy configuration (Caddy and nginx).
- A separate download hostname, and why it matters.
- Managed deployment: web on Vercel or Fly, managed PostgreSQL, managed S3,
  worker on a container platform.
- **Why Vercel alone is not enough:** Toran's default architecture needs a
  long-running worker process and a ClamAV daemon. Vercel runs functions, not
  persistent containers, and cannot host clamd. You can put the web tier on
  Vercel, but the worker and ClamAV need a container platform (Fly.io, Railway,
  Render, ECS, a VPS). An optional Vercel guide is included.
- The full [production checklist](docs/DEPLOYMENT.md#production-checklist).

---

## Security Model

Toran's threat model, in one paragraph: **the share URL is a capability.**
Anyone who has it can download every file behind it, subject to whatever limits
the link carries. Everything else follows from protecting that URL and from
never trusting an uploaded byte.

| Control                    | How                                                                                                                                                         |
| -------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Link enumeration           | 192-bit tokens; only SHA-256 hashes stored; uniform responses for missing/revoked/expired links                                                             |
| Token leakage              | Never logged, never in job payloads, no link detail server-rendered, `no-store`, `Referrer-Policy: no-referrer`                                             |
| Database leakage           | Token hashes and Argon2id password hashes only; no raw IPs; no plaintext secrets                                                                            |
| Storage credential leakage | Credentials never reach the browser; only presigned URLs, valid for minutes                                                                                 |
| Password brute force       | Argon2id (19 MiB, t=2); one password per link, checked before any file is served; rate limits per link and per client; decoy verification for missing links |
| Malicious uploads          | ClamAV scanning that fails closed, per file; a file becomes `ready` only on clamd's exact `stream: OK` reply for the whole object                           |
| Content-type confusion     | Active formats forced to `application/octet-stream`; always `Content-Disposition: attachment`; `nosniff`                                                    |
| XSS                        | No uploaded content is rendered on the app origin; strict CSP; React output encoding                                                                        |
| CSRF                       | Origin validation on every mutation; `SameSite=Strict` HttpOnly grant cookies                                                                               |
| Race conditions            | Atomic single-statement per-file download reservation + a database CHECK; `FOR UPDATE SKIP LOCKED` job claiming; idempotent completion                      |
| Re-sharing someone's file  | `POST /api/shares` requires a manage grant for every file id; an id without one is reported as `NOT_FOUND`                                                  |
| Filename attacks           | Path components stripped, control characters and bidi overrides rejected, reserved names refused, length capped                                             |
| Object-key injection       | Keys are generated, never derived; every storage call validates the key shape                                                                               |
| Denial of service          | Rate limits, per-client quotas, body size caps, request timeouts, bounded worker concurrency                                                                |
| Abuse                      | Reporting endpoint, admin CLI to block and delete, documented takedown process                                                                              |

Full analysis (risk, mitigation, **remaining limitation**, and future
improvement for each) is in [docs/THREAT_MODEL.md](docs/THREAT_MODEL.md).

### Known Limitations

These are real and deliberate. Read them before trusting Toran with anything
important.

1. **Presigned downloads are not perfectly single-use.** Toran atomically
   reserves the download slot, but the URL it returns stays valid until it
   expires (default 120 seconds). Someone who captures that URL within the
   window can reuse it. A future proxy-download mode will close this; the
   architecture already accommodates it.
2. **Malware scanning is not a safety guarantee.** See below.
3. **No end-to-end encryption.** The server and the storage operator can read
   file contents. Toran protects files in transit and at rest against outsiders,
   not against the operator.
4. **Anonymous quotas are best-effort.** They key on a rotating hash of the
   client address, so they rotate daily and can be bypassed by changing network.
5. **The share token appears in the share page's HTML, not just its URL.**
   `/s/[token]` is a dynamic route, so Next.js serialises the request's own URL
   into the page payload. The response is uncacheable and goes only to the
   client that already supplied the token, but anything that inspects response
   bodies sees it too. Fragment-based tokens are the fix; see
   [docs/THREAT_MODEL.md](docs/THREAT_MODEL.md).
6. **The link-metadata endpoint is not rate limited**, because the download page
   polls it while a file is scanning. Rate limit `/api/shares/` at your reverse
   proxy if you expect hostile traffic.
7. **No external security audit yet.**

---

## Malware Scanning and Its Limits

Toran streams every upload to ClamAV before a link will serve it, and **fails
closed**: a file becomes `ready` only when clamd replies with its exact
`stream: OK` line for the whole object. A stream that ends short of the object's
recorded size is refused rather than interpreted, and a scanner outage leaves
files in `scanning`, not available.

Each file of a link is scanned on its own, so a clean file becomes downloadable
while a slower sibling is still being checked. **An infected file revokes the
whole link**, including its clean siblings: a batch that carried malware is not
one Toran keeps serving from. The file itself is quarantined or deleted per
`TORAN_BLOCKED_FILE_ACTION`.

**This does not make every file safe.** ClamAV detects _known_ signatures. It
will not catch a novel payload, a targeted attack, an encrypted archive, a
malicious document that only executes on open, or anything written after the
last signature update. Toran tells users this on the download page, and you
should tell your users too.

Keep signatures current - stale signatures are worse than none, because they
create false confidence. The `toran-clamav` container runs `freshclam`
automatically.

Disabling scanning (`TORAN_SCANNING_ENABLED=false`) is a **development-only**
setting. Toran refuses to start in production with it off.

---

## Backup and Recovery

**Backing up PostgreSQL alone is not enough.** The database holds metadata;
object storage holds the files. Restoring one without the other gives you either
links to files that do not exist, or files nobody can reach.

Back up all four:

1. **PostgreSQL** - `pg_dump`, nightly, tested restores.
2. **Object storage** - bucket replication or `mc mirror`.
3. **Environment configuration** - your `.env`, in a secret manager.
4. **`TORAN_SECRET_KEY`** - losing it invalidates every outstanding
   password-authorisation grant and every anonymous quota identifier.

Procedures, including point-in-time recovery and consistency checks, are in
[docs/BACKUP.md](docs/BACKUP.md).

---

## Upgrading

```bash
git pull
docker compose build
docker compose up -d
```

The `toran-migrate` service applies pending migrations before the worker starts.
Migrations are **forward-only and additive**; Toran never runs a destructive
statement automatically. Back up before upgrading. See
[docs/UPGRADING.md](docs/UPGRADING.md).

---

## Administration

Toran ships a command-line admin tool rather than a dashboard.

```bash
docker compose exec worker node apps/worker/dist/cli/main.js <command>

# or, in development:
npm run admin -- <command>
```

```text
file <file-id>                 Show a file, its links and its scan result
link <token-or-url>            Resolve a link from a token (never echoes it)
reports [--limit N]            List open abuse reports
jobs [--failed]                Queue state, or failed jobs
revoke-link <share-id>         Revoke one link
block-file <file-id>           Block a file and revoke every link to it
delete-file <file-id>          Delete the record and the storage object
rescan <file-id>               Queue a fresh malware scan
retry-job <job-id>             Return a dead job to the queue
cleanup                        Run every maintenance sweep now
report-status <id> <status>    Set a report to open|actioned|dismissed
```

Destructive commands prompt for confirmation. Pass `--yes` for automation.

---

## Troubleshooting

**Uploads fail with "could not reach storage"**
The browser is blocked from reaching object storage. Check that
`S3_PUBLIC_ENDPOINT` (or `S3_ENDPOINT`) is an origin the browser can resolve,
and that the bucket allows CORS `PUT` from `TORAN_APP_URL`. The Content-Security-Policy
must also include that origin - Toran adds it automatically from the environment
at request time, so restart the app after changing it.

**Links stay stuck on "Scanning this file"**
ClamAV is not ready or not reachable. `docker logs -f toran-clamav`. The first
boot downloads a signature database and can take several minutes. The worker
retries with backoff; nothing is lost.

**"Toran configuration is invalid" on startup**
Read the message: it names every offending variable and never prints its value.
In production Toran rejects example credentials, HTTP URLs, insecure cookies,
disabled scanning, and the in-memory rate limiter.

**`/api/ready` returns 503**
One dependency is unreachable. The response says which. The server log carries
the specific reason.

**Uploads rejected as too large**
`TORAN_MAX_FILE_SIZE_BYTES`. Remember the MVP uses single-request uploads.

**Downloads give the wrong filename**
Toran sets `Content-Disposition` through presigned response overrides. Some
S3-compatible services ignore them; check `docs/STORAGE.md` for your provider.

More in [docs/TROUBLESHOOTING.md](docs/TROUBLESHOOTING.md).

---

## Roadmap

Near-term, roughly in order:

- [ ] Multipart and resumable uploads (the storage interface is already shaped for it)
- [ ] Optional proxy-download mode for true single-use downloads
- [ ] User accounts (the schema already reserves `users` and `files.owner_id`)
- [ ] A file management page for uploaders
- [ ] Client-side end-to-end encryption
- [ ] Redis rate-limiter backend
- [ ] Prometheus metrics endpoint
- [ ] Internationalisation
- [ ] Admin web dashboard
- [ ] External security audit

---

## Contributing

Contributions are welcome. Start with [CONTRIBUTING.md](CONTRIBUTING.md), which
covers the development setup, code standards, testing expectations, and the
review process. Issues labelled **good first issue** are scoped for a first
contribution.

By participating you agree to the [Code of Conduct](docs/CONDUCT.md).

To report a security vulnerability, follow [SECURITY.md](SECURITY.md). Please do
not open a public issue.

---

## License

Toran is free software licensed under the **[MIT License](LICENSE)**.

You may use, copy, modify, merge, publish, distribute, sublicense, and sell
copies of Toran, including in closed-source and commercial products, provided
the copyright notice and the permission notice are preserved in all copies or
substantial portions of the software. The software is provided "as is", without
warranty of any kind.

Running a modified Toran as a hosted service does **not** oblige you to publish
your changes. Contributions back are welcome, not required.

Dependency licences are reviewed automatically in CI (see
[docs/LICENSING.md](docs/LICENSING.md)), but **that is not a legal review**.
Maintainers should obtain a formal review before any commercial launch.
