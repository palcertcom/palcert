# Release delivery

How a PalCert release is built, identified, verified, promoted and rolled
back. Written for whoever is holding the pager, which is why every procedure
says what to do when it goes wrong rather than only when it works.

Companion documents: [deployment.md](deployment.md) for the runtime topology,
[backup.md](backup.md) and [restore.md](restore.md) for the data plane,
[disaster-recovery.md](disaster-recovery.md) for the scenarios.

---

## The model, in one page

A PalCert release is **five OCI images built once from one commit**: `api`,
`worker`, `migrate`, `web` and `documentEngine`. They are deployed together or
not at all. Promoting four of them and rebuilding the fifth produces a system
nobody tested, under a version string claiming otherwise.

Every image is addressed by **digest**, never by tag. A tag is a label that
anyone who can push may move to different bytes; a digest *is* the bytes. Tags
exist for humans to read and appear nowhere in a deployment.

Three files carry a release, and they are distinct on purpose:

| File | What it asserts |
| --- | --- |
| `release-manifest.json` | what the release *is*: version, commit, five digests, migration state, schema versions |
| `release-freeze.json` | that this exact manifest — by content hash — was accepted, with the supply-chain evidence gathered against those digests |
| `release-descriptor.json` | everything above in one place, plus the analyzer and schema versions that decide what a stored report or certificate claim means (`describe-release.mjs`) |
| `release-record.json` | what happened to it: staging result, who approved production, rollback rehearsal, scan outcomes |

Version strings are SemVer with build metadata: `0.1.0+18d07c5`. The registry
tag replaces `+` with `-` (`0.1.0-18d07c5`), because OCI tags forbid `+`.

**Nothing in the release path builds anything.** Staging, production, rollback
and post-disaster redeployment all resolve digests and start containers.

---

## 1. Building a release candidate

Release builds run from `.github/workflows/release.yml`. It builds each image
once, pushes it, and records the digest the registry returned — not a digest
computed locally, because the artifact is what the registry holds.

```
gh workflow run release.yml --ref main
```

The workflow, in order: the full CI gate suite; five image builds with
provenance and SBOM attestation; the runtime image gates; the vulnerability
scan; SBOM generation; the image secret scan and its self-test; the manifest;
the freeze record; the substitution refusal proof; and finally the
human-readable tag, applied only to images that already exist by digest.

To build without publishing (a dry run), dispatch with `publish: false`. The
manifest is still produced and verified; nothing is pushed and no tag moves.

**If the build fails at the vulnerability scan.** Read
`scan/palcert-*.json`. The gate blocks only on HIGH and CRITICAL findings that
have a fix available; anything else is reported and does not block. If the
finding is in a base image rather than in PalCert's own dependencies, the fix
is usually to stop shipping whatever carries it — Checkpoint 20.5 removed npm
and setuptools from the runtime images for exactly this reason, taking the
release from 46 fixable findings to zero. Suppressing a finding is a last
resort and belongs in a commit message, not in a scanner flag.

---

## 2. Finding a release's image digests

From the freeze record, which is the authority:

```
python3 -c "import json;print(json.dumps(json.load(open('release-freeze.json'))['images'],indent=2))"
```

From a running deployment, which answers a different and often more urgent
question — *what is actually running right now*:

```
docker inspect palcert-release-api-1 --format '{{.Config.Image}}'
curl -sk https://<host>/health/ready | python3 -m json.tool   # reports the commit
curl -sk https://<host>/metrics | grep palcert_build_info
```

If those two disagree, trust the container and the endpoint: the freeze record
says what should be running, and they say what is.

From the registry, for a release whose files you do not have:

```
docker buildx imagetools inspect ghcr.io/<owner>/palcert-api:0.1.0-18d07c5 \
  --format '{{json .Image}}' | python3 -m json.tool | grep revision
```

The `org.opencontainers.image.revision` label records the commit each image
was built from. It is what proves a manifest names the right images.

---

## 3. Reading and verifying a manifest

```
node scripts/release/verify-manifest.mjs \
  --manifest release-manifest.json \
  --expect-commit <sha> \
  --registry-check
```

