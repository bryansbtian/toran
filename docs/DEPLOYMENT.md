<!-- SPDX-License-Identifier: MIT -->

# Deploying Toran

Docker Compose is the **primary supported path**. Managed deployment works too,
with one caveat covered below.

---

## Self-hosting with Docker Compose

### Requirements

- A host with Docker and Compose v2.
- 4 GB RAM minimum. **ClamAV alone needs about 1.5 GB** for its signature
  database; below that it will be killed by the OOM reaper.
- A domain name and a TLS certificate (Caddy will get one for you).

### Install

```bash
git clone https://github.com/toran-project/toran.git
cd toran
```

Create `.env` from the template. On Linux and macOS that is
`cp .env.example .env`; in PowerShell, `Copy-Item .env.example .env`.

Now open `.env` in an editor and set the values below. Toran **will refuse to
start** if you skip this, and there is no flag that turns those checks into
warnings.

```dotenv
NODE_ENV=production

TORAN_APP_URL=https://toran.example.com
TORAN_DOWNLOAD_URL=https://files.example.com
TORAN_SECURE_COOKIES=true
TORAN_RATE_LIMIT_BACKEND=postgres

TORAN_SECRET_KEY=paste-a-generated-value-here
POSTGRES_PASSWORD=paste-a-generated-value-here
MINIO_ROOT_USER=paste-a-generated-value-here
MINIO_ROOT_PASSWORD=paste-a-generated-value-here

TORAN_ABUSE_CONTACT_EMAIL=abuse@example.com

# The web app binds to loopback; your reverse proxy fronts it. These four are
# read by docker-compose.yml, not by Toran.
TORAN_BIND_ADDRESS=127.0.0.1
TORAN_PORT=3000
MINIO_BIND_ADDRESS=127.0.0.1
MINIO_PORT=9000
```

Generate each secret by running this in a terminal and copying what it prints -
once per value, never reusing one:

```bash
node -e "console.log(require('node:crypto').randomBytes(32).toString('base64url'))"
```

Paste the output as a literal value. An `.env` file is parsed, not executed, so
writing `TORAN_SECRET_KEY=$(node ...)` stores the text of the command rather
than a secret, and Toran would reject it.

`docker-compose.yml` builds the containers' `DATABASE_URL`, `S3_ACCESS_KEY_ID`
and `S3_SECRET_ACCESS_KEY` from `POSTGRES_*` and `MINIO_ROOT_*`, so those are
the values to set; you do not also edit `DATABASE_URL` for a Compose
deployment.

Then:

```bash
docker compose up -d
docker compose ps
```

You should see `toran-web`, `toran-worker`, `toran-postgres`, `toran-minio` and
`toran-clamav` healthy, with `toran-migrate` and `toran-minio-init` exited
successfully.

```bash
curl -fsS http://127.0.0.1:3000/api/health
curl -fsS http://127.0.0.1:3000/api/ready
```

ClamAV takes several minutes on first boot to download signatures. Uploads sit
in `scanning` until it is ready. `docker logs -f toran-clamav`.

### What each service does

| Service            | Public port | Notes                                        |
| ------------------ | ----------- | -------------------------------------------- |
| `toran-web`        | via proxy   | The only service that serves users           |
| `toran-worker`     | none        | Scanning, cleanup, reconciliation            |
| `toran-migrate`    | none        | Runs migrations once, then exits             |
| `toran-postgres`   | none        | Never expose this                            |
| `toran-minio`      | via proxy   | Browsers reach it directly for file transfer |
| `toran-minio-init` | none        | Creates the private bucket, then exits       |
| `toran-clamav`     | none        |                                              |

---

## Reverse proxy

### Why a separate download hostname

Put storage on a **different hostname** from the app:

```text
toran.example.com   -> toran-web
files.example.com   -> toran-minio
```

If a browser is ever tricked into rendering an uploaded file instead of
downloading it, that content executes on `files.example.com`, which has no Toran
cookies, no session, and no same-origin access to anything. On a single
hostname, the same bug would be an XSS on your application origin.

