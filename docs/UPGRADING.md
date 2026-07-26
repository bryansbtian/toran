<!-- SPDX-License-Identifier: AGPL-3.0-only -->

# Upgrading Toran

## Before you start

```bash
# 1. Back up. Always.
/usr/local/bin/toran-backup

# 2. Read what changed.
git log --oneline HEAD..origin/main
# and CHANGELOG.md
```

## Standard upgrade

```bash
cd /opt/toran
git pull
docker compose build
docker compose up -d
docker compose ps
curl -fsS http://127.0.0.1:3000/api/ready | jq
```

`toran-migrate` runs pending migrations before the worker starts, so ordering is
handled for you.

## Migration policy

Toran migrations are **forward-only and additive**. Toran never runs a
destructive statement automatically — no dropped columns, no dropped tables, no
type changes that lose data.

This means an old and a new version can run at the same time, so rolling
deployments and zero-downtime upgrades work. It also means the schema
accumulates unused columns; removing one is a deliberate, reviewed, separately
announced migration.

**Downgrades are not supported.** If you need to roll back, restore the database
backup you took before upgrading.

## Applying migrations manually

```bash
# Compose
docker compose run --rm migrate

# From a checkout
npm run db:migrate
```

Safe to run repeatedly; already-applied migrations are skipped.

## Zero-downtime upgrade

```bash
git pull
docker compose build

# Migrate first. Additive migrations are safe against the running old version.
docker compose run --rm migrate

# Then replace the services.
docker compose up -d --no-deps web
docker compose up -d --no-deps worker
```

## Verifying an upgrade

```bash
curl -fsS http://127.0.0.1:3000/api/health
curl -fsS http://127.0.0.1:3000/api/ready | jq

# The worker should be claiming jobs again.
docker compose logs --tail=50 worker

# No new dead jobs.
docker compose exec worker node apps/worker/dist/cli/main.js jobs --failed
```

Then actually upload a file, open the link in a private window, and download it.
Health checks do not prove the product works.

## If an upgrade fails

```bash
# Roll the images back.
git checkout <previous-tag>
docker compose build
docker compose up -d

# If a migration ran and the new schema is incompatible, restore the backup:
docker compose stop web worker
docker compose exec -T postgres psql -U toran -d postgres \
  -c "DROP DATABASE toran;" -c "CREATE DATABASE toran OWNER toran;"
docker compose exec -T postgres pg_restore -U toran -d toran --no-owner < backup.dump
docker compose up -d
```

## Version-specific notes

### Upgrading to 0.1.0

First release. Nothing to migrate from.

<!--
Add a section per release that needs operator action. For example:

### Upgrading to 0.2.0

- `TORAN_FOO` replaces `TORAN_BAR`. Update `.env` before upgrading; Toran will
  refuse to start otherwise.
- The `files.checksum` column now stores a base64 digest rather than hex. The
  migration converts existing rows.
-->

## Pre-1.0 expectations

While the major version is `0`, minor releases may contain breaking changes.
Read `CHANGELOG.md` before every upgrade. Once Toran reaches 1.0, semantic
versioning applies normally.
