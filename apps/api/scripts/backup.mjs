#!/usr/bin/env node
/**
 * Create one logically consistent PalCert backup (Phase 20 Checkpoint 4).
 *
 *   pnpm --filter @palcert/api backup -- --out /var/backups/palcert
 *
 * A PalCert backup is not "a database dump and a pile of files". The database
 * holds object keys and the object store holds the bytes those keys name, so
 * a backup is only useful if the two halves agree. PostgreSQL and an
 * S3-compatible store cannot be snapshotted atomically together, so this tool
 * does the next best thing and *proves* the result rather than assuming it:
 *
 *   1. Open a repeatable-read transaction and export its snapshot id.
 *   2. Run `pg_dump --snapshot` against that same id, so the dump is the
 *      database exactly as it stood at one instant.
 *   3. Read the reference closure -- every database-to-object reference --
 *      inside that same still-open transaction, so the list of objects the
 *      backup must contain is derived from the very rows that were dumped,
 *      not from the live database as it has since moved on.
 *   4. Copy those objects.
 *   5. Reconcile: every referenced object the database did not already record
 *      as deleted must be present, and must hash to what PalCert recorded.
 *
 * Step 3 is what makes this a unit. Step 5 is what makes the claim checkable:
 * objects are copied after the database snapshot, so an object collected in
 * between would leave a dangling reference -- and this finds it now, on a
 * quiet afternoon, rather than during a recovery.
 *
 * Reads DATABASE_ADMIN_URL and STORAGE_* from the environment. Never prints a
 * credential, a presigned URL, or any document's content.
 */
import { mkdir, readFile, writeFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
// The format module is CommonJS so the operator tooling and the test
// suite share one implementation rather than two that can drift.
import backupFormat from './lib/backup-format.cjs';

const { BACKUP_FORMAT_VERSION, LAYOUT, assertSafeObjectKey, objectDataPath, sha256Hex, toJsonl } =
  backupFormat;
import { PsqlSnapshotSession, dumpDatabase, redactUrl } from './lib/pg-tools.mjs';
import {
  ZONES,
  getObject,
  listZone,
  objectStoreFromEnv,
  zoneIsVersioned,
} from './lib/object-store.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));

function parseArgs(argv) {
  const args = { out: null, allowDangling: false, label: null };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--out') args.out = argv[(index += 1)];
    else if (arg === '--label') args.label = argv[(index += 1)];
    else if (arg === '--allow-dangling') args.allowDangling = true;
  }
  return args;
}

