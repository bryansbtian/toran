<!-- SPDX-License-Identifier: AGPL-3.0-only -->

# Changelog

All notable changes to Toran are documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and
Toran uses [Semantic Versioning](https://semver.org/spec/v2.0.0.html). While the
major version is `0`, minor releases may contain breaking changes.

## [Unreleased]

Nothing yet.

## [0.1.0] - 2026-07-25

First MVP release.

### Added

**Sharing**

- Anonymous uploads with drag-and-drop and a file picker.
- Live upload progress with cancel support.
- Generated share links with one-click copy and confirmation.
- Configurable link expiry, from one hour to the server maximum.
- Optional password protection using Argon2id.
- Optional maximum download count, enforced atomically.
- Link revocation.
- A public download page reporting file name, size, expiry, remaining
  downloads, and distinct states for expired, revoked, exhausted, scanning,
  blocked, deleted and unavailable links.

**Architecture**

- Direct browser-to-storage uploads via short-lived presigned `PUT` URLs;
  file contents never pass through the application server.
- Storage `HEAD` verification of the actual object size after upload.
- Idempotent upload completion: repeated requests never duplicate a share link
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
- Atomic download reservation, backed by a database CHECK constraint.
- Filename normalisation: path stripping, control-character and bidi-override
  rejection, reserved-name refusal, length capping.
- Active content types forced to `application/octet-stream` and always served
  as attachments.
- Randomly generated storage keys, validated on every storage call.
- Runtime Content-Security-Policy, `nosniff`, `no-referrer`, Permissions-Policy,
  clickjacking protection and HSTS.
- Origin validation on every mutating endpoint.
- Short-lived, link-scoped, HttpOnly `SameSite=Strict` download grants.
- Rate limiting with in-memory (development) and PostgreSQL (production)
  backends, plus per-client quotas on active files, storage and concurrency.
- Privacy-preserving rotating client identifiers; raw IP addresses are never
  stored.
- Structured JSON logging that redacts tokens, passwords, credentials and
  presigned URLs by key name and by value pattern.
- Start-up guards that refuse to run in production with example credentials,
  HTTP origins, insecure cookies, disabled scanning, or the in-memory limiter.

**Operations**

- Production Docker Compose stack: web, worker, migrations, PostgreSQL, MinIO,
  bucket initialisation and ClamAV, with health checks, restart policies,
  persistent volumes, an internal network and example resource limits.
- Multi-stage Dockerfiles producing non-root images with graceful shutdown.
- `npm run dev:setup`, a cross-platform, idempotent development bootstrap.
- `/api/health` and `/api/ready` endpoints, and a worker health endpoint.
- OpenTelemetry-compatible tracing hooks and metric instrumentation.
- `toran-admin` command-line tool for lookup, revocation, blocking, deletion,
  rescanning, job retries and manual cleanup, with confirmation prompts and a
  non-interactive `--yes` flag.
- Abuse reporting endpoint and form.

**Project**

- AGPL-3.0-only licence.
- Architecture, deployment, API, threat-model, storage, backup, upgrade,
  privacy, observability, abuse and licensing documentation.
- GitHub Actions for formatting, linting, type checking, unit, integration and
  end-to-end tests, builds, Docker images, migration validation, CodeQL,
  dependency review, container scanning, SBOM generation and secret scanning.
- Dependabot configuration, issue templates and a pull-request template.

### Known limitations

- Presigned download URLs remain usable until they expire (default 120
  seconds), so single-use downloads are not perfectly enforced.
- Single-request uploads only; no multipart and no resume.
- No end-to-end encryption: the operator can read uploaded files.
- Anonymous quotas key on a rotating client hash and can be bypassed by
  changing network.
- No external security audit has been performed.

[Unreleased]: https://github.com/toran-project/toran/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/toran-project/toran/releases/tag/v0.1.0
