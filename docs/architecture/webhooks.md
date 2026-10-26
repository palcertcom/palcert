# Outbound webhooks

**Status:** Phase 17, complete.

> A webhook is an external projection of an authoritative `DomainEvent`.
> It never becomes the authoritative record itself.

That sentence governs everything below. Nothing in this subsystem may be
consulted to decide whether a submission was approved or whether a certificate
is valid: Phase 14 and Phase 15 keep that authority, and Phase 16's
`DomainEvent` remains the only business-event source. A webhook says *that*
something happened, so somebody else's system can go and ask PalCert what.

---

## 1. The flow, end to end

```
DomainEvent (Phase 16, authoritative, append-only)
      │  webhook_eligible = true
      ▼
WEBHOOK_FANOUT job  ──────────────► WebhookEvent (one per DomainEvent)
      │                                   │ minimized payload, body hash
      │                                   ▼
      └─► one WebhookDelivery per ACTIVE, subscribed endpoint
                    │
                    ▼
            WEBHOOK_DELIVER job
                    │
                    ├─ begin attempt  (delivery → SENDING, attempt row, counter)
                    ├─ one HTTPS request through SafeWebhookHttpClient
                    └─ finish attempt (attempt outcome + delivery state, one write)
```

The producer writes the `DomainEvent` and the fan-out job in one transaction.
`WebhookFanoutReconciler` is the safety net for the case that ordering cannot
cover: a rolling deployment where a process still running Phase 16 code writes
an eligible event and knows nothing about the job type. It is a bounded,
oldest-first scan for eligible events with no live fan-out job; it creates
exactly the missing job and makes no network request of any kind.

## 2. Event vocabulary

Nine public types, deliberately not the internal `NotificationType`:

```
submission.ready              submission.rejected
submission.revision_ready     submission.revision_requested
submission.under_review       submission.comment_added
submission.approved           certificate.issued
                              certificate.revoked
```

An external contract that was literally an internal enum would make every
internal rename a breaking change for every integrator, and would invite adding
an internal-only type to it by accident. `WEBHOOK_EVENT_TYPE_OF` maps the two
and is total over the nine, so a tenth internal type fails the exhaustiveness
test rather than silently producing no webhook.

There is no wildcard subscription. The default is none, so a type added in a
later phase reaches nobody until somebody asks for it.

## 3. Payload schema, version 1

```json
{
  "id": "…",                       // the WebhookEvent id — the dedup key
  "type": "submission.approved",
  "schemaVersion": 1,
  "occurredAt": "2026-06-01T12:00:00.000Z",
  "organizationId": "…",
  "data": { "submissionId": "…", "submissionRevisionId": "…",
            "institutionDecisionStatus": "APPROVED" }
}
```

`data` is built by an allow-list per event type, not by removing known-bad keys
from the `DomainEvent` payload. Only five keys exist across the whole
vocabulary — `submissionId`, `submissionRevisionId`, `revisionNumber`,
`institutionDecisionStatus`, `certificateId` — and `assertSafeWebhookPayload`
refuses anything else. No name, no email address, no document title, no comment
prose, no file. A webhook tells an integrator's system to come and ask.

`schemaVersion` is independent of `DOMAIN_EVENT_SCHEMA_VERSION`: the internal
payload and the external contract change for different reasons.

The body is RFC 8785 canonical JSON, hashed at projection time and re-verified
before every attempt. A delivery whose stored hash no longer describes its own
body is refused before any socket opens.

## 4. Endpoints and configuration versions

An endpoint is the logical integration; its URL and signing secret are not on
it. They live in immutable `WebhookEndpointConfigVersion` rows, and the endpoint
points at two of them: the one currently serving and the one waiting to be
verified.

```
PENDING_VERIFICATION ──► DISABLED
        │ (successful verification only)
        ▼
      ACTIVE ⇄ PAUSED ──► DISABLED       DISABLED is terminal
```

Saving a new URL creates a new version and supersedes any older pending one;
the verified version keeps serving until the new one proves itself, so a typo
does not silently stop an integration. Disabling frees the endpoint slot — an
organization may hold ten non-disabled endpoints, enforced by a unique index on
`(organization, slot)` rather than by a count anybody has to trust.

