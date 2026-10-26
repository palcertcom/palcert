# Phase 20 — Checkpoint 5: Registry, CI/CD & Release Delivery Report

**Status: F-013 — CLOSED.**

Deployment, immutable promotion and rollback have each been demonstrated
against real OCI images in a real registry, with identity verified from the
running system rather than from the command that was issued.

---

## 1. The frozen release candidate

Everything below was proved against one release set. Nothing was rebuilt
between staging, production, rollback or recovery.

| | |
| --- | --- |
| Release version | `0.1.0+18d07c5` |
| Registry tag | `0.1.0-18d07c5` |
| Commit | `18d07c51d91fdbd8a953af16e1f34bedddf2b206` |
| Manifest digest | `sha256:4eb6a7a9c8b171f389629cdc2536ed574525c219f3910ad3239e1e8d8ac4bcd8` |
| Migration state | 63 migrations, head `20260925000000_phase20_operational_metrics` |
| Registry | `127.0.0.1:5001/testowner` (a real `registry:2`, plain HTTP for the rehearsal) |

The five images, as one indivisible set:

| Component | Digest |
| --- | --- |
| `api` | `sha256:1b21fbffc02a61671eaf61a0c507de574b28a8378cb27da4c6fe638cc90548fd` |
| `worker` | `sha256:da68ac17267fffc9efe35b992c28182ff149878ff1d4390009ee2eb06b17f4a4` |
| `migrate` | `sha256:c622e261cfa3e7ce33ba369af677c1bb483384c3f16acb5894ce9d7abc0562c9` |
| `web` | `sha256:09b170a1ce45bc5ae2c1380dffb59e021e5490402e711d2bc62a27afb3f6600b` |
| `documentEngine` | `sha256:d5db3168372ef0116dd9cc83e4a8a900c78d3ca4158d78bb73334e4d61123324` |

A second real release, **`0.1.0+c136cc5`** (manifest
`sha256:30a55ab286cf2be73c12c6164b2832da78de4bb6e9998a56dce2100691f5f871`),
exists in the same registry and served as the rollback target. It is the
pre-hardening build, and its freeze record honestly carries the 46 findings it
has — a freeze record that flattered it would be worthless.

---

## 2. Registry and digest evidence

`verify-manifest.mjs --registry-check` returns **15/15** for the frozen
release: well formed, canonical, nothing credential-shaped, five distinct
digests, the expected commit, every digest resolvable, and every image
reporting that commit through `org.opencontainers.image.revision`.

That last group of checks was added during this checkpoint after a rehearsal
produced a manifest whose commit did not match the images it named. The
manifest was internally flawless — every field agreed with every other field —
and only the images disagreed. The negative case is now proven: a manifest
naming a different commit passes nine checks and fails five, printing both
commits side by side.

**Immutability.** Every deployment reference is `repository@sha256:…`. A tag
is never resolved at deploy time. `assert-frozen-images.mjs` treats a
tag-shaped reference as a failure rather than comparing it, and
`test-substitution-refused.sh` proves it refuses a tag substituted for a
digest, one image swapped while four stay frozen, an image missing entirely,
and correct digests under a rewritten commit — with a control asserting the
honest rendering is still accepted.

---

## 3. SBOM, provenance and vulnerability findings

SBOMs are generated from the images, not from the source dependency graph:
SPDX 2.3, one per component.

| Component | Packages (before) | Packages (after) |
| --- | --- | --- |
| `api` | 530 | 333 |
| `worker` | 530 | 333 |
| `migrate` | 461 | 264 |
| `web` | 412 | 215 |
| `documentEngine` | 147 | 122 |

**Provenance** is a SLSA `https://slsa.dev/provenance/v1` in-toto statement
attached to each image index as an OCI referrer, verified by
`verify-provenance.sh` reading it back from the registry. It is deliberately
presence-and-type verification, not signature verification: PalCert has no
trust root yet, and claiming "provenance verified" without one would be false.
No vendor signing service is a deployment dependency.

### Before and after: the vulnerability scan

The first real scan **blocked the release**.

| Image | Fixable HIGH/CRITICAL before | After | All findings before → after |
| --- | --- | --- | --- |
| `palcert-api` | 11 | **0** | 19 → 0 |
| `palcert-worker` | 11 | **0** | 19 → 0 |
| `palcert-migrate` | 11 | **0** | 19 → 0 |
| `palcert-web` | 11 | **0** | 19 → 0 |
| `palcert-document-engine` | 2 | **0** | 161 → 152 |
| **Total** | **46** | **0** | |

