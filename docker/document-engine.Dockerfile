# syntax=docker/dockerfile:1.7
# Production image for the PalCert document engine.
FROM python:3.11-slim AS base
ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PIP_NO_CACHE_DIR=1
WORKDIR /srv

FROM base AS build
COPY services/document-engine/pyproject.toml ./
COPY services/document-engine/app ./app
RUN pip install --prefix=/install .

FROM base AS runtime
RUN groupadd --system palcert && useradd --system --gid palcert palcert
COPY --from=build /install /usr/local
COPY --from=build --chown=palcert:palcert /srv/app ./app
# The shared contracts, read at runtime by the schema validator and the
# property support registry. They are repository data rather than package
# resources on purpose: one file, read by both languages, so the analyzer and
# the API cannot disagree about a schema or about what PDF can answer. An image
# without them raises FileNotFoundError on the first analysis rather than
# validating nothing, which is the right failure — but it is a failure, so the
# files ship. Both lookups walk up from the module and find them at /srv.
COPY --chown=palcert:palcert contracts ./contracts

# The build toolchain, removed from the runtime.
#
# Both findings in this image's vulnerability scan were inside
# setuptools/_vendor (jaraco.context, wheel) — packages setuptools vendors for
# its own use, not PalCert's. The engine's own dependency closure was clean.
# setuptools is a build-system requirement here (pyproject's [build-system]),
# needed to produce the wheel in the `build` stage; the installed application
# imports none of it, and pip has no business in a running container either.
#
# Verified by importing app.main with all three removed: the application and
# its ten routes load unchanged. Proved on every build by
# scripts/check-image-dependencies.mjs.
RUN rm -rf /usr/local/lib/python3.11/site-packages/setuptools \
      /usr/local/lib/python3.11/site-packages/setuptools-* \
      /usr/local/lib/python3.11/site-packages/pkg_resources \
      /usr/local/lib/python3.11/site-packages/wheel \
      /usr/local/lib/python3.11/site-packages/wheel-* \
      /usr/local/lib/python3.11/site-packages/pip \
      /usr/local/lib/python3.11/site-packages/pip-* \
 && rm -f /usr/local/bin/pip /usr/local/bin/pip3 /usr/local/bin/pip3.11 \
      /usr/local/bin/wheel

# Release identity, in the final stage only so earlier layers stay cacheable
# across builds of the same source. `DOC_ENGINE_COMMIT` is what the engine's
# `palcert_build_info` metric and its log lines report (Phase 20 Checkpoint 3);
# an empty value reads as "unknown", which is honest, rather than as a
# fabricated commit.
ARG APP_COMMIT=""
ARG APP_BUILT_AT=""
ARG APP_VERSION="0.1.0"
ENV DOC_ENGINE_COMMIT=${APP_COMMIT}
LABEL org.opencontainers.image.revision=${APP_COMMIT} \
      org.opencontainers.image.created=${APP_BUILT_AT} \
      org.opencontainers.image.version=${APP_VERSION} \
      org.opencontainers.image.title="palcert-document-engine"

USER palcert
EXPOSE 8000
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD python -c "import urllib.request,sys; sys.exit(0 if urllib.request.urlopen('http://127.0.0.1:8000/health/live').status==200 else 1)"
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]
