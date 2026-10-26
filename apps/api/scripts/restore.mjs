#!/usr/bin/env node
/**
 * Restore a PalCert backup into a clean destination (Phase 20 Checkpoint 4).
 *
 *   pnpm --filter @palcert/api restore -- \
 *     --from /var/backups/palcert/palcert-... \
 *     --to-database "$RESTORE_DATABASE_ADMIN_URL" \
 *     --storage-prefix RESTORE_STORAGE
 *
 * The order is not arbitrary. Nothing is written until the archive has been
 * shown to be complete and internally consistent, because a restore that
 * fails half way leaves an operator with neither the old installation nor a
 * working new one. And nothing is declared successful until the *restored*
 * database has been re-read and every object reference in it checked against
 * the objects that were uploaded -- the closure is recomputed from the rows
 * that actually landed, not replayed from the archive's own record of them.
 *
 * Refuses a destination that already has a PalCert schema unless told
 * otherwise. Restoring on top of live data is how a recovery turns one
 * outage into two.
 */
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
// The format module is CommonJS so the operator tooling and the test
// suite share one implementation rather than two that can drift.
import backupFormat from './lib/backup-format.cjs';

const {
  LAYOUT,
  assertSafeObjectKey,
  manifestIsClean,
  objectDataPath,
  parseJsonl,
  sha256Hex,
  validateManifest,
} = backupFormat;
import {
  PsqlSnapshotSession,
  existingRoles,
  psqlQuery,
  redactUrl,
  restoreDatabase,
  rolesReferencedByDump,
} from './lib/pg-tools.mjs';
import { getObject, objectStoreFromEnv, putObject } from './lib/object-store.mjs';

/**
 * Every column that pins an object to one exact stored version, by the key
 * column beside it and the zone it lives in (Phase 20 Checkpoint 9).
 *
 * PalCert reads a finalized object by (key, version id), never by key alone:
 * that is how a later overwrite of the same key cannot change what a report,
 * a certificate or a document download serves. A restore cannot preserve
 * version ids -- no S3 API lets a writer choose one -- so every object comes
 * back under a new id and every pin must be moved to it. Checkpoint 20.9's
 * upgrade rehearsal found that nothing did: the restored installation served
 * its metadata and failed every document download, certificate read and
 * report artifact with `NoSuchVersion`.
 *
 * Kept in step with lib/reference-closure.sql. A versioned reference whose
 * column is not listed here refuses the restore rather than leaving a pin
 * pointing at a version the destination has never held.
 */
const VERSION_PINS = [
  ['document_versions', 'quarantine_object_key', 'quarantine_object_version_id', 'quarantine'],
  ['document_versions', 'clean_object_key', 'clean_object_version_id', 'clean'],
  ['standard_source_assets', 'quarantine_object_key', 'quarantine_object_version_id', 'quarantine'],
  ['standard_source_assets', 'clean_object_key', 'clean_object_version_id', 'clean'],
  ['document_analyses', 'artifact_object_key', 'artifact_object_version_id', 'derived'],
  ['check_reports', 'artifact_object_key', 'artifact_object_version_id', 'derived'],
  ['smartfix_plans', 'artifact_object_key', 'artifact_object_version_id', 'derived'],
  ['smartfix_manifests', 'artifact_object_key', 'artifact_object_version_id', 'derived'],
  ['compliance_certificates', 'claim_object_key', 'claim_object_version_id', 'derived'],
  ['compliance_certificates', 'certificate_object_key', 'certificate_object_version_id', 'derived'],
  ['attestation_artifacts', 'quarantine_object_key', 'quarantine_object_version_id', 'quarantine'],
  ['attestation_artifacts', 'clean_object_key', 'clean_object_version_id', 'clean'],
  ['attestations', 'artifact_clean_object_key', 'artifact_clean_object_version_id', 'clean'],
  ['manual_topup_receipts', 'quarantine_object_key', 'quarantine_object_version_id', 'quarantine'],
  ['manual_topup_receipts', 'clean_object_key', 'clean_object_version_id', 'clean'],
  ['manual_payment_method_logos', 'quarantine_object_key', 'quarantine_object_version_id', 'quarantine'],
  ['manual_payment_method_logos', 'clean_object_key', 'clean_object_version_id', 'clean'],
];

const literal = (value) => `'${String(value).replaceAll("'", "''")}'`;

/**
 * One statement per pinned column: move every pin from the source store's
 * version id to the one the destination assigned, and count what moved.
 */