Every one of the 46 was in build tooling PalCert does not run: npm's own
vendored dependencies (`tar` CRITICAL, `pacote`, `sigstore`,
`brace-expansion`, `picomatch`, `ip-address`) in the four Node images, and
setuptools' vendored packages in the document engine. **PalCert's own
dependency closure was clean in all five.**

So nothing was suppressed. npm and corepack were removed from the Node runtime
stages and setuptools, pkg_resources, wheel and pip from the engine's, after
verifying nothing needed them: the API reaches config validation with an
identical module graph, the migration job's Prisma CLI still runs, the traced
web server is intact, and the engine imports `app.main` with all ten routes.
`check-image-dependencies.mjs` now asserts their absence so they cannot return.

The document engine's remaining 152 findings are unfixable or low-severity
base-image packages; the gate blocks only on fixable HIGH and CRITICAL.

---

## 4. The corrected secret scanner

`check-image-secrets.sh` reports all five images clean — and that statement
means something only because the scanner was first shown able to fail.

A negative test was written on the principle that a scanner which has only
ever reported "clean" against images that are in fact clean has not been
tested. It plants a credential in the image configuration and a fixture `.env`
in a layer, requires a refusal for each, and includes a control so that
refusing everything is not a way to pass.

**It failed on first run, and the cause was serious.** The filesystem checks
were written as:

```
if docker export "$c" | tar -tf - | grep -qE '(^|/)\.env(\.|$)'; then
```

Under `set -o pipefail`, `grep -q` stops reading at the first match, closing
the pipe and killing `docker export` with SIGPIPE. The pipeline's exit status
was therefore non-zero **precisely when a secret was found**, and the `if`
read that as "nothing found". Both filesystem checks were inverted: they could
report clean and nothing else. Only the configuration check had ever been
real.

Replaced with `grep -c`, which consumes the whole stream, testing the count
rather than the pipeline status. A container that cannot be created is now a
failure rather than a silent skip. The self-test runs in `release.yml`.

---

## 5. Staging promotion

Deployed into a clean production-like environment from the frozen digests
alone, through the twelve-step choreography, with ingress reached only by
falling off the end.

All five services verified as running exactly the frozen digests, through
`docker inspect` on the containers that exist — not through the configuration
that asked for them. The API reported commit `18d07c51d91f` through
`/health/ready` and through `palcert_build_info`. Every smoke check passed:
API, web, worker and document-engine readiness; database, Redis and
object-storage dependencies by name; metrics on both API and engine; DOCX,
PDF and evaluation capability surfaces; public certificate verification;
unauthenticated and unknown-API-client refusals; webhook keyring; Redis and
object storage asked directly; and the worker's job surface.

Ingress then opened and served through the published proxy port.

### Four defects the staging run found

1. **`--wait` on one-shot containers.** `certs` and `storage-init` exit 0 when
   done, and compose treats a listed service exiting as a failure — so the
   deployment failed because of the two containers doing exactly what they are
   supposed to. They still run, via the `service_completed_successfully`
   conditions the topology already declares.
2. **A preflight that triggered what it was meant to precede.** The "migration
   compatibility preflight" ran `migrate-check`, which `depends_on` `migrate`.
   It applied the migrations it was supposed to decide about.
3. **An empty database reported as an outage.** `check-migrations.mjs` mapped
   a missing `_prisma_migrations` table to "could not be reached", collapsing
   an outage together with the normal starting state of every new environment
   and every restore into a clean destination. Now separated: an empty schema
   exits 6 (proceed to migrate); tables present with no migration history
   exits 4, because that schema was built by something other than these
   migrations and needs a person.
4. **The malware scanner never started.** The worker sat at 503 forever, and
   it was right to: every uploaded document is scanned before anything else
   touches it, so a worker that is ready without a scanner would either
   process documents unscanned or fail every job.

### The smoke suite's own false pass

The first smoke run probed unversioned paths. The product API is URI-versioned
— a `/v1` segment that Nest's startup log does not print — so every check
returned 404. Most failed correctly. One **passed**: "public verification
rejects an unknown code", because an unserved route 404s exactly as a missing
certificate does.

It now asserts the body. `CERTIFICATE_NOT_FOUND` can only come from the
verification handler running; a generic `NOT_FOUND` is reported as the route
being missing. The version segment is read from the contracts package so a
future bump cannot silently restore the false pass.

---

## 6. Production promotion

