<!-- SPDX-License-Identifier: MIT -->

# ClamAV in Toran

Toran runs ClamAV as a standalone container and talks to `clamd` over TCP using
the `INSTREAM` protocol. The client is implemented directly in
`apps/worker/src/scanning/clamav.ts` - the protocol is a handful of commands,
and keeping it dependency-free matters in the one component that handles hostile
input.

No custom image is needed. The upstream `clamav/clamav` image is used as-is;
`clamd.conf` in this directory documents the settings Toran relies on and lets
you override them if you need to.

## How scanning works

1. The worker claims a `scan_file` job.
2. It opens a read stream for the object from storage.
3. It sends `zINSTREAM`, then length-prefixed chunks, then a zero-length
   terminator.
4. `clamd` replies with `stream: OK`, `stream: <SIGNATURE> FOUND`, or an error.
5. The file becomes `ready`, `blocked`, or `failed`.

**Scanning fails closed.** A file becomes `ready` only on an explicit clean
verdict. A transient error leaves it in `scanning` and the job retries with
backoff; a permanent error marks it `failed`. Neither ever produces a
downloadable file.

## Resource requirements

ClamAV loads its whole signature database into memory.

|        | Minimum | Recommended |
| ------ | ------- | ----------- |
| Memory | 1.5 GB  | 3 GB        |
| Disk   | 1 GB    | 2 GB        |
| CPU    | 1 core  | 2 cores     |

Below the minimum, `clamd` is killed by the OOM reaper during startup and the
container restarts in a loop. If ClamAV never becomes healthy, check memory
first.

## Signature updates

`freshclam` runs inside the container and updates automatically. The production
Compose file sets `FRESHCLAM_CHECKS=2` (twice daily).

**Stale signatures are worse than no signatures**, because they give false
confidence. Monitor signature age:

```bash
docker compose exec clamav sh -c 'ls -l --time-style=+%F\ %T /var/lib/clamav/*.c[vl]d'
```

Alert if the newest file is more than 48 hours old.

The `clamav-data` volume persists the database, so a container restart does not
re-download several hundred megabytes.

## Verifying it works

The EICAR test string is a harmless file every scanner detects by agreement.

```bash
# Should report FOUND.
docker compose exec clamav sh -c \
  'printf "%s" "X5O!P%@AP[4\\PZX54(P^)7CC)7}\$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!\$H+H*" \
   | clamdscan -'
```

End to end, upload a file containing that string through the UI. It should reach
`scanning`, then become blocked, and the link should stop working.

## Health

```bash
docker compose exec clamav clamdcheck.sh
docker compose ps clamav
docker compose logs -f clamav
```

`clamdcheck.sh` is what the Compose health check runs. The `start_period` is
generous (300 s in production) because the first boot downloads the database.

## Tuning

Override settings by mounting `clamd.conf`:

```yaml
services:
  clamav:
    volumes:
      - ./docker/clamav/clamd.conf:/etc/clamav/clamd.conf:ro
      - clamav-data:/var/lib/clamav
```

Two limits matter to Toran:

- **`MaxScanSize` / `MaxFileSize`** must be at least
  `TORAN_MAX_FILE_SIZE_BYTES`, or large uploads will fail to scan and therefore
  never become available. `@toran/config` refuses to start when
  `CLAMAV_MAX_SCAN_BYTES` is below `TORAN_MAX_FILE_SIZE_BYTES`, which catches
  the Toran side of this mismatch.
- **`MaxRecursion` / `MaxFiles`** bound archive expansion. The defaults protect
  against zip bombs; raising them trades safety for coverage.

## Disabling scanning

`TORAN_SCANNING_ENABLED=false` skips scanning entirely and marks uploads `ready`
immediately.

**This is a development-only setting.** Toran refuses to start in production
with it disabled, and the UI states plainly that scanning is off.

## What ClamAV does not do

ClamAV detects **known signatures**. It will not catch a novel payload, a
targeted attack, an encrypted archive, a malicious document that only executes
on open, or anything created since the last signature update.

Toran says this on the download page, and you should say it to your users too.
Scanning meaningfully reduces the odds of hosting known malware. It does not
make files safe.
