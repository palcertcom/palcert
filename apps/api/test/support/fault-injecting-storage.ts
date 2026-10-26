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
} from '../../src/infrastructure/storage/object-storage.port';

export type StorageOperation = 'presign' | 'head' | 'get' | 'put' | 'copy' | 'delete' | 'readiness';

/**
 * The real adapter, with a switch for each operation (§88 "storage
 * unavailable"). Everything else passes straight through to the S3-compatible
 * service the suite runs against, so an outage test exercises the genuine
 * code path up to the moment the network would have failed.
 */
export class FaultInjectingObjectStorage extends ObjectStoragePort {
  readonly failing = new Set<StorageOperation>();
  /**
   * Keys whose bytes come back altered.
   *
   * The database enforces that an artifact's identity is write-once, so a test
   * cannot simulate corruption by editing the recorded digest — nor should it
   * be able to. Corrupting the *bytes* on the way back is the honest
   * simulation of an object that no longer matches what was recorded, and it
   * exercises the digest verification exactly as a real swap would.
   */
  readonly corrupting = new Set<string>();
  /** Keys whose *streamed* bytes come back altered (same idea, other read path). */
  readonly corruptingStreams = new Set<string>();

  constructor(private readonly inner: ObjectStoragePort) {
    super();
  }

  private guard(operation: StorageOperation): void {
    if (this.failing.has(operation)) {
      throw new ObjectStorageUnavailableError(operation, new Error('injected storage outage'));
    }
  }

  async createUploadAuthorization(
    params: Parameters<ObjectStoragePort['createUploadAuthorization']>[0],
  ): Promise<UploadAuthorization> {
    this.guard('presign');
    return this.inner.createUploadAuthorization(params);
  }

  async headObject(ref: ObjectRef): Promise<StoredObjectIdentity | null> {
    this.guard('head');
    return this.inner.headObject(ref);
  }

  async getObjectStream(
    ref: ObjectRef,
  ): Promise<{ stream: Readable; identity: StoredObjectIdentity }> {
    this.guard('get');
    const result = await this.inner.getObjectStream(ref);
    if (!this.corruptingStreams.has(ref.key)) return result;
    const chunks: Buffer[] = [];
    for await (const chunk of result.stream) chunks.push(Buffer.from(chunk as Buffer));
    chunks.push(Buffer.from(' ', 'utf8'));
    return { ...result, stream: Readable.from([Buffer.concat(chunks)]) };
  }

  async copyImmutable(params: {
    source: ObjectRef;
    destination: { zone: StorageZone; key: string };
    contentType: string;
  }): Promise<StoredObjectIdentity> {
    this.guard('copy');
    return this.inner.copyImmutable(params);
  }

  async putObject(
    params: Parameters<ObjectStoragePort['putObject']>[0],
  ): Promise<StoredObjectIdentity> {
    this.guard('put');
    return this.inner.putObject(params);
  }

  async getObjectBytes(ref: ObjectRef): Promise<Buffer> {
    this.guard('get');
    const bytes = await this.inner.getObjectBytes(ref);
    if (!this.corrupting.has(ref.key)) return bytes;
    return Buffer.concat([bytes, Buffer.from(' ', 'utf8')]);
  }

  async deleteObject(ref: ObjectRef): Promise<void> {
    this.guard('delete');
    return this.inner.deleteObject(ref);
  }

  async createDownloadAuthorization(
    params: Parameters<ObjectStoragePort['createDownloadAuthorization']>[0],
  ): Promise<DownloadAuthorization> {
    this.guard('presign');
    return this.inner.createDownloadAuthorization(params);
  }

  async checkReadiness(): Promise<StorageReadiness> {
    if (this.failing.has('readiness')) {
      return {
        ok: false,
        versioning: { quarantine: 'unknown', clean: 'unknown', derived: 'unknown' },
        message: 'unreachable',
      };
    }
    return this.inner.checkReadiness();
  }
}
