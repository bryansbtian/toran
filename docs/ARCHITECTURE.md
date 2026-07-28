<!-- SPDX-License-Identifier: MIT -->

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
| `packages/config`        | Typed environment parsing and production guards              | -                                  |
| `packages/database`      | Schema, migrations, repositories, job queue, PG rate limiter | PostgreSQL                         |
| `packages/storage`       | `StorageProvider` interface, S3 and in-memory impls          | object storage                     |
| `packages/security`      | Tokens, Argon2id, grants, rate limiting, client identity     | -                                  |
| `packages/shared`        | Domain types, Zod contracts, filename safety, branding       | - (browser-safe)                   |
| `packages/observability` | Redacting JSON logger, OpenTelemetry hooks                   | -                                  |
| `packages/ui`            | Accessible React primitives, logo                            | -                                  |

`@toran/shared` is deliberately free of Node built-ins so it can be imported by
client components. Anything Node-only lives elsewhere.

---

## Upload sequence

A link may serve up to `MAX_FILES_PER_SHARE` (20) files, so it cannot exist
until every one of them has been stored and verified. Uploading and link
creation are therefore separate phases: the per-file loop below, then one call
that mints the link over the whole batch.

```text
Browser                     Toran API                PostgreSQL      Storage
   │                            │                        │             │
   │ ╔═ for each selected file ═══════════════════════════════════════╗ │
   │ POST /api/uploads          │                        │             │
   ├───────────────────────────▶│                        │             │
   │                            │ validate name, size,   │             │
   │                            │ type, expiry,          │             │
   │                            │ rate limits, quotas    │             │
   │                            ├───────────────────────▶│             │
   │                            │  files + upload_session│             │
   │                            │                        │             │
   │                            │ presign PUT (15 min)   │             │
   │                            ├──────────────────────────────────────▶│
   │ 201 { uploadId, fileId,    │                        │             │
   │       url, manageKey }     │                        │             │
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
   │                            │  enqueue scan_file     │             │
   │ 201 { file, manageKey }    │   (no link created)    │             │
   │◀───────────────────────────┤                        │             │
   │ ╚════════════════════════════════════════════════════════════════╝ │
   │                                                                   │
   │ POST /api/shares  { fileIds[], manageKeys[], expiry, password,    │
   ├───────────────────────────▶│         maxDownloads }               │
   │                            │ verify a grant per id  │             │
   │                            │ hash token + password  │             │
   │                            ├───────────────────────▶│             │
   │                            │  share_links + one     │             │
   │                            │  share_link_files row  │             │
   │                            │  per file, one txn     │             │
   │ 201 { share (token once) } │                        │             │
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
concurrent request finds no matching row and replays the same file rather than
transitioning twice. The scan job carries a dedupe key (`scan_file:{fileId}`)
enforced by a partial unique index, so no duplicate scan can be queued even if
the application logic were wrong.

`POST /api/shares` is deliberately **not** idempotent: each call mints a new
link with a new token. Calling it twice over the same files gives two links,
which is a legitimate thing to want.

### Where share options live

Password, maximum downloads and link expiry belong to the link, so they are
supplied to `POST /api/shares` and nowhere else. The upload endpoints reject
them outright rather than appearing to honour a setting they would ignore.

The one thing an upload does carry is the **file's own** expiry, because the
stored object is given a lifetime the moment it is created. A link's expiry is
then clamped to the earliest expiry among its files: a link must never outlive
content the cleanup job has already removed.

`upload_sessions` still has `share_password_hash`, `share_max_downloads` and
`share_expires_at` columns from when completion minted the link. The upload
path writes `NULL` into them and no application code reads them back;
migrations are additive, so removing a column is a separate, deliberate change.

### Proving ownership of a file

`POST /api/shares` will not put a file behind a link without a **manage grant**
for it - an HMAC issued when the upload was created and reissued on completion,
bound to that one file id. Without the check, any client could mint a fresh
link, with its own password and expiry, over a file id it merely guessed, and
so re-share someone else's upload. A file id with no matching grant is reported
as `NOT_FOUND`, the same as one that does not exist.

Grants travel in the request body rather than a header, because there is one
per file and twenty of them would not reliably fit in a header. They are
credentials: the request logger records field names, never values.

---

## Download sequence

```text
Visitor                    Toran API                PostgreSQL      Storage
   │ GET /s/{token}             │                        │             │
   ├───────────────────────────▶│  (renders a shell only)│             │
   │                            │                        │             │
   │ GET /api/shares/{token}    │                        │             │
   ├───────────────────────────▶│ sha256(token) lookup   │             │
   │                            ├───────────────────────▶│             │
   │                            │  link + every file it  │             │
   │                            │  serves, by position   │             │
   │ 200 { status, files[] }    │                        │             │
   │◀───────────────────────────┤  each file's own state │             │
   │                                                                   │
   │ (if protected) POST /api/shares/{token}/authorize                 │
   ├───────────────────────────▶│ argon2 verify          │             │
   │ Set-Cookie: grant          │ rate limited x2        │             │
   │◀───────────────────────────┤ (covers the whole link)│             │
   │                                                                   │
   │ POST /api/shares/{token}/download  { fileId }                     │
   ├───────────────────────────▶│ link gate: revoked?    │             │
   │                            │ expired? authorised?   │             │
   │                            │ file gate: ready? has  │             │
   │                            │ budget left?           │             │
   │                            │ ATOMIC reserve slot    │             │
   │                            ├───────────────────────▶│  that file  │
   │                            │ presign GET (120 s)    │  alone      │
   │                            ├──────────────────────────────────────▶│
   │ 200 { url, fileId, ... }   │                        │             │
   │◀───────────────────────────┤                        │             │
   │ GET <presigned url> ── file bytes, never via Toran ──────────────▶│
