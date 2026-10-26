# Observability

How to see what PalCert is doing, and what it deliberately refuses to show you.

Phase 20 Checkpoint 1 recorded "no metrics, no tracing, no alert hooks" as a
release blocker (F-005): queue depth, job age and the terminal `DEAD` state
were reachable only by querying the database by hand, and nothing could be
alerted on. This document describes what Checkpoint 3 put in its place.

## The shape of it

Three signals, in descending order of how much you should rely on them:

| Signal | Where | What it answers |
| --- | --- | --- |
| **Metrics** | `/metrics` on every PalCert process | Is it healthy? Is it keeping up? Is anything stuck? |
| **Logs** | stdout, JSON, one object per line | What happened to *this* request, job or delivery? |
| **Health probes** | `/health/live`, `/health/ready` | Should this instance be restarted? Should it get traffic? |

They are kept separate on purpose. Readiness is a scheduling decision, not a
monitoring surface: it answers one yes/no question for an orchestrator and it
does not grow a metrics payload. Metrics are aggregates and never carry an
identifier. Logs are where identifiers live, behind the access controls a log
system has.

## Vendor neutrality

PalCert emits the **Prometheus text exposition format** and nothing else. It
opens no outbound telemetry connection, embeds no vendor SDK, and requires no
hosted service to operate. Prometheus, VictoriaMetrics, Grafana Agent, the
OpenTelemetry Collector and Datadog's OpenMetrics check all read this format
directly; a deployment points whatever it already runs at the endpoint.

The alert rules ship as a standard Prometheus rule file
(`ops/alerts/palcert.rules.yml`), which every one of those also evaluates.
The dashboard is a written specification rather than a vendor export, for the
same reason — see `docs/operations/dashboards.md`.

### Distributed tracing

Not in v1, deliberately. Full OpenTelemetry tracing across the API, the
worker, the document engine and PostgreSQL would be a telemetry-platform
migration — a new dependency in four runtimes, a collector to run, sampling
to tune and context propagation to get right through BullMQ and Prisma — for
a system whose slow paths are already legible from the job ledger and the
correlation identifiers below. Recorded as post-v1 work (P-008), not as a
blocker. What tracing would have given operationally on day one — "which
request produced this job, and what did the job do?" — the correlation model
below already answers.

## Endpoints

| Process | Scrape URL | Port |
| --- | --- | --- |
| API | `http://api:4000/metrics` | 4000 |
| Worker | `http://worker:4100/metrics` | 4100 |
| Document engine | `http://document-engine:8000/metrics` | 8000 |
| Web | `http://web:3000/metrics` | 3000 |

All four sit outside the versioned API prefix: a scrape URL must stay stable
across API versions, and none of them is part of the contract PalCert
publishes. The API's is excluded from the OpenAPI document.

### Exposure

Telemetry is internal. **Two independent controls, and the first one is
topology.**

1. **The reverse proxy has no route to `/metrics`.** It returns 404 for
   `/metrics` and anything beneath it, so an external request never reaches a
   PalCert process. CI proves this against the running release stack rather
   than asserting it in a unit test, and `release-topology.spec.ts` fails if
   the proxy configuration loses the rule.
2. **`METRICS_TOKEN`**, optional, for a deployment whose internal network is
   shared. When set, a scrape must present `Authorization: Bearer <token>`;
   the comparison is constant-time. When unset the endpoint sits at the same
   trust level as `/health` — a deliberate choice a deployment makes, not a
   default pretending to be security.

`METRICS_ENABLED=false` turns the endpoint off entirely. It then answers 404,
not 403: a deployment that has turned telemetry off should look like one that
never had it.

## Cardinality

This is the first design constraint, not an afterthought. A metric labelled
by an identifier is a memory leak with a dashboard: one timeseries per
document, per user, per organization, growing forever, and getting slower to
scrape as it grows.

**Never used as a label, anywhere:** a raw URL containing an id, a user id, an
organization id, a document id, an email address, an API client id, a webhook
URL, a payment reference, an exception message.

**Used instead:** normalized route templates (`/api/v1/documents/:documentId`,
never the requested path), HTTP methods, status *classes* (`2xx`, five values
rather than sixty), and database enums — job type (20), job status (6),
delivery status (6), notification channel, analyzer name, issuance status.

A request that matched no route is labelled `<unmatched>`, so a scanner
probing a hundred paths mints one timeseries rather than a hundred. There is
an e2e test that probes 25 distinct URLs and asserts at most one new series
appears.

## What each process reports

### API and worker

