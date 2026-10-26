# Deploying PalCert

How the images are built, what runs where, the order a deployment happens in,
and how to get back from a bad release.

Companion to
[the Checkpoint 20.1 audit](phase-20-checkpoint-1-production-readiness-audit.md),
which is what found most of this missing.

For an existing deployment, see [AI configuration](ai-configuration.md) for the
optional API/worker overlay and a validation step that does not restart services.

---

## 1. Runtime topology

### Application images PalCert owns

| Image | Built from | Command | Port | Probe |
|---|---|---|---|---|
| `palcert/api` | `docker/api.Dockerfile` target `runtime` | `node dist/main.js` | 4000 | `/health/live`, `/health/ready` |
| `palcert/worker` | same file, target `worker` | `node dist/worker-main.js` | 4100 | `/health/live`, `/health/ready` |
| `palcert/migrate` | same file, target `migrate` | `prisma migrate deploy` | — | exits 0 or fails the deployment |
| `palcert/web` | `docker/web.Dockerfile` | `node apps/web/server.js` | 3000 | `/health/live` |
| `palcert/document-engine` | `docker/document-engine.Dockerfile` | `uvicorn app.main:app` | 8000 | `/health/live` |

The API and the worker are **one build with two targets**, because they are the
same compiled code with the same dependencies and differ only in entrypoint.
Building them separately would create two dependency trees that can drift while
claiming to be one release. The migration job is a **separate image**, because
it needs the Prisma CLI and nothing that runs continuously should carry a
schema-mutating tool.

### Stateful services PalCert connects to

PostgreSQL 17, Redis 7, S3-compatible object storage, ClamAV. **None of these
is bundled into an application image**, and none is PalCert's to run in
production: they are managed services the application is pointed at.

### The boundary

```
   Internet
      │
      ▼
 ┌──────────┐   the only thing with a published port
 │  proxy   │   TLS terminates here
 └────┬─────┘
      │  edge network
 ┌────▼────┬─────────┐
 │   web   │   api   │
 └─────────┴────┬────┘
                │  internal network
   ┌──────┬─────┴─────┬──────────┬────────┬────────┐
   │worker│document-  │postgres  │ redis  │ object │
   │      │engine     │          │        │ storage│
   └──────┴───────────┴──────────┴────────┴────────┘
```

`docker/docker-compose.release.yml` encodes this, and
`packages/config/src/release-topology.spec.ts` asserts it — one published
service, no ports on anything internal, no object-store console, no credential
in the manifest. The development file `docker/docker-compose.yml` publishes
every dependency on localhost and **must never be used as a production
template**.

### Browser uploads and downloads go through the web origin

A browser moves document bytes straight to and from object storage with
presigned URLs; the API never carries them. The web app's Content Security
Policy lets a browser connect only to **its own origin** (`connect-src
'self'`, Checkpoint 20.7), so a presigned URL on any other origin is one the
browser refuses to send. Every deployment therefore needs two things:

1. **`STORAGE_PUBLIC_ENDPOINT` set to the origin of `APP_PUBLIC_WEB_URL`**,
   with no path — e.g. both `https://palcert.example.org`. Production refuses
   to boot otherwise. `STORAGE_ENDPOINT` stays the internal address the API
   and worker use.
2. **The edge routes the bucket paths to object storage.** Requests for
   `/<STORAGE_BUCKET>/…`, `/<STORAGE_QUARANTINE_BUCKET>/…` and
   `/<STORAGE_DERIVED_BUCKET>/…` on the public origin go to the object store
   with the **original `Host` header, port included** (SigV4 signs it), and
   only `GET`/`HEAD`/`PUT` are allowed. The request body limit must cover the
   largest upload (`UPLOAD_MAX_PDF_BYTES`, 200 MiB by default). Strip
   `Authorization` and `Cookie` so the route serves presigned requests only,
   and send `Content-Security-Policy: default-src 'none'; sandbox` and
   `X-Content-Type-Options: nosniff` on these responses: a stored document is
   now served from the application's own origin and must never run as it.
   `docker/release-proxy.conf` is the reference implementation.

The object store must also honour SSE-S3 (`STORAGE_SERVER_SIDE_ENCRYPTION`,
required in production). A managed S3 service does. A self-run MinIO needs a
KMS key; the release stack generates one per stack (`docker/release-certs.sh`)
into a volume only MinIO mounts. Without it every object write fails with
`501 NotImplemented: KMS is not configured`.

Checkpoint 20.9 found that neither held in the release stack, so no document
could be uploaded through the interface. `qa/release-checks.mjs` now uploads
through the interface in Chromium, Firefox and WebKit, waits for the worker to
reach Ready, and compares the downloaded bytes with the uploaded ones.

---

## 2. Building a release

