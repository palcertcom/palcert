# Phase 20 · Checkpoint 2 — Production Runtime & Deployment Report

Checkpoint 20.1 classified "no deployment substrate" as a release blocker. This
checkpoint makes every PalCert runtime component buildable, identifiable,
health-checkable and deployable, and proves it by running the whole thing.

Baseline: 20.1 frozen at `619133b`.

---

## 1. What re-verification found before anything changed

Every 20.1 finding this checkpoint touches was re-checked against the tree
first. All confirmed:

| Finding | Confirmed at | Status |
|---|---|---|
| F-001 worker readiness drops the engine probe | `worker-health.controller.ts:44-52` | **Fixed** |
| F-002 `AUTH_SESSION_SECRET` unused | 4 references, all test fixtures | **Removed** |
| F-009 per-process rate limit | `app.module.ts:50-56`, no `storage` | **Fixed** |
| F-012 no worker image | `docker/` had three files, none for the worker | **Fixed** |
| F-006 web ships devDependencies | `web.Dockerfile` copied `/app/node_modules` | **Fixed** |
| F-008 no web health route or HEALTHCHECK | neither existed | **Fixed** |
| F-013 no deployment definition | `infra/` empty, CI built one image | **Addressed** |
| F-019 `APP_VERSION` hand-set, no commit | no commit anywhere | **Fixed** |

And then building the images for the first time found **five more defects that
had never been executed**, which is the substance of §3.

---

## 2. Runtime topology

### Application images PalCert owns

| Image | Target | Command | Size | Packages |
|---|---|---|---|---|
| `palcert/api` | `api.Dockerfile:runtime` | `node dist/main.js` | 841 MB | 277 |
| `palcert/worker` | `api.Dockerfile:worker` | `node dist/worker-main.js` | 841 MB | 277 |
| `palcert/migrate` | `api.Dockerfile:migrate` | `prisma migrate deploy` | 647 MB | 226 |
| `palcert/web` | `web.Dockerfile` | `node apps/web/server.js` | 363 MB | 79 |
| `palcert/document-engine` | `document-engine.Dockerfile` | `uvicorn app.main:app` | 321 MB | Python |

**One build, three targets** for the API, worker and migration job. The API and
the worker are the same compiled code with the same dependencies and differ
only in entrypoint and probe, so they share every layer — building them
separately would create two dependency trees that can drift while claiming to
be one release. The migration job is separate for the opposite reason: it needs
the Prisma CLI, and nothing that runs continuously should carry a
schema-mutating tool.

### Stateful services PalCert connects to

PostgreSQL 17, Redis 7, S3-compatible object storage, ClamAV. None is bundled
into an application image; none is PalCert's to run.

### The boundary, and how it is held

```
Internet → proxy :8443 (TLS)          ← the only published port
             ├── edge:     web, api
             └── internal: worker, document-engine, migrate,
                           postgres, redis, object storage, clamav
```

Verified on the running stack:

```
proxy   -> 0.0.0.0:8443->8443/tcp
api     -> 4000/tcp          (no host binding)
postgres-> 5432/tcp          (no host binding)
redis   -> 6379/tcp          (no host binding)
minio   -> 9000/tcp          (no host binding)
worker  -> 4100/tcp          (no host binding)
```

`packages/config/src/release-topology.spec.ts` asserts it without Docker: one
published service, no ports on anything internal, no object-store console, no
credential in the manifest, one migration step that at least two services wait
for, and no deployment override of release identity.

---

## 3. Defects found by building and running the images

None of these was in the 20.1 ledger, because 20.1 read the Dockerfiles and
these are only visible when they execute. All five are pre-existing.

**F-021 — The build context carried host incremental-build state.**
`.dockerignore` excluded `**/dist` but not `*.tsbuildinfo`. tsc read a manifest
saying every file was already emitted, emitted nothing, exited 0, and the API
compile then failed with 1323 `cannot find module '@palcert/contracts'` errors.
A build must not depend on whether somebody ran a typecheck on the machine that
started it. *Fixed: `**/*.tsbuildinfo` excluded.*

**F-022 — `pnpm deploy` could not run.** pnpm 10 refuses `deploy` from a
workspace without `inject-workspace-packages=true`. *Fixed with `--legacy`,
scoped to the image build rather than changing how every developer's install
links workspace packages.*

