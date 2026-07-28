<!-- SPDX-License-Identifier: MIT -->

# Troubleshooting

Start here, in this order:

```bash
curl -fsS http://localhost:3000/api/ready | jq   # which dependency is unhappy?
docker compose ps                                 # what is not healthy?
docker compose logs --tail=100 web worker         # what did it say?
```

Toran returns an `X-Request-Id` on every response. If a user reports a failure,
ask for it and grep the logs.

---

## Toran will not start

### "Toran configuration is invalid"

The message names every offending variable - and never prints its value.

```text
Toran configuration is invalid:
  - TORAN_SECRET_KEY: is still set to the example value
  - TORAN_SECURE_COOKIES: must be true in production
```

In production Toran refuses: example credentials, `http://` origins, insecure
cookies, disabled scanning, and the in-memory rate limiter. That is deliberate,
and there is no flag that downgrades it to a warning. Fix the values.

The message lists every problem it found, so one restart tells you everything
that needs changing.

### The `.env` file is not being read

Toran walks up from the working directory looking for `.env`, so workspace
scripts find the repository-root file. Environment variables that are already
set always win - a container's real environment is never shadowed.

If a value is not taking effect, check whether it is set in the shell or in
`docker-compose.yml`.

---

## Uploads

### "The upload could not reach storage"

The browser could not `PUT` to object storage. Three usual causes:

**1. CSP blocks it.** The Content-Security-Policy `connect-src` must include the
storage origin. Toran builds this at request time from `S3_PUBLIC_ENDPOINT` (or
`S3_ENDPOINT`), so:

```bash
curl -sI https://toran.example.com/ | grep -i content-security-policy
```

If your storage origin is missing, the environment variable is not set where the
web app can see it. Restart the app after changing it.

**2. CORS.** The bucket must allow `PUT` from your app origin:

```bash
curl -i -X OPTIONS "https://files.example.com/toran/objects/test" \
  -H "Origin: https://toran.example.com" \
  -H "Access-Control-Request-Method: PUT"
```

Expect `204` with `Access-Control-Allow-Origin` matching your app.

**3. The browser cannot resolve the storage host.** `S3_ENDPOINT` may be an
internal name like `http://minio:9000` that only the server can reach. Set
`S3_PUBLIC_ENDPOINT` to the host the browser can reach; Toran rewrites only the
origin, so the signature stays valid.

### Storage returns 403

The signature is invalid or expired. Upload URLs live for
`TORAN_UPLOAD_URL_TTL_SECONDS` (default 15 minutes). Request a new session.

Also check the system clock on the server - SigV4 rejects requests with a
skewed timestamp.

### Storage returns 400

The body did not match what was authorised. The presigned `PUT` pins
`Content-Type` and `Content-Length`; the browser must send them exactly. Toran's
own client handles this - a 400 usually means a custom client is not.

### "UPLOAD_SIZE_MISMATCH"

The stored object is not the size that was declared. Toran refuses it, aborts
the session, and queues the object for deletion. Usually a truncated upload;
retry.

### "QUOTA_EXCEEDED"

The per-client quota was hit: `TORAN_ANON_MAX_ACTIVE_FILES`,
`TORAN_ANON_MAX_STORAGE_BYTES`, or `TORAN_ANON_MAX_CONCURRENT_UPLOADS`.

In development, abandoned upload sessions count against the concurrency limit
until they expire. Clear them:

```bash
docker compose exec worker node apps/worker/dist/cli/main.js cleanup --yes
```

### "FILE_TOO_LARGE"

