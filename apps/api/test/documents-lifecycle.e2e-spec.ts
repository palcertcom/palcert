import { createUser } from './support/organization-client';
import { API, AuthClient } from './support/auth-client';
import {
  DOCUMENTS,
  createDocument,
  createVersion,
  downloadAuthorization,
  fetchDownload,
  finalize,
  getVersion,
  putToStorage,
  uploadAndProcess,
  waitForSettled,
} from './support/documents-client';
import { storageEnforcesSignatures } from './support/storage-capability';
import { minimalDocx, minimalPdf, sha256Hex } from './support/fixtures';
import {
  createTestContext,
  destroyTestContext,
  resetState,
  type TestContext,
} from './support/test-app';

/**
 * The upload journey, end to end (§100 scenarios 1-10, 21, 31-35).
 *
 * The browser's part is played by plain HTTP against the real S3-compatible
 * service; PalCert's worker runs for real in the same process. Nothing is
 * mocked except the clock and the malware scanner engine.
 */
describe('Documents — lifecycle (e2e)', () => {
  let context: TestContext;
  let user: { email: string; userId: string; client: AuthClient };

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

  const client = (): AuthClient => user.client;

  // -------------------------------------------------------------------------
  describe('documents', () => {
    it('creates a document with no content and lists it', async () => {
      const created = await createDocument(client(), 'My PhD thesis');
      expect(created.body).toMatchObject({
        displayName: 'My PhD thesis',
        status: 'ACTIVE',
        latestVersion: null,
      });

      const list = await client().get(DOCUMENTS);
      expect(list.status).toBe(200);
      expect(list.body.items.map((item: { id: string }) => item.id)).toEqual([created.id]);
      expect(list.body.nextCursor).toBeNull();
    });

    it('never exposes storage details in a version view', async () => {
      const document = await createDocument(client());
      const { version } = await uploadAndProcess(client(), document.id, {
        name: 'thesis.pdf',
        bytes: minimalPdf(),
      });
      const text = JSON.stringify(version);
      expect(text).not.toMatch(/staging\/|\/source|bucket|etag|objectVersion|quarantine/i);
    });

    it('renames and soft-deletes; a deleted document leaves the list and is purged from storage', async () => {
      const document = await createDocument(client(), 'Draft');
      const renamed = await client().patch(`${DOCUMENTS}/${document.id}`, { displayName: 'Final' });
      expect(renamed.status).toBe(200);
      expect(renamed.body.displayName).toBe('Final');

      const { versionId } = await uploadAndProcess(client(), document.id, {
        name: 'thesis.pdf',
        bytes: minimalPdf(),
      });
      const row = await context.adminDb.documentVersion.findUniqueOrThrow({
        where: { id: versionId },
      });
      expect(
        await context.storage.headObject({ zone: 'clean', key: row.cleanObjectKey! }),
      ).not.toBeNull();

      expect((await client().delete(`${DOCUMENTS}/${document.id}`)).status).toBe(204);
      expect((await client().get(`${DOCUMENTS}/${document.id}`)).status).toBe(410);
      expect((await client().get(DOCUMENTS)).body.items).toEqual([]);

      // The purge job removes the clean object and records that it did.
      const deadline = Date.now() + 15_000;
      let purged = await context.adminDb.documentVersion.findUniqueOrThrow({
        where: { id: versionId },
      });
      while (purged.purgedAt === null && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 50));
        purged = await context.adminDb.documentVersion.findUniqueOrThrow({
          where: { id: versionId },
        });
      }
      expect(purged.purgedAt).not.toBeNull();
      expect(
        await context.storage.headObject({ zone: 'clean', key: row.cleanObjectKey! }),
      ).toBeNull();
    });
  });

  // -------------------------------------------------------------------------
  describe('the happy path', () => {
    it('uploads a PDF, finalizes, processes to READY and downloads the exact bytes', async () => {
      const bytes = minimalPdf('Hello PalCert');
      const document = await createDocument(client());

      const created = await createVersion(client(), document.id, {
        name: 'thesis.pdf',
        bytes,
        mimeType: 'application/pdf',
        sha256: sha256Hex(bytes),
      });
      expect(created.body.version).toMatchObject({
        versionNumber: 1,
        status: 'AWAITING_UPLOAD',
        originalFilename: 'thesis.pdf',
      });
      expect(created.upload.method).toBe('PUT');
      expect(created.upload.headers['Content-Type']).toBe('application/pdf');

      expect((await putToStorage(created.upload, bytes)).status).toBeLessThan(300);

      const finalized = await finalize(client(), document.id, created.versionId);
      expect(finalized.status).toBe(200);
      expect(['UPLOADED', 'VALIDATING', 'SCANNING', 'READY']).toContain(finalized.body.status);

      const version = await waitForSettled(client(), document.id, created.versionId);
      expect(version).toMatchObject({
        status: 'READY',
        detectedFormat: 'PDF',
        detectedMimeType: 'application/pdf',
        sizeBytes: bytes.length,
        sha256: sha256Hex(bytes),
        rejectionCode: null,
        failureCode: null,
      });
      expect(version['readyAt']).not.toBeNull();

      const grant = await downloadAuthorization(client(), document.id, created.versionId);
      expect(grant.status).toBe(201);
      expect(grant.body.filename).toBe('thesis.pdf');

      const download = await fetchDownload(grant.body.url);
      expect(download.status).toBe(200);
      expect(download.bytes.equals(bytes)).toBe(true);
      expect(download.headers.get('content-disposition')).toMatch(
        /^attachment; filename="thesis\.pdf"/,
      );
      expect(download.headers.get('content-type')).toBe('application/pdf');

      const list = await client().get(DOCUMENTS);
      expect(list.body.items[0].latestVersion).toMatchObject({
        id: created.versionId,
        status: 'READY',
      });
    });

    it('uploads a DOCX', async () => {
      const bytes = minimalDocx();
      const document = await createDocument(client());
      const { version } = await uploadAndProcess(client(), document.id, {
        name: 'Thesis.DOCX',
        bytes,
        mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      });
      expect(version).toMatchObject({
        status: 'READY',
        detectedFormat: 'DOCX',
        sha256: sha256Hex(bytes),
      });
    });

    it('keeps the first version unchanged when a second is uploaded, numbered monotonically', async () => {
      const first = minimalPdf('first');
      const second = minimalPdf('second, longer than the first');
      const document = await createDocument(client());

      const one = await uploadAndProcess(client(), document.id, { name: 'v1.pdf', bytes: first });
      const two = await uploadAndProcess(client(), document.id, { name: 'v2.pdf', bytes: second });

      expect(one.version['versionNumber']).toBe(1);
      expect(two.version['versionNumber']).toBe(2);

      const firstAgain = (await getVersion(client(), document.id, one.versionId)).body;
      expect(firstAgain).toMatchObject({
        status: 'READY',
        sha256: sha256Hex(first),
        sizeBytes: first.length,
      });
      const firstDownload = await fetchDownload(
        (await downloadAuthorization(client(), document.id, one.versionId)).body.url,
      );
      expect(firstDownload.bytes.equals(first)).toBe(true);

      const list = await client().get(`${DOCUMENTS}/${document.id}/versions`);
      expect(list.body.items.map((v: { versionNumber: number }) => v.versionNumber)).toEqual([
        2, 1,
      ]);
    });

    it('allocates unique version numbers under concurrent creation (§9)', async () => {
      const document = await createDocument(client());
      const results = await Promise.all(
        Array.from({ length: 6 }, (_, index) =>
          client().post(`${DOCUMENTS}/${document.id}/versions`, {
            originalFilename: `v${index}.pdf`,
            sizeBytes: 10,
          }),
        ),
      );
      for (const response of results) expect(response.status).toBe(201);
      const numbers = results
        .map((response) => response.body.version.versionNumber as number)
        .sort((a, b) => a - b);
      expect(numbers).toEqual([1, 2, 3, 4, 5, 6]);
    });

    it('preserves an Arabic filename through upload and download (§45, §82)', async () => {
      const bytes = minimalPdf();
      const arabicUser = await createUser(context, 'author-ar@example.test', 'ar');
      const document = await createDocument(arabicUser.client, 'رسالة الماجستير');
      const { versionId, version } = await uploadAndProcess(arabicUser.client, document.id, {
        name: 'رسالة الماجستير.pdf',
        bytes,
      });
      expect(version['originalFilename']).toBe('رسالة الماجستير.pdf');

      const grant = await downloadAuthorization(arabicUser.client, document.id, versionId);
      const download = await fetchDownload(grant.body.url);
      expect(download.status).toBe(200);
      const disposition = download.headers.get('content-disposition') ?? '';
      expect(disposition).toMatch(/^attachment; filename="[_ ]+\.pdf"; filename\*=UTF-8''%D8%B1/);
      expect(disposition).toMatch(/^[ -~]*$/);
    });
  });

  // -------------------------------------------------------------------------
  describe('finalize and idempotency (§30, §74)', () => {
    it('is safe to finalize twice: one version, one job, one scan', async () => {
      const bytes = minimalPdf();
      const document = await createDocument(client());
      const created = await createVersion(client(), document.id, { name: 'thesis.pdf', bytes });
      await putToStorage(created.upload, bytes);

      const [first, second] = await Promise.all([
        finalize(client(), document.id, created.versionId),
        finalize(client(), document.id, created.versionId),
      ]);
      expect(first.status).toBe(200);
      expect(second.status).toBe(200);
      await waitForSettled(client(), document.id, created.versionId);
      const third = await finalize(client(), document.id, created.versionId);
      expect(third.status).toBe(200);
      expect(third.body.status).toBe('READY');

      expect(
        await context.adminDb.processingJob.count({ where: { resourceId: created.versionId } }),
      ).toBe(1);
      expect(
        await context.adminDb.documentVersion.count({ where: { documentId: document.id } }),
      ).toBe(1);
      expect(context.scanner.scannedSizes).toHaveLength(1);
    });

    it('returns the same version for a repeated Idempotency-Key and refuses the key with another body', async () => {
      const bytes = minimalPdf();
      const document = await createDocument(client());
      const key = 'browser-retry-7f3a';
      const first = await createVersion(
        client(),
        document.id,
        { name: 'thesis.pdf', bytes },
        { idempotencyKey: key },
      );
      const second = await createVersion(
        client(),
        document.id,
        { name: 'thesis.pdf', bytes },
        { idempotencyKey: key },
      );

      expect(second.versionId).toBe(first.versionId);
      expect(
        await context.adminDb.documentVersion.count({ where: { documentId: document.id } }),
      ).toBe(1);

      const different = await client().post(
        `${DOCUMENTS}/${document.id}/versions`,
        { originalFilename: 'other.pdf', sizeBytes: bytes.length },
        { headers: { 'Idempotency-Key': key } },
      );
      expect(different.status).toBe(422);
      expect(different.body.error.code).toBe('IDEMPOTENCY_KEY_REUSED');
    });

    it('refuses to finalize before anything was uploaded', async () => {
      const document = await createDocument(client());
      const created = await createVersion(client(), document.id, {
        name: 'thesis.pdf',
        bytes: minimalPdf(),
      });
      const response = await finalize(client(), document.id, created.versionId);
      expect(response.status).toBe(409);
      expect(response.body.error.code).toBe('UPLOAD_OBJECT_NOT_FOUND');
    });

    it('refuses an upload whose size differs from the authorization', async () => {
      const bytes = minimalPdf();
      const document = await createDocument(client());
      const created = await createVersion(client(), document.id, { name: 'thesis.pdf', bytes });
      const longer = Buffer.concat([bytes, Buffer.from('extra')]);
      const put = await putToStorage(
        {
          ...created.upload,
          headers: { ...created.upload.headers, 'Content-Length': String(longer.length) },
        },
        longer,
      );

      // Content-Length is part of what the presigned URL signs, so a storage
      // that enforces its signatures refuses the PUT and the mismatched bytes
      // never land — a stronger outcome than PalCert catching them later.
      if (storageEnforcesSignatures()) {
        expect(put.status).toBeGreaterThanOrEqual(400);
        expect((await getVersion(client(), document.id, created.versionId)).body.status).toBe(
          'AWAITING_UPLOAD',
        );
        return;
      }

      const response = await finalize(client(), document.id, created.versionId);
      expect(response.status).toBe(422);
      expect(response.body.error.code).toBe('UPLOAD_SIZE_MISMATCH');
      expect((await getVersion(client(), document.id, created.versionId)).body.status).toBe(
        'AWAITING_UPLOAD',
      );
    });
  });

  // -------------------------------------------------------------------------
  describe('expiry and cancellation (§28, §31, §32)', () => {
    it('refuses to finalize an expired upload session and expires the version', async () => {
      const bytes = minimalPdf();
      const document = await createDocument(client());
      const created = await createVersion(client(), document.id, { name: 'thesis.pdf', bytes });
      await putToStorage(created.upload, bytes);

      context.clock.advanceMinutes(11); // the session TTL is 10 minutes in tests
      const response = await finalize(client(), document.id, created.versionId);
      expect(response.status).toBe(410);
      expect(response.body.error.code).toBe('UPLOAD_SESSION_EXPIRED');
      expect((await getVersion(client(), document.id, created.versionId)).body.status).toBe(
        'UPLOAD_EXPIRED',
      );
    });

    it('sweeps abandoned sessions and removes their staged objects', async () => {
      const bytes = minimalPdf();
      const document = await createDocument(client());
      const created = await createVersion(client(), document.id, { name: 'thesis.pdf', bytes });
      await putToStorage(created.upload, bytes);
      const row = await context.adminDb.documentVersion.findUniqueOrThrow({
        where: { id: created.versionId },
      });
      expect(
        await context.storage.headObject({ zone: 'quarantine', key: row.quarantineObjectKey }),
      ).not.toBeNull();

      context.clock.advanceMinutes(11);
      expect(await context.sweeper.sweep()).toBe(1);

      expect((await getVersion(client(), document.id, created.versionId)).body.status).toBe(
        'UPLOAD_EXPIRED',
      );
      expect(
        await context.storage.headObject({ zone: 'quarantine', key: row.quarantineObjectKey }),
      ).toBeNull();
      const session = await context.adminDb.uploadSession.findUniqueOrThrow({
        where: { documentVersionId: created.versionId },
      });
      expect(session.status).toBe('EXPIRED');
    });

    it('cancels an upload that has not been finalized, and refuses to finalize it afterwards', async () => {
      const document = await createDocument(client());
      const created = await createVersion(client(), document.id, {
        name: 'thesis.pdf',
        bytes: minimalPdf(),
      });
      const cancelled = await client().post(
        `${DOCUMENTS}/${document.id}/versions/${created.versionId}/cancel`,
      );
      expect(cancelled.status).toBe(200);
      expect(cancelled.body.status).toBe('CANCELLED');

      const response = await finalize(client(), document.id, created.versionId);
      expect(response.status).toBe(410);
      expect(response.body.error.code).toBe('UPLOAD_SESSION_CANCELLED');
    });

    it('re-issues an authorization only while the version awaits its upload', async () => {
      const bytes = minimalPdf();
      const document = await createDocument(client());
      const created = await createVersion(client(), document.id, { name: 'thesis.pdf', bytes });
      const reissued = await client().post(
        `${DOCUMENTS}/${document.id}/versions/${created.versionId}/upload-authorizations`,
      );
      expect(reissued.status).toBe(201);
      expect(typeof reissued.body.expiresAt).toBe('string');
      expect(reissued.body.headers['Content-Length']).toBe(String(bytes.length));
      expect((await putToStorage(reissued.body, bytes)).status).toBeLessThan(300);

      await finalize(client(), document.id, created.versionId);
      const after = await client().post(
        `${DOCUMENTS}/${document.id}/versions/${created.versionId}/upload-authorizations`,
      );
      expect(after.status).toBe(409);
      expect(after.body.error.code).toBe('UPLOAD_ALREADY_FINALIZED');
    });
  });

  // -------------------------------------------------------------------------
  describe('presigned URL reuse cannot change a finalized version (§25, §33)', () => {
    it('processes the object version captured at finalize even after the URL is reused', async () => {
      const original = minimalPdf('the finalized content');
      const document = await createDocument(client());
      const created = await createVersion(client(), document.id, {
        name: 'thesis.pdf',
        bytes: original,
      });
      await putToStorage(created.upload, original);
      expect((await finalize(client(), document.id, created.versionId)).status).toBe(200);

      // Someone holding the still-valid URL writes again, same size.
      const replacement = Buffer.from(original);
      replacement.write('X'.repeat(8), original.indexOf('finalized'), 'latin1');
      const reuse = await putToStorage(created.upload, replacement);
      expect(reuse.status).toBeLessThan(300);

      const version = await waitForSettled(client(), document.id, created.versionId);
      expect(version['status']).toBe('READY');
      expect(version['sha256']).toBe(sha256Hex(original));

      const download = await fetchDownload(
        (await downloadAuthorization(client(), document.id, created.versionId)).body.url,
      );
      expect(download.bytes.equals(original)).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  describe('download authorization (§43, §44)', () => {
    it('refuses a download for a version that is not READY', async () => {
      const document = await createDocument(client());
      const created = await createVersion(client(), document.id, {
        name: 'thesis.pdf',
        bytes: minimalPdf(),
      });
      const response = await downloadAuthorization(client(), document.id, created.versionId);
      expect(response.status).toBe(409);
      expect(response.body.error.code).toBe('DOCUMENT_NOT_READY');
    });

    it('audits the download and never records the signed URL', async () => {
      const document = await createDocument(client());
      const { versionId } = await uploadAndProcess(client(), document.id, {
        name: 'thesis.pdf',
        bytes: minimalPdf(),
      });
      const grant = await downloadAuthorization(client(), document.id, versionId);

      const events = await context.adminDb.auditEvent.findMany({
        where: { action: 'DOCUMENT_VERSION_DOWNLOADED' },
      });
      expect(events).toHaveLength(1);
      expect(JSON.stringify(events[0]!.afterState)).not.toContain('Signature');
      expect(JSON.stringify(events[0]!.afterState)).not.toContain(grant.body.url);
    });

    it('records the expected audit trail for the journey', async () => {
      const document = await createDocument(client());
      await uploadAndProcess(client(), document.id, { name: 'thesis.pdf', bytes: minimalPdf() });
      const actions = (
        await context.adminDb.auditEvent.findMany({ orderBy: { createdAt: 'asc' } })
      ).map((e) => e.action);
      const expected = [
        'DOCUMENT_CREATED',
        'DOCUMENT_VERSION_CREATED',
        'UPLOAD_SESSION_CREATED',
        'UPLOAD_FINALIZED',
        'DOCUMENT_VALIDATION_STARTED',
        'DOCUMENT_SCAN_STARTED',
        'DOCUMENT_VERSION_READY',
      ];
      for (const action of expected) expect(actions).toContain(action);
    });
  });

  // -------------------------------------------------------------------------
  describe('validation of the request itself', () => {
    it('refuses an unsupported extension before any storage is touched', async () => {
      const document = await createDocument(client());
      for (const name of [
        'thesis.doc',
        'thesis.docm',
        'thesis.exe',
        'thesis',
        'thesis.pdf.exe',
        'thesis.zip',
      ]) {
        const response = await client().post(`${DOCUMENTS}/${document.id}/versions`, {
          originalFilename: name,
          sizeBytes: 10,
        });
        expect(response.status).toBe(415);
        expect(response.body.error.code).toBe('FILE_EXTENSION_UNSUPPORTED');
      }
      expect(await context.adminDb.documentVersion.count()).toBe(0);
    });

    it('refuses a declared size over the limit', async () => {
      const document = await createDocument(client());
      const response = await client().post(`${DOCUMENTS}/${document.id}/versions`, {
        originalFilename: 'big.pdf',
        sizeBytes: 300 * 1024,
      });
      expect(response.status).toBe(413);
      expect(response.body.error.code).toBe('FILE_TOO_LARGE');
    });

    it('sanitizes the original filename and keeps it as metadata only', async () => {
      const bytes = minimalPdf();
      const document = await createDocument(client());
      const created = await createVersion(client(), document.id, {
        name: '../../etc/passwd .pdf',
        bytes,
      });
      expect((created.body.version as { originalFilename: string }).originalFilename).toBe(
        '_.._etc_passwd.pdf',
      );
      const row = await context.adminDb.documentVersion.findUniqueOrThrow({
        where: { id: created.versionId },
      });
      expect(row.quarantineObjectKey).not.toContain('passwd');
      expect(row.quarantineObjectKey).toMatch(/^staging\/users\/[0-9a-f-]{36}\//);
    });

    it('requires authentication', async () => {
      const anonymous = new AuthClient(context.app);
      expect((await anonymous.get(DOCUMENTS)).status).toBe(401);
      expect((await anonymous.get(`${API}/documents`)).status).toBe(401);
    });
  });
});
