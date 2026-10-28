# syntax=docker/dockerfile:1.7
# Operator tooling for backup, restore and recovery rehearsals
# (Phase 20 Checkpoints 4 and 5).
#
# Not a release image and not part of the release set: nothing in PalCert
# runs from it and no manifest names it. It exists so the backup and restore
# tools can be run from inside a deployment's own network, which is both how
# an operator would actually reach a production data plane — it is not
# published — and the only way to get PostgreSQL client tools whose major
# version matches the server.
#
# That version match is not a detail. `pg_dump` refuses outright when its
# major version is older than the server's, so a host with PostgreSQL 16
# tools cannot back up a PostgreSQL 17 database at all. Pinning the client to
# the same major as the topology's server removes the question.
FROM node:22-alpine

# postgresql17-client for pg_dump, pg_restore and psql; the rest are what the
# backup tool shells out to. bash runs the release gates written for it
# (check-service-revenue-rollback.sh) inside the deployment's network.
RUN apk add --no-cache postgresql17-client ca-certificates bash

WORKDIR /repo
ENTRYPOINT []
CMD ["node", "--version"]
