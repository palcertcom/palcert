#!/usr/bin/env node
/**
 * Create the dedicated backup database role (Phase 20 Checkpoint 4).
 *
 *   BACKUP_DB_PASSWORD=... DATABASE_ADMIN_URL=... node scripts/provision-backup-role.mjs
 *
 * PalCert forces row-level security on 64 tables, which means even the table
 * owner is filtered by policy. A role without bypass capability therefore
 * cannot dump them -- `pg_dump` refuses with "query would be affected by
 * row-level security policy" rather than quietly writing an empty table, which
 * is the one mercy in this design. So `BYPASSRLS` is genuinely required by
 * PostgreSQL to take a complete backup, and this role has it.
 *
 * Everything else about the role is the narrowest thing that still works, and
 * the constraints are enforced here rather than left to a runbook:
 *
 *   - NOSUPERUSER. `BYPASSRLS` lets it read every row; superuser would let it
 *     do anything at all, including turn the policies off permanently.
 *   - NOCREATEDB, NOCREATEROLE, NOINHERIT.
 *   - SELECT on tables, and nothing else. No INSERT, UPDATE or DELETE: a
 *     backup reads. Nothing in the backup path writes to the database, and a
 *     role that cannot write cannot be turned into a way to corrupt the
 *     thing it exists to protect.
 *   - No ownership and no schema rights, so it cannot alter or drop anything.
 *   - Not the application role, and never used by the application: a
 *     credential that can read across every tenant must not be reachable from
 *     the request path.
 *
 * The password comes from the environment, never from a committed file, and is
 * never printed. Idempotent.
 */
import { execFileSync } from 'node:child_process';

function toLibpqUrl(value) {
  const PRISMA_ONLY = new Set(['schema', 'connection_limit', 'pool_timeout', 'pgbouncer']);
  let url;
  try {
    url = new URL(value);
  } catch {
    return value;
  }
  for (const key of [...url.searchParams.keys()]) {
    if (PRISMA_ONLY.has(key)) url.searchParams.delete(key);
  }
  return url.toString();
}

const ROLE = process.env.BACKUP_DB_ROLE ?? 'palcert_backup';
const password = process.env.BACKUP_DB_PASSWORD;
const adminUrl = process.env.DATABASE_ADMIN_URL;

if (adminUrl === undefined || adminUrl === '') {
  console.error('provision-backup-role: DATABASE_ADMIN_URL is required');
  process.exit(78);
}
if (password === undefined || password === '') {
  console.error('provision-backup-role: BACKUP_DB_PASSWORD is required');
  process.exit(78);
}
if (!/^[a-z_][a-z0-9_]*$/.test(ROLE)) {
  console.error('provision-backup-role: BACKUP_DB_ROLE must be a plain identifier');
  process.exit(64);
}

function psql(sql, env = {}) {
  return execFileSync(
    'psql',
    [
      toLibpqUrl(adminUrl),
      '--no-psqlrc',
      '--quiet',
      '--tuples-only',
      '--no-align',
      '--set=ON_ERROR_STOP=1',
      '--command',
      sql,
    ],
    { encoding: 'utf8', env: { ...process.env, ...env } },
  );
}

// Passed through a session setting into a DO block rather than interpolated
// into the statement text, so the password cannot break out of the statement
// or turn up in a parse error. Same pattern as the application role.
const capabilities = 'LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION BYPASSRLS';
const roleSql = `
DO $$
DECLARE
    pw text := current_setting('palcert.provision_password');
BEGIN
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${ROLE}') THEN
        EXECUTE format('ALTER ROLE %I WITH ${capabilities} PASSWORD %L', '${ROLE}', pw);
    ELSE
        EXECUTE format('CREATE ROLE %I WITH ${capabilities} PASSWORD %L', '${ROLE}', pw);
    END IF;
END
$$;
`;

try {
  execFileSync(
    'psql',
    [
      toLibpqUrl(adminUrl),
      '--no-psqlrc',
      '-v',
      'ON_ERROR_STOP=1',
      '-c',
      `SET palcert.provision_password = '${password.replace(/'/g, "''")}'; ${roleSql}`,
    ],
    { stdio: ['ignore', 'ignore', 'pipe'] },
  );
} catch {
  // Deliberately not reporting the caught error: psql echoes the failing
  // statement, and this statement carries the password.
  console.error(`provision-backup-role: could not create or alter ${ROLE}`);
  process.exit(70);
}

// Read-only, and explicitly so. The REVOKE runs unconditionally rather than
// only on creation: a role that acquired a write grant by some other route
// loses it every time this is run.
const database = new URL(toLibpqUrl(adminUrl)).pathname.replace(/^\//, '');
psql(`GRANT CONNECT ON DATABASE "${database}" TO ${ROLE};`);
psql(`GRANT USAGE ON SCHEMA public TO ${ROLE};`);
psql(`GRANT SELECT ON ALL TABLES IN SCHEMA public TO ${ROLE};`);
psql(
  `REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON ALL TABLES IN SCHEMA public FROM ${ROLE};`,
);
psql(`REVOKE CREATE ON SCHEMA public FROM ${ROLE};`);
// Tables added by a later migration must be readable without re-running this,
// and must still be read-only.
psql(`ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT ON TABLES TO ${ROLE};`);

const summary = psql(
  `SELECT rolsuper::text || ' ' || rolbypassrls::text || ' ' || rolcreatedb::text || ' ' || rolcreaterole::text
   FROM pg_roles WHERE rolname = '${ROLE}';`,
).trim();
const [isSuper, bypassRls, createDb, createRole] = summary.split(' ');

// Refuse to report success on a role that is not what this script promises.
if (isSuper !== 'false' || bypassRls !== 'true' || createDb !== 'false' || createRole !== 'false') {
  console.error(
    `provision-backup-role: ${ROLE} did not end up with the expected capabilities ` +
      `(superuser=${isSuper} bypassrls=${bypassRls} createdb=${createDb} createrole=${createRole})`,
  );
  process.exit(70);
}

const writable = psql(
  `SELECT count(*) FROM information_schema.table_privileges
   WHERE grantee = '${ROLE}' AND privilege_type IN ('INSERT','UPDATE','DELETE','TRUNCATE');`,
).trim();
if (writable !== '0') {
  console.error(`provision-backup-role: ${ROLE} holds ${writable} write grant(s); expected none`);
  process.exit(70);
}

const readable = psql(
  `SELECT count(*) FROM information_schema.table_privileges
   WHERE grantee = '${ROLE}' AND privilege_type = 'SELECT';`,
).trim();

console.log(
  `provision-backup-role: ${ROLE} ready — not a superuser, BYPASSRLS for FORCE-RLS tables, ` +
    `SELECT on ${readable} table(s), no write grants`,
);