Rotating the signing secret is the same shape: a new immutable version with a
new secret, which must be verified before it serves.

**A rotation changes the secret and nothing else.** The destination is read back
from the source version's own sealed material and re-sealed against the new
version id — the exact normalized URL, scheme, host, port and path. Nothing
rebuilds it from a read model: the tenant-safe projection deliberately has no
path, so a rotation built from it would silently move where an organization's
events go, and no surface would show the change until deliveries started
failing. The URL never reaches a DTO, a browser response, a log or an audit
entry on the way through; it is opened inside the request, re-validated against
the current policy, and re-sealed.

**The source is the pending version if there is one, otherwise the verified
one.** A pending version is the destination the organization most recently
chose, so rotating while a URL change is waiting must carry that change forward
rather than reverting to the one still serving. An endpoint that has never
verified can still recover from a lost first secret this way. With neither, the
rotation is refused with `WEBHOOK_NO_PENDING_CONFIG`.

## 5. Verification

An administrator asks; a worker sends. PalCert signs a challenge body and
expects the exact nonce echoed in a response header.

- The job is keyed by the **management operation**, never by the configuration.
  A job keyed by the configuration would have succeeded once and refused to run
  again, so an administrator who fixed their receiver could never ask a second
  time. A new `Idempotency-Key` makes a new operation, a new job and a fresh
  chance.
- The wire identity of a verification is the **verification attempt**: its id is
  the `PalCert-Delivery-Id` header and the id the signature commits to. Two
  handshakes against one configuration are therefore never byte-identical, and a
  receiver can tell a fresh challenge from a replayed one.
- A refusal that never reached the wire opens **no attempt row**. An attempt is
  the record of a real network request; manufacturing one to carry a refusal
  would put a request in the log that never left the process.
- The challenge is generated per attempt, compared against the immediate
  response, and forgotten. Persisting it would be persisting an answer key.
- A receiver's HTTP answer — including 408, 425, 429 and 5xx — settles the
  administrator's intent. Asking again is an explicit act. Only a transport
  failure, where nothing was heard at all, retries on the queue's ladder.

## 6. Signing, and what a receiver verifies

```
signature = HMAC-SHA256(secret, "<timestamp>.<PalCert-Delivery-Id>.<raw body bytes>")
```

Over the **exact bytes sent**. The canonical body is built once, converted to a
`Buffer`, hashed, signed and written to the socket without re-serialization —
a second `JSON.stringify` between signing and sending is how a signature comes
to describe bytes nobody received.

Headers: `PalCert-Signature`, `PalCert-Timestamp`, `PalCert-Event-Type`,
`PalCert-Delivery-Id`, and `PalCert-Event-Id` for business events only.

## 7. The SSRF model

`SafeWebhookHttpClient` is the only thing in PalCert that opens a socket to a
customer-supplied address.

- HTTPS only, port 443 (or a configured allow-list), no query string, no IP
  literal, and not a PalCert-owned host.
- DNS is resolved by the client and **every** returned address is classified
  against committed IANA special-purpose registry snapshots for IPv4 and IPv6
  — not a hand-written private-range list.
- The connection is made to the address that was checked, by pinning it, so the
  name cannot resolve to something else between the check and the connect.
- Redirects are refused rather than followed: PalCert does not accept a new
  destination from the answer to a request it already validated.
- The response body is not read. There is nothing in it PalCert wants, and
  reading it is how a receiver gets to decide how much memory PalCert spends.

The IANA snapshots are generated, committed, and checked for drift in CI.

## 8. Retries: two ladders, and why they never touch

| | answers | length |
|---|---|---|
| ProcessingJob ladder | did this *process* manage to run the attempt? | seconds |
| Webhook ladder | is the *receiver* ready yet? | 1m, 5m, 30m, 2h, 12h, 24h |

A receiver's answer never throws. The attempt is recorded, the delivery gets
its own `next_attempt_at`, and the job **succeeds** — a job held in
`RETRY_PENDING` for twelve hours would occupy the queue with waiting, and a job
that failed would put a 503 on the queue's short ladder and ask a struggling
receiver again within seconds. `WebhookDeliverySweeper` re-arms that same job
when the time comes.

