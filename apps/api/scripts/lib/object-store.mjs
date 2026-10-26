/**
 * Object-store access for backup and restore.
 *
 * Reads exactly what the running application reads -- the same STORAGE_*
 * configuration, the same zone-to-bucket mapping -- so a backup cannot
 * silently protect a different bucket from the one PalCert is writing to.
 */
import {
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';

export const ZONES = Object.freeze(['quarantine', 'clean', 'derived']);

/**
 * Build the client and the zone map from the environment.
 *
 * `prefix` lets a restore point at a different set of buckets in the same
 * account, which is what makes a restore drill to an independent destination
 * possible without a second object store.
 */
export function objectStoreFromEnv(env = process.env, { prefix = 'STORAGE' } = {}) {
  const read = (name) => env[`${prefix}_${name}`];
  const required = [
    'ENDPOINT',
    'ACCESS_KEY_ID',
    'SECRET_ACCESS_KEY',
    'BUCKET',
    'QUARANTINE_BUCKET',
    'DERIVED_BUCKET',
  ];
  const missing = required.filter((name) => {
    const value = read(name);
    return value === undefined || value === '';
  });
  if (missing.length > 0) {
    const error = new Error(
      `Missing object-store configuration: ${missing.map((n) => `${prefix}_${n}`).join(', ')}`,
    );
    error.exitCode = 78;
    throw error;
  }

  const client = new S3Client({
    endpoint: read('ENDPOINT'),
    region: read('REGION') ?? 'us-east-1',
    credentials: {
      accessKeyId: read('ACCESS_KEY_ID'),
      secretAccessKey: read('SECRET_ACCESS_KEY'),
    },
    forcePathStyle: String(read('FORCE_PATH_STYLE') ?? 'true') === 'true',
  });

  const buckets = {
    // `STORAGE_BUCKET` is the clean zone; the application names it the same way.
    clean: read('BUCKET'),
    quarantine: read('QUARANTINE_BUCKET'),
    derived: read('DERIVED_BUCKET'),
  };

  return { client, buckets, endpoint: read('ENDPOINT') };
}

async function streamToBuffer(body) {
  const chunks = [];
  for await (const chunk of body) chunks.push(chunk);
  return Buffer.concat(chunks);
}

/**
 * Fetch one object's bytes.
 *
 * Returns null for an object that is not there, and throws for everything
 * else. The distinction matters: a missing object is a fact about the data
 * that the caller has to reconcile against the database, while a refused
 * request is a fact about credentials that must stop the run.
 */
export async function getObject(store, zone, key, versionId) {
  try {
    const response = await store.client.send(
      new GetObjectCommand({
        Bucket: store.buckets[zone],
        Key: key,
        ...(versionId !== undefined && versionId !== null ? { VersionId: versionId } : {}),
      }),
    );
    return await streamToBuffer(response.Body);
  } catch (error) {
    if (isNotFound(error)) return null;
    throw error;
  }
}

/** Store an object; returns the version id the store assigned, or null if unversioned. */
export async function putObject(store, zone, key, body, contentType) {
  const response = await store.client.send(
    new PutObjectCommand({
      Bucket: store.buckets[zone],
      Key: key,
      Body: body,
      ...(contentType === undefined ? {} : { ContentType: contentType }),
    }),
  );
  return response.VersionId ?? null;
}

export async function headObject(store, zone, key) {
  try {
    const response = await store.client.send(
      new HeadObjectCommand({ Bucket: store.buckets[zone], Key: key }),
    );
    return { sizeBytes: response.ContentLength ?? 0, versionId: response.VersionId ?? null };
  } catch (error) {
    if (isNotFound(error)) return null;
    throw error;
  }
}

/** Every key in a zone. Used to count objects the database no longer references. */
export async function listZone(store, zone) {
  const keys = [];
  let token;
  do {
    const response = await store.client.send(
      new ListObjectsV2Command({
        Bucket: store.buckets[zone],
        ContinuationToken: token,
      }),
    );
    for (const item of response.Contents ?? []) {
      if (item.Key !== undefined) keys.push(item.Key);
    }
    token = response.IsTruncated === true ? response.NextContinuationToken : undefined;
  } while (token !== undefined);
  return keys;
}

export function isNotFound(error) {
  const name = error?.name ?? '';
  const status = error?.$metadata?.httpStatusCode;
  return name === 'NoSuchKey' || name === 'NotFound' || status === 404;
}

/**
 * Whether a zone has versioning on.
 *
 * Recorded in the manifest rather than enforced. Versioning is the object
 * store's own protection against an overwrite or a delete, and an operator
 * reading a manifest that says `false` learns that this backup is the only
 * copy of those objects.
 */
export async function zoneIsVersioned(store, zone) {
  const { GetBucketVersioningCommand } = await import('@aws-sdk/client-s3');
  try {
    const response = await store.client.send(
      new GetBucketVersioningCommand({ Bucket: store.buckets[zone] }),
    );
    return response.Status === 'Enabled';
  } catch {
    return null;
  }
}
