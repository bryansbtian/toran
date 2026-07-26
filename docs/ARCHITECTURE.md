<!-- SPDX-License-Identifier: AGPL-3.0-only -->

# Toran architecture

Toran is a **modular monolith**: one Next.js application, one worker process,
and a set of shared packages with real boundaries between them. There are no
microservices, because nothing in this problem needs them.

The single decision everything else follows from:

```text
Control operations go through the Toran API.

File contents move directly between the browser and
S3-compatible object storage using short-lived presigned URLs.
```

The application server decides _who may do what_. It never touches a file byte.

---

## Why this shape

Proxying uploads through the app is the obvious design and the wrong one:

- **Cost and scale.** A 500 MB upload would occupy an app process for its whole
  duration. Direct-to-storage means the app handles a few kilobytes of JSON.
- **Serverless compatibility.** Most managed Node platforms cap request bodies
  and durations well below a useful file size.
- **Blast radius.** An application process that never holds file contents cannot
  leak them if it is compromised.

The cost is that Toran gives up perfect control over the transfer: a presigned
URL, once issued, works until it expires. That trade-off is documented
explicitly in [the threat model](THREAT_MODEL.md) and in the README.

---

## Components

| Component                | Responsibility                                               | Talks to                           |
| ------------------------ | ------------------------------------------------------------ | ---------------------------------- |
| `apps/web`               | UI, API routes, validation, authorisation, presigning        | PostgreSQL, object storage         |
| `apps/worker`            | Scanning, cleanup, reconciliation, admin CLI                 | PostgreSQL, object storage, ClamAV |
| `packages/config`        | Typed environment parsing and production guards              | —                                  |
| `packages/database`      | Schema, migrations, repositories, job queue, PG rate limiter | PostgreSQL                         |
| `packages/storage`       | `StorageProvider` interface, S3 and in-memory impls          | object storage                     |
| `packages/security`      | Tokens, Argon2id, grants, rate limiting, client identity     | —                                  |
| `packages/shared`        | Domain types, Zod contracts, filename safety, branding       | — (browser-safe)                   |
| `packages/observability` | Redacting JSON logger, OpenTelemetry hooks                   | —                                  |
| `packages/ui`            | Accessible React primitives, logo                            | —                                  |

`@toran/shared` is deliberately free of Node built-ins so it can be imported by
client components. Anything Node-only lives elsewhere.

---

## Upload sequence

```text
Browser                     Toran API                PostgreSQL      Storage
   │                            │                        │             │
   │ POST /api/uploads          │                        │             │
   ├───────────────────────────▶│                        │             │
   │                            │ validate name, size,   │             │
   │                            │ type, expiry, limits,  │             │
   │                            │ rate limits, quotas    │             │
   │                            ├───────────────────────▶│             │
   │                            │  files + upload_session│             │
   │                            │                        │             │
   │                            │ presign PUT (15 min)   │             │
   │                            ├──────────────────────────────────────▶│
   │ 201 { uploadId, url }      │                        │             │
   │◀───────────────────────────┤                        │             │
   │                                                                   │
   │ PUT <presigned url>   ── file bytes, never via Toran ────────────▶│
   │                                                                   │
   │ POST /api/uploads/{id}/complete                                   │
   ├───────────────────────────▶│                        │             │
   │                            │ HEAD object            │             │
   │                            ├──────────────────────────────────────▶│
   │                            │ verify actual size == declared size  │
   │                            ├───────────────────────▶│             │
   │                            │  status -> scanning    │             │
   │                            │  enqueue scan_file      │             │
   │                            │  create share_link      │             │
   │ 201 { file, share }        │                        │             │
   │◀───────────────────────────┤                        │             │
```

### Why the API signs `Content-Length`

The presigned `PUT` pins both `Content-Type` and `Content-Length`. A client that
sends a different size gets a signature mismatch from storage itself. Toran then
verifies the stored size independently with a `HEAD`, because not every
S3-compatible implementation enforces the signed length.