Rehearsed on the **identical five digests** staging accepted — `images.env`
byte-identical between the two environments — through the full choreography,
in a separate environment with its own secrets. All five services verified
against the freeze record; smoke passed; ingress opened.

The promotion boundary is now a script with distinct exit codes rather than
`if:` conditions, because the only way to test the old form was to dispatch a
real production deployment from a feature branch. Ten cases:

| Case | Exit |
| --- | --- |
| a fully authorised production promotion | 0 (control) |
| staging needs no approval boundary | 0 (control) |
| promotion from a feature branch | 3 |
| promotion from a pull-request ref | 3 |
| promotion with no named approver | 4 |
| promotion with no stated reason | 5 |
| promotion with no staging record | 6 |
| promotion after staging failed | 6 |
| promotion of a manifest staging never saw | 6 |
| promotion where staging ran a different API image | 6 |

The staging evidence is checked **by manifest content hash**, not by version
string: two manifests can carry the same release name and describe different
images.

---

## 7. Rollback: A → B → A

| Step | Result |
| --- | --- |
| 1. Deploy A (`0.1.0+c136cc5`) into a clean environment | serving |
| 2. Verify A's identity | API reports `c136cc5ab509`; containers on A's digests |
| 3. Deploy B (`0.1.0+18d07c5`) over the same database | serving |
| 4. Verify B's identity | API reports `18d07c51d91f`; containers on B's digests |
| 5. Rollback safety gate, B → A | SAFE — same schema, application-only |
| 6. Roll back to A on its retained digests | serving |
| 7. Verify A is running again, then smoke | API reports `c136cc5ab509`; smoke passed |

Nothing was rebuilt or retagged. Release A's images are the bytes built when A
was cut, weeks before B existed.

---

## 8. Unsafe rollback refused

`check-rollback-safety.mjs`, six cases:

| Case | Exit |
| --- | --- |
| target expecting the same schema | 0 (permitted) |
| target one migration behind | 3 (refused) |
| target five migrations behind | 3 (refused) |
| operator has confirmed compatibility | 0 (allowed, on the record) |
| target expecting MORE migrations | 65 (not a rollback) |
| target identical to what is running | 64 (a mistake, not a no-op) |

**No reverse migration is generated anywhere.** The override flag
(`--i-have-confirmed-schema-compatibility`) is deliberately long: it is a
signed statement that someone read the migrations in the gap, not a retry.

The target manifests for the refusal cases are **fixtures, and are labelled as
such in the script**. They carry real migration states from this repository's
history; no images were built for them and nothing is deployed from them. Only
the schema expectation is under test, which is the only input the gate reads
on that path.

---

## 9. Deployment concurrency

Two promotions overlapping is the one deployment race retrying cannot fix:
both reach the migration job and the database lands somewhere neither believes
it is.

- **In CI:** `concurrency: deploy-${{ inputs.environment }}` with
  `cancel-in-progress: false` — keyed per environment so staging is not
  serialised behind production, and never cancelled, because a cancelled run
  can leave migrations applied and no application rolled out.
- **Everywhere else:** a per-environment lock in `deploy.sh`, covering an
  operator on a bastion, a recovery drill, a rollback run by hand. Its policy
  is to refuse immediately (exit 75) rather than queue: a shell script that
  queued would hold a runner and an operator indefinitely.

Proven for real: the second attempt is refused while the first holds the lock;
the lock is released when the first ends, so a failed deployment cannot block
the rollback that would fix it; and staging is not blocked by a production
deployment.

---

## 10. Failed promotions — twelve rehearsals

Each induced for real, each asserting both halves: the deployment was refused
**and** no proxy is serving. The second half is the one that matters.

| # | Failure | Refused at | Exit |
| --- | --- | --- | --- |
| 1 | image digest absent from the registry | registry verification | 65 |
| 2 | manifest commit the images contradict | registry verification | 65 |
| 3 | corrupted manifest | manifest validation | 65 |
| 4 | missing deployment secret | secrets preflight | 78 |
| 5 | missing webhook keyring | secrets preflight | 78 |
| 6 | no usable provenance | provenance verification | 65 |
| 7 | database migrated by a later release | migration preflight | 65 |
| 8 | a migration that cannot apply | the migration job | 65 |
| 9 | API never becomes ready | application readiness | 1 |
| 10 | worker never becomes ready | worker readiness | 1 |
| 11 | document engine unavailable | readiness | 65 |
| 12 | staging smoke fails | smoke, before ingress | 65 |

**In every case ingress never opened.**