function repinStatements(repins) {
  const statements = [];
  for (const [table, keyColumn, versionColumn, zone] of VERSION_PINS) {
    const rows = repins.filter((entry) => entry.zone === zone);
    if (rows.length === 0) continue;
    const values = rows
      .map((entry) => `(${literal(entry.key)}, ${literal(entry.from)}, ${literal(entry.to)})`)
      .join(', ');
    statements.push(
      `WITH moved AS (UPDATE "${table}" AS t SET "${versionColumn}" = m.to_version ` +
        `FROM (VALUES ${values}) AS m(object_key, from_version, to_version) ` +
        `WHERE t."${keyColumn}" = m.object_key AND t."${versionColumn}" = m.from_version ` +
        `RETURNING 1) SELECT count(*) FROM moved;`,
    );
  }
  return statements;
}

const here = path.dirname(fileURLToPath(import.meta.url));

function parseArgs(argv) {
  const args = {
    from: null,
    toDatabase: null,
    storagePrefix: 'RESTORE_STORAGE',
    allowNonClean: false,
    allowUnclean: false,
    skipObjects: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--from') args.from = argv[(index += 1)];
    else if (arg === '--to-database') args.toDatabase = argv[(index += 1)];
    else if (arg === '--storage-prefix') args.storagePrefix = argv[(index += 1)];
    else if (arg === '--allow-non-clean') args.allowNonClean = true;
    else if (arg === '--allow-unclean-backup') args.allowUnclean = true;
    else if (arg === '--skip-objects') args.skipObjects = true;
  }
  return args;
}

function fail(message, exitCode = 1) {
  console.error(`restore: ${message}`);
  process.exit(exitCode);
}

