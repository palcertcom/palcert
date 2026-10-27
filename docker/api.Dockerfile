# syntax=docker/dockerfile:1.7
# Production images for the PalCert API and worker.
#
# One build, two targets. The API and the worker are the same compiled code
# with the same dependencies (ADR-0001): they differ only in which entrypoint
# runs and which probes it serves. Building them separately would mean two
# dependency trees that can drift apart while claiming to be one release, so
# instead the `worker` target is the `runtime` layer plus a different command —
# identical bytes, a different process.
FROM node:22-alpine AS base
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH
RUN corepack enable
WORKDIR /app

FROM base AS deps
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY apps/api/package.json apps/api/
COPY packages/config/package.json packages/config/
COPY packages/contracts/package.json packages/contracts/
COPY packages/database/package.json packages/database/
RUN --mount=type=cache,id=pnpm,target=/pnpm/store pnpm install --frozen-lockfile

FROM deps AS build
COPY . .
# `pnpm deploy --legacy` because pnpm 10 refuses `deploy` from a workspace that
# does not set `inject-workspace-packages=true`. Setting that repo-wide would
# change how every developer's install links workspace packages in order to fix
# one image build; the flag is the documented escape hatch and stays scoped
# here. (Comments cannot live inside the continuation below: a `#` after a
# trailing backslash is passed to the shell as part of the command.)
RUN pnpm --filter @palcert/database generate \
 && pnpm --filter @palcert/contracts build \
 && pnpm --filter @palcert/config build \
 && pnpm --filter @palcert/database build \
 && pnpm --filter @palcert/api build \
 && pnpm deploy --legacy --filter @palcert/api --prod /app/deploy \
 && pnpm deploy --legacy --filter @palcert/database /app/migrate \
 && cp -R packages/database/generated /app/deploy/node_modules/@palcert/database/generated

# --- The API ---------------------------------------------------------------
FROM node:22-alpine AS runtime
ENV NODE_ENV=production
WORKDIR /app
# Never run application code as root.
RUN addgroup -S palcert && adduser -S palcert -G palcert
COPY --from=build --chown=palcert:palcert /app/deploy/node_modules ./node_modules
COPY --from=build --chown=palcert:palcert /app/apps/api/dist ./dist
# The generated Prisma client is placed inside the deployed @palcert/database
# package during the build, because `dist/prisma-client.js` requires it as
# `../generated/client` — relative to the package, not to the application root.
# The previous Dockerfile copied it to /app/generated, where nothing looks for
# it, and the API died at startup with MODULE_NOT_FOUND. Nothing caught it
# because nothing ever started this image.

# `pnpm deploy --prod` leaves the Prisma CLI and the TypeScript compiler in the
# virtual store anyway — `prisma` is a devDependency of @palcert/database, and
# legacy deploy copies the store rather than re-resolving it. Neither is used
# at runtime: the generated Prisma client is standalone, and nothing compiles
# TypeScript in a production container. Keeping a schema-mutating CLI inside
# every API and worker replica is authority those processes should not have,
# which is the whole reason the migration job is a separate image.
# Verified by scripts/check-image-dependencies.mjs, which fails the build if
# either comes back.
RUN rm -rf node_modules/.pnpm/prisma@* node_modules/.pnpm/typescript@* \
 && rm -f node_modules/.pnpm/node_modules/prisma node_modules/.pnpm/node_modules/typescript \
 && rm -f node_modules/.bin/prisma node_modules/.bin/tsc node_modules/.bin/tsserver

# The base image's package manager, removed from the runtime.
#
# Every finding in this image's vulnerability scan was inside
# /usr/local/lib/node_modules/npm — npm's own vendored dependencies (tar,
# pacote, sigstore, brace-expansion, picomatch, ip-address), not PalCert's.
# PalCert's dependency closure was clean. This process runs `node dist/…`; it
# never shells out to a package manager, so npm was pure attack surface that
# also failed the release gate on somebody else's advisories.
#
# corepack goes with it. It is the thing that would fetch and execute a
# package manager again, which is not a capability a production replica needs.
# Verified by starting the image: the module graph loads identically without
# them. scripts/check-image-dependencies.mjs fails the build if either returns.
RUN rm -rf /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack \
 && rm -f /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack

# Release identity, last so a rebuild at a new commit reuses every layer above.
# Declared here rather than in `base` for the same reason: a build argument
# invalidates every layer after the stage that declares it, and putting a
# per-commit value near the top would defeat the dependency cache entirely.
ARG APP_COMMIT=""
ARG APP_BUILT_AT=""
ARG APP_VERSION="0.1.0"
ENV APP_COMMIT=${APP_COMMIT} APP_BUILT_AT=${APP_BUILT_AT} APP_VERSION=${APP_VERSION}
LABEL org.opencontainers.image.revision=${APP_COMMIT} \
      org.opencontainers.image.created=${APP_BUILT_AT} \
      org.opencontainers.image.version=${APP_VERSION} \
      org.opencontainers.image.title="palcert-api"

USER palcert
EXPOSE 4000
# Liveness, not readiness: this decides whether to restart the container, and a
# dependency outage is not a reason to kill a healthy process.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:4000/health/live').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
# Exec form, so the process is PID 1 and receives SIGTERM directly rather than
# through a shell that would swallow it. Nest's shutdown hooks do the rest.
CMD ["node", "dist/main.js"]

