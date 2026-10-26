# PALCERT V1 FINAL PRODUCTION READINESS REPORT

_Phase 20 — Checkpoint 9: final release candidate and PalCert v1 closure._

**Scope.** Freeze one release candidate, build it once, and put those exact
bytes through every gate the release process defines: supply chain, a fresh
install, an upgrade from the Phase 19 schema, a recovery from the registry,
staging acceptance, the browser matrix, operations, security, performance,
three consecutive end-to-end runs and golden compatibility. No feature was
added, no UI redesigned, nothing tuned, and no citation intelligence or
integration changed. Every source change in this checkpoint fixed a defect
that was demonstrated first. Each one is listed in §2 with the evidence that
found it.

---

## 0. The release, in one table

| Field | Value |
| --- | --- |
| Product | PalCert |
| Application version | `0.1.0` |
| **Release identifier** | **`0.1.0+4554c7a`** (registry tag `0.1.0-4554c7a`) |
| **`PALCERT_V1_RC_COMMIT`** | **`4554c7a2f88c148e16e4e2f93801d1c9df1e0df6`** |
| Git tag | `v0.1.0`, annotated, → the RC commit. Created after every gate passed; publishing it to GitHub is an owner action (E-6) |
| Superseded candidates | `da030542242ffdbfb61610dc3c8d0a1952d17a5e` (RC1) and `451ecec9fb27b8c2a67d0e3be98464e65300fa0c` (RC2); §2 |
| Built | 2026-09-23T22:08:38Z, once, by `buildx` with SLSA v1 provenance |
| **Manifest hash** | `sha256:c6133b6db49bc81bab84547bd7b693430d7601ec303efbd97aec37c7b414dc9c` |
| Freeze record | `sha256:9cdf8ea38aaa0d8ce178552ff2cfa11163667d24d5ae5ebe53075a61e34cdee6` |
| Migration state | **64** migrations, head `20260926000000_phase20_revoke_public_function_execute`, name checksum `71cabeb9…07ea82` |
| Report schema | `REPORT_SCHEMA_VERSION` 1, canonicalization 1 |
| Certificate claim | schema 1, canonicalization 1 |
| Analyzers | DOCX analyzer `4` (envelope 2, analysis 1, facts 2, location 1, citations 1); PDF analyzer `11.0.0` (envelope 2, analysis 1, model 1, classifier 1, facts 2, location 1, citations 1); evaluation engine `1.0.0`; rule schema 2; SmartFix engine `1.0.0` (registry 2, plan 1, manifest 1); document engine `0.1.0` |
| Other schemas | extraction 1, submission evidence 1, domain event 1, AI review/context/assessment 1 |
| Machine-readable record | [`releases/0.1.0+4554c7a/`](releases/0.1.0+4554c7a/): `release-descriptor.json` (version, commit, digests, manifest hash, migration state, analyzer and schema versions, SBOM and provenance references) and `release-freeze.json`. No secrets (checked by `findSecretShapedContent`). Both bind the manifest by its hash. The manifest itself is not committed, because a canonical manifest cannot pass the repository's format gate (R-9) |

### The five images

Registry `127.0.0.1:5001/testowner` (the rehearsal registry; see E-1/E-2 in §15).

| Component | Digest | SBOM (SPDX-2.3) |
| --- | --- | --- |
| api | `sha256:890ca53000db0dd2e79efd02fc7d21eb4b16c2bfebfab0f6c4b4c9a7518e7e95` | 333 packages, `sha256:7089e812…bfe6fcb4` |
| worker | `sha256:2126e1fc7e55c711466c287c4b17399ed1d46b4f008b770c146c52af81a71935` | 333 packages, `sha256:b1b2c97f…b863c167` |
| migrate | `sha256:7bc1c438b5a9ff7d6ddd27b7bab9891bfd8102da067ed25ca7be72ca5fad5525` | 264 packages, `sha256:fa870ea7…9717cfd6` |
| web | `sha256:41b641f4da3c628d4cffbc1ce3faca4c3c0f4f94c3b3e8bcb766731689ee3f3a` | 216 packages, `sha256:69e0b066…7393719a` |
| document-engine | `sha256:7d1668d307b0e3fd5d64fabb83fea9e286fe9dfc0461050f3c9fc0618e091c17` | 122 packages, `sha256:be73f2f6…d2aae133` |

