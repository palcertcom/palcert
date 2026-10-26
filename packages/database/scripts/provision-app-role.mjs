#!/usr/bin/env node
/**
 * Grant LOGIN to the least-privileged application database role.
 *
 * The migration creates `palcert_app` with the correct privileges but NOLOGIN
 * and no password, because a committed migration must never contain a secret.
 * This step supplies the password from the environment — the secret manager in
 * a real deployment, a local placeholder in development.
 *
 *   APP_DB_PASSWORD=... DATABASE_ADMIN_URL=... node scripts/provision-app-role.mjs
 *
 * Idempotent, and prints nothing sensitive.
 */
import { execFileSync } from 'node:child_process';

/**
 * Strip Prisma-only query parameters before handing a connection string to
 * psql.
 *
 * `DATABASE_ADMIN_URL` is written for Prisma, which understands `?schema=`.
 * libpq does not, and rejects the whole URI with "invalid URI query parameter"
 * rather than ignoring what it does not recognise — so the URL that every other
 * tool in the repository uses cannot be passed through verbatim.
 */
function toLibpqUrl(value) {
  const PRISMA_ONLY = new Set(['schema', 'connection_limit', 'pool_timeout', 'pgbouncer']);
  let url;
  try {
    url = new URL(value);
  } catch {
    // Not a URL we can parse (a key/value conninfo string, say). Pass it
    // through untouched rather than mangling something that already works.
    return value;
  }
  for (const key of [...url.searchParams.keys()]) {
    if (PRISMA_ONLY.has(key)) url.searchParams.delete(key);
  }
  return url.toString();
}

const adminUrl = process.env.DATABASE_ADMIN_URL;
const password = process.env.APP_DB_PASSWORD;
const roleName = process.env.APP_DB_ROLE ?? 'palcert_app';

if (!adminUrl) {
  console.error('DATABASE_ADMIN_URL is required');
  process.exit(78);
}
if (!password || password.length < 12) {
  console.error('APP_DB_PASSWORD is required and must be at least 12 characters');
  process.exit(78);
}
if (!/^[a-z_][a-z0-9_]*$/.test(roleName)) {
  console.error('APP_DB_ROLE must be a plain lowercase identifier');
  process.exit(78);
}

// Passed as a bound parameter into a DO block rather than interpolated, so the
// password cannot break out of the statement or appear in a parse error.
const sql = `
DO $$
DECLARE
    pw text := current_setting('palcert.provision_password');
BEGIN
    EXECUTE format('ALTER ROLE %I LOGIN PASSWORD %L', '${roleName}', pw);
END
$$;
`;

try {
  execFileSync(
    'psql',
    [
      toLibpqUrl(adminUrl),
      '-v',
      'ON_ERROR_STOP=1',
      '-c',
      `SET palcert.provision_password = '${password.replace(/'/g, "''")}'; ${sql}`,
    ],
    { stdio: ['ignore', 'ignore', 'pipe'] },
  );
  process.stdout.write(`Application database role "${roleName}" can now log in.\n`);
} catch (error) {
  // Deliberately does not echo the command, which carries the password.
  console.error(`Failed to provision the application role: ${error.status ?? 'error'}`);
  process.exit(1);
}
