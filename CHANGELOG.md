<!-- SPDX-License-Identifier: MIT -->

# Changelog

All notable changes to Toran are documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and
Toran uses [Semantic Versioning](https://semver.org/spec/v2.0.0.html). While the
major version is `0`, minor releases may contain breaking changes.

## [Unreleased]

Nothing yet.

## [0.1.0] - YYYY-MM-DD

<!--
  Release date to confirm: set this to the day the `v0.1.0` tag is published,
  and update the comparison links at the bottom of this file to match.
-->

First public release. Toran is an MVP: feature-complete for its stated scope,
but it has not had an external security audit and has not been run at scale.
Read [Known limitations](#known-limitations) before putting it in front of
untrusted users.

### Added

**Sharing**

- Anonymous uploads by drag-and-drop or file picker, with live progress and
  cancel.
- **One link can serve several files** - up to 20. Select or drop any number,
  and the recipient sees them listed and chooses which to download. Each file
  is fetched on its own presigned URL, so file contents still never pass
  through the application server.
  - Every file carries its own upload, scan, storage and availability state. A
    file that passes its scan becomes downloadable immediately, while a slower
    sibling is still shown as scanning.
  - An optional maximum download count is a budget **per file**. One recipient
    exhausting one file leaves the others untouched.
  - A link's expiry is clamped to the earliest expiry among its files, so a
    link can never outlive content the cleanup job has removed.
  - The link is created only after every file in the batch has been stored and
    verified, by `POST /api/shares` over the whole set.
- Generated share links with one-click copy and confirmation.
- Configurable link expiry, from one hour to the server maximum.
- Optional password protection using Argon2id, applied to the link as a whole.
- Link revocation, which applies to the link and every file behind it.
- A public download page listing each file with its own name, size, state and
  remaining downloads, and distinct link-level states for expired, revoked,
  exhausted, scanning, blocked, deleted and unavailable.

**Architecture**

- Direct browser-to-storage uploads via short-lived presigned `PUT` URLs;
  file contents never pass through the application server.
- Storage `HEAD` verification of the actual object size after upload.
- Idempotent upload completion: repeated requests never duplicate a file record
  or a scan job.
- `StorageProvider` abstraction with S3-compatible and in-memory
  implementations, shaped to accept multipart and resumable uploads later.
- Database-backed job queue using `FOR UPDATE SKIP LOCKED`, with retries,
  jittered backoff, lock expiry and crash recovery.
- Background jobs for malware scanning, expired-file cleanup, expired-link
  cleanup, storage-object deletion, stale-upload cleanup, failed-scan retries,
  download-event retention, and database/storage reconciliation.
- ClamAV scanning worker speaking the clamd `INSTREAM` protocol directly.

**Security**

- 192-bit share tokens; only SHA-256 hashes stored.
- Argon2id password hashing (19 MiB, t=2, p=1) via pure WebAssembly.
- Atomic per-file download reservation, backed by a database CHECK constraint.
  A reservation is released if the presigned URL cannot then be signed.
- Malware scanning that fails closed. A file becomes `ready` only on clamd's
  exact `stream: OK` reply, and a stream that ends short of the object's
  recorded size is refused rather than interpreted - a storage read that ended
  early without raising must not have a prefix blessed as clean.
- Both processes refuse to start on unsafe production configuration and exit
  non-zero - the worker from `main()`, the web tier from a Next.js
  `instrumentation` hook - rather than serving errors behind a healthy
  `/api/health`. There is no flag that downgrades these checks to warnings.
- Filename normalisation: path stripping, control-character and bidi-override
  rejection, reserved-name refusal, length capping.
- Active content types forced to `application/octet-stream` and always served
  as attachments.
- Randomly generated storage keys, validated on every storage call.
- Runtime Content-Security-Policy, `nosniff`, `no-referrer`, Permissions-Policy,
  clickjacking protection and HSTS.
- Origin validation on every mutating endpoint, resolved from the `Host` header
  the browser actually addressed, with `X-Forwarded-Host` and `-Proto` honoured
  only when `TORAN_TRUSTED_PROXIES` is set.
- Short-lived, link-scoped, HttpOnly `SameSite=Strict` download grants.
- Rate limiting with in-memory (development) and PostgreSQL (production)
  backends, plus per-client quotas on active files, storage and concurrency.
- Privacy-preserving rotating client identifiers; raw IP addresses are never
  stored.
- Structured JSON logging that redacts tokens, passwords, credentials and
  presigned URLs by key name and by value pattern.

**Operations**

- Production Docker Compose stack: web, worker, migrations, PostgreSQL, MinIO,
  bucket initialisation and ClamAV, with health checks, restart policies,
  persistent volumes, an internal network and example resource limits. The web
  container waits for the migration container before starting.
- Multi-stage Dockerfiles producing non-root images with graceful shutdown.
- `npm run dev:setup`, a cross-platform, idempotent development bootstrap that
  creates `.env` from `.env.example` when it is missing.
- `npm run dev` starts the web app **and** the worker, and addresses the
  instance to this machine's LAN address so a copied link is one that can
  actually be sent to someone. It falls back to localhost when there is no
  network to bind to. `npm run dev:local` is the plain workspace dev server,
  and `npm run dev:lan` is an alias of `npm run dev`.
- `/api/health` and `/api/ready` endpoints, and `/health` and `/ready` on the
  worker.
- OpenTelemetry-compatible tracing hooks and metric instrumentation.
- `toran-admin` command-line tool for lookup, revocation, blocking, deletion,
  rescanning, job retries and manual cleanup, with confirmation prompts and a
  non-interactive `--yes` flag.
- Abuse reporting endpoint and form.

**Project**

- MIT licence, from this first release. The CI dependency policy rejects GPL
  and AGPL dependencies so the distributed application stays compatible with
  that licensing model; LGPL is permitted, and Toran already depends on LGPL
  native binaries through `sharp`. See [docs/LICENSING.md](docs/LICENSING.md).
- Architecture, deployment, API, threat-model, storage, backup, upgrade,
  privacy, observability, abuse and licensing documentation.
- GitHub Actions for formatting, linting, type checking, unit, integration and
  end-to-end tests, builds, Docker images for both web and worker, migration
  validation, CodeQL, dependency review, container scanning, SBOM generation
  and secret scanning. Third-party actions and `npx` tools are pinned to commit
  SHAs and exact versions.
- `npm run audit:prod`, which fails on any high or critical advisory in a
  shipping dependency unless it has been individually reviewed and justified in
  `scripts/audit-production.mjs`.
- Dependabot configuration, issue templates and a pull-request template.

### Known limitations

- Presigned download URLs remain usable until they expire (default 120
  seconds), so single-use downloads are not perfectly enforced.
- The share token appears in the `/s/[token]` page's own HTML, not only in its
  URL: the route is dynamic, so Next.js serialises the request's URL into the
  RSC payload. The response is `no-store` and goes only to the client that
  supplied the token, but anything inspecting response bodies sees it too.
  Fragment-based tokens are the fix.
- `GET /api/shares/{token}` is deliberately not rate limited, because the
  download page polls it while a file is scanning. Limit it at your reverse
  proxy if you expect hostile traffic.
- Single-request uploads only; no multipart and no resume.
- No end-to-end encryption: the operator can read uploaded files.
- Anonymous quotas key on a rotating client hash and can be bypassed by
  changing network.
- ClamAV detects known signatures only. Toran does not make a file safe.
- No external security audit has been performed.

[Unreleased]: https://github.com/toran-project/toran/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/toran-project/toran/releases/tag/v0.1.0