/** Read a component and prove it is byte-for-byte what the manifest recorded. */
async function readComponent(root, component, label) {
  const absolute = path.join(root, component.path);
  let contents;
  try {
    contents = await readFile(absolute);
  } catch {
    fail(`${label} is missing from the archive (${component.path})`, 65);
  }
  const info = await stat(absolute);
  if (info.size !== component.sizeBytes) {
    fail(
      `${label} is ${info.size} bytes, manifest says ${component.sizeBytes} — archive is truncated`,
      65,
    );
  }
  const digest = sha256Hex(contents);
  if (digest !== component.sha256) {
    fail(`${label} does not match its recorded checksum — archive is corrupt`, 65);
  }
  return contents;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.from === null) fail('--from <backup directory> is required', 64);
  if (args.toDatabase === null) fail('--to-database <url> is required', 64);

  const root = args.from;

  // --- 1: is this archive readable, complete, and one this build understands?
  let manifest;
  try {
    manifest = JSON.parse(await readFile(path.join(root, LAYOUT.manifest), 'utf8'));
  } catch (error) {
    fail(`cannot read ${LAYOUT.manifest}: ${error.message}`, 65);
  }
  const problems = validateManifest(manifest);
  if (problems.length > 0) {
    for (const problem of problems) console.error(`restore:   ${problem}`);
    fail(`manifest is not usable (${problems.length} problem(s))`, 65);
  }
  console.log(`restore: archive ${manifest.backupId} (format v${manifest.formatVersion})`);
  console.log(`restore: database snapshot taken at ${manifest.databaseSnapshotAt}`);

  if (!manifestIsClean(manifest) && !args.allowUnclean) {
    const reconciliation = manifest.reconciliation ?? {};
    fail(
      `this backup recorded ${reconciliation.missingReferenced ?? 0} missing object(s) and ` +
        `${reconciliation.checksumMismatches ?? 0} checksum mismatch(es); ` +
        'pass --allow-unclean-backup to restore it anyway',
      65,
    );
  }

  const dumpContents = await readComponent(root, manifest.components.databaseDump, 'database dump');
  const objectManifestText = await readComponent(
    root,
    manifest.components.objectManifest,
    'object manifest',
  );
  await readComponent(root, manifest.components.referenceClosure, 'reference closure');
  const objectRecords = parseJsonl(objectManifestText.toString('utf8'));
  if (objectRecords.length !== manifest.objectCount) {
    fail(
      `object manifest lists ${objectRecords.length} object(s), manifest header says ${manifest.objectCount}`,
      65,
    );
  }
  console.log(
    `restore: archive verified — ${(dumpContents.length / 1024).toFixed(1)} KiB dump, ${objectRecords.length} objects`,
  );

  // --- 2: is the destination actually empty? -------------------------------
  const existing = await psqlQuery(
    args.toDatabase,
    "SELECT count(*) FROM pg_tables WHERE schemaname='public';",
  ).catch((error) => fail(`cannot reach the destination database: ${error.message}`, 69));
  const tableCount = Number(existing[0] ?? '0');
  if (tableCount > 0 && !args.allowNonClean) {
    fail(
      `destination already has ${tableCount} table(s) in schema public. ` +
        'A restore must go into a clean database; pass --allow-non-clean only if you are certain.',
      65,
    );
  }
  console.log(`restore: destination ${redactUrl(args.toDatabase)} is clean`);

  // --- 2a: does the destination cluster have the roles the archive names? ---
  // Roles live in the cluster, not the database, so the dump names them but
  // cannot create them. Without this the restore fails part-way through, with
  // the schema already half applied and a raw "role does not exist" to go on.
  const requiredRoles = await rolesReferencedByDump(
    path.join(root, manifest.components.databaseDump.path),
  );
  const present = new Set(await existingRoles(args.toDatabase, requiredRoles));
  const missingRoles = requiredRoles.filter((role) => !present.has(role));
  if (missingRoles.length > 0) {
    for (const role of missingRoles) console.error(`restore:   role ${role} does not exist here`);
    fail(
      `the destination cluster is missing ${missingRoles.length} role(s) this archive grants to. ` +
        'Provision them before restoring — a database restore cannot create cluster roles.',
      3,
    );
  }
  console.log(`restore: ${requiredRoles.length} referenced role(s) present on the destination`);

  // Every versioned reference must be one this tool knows how to re-pin.
  const pinnable = new Set(VERSION_PINS.map(([table, column]) => `${table}.${column}`));
  const unpinnable = objectRecords.filter(
    (record) =>
      record.objectVersionId !== null &&
      record.objectVersionId !== undefined &&
      !pinnable.has(`${record.sourceTable}.${record.sourceColumn}`),
  );
  if (unpinnable.length > 0) {
    for (const record of unpinnable.slice(0, 5)) {
      console.error(`restore:   ${record.sourceTable}.${record.sourceColumn} is version-pinned`);
    }
    fail('the archive pins objects in a column this restore cannot re-pin', 70);
  }

  // --- 3: the tables and their rows ------------------------------------------
  //
  // In two halves. `pre-data` and `data` bring back every table and row;
  // `post-data` -- indexes, constraints, triggers, policies and row-level
  // security -- waits until the object version pins have been moved (step
  // 4a). The immutability triggers would, correctly, refuse to let anything
  // rewrite an issued certificate's or a report's object reference, so the
  // one rewrite a restore must make happens before they exist.
  const dumpPath = path.join(root, manifest.components.databaseDump.path);
  const databaseStarted = Date.now();
  try {
    await restoreDatabase({ url: args.toDatabase, dumpPath, sections: ['pre-data', 'data'] });
  } catch (error) {
    fail(`database restore failed: ${error.message}`, 70);
  }
  let databaseMs = Date.now() - databaseStarted;
  console.log(`restore: tables and rows restored in ${(databaseMs / 1000).toFixed(1)}s`);

  // --- 4: the objects -------------------------------------------------------
  let objectsMs = 0;
  const repins = [];
  let store = null;
  if (!args.skipObjects) {
    try {
      store = objectStoreFromEnv(process.env, { prefix: args.storagePrefix });
    } catch (error) {
      fail(error.message, error.exitCode ?? 78);
    }
    const objectsStarted = Date.now();
    let uploaded = 0;
    // Filled per object below; consumed by step 4a.
    for (const record of objectRecords) {
      assertSafeObjectKey(record.key);
      const source = path.join(root, objectDataPath(record.zone, record.key));
      const bytes = await readFile(source).catch(() => null);
      if (bytes === null) {
        fail(`object ${record.zone}/${record.key} is listed in the manifest but absent`, 65);
      }
      const digest = sha256Hex(bytes);
      if (digest !== record.sha256) {
        fail(`object ${record.zone}/${record.key} does not match its manifest checksum`, 65);
      }
      const assigned = await putObject(store, record.zone, record.key, bytes);
      if (record.objectVersionId !== null && record.objectVersionId !== undefined) {
        if (assigned === null) {
          fail(
            `the ${record.zone} bucket returned no version id: PalCert pins every finalized ` +
              'object to a version, so its buckets must be versioned. The destination ' +
              'database is incomplete (no constraints, triggers or row-level security yet): ' +
              'do not start PalCert against it; version the buckets and restore again.',
            78,
          );
        }
        repins.push({
          zone: record.zone,
          key: record.key,
          from: record.objectVersionId,
          to: assigned,
        });
      }
      uploaded += 1;
    }
    objectsMs = Date.now() - objectsStarted;
    console.log(`restore: ${uploaded} objects uploaded in ${(objectsMs / 1000).toFixed(1)}s`);
  } else {
    console.log(
      'restore: object upload skipped at the operator’s request; object version pins still ' +
        'name the source store',
    );
  }

  // --- 4a: move every version pin to the version the destination holds -----
  let repinned = 0;
  if (repins.length > 0) {
    const statements = repinStatements(repins);
    try {
      const counts = await psqlQuery(args.toDatabase, `BEGIN; ${statements.join(' ')} COMMIT;`);
      repinned = counts.reduce((total, line) => total + (Number(line) || 0), 0);
    } catch (error) {
      fail(
        `re-pinning object versions failed: ${error.message}. The destination database is ` +
          'incomplete; do not start PalCert against it.',
        70,
      );
    }
    console.log(`restore: ${repinned} object version pin(s) moved to the restored objects`);
  }

  // --- 4b: indexes, constraints, triggers, policies, row-level security ---
  const postStarted = Date.now();
  try {
    await restoreDatabase({ url: args.toDatabase, dumpPath, sections: ['post-data'] });
  } catch (error) {
    fail(
      `database restore failed in post-data: ${error.message}. The destination database has ` +
        'no row-level security; do not start PalCert against it.',
      70,
    );
  }
  databaseMs += Date.now() - postStarted;
  console.log('restore: constraints, triggers, policies and row-level security restored');

  // --- 5: does the restored database agree with what was uploaded? ----------
  // The closure is recomputed here, from the rows that actually landed. This
  // is the difference between "the archive said it was consistent" and "the
  // installation in front of us is".
  const verificationStarted = Date.now();
  const session = new PsqlSnapshotSession(args.toDatabase);
  await session.open();
  let closure;
  try {
    const closureSql = await readFile(path.join(here, 'lib', 'reference-closure.sql'), 'utf8');
    const inner = closureSql
      .replace(/;\s*$/, '')
      .split('\n')
      .filter((line) => !line.trimStart().startsWith('--'))
      .join('\n');
    const rows = await session.query(`SELECT row_to_json(r) FROM (${inner}) r;`);
    closure = rows.map((line) => JSON.parse(line));
  } finally {
    await session.close();
  }

  const isTrue = (value) => value === true || value === 't';
  const missing = [];
  const mismatched = [];
  let verified = 0;
  let unhashed = 0;

  if (store !== null) {
    for (const reference of closure) {
      if (isTrue(reference.deleted)) continue;
      // By the version the restored row now pins -- the read the application
      // will make -- not merely the latest object under the key.
      const bytes = await getObject(
        store,
        reference.zone,
        reference.object_key,
        reference.object_version_id,
      );
      if (bytes === null) {
        if (isTrue(reference.ephemeral)) continue;
        missing.push(
          `${reference.source_table}.${reference.source_column} row ${reference.row_id}`,
        );
        continue;
      }
      const expected = reference.expected_sha256;
      if (typeof expected === 'string' && expected.length === 64) {
        if (sha256Hex(bytes) !== expected) {
          mismatched.push(
            `${reference.source_table}.${reference.source_column} row ${reference.row_id}`,
          );
        } else {
          verified += 1;
        }
      } else {
        // PalCert never hashed these exact bytes, so presence is all that can
        // honestly be claimed. Counted separately rather than folded into the
        // verified total, which would overstate what was proved.
        unhashed += 1;
      }
    }
  }
  const verificationMs = Date.now() - verificationStarted;

  console.log(
    `restore: ${closure.length} references in the restored database — ` +
      `${verified} hash-verified, ${unhashed} present (no recorded hash)`,
  );
  console.log(
    `restore: total ${((databaseMs + objectsMs + verificationMs) / 1000).toFixed(1)}s ` +
      `(database ${(databaseMs / 1000).toFixed(1)}s, objects ${(objectsMs / 1000).toFixed(1)}s, ` +
      `verification ${(verificationMs / 1000).toFixed(1)}s)`,
  );

  if (mismatched.length > 0) {
    console.error(`restore: ${mismatched.length} object(s) do not match PalCert's recorded hash:`);
    for (const entry of mismatched.slice(0, 5)) console.error(`restore:   ${entry}`);
    fail('restored rows point at corrupted objects', 65);
  }
  if (missing.length > 0) {
    console.error(
      `restore: ${missing.length} restored row(s) point at objects that are not there:`,
    );
    for (const entry of missing.slice(0, 5)) console.error(`restore:   ${entry}`);
    fail('restore is incomplete', 65);
  }

  // Machine-readable, for the drill and for CI.
  console.log(
    `restore-result: ${JSON.stringify({
      backupId: manifest.backupId,
      references: closure.length,
      versionPinsMoved: repinned,
      hashVerified: verified,
      presentWithoutHash: unhashed,
      databaseMs,
      objectsMs,
      verificationMs,
    })}`,
  );
}

main().catch((error) => {
  console.error(`restore: ${error.message}`);
  process.exit(1);
});
