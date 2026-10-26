import { Readable } from 'node:stream';
import {
  CopyObjectCommand,
  DeleteObjectCommand,
  DeleteObjectsCommand,
  GetBucketVersioningCommand,
  GetObjectCommand,
  HeadBucketCommand,
  HeadObjectCommand,
  ListObjectVersionsCommand,
  PutObjectCommand,
  S3Client,
  S3ServiceException,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import {
  ObjectStoragePort,
  ObjectStorageUnavailableError,
  STORAGE_ZONES,
  type DownloadAuthorization,
  type ObjectRef,
  type StorageReadiness,
  type StorageZone,
  type StoredObjectIdentity,
  type UploadAuthorization,
} from './object-storage.port';

export interface S3StorageOptions {
  readonly endpoint: string;
  /** Endpoint embedded in presigned URLs, when browsers cannot use `endpoint`. */
  readonly publicEndpoint: string;
  readonly region: string;
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
  readonly forcePathStyle: boolean;
  readonly buckets: Readonly<Record<StorageZone, string>>;
  readonly serverSideEncryption: 'none' | 'AES256' | 'aws:kms';
  readonly kmsKeyId: string | undefined;
  readonly requestTimeoutMs: number;
  /**
   * Called once per storage call with its outcome (Phase 20 Checkpoint 3).
   *
   * A callback rather than an injected metrics service, so this adapter keeps
   * knowing nothing about Nest or about telemetry: the module that builds it
   * decides whether anybody is counting. Optional, so every test that
   * constructs one directly is unaffected.
   */
  readonly observe?: (operation: string, outcome: StorageOutcome) => void;
}

/** How a storage call ended. A closed set, so the label stays bounded. */
export type StorageOutcome = 'succeeded' | 'not_found' | 'refused' | 'unavailable';

const READINESS_TIMEOUT_MS = 3_000;

/**
 * The S3-compatible adapter (AWS S3, MinIO, and anything speaking the API).
 *
 * Two clients: one for the API's own calls and one that only ever *signs*
 * URLs against the public endpoint. Nothing AWS-specific escapes this file —
 * the domain sees `ObjectStoragePort` and zone names.
 */
export class S3ObjectStorage extends ObjectStoragePort {
  private readonly client: S3Client;
  private readonly signer: S3Client;

  constructor(private readonly options: S3StorageOptions) {
    super();
    const base = {
      region: options.region,
      credentials: {
        accessKeyId: options.accessKeyId,
        secretAccessKey: options.secretAccessKey,
      },
      forcePathStyle: options.forcePathStyle,
      // Without this the SDK stamps a CRC32 of an *empty* body into every
      // presigned PUT (x-amz-checksum-crc32=AAAAAA==), which a real bucket
      // then enforces against the browser's actual bytes. Integrity is
      // carried by the explicitly signed SHA-256 and by the worker's own
      // digest, so the SDK's automatic checksum is only ever a hazard here.
      requestChecksumCalculation: 'WHEN_REQUIRED' as const,
      responseChecksumValidation: 'WHEN_REQUIRED' as const,
      // Plain handler options rather than a handler instance, so the adapter
      // depends on the S3 client alone and not on a transitive Smithy package.
      requestHandler: {
        connectionTimeout: Math.min(options.requestTimeoutMs, 5_000),
        requestTimeout: options.requestTimeoutMs,
      },
    };
    this.client = new S3Client({ ...base, endpoint: options.endpoint });
    this.signer = new S3Client({ ...base, endpoint: options.publicEndpoint });
  }

  private bucket(zone: StorageZone): string {
    return this.options.buckets[zone];
  }

  private encryptionParams(): {
    ServerSideEncryption?: 'AES256' | 'aws:kms';
    SSEKMSKeyId?: string;
  } {
    if (this.options.serverSideEncryption === 'none') return {};
    return {
      ServerSideEncryption: this.options.serverSideEncryption,
      ...(this.options.serverSideEncryption === 'aws:kms' && this.options.kmsKeyId !== undefined
        ? { SSEKMSKeyId: this.options.kmsKeyId }
        : {}),
    };
  }

  async createUploadAuthorization(params: {
    zone: StorageZone;
    key: string;
    contentLength: number;
    contentType: string;
    sha256Hex?: string | null;
    expiresInSeconds: number;
  }): Promise<UploadAuthorization> {
    const checksum =
      params.sha256Hex !== undefined && params.sha256Hex !== null
        ? Buffer.from(params.sha256Hex, 'hex').toString('base64')
        : undefined;
    const encryption = this.encryptionParams();

    const command = new PutObjectCommand({
      Bucket: this.bucket(params.zone),
      Key: params.key,
      ContentLength: params.contentLength,
      ContentType: params.contentType,
      ...(checksum !== undefined ? { ChecksumSHA256: checksum } : {}),
      ...encryption,
    });

    // The content headers are *signed*, not hoisted into the query string, so
    // the object storage refuses a PUT whose length or type differs from what
    // the API authorized (§24).
    const unhoistable = new Set(['content-length', 'content-type', 'x-amz-checksum-sha256']);
    const expiresAt = new Date(Date.now() + params.expiresInSeconds * 1000);
    const url = await this.wrap('presign upload', () =>
      getSignedUrl(this.signer, command, {
        expiresIn: params.expiresInSeconds,
        unhoistableHeaders: unhoistable,
        signableHeaders: unhoistable,
      }),
    );

    const headers: Record<string, string> = {
      'Content-Type': params.contentType,
      'Content-Length': String(params.contentLength),
    };
    if (checksum !== undefined) headers['x-amz-checksum-sha256'] = checksum;
    if (encryption.ServerSideEncryption !== undefined) {
      headers['x-amz-server-side-encryption'] = encryption.ServerSideEncryption;
      if (encryption.SSEKMSKeyId !== undefined) {
        headers['x-amz-server-side-encryption-aws-kms-key-id'] = encryption.SSEKMSKeyId;
      }
    }

    return { method: 'PUT', url, headers, expiresAt };
  }

  async headObject(ref: ObjectRef): Promise<StoredObjectIdentity | null> {
    try {
      const head = await this.wrap('head', () =>
        this.client.send(
          new HeadObjectCommand({
            Bucket: this.bucket(ref.zone),
            Key: ref.key,
            ...(ref.versionId ? { VersionId: ref.versionId } : {}),
          }),
        ),
      );
      return {
        key: ref.key,
        versionId: head.VersionId ?? null,
        etag: head.ETag ?? null,
        sizeBytes: head.ContentLength ?? 0,
        contentType: head.ContentType ?? null,
      };
    } catch (error) {
      if (isNotFound(error)) return null;
      throw error;
    }
  }

  async getObjectStream(
    ref: ObjectRef,
  ): Promise<{ stream: Readable; identity: StoredObjectIdentity }> {
    const object = await this.wrap('get', () =>
      this.client.send(
        new GetObjectCommand({
          Bucket: this.bucket(ref.zone),
          Key: ref.key,
          ...(ref.versionId ? { VersionId: ref.versionId } : {}),
        }),
      ),
    );
    const body = object.Body;
    if (body === undefined) throw new ObjectStorageUnavailableError('get', new Error('empty body'));
    const stream =
      body instanceof Readable ? body : Readable.fromWeb(body.transformToWebStream() as never);
    return {
      stream,
      identity: {
        key: ref.key,
        versionId: object.VersionId ?? null,
        etag: object.ETag ?? null,
        sizeBytes: object.ContentLength ?? 0,
        contentType: object.ContentType ?? null,
      },
    };
  }

  async copyImmutable(params: {
    source: ObjectRef;
    destination: { zone: StorageZone; key: string };
    contentType: string;
  }): Promise<StoredObjectIdentity> {
    const existing = await this.headObject({ ...params.destination });
    if (existing !== null) {
      // A destination that already exists is a bug or a replay; either way the
      // clean object is never overwritten. Report what is there.
      return existing;
    }

    const sourceBucket = this.bucket(params.source.zone);
    const encodedKey = params.source.key.split('/').map(encodeURIComponent).join('/');
    const copySource = params.source.versionId
      ? `${sourceBucket}/${encodedKey}?versionId=${encodeURIComponent(params.source.versionId)}`
      : `${sourceBucket}/${encodedKey}`;

    const copied = await this.wrap('copy', () =>
      this.client.send(
        new CopyObjectCommand({
          Bucket: this.bucket(params.destination.zone),
          Key: params.destination.key,
          CopySource: copySource,
          MetadataDirective: 'REPLACE',
          ContentType: params.contentType,
          ...this.encryptionParams(),
        }),
      ),
    );

    const head = await this.headObject({
      zone: params.destination.zone,
      key: params.destination.key,
      versionId: copied.VersionId ?? null,
    });
    if (head === null) {
      throw new ObjectStorageUnavailableError('copy', new Error('destination missing after copy'));
    }
    return head;
  }

  async putObject(params: {
    zone: StorageZone;
    key: string;
    content: Buffer;
    contentType: string;
  }): Promise<StoredObjectIdentity> {
    const written = await this.wrap('put', () =>
      this.client.send(
        new PutObjectCommand({
          Bucket: this.bucket(params.zone),
          Key: params.key,
          Body: params.content,
          ContentType: params.contentType,
          ContentLength: params.content.byteLength,
          ...this.encryptionParams(),
        }),
      ),
    );

    return {
      key: params.key,
      versionId: written.VersionId ?? null,
      etag: (written.ETag ?? '').replaceAll('"', ''),
      sizeBytes: params.content.byteLength,
      contentType: params.contentType,
    };
  }

  async getObjectBytes(ref: ObjectRef): Promise<Buffer> {
    const { stream } = await this.getObjectStream(ref);
    const chunks: Buffer[] = [];
    for await (const chunk of stream) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array));
    }
    return Buffer.concat(chunks);
  }

  async deleteObject(ref: ObjectRef): Promise<void> {
    const bucket = this.bucket(ref.zone);
    if (ref.versionId) {
      await this.wrap('delete', () =>
        this.client.send(
          new DeleteObjectCommand({ Bucket: bucket, Key: ref.key, VersionId: ref.versionId! }),
        ),
      );
      return;
    }

    // Every version of exactly this key, so a reused presigned URL cannot
    // leave a stray copy behind. The prefix is the full key; an exact match
    // is required so a key that is a prefix of another never widens the delete.
    const versions = await this.wrap('list versions', () =>
      this.client.send(new ListObjectVersionsCommand({ Bucket: bucket, Prefix: ref.key })),
    );
    const targets = [...(versions.Versions ?? []), ...(versions.DeleteMarkers ?? [])]
      .filter((entry) => entry.Key === ref.key)
      .map((entry) => ({
        Key: ref.key,
        ...(entry.VersionId ? { VersionId: entry.VersionId } : {}),
      }));

    if (targets.length === 0) {
      await this.wrap('delete', () =>
        this.client.send(new DeleteObjectCommand({ Bucket: bucket, Key: ref.key })),
      );
      return;
    }
    await this.wrap('delete versions', () =>
      this.client.send(
        new DeleteObjectsCommand({ Bucket: bucket, Delete: { Objects: targets, Quiet: true } }),
      ),
    );
  }

  async createDownloadAuthorization(params: {
    ref: ObjectRef;
    expiresInSeconds: number;
    contentDisposition: string;
    contentType: string;
  }): Promise<DownloadAuthorization> {
    const command = new GetObjectCommand({
      Bucket: this.bucket(params.ref.zone),
      Key: params.ref.key,
      ...(params.ref.versionId ? { VersionId: params.ref.versionId } : {}),
      ResponseContentDisposition: params.contentDisposition,
      ResponseContentType: params.contentType,
    });
    const expiresAt = new Date(Date.now() + params.expiresInSeconds * 1000);
    const url = await this.wrap('presign download', () =>
      getSignedUrl(this.signer, command, { expiresIn: params.expiresInSeconds }),
    );
    return { method: 'GET', url, expiresAt };
  }

  async checkReadiness(): Promise<StorageReadiness> {
    const versioning: Record<StorageZone, 'Enabled' | 'Suspended' | 'Disabled' | 'unknown'> = {
      quarantine: 'unknown',
      clean: 'unknown',
      derived: 'unknown',
    };
    try {
      for (const zone of STORAGE_ZONES) {
        const bucket = this.bucket(zone);
        await withTimeout(
          this.client.send(new HeadBucketCommand({ Bucket: bucket })),
          READINESS_TIMEOUT_MS,
        );
        const state = await withTimeout(
          this.client.send(new GetBucketVersioningCommand({ Bucket: bucket })),
          READINESS_TIMEOUT_MS,
        );
        versioning[zone] =
          state.Status === 'Enabled'
            ? 'Enabled'
            : state.Status === 'Suspended'
              ? 'Suspended'
              : 'Disabled';
      }
    } catch {
      // Deliberately no detail: the response is public and the failure may
      // name an endpoint or a bucket.
      return { ok: false, versioning, message: 'unreachable' };
    }
    if (versioning.quarantine !== 'Enabled') {
      return { ok: false, versioning, message: 'quarantine versioning disabled' };
    }
    return { ok: true, versioning };
  }

  /** Translate transport and 5xx failures into the one error callers classify. */
  private async wrap<T>(operation: string, call: () => Promise<T>): Promise<T> {
    try {
      const result = await call();
      this.options.observe?.(operation, 'succeeded');
      return result;
    } catch (error) {
      // The outcome is recorded before rethrowing, and the classification is
      // the same one the caller sees: a missing object is an ordinary answer,
      // a 4xx is something PalCert asked for wrongly, and anything else means
      // the store could not serve. Counting all three identically would hide
      // the only one that is an outage.
      if (isNotFound(error)) {
        this.options.observe?.(operation, 'not_found');
        throw error;
      }
      const status = (error as { $metadata?: { httpStatusCode?: number } }).$metadata
        ?.httpStatusCode;
      if (status !== undefined && status >= 400 && status < 500) {
        this.options.observe?.(operation, 'refused');
        throw error;
      }
      this.options.observe?.(operation, 'unavailable');
      throw new ObjectStorageUnavailableError(operation, error);
    }
  }
}

function isNotFound(error: unknown): boolean {
  if (error instanceof S3ServiceException) {
    return (
      error.name === 'NotFound' ||
      error.name === 'NoSuchKey' ||
      error.name === 'NoSuchVersion' ||
      error.$metadata.httpStatusCode === 404
    );
  }
  const status = (error as { $metadata?: { httpStatusCode?: number } })?.$metadata?.httpStatusCode;
  return status === 404;
}

async function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('timeout')), ms);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
