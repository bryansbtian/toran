<!-- SPDX-License-Identifier: MIT -->

# Backup and recovery

## The one thing to understand

**Backing up PostgreSQL alone is not enough.** Toran's state is split:

- **PostgreSQL** holds metadata - which files each link serves, in what order,
  the link's expiry and password hash, and each file's own download budget and
  spent count.
- **Object storage** holds the actual file bytes.

Restore only the database and you get links to objects that no longer exist.
Restore only storage and you get objects nobody can reach. You need both, plus
the configuration that ties them together.

## What to back up

| Asset              | Contains                            | Frequency              | Retention                     |
| ------------------ | ----------------------------------- | ---------------------- | ----------------------------- |
| PostgreSQL         | Metadata, links, jobs, reports      | Daily minimum          | 30 days                       |
| Object storage     | File contents                       | Continuous replication | Match link lifetime           |
| `.env` / secrets   | Credentials, `TORAN_SECRET_KEY`     | On change              | Indefinite, encrypted         |
| `TORAN_SECRET_KEY` | Signs grants and client identifiers | On change              | Indefinite, separate location |

Losing `TORAN_SECRET_KEY` invalidates every outstanding password-authorisation
grant (users re-enter passwords - survivable) and resets every anonymous quota
identifier. **Back it up somewhere other than the database backup**, so one
compromise does not yield both.

---

## PostgreSQL

### Docker Compose

```bash
docker compose exec -T postgres \
  pg_dump -U toran -d toran --format=custom --compress=9 \
  > "toran-$(date +%F).dump"
```

Automate it:

```bash
#!/usr/bin/env bash
# /usr/local/bin/toran-backup
set -euo pipefail

BACKUP_DIR=/var/backups/toran
RETENTION_DAYS=30
mkdir -p "$BACKUP_DIR"

stamp=$(date +%F-%H%M)
docker compose -f /opt/toran/docker-compose.yml exec -T postgres \
  pg_dump -U toran -d toran --format=custom --compress=9 \
  > "$BACKUP_DIR/toran-$stamp.dump"

# Verify the dump is readable before trusting it.
pg_restore --list "$BACKUP_DIR/toran-$stamp.dump" > /dev/null

find "$BACKUP_DIR" -name 'toran-*.dump' -mtime "+$RETENTION_DAYS" -delete
echo "backup complete: toran-$stamp.dump"
```

```cron
0 3 * * * /usr/local/bin/toran-backup >> /var/log/toran-backup.log 2>&1
```

The `pg_restore --list` step matters: a backup you have never read is a backup
you do not have.

### Point-in-time recovery

For anything you would be upset to lose, enable WAL archiving or use a managed
PostgreSQL with PITR. A nightly dump means up to 24 hours of loss.

### Restore

```bash
docker compose stop web worker
docker compose exec -T postgres psql -U toran -d postgres \
  -c "DROP DATABASE IF EXISTS toran;" -c "CREATE DATABASE toran OWNER toran;"
docker compose exec -T postgres pg_restore -U toran -d toran --no-owner < toran-2026-07-25.dump
docker compose up -d
curl -fsS http://127.0.0.1:3000/api/ready
```

---

## Object storage

### MinIO

Continuous mirroring to a second location:

```bash
mc alias set primary http://localhost:9000 "$MINIO_ROOT_USER" "$MINIO_ROOT_PASSWORD"
mc alias set backup  https://s3.example.com "$BACKUP_KEY" "$BACKUP_SECRET"

# One-off
mc mirror --overwrite primary/toran backup/toran-backup

# Continuous
mc mirror --watch --overwrite primary/toran backup/toran-backup
```

Enable versioning so a deletion is recoverable:

```bash
mc version enable primary/toran
```

### AWS S3 and compatible

Use bucket replication (cross-region if you can) plus versioning. Add a
lifecycle rule to expire noncurrent versions after your retention window so
versioning does not grow without bound.

### Restore

```bash
mc mirror --overwrite backup/toran-backup primary/toran
```

---

## Configuration and secrets

Do **not** back up `.env` to the same place as your database dumps.

```bash
# Encrypted, in a separate location.
age -r "$AGE_PUBLIC_KEY" -o toran-env-$(date +%F).age /opt/toran/.env
```

Better: keep secrets in a secret manager (Vault, AWS Secrets Manager, 1Password)
and treat `.env` as generated.

---

## Consistency

Database and storage backups are taken at slightly different moments, so a
restore can be inconsistent in two ways:

**Metadata without an object.** A file was uploaded after the storage snapshot.
The `reconcile_storage` job detects this and marks the file `failed`, so that
file reports unavailable rather than erroring. A link serving several files
keeps serving the ones whose objects did restore - each file is judged on its
own - so a partial restore degrades a link rather than breaking it outright.

**Object without metadata.** A file was deleted after the storage snapshot. The
object is orphaned; it is not reachable (keys are random and never listed), but
it consumes space. Run reconciliation after a restore:

```bash
docker compose exec worker node apps/worker/dist/cli/main.js cleanup --yes
```

To minimise the window, snapshot the database **first**, then storage. That
biases toward orphaned objects (harmless) over dangling metadata (visible).

---

## Testing your backups

Quarterly, on a staging host:

1. Restore the database dump into a fresh instance.
2. Restore the storage bucket.
3. Start Toran against them.
4. `curl /api/ready` - everything green.
5. Open a share link created before the backup, and download the file.
6. Run reconciliation and check what it reports.
7. Write down how long the whole thing took. That number is your RTO.

A backup procedure that has never been executed is a hypothesis.

---

## Disaster recovery targets

Set these deliberately for your deployment:

| Metric | Question                                                          |
| ------ | ----------------------------------------------------------------- |
| RPO    | How much data can you afford to lose? (Nightly dump = up to 24 h) |
| RTO    | How long may recovery take? (Measure it, do not guess)            |

Reference procedure for a total host loss:

1. Provision a new host with Docker.
2. Restore `.env` from your secret store.
3. `git clone` and `docker compose up -d postgres minio`.
4. Restore the database dump.
5. Restore the storage bucket.
6. `docker compose up -d`.
7. Verify `/api/ready`.
8. Run `cleanup --yes` to reconcile.
9. Update DNS.
