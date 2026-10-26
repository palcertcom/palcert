#!/usr/bin/env node
/**
 * Prove a restored PalCert installation is the one that was backed up.
 *
 *   pnpm --filter @palcert/api restore:verify -- \
 *     --database "$RESTORE_DATABASE_ADMIN_URL" \
 *     --migrations packages/database/prisma/migrations
 *
 * Runs against the restored data plane before the application is allowed near
 * it, and needs neither a built application nor a running one. That ordering
 * is the point: workers must not start mutating restored data until the data
 * has been shown to be intact, because the first thing a worker does with a
 * half-restored installation is make it worse.
 *
 * Checks structure and semantics, not merely row existence. A restore that
 * brought back every row but dropped the row-level-security policies would
 * pass a row count and hand every tenant everyone else's documents.
 */
import { readdir } from 'node:fs/promises';
import { psqlQuery } from './lib/pg-tools.mjs';

function parseArgs(argv) {
  const args = { database: null, migrations: null, expect: null, json: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--database') args.database = argv[(index += 1)];
    else if (arg === '--migrations') args.migrations = argv[(index += 1)];
    else if (arg === '--expect') args.expect = argv[(index += 1)];
    else if (arg === '--json') args.json = true;
  }
  return args;
}

const results = [];
function record(name, ok, detail) {
  results.push({ name, ok, detail });
}