### Idempotency

`POST /api/uploads/{id}/complete` is safe to repeat. The state change is a
conditional `UPDATE` matching only a session still in `pending`, executed inside
a transaction that holds `SELECT ... FOR UPDATE` on the session row. A second
concurrent request finds no matching row and returns the existing share link
rather than creating a second one. The scan job carries a dedupe key
(`scan_file:{fileId}`) enforced by a partial unique index, so no duplicate scan
can be queued even if the application logic were wrong.

### Where share options live

Password, maximum downloads and expiry are supplied when the upload _starts_,
but the share link is created when the upload _completes_. They are stored on
the `upload_sessions` row in between — already Argon2id-hashed, so no plaintext
password is ever written. This keeps the UX to a single round trip without
inventing a second place for link configuration to live.

---

## Download sequence

```text
Visitor                    Toran API                PostgreSQL      Storage
   │ GET /s/{token}             │                        │             │
   ├───────────────────────────▶│  (renders a shell only) │             │
   │                            │                        │             │
   │ GET /api/shares/{token}    │                        │             │
   ├───────────────────────────▶│ sha256(token) lookup   │             │
   │                            ├───────────────────────▶│             │
   │ 200 uniform metadata       │                        │             │
   │◀───────────────────────────┤                        │             │
   │                                                                   │
   │ (if protected) POST /api/shares/{token}/authorize                 │
   ├───────────────────────────▶│ argon2 verify          │             │
   │ Set-Cookie: grant          │ rate limited x2        │             │
   │◀───────────────────────────┤                        │             │
   │                                                                   │
   │ POST /api/shares/{token}/download                                 │
   ├───────────────────────────▶│ ATOMIC reserve slot    │             │
   │                            ├───────────────────────▶│             │
   │                            │ presign GET (120 s)    │             │
   │                            ├──────────────────────────────────────▶│
   │ 200 { url }                │                        │             │
   │◀───────────────────────────┤                        │             │
   │ GET <presigned url> ── file bytes, never via Toran ──────────────▶│
```

The share page is a client-rendered shell. The token never appears in
server-rendered HTML, in the RSC payload, or in a server log line that records
rendered routes.

The download URL is returned in a JSON body rather than as a `302`. That lets
the client surface a failure before navigating away, and keeps the signed URL
out of browser history and out of any `Referer` header.

---

## Concurrency

Every race the system can actually hit, and what closes it:

| Race                                 | Mechanism                                                                         |
| ------------------------------------ | --------------------------------------------------------------------------------- |
| Two clients complete the same upload | `SELECT ... FOR UPDATE` on the session + conditional `UPDATE` on `files`          |
| Two workers claim the same job       | `FOR UPDATE SKIP LOCKED` in the claim CTE                                         |
| Two clients take the last download   | Single-statement conditional `UPDATE` + `share_links_within_download_limit` CHECK |
| Revocation during authorisation      | The reservation statement re-asserts `revoked_at IS NULL`                         |
| Cleanup during authorisation         | The reservation statement re-asserts file readiness via `EXISTS`                  |
| Duplicate cleanup scheduling         | `dedupe_key` partial unique index, keyed by time bucket                           |
| Worker crashes holding a job         | `locked_at` expiry, reclaimed by `reclaimExpiredLocks`                            |
| Repeated API requests                | Idempotent completion; idempotent revocation; idempotent deletion                 |
| Storage deletion retried             | Deleting an absent object succeeds                                                |

### The download reservation

This is the single most important statement in Toran:

```sql
UPDATE share_links
SET download_count = download_count + 1
WHERE id = $1
  AND revoked_at IS NULL
  AND (expires_at IS NULL OR expires_at > $2)
  AND (max_downloads IS NULL OR download_count < max_downloads)
  AND EXISTS (
    SELECT 1 FROM files
    WHERE files.id = share_links.file_id
      AND files.status = 'ready'
      AND files.deleted_at IS NULL
      AND (files.expires_at IS NULL OR files.expires_at > $2)
  )
RETURNING *;
```

