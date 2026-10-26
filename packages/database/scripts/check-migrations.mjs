#!/usr/bin/env node
/**
 * Refuse to let PalCert serve traffic against a schema that is not the one
 * this build was written for (Phase 20 Checkpoint 4).
 *
 *   pnpm --filter @palcert/database migrations:check
 *
 * A database one migration behind the code is the worst kind of broken: it
 * connects, it answers the readiness probe, it serves most requests, and it
 * fails only on the paths that needed the object the missing migration would
 * have created. Checkpoint 20.3 shipped exactly that and its end-to-end suite
 * reported green, because nothing compared the migrations on disk with the
 * migrations in the database. This is that comparison.
 *
 * Deliberately a *deployment and recovery* step, not a readiness probe. It
 * reads a directory listing and one table, which is far too much work to do
 * on every liveness poll, and the answer cannot change while a container is
 * running: the schema is settled before the process starts, by the migration
 * job it waits for.
 *
 * Exit codes are distinct so the caller can tell what to do next:
 *   0  the database is exactly at the code's migration level
 *   3  migrations exist in source that the database has not applied
 *   4  the database records a migration that failed or is half-applied, or
 *      carries tables with no migration history at all
 *   5  the database is ahead: it has migrations this build does not know
 *   6  the database is empty and has never been migrated
 *   69 the database could not be reached
 *   78 configuration is missing
 */
import { readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
// The client is generated into this package rather than into node_modules, so
// the tool imports it by path. That also keeps this script working inside the
// migrate image, where the application bundle is deliberately absent.
import { PrismaClient } from '../generated/client/index.js';

const here = path.dirname(fileURLToPath(import.meta.url));

function parseArgs(argv) {
  const args = { url: null, migrations: null, json: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--url') args.url = argv[(index += 1)];
    else if (arg === '--migrations') args.migrations = argv[(index += 1)];
    else if (arg === '--json') args.json = true;
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const url = args.url ?? process.env.DATABASE_ADMIN_URL ?? process.env.DATABASE_URL;
  if (url === undefined || url === null || url === '') {
    console.error('migrations:check: DATABASE_ADMIN_URL or --url is required');
    process.exit(78);
  }
  const migrationsDir = args.migrations ?? path.join(here, '..', 'prisma', 'migrations');

  let onDisk;
  try {
    onDisk = (await readdir(migrationsDir, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
  } catch (error) {
    console.error(`migrations:check: cannot read ${migrationsDir}: ${error.message}`);
    process.exit(78);
  }
  if (onDisk.length === 0) {
    console.error(`migrations:check: no migrations found in ${migrationsDir}`);
    process.exit(78);
  }

  const prisma = new PrismaClient({ datasources: { db: { url } } });
  let rows;
  try {
    rows = await prisma.$queryRawUnsafe(
      'SELECT migration_name, finished_at, rolled_back_at, applied_steps_count ' +
        'FROM _prisma_migrations ORDER BY migration_name',
    );
  } catch (error) {
    // A database with no `_prisma_migrations` table is one of two very
    // different things, and collapsing them into one exit code made a first
    // deployment into a clean environment indistinguishable from an outage.
    //
    //   empty schema     — never migrated. The normal starting state for a
    //                      new environment and for a restore into a clean
    //                      destination (Checkpoint 20.4). The migrate job is
    //                      exactly what fixes it.
    //   schema with data — tables exist but no migration history does. That
    //                      is a database built by something other than this
    //                      migration system, and running `migrate deploy`
    //                      against it would try to create objects that are
    //                      already there. It needs a person.
    let tables = null;
    if (/_prisma_migrations/.test(error.message)) {
      try {
        const rows = await prisma.$queryRawUnsafe(
          'SELECT count(*)::int AS count FROM information_schema.tables ' +
            "WHERE table_schema = 'public' AND table_type = 'BASE TABLE'",
        );
        tables = Number(rows[0]?.count ?? 0);
      } catch {
        tables = null;
      }
    }
    await prisma.$disconnect().catch(() => {});

    if (tables === 0) {
      console.error(
        `migrations:check: this database has never been migrated; ` +
          `${onDisk.length} migration(s) in source are all pending`,
      );
      process.exit(6);
    }
    if (tables !== null && tables > 0) {
      console.error(
        `migrations:check: FAIL no migration history, but ${tables} table(s) exist. ` +
          'This schema was not built by these migrations; it needs a decision, not a deploy.',
      );
      process.exit(4);
    }

    console.error(`migrations:check: cannot read migration history: ${error.message}`);
    process.exit(69);
  } finally {
    await prisma.$disconnect().catch(() => {});
  }

  const finished = new Set(
    rows
      .filter((row) => row.finished_at !== null && row.rolled_back_at === null)
      .map((row) => row.migration_name),
  );
  const unfinished = rows
    .filter((row) => row.finished_at === null && row.rolled_back_at === null)
    .map((row) => row.migration_name);
  const rolledBack = rows
    .filter((row) => row.rolled_back_at !== null)
    .map((row) => row.migration_name);
  const pending = onDisk.filter((name) => !finished.has(name));
  const ahead = [...finished].filter((name) => !onDisk.includes(name));

  const report = {
    migrationsInSource: onDisk.length,
    appliedAndFinished: finished.size,
    pending,
    unfinished,
    rolledBack,
    aheadOfCode: ahead,
  };

  if (args.json) {
    console.log(JSON.stringify(report, null, 2));
  }

  // Order matters: a half-applied migration is reported before a pending one,
  // because it is the condition that needs a human rather than another
  // `migrate deploy`.
  if (unfinished.length > 0 || rolledBack.length > 0) {
    for (const name of unfinished) {
      console.error(`migrations:check: ${name} started and never finished`);
    }
    for (const name of rolledBack) {
      console.error(`migrations:check: ${name} was rolled back`);
    }
    console.error(
      'migrations:check: FAIL the database is in a half-applied migration state; ' +
        'it needs a decision, not another deploy',
    );
    process.exit(4);
  }
  if (pending.length > 0) {
    for (const name of pending) console.error(`migrations:check: ${name} is not applied`);
    console.error(
      `migrations:check: FAIL ${pending.length} migration(s) in source are not in this database. ` +
        'Run the migration job before starting the application.',
    );
    process.exit(3);
  }
  if (ahead.length > 0) {
    for (const name of ahead) {
      console.error(`migrations:check: ${name} is applied but unknown to this build`);
    }
    console.error(
      'migrations:check: FAIL the database is ahead of this build. ' +
        'Deploying an older release over a newer schema is not supported.',
    );
    process.exit(5);
  }

  console.log(
    `migrations:check: OK ${onDisk.length} migration(s), database is at the code's level`,
  );
}

main().catch((error) => {
  console.error(`migrations:check: ${error.message}`);
  process.exit(1);
});