Five of the twelve reported that the deployment *succeeded* on the first run.
Every one was a fault in the test, and each is recorded beside the case it
broke: environment assignments ordered so a case's own `SMOKE` was overridden
by the default; a future migration seeded into an empty database (making every
real migration merely pending, the ordinary and correctly-allowed "behind"
case); credentials changed that the dependency itself is initialised from, so
both sides simply agreed; and a fixed sleep that missed the window it was
racing.

---

## 11. Recovery from the registry

Connects this checkpoint to the 20.4 disaster-recovery model. End to end, with
nothing rebuilt:

1. deploy the frozen release;
2. register a user **through the public API**, not with an INSERT;
3. back the installation up with 20.4's tool;
4. destroy the data plane, volumes and all;
5. confirm all five digests are still pullable from the registry;
6. restore database and objects into a clean data plane;
7. boot the same five digests over the restored data;
8. confirm the user survived and the authentication path still applies its
   rules to the account.

All steps passed. `assert-frozen-images.mjs --running` confirmed every
recovered container was created from the frozen digest.

The user is created through the API on purpose: recovery has to return data
the application itself wrote, under the same validation, hashing and tenancy
rules. Registration answers 202 whether or not the address was already taken —
deliberately, so an unauthenticated caller cannot enumerate accounts — so the
database row is the evidence, not the acknowledgement.

**A tooling defect worth recording:** the host carries PostgreSQL 16 client
tools against a 17 server, and `pg_dump` refuses outright on that mismatch. It
reports it in a way that reads as a backup failure rather than a tooling one.
Backup and restore now run inside a small image with matching clients,
attached to the deployment's own internal network — which is also how an
operator reaches a production data plane, since it is not published anywhere.

---

## 12. Retained rollback artifacts

The rule: cleanup may never delete the release currently in production, the
release that is its rollback target, or the manifests, freeze records, SBOMs
and provenance belonging to either.

Ordinary retention does not give this. "Keep the last N" and "delete untagged
after D days" both assume the thing worth keeping is the thing most recently
pushed; during an incident it is the release *before* the one that broke,
which is by construction older.

`check-registry-retention.mjs` names the protected set explicitly, reports what
a cleanup pass would remove, fails if the two intersect, and verifies the
protected images are still present. It deletes nothing: a tool that both
decides and deletes is one bug away from being the incident.

Demonstrated both ways against the live registry — under a policy keeping ten
tags both releases survive; under one keeping a single tag it names the five
images of the current release that cleanup would remove.

---

## 13. The release audit record

One file — `release-record.json` — carrying version, commit, five digests,
manifest hash, migration state, schema versions, SBOM references with package
counts and content hashes, the vulnerability verdict recomputed under the
gate's own definition, provenance predicate, the staging result (including
whether staging ran the frozen digests), the approval with approver and
reason, and the outcome of every rehearsal.

It refuses to be written rather than redacting anything credential-shaped,
because a record that silently drops a field is worse than one that will not
be written. No credentials or application secrets appear in it.

---

## 14. Defects discovered during this checkpoint

| # | Defect | Where |
| --- | --- | --- |
| 1 | 46 fixable HIGH/CRITICAL, all in package managers shipped in runtime images | four Node images + engine |
| 2 | `check-image-dependencies.mjs` invoked with **no images** — inspected nothing, exited 0 | `release.yml` |
| 3 | the Prisma-CLI exemption keyed on a parse that never matches a digest reference | `check-image-dependencies.mjs` |
| 4 | the image secret scanner's filesystem checks were **inverted** and could only report clean | `check-image-secrets.sh` |
| 5 | `--wait` on one-shot containers failed the deployment | `deploy.sh` |
| 6 | the migration preflight applied the migrations it was deciding about | `deploy.sh` |
| 7 | an empty database reported as "could not be reached" | `check-migrations.mjs` |
| 8 | the malware scanner never started, so the worker could never be ready | `deploy.sh` |
| 9 | a smoke check **passed** against a URL the API does not serve | `staging-smoke.sh` |
| 10 | `pg_dump` major-version mismatch reported as a backup failure | recovery tooling |
| 11 | five of twelve failure rehearsals silently passed (four distinct test faults) | `test-failed-promotions.sh` |
| 12 | a URL passed to `psql` without stripping Prisma's `?schema=` | `disaster-recovery-negative.e2e-spec.ts` |
| 13 | a negative suite whose object cases depended on another test's leftovers | `disaster-recovery-negative.e2e-spec.ts` |

