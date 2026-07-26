<!-- SPDX-License-Identifier: AGPL-3.0-only -->

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

**Download grants.** Set as an `HttpOnly`, `SameSite=Strict`, path-scoped
cookie after a correct password. Bound to one share-link id and short-lived
(15 minutes).

Mutating endpoints validate the `Origin` header.

---

## Uploads

### `POST /api/uploads`

Creates an upload session and returns a presigned `PUT` URL. Rate limited by
`TORAN_RATE_LIMIT_UPLOAD_CREATE`.

```json
{
  "filename": "quarterly-report.pdf",
  "size": 2481523,
  "contentType": "application/pdf",
  "expiresInSeconds": 86400,
  "password": "optional, min 8 chars",
  "maxDownloads": 5
}
```

`filename`, `size` required; unknown fields are rejected. `expiresInSeconds`
defaults to `TORAN_DEFAULT_EXPIRY_SECONDS` and is clamped by
`TORAN_MAX_EXPIRY_SECONDS`.

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

### `PUT <upload.url>` — direct to storage

Not a Toran endpoint. The file body goes straight to object storage.

| Storage status | Meaning                                              |
| -------------- | ---------------------------------------------------- |
| `200` / `204`  | Stored                                               |
| `400`          | Body did not match what was authorised               |
| `403`          | Signature invalid or expired — request a new session |
| `5xx`          | Storage problem; retry                               |

### `POST /api/uploads/{id}/complete`

Verifies the stored object and creates the share link. **Idempotent** — repeat
it freely; you get the same link back and no duplicate scan job.

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
  "share": {
    "shareId": "7c6d5e4f-...",
    "url": "https://toran.example.com/s/Xy9_Kq2mNp4RvT8wZa1BcD3e",
    "token": "Xy9_Kq2mNp4RvT8wZa1BcD3e",
    "expiresAt": "2026-07-27T12:00:00.000Z",
    "maxDownloads": 5,
    "downloadCount": 0,
    "passwordProtected": true,
    "revokedAt": null,
    "createdAt": "2026-07-26T12:00:05.000Z"
  },
  "manageKey": "...",
  "shareManageKey": "..."
}
```

> `share.token` appears **only here, only once**. Toran stores only its SHA-256
> and cannot recover it. Losing it means losing the link.

Errors: `UPLOAD_INCOMPLETE` (object not in storage yet), `UPLOAD_SIZE_MISMATCH`,
`GONE` (session expired), `CONFLICT` (cancelled).

### `DELETE /api/uploads/{id}`

Cancels an in-flight upload. Requires `X-Toran-Manage-Key`.

```json
{ "cancelled": true }
```

---

## Share links

### `POST /api/files/{id}/shares`

Creates an additional link for an existing file. Requires `X-Toran-Manage-Key`
for that file id.

```json
{ "expiresInSeconds": 3600, "password": "optional", "maxDownloads": 1 }
```

**`201 Created`** — `{ "share": { ... "token": "..." }, "shareManageKey": "..." }`

### `GET /api/files/{id}/shares`

Lists a file's links. Requires `X-Toran-Manage-Key`. Raw tokens are **never**
included — they cannot be recovered.

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
  "filename": "quarterly-report.pdf",
  "size": 2481523,
  "status": "ready",
  "passwordProtected": true,
  "authorized": false,
  "expiresAt": "2026-07-27T12:00:00.000Z",
  "remainingDownloads": 5
}
```

`status` is `ready`, `scanning`, or `unavailable`. **Missing, revoked, expired,
exhausted, blocked and deleted links all return the identical `unavailable`
shape** with empty filename and zero size, so this endpoint cannot be used to
distinguish them.

### `POST /api/shares/{token}/authorize`

Exchanges a password for a grant cookie. Rate limited per link **and** per
client (`TORAN_RATE_LIMIT_PASSWORD`).

```json
{ "password": "the link password" }
```

**`200 OK`** — `{ "authorized": true }` plus a `Set-Cookie` with the grant.

**`401 INVALID_CREDENTIALS`** for a wrong password, a link with no password, or
a link that does not exist — the three are indistinguishable, including in
response time (a decoy Argon2id verification runs for the non-matching cases).

### `POST /api/shares/{token}/download`

Atomically reserves a download slot and returns a presigned URL. Empty body.

**`200 OK`**

```json
{
  "url": "https://files.example.com/toran/objects/...?X-Amz-Signature=...",
  "expiresAt": "2026-07-26T12:32:00.000Z",
  "filename": "quarterly-report.pdf",
  "remainingDownloads": 4
}
```

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

**`202 Accepted`** — `{ "received": true }`

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

```javascript
// 1. Ask for permission to upload.
const session = await fetch('/api/uploads', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({
    filename: file.name,
    size: file.size,
    contentType: file.type || 'application/octet-stream',
    expiresInSeconds: 86400,
    maxDownloads: 5,
  }),
}).then((response) => response.json());

// 2. Upload the bytes DIRECTLY to storage. Never through Toran.
await new Promise((resolve, reject) => {
  const request = new XMLHttpRequest();
  request.open('PUT', session.upload.url);
  request.setRequestHeader('Content-Type', session.upload.headers['Content-Type']);
  request.upload.onprogress = (event) => {
    console.log(`${Math.round((event.loaded / event.total) * 100)}%`);
  };
  request.onload = () =>
    request.status < 300 ? resolve() : reject(new Error(`HTTP ${request.status}`));
  request.onerror = () => reject(new Error('network error'));
  request.send(file);
});

// 3. Confirm. Safe to retry.
const { share } = await fetch(`/api/uploads/${session.uploadId}/complete`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: '{}',
}).then((response) => response.json());

console.log(share.url); // the only time you will see the token
```

## Download example

```javascript
const meta = await fetch(`/api/shares/${token}`).then((r) => r.json());
if (meta.status === 'unavailable') throw new Error('link not available');

if (meta.passwordProtected && !meta.authorized) {
  await fetch(`/api/shares/${token}/authorize`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ password }),
    credentials: 'same-origin',
  });
}

const { url } = await fetch(`/api/shares/${token}/download`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: '{}',
  credentials: 'same-origin',
}).then((r) => r.json());

window.location.href = url;
```