Provenance: an in-toto statement with predicate `https://slsa.dev/provenance/v1`
is attached to every image index as an OCI attestation manifest. Every image's
`org.opencontainers.image.revision` is `4554c7a2f88c…`.

---

## 1. Reconciliation (step 1)

20.8 ended with images built from `8aba095` and later commits on top of it.
`8aba095..c4bd08a` touched only `qa/lib/session.mjs`, `qa/release-checks.mjs`
and the 20.8 report. `docs/` is excluded by `.dockerignore`, and `qa/` enters
only build stages: a search of the `8aba095` images found no `qa/` path among
32 836 (api/worker), 14 803 (migrate) and 5 457 (web) files. So those
commits could not have changed an image.

Reconciliation was then overtaken: 20.9 found release-blocking defects before
freezing (§2). The release therefore has a new, single source commit, and
**every image, test and rehearsal in this report comes from it**. The only
commit after it is documentation-only (§14).

---

## 2. Defects found by this checkpoint, before and after the first freeze

R-1, R-2, R-3, R-6 and R-7 were found by sending the release down paths real
users and operators take. No existing gate could have found them; each now has
one. R-4 and R-5 were found *by* existing gates, which could not give an honest
verdict: one failed on test fixtures, and one failed on a readable
endpoint. R-8 was found by the release's own last step, which had never been
executed before. R-9 was found while committing this release's records. It
is recorded, not fixed, because no documented step depends on it.

| # | Found by | Defect | Fix |
| --- | --- | --- | --- |
| R-1 | Driving a real upload through the release stack's UI | **No document could be uploaded.** Every presigned URL was signed for `https://localhost:9000`, which nothing published and which the frozen CSP (`connect-src 'self'`) refuses anyway: the browser logged a CSP violation and the screen said "Something went wrong" | A storage route on the web origin (`release-proxy.conf`: bucket paths only, GET/PUT only, `Authorization`/`Cookie` stripped, sandboxed and `nosniff`). Production refuses to boot unless `STORAGE_PUBLIC_ENDPOINT` is the web origin. `release-checks.mjs` uploads and downloads in three engines (`6a007b1`) |
| R-2 | The same upload, one layer down | **The release stack's object store refused every encrypted write** (`501 KMS is not configured`); production requires SSE | A per-stack SSE key in a volume only MinIO mounts, plus bucket-default SSE-S3 (`6a007b1`) |
| R-3 | The upgrade rehearsal (Phase 19 data, restored, then upgraded) | **A restored installation could not serve a single stored object.** No S3 API preserves version ids, and every pin still named the source's, so every document download, certificate read and report artifact failed with `NoSuchVersion` while rows, hashes and public verification looked perfect | `restore.mjs` loads tables and rows, uploads objects recording the new ids, re-pins every version before the immutability triggers exist, then applies post-data and verifies each reference by its pin. `disaster-recovery.e2e-spec.ts` now reads every pin back by version (`451ecec`) |
| R-4 | The RC1 supply-chain gate | gitleaks exited 1 on the tree (5) and history (9). Every finding, checked by hand, was a planted test value or a placeholder | Inline `gitleaks:allow` and a fingerprinted `.gitleaksignore`, each with its reason. No rule changed, nothing real excused (`451ecec`) |
| R-5 | The RC1 runbook dry-run | `printf "$metrics" \| grep -q` under pipefail reported readable metrics as unreadable once the exposition outgrew a pipe buffer. Deploy step 10 had the same shape, and CI's negated UUID check could *pass* on a leak | Here-strings (`451ecec`) |
| R-6 | The rollback refusal rehearsal | Two refusal messages cite `docs/operations/rollback.md`, which did not exist; the procedure was documented under other names | The page, pointing at the procedures (`4554c7a`) |
| R-7 | Running the recovery rehearsal from a clean machine | It needed a tools image that nothing said how to build | Built from `docker/tools/recovery-tools.Dockerfile` on demand (`da03054`) |
| R-8 | Tagging RC2, after every RC2 gate had passed | **The release workflow's tag step could not succeed.** `tag-release.sh` read each tag's digest with `{{.Manifest.Digest}}`, which buildx answers with its human-readable listing, so the check refused every image of every release. In `release.yml` it runs before the release record is uploaded, so a CI-published release would have had no record to promote from. It had never run, because the workflow never has (E-1) | Read `{{json .Manifest}}`. `test-tag-release.sh` runs the real script against a stand-in `docker` that answers as buildx does: an honest registry is accepted, a moved tag is refused (65), and the previous script fails exactly as RC2 did. `release.yml` runs it before tagging (`4554c7a`) |
| R-9 | Committing this release's records | **A release manifest cannot be committed to the repository.** `verify-manifest` requires the canonical serialization byte for byte, and the repository's format gate rewrites that layout, so a committed manifest fails one gate or the other. `fetch-manifest.sh` reads committed records first; the documented process fetches the workflow artifact, which `release.yml` keeps for 90 days | **Not fixed in v1**, and not a blocker: no documented step commits a record. Post-v1, exempt `docs/releases/` from the formatter, as the canonical report golden already is ([register](v1-known-limitations.md), R-9) |

