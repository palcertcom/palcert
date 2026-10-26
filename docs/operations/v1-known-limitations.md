# PalCert v1 — known limitations and the post-v1 backlog

Written at the v1 release (Phase 20 Checkpoint 9) for release commit
`4554c7a2f88c148e16e4e2f93801d1c9df1e0df6`, release `0.1.0+4554c7a`.

A documented limitation is not automatically a release blocker. Each entry says
what the limitation is, what it costs, what stands in for it in v1, and
whether someone has to act. Nothing listed here is a known security defect, a
known correctness defect or a known data-loss risk: those were fixed before
release. The defects Checkpoint 20.9 itself found are recorded at the end, with
their fixes, except R-9, a low-severity operability gap left for post-v1.

No new mandatory v1 phase is implied by anything here. Every item is post-v1
work, or an owner decision that the software already supports either way.

---

## 1. The release environment

These are about how v1 was verified, not about PalCert. They are listed first
because they decide what an owner has to do before the first real
production deployment.

| # | Limitation | Consequence | What stands in for it | Owner action |
| --- | --- | --- | --- | --- |
| **E-1** | **GitHub Actions has not executed any run since Checkpoint 20.1.** Every CI run from #102 to #133 concluded `failure` within seconds, with no runner assigned, no steps and no logs. That is an account-level condition, such as billing or a spending limit, not a failing test. | No Phase 20 CI gate has ever run *in CI*. `release.yml` cannot publish to GHCR, and `deploy.yml` cannot promote. | Every gate the workflows define was executed locally against the release commit, with the same scripts (§3–§12 of the final report). | Restore Actions on the account. Then push the tag `v0.1.0`, or dispatch `release.yml`, so that CI builds, gates and publishes the release. |
| **E-2** | **The rehearsed artifacts live in a rehearsal registry** (`127.0.0.1:5001/testowner`), not GHCR. | The five digests in the final report identify the images that were tested. The images `release.yml` publishes will be rebuilt from the same commit and will carry **different digests**. | `release.yml` runs the same gates before it freezes anything, and deployment is by digest from its own freeze record. | Promote only digests from the `release.yml` freeze record. Never promote the rehearsal digests to a real environment. Keep that run's manifest and freeze record beyond the artifact's 90-day retention. `fetch-manifest.sh` reads `docs/releases/0.1.0-<sha>.json` and `.freeze.json` first, but committing them needs a formatter exception first (R-9). The rehearsal records under `docs/operations/releases/` are evidence, deliberately kept out of that path. |
| **E-3** | **Sandbox build divergence.** This environment reaches package registries through a TLS-inspecting proxy, and Docker Hub rate-limited it. | Rehearsal builds bind-mounted the proxy CA into each `RUN` step (nothing reaches a layer; verified per image), and used base images pulled through `mirror.gcr.io`. | Every runtime image was checked: the trust store is identical to the base image's, there is no CA environment variable, and there is no mount stub. | None; CI builds the committed Dockerfiles unmodified. |
| **E-4** | **No SBOM attestation in the image index** for rehearsal builds (`--sbom=false`; the BuildKit scanner image is on Docker Hub). | SBOMs were produced by `generate-sboms.sh` and bound into the freeze record by digest, not attached to the image. | `release-freeze.json` → `supplyChain.sbom`. | None; `release.yml` attaches both. |
| **E-5** | **Payments were never exercised end to end with a live provider.** Calling a real payment service was out of scope, and the fake provider is refused in production. | "Enabled and available" is verified in the interface with PalCert's own availability response stubbed, and top-ups are covered by the e2e suites against the fake provider. | The release stack verifies payments enabled-but-unavailable and payments disabled; every workflow was accepted in both, with credit from audited adjustments. | Before taking real money: a Stripe test-mode top-up on staging, with real keys. |
| **E-6** | **The git tag `v0.1.0` is not on GitHub yet.** It was created, annotated, at `4554c7a` after every gate passed. Pushing it was refused (HTTP 403) because the session that ran the release may push only its working branch. | Nothing is published under the tag, and `release.yml` has not been triggered by it. | The release commit, identifier, registry tag and digests are recorded in the final report, the release records and `docs/requirements/phases.md`. | Push `v0.1.0` at `4554c7a2f88c148e16e4e2f93801d1c9df1e0df6` once Actions is restored (E-1): pushing it starts the CI release. |

