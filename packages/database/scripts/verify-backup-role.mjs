#!/usr/bin/env node
/**
 * Prove the backup-role contract, in both directions (Phase 20 Checkpoint 4).
 *
 *   node scripts/verify-backup-role.mjs
 *
 * Two questions, and both answers matter:
 *
 *   The negative. Can the least-privileged application role take a complete
 *   backup? It must not be able to. If it could, the credential that every
 *   request path holds would also be a way to walk out with every tenant's
 *   data in one file.
 *
 *   The positive. Can the dedicated backup role? It must be able to, and the
 *   dump must actually contain rows -- because the failure this is really
 *   guarding against is not a refusal but a *silent* one, where row-level
 *   security filters every row and the archive looks fine until someone
 *   restores it and finds an empty installation.
 *
 * Also asserts the role's standing capabilities, so the contract cannot be
 * loosened later without this failing.
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

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

const adminUrl = process.env.DATABASE_ADMIN_URL;
const appUrl = process.env.DATABASE_URL;
const backupUrl = process.env.BACKUP_DATABASE_URL;
if ([adminUrl, appUrl, backupUrl].some((value) => value === undefined || value === '')) {
  console.error(
    'verify-backup-role: DATABASE_ADMIN_URL, DATABASE_URL and BACKUP_DATABASE_URL are required',
  );
  process.exit(78);
}

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok, detail });
  console.log(`verify-backup-role: ${ok ? 'ok  ' : 'FAIL'} ${name} — ${detail}`);
}

function query(url, sql, quiet = false) {
  return execFileSync(
    'psql',
    [
      toLibpqUrl(url),
      '--no-psqlrc',
      '--quiet',
      '--tuples-only',
      '--no-align',
      '--set=ON_ERROR_STOP=1',
      '-c',
      sql,
    ],
    // Cleanup runs against a role that may not exist; its complaints are
    // expected and would otherwise drown the result lines this tool exists for.
    {
      encoding: 'utf8',
      stdio: quiet ? ['ignore', 'pipe', 'ignore'] : ['ignore', 'pipe', 'inherit'],
    },
  ).trim();
}

function tryDump(url, outputPath) {
  try {
    execFileSync(
      'pg_dump',
      [toLibpqUrl(url), '--format=custom', '--no-password', `--file=${outputPath}`],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
    );
    return { ok: true, stderr: '' };
  } catch (error) {
    return { ok: false, stderr: String(error.stderr ?? error.message) };
  }
}

const workDir = mkdtempSync(path.join(tmpdir(), 'palcert-backup-role-'));
try {
  const roleName = process.env.BACKUP_DB_ROLE ?? 'palcert_backup';

  // --- the role's standing capabilities ------------------------------------
  const caps = query(
    adminUrl,
    `SELECT rolsuper::text||' '||rolbypassrls::text||' '||rolcreatedb::text||' '||rolcreaterole::text
     FROM pg_roles WHERE rolname='${roleName}';`,
  ).split(' ');
  check('backup role exists', caps.length === 4, caps.length === 4 ? roleName : 'not found');
  check('backup role is not a superuser', caps[0] === 'false', `rolsuper=${caps[0]}`);
  check(
    'backup role has BYPASSRLS, which PostgreSQL requires to read FORCE-RLS tables',
    caps[1] === 'true',
    `rolbypassrls=${caps[1]}`,
  );
  check('backup role cannot create databases', caps[2] === 'false', `rolcreatedb=${caps[2]}`);
  check('backup role cannot create roles', caps[3] === 'false', `rolcreaterole=${caps[3]}`);

  const writes = query(
    adminUrl,
    `SELECT count(*) FROM information_schema.table_privileges
     WHERE grantee='${roleName}' AND privilege_type IN ('INSERT','UPDATE','DELETE','TRUNCATE');`,
  );
  check('backup role holds no write grant', writes === '0', `${writes} write grant(s)`);

  // A read-only role that can call a SECURITY DEFINER function is not
  // read-only (Phase 20 Checkpoint 7). PostgreSQL grants EXECUTE on every new
  // function to PUBLIC by default, and PalCert's `app_*` functions run as the
  // schema owner — several of them write. So the absence of write *grants* was
  // never the whole contract: it also has to be unable to reach a function
  // that writes on its behalf.
  const executable = query(
    adminUrl,
    `SELECT count(*)::text FROM pg_proc p
       JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'public'
        AND has_function_privilege('${roleName}', p.oid, 'EXECUTE');`,
  );
  check(
    'backup role cannot execute any function in the application schema',
    executable === '0',
    `${executable} function(s) executable`,
  );

  const schemaRights = query(
    adminUrl,
    `SELECT has_schema_privilege('${roleName}', 'public', 'CREATE')::text;`,
  );
  check('backup role cannot mutate the schema', schemaRights === 'false', `CREATE=${schemaRights}`);

  const ownsAnything = query(
    adminUrl,
    `SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
     JOIN pg_roles r ON r.oid=c.relowner
     WHERE n.nspname='public' AND r.rolname='${roleName}';`,
  );
  check('backup role owns nothing', ownsAnything === '0', `${ownsAnything} object(s) owned`);

  const isAppRole = query(
    adminUrl,
    `SELECT (('${roleName}' = split_part(split_part('${appUrl}', '://', 2), ':', 1)))::text;`,
  );
  check('backup role is not the application role', isAppRole === 'false', 'distinct identities');

  // --- the negative: the application role must NOT be able to back up ------
  const appDump = tryDump(appUrl, path.join(workDir, 'app.dump'));
  check(
    'the application role cannot take a complete backup',
    !appDump.ok,
    appDump.ok ? 'it produced a dump, which is a privilege leak' : 'pg_dump refused',
  );
  // It is stopped twice over, and the first stop comes first: the application
  // role has no SELECT at all on the tables it was never given, so pg_dump
  // fails on a permission denial before it ever reaches a FORCE-RLS table.
  const deniedByGrant = /permission denied/i.test(appDump.stderr);
  const deniedByRls = /row-level security/i.test(appDump.stderr);
  check(
    'and it is refused loudly, with PostgreSQL naming the reason',
    !appDump.ok && (deniedByGrant || deniedByRls),
    deniedByGrant
      ? 'permission denied on a table it holds no grant for'
      : deniedByRls
        ? 'row-level security'
        : `unexpected reason: ${appDump.stderr.split('\n')[0] ?? ''}`,
  );

  // --- the hazard this contract exists to rule out -------------------------
  // The dangerous case is not a refusal but a *silent* one: a role that can
  // SELECT every table but cannot bypass row-level security could, in another
  // database design, dump 64 tables as empty and produce an archive that looks
  // healthy until someone restores it. Prove PostgreSQL does not do that, with
  // a throwaway role that has exactly those privileges.
  const probe = 'palcert_backup_rls_probe';
  const database = new URL(toLibpqUrl(adminUrl)).pathname.replace(/^\//, '');
  // A role cannot be dropped while any privilege still references it, so a
  // probe left behind by an interrupted run is revoked before it is dropped.
  const dropProbe = () => {
    for (const sql of [
      `REVOKE ALL ON ALL TABLES IN SCHEMA public FROM ${probe};`,
      `REVOKE ALL ON SCHEMA public FROM ${probe};`,
      `REVOKE ALL ON DATABASE "${database}" FROM ${probe};`,
      `DROP ROLE IF EXISTS ${probe};`,
    ]) {
      try {
        query(adminUrl, sql, true);
      } catch {
        // Best effort; the role may not exist at all.
      }
    }
  };

  try {
    dropProbe();
    query(
      adminUrl,
      `CREATE ROLE ${probe} LOGIN NOSUPERUSER NOBYPASSRLS PASSWORD 'probe-only-${process.pid}';`,
    );
    query(adminUrl, `GRANT CONNECT ON DATABASE "${database}" TO ${probe};`);
    query(adminUrl, `GRANT USAGE ON SCHEMA public TO ${probe};`);
    query(adminUrl, `GRANT SELECT ON ALL TABLES IN SCHEMA public TO ${probe};`);

    const probeUrl = new URL(toLibpqUrl(adminUrl));
    probeUrl.username = probe;
    probeUrl.password = `probe-only-${process.pid}`;
    const probeDump = tryDump(probeUrl.toString(), path.join(workDir, 'probe.dump'));
    check(
      'SELECT without BYPASSRLS cannot produce a backup at all',
      !probeDump.ok,
      probeDump.ok ? 'it produced a dump' : 'pg_dump refused',
    );
    check(
      'and PostgreSQL refuses rather than silently dumping empty tables',
      !probeDump.ok && /row-level security/i.test(probeDump.stderr),
      /row-level security/i.test(probeDump.stderr)
        ? 'named row-level security as the reason'
        : `unexpected reason: ${probeDump.stderr.split('\n')[0] ?? ''}`,
    );
  } finally {
    dropProbe();
  }

  // --- the positive: the backup role must be able to, with rows in it ------
  const backupPath = path.join(workDir, 'backup.dump');
  const backupDump = tryDump(backupUrl, backupPath);
  check(
    'the dedicated backup role can take a complete backup',
    backupDump.ok,
    backupDump.ok ? 'pg_dump succeeded' : (backupDump.stderr.split('\n')[0] ?? 'failed'),
  );

  if (backupDump.ok) {
    const size = statSync(backupPath).size;
    check('the dump is not empty', size > 0, `${(size / 1024).toFixed(1)} KiB`);

    const toc = execFileSync('pg_restore', ['--list', backupPath], { encoding: 'utf8' });
    const entries = toc.split('\n').filter((line) => line.length > 0 && !line.startsWith(';'));
    for (const [label, needle] of [
      ['row-level-security policies', ' POLICY '],
      ['functions', ' FUNCTION '],
      ['grants', ' ACL '],
    ]) {
      const count = entries.filter((line) => line.includes(needle)).length;
      check(`the dump carries ${label}`, count > 0, `${count}`);
    }

    // The real hazard is a dump that restores cleanly and is empty. Compare a
    // table the application role could never have read in full.
    const expected = query(adminUrl, 'SELECT count(*) FROM _prisma_migrations;');
    check(
      'the dump contains data, not just an empty schema',
      Number(expected) > 0 && entries.some((line) => line.includes(' TABLE DATA ')),
      `${entries.filter((line) => line.includes(' TABLE DATA ')).length} table-data sections`,
    );
  }
} finally {
  rmSync(workDir, { recursive: true, force: true });
}

const failures = results.filter((result) => !result.ok);
console.log(
  `verify-backup-role: ${results.length - failures.length}/${results.length} checks passed`,
);
if (failures.length > 0) process.exit(65);