**RC history.**
- **RC1 `da03054`** was frozen and built. It passed every supply-chain gate
  except the repository secret scan (R-4), and passed a fresh install and
  acceptance. Its dress rehearsal then found R-3, R-4 and R-5, all of which
  needed source changes, so RC1 was superseded rather than patched.
- **RC2 `451ecec`** passed every gate in this report, including three
  consecutive full e2e runs (1 398 passed, 0 failed, each), and then failed
  at the tag step (R-8). The fix is a change to a release script, and any
  required change starts a new candidate, so RC2 was superseded too.
- **RC3 `4554c7a` is the release.** Its diff from RC2 is five files:
  `tag-release.sh`, its new test, `release.yml`, one row of the gate table and
  `rollback.md`. No application source, Dockerfile, migration, product test or
  golden changed. That shortened nothing: all five images were rebuilt from
  RC3, and **every result below is for RC3's five digests**, with every gate
  re-run. Nothing was rebuilt after the digests were recorded.

---

## 3. Supply chain (steps 3–5)

| Gate | Result |
| --- | --- |
| Five images, built once from the RC with provenance | ✅ `buildx --provenance=mode=max`, pushed by digest |
| Manifest verified against the registry | ✅ 15/15: every digest resolves, every image built from `4554c7a` |
| `org.opencontainers.image.revision` = RC, all five | ✅ |
| No build-time CA in any runtime image | ✅ Trust store identical to base; no CA env; no mount stub |
| Dependency and runtime-tooling gate | ✅ No development-only package, no package manager or build tooling |
| Vulnerability scan (Trivy, DB updated 2026-09-23) | ✅ **0 fixable HIGH/CRITICAL**; api, worker, migrate and web have 0 findings at all. The engine has 44 unfixed HIGH in Debian base packages (no fix exists; the same set as 20.8); no suppression was added |
| SBOM, one per image | ✅ SPDX-2.3, bound into the freeze by digest |
| Image secret scan | ✅ Configuration and filesystem clean, all five |
| Planted-secret negative self-test | ✅ A credential in the image configuration and a fixture credential in a layer are both refused; the clean image is accepted |
| Repository secret scan (gitleaks, full history and RC tree) | ✅ No leaks; a planted AWS-shaped key is detected (exit 1) |
| Provenance verification | ✅ SLSA v1, all five |
| Production-bundle forbidden-origin scan | ✅ 75 client assets, no deployment placeholder |
| Freeze, descriptor, substitution refusal | ✅ A tag for a digest, one image swapped, an image missing and a rewritten commit are all refused; the honest rendering is accepted |
| The tag check can pass and can fail | ✅ `test-tag-release.sh`: an honest registry is accepted; a moved tag is refused (65), for the first image and for a later one |

---

## 4. Fresh install from empty infrastructure (step 6)

Zero volumes → `deploy.sh`: manifest, registry and provenance, secrets,
migration preflight, frozen digests, internal services, **one** migration job,
migration state verified at the head, application services, readiness and
release identity, worker, smoke, **then** ingress. **12/12 in 67 s.** All five
running images are exactly the frozen digests.

