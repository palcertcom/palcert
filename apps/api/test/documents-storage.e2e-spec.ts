import { createUser } from './support/organization-client';
import type { AuthClient } from './support/auth-client';
import {
  createDocument,
  createVersion,
  downloadAuthorization,
  fetchDownload,
  finalize,
  putToStorage,
  uploadAndProcess,
  waitForSettled,
} from './support/documents-client';
import { storageEnforcesSignatures } from './support/storage-capability';
import { minimalPdf, sha256Hex } from './support/fixtures';
import {
  createTestContext,
  destroyTestContext,
  resetState,
  type TestContext,
} from './support/test-app';

/**
 * Storage integration against the real S3-compatible service (§89).
 *
 * MinIO in CI and local Docker; any S3-compatible endpoint the environment
 * names. These are the properties the quarantine/clean architecture rests on
 * and they are asserted against real objects, not a mock.
 */

describe('Documents — object storage integration (e2e)', () => {
  let context: TestContext;
  let user: { userId: string; client: AuthClient };
  const endpoint = (): string => process.env.STORAGE_ENDPOINT!;

  beforeAll(async () => {
    context = await createTestContext();
  });

  afterAll(async () => {
    await destroyTestContext(context);
  });

  beforeEach(async () => {
    await resetState(context);
    user = await createUser(context, 'author@example.test');
  });

  it('the readiness probe sees both buckets with quarantine versioning enabled', async () => {
    const readiness = await context.storage.checkReadiness();
    expect(readiness.ok).toBe(true);
    expect(readiness.versioning.quarantine).toBe('Enabled');
  });

  it('an upload authorization works for exactly its key, and a tampered key or signature does not', async () => {
    const bytes = minimalPdf();
    const document = await createDocument(user.client);
    const created = await createVersion(user.client, document.id, { name: 'thesis.pdf', bytes });

    const wrongKey = created.upload.url.replace(
      /upload-[0-9a-f]+/,
      'upload-000000000000000000000000',
    );
    const tampered = new URL(created.upload.url);
    tampered.searchParams.set('X-Amz-Signature', '0'.repeat(64));

    // MinIO and AWS verify the signature. An emulator that does not (moto in
    // a sandbox) is reported rather than silently passed.
    if (storageEnforcesSignatures()) {
      expect(
        (await putToStorage({ ...created.upload, url: wrongKey }, bytes)).status,
      ).toBeGreaterThanOrEqual(400);
      expect(
        (await putToStorage({ ...created.upload, url: tampered.toString() }, bytes)).status,
      ).toBeGreaterThanOrEqual(400);
    } else {
      console.warn(
        'storage service does not verify presigned signatures; tamper assertions skipped',
      );
    }

    expect((await putToStorage(created.upload, bytes)).status).toBeLessThan(300);
  });

  it('finalize captures the exact object version that was staged', async () => {
    const bytes = minimalPdf();
    const document = await createDocument(user.client);
    const created = await createVersion(user.client, document.id, { name: 'thesis.pdf', bytes });
    const put = await putToStorage(created.upload, bytes);
    expect(put.versionId).not.toBeNull();

    await finalize(user.client, document.id, created.versionId);
    const row = await context.adminDb.documentVersion.findUniqueOrThrow({
      where: { id: created.versionId },
    });
    expect(row.quarantineObjectVersionId).toBe(put.versionId);
    expect(row.quarantineObjectEtag).not.toBeNull();
    const head = await context.storage.headObject({
      zone: 'quarantine',
      key: row.quarantineObjectKey,
      versionId: row.quarantineObjectVersionId,
    });
    expect(head?.sizeBytes).toBe(bytes.length);
    await waitForSettled(user.client, document.id, created.versionId);
  });

  it('promotes to a fresh, versioned clean object of the same size, and clears quarantine', async () => {
    const bytes = minimalPdf();
    const document = await createDocument(user.client);
    const { versionId } = await uploadAndProcess(user.client, document.id, {
      name: 'thesis.pdf',
      bytes,
    });
    // Quarantine cleanup happens after the version reaches READY — it is
    // best-effort by design (§40), so READY does not imply it has landed. Wait
    // for it rather than reading a row that may predate it: a test that reads
    // too early proves nothing either way.
    const row = await waitForQuarantineDiscarded(versionId);

    expect(row.cleanObjectKey).toMatch(
      /^users\/[0-9a-f-]{36}\/documents\/[0-9a-f-]{36}\/versions\/[0-9a-f-]{36}\/source$/,
    );
    expect(row.cleanObjectVersionId).not.toBeNull();
    const clean = await context.storage.headObject({
      zone: 'clean',
      key: row.cleanObjectKey!,
      versionId: row.cleanObjectVersionId,
    });
    expect(clean?.sizeBytes).toBe(bytes.length);
    expect(clean?.contentType).toBe('application/pdf');
    expect(
      await context.storage.headObject({ zone: 'quarantine', key: row.quarantineObjectKey }),
    ).toBeNull();
    expect(row.quarantineDeletedAt).not.toBeNull();
  });

  /**
   * The version row once the staged bytes have been discarded.
   *
   * Polls rather than sleeps, and still fails if the cleanup never happens —
   * the assertion is unchanged, only the moment it is read.
   */
  async function waitForQuarantineDiscarded(versionId: string, timeoutMs = 10_000) {
    const deadline = Date.now() + timeoutMs;
    let row = await context.adminDb.documentVersion.findUniqueOrThrow({ where: { id: versionId } });
    while (row.quarantineDeletedAt === null && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 25));
      row = await context.adminDb.documentVersion.findUniqueOrThrow({ where: { id: versionId } });
    }
    return row;
  }

  it('serves nothing without a signature: neither quarantine nor clean objects are readable anonymously', async () => {
    const bytes = minimalPdf();
    const document = await createDocument(user.client);
    const created = await createVersion(user.client, document.id, { name: 'thesis.pdf', bytes });
    await putToStorage(created.upload, bytes);
    const staged = await context.adminDb.documentVersion.findUniqueOrThrow({
      where: { id: created.versionId },
    });

    const quarantineUrl = `${endpoint()}/${process.env.STORAGE_QUARANTINE_BUCKET}/${staged.quarantineObjectKey}`;
    expect((await fetch(quarantineUrl)).status).toBeGreaterThanOrEqual(400);

    await finalize(user.client, document.id, created.versionId);
    await waitForSettled(user.client, document.id, created.versionId);
    const ready = await context.adminDb.documentVersion.findUniqueOrThrow({
      where: { id: created.versionId },
    });
    const cleanUrl = `${endpoint()}/${process.env.STORAGE_BUCKET}/${ready.cleanObjectKey}`;
    expect((await fetch(cleanUrl)).status).toBeGreaterThanOrEqual(400);

    const signed = await downloadAuthorization(user.client, document.id, created.versionId);
    expect((await fetchDownload(signed.body.url)).status).toBe(200);
  });

  it('a signed download is bound to the exact clean object version and its bytes', async () => {
    const bytes = minimalPdf('exact');
    const document = await createDocument(user.client);
    const { versionId } = await uploadAndProcess(user.client, document.id, {
      name: 'thesis.pdf',
      bytes,
    });
    const grant = await downloadAuthorization(user.client, document.id, versionId);
    const download = await fetchDownload(grant.body.url);
    expect(sha256Hex(download.bytes)).toBe(sha256Hex(bytes));
    expect(new URL(grant.body.url).searchParams.get('versionId')).not.toBeNull();
  });

  it('a signed download expires', async () => {
    const bytes = minimalPdf();
    const document = await createDocument(user.client);
    const { versionId } = await uploadAndProcess(user.client, document.id, {
      name: 'thesis.pdf',
      bytes,
    });
    const row = await context.adminDb.documentVersion.findUniqueOrThrow({
      where: { id: versionId },
    });

    const short = await context.storage.createDownloadAuthorization({
      ref: { zone: 'clean', key: row.cleanObjectKey!, versionId: row.cleanObjectVersionId },
      expiresInSeconds: 1,
      contentDisposition: 'attachment; filename="x.pdf"',
      contentType: 'application/pdf',
    });
    expect((await fetch(short.url)).status).toBe(200);
    await new Promise((resolve) => setTimeout(resolve, 2_500));
    const late = await fetch(short.url);
    // MinIO and AWS refuse an expired signature. A service that does not
    // (moto in a sandbox) is reported rather than silently passed.
    if (late.status === 200 && !storageEnforcesSignatures()) {
      console.warn('storage service does not enforce presigned URL expiry; skipped');
      return;
    }
    expect(late.status).toBeGreaterThanOrEqual(400);
  });

  it('the readiness endpoint reports object storage without naming it', async () => {
    const response = await user.client.get('/health/ready');
    const storage = (response.body.dependencies as Array<{ name: string; status: string }>).find(
      (d) => d.name === 'object-storage',
    );
    expect(storage?.status).toBe('ok');
    expect(JSON.stringify(response.body)).not.toMatch(/palcert-test|9000|access|secret/i);
  });
});