```bash
COMMIT=$(git rev-parse HEAD)
BUILT=$(date -u +%Y-%m-%dT%H:%M:%SZ)

for target in runtime:api worker:worker migrate:migrate; do
  docker build -f docker/api.Dockerfile --target "${target%%:*}" \
    --build-arg APP_COMMIT="$COMMIT" --build-arg APP_BUILT_AT="$BUILT" \
    -t "palcert/${target##*:}:$COMMIT" .
done

docker build -f docker/web.Dockerfile \
  --build-arg APP_COMMIT="$COMMIT" --build-arg APP_BUILT_AT="$BUILT" \
  --build-arg NEXT_PUBLIC_API_URL="https://palcert.example/api" \
  -t "palcert/web:$COMMIT" .

docker build -f docker/document-engine.Dockerfile -t "palcert/document-engine:$COMMIT" .
```

**Tag by commit, never by a moving tag.** `latest` cannot be rolled back to.

### Release identity

Every image carries `APP_COMMIT` and `APP_BUILT_AT` as environment variables
and as OCI labels, and every health response reports them:

```json
{ "status": "ok", "version": "0.1.0",
  "release": { "commit": "619133b…", "builtAt": "2026-09-21T10:18:14Z" } }
```

That is how "did the rollback land?" gets answered. The build timestamp is
**read at runtime only** — nothing derives a cache key or a digest from it, so
two builds of the same source still produce the same layers.

A deployment must not set `APP_COMMIT` or `APP_BUILT_AT`. Identity belongs to
the image; a deployment that could set it could lie about what is running.

### Public web variables are build-time

`NEXT_PUBLIC_*` are inlined into the client bundle by the Next build, so the
web image is **environment-specific**: staging and production need separate
builds from the same commit. That is a property of Next, not a choice.

---

## 3. Deployment sequence

```
  1. build and push images, tagged by commit
  2. run the migration job  ── must exit 0 ──┐
  3. roll out the API                        │ nothing in step 3 or 4 starts
  4. roll out the worker                     │ until step 2 succeeds
  5. roll out the web                        │
  6. verify: readiness green, commit correct ┘
```

**One migration step, never a race.** Every API and worker container waits for
the migration job to exit 0. Without that gate each replica would run
`migrate deploy` at startup and contend for the same advisory lock, with the
losers blocking or failing their health check while the winner works.

### Compatibility during rollout

Between steps 2 and 5 the **new schema is live and old application code is
still running**. That is unavoidable in a rolling deployment and it is what
makes migration classification necessary.

| Class | Meaning | Rollout |
|---|---|---|
| **Backward-compatible** | Old code runs correctly against the new schema. Additive columns with defaults, new tables, new indexes, widened enums. | Rolling. No coordination. |
| **Forward-fix-only** | Cannot be undone. Dropped or renamed columns, narrowed types, destructive backfills. | Rolling, but **the release cannot be rolled back past it**. |
| **Requires coordinated deployment** | Old code would be *wrong*, not merely unaware — a changed meaning, a moved authority. | Stop the workers, migrate, start the new version. Announced in advance. |

**Every PalCert migration is forward-fix-only unless proven backward-compatible.**
Prisma generates no down-migrations and this repository has none; that is a
deliberate position, not an oversight. A down-migration that has never been
executed is a guess about a failure that has not happened yet, and running one
against production data under incident pressure is how a bad release becomes a
data-loss incident.

Classify each migration **in its pull request**, in the migration file's
header comment. The classification is a claim about old code, so it is made by
whoever knows what the old code does.

---

## 4. Rollback

Three different things, and conflating them is how an outage gets worse.

### Application rollback — the normal case

Redeploy the previous image tag.

```bash
docker compose --env-file <env> -f docker/docker-compose.release.yml up -d api
# with API_IMAGE=palcert/api:<previous-commit>
```

Safe **when the schema the previous build expects is compatible with the schema
that is live**. If the release contained only backward-compatible migrations,
it always is.

Verify with the identity, not with the deploy tool's opinion:

```bash
curl -sk https://palcert.example/health/live | jq -r .release.commit
```

### Database rollback — the last resort

Restoring the database to a point in time **loses every transaction committed
since**: submissions, payments, issued certificates. It is correct only when the
alternative is worse, and it is never the first response to a bad release.
Backup and restore themselves are Checkpoint 20.4; today there is no backup,
which is recorded as a release blocker.

### Forward fix — when rollback is not available

If the release included a forward-fix-only migration, the previous image may
not run against the live schema. Then the only way out is forward: a new
release that repairs the problem. Plan for this **before** shipping such a
migration, not during the incident.

| Situation | Action |
|---|---|
| Bad code, compatible schema | Application rollback |
| Bad code, forward-fix-only migration shipped | Forward fix |
| Corrupted or wrongly migrated data | Database restore, accepting the loss |

---

## 5. Shutdown and restart

Both processes handle `SIGTERM` through Nest's shutdown hooks, and both are
started in exec form so the process is PID 1 and receives the signal directly
rather than through a shell that would swallow it.