Above `TORAN_MAX_FILE_SIZE_BYTES`. Remember the MVP uses single-request uploads;
see [STORAGE.md](STORAGE.md#upload-size-limits) before raising it a lot.

---

## Downloads

### Links stay on "Scanning this file"

The scan has not completed. In order of likelihood:

**ClamAV is not ready.** First boot downloads a signature database and takes
several minutes.

```bash
docker logs -f toran-clamav
docker compose ps clamav      # is it healthy?
```

**The worker is not running.** The web app looks perfectly healthy while nothing
ever becomes downloadable, because it is the worker that scans uploads.

```bash
docker compose ps worker
docker compose logs --tail=50 worker
```

In development `npm run dev` starts the worker alongside the web app, and its
logs are interleaved with everything else - look for `worker started` and, per
upload, `scan clean; file is ready`. If neither appears, check that you are
running `npm run dev` and not `next dev` or the web workspace on its own. To run
just the worker against a stack that is already up:

```bash
npm run dev --workspace=@toran/worker
```

**The worker cannot reach ClamAV.** Look for `scanner error` in the worker log.
Check `CLAMAV_HOST` and `CLAMAV_PORT`. Jobs retry with backoff; nothing is lost.

### "This link isn't available"

Deliberately uniform - it covers expired, revoked, exhausted, blocked, deleted
and never-existed, so the page cannot be used to probe for valid tokens. To find
out which it actually was:

```bash
toran-admin link "https://toran.example.com/s/<token>"
```

### Downloads get the wrong filename

Toran sets the filename with `ResponseContentDisposition` on the presigned
`GET`. Some S3-compatible services ignore response overrides. See
[STORAGE.md](STORAGE.md#content-disposition-support).

### "That password is not correct" for a correct password

Check whether you are rate limited - `TORAN_RATE_LIMIT_PASSWORD` applies per
link **and** per client, and a `429` carries `Retry-After`.

Note that a link with no password and a link that does not exist both return
`INVALID_CREDENTIALS`, by design.

---

## Worker

### Jobs are failing

```bash
toran-admin jobs --failed
```

Each shows `attempts/maxAttempts` and the last error. To requeue one:

```bash
toran-admin retry-job <job-id>
```

### Files stuck in "scanning" after the worker recovered

The `retry_failed_scans` job requeues scans that stalled. It runs on the
maintenance interval. Force it:

```bash
toran-admin cleanup --yes
```

### The worker crashed and jobs are locked

Locks expire after `TORAN_WORKER_JOB_LOCK_SECONDS` (default 300) and are
reclaimed automatically on the next tick. No action needed.

---

## Database

### "too many connections"

`DATABASE_POOL_MAX` multiplied by the number of processes exceeds PostgreSQL's
`max_connections`. Lower the pool, raise the limit, or put PgBouncer in front.
Toran runs with prepared statements disabled specifically so transaction-mode
poolers work.

### Migrations fail

```bash
docker compose logs migrate
```

Migrations are forward-only and idempotent. If one fails partway, restore your
backup rather than hand-editing the schema.

### CI reports schema drift

The Drizzle schema changed without a committed migration:

```bash
npm run db:generate
git add packages/database/drizzle
```

---

## Development

### `npm run dev:setup` fails

**Docker not running** - start Docker Desktop or your daemon.

**Ports in use** - 5432, 9000, 9001 and 3310 must be free.
`docker compose -f docker-compose.dev.yml down` then retry.

**ClamAV never goes healthy** - it needs roughly 1.5 GB of RAM. On Docker
Desktop, raise the VM memory limit.

### A share link does not open on another device

**Both devices must be on the same local network.** A guest or isolated WiFi
network usually blocks client-to-client traffic entirely.

**Ports 3000 and 9000 must both be reachable.** The page loading while the
download fails is the signature of 3000 being open and 9000 being blocked:
downloads redirect the browser straight to object storage. On Windows, allow both
through the Firewall for Private networks.

**The link must carry the LAN address, not `localhost`.** Generate links from the
address `npm run dev` printed. Links made under an address you have since lost on
reconnect will not work; re-run `npm run dev`.

**`npm run dev` must have found a LAN address.** With none available it says so
and falls back to a localhost-only instance, which nothing else on the network
can reach. Name the address by hand if detection picked the wrong adapter:
`npm run dev -- --address 192.168.1.42`.

**`npm run dev:setup` has to have run once**, otherwise the bucket and schema do
not exist. `npm run dev` stops with that message rather than starting a server
that cannot work.

### Tests fail with "DATABASE_URL is unreachable"

Integration and E2E tests need the dev stack:

```bash
npm run dev:setup
```

They skip themselves with a message rather than failing, so `npm test` alone
should always pass.

### Playwright tests fail

```bash
npx playwright install chromium   # from apps/web
```

Then confirm the stack is healthy: `curl -fsS http://localhost:3000/api/ready`.

Traces for failures are in `apps/web/test-results/`:

```bash
npx playwright show-trace apps/web/test-results/<test>/trace.zip
```

### Changes to a package are not picked up

Workspace packages compile to `dist/`. Rebuild, or run the watcher:

```bash
npm run build
# or
npm run dev --workspace=@toran/shared
```

---

## Still stuck

Open an issue with: what you ran, what happened, the relevant log lines with the
`requestId`, your `/api/ready` output, and how you are running Toran.

**Redact every share link, password and credential first.** Issues are public.