# --- The worker ------------------------------------------------------------
# Everything above, re-pointed. Same layers, same digest for the shared
# content, so pulling both costs barely more than pulling one.
FROM runtime AS worker
LABEL org.opencontainers.image.title="palcert-worker"
USER palcert
EXPOSE 4100
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:4100/health/live').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "dist/worker-main.js"]

# --- The migration job -----------------------------------------------------
#
# Its own image, because the API image deliberately does not keep the Prisma
# CLI: bundling it there would put a schema-mutating tool inside every running
# replica, which is exactly the authority a one-shot migration job exists to
# keep separate. This target is built without `--prod`, so it carries the CLI
# and nothing else does.
#
# It runs once per deployment, before any application container starts. See
# docs/operations/deployment.md.
FROM node:22-alpine AS migrate
ENV NODE_ENV=production
WORKDIR /app
RUN addgroup -S palcert && adduser -S palcert -G palcert
# The same reviewed/scanned migration image supplies the operator's PostgreSQL
# 17 backup tools. Production needs neither Node nor pg_dump on the host, and
# a deployment does not build or fetch a sixth, unverified tooling image.
RUN apk add --no-cache postgresql17-client bash ca-certificates
COPY --from=build --chown=palcert:palcert /app/migrate ./
COPY --from=runtime --chown=palcert:palcert /app/node_modules ./operator/node_modules
COPY --from=build --chown=palcert:palcert /app/apps/api/scripts/backup.mjs /app/apps/api/scripts/verify-backup.mjs /app/apps/api/scripts/restore.mjs /app/apps/api/scripts/verify-restore.mjs ./operator/apps/api/scripts/
COPY --from=build --chown=palcert:palcert /app/apps/api/scripts/lib ./operator/apps/api/scripts/lib
COPY --from=build --chown=palcert:palcert /app/packages/database/prisma/migrations ./operator/packages/database/prisma/migrations
COPY --from=build --chown=palcert:palcert /app/scripts/release/check-service-revenue-rollback.sh ./operator/scripts/release/

ARG APP_COMMIT=""
ARG APP_BUILT_AT=""
ARG APP_VERSION="0.1.0"
ENV APP_COMMIT=${APP_COMMIT} APP_BUILT_AT=${APP_BUILT_AT} APP_VERSION=${APP_VERSION}
LABEL org.opencontainers.image.revision=${APP_COMMIT} \
      org.opencontainers.image.created=${APP_BUILT_AT} \
      org.opencontainers.image.version=${APP_VERSION} \
      org.opencontainers.image.title="palcert-migrate"

# The migration job needs the Prisma CLI and nothing else from the build
# toolchain. It talks to the database with schema authority, so the less it
# carries the better, even for a container that exits in seconds.
#
# Browser automation and accessibility scanning went on the list in Checkpoint
# 20.8, after the release QA harness added them as root devDependencies and
# the supply-chain scan found `playwright` here — with a HIGH advisory — before
# the image-dependency gate did. That gate now names them too.
RUN rm -rf node_modules/.pnpm/vitest@* node_modules/.pnpm/@vitest+* \
      node_modules/.pnpm/eslint@* node_modules/.pnpm/prettier@* \
      node_modules/.pnpm/jest@* node_modules/.pnpm/@testing-library+* \
      node_modules/.pnpm/playwright@* node_modules/.pnpm/playwright-core@* \
      node_modules/.pnpm/axe-core@* \
 && rm -f node_modules/.pnpm/node_modules/vitest node_modules/.pnpm/node_modules/eslint \
      node_modules/.pnpm/node_modules/prettier node_modules/.pnpm/node_modules/jest \
      node_modules/.pnpm/node_modules/playwright node_modules/.pnpm/node_modules/playwright-core \
      node_modules/.pnpm/node_modules/axe-core \
 && rm -rf node_modules/playwright node_modules/playwright-core node_modules/axe-core \
 && rm -f node_modules/.bin/vitest node_modules/.bin/eslint node_modules/.bin/prettier \
      node_modules/.bin/playwright

# The base image's package manager, removed from the runtime.
#
# Every finding in this image's vulnerability scan was inside
# /usr/local/lib/node_modules/npm — npm's own vendored dependencies (tar,
# pacote, sigstore, brace-expansion, picomatch, ip-address), not PalCert's.
# PalCert's dependency closure was clean. This process runs `node dist/…`; it
# never shells out to a package manager, so npm was pure attack surface that
# also failed the release gate on somebody else's advisories.
#
# corepack goes with it. It is the thing that would fetch and execute a
# package manager again, which is not a capability a production replica needs.
# Verified by starting the image: the module graph loads identically without
# them. scripts/check-image-dependencies.mjs fails the build if either returns.
RUN rm -rf /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack \
 && rm -f /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack

USER palcert
# `migrate deploy` applies pending migrations and nothing else: it never
# generates, never resets, never prompts, and never runs a destructive step
# Prisma would refuse in production.
CMD ["node_modules/.bin/prisma", "migrate", "deploy", "--schema", "prisma/schema.prisma"]
