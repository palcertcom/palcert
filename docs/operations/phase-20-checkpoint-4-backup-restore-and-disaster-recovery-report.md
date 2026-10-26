# Phase 20 — Checkpoint 4 Backup, Restore & Disaster Recovery Report

**Scope frozen at:** Checkpoint 20.3, commit `82760e2`.
**Closes:** the Checkpoint 20.1 release blocker **F-018 — No backup, no
restore, no disaster-recovery plan**.
**Does not touch:** compliance calculation, citation semantics, financial
rules, payment capture, certificate eligibility, submission workflow, advisory
semantics, or webhook/API-client authorization. This checkpoint protects
persisted state; it does not redefine it.

---

## 0. Verdict

**F-018 is CLOSED.** PalCert can lose its production data plane and be restored
into a clean environment with its authoritative data, document objects,
relationships, hashes and business workflows intact. §11 is the drill that
proves it, end to end, against a database cluster and an object store that did
not exist when the backup was taken.

Three defects were found by running the drill rather than by reasoning about
it. Two were in work this checkpoint introduced; **one was a pre-existing
production defect in the deployment topology** that no previous checkpoint
could have caught, because it only appears when a restored database actually
contains data (§12).

One correction to a previous checkpoint's record is carried here (§1).

---

## 1. Correction carried forward: Checkpoint 20.3's end-to-end gate

While inventorying the database for this checkpoint, the local end-to-end
database was found not to contain `20260925000000_phase20_operational_metrics`
— Checkpoint 20.3's own migration. Four of the nine tests in
`observability.e2e-spec.ts` fail without it, so the "1317 passed, 0 failed"
that checkpoint recorded as its final gate cannot have been what it appeared to
be.

That claim is **withdrawn**, struck through rather than deleted, in
[§15a of the Checkpoint-20.3 report](phase-20-checkpoint-3-observability-and-alerting-report.md).
The F-005 verdict is unchanged: the code was correct, and the production-like
stack proofs were taken against the release stack's own PostgreSQL, whose
migration job had applied everything. What was wrong was the evidence, and the
absence of anything that compared migrations on disk against migrations in the
database.

That comparison is now a gate in three places (§3), and §15 records the
re-certification run.

## 2. Recovery inventory

Everything required to reconstruct a working installation, classified.

### Authoritative persistent data

| Item | Where | Notes |
| --- | --- | --- |
| Users, sessions, roles, permissions | PostgreSQL | 88 tables in total |
| Organizations and memberships | PostgreSQL | |
| Documents and versions | PostgreSQL + object store | `quarantine_object_key`, `clean_object_key`, each with a PalCert-computed SHA-256 |
| Uploaded source documents | Object store, quarantine zone | Deleted after promotion; the row records when |
| Promoted clean objects | Object store, clean zone | Immutable; `copyImmutable` refuses to overwrite |
| Analyses (DOCX and PDF) | PostgreSQL + derived zone | `artifact_object_key` + `artifact_sha256` |
| Check runs, rule results, violations | PostgreSQL | |
| Reports | PostgreSQL + derived zone | Canonical `report_hash` is the identity |
| SmartFix plans and manifests | PostgreSQL + derived zone | Canonical hashes, not byte hashes — see §5 |
| Submissions, revisions, decisions, comments | PostgreSQL | |
| Certificates | PostgreSQL + derived zone | Claim and certificate objects, each with a SHA-256 |
| Finance: accounts, ledger, holds, purchases, top-ups, refunds, disputes | PostgreSQL | Append-only ledger; balance is derived |
| Notifications, deliveries, domain events | PostgreSQL | |
| Webhook endpoints, config versions, deliveries | PostgreSQL | URL and signing secret are **sealed ciphertext** (§7) |
| API clients and secrets | PostgreSQL | Verifier-based, not ciphertext (§7) |
| Processing jobs | PostgreSQL | The durability record; §10 |
| Migration history | PostgreSQL | `_prisma_migrations`; §3 |

