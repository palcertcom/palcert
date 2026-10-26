# syntax=docker/dockerfile:1.7
# Production image for the PalCert web application.
FROM node:22-alpine AS base
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH
RUN corepack enable
WORKDIR /app

# Dependencies first, from the lockfile alone.
#
# `pnpm fetch` fills the package store from pnpm-lock.yaml without reading the
# workspace's package manifests, so this layer is rebuilt only when a
# dependency changes — not when a component or a stylesheet does. It used to
# sit after `COPY . .`, which made every UI edit download and install the whole
# workspace again. The store lives in the layer (not a cache mount) so the
# offline install below can rely on it on any builder, including a fresh CI
# runner restoring layers from its cache.
FROM base AS deps
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm fetch --store-dir /pnpm/store

FROM deps AS build
COPY . .
# Public variables are read at build time by Next and inlined into the client
# bundle, so they have to be present here rather than only at run time.
#
# The API URL defaults to empty, which the client reads as *same origin*. That
# is what a release deployment is: the proxy serves the API under `/api/` on
# the same host as the web app. The previous default was
# `http://localhost:4000`, and because the value is inlined at build time the
# published image carried it — so every API call a browser made from a deployed
# PalCert went to port 4000 on the user's own machine (Phase 20 Checkpoint 7).
# A deployment that really does split the two origins sets this build argument
# and must also revisit the cookie and CORS policy, which is why it is not the
# default.
ARG NEXT_PUBLIC_API_URL=""
ARG NEXT_PUBLIC_APP_NAME="PalCert"
ARG NEXT_PUBLIC_DEFAULT_LOCALE="en"
ENV NEXT_PUBLIC_API_URL=${NEXT_PUBLIC_API_URL} \
    NEXT_PUBLIC_APP_NAME=${NEXT_PUBLIC_APP_NAME} \
    NEXT_PUBLIC_DEFAULT_LOCALE=${NEXT_PUBLIC_DEFAULT_LOCALE}
# Still a frozen install — the lockfile must match every manifest exactly, or
# the build fails — but offline: every package comes from the store fetched
# above, so nothing new can be resolved or downloaded at this point.
RUN pnpm install --frozen-lockfile --offline --store-dir /pnpm/store \
 && pnpm --filter @palcert/contracts build \
 && pnpm --filter @palcert/config build \
 && pnpm --filter @palcert/web build

FROM node:22-alpine AS runtime
ENV NODE_ENV=production
WORKDIR /app
RUN addgroup -S palcert && adduser -S palcert -G palcert

# Standalone output, not the monorepo's `node_modules`.
#
# The previous image copied `/app/node_modules` wholesale, which shipped every
# devDependency in the workspace — vitest, testing-library, eslint, the Prisma
# CLI — inside the public web image (Phase 20 Checkpoint 1, F-006). Next's
# standalone build traces the modules the compiled server actually imports and
# writes them next to it, so the runtime stage copies one directory and a
# devDependency cannot arrive by being installed somewhere in the workspace.
#
# Two copies are the whole runtime: the traced server with its modules, and
# the static assets the server does not inline. There is no `public/` in this
# app — the previous Dockerfile copied one anyway, which is a build failure
# rather than an empty directory, and nothing caught it because nothing ever
# built this image.
COPY --from=build --chown=palcert:palcert /app/apps/web/.next/standalone ./
COPY --from=build --chown=palcert:palcert /app/apps/web/.next/static ./apps/web/.next/static

# Next's tracer pulls the TypeScript compiler into the standalone output
# because the framework loads it lazily for dev-time type checking. A
# production server never reaches that path, so 8.7 MB of compiler ships for a
# code path that cannot run. Removed and then proved by starting the server:
# `scripts/check-image-dependencies.mjs` fails the build if it returns.
RUN rm -rf node_modules/.pnpm/typescript@* node_modules/.pnpm/node_modules/typescript

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

ARG APP_COMMIT=""
ARG APP_BUILT_AT=""
ARG APP_VERSION="0.1.0"
ENV APP_COMMIT=${APP_COMMIT} APP_BUILT_AT=${APP_BUILT_AT} APP_VERSION=${APP_VERSION}
LABEL org.opencontainers.image.revision=${APP_COMMIT} \
      org.opencontainers.image.created=${APP_BUILT_AT} \
      org.opencontainers.image.version=${APP_VERSION} \
      org.opencontainers.image.title="palcert-web"

USER palcert
EXPOSE 3000
ENV PORT=3000 HOSTNAME=0.0.0.0
# Liveness: can this server still run a handler? It deliberately does not probe
# the API — restarting web would not bring the API back, and a restart loop
# across every replica during an API blip turns a partial outage into a total one.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3000/health/live').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
# Exec form and the traced server directly: `npx next start` would need the Next
# CLI in the image, which standalone output deliberately does not ship.
CMD ["node", "apps/web/server.js"]