---

## 2. Carried post-v1 items

| # | Item | Status in v1 | Why it is not a blocker |
| --- | --- | --- | --- |
| **P-014** | Worker memory under its own workload | **Inconclusive.** 20.6 saw +11.3 MiB/h in a 20-minute soak. 20.7's controlled 30-minute rerun showed a *negative* second-half slope (−4.05 MiB/h), so the growth did not reproduce, but the ±4.7 MiB oscillation is too wide to call it flat | A graph is not a bug report. The container-memory panel exists; the recommended worker-RSS alert needs a threshold an owner approves |
| **P-015** | Nonce or hash `script-src` | `script-src 'self' 'unsafe-inline'`, because 23 routes are prerendered and a per-request nonce cannot reach them. Everything else in the policy starts from `'none'`, including `object-src`, `base-uri` and `frame-ancestors`; `connect-src` and `form-action` are same-origin, and there is no `unsafe-eval` in production | The escalation paths out of an injection are closed. Making the prerendered routes dynamic is an architectural change |
| **F-020** | Licence scan in CI | Absent. Image vulnerability scan, SBOMs, secret scan (with its negative test), dependency gate and provenance are all present | No licence obligation is known to be violated. It is the missing half of F-020 |
| **P-004** | Distributed tracing, API → worker → engine | Not built. There are request ids in every log line and job ids across the worker, plus the 20.3 metrics | Tracing is a diagnosis aid, not a correctness property |
| **P-011** | WAL archiving and point-in-time recovery | Not built. The RPO is the backup interval | A restore has been performed into a clean environment, re-verified through the application and rehearsed from the registry (20.4, 20.9) |
| **P-012** | Automated cross-region backup replication | Not built | Where backups are stored is the operator's decision |
| **P-013** | Automated restore drills on a schedule | Not built. `recovery-from-registry.sh` is the drill, run by hand | The drill is one command and was run for this release |
| **P-001** | Partitioning / time-series storage for the highest-volume tables | Not built | 20.6 found no table close to needing it |
| **P-002** | Row-level security on the six authentication tables | Protected by the Phase 2 application-authorization decision; every tenant table has FORCE RLS | Defence in depth behind an authorization boundary that holds |
| **P-003** | Multi-region / active-active | Out of scope (ADR-0006) | — |
| **P-005** | Data-subject export and erasure tooling | Not built | Pending the owner's decision on the applicable regime (§3) |
| **P-006** | A public status page | Not built | — |
| **P-007** | Worker autoscaling policy | Not built. `WORKER_CONCURRENCY` is configurable | — |
| **P-008** | Per-route latency objectives and error budgets | Global objectives only: public p95 < 150 ms, authenticated p95 < 400 ms | Measured at 200/s and 90/s with wide headroom (20.6, 20.9) |
| **P-009** | Re-derive every `ASSUMPTION` alert threshold from production data | The thresholds are documented placeholders | They can only be derived from traffic that does not exist yet |
| **P-016** | Validate the Next.js server's environment at boot | The web tier reads two variables through the shared parser | — |
| **P-017** | A browser upload origin other than the web origin | v1 requires `STORAGE_PUBLIC_ENDPOINT` to be the web origin, and production refuses to boot otherwise. The edge routes the bucket paths to storage (deployment.md) | Required by the frozen CSP (`connect-src 'self'`); a separate storage origin would need a runtime-configurable CSP |
| **P-018** | The restore tool writes objects without an SSE header | It relies on the destination bucket's default encryption. The release stack sets SSE-S3 by default, and managed S3 encrypts by default | An object written without the header was verified SSE-S3 at rest in the release stack (`mc stat`). Setting the header explicitly is hardening |
| **Q-005** | The localized 404 body arrives with JavaScript, not in the HTML | Recorded in 20.8 | The status code and the page are right; only a no-JS visitor sees the fallback |
| **Citations** | Named citation-style conformance (APA, IEEE, Vancouver, Harvard, Chicago, MLA), CSL/citeproc, style conversion, bibliography rewriting, SmartFix correction of citations, the `STRUCTURED_TUPLE` shape, per-citation observed resolution | Deferred by Phase 18's own scope | Phase 18 delivered what it promised; these are the roadmap beyond it |
| **Journal** | "Scientific journal enhancements" | Deferred with no phase number, pending roadmap approval (`docs/requirements/phases.md`) | — |