### Reproducible derived data

Analyses, reports, SmartFix artifacts and rendered certificates are derived —
but **they are backed up anyway**, because re-deriving them is not free and
some of them cannot be re-derived at all once their input is gone. A
certificate's PDF is bound to a claim hash; regenerating it is not the same act
as restoring it.

### Ephemeral operational data

Redis: BullMQ transport messages (identifiers only), rate-limit counters, a
render cache. **Not backed up.** §10 proves a cold start is correct.

### External-provider state

Stripe payment intents, charges and disputes live at the provider.
Reconciliation is PalCert's existing mechanism for re-agreeing with them; a
restore does not and should not try to rebuild provider state.

## 3. Migration compatibility as a gate

A database one migration behind the code connects, answers its readiness probe,
serves most requests, and fails only on the paths that needed the missing
object.

`packages/database/scripts/check-migrations.mjs` compares the migration
directories in source against the applied history. Proved on every state:

| State | Result |
| --- | --- |
| Source migrations == applied history | **PASS**, exit 0 |
| A migration in source not applied | **FAIL**, exit 3, names the migration |
| A migration started and never finished | **FAIL**, exit 4 — "needs a decision, not another deploy" |
| The database ahead of the code | **FAIL**, exit 5 |
| Restored database at the current level | **PASS** — §11 step 8 |

Wired into three places, and deliberately **not** into the readiness probe: it
reads a directory listing and a table, and the answer cannot change while a
container runs.

1. **Deployment.** A `migrate-check` service sits between the migration job and
   the application. `api` and `worker` now wait on *it* rather than on
   `migrate`, so traffic cannot open against a stale schema. It runs Prisma's
   own `migrate status`, because Checkpoint 20.2 slimmed the migrate image on
   purpose and the richer checker needs a generated client the image does not
   carry — same invariant, no image weight.
2. **The end-to-end harness.** Jest refuses to start against a database behind
   the code. The Checkpoint-20.3 failure mode is now impossible.
3. **Recovery.** Part of `restore:verify`, before workers run.

## 4. The backup-role security contract

PalCert forces row-level security on 64 of its 88 tables, which means even the
table owner is filtered by policy. A role without bypass capability cannot dump
them — **and PostgreSQL refuses rather than silently writing empty tables**,
which is the one mercy in the design:

```
pg_dump: error: query failed: ERROR:  query would be affected by
row-level security policy for table "ai_consents"
```

So `BYPASSRLS` is genuinely required by PostgreSQL here, and that is the
exemption the contract allows. Nothing beyond it is:

| Property | Enforced |
| --- | --- |
| Not a superuser | `provision-backup-role` refuses to report success otherwise |
| Dedicated to backup, never the application role | Asserted |
| No CREATEDB, no CREATEROLE, no REPLICATION | Asserted |
| `SELECT` only — no INSERT, UPDATE, DELETE, TRUNCATE | Asserted; the REVOKE runs on every provision, so a grant acquired by another route is removed |
| No `CREATE` on the schema | Asserted |
| Owns nothing | Asserted |
| Password from the environment, never a file, never printed | Passed through a session setting into a `DO` block, so it cannot appear in a parse error |

`verify-backup-role` proves the contract in both directions — **19 of 19
checks**:

- **Negative.** The application role cannot produce a backup. It is stopped
  twice over, and the first stop comes first: it holds no `SELECT` at all on
  tables it was never granted, so `pg_dump` fails on a permission denial before
  it ever reaches a FORCE-RLS table.
- **The hazard itself.** A throwaway probe with `SELECT` on everything and no
  `BYPASSRLS` proves the dangerous case does not exist: PostgreSQL refuses and
  names row-level security, rather than producing an archive that looks healthy
  and restores to 64 empty tables.
