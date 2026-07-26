<!-- SPDX-License-Identifier: AGPL-3.0-only -->

# Toran threat model

Each threat below records four things: the **risk**, the **mitigation** Toran
implements, the **remaining limitation** after that mitigation, and a
**future improvement**. The remaining limitations are the honest part — read
them.

## Core assumption

**The share URL is a capability.** Anyone holding it can download the file,
subject to the link's own limits. Toran protects the URL; it cannot protect a
user who posts it publicly.

## Assets

| Asset                  | Why it matters                          |
| ---------------------- | --------------------------------------- |
| Uploaded file contents | The thing users are trusting Toran with |
| Raw share tokens       | Possession is authorisation             |
| Link passwords         | Second factor on a link                 |
| Storage credentials    | Full read/write of every object         |
| `TORAN_SECRET_KEY`     | Forges grants and client identifiers    |
| Database contents      | Metadata, hashes, usage patterns        |
| Service availability   | Denial of service affects every user    |

## Adversaries

1. **Opportunistic scanner** — automated, untargeted, high volume.
2. **Malicious uploader** — using Toran to distribute malware, phishing, or
   illegal content.
3. **Link guesser** — trying to enumerate other people's files.
4. **Resource abuser** — exhausting storage or bandwidth.
5. **Network observer** — on the path between browser and server.
6. **Compromised dependency** — malicious code in the supply chain.
7. **Curious operator** — has legitimate infrastructure access. **Toran does not
   defend against this one**; see "no end-to-end encryption".

---

## 1. Malicious uploads

**Risk.** An attacker uploads content that attacks the server, the worker, or
whoever downloads it.

**Mitigation.** Toran never interprets uploaded content. Bytes go browser →
storage and storage → ClamAV, never through a parser in the app. Filenames are
normalised and validated; the storage key is generated, never derived from
input. Declared size is validated, and actual stored size verified with a `HEAD`.
Active content types are forced to `application/octet-stream` and always served
with `Content-Disposition: attachment`.

**Remaining limitation.** Toran does not sandbox ClamAV's parsers, and ClamAV
itself parses hostile input. A ClamAV parsing vulnerability would execute in the
worker container.

**Future improvement.** Run the scanner with seccomp/AppArmor confinement and no
network egress; add per-scan resource limits.

## 2. Malware distribution

**Risk.** Toran becomes a delivery host for malware.

**Mitigation.** Every upload is streamed to ClamAV before a link will serve it.
Scanning **fails closed**: a file becomes `ready` only on an explicit clean
verdict. Scanner outages leave files in `scanning`, not available. Infected
files are blocked, their links revoked, and the object quarantined or deleted.
`freshclam` keeps signatures current. The download page states plainly that
scanning is not a guarantee.

**Remaining limitation.** Signature-based scanning misses novel payloads,
targeted attacks, encrypted archives, and anything newer than the last signature
update. **Toran does not make files safe.**

**Future improvement.** Optional integration with a multi-engine or
behavioural scanning service, kept optional so Toran stays free to run.

## 3. Link enumeration

**Risk.** An attacker guesses share tokens to find other people's files.

**Mitigation.** Tokens are 24 cryptographically random bytes — 192 bits, well
above the 128-bit floor — encoded URL-safe. Guessing is not feasible even
without rate limiting. Download attempts are rate limited anyway. Missing,
revoked, expired, exhausted, blocked and deleted links all return the same
uniform "unavailable" shape, so the endpoint is not an existence oracle.

**Remaining limitation.** A correct token always works; that is the design.

**Future improvement.** Optional per-instance token length configuration.

## 4. Token leakage

**Risk.** A token escapes through a log, a referrer, a proxy, or browser history.

**Mitigation.** The raw token is returned exactly once, in the creation
response. Only its SHA-256 is stored. It is never logged (the logger redacts by
key name and value pattern), never placed in a job payload, and never
server-rendered — the share page is a client shell that fetches metadata itself.
`Referrer-Policy: no-referrer` is set globally. The download URL is delivered in
a JSON body, not a redirect, so it does not enter history.