`WEBHOOK_DELIVER` is the only job type the lifecycle lets move back from
`SUCCEEDED` to `PENDING`, and only to `PENDING`. Every other job type keeps
`SUCCEEDED` terminal, because for every other job type a second run is a
duplicate.

`Retry-After` is honoured upward only and clamped to 24 hours — a receiver does
not get to schedule PalCert — and it is read, clamped and forgotten in memory.
It never reaches a stored column.

## 9. Atomicity: an attempt and its parent

Both ends of an attempt are one write.

**Beginning** moves the delivery to `SENDING`, increments `attempt_count` and
inserts the attempt row in one doorway, so `attempt_count` equals the number of
attempt rows by construction. That matters because the counter indexes the
ladder: while starting was two commits, a crash between them spent a rung with
no attempt row and no request, and the recovery spent another putting it right.
A handful of restarts could exhaust an organization's retries without a single
request leaving the process. The rung is now the attempt's own number.

The doorway also refuses to begin before the delivery's own `next_attempt_at`,
comparing against the caller's clock, so no code path can start a real attempt
ahead of the business schedule.

**Finishing** closes the attempt and moves the delivery in one doorway, deriving
the delivery from the attempt id so it cannot be pointed at another one. The
old parent-only transition can no longer write an HTTP status or carry a
receiver-derived error code, so there is exactly one authority for what a
receiver said. A partial unique index allows one open attempt per delivery, and
one per verification operation.

## 10. Crash recovery and at-least-once

| crash point | durable state | what the reclaim does |
|---|---|---|
| before the begin commits | delivery unchanged, no attempt | begins normally; no rung spent |
| after begin, before the socket | `SENDING`, one open attempt | closes it `WORKER_INTERRUPTED`, begins again |
| after the request, before the finish | same as above | same — the outcome is genuinely unknown |
| after the finish commits | delivery settled or scheduled | reads the finished state and sends nothing |

The third row is the at-least-once boundary: a receiver may see the same event
twice. That is accepted, and it is why the envelope's `id` is the
`WebhookEvent`'s and is stable across every retry and replay.

Recovery happens on the **first reclaim**, not after the queue has spent its
whole attempt budget: the reclaiming worker holds the lease, so the previous one
is already gone.

## 11. Receiver deduplication

Deduplicate on **`WebhookEvent.id`** — the envelope's `id` field.

Not on the delivery id. An automatic retry reuses the delivery id; a manual
replay creates a new one. Both carry the same event id, which is the thing that
means "this event", and it is what a receiver should key its idempotency on.

## 12. Manual replay

A replay creates a new `WebhookDelivery` with a new id and the **same**
`WebhookEvent` id, references the delivery it replays, and may replay an
original or another replay. It requires an ACTIVE endpoint and a live
subscription, and it uses the endpoint's **current verified configuration** —
a replay is a new decision made now, and signing it with a retired secret would
ask a receiver to keep one alive for ever.

A control message projects no event, so a test delivery cannot be replayed.

## 13. Secret rotation and the recovery window

A signing secret is shown once: in the response to the operation that minted it.
There is no "show it again" route, because PalCert holds only the ciphertext and
because such a route would turn every read of the settings screen into a
credential disclosure.

What exists instead is a bounded **recovery window** of 24 hours. Writing an
HTTP response is not the same as a client receiving one, so the identical
request — same organization, same operation, same `Idempotency-Key`, same
actor, same request fingerprint — returns the identical secret for that long.
Unlimited identical repeats are allowed and have no additional side effect.
After the window the read path refuses **before decrypting anything**, with
`WEBHOOK_IDEMPOTENCY_KEY_EXPIRED`. The sweeper that clears the ciphertext is
storage hygiene, not the authority for expiry.

**The rotation hazard, stated plainly:** an automatic delivery keeps the
configuration it was created with, so deliveries already scheduled are still
signed with the previous secret. A receiver must keep the previous secret valid
until the unsettled old-configuration count reaches zero — which the API and the
UI both report. PalCert does not silently re-sign an old delivery with a new
secret, because that is the one thing a receiver cannot detect.