Acceptance on the fresh install: **34/34**.

---

## 5. Upgrade from the Phase 19 schema (step 7)

The source is the Phase 19 application itself (`b2bd416`, 62 migrations, head
`20260924000100_phase19_audit_actor`) running the recovery fixture: two
users, an organization, DOCX and PDF documents through scan, promotion and
both analyzers, free, paid and PDF checks, a report, a submission that was
reviewed and approved, an issued certificate, a sealed webhook endpoint, an
API client, and notifications. It was backed up with the release's own tool.

`upgrade-rehearsal.sh`:

| Step | Result |
| --- | --- |
| Restore into an empty data plane | ✅ 9 objects; 9 version pins moved; 9 hash-verified by pin |
| Starting point | ✅ 62 applied, head `…phase19_audit_actor`; 2 of the release's migrations not applied |
| `deploy.sh` over it | ✅ The migration job ran once and applied exactly 63 and 64; the gate passed; **no manual SQL** |
| Frozen digests running | ✅ |
| Migration history after | ✅ 62 → **64**, identical to the release's migrations directory |
| RLS, policies, grants, ledger, certificates | ✅ `verify-restore` clean |
| Phase 19 data through the release | ✅ DOCX and PDF byte-identical; the report hash is unchanged; the certificate verifies publicly by its code and reads for its owner; the webhook URL decrypts under the keyring; the institution still cannot read the author's document; a new upload is scanned, promoted and Ready |

There is no downgrade step. PalCert ships no down-migrations, and rolling back
across one was refused (§10).

---

## 6. Recovery from the registry (step 8)

`recovery-from-registry.sh` on RC3 artifacts only, nothing rebuilt:

1. Deploy from digests.
2. Create real data with `acceptance.mjs`.
3. Back up.
4. **Destroy the data plane, volumes included.**
5. Confirm all five digests are still pullable.
6. Restore (8 objects, 8 pins moved).
7. Boot the same digests over the restored data.
8. Verify.

| Property | Result |
| --- | --- |
| Object hashes | ✅ 8/8 hash-verified by pinned version; both documents byte-identical through the API |
| RLS, grants, policies | ✅ The app role cannot bypass RLS and is not superuser |
| Ledger | ✅ No duplicate entry, none negative, integer amounts; the balance equals the pre-disaster balance |
| Report hashes | ✅ DOCX and PDF unchanged |
| Certificate verification | ✅ Public verification by code, owner read, claim and code hashes intact |
| Webhook encrypted state | ✅ The URL decrypts under the restored keyring |
| API-client state | ✅ The stored secret still authenticates on the machine surface |
| MFA | ✅ The administrator signs in with the enrolled TOTP (MFA secrets decrypt) |
| Job recovery | ✅ No succeeded job holds a lease; in-flight jobs are visible to the reaper; a new upload flows through the recovered worker |

The documented emergency redeploy (release-delivery.md §10) was also run as
written. `fetch-manifest.sh` returned the manifest and freeze record from a
committed-style record, byte-identical. `verify-manifest --registry-check`
passed 14/14, the rendered deployment environment was identical to staging's,
and an unknown release was refused (exit 65).

---

## 7. Staging acceptance (step 9)

Staging deployed from the exact RC digests; no rebuild anywhere.

| Area | Result |
| --- | --- |
| Readiness / liveness | ✅ `status: ok`, `release.commit = 4554c7a…`; database, Redis and storage ok |
| Proxy smoke | ✅ `staging-smoke.sh` in every deploy; proxy security smoke 27/27 |
| Critical API paths, DOCX and PDF workflows, public verification, institution, API-client and webhook flows | ✅ `acceptance.mjs` **34/34**. Admin bootstrap with MFA; a separate finance role; price and audited credit; institution verified; DOCX and PDF standards; both documents uploaded through the proxy, scanned, promoted, fingerprinted and downloaded byte-identical; paid checks on both analyzers with report hashes; submission, review, approval; certificate issued, PDF downloaded and publicly verified (and a wrong code refused); API client reads the submission and certificate (and a wrong secret gets 401); webhook sealed and its secret never shown again |
| Payments disabled | ✅ Redeployed with `PAYMENTS_ENABLED=false`: acceptance 34/34; release checks 17/17 |
| Payments enabled | ✅ The deployed state is `enabled: true, available: false` (no route to a provider). "Available" was verified in the browser with PalCert's own availability response stubbed. No real payment service was called, and the fake provider is refused in production by design (E-5) |
| Production promotion rehearsal | ✅ The same digests; acceptance 34/34 on the production rehearsal |