Fifteen checks: the manifest is well formed and in canonical form, carries
nothing credential-shaped, names five distinct digests, is for the expected
commit, every digest resolves in the registry, and every image reports the
release's commit as the one it was built from.

That last check exists because a manifest assembled from the wrong images is
otherwise indistinguishable from a correct one: the digests exist, the version
is well formed, and every field agrees with every other field. The only thing
that disagrees is the image.

**`--insecure-registry`** is only for a plain-HTTP rehearsal registry.
Production registries are HTTPS and stay verified.

**If a digest does not resolve**, the image is gone from the registry or the
credentials cannot see it. Check retention (§11) before assuming the former.

---

## 4. Promoting to staging

```
gh workflow run deploy.yml -f release-version=0.1.0+18d07c5 -f environment=staging
```

Or directly, which is what the workflow does:

```
node scripts/release/render-deploy-env.mjs \
  --manifest release-manifest.json --out images.env

FREEZE=release-freeze.json \
ENVIRONMENT_FILE=/path/to/staging-secrets.env \
DEPLOY_ENVIRONMENT=staging \
SMOKE=scripts/release/staging-smoke.sh \
  bash scripts/release/deploy.sh release-manifest.json images.env
```

The twelve steps, and why the order is the safety property:

| # | Step | Why here |
| --- | --- | --- |
| 1 | validate the manifest | cheapest refusal available |
| 2 | verify registry objects and provenance | before anything is pulled |
| 3 | verify this environment's secrets | nothing has started yet, so a missing secret costs nothing |
| 4 | migration compatibility preflight | *before* the schema changes |
| 5 | prove the configuration names the frozen digests | last gate before this release runs at all |
| 6 | internal services | database, cache, object storage, malware scanner |
| 7 | the migrate image, once | the only schema-mutating path |
| 8 | verify the migration state | the job exiting 0 is not the same as the database being here |
| 9 | application services | engine, API, web |
| 10 | readiness and release identity | asked of the running system, not the deploy tool |
| 11 | the worker | after the stack has proved itself |
| 12 | smoke, then ingress | ingress last, and only if smoke passed |

**Ingress is reached only by falling off the end.** Any failure exits non-zero
and leaves the proxy unstarted, so an unhealthy candidate is never addressable
from outside. Twelve failure modes are rehearsed in
`scripts/release/test-failed-promotions.sh`, each asserting both halves:
refused, *and* no proxy serving.

### Acceptance: can anyone actually use it?

`staging-smoke.sh` proves a deployment is wired. Checkpoint 20.9 found a
release stack that passed every smoke and could not store a single document,
so staging acceptance also runs the product's critical workflows through the
published surface:

```
BASE=https://staging.example.org PROJECT=palcert-staging \
  node scripts/release/acceptance.mjs --out acceptance.json
```

It bootstraps an administrator with the documented CLI
(`docs/security/admin-bootstrap.md`), who enrolls MFA and grants a separate
finance role; finance prices the check and credits an author through an
audited adjustment (no payment provider is called); an institution is verified
and publishes a DOCX and a PDF standard; the author uploads both documents
through the proxy, buys a check of each and submits one; the institution
approves; the certificate is issued, downloaded and verified publicly by its
code; an API client reads the submission and a webhook endpoint is sealed
under the keyring. One documented shortcut: with no email provider configured
the verification mail goes nowhere, so the address is marked verified with a
single SQL statement, as `qa/seed-fixture.mjs` does. The summary it writes
holds identifiers, hashes and verdicts only.

Run it twice for a release: once as deployed, and once redeployed with
`PAYMENTS_ENABLED=false`, where every workflow must still pass because credit
comes from an adjustment rather than a top-up.

### Upgrading an existing installation

```
FREEZE=release-freeze.json SECRETS=/path/to/secrets.env \
SOURCE_BACKUP=/backups/palcert-<timestamp> SOURCE_STATE=/secure/state.json \
  bash scripts/release/upgrade-rehearsal.sh
```