**Remaining limitation.** The token is in the URL, so it will appear in the
user's own browser history, in any screenshot, and in whatever channel they use
to share it. TLS protects it on the wire; nothing protects a user who pastes it
into a public forum.

**Future improvement.** Optional fragment-based tokens (`/s/#token`), which are
never sent to the server at all.

## 5. Database leakage

**Risk.** An attacker obtains a database dump.

**Mitigation.** No raw tokens (SHA-256 only), no plaintext passwords (Argon2id
only), no raw IP addresses (truncated rotating HMAC only), no storage
credentials. A dump alone does not yield a single downloadable link.

**Remaining limitation.** A dump reveals filenames, sizes, content types,
timestamps and usage patterns. Combined with storage access it reveals which
object belongs to which file.

**Future improvement.** Optional encryption of filename metadata at rest.

## 6. Storage-credential leakage

**Risk.** An attacker obtains the S3 credentials and reads every object.

**Mitigation.** Credentials live only in the server environment. They are never
sent to a browser, never logged (redacted by key name), and never baked into a
container image. Browsers only ever receive presigned URLs scoped to one object,
one method, and a few minutes.

**Remaining limitation.** Toran uses one credential pair with full bucket
access. A compromise of the app or worker environment exposes the whole bucket.

**Future improvement.** Separate least-privilege credentials for web (presign
only) and worker (read/delete), plus support for assumed roles.

## 7. Presigned URL leakage

**Risk.** A signed URL is captured and reused.

**Mitigation.** Short lifetimes — 120 seconds for downloads, 15 minutes for
uploads. Scoped to a single object and method. Never logged. Delivered in a
response body rather than a redirect.

**Remaining limitation. This is Toran's most significant known weakness.** A
download URL, once issued, is valid until it expires regardless of the link's
download limit. Toran reserves the slot atomically, but it cannot revoke an
already-signed URL. **Single-use downloads are therefore not perfectly enforced.**

**Future improvement.** A proxy-download mode streaming through the application,
giving exact single-use semantics at the cost of bandwidth. `getObjectStream`
already exists for this.

## 8. Password brute force

**Risk.** An attacker guesses a link's password.

**Mitigation.** Argon2id at the OWASP-recommended profile (19 MiB, t=2, p=1),
which makes each guess expensive. Attempts are rate limited **twice** — per link
and per client — so a distributed attacker cannot trade addresses for attempts
against one link. Errors are generic. A nonexistent or password-free link still
runs a decoy Argon2id verification, so response time does not reveal which case
occurred. Success resets the link's attempt budget so a legitimate visitor is
not locked out by someone else's failures.

**Remaining limitation.** A weak, guessable password is still weak. Toran
enforces only an 8-character minimum.

**Future improvement.** Optional strength requirements and a configurable
per-link lockout.

## 9. Denial of service

**Risk.** An attacker exhausts CPU, connections, or the worker queue.

**Mitigation.** Rate limits on every expensive endpoint, using a shared
PostgreSQL backend in production. Request body ceiling and per-request timeout.
Bounded worker concurrency and cleanup batch sizes. Argon2id memory cost is
bounded and the endpoint that invokes it is rate limited. File bytes never
occupy an app process.

**Remaining limitation.** Toran has no network-layer DDoS protection; that is
the job of the reverse proxy or CDN in front of it. The rotating client
identifier means a distributed attacker gets a fresh budget per address.

**Future improvement.** Documented fail2ban and CDN rules; optional proof-of-work
on upload creation.

## 10. Storage exhaustion

**Risk.** An attacker fills the bucket.

**Mitigation.** Per-client quotas on active file count, total bytes, and
concurrent uploads. Quota accounting counts the _declared_ size of in-flight
uploads, so a burst of concurrent uploads cannot collectively exceed the
allowance before any completes. Maximum file size. Every file has an expiry, and
cleanup jobs delete expired objects. Stale upload sessions are reclaimed.

