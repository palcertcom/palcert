# Persistent local environment

A full PalCert stack on your own machine at **https://localhost:8443**, built
from your working tree, whose data survives rebuilds, restarts, branch
switches and mistakes. It is for development and manual testing only.

| Command | What it does | Deletes data? |
|---|---|---|
| `pnpm local:up` | Builds the five images from the working tree and starts the stack. First run also creates the secrets file and the volumes. | Never |
| `pnpm local:up --no-build` | Starts with the images already built. | Never |
| `pnpm local:stop` | Stops every container. | Never |
| `pnpm local:status` | Containers, the six volumes and the URL. | Never |
| `pnpm local:logs [service]` | Follows logs (`web`, `api`, `worker`, …). | Never |
| `pnpm local:admin [email]` | Creates or promotes a PalCert administrator. Asks for the password twice, without echo; MFA must be enrolled at first sign-in. | Never |
| `pnpm local:reset` | **Deletes all local data**, after you type `delete palcert-local` at a terminal. | **Yes** |

Requirements: Docker with Compose v2, Node (for secret generation), bash.

## What keeps the data safe

- **The volumes are not Compose's.** `docker/docker-compose.local.yml` declares
  them `external`, with fixed names:
  `palcert-local-postgres`, `palcert-local-redis`, `palcert-local-minio`,
  `palcert-local-clamav`, `palcert-local-certs`, `palcert-local-kms`.
  No Compose command can remove an external volume — not `up`, not `build`,
  not `down`, not even `docker compose down -v`. Only `pnpm local:reset`
  deletes them.
- **A UI rebuild is a web-container restart.** `local:up` rebuilds images and
  then `docker compose up` recreates only the containers whose image or
  configuration changed. Changing a page recreates `web`; PostgreSQL, Redis
  and MinIO keep running on the same volumes.
- **Secrets are generated once and never shown.** The first `local:up` writes
  `.local/palcert-local.env` (git-ignored, mode 600) with random database,
  storage and encryption keys. Nothing prints them.
- **New secrets are never generated over old data.** A database, an MFA secret
  store or a webhook keyring initialised with one key set is unreadable with
  another. If the volumes exist but the secrets file does not, `local:up`
  stops and explains instead of starting with fresh keys.
- **Reset cannot run by accident.** It refuses without a terminal, and it
  needs the exact phrase. It removes only the six volumes above and the
  `palcert-local` containers; other projects are untouched, and the secrets
  file is kept so the next `local:up` reuses it.
- **Not for production.** Every command refuses when `NODE_ENV` or
  `PALCERT_ENV` says production, or when `APP_PUBLIC_WEB_URL` in the secrets
  file is not `localhost`.

## Using an existing environment

If you already have data in `palcert-local-*` volumes from an earlier setup:

1. Stop the old stack **without** `-v` (for example
   `docker compose -p <old-project> … stop`), so port 8443 is free.
2. Point the scripts at the env file those volumes were created with:
   `export PALCERT_LOCAL_ENV_FILE=/path/to/that.env`
   (or copy it to `.local/palcert-local.env` with `chmod 600`).
3. `pnpm local:up`. The existing volumes are reused as they are.

## Payments

The stack cannot yet boot with payments switched off (finding F-024 in the
Checkpoint 20.2 report), so the generated file carries placeholder Stripe test
values. No Stripe account is contacted; a top-up fails until real Stripe
*test* keys are put in the secrets file. Never put live keys there.

## Other stacks

- `docker/docker-compose.yml` runs only the stateful dependencies for
  host-side `pnpm dev`; it is unrelated to this environment.
- `docker/docker-compose.release.yml` alone is the release-testing stack;
  this environment is that file plus the local overlay, so it exercises the
  same topology a release does.
- A second, disposable stack (for example automated QA) must use a different
  project name and port and its own volumes — never the `palcert-local-*`
  volumes.

## Image builds

`docker/web.Dockerfile` fetches dependencies from `pnpm-lock.yaml` alone in
its own layer, then installs offline with `--frozen-lockfile`. A change to a
component or stylesheet reuses the dependency layer and only recompiles the
application; the install is still exact and deterministic, and a lockfile
mismatch still fails the build.