---

## 8. UX (step 10)

The web image changed since 20.8, so the **complete matrix was re-run on the RC
web digest**: **960/960 steps, 0 findings**. That is Chromium, Firefox and
WebKit × EN/AR × phone, tablet, laptop and desktop, across the public-visitor,
authenticated-user, organization-admin, keyboard-and-focus and
error-and-slow-states journeys, in 33 minutes. The page guard is zero-tolerance
for uncaught exceptions, hydration failures, CSP violations, mixed content,
development origins and raw translation keys. Axe-core scans run inside the
public, authenticated and organization journeys.

`release-checks.mjs`: **46/46**. These cover:
- privacy through the interface, with its control
- webhook UX and the SSRF refusal
- all three payment states
- render failure in both locales
- typing before hydration
- **new:** an upload through the UI in Chromium, Firefox and WebKit, reaching Ready, with a byte-identical download
- probes of the storage route: no listing, unsigned requests refused, other methods refused, responses sandboxed and `nosniff`.

---

## 9. Operations (step 11)

Every command is documented; `runbook-dry-run.sh` checks that.

| Proof | Result |
| --- | --- |
| Identify the release | ✅ `/health/ready` → `release.commit`; `palcert_build_info`; manifest and descriptor |
| Migration status | ✅ Deploy steps 7–8 and `migrate-check`; `migrations:check` before every e2e run |
| Readiness | ✅ |
| Metrics | ✅ Readable on the deployment network, 404 through the proxy, bounded cardinality under load, no identifier in the exposition |
| Alert configuration | ✅ 25 alerts, each explained in the runbook |
| Backup | ✅ `backup.mjs`, consistent snapshot plus object closure |
| Restore verification | ✅ `restore.mjs` (now re-pinning) plus `verify-restore.mjs` |
| Staging deploy | ✅ §4, §7 |
| Production promotion rehearsal | ✅ Staging record written; promotion allowed; **boundary 10/10**: a feature branch, a PR ref, no approver, no reason, no staging record, failed staging, an unseen manifest and a different API image are all refused |
| Rollback | ✅ `0.1.0+451ecec → 0.1.0+4554c7a → 0.1.0+451ecec` (RC2 as the prior release), identity and frozen digests verified at each step, 184 s. RC3 → `0.1.0+18d07c5` (one migration behind) **refused, exit 3**, pointing at `rollback.md`; `test-rollback-refusal.sh` passes |
| Runbook dry-run | ✅ **31/31**: "every step is doable from the documentation alone" |

---

## 10. Security (step 12)

The Checkpoint 20.7 security semantics are frozen, and none changed. The
storage route adds a surface; it is tested, and it carries its own sandboxing
CSP.

| Gate | Result |
| --- | --- |
| Proxy security smoke | ✅ 27/27: headers, CSP, HSTS, CORS allow and deny plus preflight, forwarded headers overwritten, metrics 404, no stack traces |
| Browser security | ✅ No CSP violation and no off-origin API call on prerendered, RTL, dynamic and authenticated routes |
| Tenant isolation, certificates, ledger, jobs, webhooks, machine auth under load | ✅ `safety-under-load.sh`, all checks |
| Security e2e suites (upload boundary, SSRF, isolation, API clients, webhooks, finance, certificates, edge) | ✅ Included in each of the three full e2e runs (§12) |
| Secret scanning and supply chain | ✅ §3 |
| Production configuration refusals | ✅ `load-env.spec.ts`: now including `STORAGE_PUBLIC_ENDPOINT` |

---

## 11. Performance (step 13)

A smoke to catch gross regressions, not a benchmark. As in 20.6, the stack
under capacity measurement ran with `API_RATE_LIMIT_LIMIT=1000000` so that it
measures the application, not the throttle. The shipped limit was restored
afterwards and verified.