```

`fileId` may be omitted only when the link serves exactly one file; omitting it
on a multi-file link is `VALIDATION_FAILED`. A file id that is not behind this
link is `NOT_FOUND` - whether it exists elsewhere is not something a visitor
holding only the token may probe for.

### Two gates, not one

Link-level state - revoked, expired, password - applies to every file equally.
Per-file state - scanning, blocked, deleted, expired, download budget - applies
to one. `evaluateShare` answers "can this link serve _anything_", which is what
the metadata endpoint reports; `evaluateShareFile` answers "can this file be
served", which is what the download endpoint enforces and what each row of the
download page shows.

Keeping them apart is what stops one file's state leaking onto another: a link
with one clean file and one still scanning is `ready` and offers a download for
the clean one, and a recipient exhausting one file's budget leaves the others
untouched.

### What the share page renders

The share page is a client-rendered shell: no filename, size, expiry or
password state reaches the initial HTML, so nothing about the content is
disclosed to a visitor who turns out not to be entitled to it.

The token is a different matter. `/s/[token]` is a dynamic route, so Next.js
serialises the request's own URL into the RSC payload embedded in that page's
HTML regardless of what the component does with `params`. The response is
`Cache-Control: no-store` and goes only to the client that supplied the token,
but the token is **not** absent from the HTML. See
[the threat model](THREAT_MODEL.md#4-token-leakage).

The download URL is returned in a JSON body rather than as a `302`. That lets
the client surface a failure before navigating away, and keeps the signed URL
out of browser history and out of any `Referer` header.

---

## Concurrency

Every race the system can actually hit, and what closes it:

| Race                                    | Mechanism                                                                                 |
| --------------------------------------- | ----------------------------------------------------------------------------------------- |
| Two clients complete the same upload    | `SELECT ... FOR UPDATE` on the session + conditional `UPDATE` on `files`                  |
| Two workers claim the same job          | `FOR UPDATE SKIP LOCKED` in the claim CTE                                                 |
| Two clients take a file's last download | Single-statement conditional `UPDATE` + `share_link_files_within_download_limit` CHECK    |
| A link created over a half-stored batch | The link is minted only after every file has completed; `pending`/`uploading` are refused |
| A link with no files                    | Link row and its `share_link_files` rows are written in one transaction                   |
| The same file twice on one link         | `share_link_files_link_file_unique`, plus a duplicate check in `createShare`              |
| Revocation during authorisation         | The reservation statement re-asserts `revoked_at IS NULL`                                 |
| Cleanup during authorisation            | The reservation statement re-asserts file readiness via `EXISTS`                          |
| Duplicate cleanup scheduling            | `dedupe_key` partial unique index, keyed by time bucket                                   |
| Worker crashes holding a job            | `locked_at` expiry, reclaimed by `reclaimExpiredLocks`                                    |
| Repeated API requests                   | Idempotent completion; idempotent revocation; idempotent deletion                         |
| Storage deletion retried                | Deleting an absent object succeeds                                                        |

### The download reservation

This is the single most important statement in Toran. It claims one slot for
**one file of one link**:

```sql
UPDATE share_link_files
SET download_count = download_count + 1
WHERE share_link_id = $1
  AND file_id = $2
  AND (max_downloads IS NULL OR download_count < max_downloads)
  AND EXISTS (
    SELECT 1 FROM share_links
    WHERE share_links.id = share_link_files.share_link_id
      AND share_links.revoked_at IS NULL
      AND (share_links.expires_at IS NULL OR share_links.expires_at > $3)
  )
  AND EXISTS (
    SELECT 1 FROM files
    WHERE files.id = share_link_files.file_id
      AND files.status = 'ready'
      AND files.deleted_at IS NULL
      AND (files.expires_at IS NULL OR files.expires_at > $3)
  )