The engine image carries 44 HIGH findings in Debian base packages
(util-linux family, ncurses, systemd libraries, `perl-base`) with **no fixed
version available**, the same set 20.8 recorded. The gate is "no *fixable*
HIGH/CRITICAL", and no suppression was added. Rebuild when Debian ships
fixes.

---

## 3. Values awaiting an owner decision

The software supports any of these; what it cannot do is choose.

| Value | v1 default | Source |
| --- | --- | --- |
| Database backup retention | 30 days | 20.1 §RPO/RTO |
| Object retention | versioning plus a 30-day soft delete | 20.1 |
| Who owns a restore | undefined; there is no operations team yet | 20.1 |
| Applicable data-protection regime (Palestinian law, GDPR, …) | undecided | 20.1 |
| Worker-RSS alert threshold | not set | P-014 |
| `ASSUMPTION` alert thresholds | documented placeholders | P-009 |

---

## 4. Found in Checkpoint 20.9

Recorded here because each was found only by pushing the release through the
paths people will actually use. All but R-9 were fixed before release.

| # | Defect | Severity | Fix |
| --- | --- | --- | --- |
| R-1 | No document could be uploaded through the interface of the release topology. Uploads were signed for an unpublished `https://localhost:9000`, which the frozen CSP would also refuse | RELEASE BLOCKER | A storage route on the web origin; production requires `STORAGE_PUBLIC_ENDPOINT` to be that origin; a browser upload/download check in three engines (`6a007b1`) |
| R-2 | The release stack's object store had no KMS, so every SSE write (required in production) was refused with a 501 | RELEASE BLOCKER | A per-stack SSE key, and bucket-default SSE-S3 (`6a007b1`) |
| R-3 | **A restored installation could not serve a single stored object.** No S3 API preserves version ids, and every pin still named the source store's, so every download, certificate read and report artifact failed with `NoSuchVersion` | RELEASE BLOCKER (data availability after recovery) | Restore now re-pins every version, before the immutability triggers exist, and verifies each reference by its pin (`451ecec`) |
| R-4 | gitleaks exited non-zero on the tree and on history. Every finding was a planted test value or a placeholder | Gate integrity | Inline `gitleaks:allow` plus fingerprinted `.gitleaksignore`, each entry with a reason; no rule changed (`451ecec`) |
| R-5 | `echo "$metrics" \| grep -q` under pipefail failed once the output exceeded a pipe buffer. It broke the runbook dry-run and could fail deploy step 10; CI's negated UUID check could *pass* on a leak | Gate integrity | Here-strings (`451ecec`) |
| R-6 | The rollback refusal messages named `docs/operations/rollback.md`, which did not exist | LOW (documentation) | The page, pointing at procedures that were already documented (`4554c7a`) |
| R-7 | The recovery rehearsal depended on a tools image that nothing documented how to build | Operability | The script builds it from `docker/tools/recovery-tools.Dockerfile` (`da03054`) |
| R-8 | The release tag step could not succeed: `tag-release.sh` compared each digest with buildx's human-readable listing, so `release.yml` would have failed before uploading the release record. It had never run (E-1) | RELEASE BLOCKER (CI release path) | Read the digest from `{{json .Manifest}}`; `test-tag-release.sh` shows the check passing and refusing, and runs in `release.yml` before tagging (`4554c7a`) |
| R-9 | A release manifest cannot be committed: `verify-manifest` requires the canonical serialization byte for byte, and the repository's format gate rewrites it, so a manifest under `docs/releases/` (the first place `fetch-manifest.sh` looks) fails one gate or the other | LOW (operability); **not fixed in v1** | No documented step commits a record; deployment fetches the workflow artifact (kept 90 days). Post-v1: add `docs/releases/` to `.prettierignore`, as the canonical report golden already is, in the commit that adds the first record |
