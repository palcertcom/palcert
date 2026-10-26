# Dashboard specification

A written specification rather than a vendor export. PalCert does not depend
on Grafana, Datadog or anything else, and shipping a `dashboard.json` for one
of them would quietly make it the supported product. Every panel below is one
PromQL expression against metrics PalCert emits; building it takes minutes in
any tool that reads Prometheus.

A local Prometheus and Grafana may be used for testing. Neither is part of
the release stack.

## 1. Service health — "is anything broken right now?"

The first screen. Six panels, all of which should be flat and boring.

| Panel | Type | Expression |
| --- | --- | --- |
| Instances up | stat | `count(up{job=~"palcert-.*"} == 1) by (job)` |
| Request rate | graph | `sum by (job) (rate(palcert_http_requests_total[5m]))` |
| Error share | graph | `sum by (job) (rate(palcert_http_requests_total{status_class="5xx"}[5m])) / sum by (job) (rate(palcert_http_requests_total[5m]))` |
| Latency p50 / p95 / p99 | graph | `histogram_quantile(0.95, sum by (job, le) (rate(palcert_http_request_duration_seconds_bucket[5m])))` |
| In flight | graph | `sum by (job) (palcert_http_requests_in_flight)` |
| Telemetry healthy | stat | `min(palcert_metrics_collector_up)` |

The last panel is not decoration. Every job and delivery panel on the next
screen goes to zero if the collector cannot read the database, and without
this one they would read as "nothing to do".

## 2. Work — "is it keeping up?"

| Panel | Type | Expression |
| --- | --- | --- |
| Queue depth by type | graph | `palcert_jobs_queue_depth` |
| Oldest waiting job | graph | `palcert_jobs_oldest_queued_age_seconds` |
| Oldest running job | graph | `palcert_jobs_oldest_running_age_seconds` |
| **DEAD jobs** | table | `palcert_jobs_dead > 0` |
| Retrying | graph | `palcert_jobs_retrying` |
| Lapsed leases | graph | `palcert_jobs_expired_leases` |
| Throughput by outcome | graph | `sum by (job_type, outcome) (rate(palcert_job_executions_total[5m]))` |
| Job duration p95 | graph | `histogram_quantile(0.95, sum by (job_type, le) (rate(palcert_job_duration_seconds_bucket[10m])))` |

Depth and age are both shown because they answer different questions: a small
queue that never drains is worse than a large one that does.

The DEAD panel is a table rather than a graph and sits in the middle of the
screen, because it is the one number nobody should have to look for. It does
not clear on a restart — it is read from the ledger.

## 3. Delivery — "is anyone hearing from us?"

| Panel | Type | Expression |
| --- | --- | --- |
| Notifications by status | graph | `sum by (status) (palcert_notification_deliveries)` |
| Oldest unsent notification | stat | `max(palcert_notification_oldest_pending_age_seconds)` |
| Webhooks by status | graph | `sum by (status) (palcert_webhook_deliveries)` |
| Oldest undelivered webhook | stat | `palcert_webhook_oldest_pending_age_seconds` |

No panel here can be broken down by recipient, endpoint or organization, and
that is the design rather than a gap. When the question becomes "whose?", the
answer is a database query, not a dashboard.

## 4. Documents — "is the analysis working?"

| Panel | Type | Expression |
| --- | --- | --- |
| Analyses by outcome | graph | `sum by (analyzer, outcome) (rate(palcert_analyses_total[10m]))` |
| Analyzer failure share | graph | `sum by (analyzer) (rate(palcert_analyses_total{outcome="failed"}[10m])) / sum by (analyzer) (rate(palcert_analyses_total[10m]))` |
| Analysis duration p95 | graph | `histogram_quantile(0.95, sum by (analyzer, le) (rate(palcert_analysis_duration_seconds_bucket[10m])))` |
| Document size distribution | heatmap | `sum by (analyzer, le) (rate(palcert_analysis_document_bytes_bucket[1h]))` |
| Stored analyses by status | graph | `sum by (status) (palcert_document_analyses)` |

Keep `rejected` and `failed` visually distinct. A pile of malformed uploads
is a Tuesday; a pile of analyzer errors is an incident.

## 5. Business outcomes — "is the product doing its job?"

| Panel | Type | Expression |
| --- | --- | --- |
| Certificates by issuance status | graph | `palcert_certificates` |
| Certificates stuck | stat | `sum(palcert_certificates{issuance_status=~"PENDING\|ISSUING"})` |
| Top-ups by status | graph | `palcert_balance_topups` |
| API clients by status | stat | `palcert_api_clients` |

**No money on this screen, ever.** These are operational outcome counts.
Amounts, currencies, provider references and anything that could describe one
customer's spending stay out of telemetry entirely; the ledger and
reconciliation remain the authority on what happened to money.

## 6. Platform and release

| Panel | Type | Expression |
| --- | --- | --- |
| Builds serving | table | `palcert_build_info` |
| Distinct commits | stat | `count(count by (commit) (palcert_build_info))` |
| Resident memory | graph | `palcert_process_resident_memory_bytes` |
| Heap used | graph | `palcert_nodejs_heap_size_used_bytes` |
| Event-loop lag p99 | graph | `palcert_nodejs_eventloop_lag_p99_seconds` |
| Scrape cost | graph | `histogram_quantile(0.95, sum by (le) (rate(palcert_metrics_collector_duration_seconds_bucket[10m])))` |
| API client auth outcomes | graph | `sum by (outcome) (rate(palcert_api_client_auth_total[10m]))` |
| Throttled requests | graph | `sum by (window) (rate(palcert_api_client_throttled_total[10m]))` |

"Distinct commits" should be 1. More than that for longer than a rollout
takes means two versions are answering customers.

"Scrape cost" is there so the cost of observing is itself observed. If it
climbs alongside memory, suspect cardinality before suspecting a leak
elsewhere.

## What is deliberately not here

- **Per-user, per-organization or per-document panels.** They would require
  labels that turn the registry into a memory leak, and they would put
  customer identities on a screen that gets shared in incident channels.
- **A revenue panel.** See above.
- **A recipient or endpoint breakdown for deliveries.** See above.
- **Distributed traces.** Not in v1; see `observability.md`.
