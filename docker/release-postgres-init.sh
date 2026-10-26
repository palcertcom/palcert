#!/bin/sh
# Create the least-privileged request-path role, once, at first start.
#
# PalCert refuses to boot in production when DATABASE_URL and
# DATABASE_ADMIN_URL are the same connection, because row-level security is
# not enforced against the role that owns the schema. The release stack has to
# satisfy that the same way a real deployment does: two roles, one that owns
# the schema and one that serves requests.
#
# This runs only on an empty data directory, which is what a clean-state boot
# is. It is a release-testing convenience; a real deployment provisions the
# role through `pnpm db:provision-app-role` or its own infrastructure.
set -eu

psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" <<SQL
DO \$\$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'palcert_app') THEN
        CREATE ROLE palcert_app LOGIN PASSWORD '${POSTGRES_APP_PASSWORD}';
    END IF;
END
\$\$;

GRANT CONNECT ON DATABASE "$POSTGRES_DB" TO palcert_app;
GRANT USAGE ON SCHEMA public TO palcert_app;
SQL