It also lets you apply different caching, rate limiting and bandwidth policy to
bulk transfer.

### Caddy

```caddyfile
toran.example.com {
	encode gzip
	reverse_proxy 127.0.0.1:3000 {
		header_up X-Real-IP {remote_host}
	}
}

files.example.com {
	# Large bodies: this path carries the actual files.
	request_body {
		max_size 5GB
	}
	reverse_proxy 127.0.0.1:9000 {
		header_up Host {upstream_hostport}
	}
}
```

Then set `TORAN_TRUSTED_PROXIES=127.0.0.1` so Toran honours `X-Real-IP` from
Caddy. **Without this, every client looks like the proxy** and per-client rate
limits become a single shared bucket.

### nginx

```nginx
server {
    listen 443 ssl http2;
    server_name toran.example.com;

    ssl_certificate     /etc/letsencrypt/live/toran.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/toran.example.com/privkey.pem;

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_set_header Host              $host;
        proxy_set_header X-Real-IP         $remote_addr;
        proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}

server {
    listen 443 ssl http2;
    server_name files.example.com;

    ssl_certificate     /etc/letsencrypt/live/files.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/files.example.com/privkey.pem;

    # Files stream through here. Do not buffer them to disk.
    client_max_body_size 5G;
    proxy_request_buffering off;
    proxy_buffering off;
    proxy_read_timeout 600s;
    proxy_send_timeout 600s;

    location / {
        proxy_pass http://127.0.0.1:9000;
        proxy_set_header Host $http_host;
    }
}
```

---

## Managed deployment

### Vercel is not sufficient on its own

Toran's default architecture needs two things Vercel cannot provide:

1. **A long-running worker process** that polls the job queue, streams objects
   to ClamAV, and runs cleanup. Vercel runs request-scoped functions.
2. **A ClamAV daemon**, which is a stateful service holding a multi-gigabyte
   signature database in memory.

You can host the **web tier** on Vercel. The worker and ClamAV need a
container-capable platform.

### Recommended split

| Component       | Platform                                   |
| --------------- | ------------------------------------------ |
| Web             | Vercel, Fly.io, Railway, Render, Cloud Run |
| PostgreSQL      | Neon, Supabase, RDS, Cloud SQL             |
| Object storage  | S3, Cloudflare R2, Backblaze B2            |
| Worker + ClamAV | Fly.io, Railway, Render, ECS, a VPS        |

The worker and ClamAV should be co-located: the worker streams whole file
contents to clamd, so putting them in different regions is slow and expensive.

### Vercel guide (web tier only)

1. Import the repository. Set the root directory to `apps/web`.
2. Build command: `cd ../.. && npm run build --workspace=@toran/web`.
3. Set every variable from `.env.example` in Vercel's environment settings, with
   `NODE_ENV=production`.
4. Set `TORAN_RATE_LIMIT_BACKEND=postgres` - Vercel runs many isolated
   instances, so the in-memory limiter would be meaningless. Toran refuses it in
   production anyway.
5. Configure the storage bucket's CORS to allow `PUT` from your Vercel domain.
6. Deploy the worker separately (below).
7. Run migrations once, from anywhere with database access:
   `npm run db:migrate`.

Vercel terminates TLS and sets `X-Forwarded-For`. Set `TORAN_TRUSTED_PROXIES` to
Vercel's ranges, or leave it empty and accept that rate limiting keys on the
proxy.

### Worker on Fly.io

```toml
# fly.toml
app = "toran-worker"

[build]
  dockerfile = "apps/worker/Dockerfile"

[env]
  NODE_ENV = "production"
  TORAN_SCANNING_ENABLED = "true"
  CLAMAV_HOST = "localhost"

[[services]]
  internal_port = 3001
  protocol = "tcp"
  [[services.http_checks]]
    path = "/health"

[[vm]]
  memory = "2gb"   # ClamAV needs most of this
  cpus = 1
```