- **Positive.** The dedicated role produces a 924 KiB dump carrying 104
  policies, 305 function entries, 249 grants and 88 table-data sections.

## 5. The consistency model

PostgreSQL and an S3-compatible store cannot be snapshotted atomically
together. Rather than assert consistency, the backup constructs and then proves
it.

### Mutation cannot occur

Object keys are immutable by construction, and this is enforced in code rather
than by convention:

- every key is derived from a per-entity UUID — a version id, an analysis id, a
  check *run* id, a plan id — so a retry produces a new entity and therefore a
  new key;
- quarantine keys additionally carry a 12-byte random nonce;
- `copyImmutable` **refuses** to overwrite an existing destination and returns
  what is already there;
- all three buckets are versioned, so even an overwrite would leave the prior
  version retrievable.

### Deletion can occur, and is handled

Deletion is a real lifecycle step: quarantine objects are collected after
promotion, abandoned uploads are swept, retention purges run. Critically, the
object is deleted *before* the row is updated to say so — so an absent object
whose row still says `quarantine_deleted_at IS NULL` is a genuine dangling
reference rather than an ordinary step.

Two mechanisms, and neither is new infrastructure:

1. **Version pinning.** Objects are fetched by the exact version id the
   database recorded. In a versioned bucket a DELETE writes a delete marker and
   leaves the version itself retrievable, so a collection between the database
   snapshot and the object copy cannot pull the bytes out from under the
   backup. The manifest records per object whether it was pinned this way, so
   an operator can tell which objects were immune and which were merely lucky.
2. **Reconciliation.** Any referenced, non-deleted object that is absent fails
   the backup — on a quiet afternoon, not on recovery day.

### One snapshot, shared

The load-bearing mechanism:

1. open a **repeatable-read** transaction and `pg_export_snapshot()`;
2. run `pg_dump --snapshot=<id>` against that same snapshot;
3. read the reference closure **inside that same still-open transaction**.

So the list of objects the backup must contain is derived from the very rows
that were dumped, not from a live database that has since moved on. The
manifest records the model itself:

```json
"consistency": {
  "model": "shared-snapshot-closure",
  "databaseSnapshotIsolation": "repeatable read",
  "closureDerivedFrom": "the database snapshot, inside the same transaction",
  "objectsCopiedAfterSnapshot": true,
  "objectsPinnedByVersion": 9,
  "objectsReadByKeyOnly": 0
}
```

### The two invariants, as tests

- **A post-snapshot upload does not invalidate the backup.** An object written
  to a bucket after the snapshot belongs to no row and no restored workflow can
  reach it. The drill writes one and re-validates: `verify-backup: OK`.
- **A database-referenced object missing from the backup does invalidate it.**
  Exit 65, naming the table, column and row id.

### What is honestly not covered

`expected_sha256` is **NULL** for SmartFix plan and manifest artifacts and for
upload-session staging, because PalCert never hashed those exact bytes — a
plan's `plan_hash` is canonical over the plan's content, not a digest of the
stored file, and an upload session's `client_sha256` is an unverified claim by
the uploader. The verifier checks presence and size for those and **says so**,
counting them apart from the hash-verified total rather than inflating it.

## 6. Backup architecture

```
<backup-id>/
  backup.json                        manifest: format version, ids, timings,
                                     component checksums, consistency model,
                                     reconciliation result
  database/palcert.dump              pg_dump custom format, compressed
  database/reference-closure.jsonl   every DB→object reference at the snapshot
  objects/manifest.jsonl             per object: key, size, sha256, expected
                                     sha256, version id, pinned, source table
  objects/data/<zone>/<key>          the bytes
```

**Custom format**, not plain SQL: it is compressed, `pg_restore --list` can
read its contents without applying any of it (which is how an archive is
validated with no database present), and it can be restored selectively.

**`--no-owner` and `--no-privileges` are deliberately not passed.** PalCert's
least-privilege grants and its 104 policies are part of what must survive.

