# Alerting

The rules live in `ops/alerts/palcert.rules.yml` — a standard Prometheus rule
file, which Prometheus, VictoriaMetrics, Thanos Ruler, Grafana Alerting and
the OpenTelemetry Collector all evaluate. PalCert requires none of them.

```bash
# Prometheus
rule_files:
  - /etc/prometheus/palcert.rules.yml
```

## Severity

| Severity | Meaning |
| --- | --- |
| `page` | A person is woken. Customer-visible now, or losing data. |
| `ticket` | Looked at during working hours. Real, not urgent. |

## The honest part about thresholds

**PalCert has no production workload yet.** Any number that depends on how
much traffic it actually takes is a starting point, not a measurement.
Inventing one and presenting it as tuned would produce alerts that look
authoritative and fire at the wrong time — which is how teams learn to ignore
alerts.

So every such rule carries an `ASSUMPTION` comment in the rule file saying
what it assumes, and this table says what to re-derive. A test
(`alert-rules.spec.ts`) fails if a rule with an invented numeric threshold
loses its `ASSUMPTION` note.

The rules that need **no** workload knowledge carry no invented number at
all, and those are the ones to trust on day one: a dead job, a stuck
certificate, a collector that cannot read the database, more than one build
serving at once, a process that is not scrapable.

## Catalogue

### Availability

| Alert | Severity | Condition | Threshold basis |
| --- | --- | --- | --- |
| `PalCertServiceDown` | page | `up == 0` for 2m | None needed |
| `PalCertHighErrorRate` | page | 5xx > 2% of responses for 10m | **ASSUMPTION.** High enough that one bad request does not page, low enough that a broken endpoint does. Re-derive from the measured 5xx baseline. |
| `PalCertLatencyDegraded` | ticket | p95 > 2s for 10m | **ASSUMPTION.** A starting point for interactive routes. Uploads and report reads are legitimately slower and will need their own threshold once the route mix is known. |

### Jobs

| Alert | Severity | Condition | Threshold basis |
| --- | --- | --- | --- |
| `PalCertJobDead` | page | any job in `DEAD` | **None needed.** A terminal failure is work a customer asked for that will not happen without intervention. One is enough. |
| `PalCertQueueBacklogGrowing` | ticket | depth > 200 for 15m | **ASSUMPTION.** Chosen so a normal burst of uploads clears without paging. Re-derive from the arrival rate. |
| `PalCertOldestQueuedJobStale` | page | oldest waiting job > 30m | **ASSUMPTION.** A starting point for "a customer has noticed". Age, not depth: a small queue that never drains is worse than a large one that does. |
| `PalCertJobLeasesExpiring` | ticket | > 5 lapsed leases for 10m | **ASSUMPTION.** Against the lease period, not a measured restart rate. |
| `PalCertJobFailureRateHigh` | ticket | > 10% of attempts retry or die, 15m | **ASSUMPTION.** |

### Delivery

| Alert | Severity | Condition | Threshold basis |
| --- | --- | --- | --- |
| `PalCertNotificationsNotSending` | ticket | oldest unsent > 1h | **ASSUMPTION**, against the retry schedule. |
| `PalCertNotificationsFailingPermanently` | ticket | > 10/h | **ASSUMPTION.** No measured send volume behind it. |
| `PalCertWebhooksNotDelivering` | ticket | oldest undelivered > 1h | **ASSUMPTION**, matching the notification rule. |
| `PalCertWebhooksFailingPermanently` | ticket | > 20/h | **ASSUMPTION.** One customer's broken endpoint should not page; a platform-wide delivery fault should. |

### Analysis

| Alert | Severity | Condition | Threshold basis |
| --- | --- | --- | --- |
| `PalCertAnalyzerFailing` | page | > 5% of analyses end `failed` | **ASSUMPTION.** Low, because `failed` is PalCert's own bug rather than a bad upload — `rejected` is counted separately and does not page. |
| `PalCertAnalyzerTimingOut` | ticket | > 5 timeouts in 15m | **ASSUMPTION.** Depends entirely on the document mix. |

### Certificates, payments, credentials

