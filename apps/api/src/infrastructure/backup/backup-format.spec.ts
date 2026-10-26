import { readFileSync } from 'node:fs';
import path from 'node:path';
import {
  BACKUP_FORMAT_VERSION,
  SUPPORTED_FORMAT_VERSIONS,
  assertSafeObjectKey,
  manifestIsClean,
  objectDataPath,
  parseJsonl,
  sha256Hex,
  toJsonl,
  validateManifest,
} from '../../../scripts/lib/backup-format.cjs';

const SCRIPTS = path.join(__dirname, '..', '..', '..', 'scripts');
const REPO = path.join(__dirname, '..', '..', '..', '..', '..');

/**
 * The rules a backup archive is read by.
 *
 * Tested directly rather than through a restore, because the point of these
 * rules is to reject an archive *before* anything is written — and a test that
 * had to perform a restore to discover that would be proving the opposite.
 */
describe('backup archive format', () => {
  interface TestManifest {
    formatVersion: number;
    backupId: string;
    createdAt: string;
    databaseSnapshotAt: string;
    objectCount: number;
    components: Record<string, { path: string; sizeBytes: number; sha256: string }>;
    reconciliation: { missingReferenced: number; checksumMismatches: number };
  }

  const validManifest = (): TestManifest => ({
    formatVersion: BACKUP_FORMAT_VERSION,
    backupId: 'palcert-2026-01-01T00-00-00-000Z',
    createdAt: '2026-01-01T00:00:00.000Z',
    databaseSnapshotAt: '2026-01-01T00:00:00.000+00',
    objectCount: 2,
    components: {
      databaseDump: { path: 'database/palcert.dump', sizeBytes: 1024, sha256: 'a'.repeat(64) },
      referenceClosure: {
        path: 'database/reference-closure.jsonl',
        sizeBytes: 10,
        sha256: 'b'.repeat(64),
      },
      objectManifest: { path: 'objects/manifest.jsonl', sizeBytes: 20, sha256: 'c'.repeat(64) },
    },
    reconciliation: { missingReferenced: 0, checksumMismatches: 0 },
  });

  it('accepts a well-formed manifest', () => {
    expect(validateManifest(validManifest())).toEqual([]);
  });

  it('refuses a format version this build does not understand', () => {
    const manifest = { ...validManifest(), formatVersion: BACKUP_FORMAT_VERSION + 1 };
    // Named, not merely rejected: an operator holding an archive written by a
    // newer PalCert needs to know that is what they are holding.
    expect(validateManifest(manifest).join(' ')).toContain('is not supported by this build');
  });

  it('knows which versions it supports', () => {
    expect(SUPPORTED_FORMAT_VERSIONS).toContain(BACKUP_FORMAT_VERSION);
  });

  it('refuses a component that could not be checksum-verified', () => {
    const manifest = validManifest();
    manifest.components['databaseDump'] = {
      ...manifest.components['databaseDump']!,
      sha256: 'not-a-digest',
    };
    expect(validateManifest(manifest).join(' ')).toContain('no valid sha256');
  });

  it('refuses an empty database dump', () => {
    // The failure that looks most like success: the command exits 0, the
    // archive is small, and nobody notices until a restore produces nothing.
    const manifest = validManifest();
    manifest.components['databaseDump'] = { ...manifest.components['databaseDump']!, sizeBytes: 0 };
    expect(validateManifest(manifest).join(' ')).toContain('Database dump is empty');
  });

  it('reports every problem at once rather than only the first', () => {
    expect(validateManifest({ formatVersion: 1 }).length).toBeGreaterThan(1);
  });

  it('calls a backup unclean when it recorded a missing object or a bad hash', () => {
    expect(manifestIsClean(validManifest())).toBe(true);
    expect(
      manifestIsClean({
        ...validManifest(),
        reconciliation: { missingReferenced: 1, checksumMismatches: 0 },
      }),
    ).toBe(false);
    expect(
      manifestIsClean({
        ...validManifest(),
        reconciliation: { missingReferenced: 0, checksumMismatches: 1 },
      }),
    ).toBe(false);
  });

  describe('object keys become paths inside the archive', () => {
    it('accepts the shapes PalCert actually mints', () => {
      expect(assertSafeObjectKey('users/abc/documents/def/versions/ghi/source')).toContain(
        'users/',
      );
    });

    it.each([
      ['parent traversal', '../../etc/passwd'],
      ['absolute', '/etc/passwd'],
      ['backslash', 'users\\..\\etc'],
      ['empty segment', 'users//source'],
      ['single dot', 'users/./source'],
      ['control character', 'users/\u0000/source'],
      ['empty', ''],
    ])('refuses a key that escapes its directory (%s)', (_label, key) => {
      // PalCert mints its own keys and none of these can occur, which is why
      // the check is cheap to keep: it is the difference between a crafted
      // archive being data and being code.
      expect(() => assertSafeObjectKey(key)).toThrow(/Unsafe object key|non-empty/);
    });

    it('places bytes under the zone they belong to', () => {
      expect(objectDataPath('derived', 'a/b.json')).toBe('objects/data/derived/a/b.json');
    });
  });

  describe('manifests are deterministic', () => {
    it('sorts records and keys so identical content produces identical bytes', () => {
      const first = toJsonl(
        [
          { b: 2, a: 1 },
          { b: 1, a: 0 },
        ],
        (record: { a: number }) => String(record.a),
      );
      const second = toJsonl(
        [
          { a: 0, b: 1 },
          { a: 1, b: 2 },
        ],
        (record: { a: number }) => String(record.a),
      );
      expect(first).toBe(second);
      // Determinism is not tidiness: it makes the manifest's own checksum
      // meaningful and two manifests diffable.
      expect(sha256Hex(Buffer.from(first))).toBe(sha256Hex(Buffer.from(second)));
    });

    it('round-trips through the line format', () => {
      const records = [
        { zone: 'clean', key: 'a' },
        { zone: 'derived', key: 'b' },
      ];
      expect(parseJsonl(toJsonl(records, (record: { key: string }) => record.key))).toEqual(
        records,
      );
    });

    it('names the line a malformed record is on', () => {
      expect(() => parseJsonl('{"a":1}\nnot json\n')).toThrow(/line 2/);
    });
  });
});