| Profile | 20.9 | 20.6 baseline | Objective |
| --- | --- | --- | --- |
| CI k6 smoke | 242/242 checks; health p95 2.68 ms | 241/241; p95 1.58 ms | all thresholds |
| Public verification, 200/s, spread clients | 200.0/s achieved, p95 **8.03 ms**, 0 dropped, checks 100% | 200/s, p95 5.48 ms | p95 < 150 ms |
| Authenticated navigation, 90/s | 89.5/s achieved, p95 **29.9 ms**, 0 failed, checks 100% | 89.5/s, p95 26.86 ms | p95 < 400 ms |
| Distributed rate limit, two API replicas | **120/200 allowed** at the shipped 120/60 s: one budget | same | one budget |
| Verification guard, two replicas | **60/90 allowed** at 60/15 min: one budget | same | one budget |

Public verification is 1.5× and authenticated navigation 1.1× the 20.6
figures, on a shared host that was running other stacks, and both are more
than 13× inside their objectives. That is not a regression signal. Half of the
public profile's requests ask for unknown codes on purpose, so k6 counts their
404s as `http_req_failed`; every check passed.

---

## 12. Three consecutive end-to-end runs (steps 14–15)

Each run started from an empty schema migrated to the RC's migrations, and
**the migration history was proven identical to the source before the suite
ran** (`migrations:check: OK 64 migration(s), database is at the code's
level`). Same commit, clean tree, `--runInBand`, no retries.

| Run | Commit | Migration check | Suites | Passed | Skipped | Failed | Duration |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | `4554c7a` | ✅ OK, 64 migrations, at the code's level | 79 passed, 3 skipped, of 82 | 1 398 | 10 | **0** | 1 615 s |
| 2 | `4554c7a` | ✅ OK, 64 migrations, at the code's level | 79 passed, 3 skipped, of 82 | 1 398 | 10 | **0** | 1 669 s |
| 3 | `4554c7a` | ✅ OK, 64 migrations, at the code's level | 79 passed, 3 skipped, of 82 | 1 398 | 10 | **0** | 1 667 s |

The three skipped suites are `ai-live-smoke`, `extraction-live-smoke` and
`stripe-live-smoke`, which run only with live provider credentials. A release
test must not use those; no real payment service may be called. Their tests
are the skipped tests counted above, and the same three suites were skipped in
every earlier checkpoint. Nothing was skipped for this release.

Around them, on the RC tree:
- unit tests: **2 282** passed (contracts 819, config 234, API 659 with 5 skipped, web 567, database 3)
- document engine: **1 877** tests, 1 792 passed, 85 skipped, 0 failed
- lint, typecheck and format all clean
- the disaster-recovery drill and its negative suite, including the new read of every pin by version, pass inside each of the three runs.

---

## 13. Golden compatibility (step 16)

| Golden | Result |
| --- | --- |
| Report canonical hash (`verify:report-golden`) | ✅ "The report golden verifies" |
| Certificate claim hashes, report canonicalization, rule canonical form, submission evidence, cross-language evaluation parity | ✅ 176/176 |
| Golden PDF corpus, analyzer fixtures | ✅ Inside the 1 877-test engine suite |
| Stored-analysis compatibility | ✅ Phase 19 analyses, a report and a certificate read back through the release with unchanged hashes (§5). Between `b2bd416` and the RC the analyzers changed only by metrics instrumentation; every analyzer, envelope and schema version is identical |
| **No golden updated** | ✅ `git diff c4bd08a 4554c7a` touches no golden, corpus, fixture or snapshot file |

---

## 14. Release identifier, tag, retention and documentation (steps 17–19)

- **Identifier.** PalCert never reserved a semantic v1 tag, so the established
  policy applies:
  - release `0.1.0+4554c7a`
  - registry tag `0.1.0-4554c7a`
  - git tag `v0.1.0`: `release.yml` triggers on `v*` tags, and the production ref policy accepts `refs/tags/v*`.

  The tag was created only after every gate in this report was green. It is
  annotated at `4554c7a`. This session's GitHub access pushes only its working
  branch, so publishing the tag is an owner action (E-6). Pushing it starts
  `release.yml`, so it belongs with restoring Actions (E-1).