Manifests are deterministic — records sorted, keys sorted — so two backups of
identical content produce byte-identical manifests, which is what makes their
checksums meaningful and two manifests diffable.

Object keys become path segments inside the archive, so `assertSafeObjectKey`
refuses traversal, absolute paths, backslashes, empty segments and control
characters. PalCert mints its own keys and none of these can occur, which is
exactly why the check is cheap to keep.

## 7. Encryption and secret dependencies

**Secrets are not in the backup.** That is what makes an archive safe to store
off-site, and it means recovery is incomplete without them.

| Secret | Classification | Consequence |
| --- | --- | --- |
| `WEBHOOK_ENCRYPTION_KEYS` (+ active kid) | **Must be recovered** | Every webhook URL and signing secret is AES-256-GCM ciphertext naming the key id that sealed it. **The API refuses to start** without it — proved in §12. |
| `AUTH_MFA_SECRET_KEY` | **Must be recovered** | Every enrolled authenticator's TOTP secret is sealed with it. |
| `API_CLIENT_REVEAL_SECRET_KEY` | **Rotate** | Seals only the short-lived reveal copy. API-client *authentication* is verifier-based and needs no key. |
| `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET` | **Rotate** | Gate no stored data. |
| `CERTIFICATE_VERIFICATION_SECRET_KEY` | Needed, but **not for reading stored data** | See below. |

### Certificate verification is key-independent, and this is proved

`compliance_certificates` keeps `verification_code_hash` — a plain SHA-256 of
the canonical code — as **the only lookup authority**. The sealed plaintext is
issuance staging and is erased in the same statement that marks the certificate
`ISSUED`.

So a restored installation can verify a certificate whose code it has never
held. The drill does exactly that (§11), through the released proxy, on a stack
whose database was restored from an archive.

No real production secret appears in any fixture. The drill's own summary file
is written through `redactFixture`, which strips the verification code — the
one value in the fixture that is a capability.

## 8. Restore architecture

Nothing is written until three things are established, in this order:

1. **The archive is usable** — every component present, the recorded length (a
   truncated transfer is *named* as truncated), and the recorded checksum.
2. **The destination is clean** — a database that already has a schema is
   refused. Restoring on top of live data is how a recovery turns one outage
   into two.
3. **Every role the archive grants to exists.** See §12; this check exists
   because the drill found its absence the hard way.

Then the database, then the objects, and then the part that matters: the
reference closure is **recomputed from the restored database** and every object
it names is re-read and re-hashed. That is the difference between "the archive
said it was consistent" and "the installation in front of us is".

## 9. RPO and RTO

**Measured, from the drill.** No business target is invented here; an RPO and
an RTO are decisions an owner makes.

| Measurement | Value |
| --- | --- |
| Backup duration | **0.6 s** (0.2 s database, 0.1 s objects) |
| Backup size | 940 KiB database dump + 42.6 KiB objects |
| Objects backed up | 9, all version-pinned |
| Archive validation (`--deep`) | under 1 s |
| Restore duration | **2.9 s** (2.3 s database, 0.1 s objects, 0.1 s integrity) |
| Migration + integrity verification | under 2 s |
| Application boot on restored data | ~40 s to API healthy; ~3 min including the malware scanner's database load |
| **Total measured recovery** | **under 4 minutes**, dominated by container startup, not by data movement |

These are the figures for a representative dataset, not a production one. They
scale with data volume, and the database restore is the part that will grow.

**Proposed, requiring owner approval:**

| | Proposal | Depends on |
| --- | --- | --- |
| RPO | 6 hours, matching a 6-hourly backup | How much work may be lost. Cannot be shorter than the backup interval without WAL archiving. |
| RTO | 4 hours | Dominated by human decision-making, not by these tools. |

### Point-in-time recovery: stated plainly

