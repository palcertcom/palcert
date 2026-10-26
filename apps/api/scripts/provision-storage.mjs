#!/usr/bin/env node
/**
 * Deterministic bucket provisioning (§67, §86, §87).
 *
 * Creates the quarantine and clean buckets, enables versioning on both,
 * applies the narrow browser CORS policy to quarantine (uploads) and clean
 * (downloads), and installs lifecycle rules that expire abandoned staging
 * objects. Idempotent: safe to run on every deploy. Nothing here is a
 * manual console step.
 *
 *   pnpm storage:provision
 *
 * Reads STORAGE_* from the environment (or .env via the shell); never
 * prints credentials.
 */
import {
  CreateBucketCommand,
  HeadBucketCommand,
  PutBucketCorsCommand,
  PutBucketLifecycleConfigurationCommand,
  PutBucketVersioningCommand,
  PutPublicAccessBlockCommand,
  S3Client,
} from '@aws-sdk/client-s3';

const env = process.env;
const required = [
  'STORAGE_ENDPOINT',
  'STORAGE_ACCESS_KEY_ID',
  'STORAGE_SECRET_ACCESS_KEY',
  'STORAGE_BUCKET',
  'STORAGE_QUARANTINE_BUCKET',
  'STORAGE_DERIVED_BUCKET',
];
const missing = required.filter((name) => !env[name]);
if (missing.length > 0) {
  console.error(`Missing configuration: ${missing.join(', ')}`);
  process.exit(78);
}

const client = new S3Client({
  endpoint: env.STORAGE_ENDPOINT,
  region: env.STORAGE_REGION ?? 'us-east-1',
  credentials: {
    accessKeyId: env.STORAGE_ACCESS_KEY_ID,
    secretAccessKey: env.STORAGE_SECRET_ACCESS_KEY,
  },
  forcePathStyle: (env.STORAGE_FORCE_PATH_STYLE ?? 'true') !== 'false',
});

const origins = (env.API_CORS_ORIGINS ?? 'http://localhost:3000')
  .split(',')
  .map((o) => o.trim())
  .filter(Boolean);
/** Days an unfinalized staging object may linger before storage removes it. */
const STAGING_EXPIRY_DAYS = Number.parseInt(env.STORAGE_STAGING_EXPIRY_DAYS ?? '2', 10);

/**
 * Run one provisioning call, saying which one it was if it fails.
 *
 * S3 errors name the bucket but not the operation, so a bare "MalformedXML"
 * on a bucket that receives CORS, lifecycle and versioning in turn leaves you
 * guessing which of them the provider refused. Cheap to say, and the next
 * person to meet a provider that validates differently starts with the answer
 * rather than the guess.
 */
async function step(what, run) {
  console.warn(`storage provisioning: ${what}`);
  try {
    return await run();
  } catch (error) {
    console.error(`storage provisioning failed at: ${what}`);
    throw error;
  }
}

async function ensureBucket(bucket) {
  const exists = await step(`head ${bucket}`, async () => {
    try {
      await client.send(new HeadBucketCommand({ Bucket: bucket }));
      return true;
    } catch {
      return false;
    }
  });
  if (!exists) {
    await step(`create ${bucket}`, () => client.send(new CreateBucketCommand({ Bucket: bucket })));
  }
  // Versioning is what makes a finalized object immutable in the face of a
  // reused presigned URL (ADR-0034); required on quarantine, prudent on clean.
  await step(`versioning ${bucket}`, () =>
    client.send(
      new PutBucketVersioningCommand({
        Bucket: bucket,
        VersioningConfiguration: { Status: 'Enabled' },
      }),
    ),
  );
  // Public access is never appropriate for either bucket (§22). Providers
  // that do not implement the call (MinIO) simply refuse public ACLs anyway.
  try {
    await step(`public-access-block ${bucket}`, () =>
      client.send(
        new PutPublicAccessBlockCommand({
          Bucket: bucket,
          PublicAccessBlockConfiguration: {
            BlockPublicAcls: true,
            IgnorePublicAcls: true,
            BlockPublicPolicy: true,
            RestrictPublicBuckets: true,
          },
        }),
      ),
    );
  } catch (error) {
    // Deliberately narrow, and only for this one call.
    //
    // The block is belt-and-braces on a provider that supports it; the bucket
    // is already private, and nothing in PalCert ever writes a public ACL or
    // a public policy. A provider that does not implement the API is entitled
    // to say so however it likes, and MinIO answers MalformedXML rather than
    // the NotImplemented this originally anticipated — so a refusal of *this*
    // call is tolerated and every other provisioning failure still fails the
    // run. The name is logged, because silently skipping a security control
    // is how one stops being applied where it is supported.
    const name = String(error?.name ?? error);
    if (!/NotImplemented|MethodNotAllowed|MalformedXML/.test(name)) throw error;
    console.warn(`public access block not applied to ${bucket}: provider said ${name}`);
  }
}

