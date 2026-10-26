import type { Readable } from 'node:stream';

/**
 * Object storage, as the application sees it (§20).
 *
 * Two trust zones and a handful of narrow capabilities. Nothing here names a
 * bucket: the adapter maps a zone to a bucket from configuration, so no
 * caller can ever be handed a bucket name by a user. Nothing here lists
 * objects for callers either — a presigned URL that could LIST would be a
 * credential to enumerate other people's documents.
 */
/**
 * `derived` (Phase 6) holds analysis artifacts: PalCert's own output about a
 * user's document. It is written only by a worker, read only by PalCert, and
 * never presigned for a browser — an artifact is an internal implementation
 * detail, not a user-facing file (ADR-0042, §94).
 */
export type StorageZone = 'quarantine' | 'clean' | 'derived';

export const STORAGE_ZONES: readonly StorageZone[] = ['quarantine', 'clean', 'derived'];

export interface ObjectRef {
  readonly zone: StorageZone;
  readonly key: string;
  /** The exact object version. Required wherever content identity matters. */
  readonly versionId?: string | null;
}

/** What storage says an object is, at one moment. */
export interface StoredObjectIdentity {
  readonly key: string;
  /** Null when the bucket is not versioned — see `checkReadiness`. */
  readonly versionId: string | null;
  readonly etag: string | null;
  readonly sizeBytes: number;
  readonly contentType: string | null;
}

/** Short-lived bearer material for one PUT of one object. Never log or persist. */
export interface UploadAuthorization {
  readonly method: 'PUT';
  readonly url: string;
  /** Headers the client must send verbatim; they are part of the signature. */
  readonly headers: Readonly<Record<string, string>>;
  readonly expiresAt: Date;
}

/** Short-lived bearer material for one GET of one object version. */
export interface DownloadAuthorization {
  readonly method: 'GET';
  readonly url: string;
  readonly expiresAt: Date;
}

export interface StorageReadiness {
  readonly ok: boolean;
  /** Versioning state per zone. Quarantine must be `Enabled` (ADR-0034). */
  readonly versioning: Readonly<
    Record<StorageZone, 'Enabled' | 'Suspended' | 'Disabled' | 'unknown'>
  >;
  readonly message?: string;
}

/**
 * Raised for storage failures that are the infrastructure's, not the
 * document's: timeouts, 5xx, connection refused. Callers classify these as
 * FAILED (retryable), never as REJECTED.
 */
export class ObjectStorageUnavailableError extends Error {
  constructor(operation: string, cause: unknown) {
    super(`Object storage ${operation} failed`);
    this.name = 'ObjectStorageUnavailableError';
    this.cause = cause;
  }
}

export abstract class ObjectStoragePort {
  abstract createUploadAuthorization(params: {
    readonly zone: StorageZone;
    readonly key: string;
    readonly contentLength: number;
    readonly contentType: string;
    /** Lower-case hex; when given, storage verifies the uploaded bytes against it. */
    readonly sha256Hex?: string | null;
    readonly expiresInSeconds: number;
  }): Promise<UploadAuthorization>;

  /** Null when the object (or that version of it) does not exist. */
  abstract headObject(ref: ObjectRef): Promise<StoredObjectIdentity | null>;

  abstract getObjectStream(
    ref: ObjectRef,
  ): Promise<{ readonly stream: Readable; readonly identity: StoredObjectIdentity }>;

  /**
   * Server-side copy of an exact source version to a new key.
   *
   * The destination must not already exist: promotion writes a fresh object,
   * never replaces one (§42). The returned identity is the destination's.
   */
  abstract copyImmutable(params: {
    readonly source: ObjectRef;
    readonly destination: { readonly zone: StorageZone; readonly key: string };
    readonly contentType: string;
  }): Promise<StoredObjectIdentity>;

  /**
   * Write bytes PalCert produced itself (Phase 6 analysis artifacts).
   *
   * Server-side only: there is no presigned equivalent, because nothing a
   * browser sends belongs in the derived zone. Encryption is applied from
   * configuration exactly as it is for a promotion.
   */
  abstract putObject(params: {
    readonly zone: StorageZone;
    readonly key: string;
    readonly content: Buffer;
    readonly contentType: string;
  }): Promise<StoredObjectIdentity>;

  /** Read a whole object into memory. For artifacts, which are bounded. */
  abstract getObjectBytes(ref: ObjectRef): Promise<Buffer>;

  /**
   * Delete an object. With a version id, that version only; without one,
   * every version of the key. Idempotent: deleting nothing is success.
   */
  abstract deleteObject(ref: ObjectRef): Promise<void>;

  abstract createDownloadAuthorization(params: {
    readonly ref: ObjectRef;
    readonly expiresInSeconds: number;
    readonly contentDisposition: string;
    readonly contentType: string;
  }): Promise<DownloadAuthorization>;

  /** Bounded probe for the readiness endpoint. Must not throw. */
  abstract checkReadiness(): Promise<StorageReadiness>;
}