**This checkpoint implements scheduled logical backups. It does not implement
WAL archiving or point-in-time recovery.** Recovery is to the instant of the
last good backup and no finer. Nothing here should be described as PITR. If a
shorter RPO is required, continuous WAL archiving is the mechanism and it is a
deployment-level addition with its own storage, retention and drill.

## 10. Redis and job recovery

### Redis is not authoritative, and it is proved

Durability lives in `processing_jobs`; BullMQ carries identifiers only and its
own retries are disabled so there is exactly one retry policy. The drill
started the restored stack against a **cold, empty Redis**: the worker reached
healthy, the outbox dispatcher republished from the ledger, and Redis refilled
by itself.

### Completed work is not repeated

The worst thing a restore can do is repeat finished business work — charge a
card twice, issue a second certificate. After the restore, and again after
workers started:

- `SUCCEEDED` = 24, **unchanged** by starting the workers;
- no `SUCCEEDED` job holds a lease, so none is claimable;
- jobs that were `DISPATCHED` or `RUNNING` are visible to the reaper and return
  to `PENDING` with one attempt spent, or become `DEAD` when attempts are
  exhausted.

## 11. The drill

Two drills, because they prove different things.

### Automated, in the test suite — 20 steps, all passing

`disaster-recovery.e2e-spec.ts` builds the fixture through real workflows, backs
it up, restores into an independent database and three independent buckets, and
interrogates the result. Runs in CI.

| Step | Proved |
| --- | --- |
| 2 | The source is migration-current before it is trusted |
| 3+4 | The backup's object closure comes from the database snapshot; reconciliation clean; consistency model recorded; objects version-pinned |
| 4a | Every copied object is there because a row points at it, and every required reference was copied |
| 4b | A post-snapshot upload does not invalidate the archive |
| 5 | Validated before the destination is touched |
| 6+7 | Restored into a database and buckets that did not exist before; every hashed object re-verified |
| 8 | The restored database is at the current migration level |
| 9 | Structure, policies, grants and semantics verified **before** workers |
| 9a | Structure matches the source exactly |
| 9b | The application role's grant matrix is still uneven |
| 11a–11i | Documents, both analyzers, report hash, certificate verification, ledger identity, organization/API-client scoping, sealed state, notification history, job recovery |
| 12 | Timings recorded |

### Against the production-like stack — the real thing

Restored into **the release stack's own PostgreSQL and its own MinIO** —
different instances entirely, not merely different names — then booted.

| # | Step | Result |
| --- | --- | --- |
| 1 | Provision infrastructure | postgres, redis, minio, certs, storage-init |
| 2 | Verify the source is migration-current | 63 migrations, current |
| 3 | Back up | 0.6 s, 9 objects |
| 4 | Capture the closure and manifest | 13 references, 9 objects, reconciliation clean |
| 5 | Validate before destruction | `--deep`, 9 objects re-hashed, OK |
| 6 | Independent destination | fresh cluster: 0 tables; fresh object store |
| 7 | Restore both | 2.9 s; **9 of 9 hash-verified** |
| 8 | Migration compatibility | current |
| 9 | Integrity, workers and ingress down | **19 of 19 checks** |
| 10 | Boot the stack | api, web, document-engine, proxy healthy; **worker deliberately not started** |
| 11 | Application verification | below |
| 12 | Start workers | healthy; `SUCCEEDED` unchanged at 24 |

**Application verification on the restored stack:**

- API `/health/ready` → 200; document engine → 200; web healthy; proxy
  `/health/ready` → 200
- Worker readiness once started: database ok, redis ok, object-storage ok,
  malware-scanner ok, document-analysis ok
- **Public certificate verification of a pre-disaster certificate** →
  **HTTP 200**, certificate number and organization present, the verification
  code **not** echoed back. The restored installation has never held that code
  in plaintext.
- An unknown code → **404**

The verification code was held only for the duration of the drill, in a file
created solely because an operator cannot present a code they do not have, and
destroyed immediately afterwards.