RETURNING *;
```

The check and the increment are one statement, so PostgreSQL's row locking
serialises concurrent attempts. At most one transaction observes
`download_count < max_downloads` as true. `packages/database/src/repos/lifecycle.integration.test.ts`
fires twenty simultaneous reservations at a limit of three and asserts exactly
three succeed.

The budget lives on `share_link_files`, not on `share_links`. Two reasons:

- A recipient exhausting one file must not make the link's other files
  unreachable.
- A CHECK constraint may only reference its own row, and
  `share_link_files_within_download_limit` is what makes the limit enforceable
  by the database rather than only by the `UPDATE` above. That is why
  `max_downloads` is **copied** onto each row when the link is created rather
  than joined to; both columns are written once and never updated, so the copy
  cannot drift.

The link's own state is re-asserted in the same statement. Budgets are per
file, but revocation and expiry are not, and a link revoked since the read must
not be raced past on any of its files.

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
`max_attempts`. A `PermanentJobError` skips retries entirely - there is no point
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
one place (`applyScanResult`, guarded by `WHERE status = 'scanning'`), so a
late-arriving verdict cannot resurrect a file that was blocked or cleaned up in
the meantime.

When scanning is disabled (development only), completion writes `ready`
directly. `@toran/config` refuses that combination in production.

Each file of a link moves through this independently. A `failed` file does not
touch its siblings - it simply stops being downloadable. An **infected** file is
the exception: `scanFile` blocks it and revokes every link that serves it,
clean siblings included. A batch that carried malware is not one Toran keeps
distributing, and a recipient's access to a clean sibling is worth less than
that.

## Link lifecycle

A link is a `share_links` row plus one `share_link_files` row per file, written
in a single transaction. Both writes must land: a link with no file rows would
resolve to nothing and could never be served.

- **Revocation** is a link-level flag. It applies to every file behind the link
  at once, and it is idempotent. `revokeAllSharesForFile` is the blunt variant
  used by the malware path and by `toran-admin block-file`.
- **Expiry** is checked at both levels. The link's own `expires_at` is clamped
  at creation to the earliest expiry among its files, and each file's expiry is
  re-checked when that file is served.
- **Deleting a file** cascades its `share_link_files` rows away. A link can
  therefore end up holding nothing: `evaluateShare` reports such a link
  `not_found`, so it is unservable that instant, and the
  `deleteOrphanedShareLinks` sweep removes the empty row along with its
  download events.

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

- **Multipart / resumable uploads** - add methods to `StorageProvider`. No
  existing caller changes.
- **Proxy-download mode** - `getObjectStream` already exists; a route that
  streams through the app would give true single-use downloads at the cost of
  bandwidth.
- **User accounts** - `users` exists and `files.owner_id` is already nullable.
- **Redis rate limiting** - implement the `RateLimiter` interface.
- **Alternative scanners** - implement the `Scanner` interface.
