<!-- SPDX-License-Identifier: AGPL-3.0-only -->

# Privacy in Toran

This describes what the **software** stores and why. If you operate a Toran
instance you also need your own privacy policy — this document is input to that,
not a substitute for it.

## What Toran stores

### About files

| Field                            | Why                                                    |
| -------------------------------- | ------------------------------------------------------ |
| Original and normalised filename | Shown to the recipient; reapplied at download          |
| Content type                     | Served correctly and safely                            |
| Declared and actual size         | Quota accounting and integrity verification            |
| Optional checksum                | Operator diagnostics                                   |
| Storage key                      | Locating the object; random, unrelated to the filename |
| Status and scan result           | Lifecycle and malware verdict                          |
| Timestamps                       | Expiry and cleanup                                     |

### About links

Token **hash** only (SHA-256), password **hash** only (Argon2id), expiry,
download limit, download count, revocation time.

Toran cannot recover a raw token or a password from its database.

### About people

This is the part that matters.

| Stored                                              | Not stored                           |
| --------------------------------------------------- | ------------------------------------ |
| A truncated, keyed, rotating hash of the IP address | The IP address itself                |
| A short, printable-ASCII slice of the User-Agent    | The full User-Agent string           |
| Timestamps of uploads and downloads                 | Any cookie or durable identifier     |
| Optional reporter email, only if volunteered        | Anything from browser fingerprinting |

## The client identifier

Toran needs _some_ notion of "the same client" for rate limiting and quotas.
Storing IP addresses would be the obvious way and the wrong one.

Instead:

```text
identifier = HMAC-SHA256(
  key = TORAN_SECRET_KEY,
  message = purpose ‖ normalised-address ‖ day-bucket
) truncated to 64 bits
```

Consequences, deliberate in each case:

- **Irreversible without the key.** A database leak does not reveal addresses.
- **Rotates daily.** It is not a durable tracking identifier. Someone with the
  key still cannot correlate a user across days without also knowing the address.
- **Purpose-separated.** The identifier used for upload limits is different from
  the one used for downloads, so the two cannot be joined.
- **IPv6 collapsed to /64.** That is the smallest block normally assigned to one
  subscriber, so rotating within your own prefix does not multiply your quota.

### The trade-off

Rotation means **quotas reset daily**, and a user who changes network gets a
fresh allowance. Toran accepts weaker abuse control in exchange for not
maintaining a durable record of who uploaded what.

If your deployment needs stronger attribution — a corporate instance, say —
raise `DEFAULT_ROTATION_SECONDS` in `packages/security/src/identity.ts` and
document the change in your privacy policy. Do not do it silently.

## No fingerprinting

Toran does not use canvas fingerprinting, font enumeration, WebGL probing,
audio fingerprinting, behavioural analysis, or any third-party analytics. There
are no third-party requests of any kind — the CSP forbids them.

## Retention

| Data                   | Retained                                          |
| ---------------------- | ------------------------------------------------- |
| File contents          | Until expiry, revocation, or deletion             |
| File and link metadata | Until cleanup removes the record                  |
| Download events        | `TORAN_DOWNLOAD_EVENT_RETENTION_DAYS`, default 30 |
| Rate-limit counters    | Until the window closes                           |
| Abuse reports          | Indefinitely (they are the audit trail)           |
| Application logs       | Whatever your log driver is configured for        |

Expiry is enforced by scheduled jobs, not lazily at read time, so an expired
file is actually deleted rather than merely hidden.

## Logs

Toran logs structured JSON with a redacting layer that removes, by key name and
by value pattern: raw tokens, passwords, password hashes, storage credentials,
authorization headers, cookies, presigned URLs and database URLs.

A typical line:

```json
{
  "level": "info",
  "time": "2026-07-26T12:00:00.000Z",
  "service": "toran-web",
  "requestId": "L3xK9mQ2pRt7",
  "route": "POST /api/shares/[token]/download",
  "statusCode": 200,
  "durationMs": 42,
  "shareLinkId": "7c6d5e4f-...",
  "fileId": "3b2e1d0c-...",
  "msg": "download authorised"
}
```

Database ids appear; the token does not. **Set a log retention period** — logs
are personal data in most jurisdictions.

## What the operator can see

Be honest with your users about this:

- **The operator can read every uploaded file.** Toran has no end-to-end
  encryption. Storage credentials are held by the application.
- The operator can see filenames, sizes, types and timing.
- The operator can be legally compelled to disclose any of it.

If your users need protection from _you_, Toran is not currently the right tool.
Client-side encryption is on the roadmap.

## For operators

Your privacy policy should state at minimum: what you store (this document is a
starting point), how long you keep it, your legal basis, who can access it, how
users request deletion, whether you use third-party infrastructure, and your
contact address.

### Handling deletion requests

```bash
# Find the file from a link the user still has.
toran-admin link "https://toran.example.com/s/<token>"

# Delete the record and the object.
toran-admin delete-file <file-id>
```

Download events and abuse reports are keyed by rotating identifiers, so they
cannot be linked back to an individual — which also means they cannot be
selectively deleted on request. Note that in your policy.

### GDPR notes

Not legal advice. Points to raise with counsel:

- The rotating identifier is likely still personal data, since it derives from
  an IP address and the key exists.
- Toran's data minimisation is strong, but you are the controller and the
  obligations are yours.
- Expiry-driven deletion helps demonstrate storage limitation.
- Where your storage provider is located determines your transfer position.
