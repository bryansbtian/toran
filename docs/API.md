<!-- SPDX-License-Identifier: MIT -->

# Toran API

Base URL: `${TORAN_APP_URL}/api`

All requests and responses are JSON (`application/json; charset=utf-8`). Every
input is validated server-side with Zod; client-side validation is UX only.

Responses carry `Cache-Control: no-store`, `X-Content-Type-Options: nosniff`,
and an `X-Request-Id` correlating the response with server logs.

## Errors

Every failure uses one envelope:

```json
{
  "error": {
    "code": "STABLE_MACHINE_CODE",
    "message": "Safe user-facing message",
    "requestId": "L3xK9mQ2pRt7"
  }
}
```

`code` is stable; branch on it. `message` is for humans and may change. Errors
never contain stack traces, database errors, object keys, hostnames, or
credentials.

| Code                          | HTTP | Meaning                                                    |
| ----------------------------- | ---- | ---------------------------------------------------------- |
| `VALIDATION_FAILED`           | 400  | The body did not match the schema                          |
| `UNSUPPORTED_FILENAME`        | 400  | The filename cannot be accepted safely                     |
| `EXPIRY_OUT_OF_RANGE`         | 400  | Requested expiry outside server policy                     |
| `DOWNLOAD_LIMIT_OUT_OF_RANGE` | 400  | Requested cap above server maximum                         |
| `PASSWORD_REQUIRED`           | 401  | The link needs a password                                  |
| `INVALID_CREDENTIALS`         | 401  | Wrong password (also returned for links that do not exist) |
| `FORBIDDEN_ORIGIN`            | 403  | Cross-origin mutation refused                              |
| `NOT_FOUND`                   | 404  | No such resource, or you cannot prove you own it           |
| `METHOD_NOT_ALLOWED`          | 405  |                                                            |
| `CONFLICT`                    | 409  | Conflicts with current state                               |
| `FILE_NOT_READY`              | 409  | The file is not downloadable yet                           |
| `FILE_SCANNING`               | 409  | Still being scanned                                        |
| `FILE_FAILED`                 | 409  | Processing failed                                          |
| `UPLOAD_INCOMPLETE`           | 409  | The object is not in storage yet                           |
| `UPLOAD_SIZE_MISMATCH`        | 409  | Stored size differs from the declared size                 |
| `GONE`                        | 410  | No longer available                                        |
| `LINK_EXPIRED`                | 410  |                                                            |
| `LINK_REVOKED`                | 410  |                                                            |
| `LINK_EXHAUSTED`              | 410  | Download limit reached                                     |
| `PAYLOAD_TOO_LARGE`           | 413  | Request body above `TORAN_MAX_REQUEST_BODY_BYTES`          |
| `FILE_TOO_LARGE`              | 413  | File above `TORAN_MAX_FILE_SIZE_BYTES`                     |
| `FILE_BLOCKED`                | 451  | Blocked by malware scanning or an administrator            |
| `RATE_LIMITED`                | 429  | Includes `Retry-After`                                     |
| `QUOTA_EXCEEDED`              | 429  | Per-client quota reached                                   |
| `STORAGE_UNAVAILABLE`         | 503  | Object storage is unreachable                              |
| `INTERNAL_ERROR`              | 500  |                                                            |

## Authentication

The MVP is anonymous. Two capability mechanisms replace accounts:

**Manage grants.** Returned when you create an upload or a share link, as
`manageKey` / `shareManageKey`. Send as `X-Toran-Manage-Key` to cancel an
upload, list a file's links, or revoke a link. Signed and bound to one subject
id, so a grant for one resource cannot act on another.

**Download grants.** Set as an `HttpOnly`, `SameSite=Strict` cookie after a
correct password, and short-lived (15 minutes). The cookie is `Path=/`, because
the page that needs it and the endpoint that consumes it are under different
prefixes; isolation between links comes from the cookie **name**, which embeds
the share-link id, and from the grant being HMAC-bound to that same id. A grant
for one link is rejected on every other.

A link has at most one password, covering all of its files. Authorising once
unlocks the whole link.

Mutating endpoints validate the `Origin` header.

---

## Uploads

### `POST /api/uploads`

Creates an upload session for **one** file and returns a presigned `PUT` URL.
Call it once per file. Rate limited by `TORAN_RATE_LIMIT_UPLOAD_CREATE`.