describe('the reference closure', () => {
  const sql = readFileSync(path.join(SCRIPTS, 'lib', 'reference-closure.sql'), 'utf8');

  /**
   * Every column in the schema that holds an object key must appear here.
   *
   * A column added by a later migration and forgotten would produce backups
   * that are silently incomplete: the rows restore, and point at objects
   * nobody copied. This is the test that makes that impossible to miss.
   */
  it('covers every object-key column in the schema', () => {
    const schema = readFileSync(
      path.join(REPO, 'packages', 'database', 'prisma', 'schema.prisma'),
      'utf8',
    );
    const columns = [
      ...new Set(
        [...schema.matchAll(/@map\("([a-z_]*object_key|storage_key)"\)/g)].map((match) => match[1]),
      ),
    ];
    expect(columns.length).toBeGreaterThan(0);
    for (const column of columns) expect(sql).toContain(column);
  });

  it('carries the three columns a verifier reasons about', () => {
    // `deleted` separates a lifecycle step from data loss; `ephemeral`
    // separates an upload in flight from a document somebody owns;
    // `expected_sha256` is null where PalCert never hashed those exact bytes,
    // and saying so is more honest than inventing a comparison.
    for (const column of ['deleted', 'ephemeral', 'expected_sha256']) {
      expect(sql).toContain(column);
    }
  });

  it('selects no column that would carry content or capability material', () => {
    // The comments are prose and legitimately contain words like "content";
    // what matters is what the statement selects, so they are stripped first.
    const statements = sql
      .split('\n')
      .filter((line) => !line.trimStart().startsWith('--'))
      .join('\n')
      .toLowerCase();
    expect(statements.length).toBeGreaterThan(0);
    for (const forbidden of ['content', 'ciphertext', 'secret', 'verification_code', 'password']) {
      // A backup manifest is written to disk and read during an incident. An
      // object key and a size are operational facts; a document's bytes or a
      // certificate's code would make the manifest itself a disclosure.
      expect(statements).not.toContain(forbidden);
    }
  });
});
