/**
 * Types for the backup archive format.
 *
 * The implementation is plain ESM on purpose — the backup and restore tools
 * must run without the application being buildable, which is exactly the
 * condition a recovery starts from. These declarations let the test suite and
 * anything else in the TypeScript build reason about it without dragging the
 * tooling into the compiler's world.
 */

export declare const BACKUP_FORMAT_VERSION: number;
export declare const SUPPORTED_FORMAT_VERSIONS: readonly number[];

export interface BackupLayout {
  readonly manifest: string;
  readonly databaseDump: string;
  readonly referenceClosure: string;
  readonly objectManifest: string;
  readonly objectData: string;
}
export declare const LAYOUT: BackupLayout;

/** One component file, with what it should weigh and hash to. */
export interface BackupComponent {
  readonly path: string;
  readonly sizeBytes: number;
  readonly sha256: string;
}

export declare function objectDataPath(zone: string, key: string): string;

/** Throws when a key could escape the archive directory. Returns the key. */
export declare function assertSafeObjectKey(key: unknown): string;

export declare function sha256Hex(buffer: Buffer | Uint8Array): string;

export declare function toJsonl<T>(records: readonly T[], sortKey: (record: T) => string): string;

export declare function parseJsonl<T = Record<string, unknown>>(text: string): T[];

/** Every problem with a manifest, rather than only the first. */
export declare function validateManifest(manifest: unknown): string[];

/** Whether the backup recorded no missing objects and no checksum mismatches. */
export declare function manifestIsClean(manifest: unknown): boolean;