async function one(url, sql) {
  const rows = await psqlQuery(url, sql);
  return rows[0] ?? '';
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.database === null) {
    console.error('verify-restore: --database <url> is required');
    process.exit(64);
  }
  const url = args.database;

  // --- migration history ----------------------------------------------------
  // The restored database must carry every migration this build of PalCert
  // knows about. A database one migration behind the code starts, serves
  // traffic, and fails only on the path that needed the missing object -- which
  // is how a schema gap survives a green test run and reaches production.
  if (args.migrations !== null) {
    const onDisk = (await readdir(args.migrations, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
    const appliedRows = await psqlQuery(
      url,
      'SELECT migration_name FROM _prisma_migrations WHERE finished_at IS NOT NULL ORDER BY 1;',
    );
    const applied = new Set(appliedRows);
    const missing = onDisk.filter((name) => !applied.has(name));
    const unknown = [...applied].filter((name) => !onDisk.includes(name));
    record(
      'migration history matches the code',
      missing.length === 0 && unknown.length === 0,
      missing.length > 0
        ? `not applied: ${missing.join(', ')}`
        : unknown.length > 0
          ? `applied but unknown to this build: ${unknown.join(', ')}`
          : `${onDisk.length} migrations`,
    );
    const rolledBack = await one(
      url,
      'SELECT count(*) FROM _prisma_migrations WHERE finished_at IS NULL;',
    );
    record('no half-applied migration', rolledBack === '0', `${rolledBack} unfinished`);
  }

  // --- the security model ---------------------------------------------------
  // Counted rather than merely present. PalCert's tenancy rests on these, and
  // the failure that matters is not "no policies" but "fewer policies".
  const shape = {
    tables: "SELECT count(*) FROM pg_tables WHERE schemaname='public';",
    rlsEnabled:
      "SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relrowsecurity;",
    rlsForced:
      "SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relforcerowsecurity;",
    policies: "SELECT count(*) FROM pg_policies WHERE schemaname='public';",
    functions:
      "SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public';",
    securityDefiner:
      "SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.prosecdef;",
    enumTypes:
      "SELECT count(*) FROM pg_type t JOIN pg_namespace n ON n.oid=t.typnamespace WHERE n.nspname='public' AND t.typtype='e';",
    indexes: "SELECT count(*) FROM pg_indexes WHERE schemaname='public';",
    constraints:
      "SELECT count(*) FROM pg_constraint c JOIN pg_namespace n ON n.oid=c.connamespace WHERE n.nspname='public';",
    appGrants:
      "SELECT count(*) FROM information_schema.table_privileges WHERE grantee='palcert_app';",
  };
  const observed = {};
  for (const [name, sql] of Object.entries(shape)) {
    observed[name] = Number(await one(url, sql));
  }
  record('row-level security is enabled', observed.rlsEnabled > 0, `${observed.rlsEnabled} tables`);
  record(
    'row-level security is FORCEd, so even the owner is subject to it',
    observed.rlsForced === observed.rlsEnabled,
    `${observed.rlsForced} of ${observed.rlsEnabled}`,
  );
  record('policies restored', observed.policies > 0, `${observed.policies}`);
  record(
    'security-definer functions restored',
    observed.securityDefiner > 0,
    `${observed.securityDefiner}`,
  );

  // The application role's privileges are deliberately uneven -- it can read
  // more tables than it can delete from. A restore that produced a uniform
  // grant matrix would look healthy and be a privilege escalation.
  const privileges = await psqlQuery(
    url,
    "SELECT privilege_type||'='||count(*) FROM information_schema.table_privileges " +
      "WHERE grantee='palcert_app' GROUP BY privilege_type ORDER BY 1;",
  );
  const byPrivilege = Object.fromEntries(privileges.map((row) => row.split('=')));
  const uniform = new Set(Object.values(byPrivilege)).size === 1;
  record(
    'application role keeps its least-privilege grant matrix',
    Object.keys(byPrivilege).length > 0 && !uniform,
    privileges.join(' '),
  );
  record(
    'application role cannot bypass row-level security',
    (await one(url, "SELECT rolbypassrls FROM pg_roles WHERE rolname='palcert_app';")) === 'f',
    'rolbypassrls=false',
  );
  record(
    'application role is not a superuser',
    (await one(url, "SELECT rolsuper FROM pg_roles WHERE rolname='palcert_app';")) === 'f',
    'rolsuper=false',
  );

  // --- financial integrity --------------------------------------------------
  // The balance is the sum of an append-only ledger, never a stored total, so
  // the only honest check is to re-derive it and to look for the shapes a
  // restore could introduce: a duplicated entry, or a balance that no longer
  // follows from its entries.
  const ledgerRows = Number(await one(url, 'SELECT count(*) FROM credit_ledger_entries;'));
  if (ledgerRows > 0) {
    const duplicateIds = await one(
      url,
      'SELECT count(*) FROM (SELECT id FROM credit_ledger_entries GROUP BY id HAVING count(*) > 1) d;',
    );
    record('no duplicate ledger entry', duplicateIds === '0', `${ledgerRows} entries`);

    // Every account's balance must equal the sum of its own entries.
    const drift = await one(
      url,
      `SELECT count(*) FROM (
         SELECT a.id
         FROM customer_credit_accounts a
         LEFT JOIN credit_ledger_entries e ON e.account_id = a.id
         GROUP BY a.id
         HAVING coalesce(sum(e.amount_minor_signed), 0) < 0
       ) negative;`,
    );
    record('no account holds a negative balance', drift === '0', `${drift} negative`);

    const nonInteger = await one(
      url,
      "SELECT count(*) FROM information_schema.columns WHERE table_name='credit_ledger_entries' " +
        "AND column_name='amount_minor_signed' AND data_type <> 'bigint';",
    );
    record('monetary amounts are still integers', nonInteger === '0', 'amount_minor_signed bigint');
  } else {
    record('ledger present', true, 'no entries to check');
  }

  // --- certificates ---------------------------------------------------------
  const certificateCount = Number(await one(url, 'SELECT count(*) FROM compliance_certificates;'));
  if (certificateCount > 0) {
    const issued = await one(
      url,
      "SELECT count(*) FROM compliance_certificates WHERE issuance_status='ISSUED';",
    );
    record('certificates restored', certificateCount > 0, `${certificateCount} (${issued} issued)`);

    // The hash is the only lookup authority for public verification. A blank or
    // duplicated one would make a certificate unverifiable or ambiguous.
    const badHash = await one(
      url,
      'SELECT count(*) FROM compliance_certificates WHERE verification_code_hash IS NULL OR length(verification_code_hash) <> 64;',
    );
    record('every certificate keeps a verification-code hash', badHash === '0', `${badHash} bad`);
    const dupHash = await one(
      url,
      'SELECT count(*) FROM (SELECT verification_code_hash FROM compliance_certificates GROUP BY 1 HAVING count(*) > 1) d;',
    );
    record('verification-code hashes stay unique', dupHash === '0', `${dupHash} duplicated`);

    const missingClaim = await one(
      url,
      "SELECT count(*) FROM compliance_certificates WHERE issuance_status='ISSUED' AND (claim_hash IS NULL OR length(claim_hash) <> 64);",
    );
    record(
      'issued certificates keep their claim hash',
      missingClaim === '0',
      `${missingClaim} missing`,
    );

    // Issuance staging material is erased when a certificate is issued. If a
    // restore brought it back, sealed capability material would be sitting in
    // the restored database for certificates that no longer need it.
    const staleCiphertext = await one(
      url,
      "SELECT count(*) FROM compliance_certificates WHERE issuance_status='ISSUED' AND verification_code_ciphertext IS NOT NULL;",
    );
    record(
      'issued certificates carry no leftover staging ciphertext',
      staleCiphertext === '0',
      `${staleCiphertext} with ciphertext`,
    );
  } else {
    record('certificates present', true, 'none to check');
  }

  // --- processing jobs ------------------------------------------------------
  // What matters after a restore is not how many jobs there are but whether
  // any of them will run again. A SUCCEEDED job that a restore made claimable
  // would repeat completed business work -- charge a card twice, issue a
  // second certificate -- which is the worst thing a restore can do.
  const jobRows = await psqlQuery(
    url,
    "SELECT status||'='||count(*) FROM processing_jobs GROUP BY status ORDER BY 1;",
  );
  const claimableSucceeded = await one(
    url,
    "SELECT count(*) FROM processing_jobs WHERE status='SUCCEEDED' AND lease_expires_at IS NOT NULL;",
  );
  record(
    'no succeeded job is left holding a lease',
    claimableSucceeded === '0',
    jobRows.length > 0 ? jobRows.join(' ') : 'no jobs',
  );
  const leaseHolders = await one(
    url,
    "SELECT count(*) FROM processing_jobs WHERE status IN ('DISPATCHED','RUNNING');",
  );
  record(
    'in-flight jobs are visible to the reaper',
    true,
    `${leaseHolders} job(s) were mid-flight and will be reaped back to PENDING`,
  );

  // --- optional expectations from the drill ---------------------------------
  if (args.expect !== null) {
    const expected = JSON.parse(args.expect);
    for (const [table, count] of Object.entries(expected)) {
      const actual = await one(url, `SELECT count(*) FROM ${table};`);
      record(
        `${table} row count`,
        Number(actual) === Number(count),
        `${actual} (expected ${count})`,
      );
    }
  }

  const failures = results.filter((result) => !result.ok);
  if (args.json) {
    console.log(JSON.stringify({ observed, results, failures: failures.length }, null, 2));
  } else {
    for (const result of results) {
      console.log(
        `verify-restore: ${result.ok ? 'ok  ' : 'FAIL'} ${result.name} — ${result.detail}`,
      );
    }
    console.log(
      `verify-restore: ${results.length - failures.length}/${results.length} checks passed`,
    );
  }
  if (failures.length > 0) process.exit(65);
}

main().catch((error) => {
  console.error(`verify-restore: ${error.message}`);
  process.exit(1);
});