**Remaining limitation.** Quotas key on a rotating identifier, so a determined
attacker with many addresses can exceed them. There is no global instance cap.

**Future improvement.** Global storage ceiling with admission control; optional
account requirement above a size threshold.

## 11. Download amplification

**Risk.** Toran is used to serve high-bandwidth content at the operator's cost.

**Mitigation.** Download rate limiting; optional per-link download caps; expiry
on every link; downloads served by storage, so provider-level bandwidth controls
apply directly.

**Remaining limitation.** An unlimited link with a long expiry can be shared
widely. Toran cannot distinguish popular from abusive.

**Future improvement.** Per-link bandwidth accounting and an optional default
download cap.

## 12. Filename attacks

**Risk.** A crafted filename escapes a path, spoofs an extension, or injects
into a header.

**Mitigation.** `normalizeFilename` strips POSIX and Windows path components,
rejects control characters, removes bidirectional override characters used for
extension spoofing, replaces characters hostile in paths or headers, rejects
pure-dot and reserved device names, strips leading dots, and caps length while
preserving the extension. `Content-Disposition` uses RFC 6266 with an
aggressively sanitised ASCII fallback and a percent-encoded `filename*`.
Crucially, **the filename never influences the storage key** — keys are random.

**Remaining limitation.** Homoglyph and mixed-script names can still mislead a
human reader.

**Future improvement.** Optional confusable-script detection and warning.

## 13. Content-type confusion

**Risk.** A file is served in a way that makes a browser execute it.

**Mitigation.** Active formats (HTML, SVG, XML, XSLT, JS, PDF, and their
extensions) are downgraded to `application/octet-stream` at upload time — the
stored type, not just the served one. Everything is served as an attachment.
`X-Content-Type-Options: nosniff` everywhere. A separate download hostname is
recommended and documented, so even a successful bypass executes on an origin
with no Toran state.

**Remaining limitation.** With a single hostname (the default for a small
deployment), an execution bypass would run on the app origin.

**Future improvement.** Make the separate download hostname the default and warn
at start-up when it is not configured.

## 14. Race conditions

**Risk.** Concurrent requests bypass a limit or corrupt state.