Restores a backup of the installation being upgraded into an empty data plane,
proves it is at the earlier schema level with the release's own migrations not
applied, deploys the release with `deploy.sh` (its migration job applies
exactly the missing migrations, once, with no manual SQL), then verifies the
schema against the release's migrations and reads the earlier data back
through the new application with `acceptance.mjs --verify`. For v1 the source
is the Phase 19 schema (62 migrations, head
`20260924000100_phase19_audit_actor`), populated by the Phase 19 application
itself running `apps/api/test/recovery-fixture.e2e-spec.ts` with
`DRILL_FIXTURE_OUT` and `DRILL_CAPABILITY_OUT` set. There is no downgrade
step, because PalCert ships no down-migrations: going back across a migration
is a restore (§9).

Before a release is frozen, rehearse the database half on its own against a
copy of the latest production backup:

```
SOURCE_BACKUP=/backups/palcert-<timestamp> \
MIGRATE_IMAGE=ghcr.io/<owner>/palcert-migrate@sha256:<digest> \
  bash scripts/release/rehearse-database-upgrade.sh
```

It restores the backup's database into a throwaway PostgreSQL 17 on an
internal Docker network (no published port; it never reads `DATABASE_URL` or
`DATABASE_ADMIN_URL`) and records, before the upgrade: the migration history
(`EXPECT_SOURCE`, default 81); a row count and content digest for every table;
the schema catalog (tables, columns, indexes, functions, triggers, policies,
enum labels, grants); every customer balance by account, currency and credit
class, holds, purchases, withdrawal requests, reservations and settlements and
attestation revenue; and every input of the platform and institution
withdrawal-funds computations, computed the earlier release's way. It runs the
candidate's migration image once, as the topology does, then requires: the
release's history and `verify-restore.mjs`; every pre-existing table unchanged,
except tables a pending migration inserts into, which may only gain rows;
nothing in the catalog removed or altered; every balance and commitment
unchanged; the same withdrawal-funds figures computed the new way; and a
`COMPATIBLE` service-revenue rollback gate. `summary.md` in `REHEARSAL_WORK`
lists the backup it ran on and the intended changes: the migrations recorded,
the rows added, the catalog entries added.

A rehearsal is only as real as its backup. Run on a backup of test data it is
a **test-data upgrade rehearsal**: useful for the tool and the migrations, but
not a substitute for the run on a copy of the production backup, which stays a
separate step before deploying. A database created from nothing is not a
substitute either: it never meets the rows an upgrade has to keep.

---

## 5. Promoting to production

```
gh workflow run deploy.yml \
  -f release-version=0.1.0+18d07c5 \
  -f environment=production \
  -f reason="why this is going out now"
```

Production requires four things, each refused with its own exit code:

- **a permitted ref** (exit 3) — `main` or a `v*` tag. The workflow file is
  read from the ref it was dispatched on, so a branch could otherwise carry
  its own deployment steps.
- **a named approver** (exit 4) — GitHub environment protection holds the job
  before any step runs; the record names who.
- **a stated reason** (exit 5) — the only question anyone asks later.
- **staging evidence for these exact bytes** (exit 6) — the staging deployment
  record must name the same manifest *by content hash* and show the same five
  digests. A matching version string is not evidence.

```
node scripts/release/check-promotion-allowed.mjs \
  --environment production --ref refs/heads/main \
  --reason "..." --approved-by "..." \
  --freeze release-freeze.json --staging-record staging-deployment.json
```

Production deploys the **same digests** staging accepted. Nothing is rebuilt
or retagged between environments; `assert-frozen-images.mjs` refuses if the
rendered configuration names anything else.

---

## 6. Approval

The approval boundary is GitHub's environment protection on the `production`
environment: a required reviewer, configured in repository settings, who must
approve before any step of the job runs. The workflow cannot bypass it and
neither can a branch.

What is recorded, and what is not: the approver's identity and the stated
reason go into the release record. Credentials never do. "Approved by a
workflow" is not an approval — an auditor asks which person accepted the risk.

---

## 7. A failed promotion

First: **check whether ingress opened.** If the deployment failed before step
12, it did not, and nothing external reached the candidate. That is the
designed behaviour and the common case.

```
docker compose -p <project> ps        # is a proxy running?
```