| Alert | Severity | Condition | Threshold basis |
| --- | --- | --- | --- |
| `PalCertCertificatesStuckUnissued` | page | `PENDING`/`ISSUING` for 1h | **No invented rate.** A paid-for certificate that has not been issued is a promise PalCert is not keeping. |
| `PalCertTopUpsFailing` | ticket | > 25% of top-ups fail, 15m | **ASSUMPTION.** Catches "the provider integration broke", not "several people had insufficient funds". Card decline rates are a property of a customer base PalCert does not have yet. |
| `PalCertApiClientAuthFailureSpike` | ticket | > 50% of authentications refused, 15m | **ASSUMPTION.** Normal integrations do not fail half their calls; a credential-stuffing run does. |
| `PalCertApiClientsThrottledHeavily` | ticket | sustained throttling for 15m | **ASSUMPTION.** A "somebody's integration is misconfigured" signal, not a security one. |

### Storage and accounts

| Alert | Severity | Condition | Threshold basis |
| --- | --- | --- | --- |
| `PalCertStorageUnavailable` | page | any sustained rate of `outcome="unavailable"` | **No invented rate.** An upload that cannot be stored surfaces to a customer as a generic error. `not_found` and `refused` are ordinary answers and are counted separately. |
| `PalCertStorageRefusing` | ticket | > 1/s of `outcome="refused"`, 10m | **ASSUMPTION.** A 4xx from the store means PalCert asked wrongly — a credential, a policy or a bucket configuration — and a steady trickle is a misconfiguration. |
| `PalCertLoginFailureSpike` | ticket | > 40% of login attempts fail, 15m | **ASSUMPTION.** People mistype passwords; a credential-stuffing run fails almost everything. |
| `PalCertLoginThrottlingSustained` | ticket | throttling firing continuously for 15m | **ASSUMPTION.** Throttling is the defence working; *sustained* throttling means something is still pushing against it. |

### Telemetry itself

| Alert | Severity | Condition | Threshold basis |
| --- | --- | --- | --- |
| `PalCertMetricsCollectorDown` | page | `palcert_metrics_collector_up == 0` for 5m | **None needed.** Every job, delivery, certificate and payment alert above is blind while this is firing. Treat it as an outage of the alerting itself. |
| `PalCertReleaseSplitBrain` | ticket | more than one `commit` in `palcert_build_info` for 30m | **None needed.** Either the deploy stalled half way or a replica did not restart. |
| `PalCertMemoryGrowing` | ticket | RSS up > 25% over 6h | **ASSUMPTION.** A shape, not a measurement. Written as growth rather than against a container limit, because PalCert sets none and a rule that compares against a limit nobody configured never fires. |

## What an alert never carries

An annotation is rendered into a page, an email and a chat message, and those
go places a database row does not. No rule interpolates a user id, an
organization id, a document id, an email address, an API client id or a URL,
and no secret field name appears anywhere in the file. `alert-rules.spec.ts`
asserts both.

`PalCertJobDead` is the case where the temptation is strongest, because the
first question is "which job?". It carries the **job type** and the count,
and the description tells the responder the query that answers the rest:

```sql
SELECT id, resource_type, resource_id, attempt_count, last_failure_code
  FROM processing_jobs WHERE status = 'DEAD';
```

The payload, the owner and the document stay in the database, where the
access controls are.

## Keeping the rules honest

A rule that references a metric nothing emits does not fail — it evaluates to
an empty vector and stays silent forever. That is the worst failure mode an
alert has: it looks configured, it gets reviewed, it is trusted, and it will
never fire.

`alert-rules.spec.ts` therefore checks every `palcert_*` name in the rule file
against the names the code actually declares, in all three languages. A
rename that forgets the rules breaks the test instead of quietly disarming an
alert.

## Runbook pointers

| Alert | First thing to check |
| --- | --- |
| `PalCertJobDead` | The query above, then `last_failure_code` — one code across many jobs is a systemic fault, many codes is not. |
| `PalCertOldestQueuedJobStale` | Whether any worker reports ready. A worker whose document-engine or storage dependency is down deliberately refuses to claim work rather than burning attempts on jobs it cannot finish. |
| `PalCertMetricsCollectorDown` | Database reachability from the API and worker, then whether the migration granting `EXECUTE` on `app_operational_counts()` has been applied. |
| `PalCertStorageUnavailable` | The store's own health, then the API's readiness probe, which reports object storage as a dependency. Bucket names and object keys are deliberately absent from the alert. |
| `PalCertAnalyzerFailing` | The engine's own logs by `x-request-id`; the analyzer records a safe failure code per document without recording the document. |
| `PalCertReleaseSplitBrain` | The orchestrator's rollout status. Two builds answering customers is a correctness problem, not just an aesthetic one. |
| `PalCertMemoryGrowing` | Metric cardinality first. A label that took an identifier grows the registry one series per document, user or organization, and `palcert_metrics_collector_duration_seconds` rises with it. |