async function cors(bucket, methods) {
  try {
    await step(`cors ${bucket}`, () =>
      client.send(
        new PutBucketCorsCommand({
          Bucket: bucket,
          CORSConfiguration: {
            CORSRules: [
              {
                AllowedOrigins: origins,
                AllowedMethods: methods,
                AllowedHeaders: [
                  'content-type',
                  'content-length',
                  'x-amz-checksum-sha256',
                  'x-amz-server-side-encryption',
                  'x-amz-server-side-encryption-aws-kms-key-id',
                ],
                ExposeHeaders: ['ETag', 'x-amz-version-id'],
                MaxAgeSeconds: 300,
              },
            ],
          },
        }),
      ),
    );
  } catch (error) {
    // Only "this API does not exist here", and only for CORS.
    //
    // MinIO answers PutBucketCors with 501 NotImplemented: it configures CORS
    // at the server rather than per bucket. Refusing to provision at all on
    // that basis would mean CI could never exercise the real storage path.
    //
    // A MalformedXML is deliberately *not* tolerated here, unlike the public
    // access block above: on a provider that does implement the API, that
    // would mean PalCert's own CORS policy is wrong, and a wrong CORS policy
    // is exactly the kind of thing that must fail loudly rather than be
    // skipped. CORS is also a browser control, not the boundary protecting
    // these objects — the buckets are private and reachable only through
    // short-lived presigned URLs.
    const name = String(error?.name ?? error);
    if (!/NotImplemented|MethodNotAllowed/.test(name)) throw error;
    console.warn(
      `CORS not applied to ${bucket}: provider said ${name}. ` +
        'Configure it at the server (MinIO) — a real S3 deployment applies it here.',
    );
  }
}

async function putLifecycle(bucket, rules) {
  return client.send(
    new PutBucketLifecycleConfigurationCommand({
      Bucket: bucket,
      LifecycleConfiguration: { Rules: rules },
    }),
  );
}

async function lifecycle(bucket, rules) {
  try {
    await step(`lifecycle ${bucket}`, () => putLifecycle(bucket, rules));
  } catch (error) {
    // Say which rule, then fail.
    //
    // A rejected lifecycle configuration names the bucket and not the rule,
    // and the whole point of several rules is that they are separable. Trying
    // them one at a time costs one round trip per rule on a path that has
    // already failed, and turns "the provider disliked something about this
    // bucket" into "the provider rejects this rule".
    for (const rule of rules) {
      try {
        await putLifecycle(bucket, [rule]);
        console.error(`  lifecycle rule accepted on its own: ${rule.ID}`);
      } catch (single) {
        console.error(
          `  lifecycle rule rejected: ${rule.ID} (${String(single?.name ?? single)}) ` +
            `${JSON.stringify(rule)}`,
        );
      }
    }
    throw error;
  }
}

const quarantine = env.STORAGE_QUARANTINE_BUCKET;
const clean = env.STORAGE_BUCKET;
const derived = env.STORAGE_DERIVED_BUCKET;
if (new Set([quarantine, clean, derived]).size !== 3) {
  console.error('Quarantine, clean and derived storage must be three separate buckets.');
  process.exit(78);
}

await ensureBucket(quarantine);
await ensureBucket(clean);
await ensureBucket(derived);
await cors(quarantine, ['PUT']);
await cors(clean, ['GET']);
// The derived bucket gets no CORS at all: no browser ever reaches it. Analysis
// artifacts are PalCert's internal working data, written and read only by
// workers, and a CORS rule would be the first step toward exposing them (§94).
// Quarantine: everything is transient. Staging objects the API did not
// remove (abandoned sessions, rejected uploads whose delete failed) expire,
// and non-current versions left by a reused URL expire with them.
await lifecycle(quarantine, [
  {
    ID: 'expire-staging',
    Status: 'Enabled',
    Filter: { Prefix: 'staging/' },
    Expiration: { Days: STAGING_EXPIRY_DAYS },
    NoncurrentVersionExpiration: { NoncurrentDays: 1 },
    AbortIncompleteMultipartUpload: { DaysAfterInitiation: 1 },
  },
]);
// Clean: authoritative documents are never auto-expired (§87). Only
// non-current versions — which promotion never creates — are tidied.
await lifecycle(clean, [
  {
    ID: 'tidy-noncurrent',
    Status: 'Enabled',
    Filter: {},
    NoncurrentVersionExpiration: { NoncurrentDays: 30 },
    AbortIncompleteMultipartUpload: { DaysAfterInitiation: 1 },
  },
]);

// Derived: an artifact outlives nothing. It is deleted with its source
// document by the purge path, and only superseded versions are tidied here
// (§123). Nothing expires a current artifact a check may still reference.
await lifecycle(derived, [
  {
    ID: 'tidy-noncurrent',
    Status: 'Enabled',
    Filter: {},
    NoncurrentVersionExpiration: { NoncurrentDays: 30 },
    AbortIncompleteMultipartUpload: { DaysAfterInitiation: 1 },
  },
]);

console.warn(`Provisioned buckets (versioned, private, CORS for ${origins.length} origin(s)).`);