**The API** stops accepting connections and lets in-flight requests finish.

**The worker** closes its BullMQ workers first and then the queue, so it stops
claiming new jobs before it releases anything. `stop_grace_period` is 40
seconds, enough for a job to finish or to reach a checkpoint.

A hard kill is survivable and is not a special case: a job's lease lapses, the
lease-lapse sweep finds it `RUNNING` past its expiry and returns it to the
queue. Graceful shutdown is worth having because it costs the job one attempt
fewer, not because the alternative corrupts anything.

Verified in the release stack: `docker compose stop worker` exits 0, leaves no
job stranded, and the API stays ready throughout.

---

## 6. Running the stack for release testing

```bash
docker compose --env-file <env-file> -f docker/docker-compose.release.yml up -d
curl -sk https://localhost:8443/health/ready
```

The stack generates its own private CA and terminates TLS, because PalCert's
production configuration **refuses to boot without it** — object storage must
be reached over https and the public URL must be https. A release stack that
disabled those checks would be testing a different system from the one that
ships. `NODE_EXTRA_CA_CERTS` points the Node processes at the generated CA;
nothing sets `NODE_TLS_REJECT_UNAUTHORIZED`.

Required environment (all fail the run if missing): `POSTGRES_PASSWORD`,
`POSTGRES_APP_PASSWORD`, `STORAGE_ACCESS_KEY_ID`, `STORAGE_SECRET_ACCESS_KEY`,
`AUTH_MFA_SECRET_KEY`, `CERTIFICATE_VERIFICATION_SECRET_KEY`,
`API_CLIENT_REVEAL_SECRET_KEY`, `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`,
`WEBHOOK_ENCRYPTION_KEYS`, `WEBHOOK_ENCRYPTION_ACTIVE_KID`.
`scripts/release/check-deployment-secrets.mjs` reads the authoritative list
out of the compose file.

Served on a port other than 8443 (`PROXY_PORT`), set `APP_PUBLIC_WEB_URL` and
`API_CORS_ORIGINS` to the URL a browser uses, port included.
`STORAGE_PUBLIC_ENDPOINT` follows `APP_PUBLIC_WEB_URL` unless set.

---

## 7. Migration compatibility is a gate

`migrate` exiting 0 means the migration job ran. It does not mean this database
is at this build's level: an image can be deployed whose migrations never
reached this database, and the application will start, pass its readiness
probe, and fail only on the paths that needed the missing object. Checkpoint
20.3 shipped exactly that.

The release stack therefore runs a `migrate-check` step between the migration
job and the application, and `api` and `worker` wait on **it** rather than on
`migrate`. Outside the stack:

```bash
pnpm --filter @palcert/database migrations:check -- --url "$DATABASE_ADMIN_URL"
```

Exit 3 means migrations in source are not applied; exit 4 means one is
half-applied and needs a decision rather than another deploy; exit 5 means the
database is ahead of this build.

Deliberately not part of the readiness probe: it reads a directory listing and
a table, and the answer cannot change while a container is running.

## 8. Telemetry

Every PalCert process exposes Prometheus metrics on its own port: API 4000,
worker 4100, document engine 8000, web 3000. `METRICS_ENABLED` (default
`true`) turns the endpoint off; `METRICS_TOKEN`, when set, requires
`Authorization: Bearer <token>` on a scrape. The document engine reads the
same two values prefixed `DOC_ENGINE_`.

**The endpoint is internal.** The release proxy returns 404 for `/metrics`
and anything beneath it, so an external request never reaches a process. A
scraper runs on the deployment network and reads each one directly. If a
deployment puts that scraper somewhere else, the token is the control that
matters, and it should be set.

After a deploy, `palcert_build_info` on each process tells you which commit
is serving — `count(count by (commit) (palcert_build_info))` should be 1 once
the rollout finishes. `palcert_metrics_collector_up` should be 1; if it is 0,
every job and delivery signal is blind and the migration granting `EXECUTE`
on `app_operational_counts()` is the first thing to check.

Full detail: [Observability](observability.md), [Alerting](alerting.md),
[Dashboard specification](dashboards.md).

## 9. What is still missing

Recorded honestly, because a deployment document that implies more readiness
than exists is worse than none:

- ~~No backup and no restore~~ — **closed in Checkpoint 20.4.** See the
  [backup](backup.md), [restore](restore.md) and
  [disaster-recovery](disaster-recovery.md) runbooks. Note that recovery is to
  the last backup, not to a point in time.
- ~~No observability beyond logs~~ — **closed in Checkpoint 20.3.** Every
  process exposes Prometheus metrics; see
  [Observability](observability.md) and [Alerting](alerting.md).
- **No image registry or CD pipeline** (Checkpoint 20.5). CI builds and starts
  every image; nothing publishes them.
- **No production environment.** The topology is defined and exercised; the
  substrate that runs it is not chosen.