The check and the increment are one statement, so PostgreSQL's row locking
serialises concurrent attempts. At most one transaction observes
`download_count < max_downloads` as true. `packages/database/src/repos/lifecycle.integration.test.ts`
fires twenty simultaneous reservations at a limit of three and asserts exactly
three succeed.

If signing the URL then fails, the reservation is released, so a storage blip
does not silently consume a user's download.

---

## Job queue

A database-backed queue, not Redis or SQS. PostgreSQL is already a hard
dependency; adding a second stateful service to run a handful of jobs per
minute would make self-hosting harder for no benefit.

```sql
WITH due AS (
  SELECT id FROM jobs
  WHERE status = 'queued' AND available_at <= $1
  ORDER BY available_at ASC
  LIMIT $2
  FOR UPDATE SKIP LOCKED
)
UPDATE jobs SET status = 'running', attempts = attempts + 1, ...
FROM due WHERE jobs.id = due.id
RETURNING jobs.*;
```

`SKIP LOCKED` lets N workers poll the same table and partition the work with no
coordination and no overlap.

Failures retry with exponential backoff and full jitter, capped, until
`max_attempts`. A `PermanentJobError` skips retries entirely — there is no point
retrying a scan of an object that does not exist.

Job types: `scan_file`, `delete_object`, `expire_files`, `expire_links`,
`cleanup_stale_uploads`, `retry_failed_scans`, `prune_download_events`,
`reconcile_storage`.

Maintenance jobs are scheduled by enqueueing with a dedupe key derived from a
time bucket (`expire_files:{floor(now/interval)}`), so any number of worker
replicas produce exactly one job per interval.

---

## File lifecycle

```text
  pending ──▶ uploading ──▶ scanning ──▶ ready
                  │             │          │
                  │             ├──▶ blocked
                  │             └──▶ failed
                  └───────────────▶ failed

  ready ──▶ expired ──▶ deleted
  any   ──▶ deleted
```

Only `ready` permits a download. The transition into `ready` happens in exactly
one place — `applyScanResult`, guarded by `WHERE status = 'scanning'` — so a
late-arriving verdict cannot resurrect a file that was blocked or cleaned up in
the meantime.

When scanning is disabled (development only), completion writes `ready`
directly. `@toran/config` refuses that combination in production.

---

## Trust boundaries

```text
┌──────────────────────────────────────────────────────────┐
│ UNTRUSTED: the browser                                   │
│  - every input validated server-side with Zod            │
│  - client-side validation is UX only                     │
└──────────────────────────────────────────────────────────┘
                          │
┌──────────────────────────────────────────────────────────┐
│ TRUSTED: Toran web                                       │
│  - holds storage credentials; never sends them out       │
│  - issues narrowly scoped, short-lived presigned URLs    │
└──────────────────────────────────────────────────────────┘
                          │
┌──────────────────────────────────────────────────────────┐
│ UNTRUSTED CONTENT: object storage                        │
│  - private bucket, random keys                           │
│  - served on a separate origin, always as an attachment  │
└──────────────────────────────────────────────────────────┘
                          │
┌──────────────────────────────────────────────────────────┐
│ HOSTILE INPUT: the worker + ClamAV                       │
│  - the only component that reads file bytes              │
│  - isolated container, no inbound network                │
└──────────────────────────────────────────────────────────┘
```

---

## Extension points

Deliberately shaped so these are additive, not rewrites:

- **Multipart / resumable uploads** — add methods to `StorageProvider`. No
  existing caller changes.
- **Proxy-download mode** — `getObjectStream` already exists; a route that
  streams through the app would give true single-use downloads at the cost of
  bandwidth.
- **User accounts** — `users` exists and `files.owner_id` is already nullable.
- **Redis rate limiting** — implement the `RateLimiter` interface.
- **Alternative scanners** — implement the `Scanner` interface.
