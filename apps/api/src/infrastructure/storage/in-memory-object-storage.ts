import { createHash, randomBytes } from 'node:crypto';
import { Readable } from 'node:stream';
import {
  ObjectStoragePort,
  ObjectStorageUnavailableError,
  type DownloadAuthorization,
  type ObjectRef,
  type StorageReadiness,
  type StorageZone,
  type StoredObjectIdentity,
  type UploadAuthorization,
} from './object-storage.port';

interface StoredVersion {
  readonly versionId: string;
  readonly bytes: Buffer;
  readonly etag: string;
  readonly contentType: string;
  deleted: boolean;
}

/**
 * A versioned, in-memory object store for unit tests (§66).
 *
 * Models the properties the pipeline depends on — every PUT to a key creates
 * a new version, reads by version id return exactly that version, deletes
 * are idempotent — so the tests assert behaviour rather than mock calls.
 * Storage integration tests run the same suite against a real S3 service.
 */
export class InMemoryObjectStorage extends ObjectStoragePort {
  private readonly objects = new Map<string, StoredVersion[]>();
  private readonly authorizations = new Map<
    string,
    { zone: StorageZone; key: string; contentLength: number; contentType: string; expiresAt: Date }
  >();
  /** Operations that should fail as if storage were down. Tests toggle this. */
  readonly failing = new Set<'head' | 'get' | 'put' | 'copy' | 'delete' | 'presign'>();

  private id(zone: StorageZone, key: string): string {
    return `${zone}/${key}`;
  }

  private fail(operation: 'head' | 'get' | 'put' | 'copy' | 'delete' | 'presign'): void {
    if (this.failing.has(operation)) {
      throw new ObjectStorageUnavailableError(operation, new Error('injected outage'));
    }
  }

  /** The port's server-side write (Phase 6 artifacts). */
  async putObject(params: {
    zone: StorageZone;
    key: string;
    content: Buffer;
    contentType: string;
  }): Promise<StoredObjectIdentity> {
    this.fail('put');
    return this.store(params.zone, params.key, params.content, params.contentType);
  }