Items 2, 3, 4, 9 and 13 share a shape: a check that could not fail, or that
passed for the wrong reason. Several had been green in CI for some time. That
is why every release gate in this checkpoint now has a demonstrated refusal.

---

## 15. Gates

| Gate | Result |
| --- | --- |
| build (all packages and apps) | pass |
| typecheck | pass |
| eslint | pass |
| prettier | pass |
| `@palcert/config` unit | 88 passed |
| `@palcert/contracts` unit | 819 passed |
| `apps/web` unit | 520 passed |
| `apps/api` unit | 644 passed, 5 skipped |
| ruff | pass |
| mypy (`app`) | Success — no issues in 102 source files |
| pytest | 1877 tests, exit 0 |
| generated-contract drift (IANA) | pass |
| docs phase check | pass |
| release manifest and tooling tests | 33 in `release-manifest.spec.ts` |
| real registry push / pull / digest verification | 15/15 |
| SBOM generation | 5 SBOMs, 1267 packages total |
| vulnerability scan | 0 fixable HIGH/CRITICAL |
| secret scan | clean, 5 images |
| secret-scan self-test | both leak shapes detected, control accepted |
| provenance verification | 5/5 SLSA v1 |
| production image gates | pass, all five by digest |
| substitution refused | 5 cases |
| promotion boundary | 10 cases |
| staging promotion rehearsal | pass |
| production promotion rehearsal | pass |
| deployment concurrency | 6 checks |
| rollback rehearsal A→B→A | pass |
| incompatible-rollback refusal | 6 cases |
| failed promotions | 12 cases, ingress never opened |
| recovery from registry | pass |
| registry retention | pass, and refuses a keep-1 policy |
| full API e2e (one run) | **76 suites passed, 1354 tests passed, 0 failed, 10 skipped** |

The three consecutive full e2e runs remain reserved for the final Phase 20
release candidate (Checkpoint 20.9).

---

## 16. Final e2e run

On the final committed tree, at `7286dd0`:

```
Test Suites: 3 skipped, 76 passed, 76 of 79 total
Tests:       10 skipped, 1354 passed, 1364 total
Time:        1915.698 s
```

One run, as Checkpoint 20.5 requires. The three consecutive runs remain
reserved for the final Phase 20 release candidate.

### Two e2e failures, and what they were

The first full run of this checkpoint failed two tests, both in
`disaster-recovery-negative.e2e-spec.ts`. Neither was caused by this
checkpoint's work; both were latent faults in the 20.4 negative suite that
this run happened to expose.

1. **`psql: error: invalid URI query parameter: "schema"`.**
   `DATABASE_ADMIN_URL` carries `?schema=public`, which Prisma understands and
   libpq does not. The backup and restore tooling has always normalised this
   (`toLibpqUrl`), and the drill spec strips it inline; this suite's own `psql`
   helper passed the URL through unchanged, so it could only ever work against
   a URL that happened not to carry the parameter.

2. **`Cannot read properties of undefined (reading 'zone')`.** The suite took
   its baseline backup of the live database, so the object manifest contained
   objects only if an earlier suite had left document rows behind. The two
   tests that corrupt an object therefore passed or failed according to suite
   ordering — they passed on one full run this session and failed on the next,
   with nothing between them touching backups. It now builds the recovery
   fixture itself, through the same real workflows the drill uses, and asserts
   the baseline archive actually contains objects, so a future regression says
   what it is instead of surfacing as an undefined array element.

Both are recorded here rather than quietly fixed, because the second is the
more interesting one: a negative test that depends on another test's leftovers
is not testing what it claims to, and it had been green.

---

## 17. F-013

**F-013 — CLOSED.**

- **Deployment** — demonstrated into staging and a production-like environment,
  through a twelve-step choreography where ingress is reached only by falling
  off the end, with twelve rehearsed failure modes none of which reached
  ingress.
- **Immutable promotion** — the same five digests served staging and
  production, byte-identical, with the no-rebuild property asserted from the
  containers that exist and substitution refused in five distinct ways.
- **Rollback** — A → B → A on real retained digests, identity verified from the
  running system at every step, with the unsafe case refused six ways and no
  reverse migration invented.

What is *not* claimed: provenance is verified as present and correctly typed,
not cryptographically verified against a trust root, because PalCert does not
yet have one. The rehearsal registry is a real OCI registry reached over plain
HTTP on loopback; production registries are HTTPS and the `--insecure-registry`
flag is opt-in for exactly this reason.
