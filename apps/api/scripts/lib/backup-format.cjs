/**
 * The on-disk shape of a PalCert backup, and the rules for reading one.
 *
 * Kept free of I/O and of the AWS and PostgreSQL clients so it can be tested
 * directly. Everything here is about one question: can this archive be
 * trusted enough to restore from, and can that be decided *before* disaster
 * day rather than during it?
 */
const { createHash } = require('node:crypto');

/**
 * The format version a reader understands.
 *
 * A backup is read by whatever version of PalCert is running when the
 * recovery happens, which is not the version that wrote it. An archive whose
 * layout this reader does not know is refused by name rather than parsed
 * optimistically -- a restore that half-understands its input is worse than
 * one that stops.
 */
const BACKUP_FORMAT_VERSION = 1;
const SUPPORTED_FORMAT_VERSIONS = Object.freeze([1]);

/** Paths inside a backup directory. One place, so writer and reader cannot drift. */
const LAYOUT = Object.freeze({
  manifest: 'backup.json',
  databaseDump: 'database/palcert.dump',
  referenceClosure: 'database/reference-closure.jsonl',
  objectManifest: 'objects/manifest.jsonl',
  objectData: 'objects/data',
});

/** Where an object's bytes live inside the archive. */
function objectDataPath(zone, key) {
  // The key is used verbatim as a relative path. `assertSafeObjectKey` is what
  // makes that safe; it runs on both the writing and the reading side.
  return `${LAYOUT.objectData}/${zone}/${key}`;
}

/**
 * Object keys become path segments inside the archive, so a key that escapes
 * its directory would let a crafted backup write anywhere the restoring
 * process can reach. PalCert mints its own keys and none of these shapes can
 * occur, which is exactly why the check is cheap to keep.
 */
function assertSafeObjectKey(key) {
  if (typeof key !== 'string' || key.length === 0) {
    throw new Error('Object key must be a non-empty string');
  }
  if (key.startsWith('/') || key.includes('\\')) {
    throw new Error(`Unsafe object key: ${key}`);
  }
  if (key.split('/').some((segment) => segment === '.' || segment === '..' || segment === '')) {
    throw new Error(`Unsafe object key: ${key}`);
  }
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f]/.test(key)) {
    throw new Error(`Unsafe object key: ${key}`);
  }
  return key;
}

function sha256Hex(buffer) {
  return createHash('sha256').update(buffer).digest('hex');
}

/**
 * Serialize records one-per-line, sorted, so two backups of identical content
 * produce byte-identical manifests.
 *
 * Determinism is not tidiness here: it is what lets an operator diff two
 * manifests, and what makes the manifest's own checksum meaningful.
 */
function toJsonl(records, sortKey) {
  return [...records]
    .sort((a, b) => (sortKey(a) < sortKey(b) ? -1 : sortKey(a) > sortKey(b) ? 1 : 0))
    .map((record) => JSON.stringify(record, Object.keys(record).sort()))
    .join('\n')
    .concat(records.length > 0 ? '\n' : '');
}

function parseJsonl(text) {
  return text
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line, index) => {
      try {
        return JSON.parse(line);
      } catch {
        throw new Error(`Malformed record on line ${index + 1}`);
      }
    });
}

/**
 * Everything a reader must agree with before a restore may begin.
 *
 * Returns the list of problems rather than throwing on the first, because an
 * operator deciding whether to reach for an older archive wants to know
 * everything that is wrong with this one, not just the first thing.
 */
function validateManifest(manifest) {
  const problems = [];
  const fail = (message) => problems.push(message);

  if (manifest === null || typeof manifest !== 'object') {
    return ['Manifest is not an object'];
  }
  if (!Number.isInteger(manifest.formatVersion)) {
    fail('Manifest has no integer formatVersion');
  } else if (!SUPPORTED_FORMAT_VERSIONS.includes(manifest.formatVersion)) {
    fail(
      `Backup format version ${manifest.formatVersion} is not supported by this build ` +
        `(understands ${SUPPORTED_FORMAT_VERSIONS.join(', ')})`,
    );
  }
  for (const field of ['backupId', 'createdAt', 'databaseSnapshotAt']) {
    if (typeof manifest[field] !== 'string' || manifest[field].length === 0) {
      fail(`Manifest field ${field} is missing`);
    }
  }
  const components = manifest.components;
  if (components === null || typeof components !== 'object') {
    fail('Manifest has no components index');
    return problems;
  }
  for (const name of ['databaseDump', 'referenceClosure', 'objectManifest']) {
    const component = components[name];
    if (component === null || typeof component !== 'object') {
      fail(`Manifest component ${name} is missing`);
      continue;
    }
    if (typeof component.path !== 'string') fail(`Component ${name} has no path`);
    if (!/^[0-9a-f]{64}$/.test(String(component.sha256))) {
      fail(`Component ${name} has no valid sha256`);
    }
    if (!Number.isInteger(component.sizeBytes) || component.sizeBytes < 0) {
      fail(`Component ${name} has no valid sizeBytes`);
    }
  }
  // A backup of nothing is the failure mode that looks most like success: the
  // command exits 0, the archive is small, and nobody notices until a restore
  // produces an empty installation.
  if (components.databaseDump && components.databaseDump.sizeBytes === 0) {
    fail('Database dump is empty');
  }
  if (!Number.isInteger(manifest.objectCount) || manifest.objectCount < 0) {
    fail('Manifest has no objectCount');
  }
  return problems;
}

/**
 * Whether the backup may be restored, given its own record of how it went.
 *
 * A backup that recorded dangling references is still *readable* -- and an
 * operator with nothing better may still choose it -- but it is not clean, and
 * nothing here will pretend otherwise.
 */
function manifestIsClean(manifest) {
  const reconciliation = manifest.reconciliation ?? {};
  return (
    (reconciliation.missingReferenced ?? 0) === 0 && (reconciliation.checksumMismatches ?? 0) === 0
  );
}

module.exports = {
  BACKUP_FORMAT_VERSION,
  SUPPORTED_FORMAT_VERSIONS,
  LAYOUT,
  objectDataPath,
  assertSafeObjectKey,
  sha256Hex,
  toJsonl,
  parseJsonl,
  validateManifest,
  manifestIsClean,
};