**F-023 — The web image copied a `public/` directory that does not exist.**
A missing COPY source is a build failure, not an empty directory. *Fixed.*

**F-024 — The generated Prisma client was copied where nothing reads it.**
`@palcert/database/dist/prisma-client.js` requires `../generated/client`,
relative to the package; the Dockerfile put it at `/app/generated`. The API
died at startup with `MODULE_NOT_FOUND`. *Fixed: placed inside the deployed
package during the build.*

**F-025 — `AI_ENABLED=false` meant true.** The field was
`z.coerce.boolean()`, and coercion runs the string through JavaScript's
`Boolean`, where `Boolean('false')` is `true`. No deployment noticed because
the cross-field guard then demanded an Anthropic key and every environment had
one — the flag was wrong and a second rule hid the symptom. It was the only
coercion left in a schema where every other flag used an enum accepting exactly
`true|false|1|0`. *Fixed, with a regression test.*

Plus one introduced and caught in the same checkpoint: release identity
declared as `ARG APP_COMMIT=""` arrives as an empty string, which is *present*,
so `.optional()` did not cover it and the API refused to boot. Empty now reads
as absent; a non-empty value is still validated.

---

## 4. Worker readiness

The fix is one line of behaviour and one line of intent:

```ts
const dependencies = await Promise.all([ …five probes… ]);
const result = this.build(dependencies);   // was: this.build([redis, storage, scanner])
```

Readiness now covers **database, Redis, object storage, malware scanner and
document analysis**. The database was missing entirely — a worker records every
claim, attempt and outcome in the job ledger and cannot mark a job `RUNNING`
without it.

Liveness and readiness are separated explicitly and documented in the
controller: liveness answers *should this process be restarted?* and touches
nothing, because restarting a healthy process does not bring a dependency back.
Readiness answers *is it safe to claim work?*, and a worker missing any
dependency stays out of rotation rather than burning an attempt and moving a
job closer to `DEAD`.

Nine tests in `worker-health.controller.spec.ts`: liveness ok with everything
down, and readiness refusing for each of the five dependencies independently —
because the bug was not in any one probe but in what the aggregate was built
from.

---

## 5. Distributed rate limiting

`RedisThrottlerStorage` implements `@nestjs/throttler`'s storage interface with
the pattern PalCert already uses twice — `AuthThrottleService` for logins and
`ApiClientThrottleService` for machine credentials: `INCR`, `EXPIRE` on first
write, compare. Neither of those is touched and both keep their own keyspaces
and their fail-closed behaviour.

Keys are SHA-256 hashed: the throttler's key derives from the caller's IP, and
a Redis dump should not be a list of who used PalCert and when.

**A Redis outage allows the request** and logs the failure. That is a
deliberate asymmetry: this limiter is an abuse control, not an authorization
control, and refusing every request because a rate limiter is unavailable turns
a throttle outage into a total outage. Authentication and API-client
throttling, which *are* security controls, stay fail-closed.

Proved by `apps/api/test/rate-limit-distribution.e2e-spec.ts` (5 tests):
two storage instances on two separate Redis connections — what two replicas
are — count one caller `1,2,3,4,5,6` rather than twice from one; the replica
that spent nothing refuses immediately once the shared budget is gone; a
different caller is unaffected; a broken store allows. Plus the regression that
matters most: the running application resolves `ThrottlerStorage` to
`RedisThrottlerStorage`, not the in-memory default.

---

## 6. Release identity

`APP_COMMIT` and `APP_BUILT_AT` are build arguments, set as environment
variables and OCI labels in the final stage only — declaring them earlier would
invalidate the dependency cache on every commit. Every health response carries
them:

```json
"release": { "commit": "619133b81b9a40e59c5fe5c935522fb57e65b850",
             "builtAt": "2026-09-21T10:18:14Z" }
```

The timestamp is read at runtime and never derives a cache key or digest, so it
does not break reproducibility. A deployment cannot set either: identity
belongs to the image, and a deployment that could set it could lie about what
is running. An earlier draft of the compose file did exactly that and
overwrote a real commit with an empty string.

---

## 7. Migration and rollout

One migration job, run once, that every API and worker container waits for
(`condition: service_completed_successfully`). Without that gate each replica
would run `migrate deploy` at startup and contend for the same advisory lock.