**Mitigation.** See [ARCHITECTURE.md](ARCHITECTURE.md#concurrency). The download
limit is one atomic statement plus a database CHECK. Job claiming uses
`FOR UPDATE SKIP LOCKED`. Upload completion is idempotent under a row lock.
Revocation, deletion and object removal are all idempotent. Integration tests
exercise the concurrency directly rather than asserting on mocks.

**Remaining limitation.** The presigned-URL window (threat 7) means the download
counter is exact but the _effective_ downloads are not.

**Future improvement.** Proxy-download mode.

## 15. Worker compromise

**Risk.** An attacker gains code execution in the worker, most plausibly through
ClamAV parsing hostile input.

**Mitigation.** The worker runs as a non-root user in its own container, with no
inbound network beyond a local health endpoint. It never serves user requests.
ClamAV runs in a separate container.

**Remaining limitation.** The worker holds full storage credentials and full
database access. A compromise is serious.

**Future improvement.** Least-privilege credentials per component; seccomp
profiles; a scan-only subprocess with no credentials at all.

## 16. Server-side request forgery

**Risk.** An attacker makes Toran fetch a URL of their choosing.

**Mitigation.** Toran fetches exactly two things: object storage and ClamAV,
both at addresses from validated configuration. **No user input ever becomes a
URL Toran fetches.** Storage keys are validated against a strict pattern before
any storage call, so a corrupted database value cannot redirect a request.

**Remaining limitation.** An operator who points `S3_ENDPOINT` at an internal
service creates the problem themselves.

**Future improvement.** Optional allow-list validation of the storage endpoint
at start-up.

## 17. Cross-site scripting

**Risk.** Script executes on the Toran origin.

**Mitigation.** **No uploaded content is ever rendered on the app origin** —
that removes the whole category. React escapes output by default. A strict CSP
is set at request time (`default-src 'self'`, `object-src 'none'`,
`base-uri 'none'`, `frame-ancestors 'none'`). The only `dangerouslySetInnerHTML`
in the codebase is a static, developer-authored theme bootstrap containing no
user data.

**Remaining limitation.** The CSP includes `'unsafe-inline'` for scripts, which
Next.js requires for its bootstrap payload. This is materially safer here than
in a typical app precisely because no user content is rendered on this origin.

**Future improvement.** Nonce-based CSP once Next.js supports it cleanly with
the App Router.

## 18. Cross-site request forgery

**Risk.** A hostile site makes a victim's browser perform a Toran mutation.

**Mitigation.** Every mutating endpoint validates the `Origin` header. Grant
cookies are `HttpOnly`, `SameSite=Strict`, path-scoped, and bound to a specific
share-link id, so they cannot be replayed against another link. Management
operations require a signed grant delivered in a header, which a cross-site form
cannot set.

**Remaining limitation.** A non-browser client can send any `Origin` — but such
a client cannot use a victim's cookies, which is what CSRF is about.

**Future improvement.** Double-submit tokens if cookie-authenticated user
accounts are added.

## 19. Supply-chain attacks

**Risk.** A malicious or compromised dependency.

**Mitigation.** `package-lock.json` is committed and CI uses `npm ci`
exclusively. Dependabot groups and proposes updates. CI runs dependency review,
`npm audit` on production dependencies, CodeQL, container scanning, and SBOM
generation. The dependency surface is kept deliberately small — the ClamAV
client and the cookie parser are implemented directly rather than pulled in, and
Argon2id uses a pure-WASM implementation with no native build step.

**Remaining limitation.** Toran trusts npm and the registry. A sophisticated
compromise of a transitive dependency would not be caught by these controls.

**Future improvement.** Vendored dependency pinning by integrity hash; optional
provenance verification; reproducible container builds.

## 20. Abuse and illegal content

**Risk.** Toran is used to distribute illegal or harmful material.

**Mitigation.** A rate-limited abuse reporting endpoint and form covering
malware, phishing, copyright, harassment, illegal content and other. Reporter
identity is stored only as a rotating hash and is never exposed to the uploader.
Administrators can look up, block and delete content through the CLI. Every file
has a bounded lifetime by design. Uploads are attributable to a rotating client
identifier for a limited window.

**Remaining limitation.** Toran does not perform proactive content matching
(no PhotoDNA, no hash-list checking). Rotating identifiers deliberately limit
how far an uploader can be traced — a privacy choice with an abuse cost.

**Future improvement.** Optional known-hash blocklist integration; an
administrative queue for reported content; documented legal-request process.

---

## Non-goals

Toran explicitly does not defend against these. Do not deploy it expecting it to.

1. **A malicious operator.** No end-to-end encryption; the operator can read
   every file. Do not use Toran for content you would not show your host.
2. **Traffic analysis.** Sizes and timing are visible to the network.
3. **Compelled disclosure.** The operator can be legally compelled.
4. **A compromised uploader device.**
5. **Users who share links publicly.**

## Verification status

| Control                              | Verified how                                                            |
| ------------------------------------ | ----------------------------------------------------------------------- |
| Token entropy and hashing            | Unit tests                                                              |
| Argon2id parameters and verification | Unit tests                                                              |
| Filename normalisation               | 30 unit tests covering traversal, control chars, bidi, reserved names   |
| Log redaction                        | Unit tests asserting tokens and signed URLs never survive               |
| Atomic download limit                | Integration test: 20 concurrent claims against a limit of 3             |
| Job claim exclusivity                | Integration test: 4 workers, 12 jobs, no overlap                        |
| Idempotent completion                | Integration test: 3 concurrent completions, exactly 1 wins              |
| Scan fail-closed                     | Integration tests for clean, infected, transient and permanent outcomes |
| Production start-up guards           | Unit tests for each unsafe setting                                      |
| End-to-end link lifecycle            | Playwright against real MinIO, PostgreSQL and ClamAV                    |
| **External security audit**          | **Not performed**                                                       |