Set secrets with `fly secrets set DATABASE_URL=... TORAN_SECRET_KEY=... ...`.
Run ClamAV as a second process in the same machine (via a process group) or as a
separate Fly app on the private network.

---

## Production checklist

Work through this before letting anyone else use your instance.

### Transport and access

- [ ] HTTPS everywhere, with a valid certificate and automatic renewal.
- [ ] `TORAN_APP_URL` and `TORAN_DOWNLOAD_URL` both `https://`.
- [ ] `TORAN_SECURE_COOKIES=true`.
- [ ] A separate download hostname configured.
- [ ] `TORAN_TRUSTED_PROXIES` set to your proxy's address, and nothing else.
- [ ] PostgreSQL and ClamAV not reachable from the internet.

### Secrets

- [ ] `TORAN_SECRET_KEY` is 32+ random characters, unique to this deployment.
- [ ] Database password is strong and not the example value.
- [ ] Storage credentials are strong and not the example values.
- [ ] Secrets come from a secret manager or Docker secrets, not a file in the
      repository.
- [ ] No secret is baked into a container image.
- [ ] A rotation procedure is written down.

### Storage

- [ ] The bucket is **private**. Verify: an unauthenticated `GET` of an object
      URL must fail.
- [ ] Public bucket listing is disabled.
- [ ] CORS allows `PUT` only from your application origin.
- [ ] A lifecycle policy expires the `quarantine/` prefix.
- [ ] Storage quotas or billing alerts are configured.

### Scanning

- [ ] `TORAN_SCANNING_ENABLED=true`.
- [ ] ClamAV is healthy and `freshclam` is updating signatures.
- [ ] Signature age is monitored - stale signatures are worse than none.
- [ ] `TORAN_BLOCKED_FILE_ACTION` matches your retention policy.
- [ ] `CLAMAV_MAX_SCAN_BYTES` is at least `TORAN_MAX_FILE_SIZE_BYTES`.

### Limits

- [ ] `TORAN_RATE_LIMIT_BACKEND=postgres`.
- [ ] Rate limits tuned for expected traffic.
- [ ] `TORAN_MAX_FILE_SIZE_BYTES` set deliberately.
- [ ] Per-client quotas set deliberately.
- [ ] `TORAN_MAX_EXPIRY_SECONDS` set deliberately.

### Reliability

- [ ] PostgreSQL backups run automatically **and restores are tested**.
- [ ] Object storage is replicated or backed up.
- [ ] `TORAN_SECRET_KEY` is backed up separately from the database.
- [ ] The worker is monitored; a dead worker means nothing becomes downloadable.
- [ ] Alerts on `/api/ready` failing, on failed jobs, and on disk usage.
- [ ] Log retention configured, with a documented retention period.
- [ ] Upgrade procedure tested on a staging copy.

### Governance

- [ ] An abuse contact is published and monitored.
- [ ] Terms of service published.
- [ ] Privacy policy published, covering what Toran stores (see
      [PRIVACY.md](PRIVACY.md)).
- [ ] An incident response plan exists.
- [ ] Dependency updates applied on a schedule.
- [ ] A process exists for handling legal requests.

---

## Operating notes

**Scaling the web tier.** Stateless - run as many replicas as you like. Requires
`TORAN_RATE_LIMIT_BACKEND=postgres`.

**Scaling the worker.** Run several. `FOR UPDATE SKIP LOCKED` partitions the
queue safely, and maintenance jobs are deduplicated per time bucket, so replicas
do not duplicate work.

**Zero-downtime upgrades.** Migrations are forward-only and additive, so an old
and a new version can run simultaneously during a rolling deploy.

**Watching for trouble.**

```bash
docker compose exec worker node apps/worker/dist/cli/main.js jobs --failed
docker compose logs -f worker | grep '"level":"error"'
curl -fsS https://toran.example.com/api/ready | jq
```