Classification, documented in `docs/operations/deployment.md`:

| Class | Rollout |
|---|---|
| Backward-compatible | Rolling, no coordination |
| Forward-fix-only | Rolling, but the release cannot be rolled back past it |
| Requires coordinated deployment | Stop workers, migrate, start the new version |

**Every PalCert migration is forward-fix-only unless proven otherwise.** Prisma
generates no down-migrations and none was written here: a down-migration that
has never been executed is a guess about a failure that has not happened, and
running one against production data under incident pressure is how a bad
release becomes a data-loss incident.

Rollback is documented as three distinct things — application rollback
(redeploy the previous tag), database rollback (restore, losing everything
since, and not yet possible because there is no backup), and forward fix — and
**rehearsed**: the API was redeployed from a different tag, came back healthy,
and reported its identity through the proxy.

---

## 8. Graceful shutdown

Both processes are started in exec form so the process is PID 1 and receives
`SIGTERM` directly rather than through a shell that would swallow it. Nest's
shutdown hooks are enabled; `ProcessingQueue.onModuleDestroy` closes the BullMQ
workers first and the queue second, so the worker stops claiming before it
releases anything. `stop_grace_period: 40s`.

Verified on the running stack: `docker compose stop worker` exits **0**, leaves
no job stranded, and the API stays ready throughout.

A hard kill remains survivable and is not a special case — a lease lapses and
the sweep reclaims the job. Graceful shutdown is worth having because it costs
one attempt fewer, not because the alternative corrupts anything.

---

## 9. The production-like stack

`docker/docker-compose.release.yml`, explicitly not the development file, which
publishes every dependency on localhost.

It terminates **real TLS** with a private CA generated at stack-up, because
PalCert's production configuration refuses to boot without it — object storage
over https, public URL https. A release stack that disabled those checks would
be testing a different system from the one that ships. `NODE_EXTRA_CA_CERTS`
points the Node processes at the CA; nothing sets
`NODE_TLS_REJECT_UNAUTHORIZED`.

Clean-state boot, verified:

```
certs        exited (0)     postgres  healthy    api    healthy
migrate      exited (0)     redis     healthy    worker healthy
storage-init exited (0)     minio     healthy    web    healthy
                            clamav    healthy    proxy  running
```

```
$ curl -sk https://localhost:8443/health/ready
{"status":"ok", … "dependencies":[{"database":"ok"},{"redis":"ok"},{"object-storage":"ok"}]}
$ curl -sk -o /dev/null -w '%{http_code}' https://localhost:8443/en   → 200
```

No credential appears in the manifest: every secret is `${VAR:?message}`, which
fails the run when missing rather than defaulting to something nobody changed.

---

## 10. Dependency evidence per image

`scripts/check-image-dependencies.mjs` inspects what each image actually
carries, scoped to the application trees — the Node base image bundles npm,
which vendors a directory literally named `typescript`, and flagging the base
image's package manager would make the gate unpassable and therefore disabled.

It refuses to report a clean image when it finds nothing at all: an early
version mis-quoted its `find` and reported "0 packages, ok" for every image,
which is a gate that cannot fail.

| Image | Packages | Test runners / linters | Prisma CLI | TypeScript |
|---|---|---|---|---|
| `palcert/web` | 79 | none | none | removed |
| `palcert/api` | 277 | none | removed | removed |
| `palcert/worker` | 277 | none | removed | removed |
| `palcert/migrate` | 226 | removed | **present, required** | present |

`pnpm deploy --prod` left the Prisma CLI and the TypeScript compiler in the
virtual store anyway; both are pruned in the runtime stage, and the gate fails
the build if either returns. `pip-audit` over the document engine's 74
packages: no known vulnerabilities. The two moderate vitest advisories from
20.1 (GHSA-82fw-gwwq-j7x9) are **no longer in any shipped image**.

---

## 11. CI gates

The `docker` job built one image and never ran it. It now builds **all five**
(`load: true`, so they exist locally), runs the dependency gate, starts the
production-like stack from empty, and verifies:

- `/health/ready` reports `status: ok` through the proxy over TLS;
- the reported commit equals `github.sha` — the running build is identifiable;
- the web surface answers 200 through the same proxy;
- the migration container exited 0.