```json
{
  "filename": "quarterly-report.pdf",
  "size": 2481523,
  "contentType": "application/pdf",
  "expiresInSeconds": 86400
}
```

`filename`, `size` required; unknown fields are rejected. `expiresInSeconds` is
**this file's** lifetime, not the link's: it defaults to
`TORAN_DEFAULT_EXPIRY_SECONDS` and is clamped by `TORAN_MAX_EXPIRY_SECONDS`.

`password` and `maxDownloads` belong to the link and are **rejected** here with
`VALIDATION_FAILED`. Send them to [`POST /api/shares`](#post-apishares) instead.
The schema refuses them outright rather than appearing to honour a setting this
endpoint would ignore.

**`201 Created`**

```json
{
  "uploadId": "8f14e45f-ceea-467a-9b8a-1e2d3c4b5a6f",
  "fileId": "3b2e1d0c-9a8b-4c7d-8e5f-0a1b2c3d4e5f",
  "upload": {
    "url": "https://files.example.com/toran/objects/...?X-Amz-Signature=...",
    "method": "PUT",
    "headers": { "Content-Type": "application/pdf", "Content-Length": "2481523" },
    "expiresAt": "2026-07-26T13:15:00.000Z"
  },
  "normalizedFilename": "quarterly-report.pdf",
  "maxFileSizeBytes": 104857600,
  "manageKey": "manage.3b2e1d0c-....signature"
}
```

The browser must `PUT` to `upload.url` with those headers. `Content-Length` is
set automatically by the browser; the others must be sent verbatim or the
signature will not match.

### `PUT <upload.url>` - direct to storage

Not a Toran endpoint. The file body goes straight to object storage.

| Storage status | Meaning                                              |
| -------------- | ---------------------------------------------------- |
| `200` / `204`  | Stored                                               |
| `400`          | Body did not match what was authorised               |
| `403`          | Signature invalid or expired - request a new session |
| `5xx`          | Storage problem; retry                               |

### `POST /api/uploads/{id}/complete`

Verifies the stored object. **Idempotent** - repeat it freely; you get the same
file back and no duplicate scan job.

This does **not** create a link. A link may serve several files, so it cannot
exist until every file of the batch has been stored; see
[`POST /api/shares`](#post-apishares).

```json
{ "checksum": "optional lowercase sha-256 hex" }
```

**`201 Created`** (first call) or **`200 OK`** (replay)

```json
{
  "file": {
    "fileId": "3b2e1d0c-...",
    "filename": "quarterly-report.pdf",
    "size": 2481523,
    "status": "scanning",
    "contentType": "application/pdf",
    "createdAt": "2026-07-26T12:00:00.000Z",
    "expiresAt": "2026-07-27T12:00:00.000Z"
  },
  "manageKey": "..."
}
```

> Keep `manageKey`. It proves you uploaded this file, and `POST /api/shares`
> will not put a file behind a link without it.

Errors: `UPLOAD_INCOMPLETE` (object not in storage yet), `UPLOAD_SIZE_MISMATCH`,
`GONE` (session expired), `CONFLICT` (cancelled).

### `DELETE /api/uploads/{id}`

Cancels an in-flight upload. Requires `X-Toran-Manage-Key`.

```json
{ "cancelled": true }
```

---

## Share links

### `POST /api/shares`

Creates one link over one or more uploaded files, in the order given. Every file
must be named with the `manageKey` returned when it was completed; a file id
without a matching grant is reported as `NOT_FOUND`, so link creation cannot be
used to probe for, or re-share, someone else's upload.

At most **20 files** per link.

```json
{
  "fileIds": ["3b2e1d0c-...", "9f8e7d6c-..."],
  "manageKeys": ["...", "..."],
  "expiresInSeconds": 3600,
  "password": "optional",
  "maxDownloads": 1
}
```

**`201 Created`**

```json
{
  "share": {
    "shareId": "7c6d5e4f-...",
    "url": "https://toran.example.com/s/Xy9_Kq2mNp4RvT8wZa1BcD3e",
    "token": "Xy9_Kq2mNp4RvT8wZa1BcD3e",
    "expiresAt": "2026-07-27T12:00:00.000Z",
    "maxDownloads": 5,
    "passwordProtected": true,
    "revokedAt": null,
    "createdAt": "2026-07-26T12:00:05.000Z",
    "files": [
      {
        "fileId": "3b2e1d0c-...",
        "filename": "quarterly-report.pdf",
        "size": 2481523,
        "status": "scanning",
        "contentType": "application/pdf",
        "createdAt": "2026-07-26T12:00:00.000Z",
        "expiresAt": "2026-07-27T12:00:00.000Z",
        "remainingDownloads": 5
      }
    ]
  },
  "shareManageKey": "..."
}
```

> `share.token` appears **only here, only once**. Toran stores only its SHA-256
> and cannot recover it. Losing it means losing the link.

`maxDownloads` is a budget **per file**, not for the link as a whole: a limit of
3 over four files permits three downloads of each. One recipient exhausting one
file leaves the others untouched.

The link's expiry is clamped to the earliest expiry among its files - a link
must never outlive content the cleanup job has already removed.

Errors: `NOT_FOUND` (unknown file, or no grant for it), `CONFLICT` (an upload has
not finished), `VALIDATION_FAILED` (over 20 files, or the same file twice),
`EXPIRY_OUT_OF_RANGE`, `DOWNLOAD_LIMIT_OUT_OF_RANGE`.

### `GET /api/files/{id}/shares`

Lists the links that serve a file. Requires `X-Toran-Manage-Key`. A link listed
here may name files beyond the one asked about. Raw tokens are **never**
included - they cannot be recovered.

### `DELETE /api/shares/{id}`

Revokes a link. Idempotent. The path segment accepts either:

- the **share-link id** (a UUID), with `X-Toran-Manage-Key`; or
- the **raw share token**, since holding it already implies the ability to
  distribute the link.

```json
{ "revoked": true, "revokedAt": "2026-07-26T12:30:00.000Z" }
```

---

## Public share access

### `GET /api/shares/{token}`

Public metadata. Always `200`, even for a token that does not exist.

```json
{
  "status": "ready",
  "passwordProtected": true,
  "authorized": false,
  "expiresAt": "2026-07-27T12:00:00.000Z",
  "files": [
    {
      "fileId": "3b2e1d0c-...",
      "filename": "quarterly-report.pdf",
      "size": 2481523,
      "status": "ready",
      "remainingDownloads": 5
    },
    {
      "fileId": "9f8e7d6c-...",
      "filename": "appendix.csv",
      "size": 8122,
      "status": "scanning",
      "remainingDownloads": 5
    }
  ]
}
```

Each file carries its own `status` and its own `remainingDownloads`, so a file
still being scanned does not hide the ones that are ready.

The link's `status` is `ready` while **any** file can still be served,
`scanning` while none can yet but some still might, and `unavailable`
otherwise. **Missing, revoked, expired, exhausted, blocked and deleted links all
return the identical `unavailable` shape** with an empty `files` array, so this
endpoint cannot be used to distinguish them.

### `POST /api/shares/{token}/authorize`

Exchanges a password for a grant cookie. Rate limited per link **and** per
client (`TORAN_RATE_LIMIT_PASSWORD`).

```json
{ "password": "the link password" }
```

**`200 OK`** - `{ "authorized": true }` plus a `Set-Cookie` with the grant.

**`401 INVALID_CREDENTIALS`** for a wrong password, a link with no password, or
a link that does not exist - the three are indistinguishable, including in
response time (a decoy Argon2id verification runs for the non-matching cases).

### `POST /api/shares/{token}/download`

Atomically reserves a download slot for **one file** of the link and returns a
presigned URL for it.

```json
{ "fileId": "3b2e1d0c-..." }
```

`fileId` may be omitted only when the link serves exactly one file; omitting it
on a multi-file link is `VALIDATION_FAILED`. A file id that is not behind this
link is `NOT_FOUND` - whether it exists elsewhere is not something a visitor
holding only the token may probe for.

**`200 OK`**

```json
{
  "url": "https://files.example.com/toran/objects/...?X-Amz-Signature=...",
  "expiresAt": "2026-07-26T12:32:00.000Z",
  "fileId": "3b2e1d0c-...",
  "filename": "quarterly-report.pdf",
  "remainingDownloads": 4
}
```

`remainingDownloads` counts down that file's own budget. Errors are reported for
the file asked for, not the link: a link can be perfectly usable while this
particular file is `FILE_SCANNING` or `LINK_EXHAUSTED`.

Navigate to `url`. Storage serves it as an attachment with the original filename.

> The URL stays valid until `expiresAt` (default 120 s) even after the limit is
> reached. See the [threat model](THREAT_MODEL.md#7-presigned-url-leakage).

Errors: `PASSWORD_REQUIRED`, `LINK_EXPIRED`, `LINK_REVOKED`, `LINK_EXHAUSTED`,
`FILE_SCANNING`, `FILE_BLOCKED`, `NOT_FOUND`.

---

## Abuse reports

### `POST /api/reports`

Rate limited by `TORAN_RATE_LIMIT_REPORT`.

```json
{
  "link": "https://toran.example.com/s/Xy9_... (or the bare token)",
  "reason": "malware",
  "details": "optional, up to 4000 chars",
  "contactEmail": "optional"
}
```

`reason` is one of `malware`, `phishing`, `copyright`, `harassment`, `illegal`,
`other`.

**`202 Accepted`** - `{ "received": true }`

Always `202`, whether or not the link resolves, so this is not an existence
oracle. Reporter identity is stored as a rotating hash and never shown to the
uploader.

---

## Operations

### `GET /api/health`

Process liveness. Touches no dependency, so a database blip does not trigger a
restart loop.

```json
{ "status": "ok", "service": "toran-web", "version": "0.1.0", "uptimeSeconds": 3600 }
```

### `GET /api/ready`

Dependency readiness. `200` when ready, `503` when degraded.

```json
{
  "status": "ready",
  "checks": {
    "configuration": { "ok": true },
    "database": { "ok": true },
    "storage": { "ok": true },
    "rateLimiter": { "ok": true, "detail": "postgres" },
    "scanning": { "ok": true, "detail": "enabled" }
  }
}
```

Failure details are deliberately coarse (`"unreachable"`); the specific reason
goes to the server log.

---

## Complete upload example

`files` is an array of one or more `File` objects. Uploading each one is a
three-step loop; the link is minted once, at the end, over all of them.

```javascript
const fileIds = [];
const manageKeys = [];

for (const file of files) {
  // 1. Ask for permission to upload this file.
  const session = await fetch('/api/uploads', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      filename: file.name,
      size: file.size,
      contentType: file.type || 'application/octet-stream',
      // The file's own lifetime. Link settings go to POST /api/shares.
      expiresInSeconds: 86400,
    }),
  }).then((response) => response.json());

  // 2. Upload the bytes DIRECTLY to storage. Never through Toran.
  await new Promise((resolve, reject) => {
    const request = new XMLHttpRequest();
    request.open('PUT', session.upload.url);
    request.setRequestHeader('Content-Type', session.upload.headers['Content-Type']);
    request.upload.onprogress = (event) => {
      console.log(`${file.name}: ${Math.round((event.loaded / event.total) * 100)}%`);
    };
    request.onload = () =>
      request.status < 300 ? resolve() : reject(new Error(`HTTP ${request.status}`));
    request.onerror = () => reject(new Error('network error'));
    request.send(file);
  });

  // 3. Confirm. Safe to retry. This creates no link.
  const completed = await fetch(`/api/uploads/${session.uploadId}/complete`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{}',
  }).then((response) => response.json());

  fileIds.push(completed.file.fileId);
  manageKeys.push(completed.manageKey);
}

// 4. Every file is stored and verified, so the link can be minted over them.
const { share } = await fetch('/api/shares', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({
    fileIds,
    manageKeys,
    expiresInSeconds: 86400,
    maxDownloads: 5, // per file, not for the link as a whole
  }),
}).then((response) => response.json());

console.log(share.url); // the only time you will see the token
```

## Download example

```javascript
const meta = await fetch(`/api/shares/${token}`).then((r) => r.json());
if (meta.status === 'unavailable') throw new Error('link not available');

if (meta.passwordProtected && !meta.authorized) {
  // One password for the whole link; authorising unlocks every file.
  await fetch(`/api/shares/${token}/authorize`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ password }),
    credentials: 'same-origin',
  });
}

// Each file has its own status and its own remaining downloads. Pick one that
// is ready; `fileId` may be omitted only when the link serves exactly one file.
const wanted = meta.files.find((file) => file.status === 'ready');
if (!wanted) throw new Error('nothing on this link is downloadable yet');

const { url } = await fetch(`/api/shares/${token}/download`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ fileId: wanted.fileId }),
  credentials: 'same-origin',
}).then((r) => r.json());

window.location.href = url;
```
