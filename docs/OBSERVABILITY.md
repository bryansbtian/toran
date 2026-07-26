<!-- SPDX-License-Identifier: AGPL-3.0-only -->

# Observability

## Logging

Toran writes structured JSON, one line per event, to stdout. No ANSI codes, no
multi-line output, nothing that needs a parser you have to write.

```json
{
  "level": "info",
  "time": "2026-07-26T12:00:00.000Z",
  "service": "toran-web",
  "requestId": "L3xK9mQ2pRt7",
  "route": "POST /api/uploads",
  "method": "POST",
  "statusCode": 201,
  "durationMs": 42,
  "fileId": "3b2e1d0c-...",
  "msg": "upload session created"
}
```

### Safe fields

`requestId`, `route`, `method`, `statusCode`, `durationMs`, `jobId`, `jobType`,
`fileId`, `shareLinkId`, `errorCategory`, `retryCount`, `workerId`.

### Redaction

Two independent layers strip anything sensitive:

1. **By key name** — `token`, `password`, `secret`, `accessKey`, `authorization`,
   `cookie`, `presignedUrl`, `databaseUrl` and their case/underscore/dash
   variants.
2. **By value pattern** — anything containing `X-Amz-Signature`, a connection
   string with inline credentials, or a PHC-encoded Argon2 hash.

So a mistake at a call site degrades to `[redacted]` rather than a leak. Unit
tests assert that a raw token and a presigned URL never survive a log call.

**Never logged, ever:** raw share tokens, passwords, storage credentials,
presigned URLs, authorization headers, full database URLs.

### Levels

Set with `TORAN_LOG_LEVEL`. Use `info` in production; `debug` is useful when
diagnosing an upload problem and is safe (redaction applies at every level).

### Correlating a user report

Every response carries `X-Request-Id`. Ask the user for it:

```bash
docker compose logs web | grep 'L3xK9mQ2pRt7'
```

## Health endpoints

| Endpoint                    | Purpose                                      | Touches dependencies |
| --------------------------- | -------------------------------------------- | -------------------- |
| `GET /api/health`           | Liveness — should this process be restarted? | No                   |
| `GET /api/ready`            | Readiness — should it receive traffic?       | Yes                  |
| `GET :3001/health` (worker) | Worker liveness                              | No                   |
| `GET :3001/ready` (worker)  | Worker database connectivity                 | Yes                  |

`/api/health` deliberately checks nothing external. A database blip should not
cause a restart loop.

`/api/ready` reports per-dependency status and returns `503` when degraded.
Failure detail is coarse (`"unreachable"`) to avoid leaking infrastructure
topology; the specific reason is logged.

## Metrics

Toran records counters and durations through a small in-process recorder:

| Metric                     | Attributes            |
| -------------------------- | --------------------- |
| `toran.http.request`       | route, method, status |
| `toran.http.duration_ms`   | route                 |
| `toran.job.completed`      | type                  |
| `toran.job.failed`         | type, permanent       |
| `toran.job.duration_ms`    | type                  |
| `toran.ratelimit.rejected` | scope                 |

The MVP does not expose a `/metrics` endpoint. Until it does, the log stream is
the metrics source — every request and job logs its outcome and duration, which
is enough to build the dashboards below with any log-based aggregation.

A Prometheus endpoint is on the roadmap.

## OpenTelemetry

Toran depends only on `@opentelemetry/api`, never on an SDK. With no provider
registered the API is a no-op, so instrumentation costs nothing by default.

Spans are emitted for every job execution (`toran.job.<type>`) with attributes
for the job id and attempt number.

To collect traces, register a provider in your own bootstrap:

```bash
npm install @opentelemetry/sdk-node @opentelemetry/auto-instrumentations-node \
            @opentelemetry/exporter-trace-otlp-http
```

```javascript
// otel.mjs — load with: node --import ./otel.mjs apps/worker/dist/main.js
import { NodeSDK } from '@opentelemetry/sdk-node';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { getNodeAutoInstrumentations } from '@opentelemetry/auto-instrumentations-node';

new NodeSDK({
  serviceName: process.env.OTEL_SERVICE_NAME ?? 'toran',
  traceExporter: new OTLPTraceExporter({
    url: process.env.OTEL_EXPORTER_OTLP_ENDPOINT,
  }),
  instrumentations: [getNodeAutoInstrumentations()],
}).start();
```

Toran's spans then flow to your collector alongside automatic HTTP and
PostgreSQL instrumentation, with no change to Toran itself.

## What to alert on

Ordered by how much it matters.

| Alert                         | Condition                                 | Why                                                            |
| ----------------------------- | ----------------------------------------- | -------------------------------------------------------------- |
| Readiness failing             | `/api/ready` non-200 for 2 minutes        | Users cannot upload or download                                |
| Worker down                   | Worker health failing for 5 minutes       | **Nothing becomes downloadable** — files pile up in `scanning` |
| Dead jobs accumulating        | `jobs --failed` count rising              | Something is systematically failing                            |
| Scanner unreachable           | `scanner error` in worker logs, sustained | Same effect as a dead worker                                   |
| ClamAV signatures stale       | Age > 48 hours                            | Scanning is running but not catching anything new              |
| Storage errors                | `STORAGE_UNAVAILABLE` rate rising         | Uploads and downloads failing                                  |
| Disk usage                    | > 80% on the storage volume               | Uploads will start failing                                     |
| Error rate                    | 5xx rate above baseline                   |                                                                |
| Rate-limit rejections spiking | Sustained `toran.ratelimit.rejected`      | Abuse, or limits set too low                                   |

The worker one is easy to miss and the most damaging: the web app stays green
while every new upload silently fails to become available.

## Dashboard suggestions

**Health.** Readiness status, error rate by code, p50/p95/p99 request duration,
worker liveness.

**Throughput.** Uploads started vs completed (the gap is failed browser→storage
transfers), downloads served, bytes stored.

**Queue.** Jobs by status, job duration by type, retry rate, dead-job count,
oldest queued job age.

**Scanning.** Clean vs blocked vs failed verdicts, scan duration, signature age.

**Abuse.** Rate-limit rejections by scope, quota rejections, abuse reports
received.

## Log shipping

```yaml
# docker-compose.override.yml
services:
  web:
    logging:
      driver: gelf
      options:
        gelf-address: 'udp://logs.example.com:12201'
        tag: toran-web
```

Because output is already JSON, most collectors parse it without configuration.

**Set a retention period.** Logs contain database ids, timing and rotating
client identifiers — personal data in most jurisdictions. See
[PRIVACY.md](PRIVACY.md).