| Metric | Type | Labels |
| --- | --- | --- |
| `palcert_build_info` | gauge | `service`, `version`, `commit`, `environment` |
| `palcert_http_requests_total` | counter | `route`, `method`, `status_class` |
| `palcert_http_request_duration_seconds` | histogram | `route`, `method` |
| `palcert_http_requests_in_flight` | gauge | — |
| `palcert_job_executions_total` | counter | `job_type`, `outcome` |
| `palcert_job_duration_seconds` | histogram | `job_type` |
| `palcert_api_client_auth_total` | counter | `outcome` |
| `palcert_api_client_throttled_total` | counter | `window` |
| `palcert_storage_operations_total` | counter | `operation`, `outcome` |
| `palcert_security_events_total` | counter | `type` |
| `palcert_metrics_collector_up` | gauge | — |
| `palcert_metrics_collector_duration_seconds` | histogram | — |
| plus Node process metrics (heap, event-loop lag, GC, file descriptors) | | |

`palcert_storage_operations_total` separates `succeeded`, `not_found`,
`refused` (a 4xx PalCert asked for) and `unavailable` (the transport or a
5xx). Only the last is an outage, and counting all four together would hide
it. Bucket names and object keys are absent by design: an object key
identifies a document, and a document is somebody's unpublished work.

`palcert_security_events_total` is labelled by the `SecurityEventType` enum —
about forty values — and nothing else. `LOGIN_FAILED` rising sharply is the
alertable fact; *whose* login failed is a question the security-event table
answers behind the database's access controls.

`palcert_api_client_auth_total` is split by outcome — `succeeded` or
`refused` — and nothing finer. Phase 19 refuses every credential failure
identically on the wire precisely so a caller cannot distinguish "no such
client" from "wrong secret"; splitting the metric by reason would rebuild
that oracle for anyone who can read the endpoint. The reason is logged.

### Database-authoritative gauges

These come from the job ledger, not from counting in a process. That matters
for one specific reason: restarting the worker is the first thing somebody
tries when jobs are failing, and a process-local counter would zero exactly
then — the `DEAD` count would clear itself and the alert would go quiet.

| Metric | Labels |
| --- | --- |
| `palcert_jobs` | `job_type`, `status` |
| `palcert_jobs_queue_depth` | `job_type` |
| `palcert_jobs_oldest_queued_age_seconds` | `job_type` |
| `palcert_jobs_oldest_running_age_seconds` | `job_type` |
| `palcert_jobs_dead` | `job_type` |
| `palcert_jobs_retrying` | `job_type` |
| `palcert_jobs_expired_leases` | — |
| `palcert_notification_deliveries` | `channel`, `status` |
| `palcert_notification_oldest_pending_age_seconds` | `channel` |
| `palcert_webhook_deliveries` | `status` |
| `palcert_webhook_oldest_pending_age_seconds` | — |
| `palcert_document_analyses` | `analyzer`, `status` |
| `palcert_certificates` | `issuance_status` |
| `palcert_balance_topups` | `status` |
| `palcert_api_clients` | `status` |

They are read through two `SECURITY DEFINER` functions,
`app_operational_counts()` and `app_operational_ages()`, added by the
migration `20260925000000_phase20_operational_metrics`.

Reading the tables directly from the request-path role does not work, and the
way it fails is the dangerous part. `webhook_deliveries` carries no `SELECT`
grant for that role at all, so the query errors — which at least announces
itself. Four of the others (`document_analyses`, `compliance_certificates`,
`balance_topups`, `api_clients`) have row-level security FORCEd, so the same
aggregate outside a tenant context returns **zero rows** and the gauge
reports a confident, wrong `0`. A dashboard showing no backlog because it
cannot see the backlog is worse than no dashboard.

What the functions widen is deliberately narrow: counts and timestamps only,
grouped by closed sets, read-only, granted `EXECUTE` rather than table
`SELECT`. No row, identifier, payload, amount or address leaves them, and the
app role's table privileges are exactly what they were. This is the same
mechanism Phase 17 uses for system-authority reads.

**`palcert_metrics_collector_up` exists because "no data" and "no backlog"
must not look the same.** If the collector cannot read the database, it
reports `0` and the scrape still succeeds, rather than the gauges silently
vanishing. There is a page-severity alert on it, because every job, delivery,
certificate and payment alert is blind while it is firing.

### Document engine

| Metric | Type | Labels |
| --- | --- | --- |
| `palcert_build_info` | gauge | `service`, `version`, `commit`, `environment` |
| `palcert_http_requests_total` | counter | `route`, `method`, `status_class` |
| `palcert_http_request_duration_seconds` | histogram | `route`, `method` |
| `palcert_analyses_total` | counter | `analyzer`, `outcome` |
| `palcert_analysis_duration_seconds` | histogram | `analyzer` |
| `palcert_analysis_document_bytes` | histogram | `analyzer` |