## 12. The three defects the drill found

### 12a. Roles are cluster objects, and a database dump cannot create them

`pg_restore` failed part-way through a restore into a fresh cluster:

```
pg_restore: error: could not execute query: ERROR:  role "palcert_backup" does not exist
Command was: GRANT USAGE ON SCHEMA public TO palcert_backup;
```

The dump records who owns what and who was granted what, but roles live in the
cluster, not the database. The failure arrives **after the schema is half
applied**, which is the worst moment to learn it.

**Fixed.** The restore now reads the roles a dump's grants and ownerships name
— by rendering the archive to SQL without touching a database — and refuses
early, naming each missing role, with the destination **untouched**:

```
restore:   role palcert_backup does not exist here
restore: the destination cluster is missing 1 role(s) this archive grants to.
         Provision them before restoring — a database restore cannot create cluster roles.
tables: 0
```

"Provision database roles" is now step 2 of the restore runbook.

### 12b. The release topology never carried the webhook keyring — a pre-existing production defect

Starting the API against a restored database that actually had a webhook
endpoint in it:

```
Failed to start PalCert API WebhookKeyUnavailableError:
  webhook encryption key k2 is not available
```

The application's behaviour is **correct**: it refuses to start rather than run
unable to read its own stored configuration. The *configuration* was wrong —
`docker-compose.release.yml` forwarded `AUTH_MFA_SECRET_KEY`,
`CERTIFICATE_VERIFICATION_SECRET_KEY`, `API_CLIENT_REVEAL_SECRET_KEY` and
`STRIPE_WEBHOOK_SECRET`, but **not `WEBHOOK_ENCRYPTION_KEYS` or
`WEBHOOK_ENCRYPTION_ACTIVE_KID` at all.**

This is not a restore problem. **No deployment built from this topology could
have run Phase 17 webhooks** — not a restored one, and not a fresh one. It
survived Checkpoints 20.2 and 20.3 because their release stacks ran against
empty databases: with no webhook rows, nothing ever needed a key. Only a
restore carrying representative data could expose it.

**Fixed**: both variables added to the release environment, required rather
than defaulted — a deployment that guesses here is one that cannot serve its
own stored data. A topology test now asserts every secret a restored
installation needs to start.

### 12c. A stale probe role, and what it revealed

A leftover test role held a schema grant, which the dump faithfully carried
into an archive. Cleaned up — but it is the reason 12a was found, and it is a
standing argument for keeping the source database's role list tidy: every role
that holds a grant becomes a restore-time dependency.

## 13. Disaster scenarios

Documented in [the disaster-recovery runbook](disaster-recovery.md), each
stating whether what was lost is authoritative or rebuildable: database loss,
object-storage loss, application-node loss, Redis loss, worker loss, corrupted
deployment, leaked or rotated runtime secret, accidental deletion, and partial
database/object inconsistency.

## 14. Negative tests — 16, all passing

Every one asserts the refusal is non-zero, names the problem, and happens
**before** anything is written.

| Case | Behaviour |
| --- | --- |
| Missing database dump | exit 65, "component databaseDump is missing" |
| Truncated dump | exit 65, named as **truncated**, not merely corrupt |
| Corrupt dump, right length | exit 65, "corrupt" |
| Missing object manifest | exit 65 |
| Manifest checksum mismatch | exit 65 |
| Missing object | exit 65, "is listed but absent" |
| Object bytes changed, same length | shallow verify passes, **`--deep` fails** — which is why `--deep` exists |
| Unsupported format version | exit 65, "not supported by this build" |
| Unclean backup | refused unless `--allow-unclean-backup` |
| Non-clean destination | exit 65, and the destination is untouched |
| Unreachable destination | exit 69 |
| Stale migration history | `migrations:check` exit 3; `restore:verify` FAIL |
| Backup role without bypass capability | refused, naming row-level security |
| Unreachable object store | non-zero, no credential in the output |
| Missing bucket | non-zero |
| Absent configuration | exit 78 |