Then read where it stopped. The step numbers in the log map to §4's table.

| Symptom | Meaning | Action |
| --- | --- | --- |
| exit 65 at step 1–2 | the manifest or the registry objects are wrong | do not retry; the release is not deployable as named |
| exit 78 at step 3 | this environment is missing a secret | add it to the environment's store, then redeploy |
| exit 65 at step 4 | the database is ahead of this release, or a migration is half-applied | §9 — this is a decision, not a retry |
| exit 65 at step 5 | the configuration does not name the frozen digests | something substituted an image; find out what before proceeding |
| exit 65 at step 7–8 | the migration job failed, or the schema is not where it should be | read the migrate container's logs; do not start the application |
| exit 1 at step 9–11 | a service never became ready | `docker compose logs <service>`; readiness names the failing dependency |
| exit 65 at step 12 | smoke failed on an otherwise healthy stack | read the smoke output; ingress is still closed |
| exit 75 | another deployment to this environment is in progress | wait for it; do not force |

A failed deployment leaves the previous release serving, because ingress was
never repointed. There is no cleanup step to run and no partial state to
unwind except the migrations, which are forward-only by design.

---

## 8. Rolling the application back

Rollback and promotion are the same operation with a different argument: deploy
an earlier release's retained digests.

```
# 1. Can the earlier release run against the schema the newer one left?
node scripts/release/check-rollback-safety.mjs \
  --from release-manifest-B.json --to release-manifest-A.json \
  --database "$DATABASE_ADMIN_URL"

# 2. If SAFE, deploy A exactly as any other release.
node scripts/release/render-deploy-env.mjs --manifest release-manifest-A.json --out images.env
FREEZE=release-freeze-A.json ENVIRONMENT_FILE=... \
  bash scripts/release/deploy.sh release-manifest-A.json images.env
```

Then confirm from the running system, not from the command you typed:

```
curl -sk https://<host>/health/ready | grep commit
node scripts/release/assert-frozen-images.mjs --freeze release-freeze-A.json --running
```

Nothing is rebuilt. Release A's images are the bytes built when A was cut.

---

## 9. Rollback refused because of the database

`check-rollback-safety.mjs` exits **3** when the release being rolled back to
predates migrations the database has already applied.

This is not an obstacle to work around. PalCert rolls back the *application*;
it does not roll back the database, and **it will not generate reverse
migrations**. A down-migration written under incident pressure, against a
schema holding real customer data, is a larger risk than the bug being rolled
back.

Three ways forward, in order of preference:

1. **Forward-fix.** Build a new release that corrects the fault. Almost always
   right when the fault is in application code.
2. **Confirm compatibility and roll back the application only.** Read the
   migrations in the gap. If they are additive — new tables, new nullable
   columns, new indexes — the older release does not know about them and does
   not care. Then:
   ```
   node scripts/release/check-rollback-safety.mjs --from B.json --to A.json \
     --i-have-confirmed-schema-compatibility
   ```
   The flag is deliberately long. It is a signed statement that someone read
   the migrations, not a way to retry the command.
3. **Restore from backup**, if the schema change destroyed or transformed data
   the older release needs. That is [restore.md](restore.md), and it means
   accepting the RPO.

Exit **65** means the target expects *more* migrations than what is running.
That is a roll forward, not a rollback, and the override does not apply.

---

## 10. Emergency redeploy from retained artifacts

For when the deployment environment is gone and the source may not build.
Rehearsed end to end by `scripts/release/recovery-from-registry.sh`.

Four things are needed, and nothing else:

1. the restored database and object storage ([restore.md](restore.md));
2. the release manifest and freeze record;
3. the five image digests, still in the registry;
4. the environment's secrets, **including the webhook keyring** — the API
   fails closed when a key referenced by stored ciphertext is absent, so a
   restore without the keyring produces an API that will not start.

```
FREEZE_OUT=release-freeze.json bash scripts/release/fetch-manifest.sh 0.1.0+18d07c5
node scripts/release/verify-manifest.mjs --manifest release-manifest.json --registry-check
node scripts/release/render-deploy-env.mjs --manifest release-manifest.json --out images.env
FREEZE=release-freeze.json ENVIRONMENT_FILE=... \
  bash scripts/release/deploy.sh release-manifest.json images.env
```