`outcome` is one of `succeeded`, `rejected`, `too_large`, `timed_out`,
`failed`. `rejected` and `failed` are kept apart deliberately: a document
PalCert read and refused on its own merits is not the same event as the
analyzer going wrong. A pile of malformed uploads is a Tuesday; a pile of
analyzer errors is an incident, and only the second should page.

**Nothing about a document reaches telemetry** — no filename, document id,
title or extracted text. The engine handles other people's unpublished work,
and a metric is the most widely copied and least access-controlled thing a
service emits.

### Web

Process metrics and `palcert_build_info`, and nothing else. The web tier is a
rendering server: everything worth counting about compliance, jobs or
payments already has an authority in the API and the job ledger, and counting
it again here would be a second set of numbers to reconcile whenever they
disagreed. What only this process can report is its own runtime — heap,
event-loop lag, handles, GC — which is what answers "why did the site get
slow?" when the API is fine.

## Structured logging

One JSON object per line on stdout. Every line carries:

| Field | Meaning |
| --- | --- |
| `time` | epoch milliseconds |
| `level` | pino numeric severity |
| `service`, `version`, `env` | which process wrote it |
| `commit` | which build wrote it |
| `req.id` | the correlation id (see below) |

`commit` matters most exactly when a rollout is half finished: without it, a
log line from a partially completed deploy cannot be attributed to the
version that produced it.

Health probes and scrapes log at `debug`, because at `info` they would be
most of the volume and none of the information.

### What logs never contain

Redaction happens in the logger, not at the call site, so no call site can
forget it. Covered at the top level and one level in:

- passwords (`password`, `newPassword`, `currentPassword`)
- session and bearer material (`accessToken`, `refreshToken`,
  `Authorization`, `Cookie`, `Set-Cookie`, `x-api-key`)
- API client secrets (`clientSecret`, `secretVerifier`,
  `revealedSecretCiphertext`) and any `pcsk_` prefix found in a URL
- webhook signing secrets (`signingSecret`, `webhookSecret`,
  `secretFingerprint`)
- payment credentials (`stripeSecretKey`, `STRIPE_SECRET_KEY`,
  `paymentSecret`, `cardNumber`)
- document content and AI payloads (`prompt`, `contextBundle`,
  `providerResponse`, `documentText`, `fileContent`, the bilingual
  explanation and summary fields)
- capability values: a certificate verification code, including the one that
  travels as a path segment on the public verification route — an access log
  is exactly the kind of thing that gets shipped to a third party, kept for a
  year and read by people who were never shown the certificate
- presigned storage URLs, which are bearer credentials for one object

`log-redaction.spec.ts` asserts each of these against the *real* pino
serializer output, with distinctive values, so the test proves what lands on
disk rather than that a configuration array matches itself. Writing it found
a real gap: a top-level `password` field was not covered, only `*.password`.

## Correlation

Identifiers that already exist, reused. Nothing new was minted for
observability.

```
HTTP request            req.id            (x-request-id, echoed on the response)
      │                                    taken from the caller when supplied,
      │                                    so it spans services
      ▼
database write          resourceType/resourceId
      │                                    what the request created
      ▼
queued job              jobId, idempotencyKey = {jobType}:{resourceId}
      │                                    the queue carries only the row id
      ▼
worker execution        "Job attempt started" / "Job attempt finished"
      │                 { jobId, jobType, resourceType, resourceId,
      │                   attempt, workerId, outcome }
      ▼
downstream delivery     deliveryId on the notification and webhook attempt lines
```

To follow one piece of work end to end: find the request line by `req.id`,
take the resource it created, and search the worker's job lines for that
`resourceId`. `attempt` distinguishes a retry from a first try, which is the
difference between "this failed once" and "this is failing".

The document engine echoes `x-request-id` back and stamps it on every line it
writes, so an analysis is joinable to the worker execution that requested it.

Deliberately absent from the job lines: the owner, the organization, the
document name and the payload. The ledger row has them, behind the database's
access controls.

## Alerting

See `docs/operations/alerting.md` for the catalogue, the severities, and —
for every threshold that depends on how much traffic PalCert actually takes —
what it assumes and what to re-derive once real traffic exists.

## Overhead

Measured rather than assumed, in the checkpoint report. In summary: the HTTP
middleware adds one `hrtime` pair and two label lookups per request; the
database collectors run once per scrape (not per request) and are timed into
`palcert_metrics_collector_duration_seconds`, so the cost of observing is
itself observable. The registry's size is bounded by construction — see
**Cardinality** — and an e2e test proves it stays bounded under a path
scanner.