function fail(message, exitCode = 1) {
  console.error(`backup: ${message}`);
  process.exit(exitCode);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.out === null) fail('--out <directory> is required', 64);

  const databaseUrl = process.env.DATABASE_ADMIN_URL;
  if (databaseUrl === undefined || databaseUrl === '') {
    fail('DATABASE_ADMIN_URL is required', 78);
  }
  let store;
  try {
    store = objectStoreFromEnv();
  } catch (error) {
    fail(error.message, error.exitCode ?? 78);
  }

  const startedAt = Date.now();
  const backupId = `palcert-${new Date(startedAt).toISOString().replace(/[:.]/g, '-')}`;
  const root = path.join(args.out, backupId);
  await mkdir(path.join(root, 'database'), { recursive: true });
  await mkdir(path.join(root, LAYOUT.objectData), { recursive: true });

  console.log(`backup: ${backupId}`);
  console.log(`backup: database ${redactUrl(databaseUrl)}`);
  console.log(`backup: object store ${store.endpoint}`);

  // --- 1..3: one instant, shared by the dump and the closure -----------------
  const session = new PsqlSnapshotSession(databaseUrl);
  await session.open();
  let snapshot;
  let closure;
  let dumpMs = 0;
  try {
    snapshot = await session.exportSnapshot();
    console.log(`backup: snapshot ${snapshot.snapshotId} at ${snapshot.snapshotAt}`);

    const dumpStarted = Date.now();
    await dumpDatabase({
      url: databaseUrl,
      snapshotId: snapshot.snapshotId,
      outputPath: path.join(root, LAYOUT.databaseDump),
    });
    dumpMs = Date.now() - dumpStarted;

    const closureSql = await readFile(path.join(here, 'lib', 'reference-closure.sql'), 'utf8');
    // Strip the trailing semicolon so the statement can be wrapped.
    const inner = closureSql.replace(/;\s*$/, '');
    const rows = await session.query(
      `SELECT row_to_json(r) FROM (${stripLeadingComments(inner)}) r;`,
    );
    closure = rows.map((line) => JSON.parse(line));
  } finally {
    await session.close();
  }
  console.log(`backup: database dumped in ${(dumpMs / 1000).toFixed(1)}s`);
  console.log(`backup: ${closure.length} object references in the snapshot`);

  // --- 4: copy the objects the snapshot names --------------------------------
  // Only referenced objects are copied. An object nothing references cannot be
  // reached by any restored workflow, so copying it would cost storage to
  // protect something already unreachable -- but the count is recorded below,
  // because a large drift is worth an operator's attention.
  const objectsStarted = Date.now();
  const wanted = new Map();
  for (const reference of closure) {
    assertSafeObjectKey(reference.object_key);
    const id = `${reference.zone}\u0000${reference.object_key}`;
    if (!wanted.has(id)) wanted.set(id, { ...reference, references: 1 });
    else wanted.get(id).references += 1;
  }

  const objectRecords = [];
  const missingReferenced = [];
  const missingEphemeral = [];
  const checksumMismatches = [];
  let copiedBytes = 0;
  let pinnedByVersion = 0;

  for (const reference of wanted.values()) {
    const { zone, object_key: key } = reference;
    // Fetched by the exact version the database recorded, wherever one was
    // recorded. In a versioned bucket a DELETE writes a delete marker and
    // leaves the version itself retrievable, so a concurrent collection
    // between the database snapshot and this read cannot pull the bytes out
    // from under the backup. Where no version id exists, the plain read is
    // all there is -- and the reconciliation below is what covers it.
    const pinned =
      reference.object_version_id !== null && reference.object_version_id !== undefined;
    const bytes = await getObject(store, zone, key, reference.object_version_id);
    if (pinned && bytes !== null) pinnedByVersion += 1;
    if (bytes === null) {
      // The database records this reference as already collected, so its
      // absence is the lifecycle working, not data loss.
      if (reference.deleted === true || reference.deleted === 't') continue;
      if (reference.ephemeral === true || reference.ephemeral === 't') {
        missingEphemeral.push({ zone, key, source: reference.source_table });
        continue;
      }
      missingReferenced.push({
        zone,
        key,
        sourceTable: reference.source_table,
        sourceColumn: reference.source_column,
        rowId: reference.row_id,
      });
      continue;
    }

    const digest = sha256Hex(bytes);
    const expected = reference.expected_sha256;
    if (typeof expected === 'string' && expected.length === 64 && expected !== digest) {
      checksumMismatches.push({
        zone,
        key,
        sourceTable: reference.source_table,
        rowId: reference.row_id,
        expected,
        actual: digest,
      });
    }

    const destination = path.join(root, objectDataPath(zone, key));
    await mkdir(path.dirname(destination), { recursive: true });
    await writeFile(destination, bytes);
    copiedBytes += bytes.length;

    objectRecords.push({
      zone,
      key,
      sizeBytes: bytes.length,
      sha256: digest,
      // What PalCert believed about these bytes, carried alongside what they
      // actually are. A restore compares both.
      expectedSha256: typeof expected === 'string' && expected.length === 64 ? expected : null,
      objectVersionId: reference.object_version_id ?? null,
      // Whether these exact bytes were pinned by version rather than read by
      // key. An operator reading a manifest can tell which objects were immune
      // to a concurrent delete and which were merely lucky.
      pinnedByVersion: pinned,
      sourceTable: reference.source_table,
      sourceColumn: reference.source_column,
      ephemeral: reference.ephemeral === true || reference.ephemeral === 't',
    });
  }
  const objectsMs = Date.now() - objectsStarted;
  console.log(
    `backup: ${objectRecords.length} objects copied (${(copiedBytes / 1024).toFixed(1)} KiB) in ${(objectsMs / 1000).toFixed(1)}s`,
  );

  // Objects present in the store that the snapshot does not reference. Not
  // copied; counted, so drift is visible rather than invisible.
  const unreferenced = {};
  const versioning = {};
  for (const zone of ZONES) {
    const keys = await listZone(store, zone);
    const referenced = new Set(
      objectRecords.filter((record) => record.zone === zone).map((record) => record.key),
    );
    unreferenced[zone] = keys.filter((key) => !referenced.has(key)).length;
    versioning[zone] = await zoneIsVersioned(store, zone);
  }

  // --- write the manifests ---------------------------------------------------
  const closureJsonl = toJsonl(
    closure.map((reference) => ({
      sourceTable: reference.source_table,
      sourceColumn: reference.source_column,
      rowId: reference.row_id,
      zone: reference.zone,
      objectKey: reference.object_key,
      objectVersionId: reference.object_version_id ?? null,
      expectedSha256: reference.expected_sha256 ?? null,
      expectedSizeBytes:
        reference.expected_size_bytes === null || reference.expected_size_bytes === undefined
          ? null
          : Number(reference.expected_size_bytes),
      deleted: reference.deleted === true || reference.deleted === 't',
      ephemeral: reference.ephemeral === true || reference.ephemeral === 't',
    })),
    (record) => `${record.zone}/${record.objectKey}/${record.sourceTable}/${record.rowId}`,
  );
  await writeFile(path.join(root, LAYOUT.referenceClosure), closureJsonl);

  const objectJsonl = toJsonl(objectRecords, (record) => `${record.zone}/${record.key}`);
  await writeFile(path.join(root, LAYOUT.objectManifest), objectJsonl);

  const component = async (relativePath) => {
    const absolute = path.join(root, relativePath);
    const contents = await readFile(absolute);
    const info = await stat(absolute);
    return { path: relativePath, sizeBytes: info.size, sha256: sha256Hex(contents) };
  };

  const finishedAt = Date.now();
  const manifest = {
    formatVersion: BACKUP_FORMAT_VERSION,
    backupId,
    label: args.label,
    createdAt: new Date(startedAt).toISOString(),
    completedAt: new Date(finishedAt).toISOString(),
    databaseSnapshotAt: snapshot.snapshotAt,
    databaseSnapshotId: snapshot.snapshotId,
    // Identifies the source without naming a host or carrying a credential.
    source: {
      databaseName: databaseUrl.replace(/^.*\/([^/?]+)(\?.*)?$/, '$1'),
      objectStoreEndpoint: store.endpoint,
      buckets: store.buckets,
      bucketVersioning: versioning,
    },
    components: {
      databaseDump: await component(LAYOUT.databaseDump),
      referenceClosure: await component(LAYOUT.referenceClosure),
      objectManifest: await component(LAYOUT.objectManifest),
    },
    objectCount: objectRecords.length,
    objectBytes: copiedBytes,
    referenceCount: closure.length,
    // The consistency model, recorded in the archive rather than only in a
    // document, so a future reader knows what this particular backup proved.
    consistency: {
      model: 'shared-snapshot-closure',
      databaseSnapshotIsolation: 'repeatable read',
      closureDerivedFrom: 'the database snapshot, inside the same transaction',
      objectsCopiedAfterSnapshot: true,
      objectsPinnedByVersion: pinnedByVersion,
      objectsReadByKeyOnly: objectRecords.length - pinnedByVersion,
      bucketVersioning: versioning,
    },
    unreferencedObjectsInStore: unreferenced,
    reconciliation: {
      missingReferenced: missingReferenced.length,
      missingEphemeral: missingEphemeral.length,
      checksumMismatches: checksumMismatches.length,
      details: { missingReferenced, missingEphemeral, checksumMismatches },
    },
    timings: {
      databaseDumpMs: dumpMs,
      objectCopyMs: objectsMs,
      totalMs: finishedAt - startedAt,
    },
  };
  await writeFile(path.join(root, LAYOUT.manifest), `${JSON.stringify(manifest, null, 2)}\n`);

  // --- 5: report and decide --------------------------------------------------
  console.log(`backup: written to ${root}`);
  console.log(`backup: total ${((finishedAt - startedAt) / 1000).toFixed(1)}s`);

  if (checksumMismatches.length > 0) {
    console.error(
      `backup: ${checksumMismatches.length} object(s) do not match the hash PalCert recorded`,
    );
    for (const mismatch of checksumMismatches.slice(0, 5)) {
      console.error(`backup:   ${mismatch.sourceTable}/${mismatch.rowId} ${mismatch.zone}`);
    }
    process.exit(65);
  }
  if (missingReferenced.length > 0) {
    console.error(
      `backup: ${missingReferenced.length} referenced object(s) are missing from the store`,
    );
    for (const missing of missingReferenced.slice(0, 5)) {
      console.error(
        `backup:   ${missing.sourceTable}.${missing.sourceColumn} row ${missing.rowId}`,
      );
    }
    if (!args.allowDangling) {
      console.error('backup: refusing to record this as a clean backup (--allow-dangling to keep)');
      process.exit(65);
    }
    console.error('backup: kept as an unclean backup at the operator’s request');
  }
  if (missingEphemeral.length > 0) {
    console.log(
      `backup: ${missingEphemeral.length} in-flight upload object(s) absent; not a data loss`,
    );
  }
}

/**
 * The closure file opens with a long comment; PostgreSQL accepts it inline,
 * but wrapping the statement in `SELECT ... FROM (<here>) r` would put the
 * comment before the sub-select's opening parenthesis is closed. Lifting it
 * out keeps the file readable and the wrapping valid.
 */
function stripLeadingComments(sql) {
  return sql
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('--'))
    .join('\n');
}

main().catch((error) => {
  console.error(`backup: ${error.message}`);
  process.exit(1);
});