**One honest limitation**, written into the test rather than papered over:
credential *rejection* cannot be exercised against the local S3 mock, which
accepts any credentials. A test asserting it would be green and would prove
nothing. The endpoint is made genuinely unreachable instead, which proves the
part that matters — the tool stops rather than writing a partial archive.

## 15. Gates

| Gate | Result |
| --- | --- |
| Backup creation | clean, reconciliation 0/0 |
| Backup validation (`--deep`) | OK, 9 objects re-hashed |
| Clean restore | 9 of 9 hash-verified |
| Post-restore verification | 19 of 19 |
| Object integrity | every hashed object matched |
| Ledger verification | balance re-derived, identical |
| Certificate hash and public verification | HTTP 200 on the restored stack |
| RLS verification | 64 FORCEd, 104 policies, grant matrix uneven |
| Production-like stack boot after restore | every service healthy |
| Backup-role contract | 19 of 19 |
| Migration gate proofs | 4 states + database-ahead |
| Document-engine suite | 1792 passed, 85 skipped |
| Contracts | 819 passed |
| Config (release topology) | 54 passed |
| Database package | 3 passed |
| API unit | 644 passed, 5 skipped |
| Web | 520 passed |
| TypeScript typecheck | clean |
| mypy | clean, 102 files |
| eslint / ruff / prettier | clean |
| Builds (all packages and apps) | clean |
| Generated-contract drift | clean |
| Report golden | verifies |
| IANA registry | current |
| `docs:check-phases` | clean |
| **One complete API e2e run** | **1354 passed, 10 skipped, 0 failed** — 79 suites, 30 minutes |

### End-to-end re-certification

Run against a database **proven migration-current before Jest started** — the
harness now refuses otherwise, and the run's first line is
`migrations:check: OK 63 migration(s), database is at the code's level`.

**76 suites passed, 3 skipped, 79 total — 1354 passed, 10 skipped, 0 failed,
in 30 minutes.** Exit code 0.

The arithmetic is itself evidence that the drill ran inside this gate rather
than beside it. Checkpoint 20.3's suite was 76 files and 1317 tests; this one
is 79 files and 1354 tests. The difference is exactly the three specs this
checkpoint added — the recovery fixture (1), the drill (20) and the negative
recovery tests (16) — so the restore mechanics were exercised by the same run
that certifies the rest of the application.

| | |
| --- | --- |
| Test suites | 76 passed, 3 skipped, 79 total |
| Tests | 1354 passed, 10 skipped, **0 failed** |
| Duration | 1809 s |
| Migration preflight | `migrations:check: OK 63 migration(s), database is at the code's level` — printed before the first suite |

This result is recorded as evidence for **both** checkpoints: Checkpoint-20.4
gate evidence, and the Checkpoint-20.3 end-to-end re-certification that §1
requires.

## 16. Remaining release blockers

From the Checkpoint-20.1 ledger:

| Id | Status |
| --- | --- |
| **F-005** — no metrics, no tracing, no alert hooks | **CLOSED** in 20.3; end-to-end evidence re-certified here |
| **F-018** — no backup, no restore, no DR plan | **CLOSED** here |
| **F-013** — no deployment topology, no rollback plan | Open; Checkpoint 20.5 |

Post-v1 items recorded rather than built:

| Id | Item |
| --- | --- |
| **P-011** | Continuous WAL archiving and point-in-time recovery |
| **P-012** | Automated cross-region backup replication |
| **P-013** | Automated restore drills on a schedule, rather than a documented quarterly procedure |

## 17. Explicit non-changes

No compliance calculation, citation semantic, financial rule, payment capture
path, certificate eligibility rule, submission workflow, advisory semantic, or
webhook/API-client authorization decision was altered. The one schema-adjacent
change is a new database role that can only read.