Logs are dumped on failure and the stack is always torn down. `docker build`
success alone is not treated as runtime proof.

---

## 12. Gate results

| Gate | Result |
|---|---|
| All five production images build | ✅ |
| All five start and become healthy | ✅ |
| Image dependency gate (4 Node images) | ✅ no dev-only packages |
| Python suite | ✅ 1774 passed, 85 skipped |
| ruff · mypy | ✅ clean · 101 files |
| Contracts | ✅ 819 passed |
| Config | ✅ 51 passed (36 env + 15 topology) |
| API unit | ✅ 563 passed, 5 skipped |
| Web | ✅ 513 passed |
| Typecheck (5 projects) | ✅ |
| eslint · prettier | ✅ |
| Generated-contract drift · report golden · IANA | ✅ |
| `docs:check-phases` | ✅ 21 phases, 21 sections |
| Fresh-database migration | ✅ via the migration job, exit 0 |
| Production-like stack boot from clean state | ✅ |
| Application rollback rehearsal | ✅ |
| Graceful worker shutdown | ✅ exit 0, no stranded job |
| Full API e2e | ✅ 1308 passed, 10 skipped, **0 failed** (72 suites) |

---

## 13. Updated readiness ledger

### Closed by this checkpoint

F-001, F-002, F-006, F-008, F-009, F-012, F-019 — and F-021 to F-025, found here.

F-013 (no deployment substrate) is **partially** closed: the topology, images,
migration ordering, rollback procedure and boundary now exist and are
exercised. What remains is an image registry, a CD pipeline and a chosen
production environment — 20.5.

### Still open

**RELEASE BLOCKER**
- **F-005** No metrics, tracing or alert hooks → 20.3
- **F-018** No backup, restore or disaster recovery → 20.4
- **F-013 (remainder)** No registry, no CD, no production environment → 20.5

**HIGH**
- **F-004** No retention for twelve append-only tables → 20.6
- **F-007** No CSP or HSTS on the web origin → 20.7
- **F-003** `WEBHOOK_OWN_HOSTS` empty by default → 20.7
- **F-017** Readiness does not prove schema compatibility → 20.3
- **F-026 (new)** **PalCert cannot boot with payments disabled.**
  `payment-provider.module.ts:27-38` branches on `PAYMENT_PROVIDER` alone and
  constructs the Stripe client regardless of `PAYMENTS_ENABLED`, which then
  throws `STRIPE_SECRET_KEY is required`. The configuration contract says
  payments are optional and defaults them off; the runtime disagrees. The
  release stack supplies placeholder credentials it never calls. Deliberately
  not fixed here: rewiring payment construction at the end of a long checkpoint
  is how a payments bug ships. → 20.7

**MEDIUM**
- F-010 no error boundaries · F-011 no a11y linting · F-014 no bulk session
  invalidation · F-015 no secret-replacement runbook · F-016 no storage
  lifecycle or orphan reconciliation · F-020 no licence or image scan → 20.7
- **F-027 (new)** The API and worker images are 841 MB. `pnpm deploy --legacy`
  copies the pnpm virtual store rather than re-resolving it, so the tree is
  larger than the dependency set requires. Pruning worked for the two named
  offenders; the general case needs `inject-workspace-packages` or a different
  packaging strategy. → 20.7

**POST-V1** — unchanged: P-001 to P-007.

---

One full run, as the checkpoint requires; the three-run gate is reserved for
the Phase 20 release candidate. 1308 passed against 1303 at 20.1 — the five new
tests are the distributed rate-limit proof. **No Phase 1–19 behaviour changed.**

---

## 14. Notes on how this was verified

Local image builds ran through a **CA shim** kept outside the repository: this
sandbox proxies HTTPS with its own certificate authority, which the build
containers do not trust. The shim inserts that CA into each stage; the
committed Dockerfiles are unmodified, because a TLS-inspecting proxy is the
sandbox's property and baking its CA into a release image would be environment
lock-in. **CI builds the real files unmodified** and is the authoritative gate.

One environmental interruption is worth recording so the results are not
misread: the container restarted mid-checkpoint and PostgreSQL came back with
only 3 of 62 migrations applied, which made the e2e suite hang before any of
this checkpoint's changes were involved. Re-applying migrations resolved it.
Every result above was produced after that.