- **Registry tag.** Applied with `tag-release.sh`, which copies inside the
  registry, so the digests are unchanged, and which now proves that every tag
  resolves to its recorded digest (R-8).
- **Retention.** `check-registry-retention.mjs --keep 10` protects `0.1.0+4554c7a`
  (production) and `0.1.0+451ecec` (its rehearsed rollback target). All ten
  protected digests survive a cleanup pass, and no tag is eligible for
  deletion. A keep-1 policy is refused (exit 65) because it would delete the
  rollback target's images.
- **Documentation**, in one documentation-only commit after the RC:
  - this report
  - [`v1-known-limitations.md`](v1-known-limitations.md)
  - the release records under [`releases/0.1.0+4554c7a/`](releases/0.1.0+4554c7a/)
  - `docs/requirements/phases.md`, where Phases 18, 19 and 20 are **Complete** and deferred items are in the post-v1 backlog.

  `docs/` is excluded from every image build, so the commit cannot change an artifact.

---

## 15. Known limitations (step 20)

The full register is [`v1-known-limitations.md`](v1-known-limitations.md).
The ones an owner must act on before real production:

- **E-1 — GitHub Actions has executed nothing since 20.1** (#102–#133: failure
  in seconds, no runner). This is an account-level condition. No Phase 20 CI
  gate has run in CI; every gate was run locally on the RC. **Restore Actions,
  then let `release.yml` build, gate and publish `v0.1.0`.**
- **E-2 — The tested digests are in a rehearsal registry.** `release.yml` will
  publish different digests for the same commit, and they pass the same gates
  there. Promote only from its freeze record.
- **E-5 — No live payment provider was exercised.** Run a test-mode top-up on
  staging with real keys before taking money.
- **R-9 — Release records cannot be committed yet.** Keep this release's
  manifest and freeze record beyond `release.yml`'s 90-day artifact retention.
  Exempt `docs/releases/` from the formatter before committing any there.
- **E-6 — The git tag `v0.1.0` is not yet on GitHub.** It was created, annotated,
  at the RC after every gate passed. Pushing it was refused (HTTP 403) because
  this session may push only its working branch. **Push `v0.1.0` once Actions
  is restored**, which also starts the CI release (E-1).

Carried post-v1 items:
- **P-014** worker memory, inconclusive
- **P-015** CSP nonce
- **F-020** licence scan
- **P-004** distributed tracing
- **P-011** PITR/WAL
- **P-012/P-013** backup replication and scheduled drills
- the citation roadmap
- **Q-005**, the localized 404 body needs JavaScript
- **P-017** a separate storage origin
- **P-018** an explicit SSE header on restore writes.

None is a security defect, a correctness defect or a data-loss risk.

---

## 16. Verdict

Every mandatory gate passed on the single release candidate
`4554c7a2f88c148e16e4e2f93801d1c9df1e0df6`, with the five digests above, and
nothing was rebuilt between gates:

| Gate | |
| --- | --- |
| Reconciliation and single source commit | ✅ |
| Five images from the RC, revision labels | ✅ |
| Final manifest, descriptor, no secrets | ✅ |
| Supply chain (scan, SBOM, secrets and negative test, provenance, bundle, dependencies) | ✅ |
| Fresh install | ✅ |
| Upgrade from Phase 19 | ✅ |
| Recovery from the registry | ✅ |
| Staging acceptance (payments enabled and disabled) | ✅ |
| UX: full matrix on the RC web image; release checks | ✅ |
| Operations: identify, migrate, ready, metrics, alerts, backup, restore, promote, rollback | ✅ |
| Security | ✅ |
| Performance smoke | ✅ |
| Three consecutive e2e runs, zero failures | ✅ |
| Migration history proven before each run | ✅ |
| Golden compatibility | ✅ |
| Release identifier and tag | ✅ Registry tag applied and verified against every digest; git tag created at the RC (publication: E-6) |
| Retention | ✅ |

PALCERT V1 PRODUCTION READY — DEVELOPMENT ROADMAP COMPLETE

PHASE 20 COMPLETE
