<!-- SPDX-License-Identifier: MIT -->

# Security Policy

## Reporting a Vulnerability

**Please do not open a public issue for a security vulnerability.**

Report privately through GitHub:

1. Go to the repository's **Security** tab.
2. Choose **Report a vulnerability** ([direct link](https://github.com/toran-project/toran/security/advisories/new)).
3. Describe the issue.

If GitHub advisories are unavailable to you, email the maintainers at the
address in the repository profile with `[SECURITY]` in the subject.

### What to Include

- What the vulnerability lets an attacker do.
- The steps to reproduce it, and the version or commit you tested.
- Whether it needs an authenticated user, a valid share link, or neither.
- Any proof of concept, with real tokens and credentials redacted.

### What to Expect

| Stage                    | Target                                  |
| ------------------------ | --------------------------------------- |
| Acknowledgement          | 3 working days                          |
| Initial assessment       | 10 working days                         |
| Fix for a critical issue | 30 days where practical                 |
| Public advisory          | After a fix ships, coordinated with you |

Toran is a volunteer-maintained project. These are goals, not contractual
commitments.

### Disclosure

We follow coordinated disclosure. Please give us a reasonable chance to ship a
fix before publishing. We will credit you in the advisory unless you prefer
otherwise.

### Safe Harbour

We will not pursue or support legal action against research that:

- targets **your own** Toran instance, not somebody else's;
- avoids privacy violations, data destruction, and service degradation;
- does not access, modify, or exfiltrate data belonging to other people;
- gives us a reasonable window before public disclosure.

Testing against a third party's Toran instance without their permission is not
covered, and is not something we can authorise.

---

## Supported Versions

Toran is pre-1.0. Only the latest release on `main` receives security fixes.

| Version                 | Supported |
| ----------------------- | --------- |
| `main` / latest release | Yes       |
| Anything older          | No        |

---

## In Scope

- The Toran web application and API.
- The Toran worker, job queue, and administration CLI.
- The published Docker images and `docker-compose.yml`.
- Default configuration values and the production start-up guards.
- The documented deployment guidance.

## Out of Scope

These are known properties, documented in
[docs/THREAT_MODEL.md](docs/THREAT_MODEL.md), not vulnerabilities:

- **Anyone with a share link can download every file behind it.** The URL _is_
  the capability. That is the design. One password and one expiry cover the
  whole link; per-file access control is not a feature Toran has.
- **Presigned download URLs are reusable until they expire** (default 120
  seconds). Toran's download limit is enforced atomically at reservation time,
  but it cannot revoke an already-signed URL. See the limitations section of the
  README.
- **The share token is present in the `/s/{token}` page's HTML**, not only in
  its URL, because the route is dynamic. The response is `no-store` and goes
  only to the client that supplied the token. Recorded as a limitation in
  [docs/THREAT_MODEL.md](docs/THREAT_MODEL.md).
- **`GET /api/shares/{token}` is not rate limited**, deliberately: the download
  page polls it while a file is scanning. Rate limit it at your reverse proxy.
- **ClamAV does not detect every malicious file.** Signature-based scanning
  catches known threats only.
- **The operator can read uploaded files.** Toran has no end-to-end encryption
  yet.
- **Anonymous quotas can be bypassed by changing network**, because they key on
  a rotating hash of the client address rather than a durable identifier.
- Vulnerabilities in a deployment's own reverse proxy, TLS configuration, or
  object-storage provider.
- Findings from an automated scanner with no demonstrated impact.
- Missing hardening headers on responses that carry no content.

---

## Security Properties Toran Maintains

If you find a way to break any of these, it is a vulnerability:

1. **Raw share tokens are never disclosed to anyone who did not already have
   them.** A token is returned once, in the creation response. It is not logged,
   not stored (only a SHA-256 hash is), and never placed in a job payload or an
   error message. The share page's own HTML does contain the token, because it
   is a dynamic route and Next.js serialises the request's own URL into the
   response - that response is `Cache-Control: no-store` and goes only to the
   client that supplied the token in the first place. See the token-leakage
   limitation in [docs/THREAT_MODEL.md](docs/THREAT_MODEL.md).
2. **Presigned URLs and credentials never appear in logs.** The logger redacts
   by key name and by value pattern.
3. **A file becomes downloadable only after an explicit clean scan verdict**
   when scanning is enabled: clamd's exact `stream: OK` reply, for a stream
   whose byte count matched the object's recorded size. Any other reply, and any
   short read, is an error rather than a pass. Each file of a link is judged on
   its own.
4. **A file's download limit cannot be exceeded by concurrency.** The check and
   increment are one atomic statement on that file's row, backed by a database
   CHECK constraint, so no two requests can claim the same last slot. The budget
   is **per file**: a limit of _n_ on a link of _k_ files permits _n_ downloads
   of each, by design. (A reservation released after a storage-signing failure
   returns the slot to the pool; combined with the presigned-URL window this is
   the one way the count of _effective_ downloads can exceed the limit. Both are
   documented limitations, not bugs.)
5. **Uploaded content is never rendered on the application origin.** Active
   formats are forced to `application/octet-stream` and always served as
   attachments.
6. **A hostile filename cannot influence the storage key.** Keys are generated
   randomly and validated on every storage call.
7. **A file cannot be put behind a link by someone who did not upload it.**
   `POST /api/shares` requires a manage grant per file id, signed and bound to
   that id; without one the file is reported as `NOT_FOUND`.
8. **Link-level controls apply to every file behind the link.** Revoking or
   expiring a link, or failing its password, stops all of them. A file being
   unavailable never makes a sibling downloadable, and a sibling being
   unavailable never hides a file that is ready.
9. **Toran refuses to start in production with example credentials**, HTTP
   origins, insecure cookies, disabled scanning, or the in-memory rate limiter.
   There is no configuration flag that downgrades these to warnings. Both
   processes exit non-zero on an unsafe configuration - the worker from
   `main()`, the web tier from its Next.js `instrumentation` hook - so a
   misconfigured deployment fails loudly at boot rather than serving errors.
10. **Password attempts are rate limited per link and per client**, and a
    nonexistent link costs the same time as a real one.

---

## For Operators

Running Toran for other people makes you responsible for their data. At minimum:

- Serve everything over HTTPS with a valid certificate.
- Keep the storage bucket private.
- Use a strong, unique `TORAN_SECRET_KEY`, database password and storage
  credentials - never the values from `.env.example`.
- Set `TORAN_RATE_LIMIT_BACKEND=postgres`.
- Keep ClamAV signatures updated.
- Use a separate hostname for downloads.
- Back up PostgreSQL **and** object storage.
- Publish an abuse contact and act on reports.
- Apply Toran updates promptly.

The full list is the [production checklist](docs/DEPLOYMENT.md#production-checklist).

---

## Secret Scanning

Enable GitHub **secret scanning** and **push protection** on any fork. Toran
also ships `npm run secrets:scan`, which CI runs on every pull request. It is a
backstop, not a replacement for either.

If a credential is ever committed: rotate it first, then remove it from history.
Rotation is what actually protects you; history rewriting is cleanup.