  async getObjectBytes(ref: ObjectRef): Promise<Buffer> {
    const { stream } = await this.getObjectStream(ref);
    const chunks: Buffer[] = [];
    for await (const chunk of stream) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array));
    }
    return Buffer.concat(chunks);
  }

  /** Test helper: what a browser does with an authorization. */
  async store(
    zone: StorageZone,
    key: string,
    bytes: Buffer,
    contentType = 'application/octet-stream',
  ): Promise<StoredObjectIdentity> {
    const versions = this.objects.get(this.id(zone, key)) ?? [];
    const version: StoredVersion = {
      versionId: randomBytes(8).toString('hex'),
      bytes: Buffer.from(bytes),
      etag: `"${createHash('md5').update(bytes).digest('hex')}"`,
      contentType,
      deleted: false,
    };
    versions.push(version);
    this.objects.set(this.id(zone, key), versions);
    return {
      key,
      versionId: version.versionId,
      etag: version.etag,
      sizeBytes: bytes.length,
      contentType,
    };
  }

  /** Test helper: upload through a previously issued authorization URL. */
  async uploadWithAuthorization(
    url: string,
    bytes: Buffer,
  ): Promise<{ status: number; identity: StoredObjectIdentity | null }> {
    const token = new URL(url).searchParams.get('token') ?? '';
    const grant = this.authorizations.get(token);
    if (grant === undefined) return { status: 403, identity: null };
    if (grant.expiresAt.getTime() < Date.now()) return { status: 403, identity: null };
    if (grant.contentLength !== bytes.length) return { status: 400, identity: null };
    return {
      status: 200,
      identity: await this.store(grant.zone, grant.key, bytes, grant.contentType),
    };
  }

  versionCount(zone: StorageZone, key: string): number {
    return (this.objects.get(this.id(zone, key)) ?? []).filter((v) => !v.deleted).length;
  }

  async createUploadAuthorization(params: {
    zone: StorageZone;
    key: string;
    contentLength: number;
    contentType: string;
    sha256Hex?: string | null;
    expiresInSeconds: number;
  }): Promise<UploadAuthorization> {
    this.fail('presign');
    const token = randomBytes(16).toString('hex');
    const expiresAt = new Date(Date.now() + params.expiresInSeconds * 1000);
    this.authorizations.set(token, {
      zone: params.zone,
      key: params.key,
      contentLength: params.contentLength,
      contentType: params.contentType,
      expiresAt,
    });
    return {
      method: 'PUT',
      url: `memory://${params.zone}/${params.key}?token=${token}`,
      headers: {
        'Content-Type': params.contentType,
        'Content-Length': String(params.contentLength),
      },
      expiresAt,
    };
  }

  private resolve(ref: ObjectRef): StoredVersion | null {
    const versions = (this.objects.get(this.id(ref.zone, ref.key)) ?? []).filter((v) => !v.deleted);
    if (ref.versionId) return versions.find((v) => v.versionId === ref.versionId) ?? null;
    return versions.at(-1) ?? null;
  }

  async headObject(ref: ObjectRef): Promise<StoredObjectIdentity | null> {
    this.fail('head');
    const version = this.resolve(ref);
    if (version === null) return null;
    return {
      key: ref.key,
      versionId: version.versionId,
      etag: version.etag,
      sizeBytes: version.bytes.length,
      contentType: version.contentType,
    };
  }

  async getObjectStream(
    ref: ObjectRef,
  ): Promise<{ stream: Readable; identity: StoredObjectIdentity }> {
    this.fail('get');
    const version = this.resolve(ref);
    if (version === null) {
      const error = new Error('NoSuchKey') as Error & {
        $metadata: { httpStatusCode: number };
        name: string;
      };
      error.name = 'NoSuchKey';
      error.$metadata = { httpStatusCode: 404 };
      throw error;
    }
    // Chunked deliberately, so a consumer that only works on one big chunk fails here.
    const chunks: Buffer[] = [];
    for (let offset = 0; offset < version.bytes.length; offset += 7)
      chunks.push(version.bytes.subarray(offset, offset + 7));
    return {
      stream: Readable.from(chunks.length === 0 ? [Buffer.alloc(0)] : chunks),
      identity: {
        key: ref.key,
        versionId: version.versionId,
        etag: version.etag,
        sizeBytes: version.bytes.length,
        contentType: version.contentType,
      },
    };
  }

  async copyImmutable(params: {
    source: ObjectRef;
    destination: { zone: StorageZone; key: string };
    contentType: string;
  }): Promise<StoredObjectIdentity> {
    this.fail('copy');
    const existing = await this.headObject(params.destination);
    if (existing !== null) return existing;
    const source = this.resolve(params.source);
    if (source === null)
      throw new ObjectStorageUnavailableError('copy', new Error('source missing'));
    return this.store(
      params.destination.zone,
      params.destination.key,
      source.bytes,
      params.contentType,
    );
  }

  async deleteObject(ref: ObjectRef): Promise<void> {
    this.fail('delete');
    const versions = this.objects.get(this.id(ref.zone, ref.key)) ?? [];
    for (const version of versions) {
      if (!ref.versionId || version.versionId === ref.versionId) version.deleted = true;
    }
  }

  async createDownloadAuthorization(params: {
    ref: ObjectRef;
    expiresInSeconds: number;
    contentDisposition: string;
    contentType: string;
  }): Promise<DownloadAuthorization> {
    this.fail('presign');
    const expiresAt = new Date(Date.now() + params.expiresInSeconds * 1000);
    const token = randomBytes(16).toString('hex');
    return {
      method: 'GET',
      url: `memory://${params.ref.zone}/${params.ref.key}?versionId=${params.ref.versionId ?? ''}&token=${token}&expires=${expiresAt.getTime()}`,
      expiresAt,
    };
  }

  async checkReadiness(): Promise<StorageReadiness> {
    return {
      ok: true,
      versioning: { quarantine: 'Enabled', clean: 'Enabled', derived: 'Enabled' },
    };
  }
}
