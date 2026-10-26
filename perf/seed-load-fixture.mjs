#!/usr/bin/env node
/**
 * Describe and validate a deployed environment's load fixture
 * (Phase 20 Checkpoint 6).
 *
 *   DATABASE_ADMIN_URL=... node perf/seed-load-fixture.mjs \
 *     --capability drill-capability.json --out perf-fixture.json
 *
 * It creates nothing. The data comes from Checkpoint 20.4's recovery fixture,
 * which builds an installation through real PalCert workflows — real uploads,
 * real checks, a real issued certificate — and is moved into the load
 * environment with the project's own backup and restore tools. Inventing
 * fifty-one columns of certificate chain with INSERT would measure a table,
 * not the product.
 *
 * ## Why this script does not write anything
 *
 * A verification code is never stored; only `sha256(canonicalCode)` is, so a
 * database reader cannot verify certificates they were not given the code
 * for. The load generator therefore cannot name a restored certificate, and
 * the first version of this script tried to fix that by repointing one
 * certificate's hash at a code the harness knew.
 *
 * The database refused:
 *
 *     ERROR: compliance_certificate … verification code is immutable
 *     CONTEXT: PL/pgSQL function compliance_certificates_guard()
 *
 * That guard is a Phase 15 safety property — a certificate that could be
 * repointed at a new code is a certificate that can be silently reassigned —
 * and a load fixture is nowhere near a good enough reason to weaken it. So
 * the code is captured at the one moment it legitimately exists in the clear:
 * when the fixture is built, through `DRILL_CAPABILITY_OUT`, the affordance
 * Checkpoint 20.4 already provides for exactly this purpose.
 *
 * This script reads that file, confirms the certificate it names is present
 * and publicly resolvable in *this* database, and writes the descriptor the
 * k6 scenarios read. If the capability file and the database disagree it
 * fails, because a scenario measuring the miss path while reporting the hit
 * path would produce excellent numbers for the wrong reason.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { canonicalizeVerificationCode, verificationCodeHash } = require(
  path.join(REPO, 'packages', 'contracts', 'dist', 'index.js'),
);

function parseArgs(argv) {
  const args = { out: null, capability: null, database: process.env.DATABASE_ADMIN_URL ?? null };
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === '--out') args.out = argv[(index += 1)];
    else if (argv[index] === '--capability') args.capability = argv[(index += 1)];
    else if (argv[index] === '--database') args.database = argv[(index += 1)];
  }
  return args;
}

const args = parseArgs(process.argv.slice(2));
if (args.database === null || args.capability === null) {
  console.error(
    'seed-load-fixture: --capability and DATABASE_ADMIN_URL (or --database) are required',
  );
  process.exit(78);
}

/** libpq does not accept Prisma's `?schema=`. */
const url = args.database.replace(/[?&]schema=[^&]*/g, '').replace(/\?$/, '');

function psql(sql) {
  return execFileSync(
    'psql',
    [
      url,
      '--no-psqlrc',
      '--quiet',
      '--tuples-only',
      '--no-align',
      '--set=ON_ERROR_STOP=1',
      '-c',
      sql,
    ],
    { encoding: 'utf8' },
  ).trim();
}

const capability = JSON.parse(readFileSync(args.capability, 'utf8'));
const canonical = canonicalizeVerificationCode(capability.verificationCode);
if (canonical === null) {
  console.error('seed-load-fixture: the capability file does not hold a valid verification code');
  process.exit(70);
}
const hash = verificationCodeHash(canonical);

// The endpoint's own query, asked of the database directly. If this returns a
// row, the scenario's "hit" really is a hit.
const resolved = psql(`SELECT count(*) FROM app_public_certificate('${hash}');`);
if (resolved !== '1') {
  console.error(
    `seed-load-fixture: the capability code resolves to ${resolved} certificate(s), expected 1.\n` +
      'seed-load-fixture: the capability file and this database are from different fixtures.',
  );
  process.exit(65);
}

const counts = Object.fromEntries(
  psql(
    `SELECT 'certificates', count(*) FROM compliance_certificates
      UNION ALL SELECT 'organizations', count(*) FROM organizations
      UNION ALL SELECT 'documents', count(*) FROM documents
      UNION ALL SELECT 'users', count(*) FROM users;`,
  )
    .split('\n')
    .map((line) => line.split('|')),
);

const fixture = {
  fixtureVersion: 1,
  seededAt: new Date().toISOString(),
  note:
    'Built by the Checkpoint 20.4 recovery fixture through real workflows and moved here with ' +
    'the project backup/restore tools. Nothing was fabricated or mutated.',
  publicVerification: {
    // A capability. The file this is written to is expected to live only as
    // long as the load run, alongside the drill capability file it came from.
    validCode: canonical,
    certificateId: capability.certificateId,
  },
  counts,
};

if (args.out !== null)
  writeFileSync(args.out, `${JSON.stringify(fixture, null, 2)}\n`, { mode: 0o600 });

console.log(`seed-load-fixture: certificate ${capability.certificateId} resolves publicly`);
for (const [name, count] of Object.entries(counts)) {
  console.log(`seed-load-fixture:   ${name}: ${count}`);
}
if (args.out !== null) console.log(`seed-load-fixture: written to ${args.out}`);