The manifest comes from the committed release record first and the workflow
artifact second, in that order of durability. Neither requires the commit to
still be buildable — which is the point, because months later it frequently
is not.

---

## 11. Registry retention and recovery of artifacts

**The rule:** cleanup may never delete the release currently in production,
the release that is its rollback target, or the manifests, freeze records,
SBOMs and provenance belonging to either.

Ordinary retention policies do not give this. "Keep the last N tags" and
"delete untagged after D days" both assume the thing worth keeping is the
thing most recently pushed; during an incident it is the release *before* the
one that broke, which is by construction older.

So the protected set is named, not inferred:

```
node scripts/release/check-registry-retention.mjs \
  --registry ghcr.io --owner <owner> \
  --protect release-freeze.json \
  --protect previous-release-freeze.json \
  --keep 10
```

It reports what a cleanup pass would remove, fails if that intersects the
protected set, and verifies the protected images are still present — retention
protects nothing that is already gone. It deletes nothing itself.

Run it **before** any cleanup, and after changing a retention setting.

**Minimum retention:** the current production release and at least one prior
release, for as long as either could be a rollback target — in practice, until
two later releases have run in production without incident. SBOM and provenance
are retained with their images: they are what answers "what was in the thing
that was running" after the fact, and that question is asked most often about
releases that are no longer current.

**If a needed image has already been deleted**, the release cannot be deployed
and must not be reconstructed by rebuilding the commit: the result would be
different bytes under the same version string. Roll forward instead, or restore
and redeploy a release whose images do survive.

---

## Release gates, and why each can fail

Every gate below has a demonstrated refusal. A gate that has only ever
reported success is not a gate — Checkpoint 20.5 found two that could not fail
at all, and one that passed against a URL the API does not serve.

| Gate | Script | Negative proof |
| --- | --- | --- |
| manifest well-formedness | `verify-manifest.mjs` | `release-manifest.spec.ts` |
| image built from this commit | `verify-manifest.mjs --registry-check` | a manifest naming another commit fails five checks |
| no substituted image | `assert-frozen-images.mjs` | `test-substitution-refused.sh` |
| each release tag names its recorded digest | `tag-release.sh` | `test-tag-release.sh`; Checkpoint 20.9: the check could not pass for any image until then |
| no development packages or package managers | `check-image-dependencies.mjs` | refuses zero images; fails on a pre-hardening image |
| vulnerabilities | `scan-images.sh` | blocked the release at 46 fixable HIGH/CRITICAL |
| secrets in images | `check-image-secrets.sh` | `test-image-secret-detection.sh` |
| provenance | `verify-provenance.sh` | an unknown predicate type is refused |
| deployment secrets | `check-deployment-secrets.mjs` | `test-failed-promotions.sh` cases 4–5 |
| migration compatibility | `migration-preflight.sh` | `test-failed-promotions.sh` cases 7–8 |
| promotion boundary | `check-promotion-allowed.mjs` | `test-promotion-boundary.sh` |
| rollback safety | `check-rollback-safety.mjs` | `test-rollback-refusal.sh` |
| deployment concurrency | the lock in `deploy.sh` | `test-deploy-concurrency.sh` |
| retention | `check-registry-retention.mjs` | a keep-1 policy is refused |
| recovery without rebuilding | `recovery-from-registry.sh` | the data plane is destroyed for real; the same data is then re-proven through the application (`acceptance.mjs --verify`) |
| the product works as deployed | `acceptance.mjs` | Checkpoint 20.9: failed on the release stack, which could not store a document |
| upgrade from the previous schema | `upgrade-rehearsal.sh` | refuses a source already at the release's schema level (it would not be an upgrade) |
| a real database survives the candidate's migrations | `rehearse-database-upgrade.sh` (on a copy of the production backup) | a migration that rewrites existing rows is refused by the per-table content digest |
| browser uploads and downloads | `qa/release-checks.mjs` §6 | Checkpoint 20.9: every upload failed with a CSP violation before the storage route |
