#!/usr/bin/env node
/**
 * Decide whether the application layer may be rolled back to an earlier
 * release (Phase 20 Checkpoint 5).
 *
 *   node scripts/release/check-rollback-safety.mjs \
 *     --from release-manifest-B.json --to release-manifest-A.json \
 *     [--database "$DATABASE_ADMIN_URL"]
 *
 * PalCert rolls back the *application* by deploying earlier image digests.
 * It does not roll back the database, and this tool exists to say so at the
 * one moment the distinction matters.
 *
 * The question is not "can these images start" but "can the release being
 * rolled back to run against the schema that is actually in the database".
 * If B applied migrations that A has never heard of, A is being asked to run
 * against a future schema. Sometimes that is fine — an additive migration
 * leaves everything A knows about untouched. Sometimes it is not, and nothing
 * here can tell the difference automatically, so it refuses and says why.
 *
 * It will never invent a reverse migration. A down-migration written under
 * incident pressure, against a schema holding real customer data, is a larger
 * risk than the bug being rolled back.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

function parseArgs(argv) {
  const args = { from: null, to: null, database: null, confirmed: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--from') args.from = argv[(index += 1)];
    else if (arg === '--to') args.to = argv[(index += 1)];
    else if (arg === '--database') args.database = argv[(index += 1)];
    else if (arg === '--i-have-confirmed-schema-compatibility') args.confirmed = true;
  }
  return args;
}

const args = parseArgs(process.argv.slice(2));
if (args.from === null || args.to === null) {
  console.error('check-rollback-safety: --from and --to manifests are required');
  process.exit(64);
}

const from = JSON.parse(readFileSync(args.from, 'utf8'));
const to = JSON.parse(readFileSync(args.to, 'utf8'));

console.log(`rollback-safety: from ${from.releaseVersion} to ${to.releaseVersion}`);

if (from.releaseVersion === to.releaseVersion) {
  console.error('rollback-safety: those are the same release');
  process.exit(64);
}

// --- the application layer -------------------------------------------------
// Always possible: the target's digests either exist in the registry or they
// do not, and `verify-manifest --registry-check` answers that separately.
const changed = Object.keys(to.images).filter(
  (component) => to.images[component].digest !== from.images[component]?.digest,
);
console.log(
  `rollback-safety: ${changed.length} of ${Object.keys(to.images).length} image(s) change: ${changed.join(', ')}`,
);

// --- the schema ------------------------------------------------------------
const fromCount = from.migration?.count ?? 0;
const toCount = to.migration?.count ?? 0;

if (toCount === fromCount && to.migration?.checksum === from.migration?.checksum) {
  console.log('rollback-safety: both releases expect the same schema');
  console.log(
    `rollback-safety: SAFE — application rollback only, ${to.migration.head} stays applied`,
  );
  process.exit(0);
}

if (toCount > fromCount) {
  // Rolling *forward* in schema terms. Whatever this is, it is not a rollback.
  console.error(
    `rollback-safety: ${to.releaseVersion} expects MORE migrations (${toCount}) than ` +
      `${from.releaseVersion} (${fromCount}); this is not a rollback`,
  );
  process.exit(65);
}

const gap = fromCount - toCount;
console.error(
  `rollback-safety: ${from.releaseVersion} applied ${gap} migration(s) that ` +
    `${to.releaseVersion} does not know about.`,
);
console.error(`rollback-safety:   current head: ${from.migration.head}`);
console.error(`rollback-safety:   target head:  ${to.migration.head}`);

if (args.database !== null) {
  // What the database actually has, which is the only thing that matters. The
  // manifests describe intentions; this is the state.
  try {
    const applied = execFileSync(
      'psql',
      [
        args.database.replace(/[?&]schema=[^&]*/g, ''),
        '--no-psqlrc',
        '--quiet',
        '--tuples-only',
        '--no-align',
        '--set=ON_ERROR_STOP=1',
        '-c',
        'SELECT count(*) FROM _prisma_migrations WHERE finished_at IS NOT NULL;',
      ],
      { encoding: 'utf8' },
    ).trim();
    console.error(`rollback-safety:   the database has ${applied} migration(s) applied`);
    if (Number(applied) > toCount) {
      console.error(
        `rollback-safety:   so the database is ahead of ${to.releaseVersion} by ` +
          `${Number(applied) - toCount}`,
      );
    }
  } catch (error) {
    console.error(`rollback-safety:   could not read migration history: ${error.message}`);
  }
}

if (args.confirmed) {
  // The operator has looked at the migrations in the gap and decided the
  // target release tolerates them. Deliberately long and deliberately
  // awkward to type: it is a signed statement, not a retry.
  console.error('');
  console.error(
    `rollback-safety: ALLOWED BY OPERATOR — ${gap} migration(s) declared compatible with ` +
      `${to.releaseVersion}`,
  );
  console.error('rollback-safety: the application rolls back; the schema stays where it is.');
  process.exit(0);
}

console.error('');
console.error('rollback-safety: REFUSED — this needs a decision, not a command.');
console.error('rollback-safety: The application layer can be rolled back; the schema cannot be,');
console.error(
  'rollback-safety: and PalCert will not generate reverse migrations to pretend it can.',
);
console.error('rollback-safety: Either');
console.error('rollback-safety:   (a) confirm the extra migration(s) are additive and the target');
console.error('rollback-safety:       release tolerates them, then roll back the application only');
console.error('rollback-safety:       with --i-have-confirmed-schema-compatibility; or');
console.error('rollback-safety:   (b) forward-fix: build a new release that corrects the fault.');
console.error('rollback-safety: See docs/operations/rollback.md.');

// A distinct code, so a deployment workflow can tell "refused pending a
// human decision" from "something broke".
process.exit(3);