**There is no dual-secret window, and no expiry date on the old secret.**
PalCert does not sign with two secrets, and it publishes no timestamp after
which the previous one stops being needed: how long old deliveries take to
settle depends on the receiver's own availability and the business retry ladder,
so any date PalCert invented would be a guess a receiver could act on. The one
honest signal is a count of work still outstanding —
`unsettledOldConfigDeliveries`, on `GET …/endpoints/{id}/rotation-pending` and
on the endpoint's page. Zero means every delivery bound to the old
configuration has settled and the previous secret can be retired.

## 14. The keyring

URLs and signing secrets are sealed with AES-256-GCM under a keyring with a key
id (`kid`) from day one, and purpose-specific length-prefixed additional
authenticated data binding each envelope to its endpoint, configuration version
and purpose. A URL sealed for one configuration will not open for another.

Readiness is an awaited part of startup: a process that does not hold every key
its stored rows refer to refuses to finish starting, including when the feature
is switched off while sealed rows still exist. Discovering a missing key
mid-delivery would report a deployment mistake as an organization's endpoint
being broken.

`WebhookRewrapService` re-seals stored material under the active key without
changing what it means, so a key can be retired.

## 15. Authority: three contexts

| context | user | organization | may |
|---|---|---|---|
| SYSTEM | NULL | NULL | project events, deliver, verify, activate |
| TENANT ACTOR | NOT NULL | NOT NULL | manage endpoints, read own history |
| anything else | — | — | nothing |

`palcert_app` holds no direct DML on any Phase 17 SYSTEM table and no direct
`SELECT` on six of them. Every read and write goes through a narrow
`SECURITY DEFINER` doorway, each with its own predicate, and the RLS
system-reader predicate additionally requires the role switch that only holds
inside a definer body — so an unauthenticated route gains nothing by reaching
the right query.

Write modes (`off | system | lifecycle | rewrap | reveal_clear`) are set inside
those doorways and are deliberately not a hierarchy: a lifecycle operation that
could also rewrite ciphertext would let an activation quietly re-point a URL.

Tenant reads use only the `*_safe` projections and the endpoint and subscription
tables, all of which RLS already scopes. **A consequence worth stating:** an
endpoint's destination is reported as scheme, host and port, never the path. The
full URL is sealed and only the worker's system context can open it, so there is
no route that decrypts it for a screen.

## 16. RBAC

Four permissions, granted only to `ORGANIZATION_OWNER` and
`ORGANIZATION_ADMIN`:

| permission | covers |
|---|---|
| `integration:webhook:read` | endpoints, history, rotation status |
| `integration:webhook:manage` | create, URL, verify, lifecycle, subscriptions, test |
| `integration:webhook:secret:rotate` | minting a new signing secret |
| `integration:webhook:replay` | sending a business event again |

No route authorizes by role name.

## 17. Management idempotency

Six durable operation types — `CREATE_ENDPOINT`, `UPDATE_URL`, `VERIFY_CONFIG`,
`TEST_ENDPOINT`, `ROTATE_SECRET`, `REPLAY_DELIVERY` — each recorded as a
`WebhookManagementOperation`. Every mutation that creates one requires an
`Idempotency-Key`.

The key is hashed rather than stored, and the request is fingerprinted from its
*meaning*: the normalized URL rather than what was typed, a sorted set rather
than whatever order the client listed.

| situation | answer |
|---|---|
| same actor, same key, same request | the original result |
| different actor, same key | `WEBHOOK_IDEMPOTENCY_KEY_CONFLICT` |
| same actor, same key, changed request | `WEBHOOK_IDEMPOTENCY_KEY_REUSED` |
| secret-bearing repeat after the window | `WEBHOOK_IDEMPOTENCY_KEY_EXPIRED` |

A `ROTATE_SECRET` request is fingerprinted from the endpoint alone. The
configuration id would have been the obvious thing to include and is exactly
wrong: the operation changes it, so once the new configuration verified, the
identical retry would fingerprint against a different id and be refused as a
reuse — precisely when a caller who lost the response needs the answer. A
deliberate second rotation is a new key, not a new fingerprint.

**The browser is a first-class caller.** A lost response is the ordinary failure
of a mutation over the internet, so every one of the six operations accepts a
caller-supplied `Idempotency-Key` from the web client as well as from a script.
The web UI holds one key per *semantic* action in component state — minted when
the action is first attempted, reused unchanged while the user retries the same
request, replaced the moment the request itself changes, and discarded after the
action succeeds so the next deliberate action is a new intention. The key never
goes in a URL, and no signing secret is ever written to storage a page
outlives.

## 18. Privacy

Never stored, never logged, never in a read model, never in a metric label:
the decrypted URL path, the signing secret, ciphertext, IV or auth tag, the
challenge, the signature, the canonical body, the request body, the response
body, the response headers, and the resolved IP address.

Stored and shown: status, normalized error code, HTTP status, duration, attempt
number, timestamps, event type, configuration version.

The response body is not read at all. A receiver's error page routinely echoes
the request back, and these rows are read by support.

Metric dimensions are the three closed vocabularies — event type, status,
normalized error code. An organization id or an endpoint id as a metric label is
a time series per customer; a host or URL is one per third party.

## 19. Operational procedures

**A receiver is failing.** Look at the delivery's attempts: the normalized code
says whether PalCert refused before the network (`URL_POLICY_VIOLATION`,
`WEBHOOK_CONFIG_INTEGRITY_MISMATCH`), could not reach the address
(`DNS_TEMPORARY_FAILURE`, `CONNECT_TIMEOUT`), or got an answer
(`HTTP_RETRYABLE`, `HTTP_PERMANENT` with the status). A retryable delivery
carries the time it is next due.

**A key is being retired.** Add the new key to the ring alongside the old one,
deploy, run the rewrap, and only then remove the old key. Readiness refuses to
start a process whose stored rows refer to a key it does not hold, so a removal
in the wrong order fails loudly at boot rather than quietly at delivery.

**An organization reports duplicate events.** Expected under at-least-once; the
fix is receiver-side deduplication on `WebhookEvent.id`. Check whether the
duplicates share an event id (correct) or not (a real bug).

**Deployment across the Phase 17 cutover.** `webhook_eligible` defaults to true
from the cutover migration; every pre-cutover row is false and stays false, so
nothing historical is announced. The reconciler covers producers still running
older code.

---

## 20. For receiver implementers

**Verify the signature over the exact raw bytes.** Not a re-serialized object:

```
expected = HMAC-SHA256(secret, `${timestamp}.${deliveryId}.${rawBodyBytes}`)
```

where `timestamp` is `PalCert-Timestamp` (Unix seconds) and `deliveryId` is
`PalCert-Delivery-Id`. Compare in constant time. Most frameworks parse JSON
before your handler sees it — capture the raw body.

**Check freshness.** Reject a timestamp outside a few minutes of your own clock.

**Deduplicate on `PalCert-Event-Id`** (the envelope's `id`), not on the delivery
id, and only for business events:

| | delivery id | event id | timestamp/signature |
|---|---|---|---|
| automatic retry | same | same | fresh |
| manual replay | new | same | fresh |
| test message | new | absent | fresh |
| verification | new attempt id each time | absent | fresh, new challenge |

A verification request carries a fresh challenge every time; echo it back in the
`PalCert-Webhook-Challenge` response header with a 2xx.

**Answer 2xx quickly.** Any 2xx is success. Do the work asynchronously —
PalCert's timeouts are measured in seconds, and a slow handler turns into a
retry you will see again.

**Do not redirect.** A 3xx is refused, not followed, and is recorded as
`REDIRECT_REFUSED`.

**410 means stop.** PalCert records `ENDPOINT_GONE` and fails the delivery
permanently. Use it when the integration is genuinely gone.

**A 503 or 429 is fine.** PalCert waits: one minute, then five, thirty, two
hours, twelve, twenty-four. `Retry-After` is honoured upward, clamped to a day.

**During a rotation, accept both secrets** until the unsettled
old-configuration count on the endpoint's page reaches zero.

## 21. Related

- [Architecture overview §6n](overview.md)
- [Notifications](notifications.md)
- ADR-0120 through ADR-0129
