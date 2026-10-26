import { createUser } from './support/organization-client';
import type { AuthClient } from './support/auth-client';
import {
  DOCUMENTS,
  attemptUpload,
  createDocument,
  createVersion,
  downloadAuthorization,
  finalize,
  getVersion,
  putToStorage,
  uploadAndProcess,
  waitForQuarantinePurge,
  waitForSettled,
} from './support/documents-client';
import {
  eicarPdf,
  macroDocx,
  manyEntriesZip,
  minimalDocx,
  minimalPdf,
  randomZip,
  traversalZip,
  zipBomb,
} from './support/fixtures';
import { storageEnforcesSignatures } from './support/storage-capability';
import {
  createTestContext,
  destroyTestContext,
  resetState,
  type TestContext,
} from './support/test-app';

/** A Windows executable header, built from bytes so no control characters appear in source. */
const FAKE_EXE = Buffer.from([
  0x4d, 0x5a, 0x90, 0x00, 0x03, 0x00, 0x00, 0x00, 0x04, 0x00, 0x00, 0x00, 0xff, 0xff,
]);

/**
 * The security test matrix (§88) and the failure semantics (§11, §36, §54).
 *
 * Every rejection is decided by the real pipeline on real staged bytes, and
 * every "PalCert's fault" case is proven to end in FAILED, never READY and
 * never REJECTED.
 */
describe('Documents — security matrix (e2e)', () => {
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

  async function expectRejected(
    file: { name: string; bytes: Buffer; mimeType?: string },
    code: string,
  ): Promise<Record<string, unknown>> {
    const document = await createDocument(client());
    const { versionId, version } = await uploadAndProcess(client(), document.id, file);
    expect(version['status']).toBe('REJECTED');
    expect(version['rejectionCode']).toBe(code);
    expect(version['sha256']).toBeNull();

    // Nothing rejected is ever downloadable, and the staged bytes are gone.
    expect((await downloadAuthorization(client(), document.id, versionId)).status).toBe(409);

    // The purge is a second transaction after the REJECTED one, so converge
    // on it rather than assuming the terminal status implies it. Still an
    // assertion: a purge that never happens fails here on the deadline.
    await waitForQuarantinePurge(context, versionId);

    const row = await context.adminDb.documentVersion.findUniqueOrThrow({
      where: { id: versionId },
    });
    expect(row.cleanObjectKey).toBeNull();
    expect(row.quarantineDeletedAt).not.toBeNull();
    expect(
      await context.storage.headObject({ zone: 'quarantine', key: row.quarantineObjectKey }),
    ).toBeNull();
    return version;
  }

  /**
   * A job ledger row once the worker has let go of it.
   *
   * The worker writes the resource's outcome first and marks its own ledger
   * row afterwards, so a version that has reached a terminal status says
   * nothing yet about the job. Reading the job straight after an upstream
   * wait races the worker and sees RUNNING. Bounded, so a job that never
   * settles still fails the assertion that follows.
   */
  async function settledJob(jobId: string, timeoutMs = 10_000) {
    const deadline = Date.now() + timeoutMs;
    let job = await context.adminDb.processingJob.findUniqueOrThrow({ where: { id: jobId } });
    while ((job.status === 'RUNNING' || job.status === 'DISPATCHED') && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 25));
      job = await context.adminDb.processingJob.findUniqueOrThrow({ where: { id: jobId } });
    }
    return job;
  }

  // -------------------------------------------------------------------------
  describe('content rejections', () => {
    it('rejects a .pdf that contains a ZIP (extension spoof)', async () => {
      await expectRejected({ name: 'thesis.pdf', bytes: minimalDocx() }, 'FILE_TYPE_MISMATCH');
    });

    it('rejects a .docx that contains a PDF', async () => {
      await expectRejected({ name: 'thesis.docx', bytes: minimalPdf() }, 'FILE_TYPE_MISMATCH');
    });

    it('rejects a .docx that is a random ZIP', async () => {
      await expectRejected({ name: 'thesis.docx', bytes: randomZip() }, 'FILE_CONTAINER_INVALID');
    });

    it('rejects an executable named as a PDF', async () => {
      await expectRejected({ name: 'thesis.pdf', bytes: FAKE_EXE }, 'FILE_TYPE_UNSUPPORTED');
    });

    it('accepts a PDF whose declared content type is wrong: the browser is advisory (§14)', async () => {
      const document = await createDocument(client());
      const { version } = await uploadAndProcess(client(), document.id, {
        name: 'thesis.pdf',
        bytes: minimalPdf(),
        mimeType: 'text/plain',
      });
      expect(version).toMatchObject({
        status: 'READY',
        declaredMimeType: 'text/plain',
        detectedMimeType: 'application/pdf',
      });
    });

    it('rejects a zero-byte upload', async () => {
      const document = await createDocument(client());
      const created = await createVersion(client(), document.id, {
        name: 'empty.pdf',
        bytes: Buffer.alloc(0),
      });
      expect((await putToStorage(created.upload, Buffer.alloc(0))).status).toBeLessThan(300);
      expect((await finalize(client(), document.id, created.versionId)).status).toBe(200);
      const version = await waitForSettled(client(), document.id, created.versionId);
      expect(version).toMatchObject({ status: 'REJECTED', rejectionCode: 'FILE_EMPTY' });
    });

    it('rejects an oversized upload at finalize, whatever size was declared', async () => {
      const document = await createDocument(client());
      const created = await createVersion(client(), document.id, {
        name: 'big.pdf',
        bytes: Buffer.alloc(100),
      });
      const big = minimalPdf('x', 300 * 1024);
      const put = await putToStorage(
        {
          ...created.upload,
          headers: { ...created.upload.headers, 'Content-Length': String(big.length) },
        },
        big,
      );

      // The declared length is signed, so an enforcing storage refuses the
      // oversized PUT and there is nothing for finalize to reject.
      if (storageEnforcesSignatures()) {
        expect(put.status).toBeGreaterThanOrEqual(400);
        expect((await getVersion(client(), document.id, created.versionId)).body.status).toBe(
          'AWAITING_UPLOAD',
        );
        return;
      }

      const response = await finalize(client(), document.id, created.versionId);
      expect(response.status).toBe(413);
      expect(response.body.error.code).toBe('FILE_TOO_LARGE');
      expect((await getVersion(client(), document.id, created.versionId)).body).toMatchObject({
        status: 'REJECTED',
        rejectionCode: 'FILE_TOO_LARGE',
      });
    });

    it('rejects a package with a path-traversal entry', async () => {
      await expectRejected({ name: 'thesis.docx', bytes: traversalZip() }, 'FILE_ARCHIVE_UNSAFE');
    });

    it('rejects a ZIP bomb by compression ratio', async () => {
      await expectRejected({ name: 'thesis.docx', bytes: zipBomb() }, 'FILE_ARCHIVE_UNSAFE');
    });

    it('rejects a package with too many entries', async () => {
      await expectRejected(
        { name: 'thesis.docx', bytes: manyEntriesZip(100) },
        'FILE_ARCHIVE_UNSAFE',
      );
    });

    it('rejects a macro-bearing package', async () => {
      await expectRejected({ name: 'thesis.docx', bytes: macroDocx() }, 'FILE_MACRO_UNSUPPORTED');
    });

    it('rejects the malware test file, records the verdict safely, and never exposes the signature', async () => {
      const version = await expectRejected(
        { name: 'thesis.pdf', bytes: eicarPdf() },
        'FILE_MALWARE_DETECTED',
      );
      expect(JSON.stringify(version)).not.toMatch(/eicar|signature|engine/i);

      const row = await context.adminDb.documentVersion.findFirstOrThrow({
        where: { rejectionCode: 'FILE_MALWARE_DETECTED' },
      });
      expect(row.scanSignature).toBe('Eicar-Test-Signature');
      expect(row.scanEngine).toMatch(/^fake/);
      const audit = await context.adminDb.auditEvent.findFirst({
        where: { action: 'DOCUMENT_VERSION_REJECTED' },
      });
      expect(audit?.afterState).toMatchObject({ rejectionCode: 'FILE_MALWARE_DETECTED' });
    });

    it('rejects a client checksum that does not match the bytes', async () => {
      const document = await createDocument(client());
      const file = { name: 'thesis.pdf', bytes: minimalPdf(), sha256: 'b'.repeat(64) };

      // The checksum is a signed header. A storage service that enforces what
      // it signed refuses the PUT outright, and the bad bytes never arrive —
      // the stronger of the two outcomes, and the one real S3 gives.
      if (storageEnforcesSignatures()) {
        const { versionId, putStatus } = await attemptUpload(client(), document.id, file);
        expect(putStatus).toBeGreaterThanOrEqual(400);
        const version = await getVersion(client(), document.id, versionId);
        expect(version.body.status).toBe('AWAITING_UPLOAD');
        expect(version.body.sha256).toBeNull();
        return;
      }

      // On a storage that does not check, PalCert's own ingestion must — it
      // re-derives the digest from the bytes rather than trusting either the
      // client or the service.
      const { version } = await uploadAndProcess(client(), document.id, file);
      expect(version).toMatchObject({
        status: 'REJECTED',
        rejectionCode: 'FILE_CHECKSUM_MISMATCH',
      });
    });
  });

  // -------------------------------------------------------------------------
  describe("infrastructure failures are never the document's fault", () => {
    /** Drive the retry policy: the clock is frozen, so each backoff must be stepped over. */
    async function exhaustRetries(
      documentId: string,
      versionId: string,
    ): Promise<Record<string, unknown>> {
      for (let round = 0; round < 8; round += 1) {
        const version = (await getVersion(client(), documentId, versionId)).body as Record<
          string,
          unknown
        >;
        if (version['status'] === 'FAILED') return version;
        await new Promise((resolve) => setTimeout(resolve, 300));
        context.clock.advanceMinutes(2);
        await context.dispatcher.sweep();
      }
      return waitForSettled(client(), documentId, versionId);
    }

    it('a scanner outage produces retries and then FAILED, never READY (§36)', async () => {
      context.scanner.mode = 'unavailable';
      const document = await createDocument(client());
      const created = await createVersion(client(), document.id, {
        name: 'thesis.pdf',
        bytes: minimalPdf(),
      });
      await putToStorage(created.upload, minimalPdf());
      expect((await finalize(client(), document.id, created.versionId)).status).toBe(200);

      const version = await exhaustRetries(document.id, created.versionId);
      expect(version).toMatchObject({
        status: 'FAILED',
        failureCode: 'SCANNER_UNAVAILABLE',
        retryable: true,
        rejectionCode: null,
      });

      const enqueued = await context.adminDb.processingJob.findFirstOrThrow({
        where: { resourceId: created.versionId },
      });
      const job = await settledJob(enqueued.id);
      expect(job.status).toBe('DEAD');
      expect(job.attemptCount).toBe(3);
      expect(job.lastFailureCode).toBe('SCANNER_UNAVAILABLE');
      expect((await downloadAuthorization(client(), document.id, created.versionId)).status).toBe(
        409,
      );

      // The staged bytes are kept, so the owner can retry without re-uploading (§80).
      const row = await context.adminDb.documentVersion.findUniqueOrThrow({
        where: { id: created.versionId },
      });
      expect(row.quarantineDeletedAt).toBeNull();
      context.scanner.mode = 'normal';
      const retried = await client().post(
        `${DOCUMENTS}/${document.id}/versions/${created.versionId}/retry`,
      );
      expect(retried.status).toBe(200);
      expect(retried.body.status).toBe('UPLOADED');
      expect((await waitForSettled(client(), document.id, created.versionId))['status']).toBe(
        'READY',
      );
    });

    it('a storage outage during processing does not corrupt state, and recovers on retry', async () => {
      const bytes = minimalPdf();
      const document = await createDocument(client());
      const created = await createVersion(client(), document.id, { name: 'thesis.pdf', bytes });
      await putToStorage(created.upload, bytes);
      context.storage.failing.add('copy');
      expect((await finalize(client(), document.id, created.versionId)).status).toBe(200);

      const version = await exhaustRetries(document.id, created.versionId);
      expect(version).toMatchObject({ status: 'FAILED', failureCode: 'STORAGE_UNAVAILABLE' });
      const row = await context.adminDb.documentVersion.findUniqueOrThrow({
        where: { id: created.versionId },
      });
      expect(row.cleanObjectKey).toBeNull();
      expect(row.sha256).toBeNull();

      context.storage.failing.clear();
      expect(
        (await client().post(`${DOCUMENTS}/${document.id}/versions/${created.versionId}/retry`))
          .status,
      ).toBe(200);
      expect((await waitForSettled(client(), document.id, created.versionId))['status']).toBe(
        'READY',
      );
    });

    it('a storage outage at finalize is a 503 and leaves the version awaiting upload', async () => {
      const bytes = minimalPdf();
      const document = await createDocument(client());
      const created = await createVersion(client(), document.id, { name: 'thesis.pdf', bytes });
      await putToStorage(created.upload, bytes);
      context.storage.failing.add('head');
      const response = await finalize(client(), document.id, created.versionId);
      expect(response.status).toBe(503);
      expect(response.body.error.code).toBe('STORAGE_UNAVAILABLE');
      expect((await getVersion(client(), document.id, created.versionId)).body.status).toBe(
        'AWAITING_UPLOAD',
      );

      context.storage.failing.clear();
      expect((await finalize(client(), document.id, created.versionId)).status).toBe(200);
      expect((await waitForSettled(client(), document.id, created.versionId))['status']).toBe(
        'READY',
      );
    });

    it('a Redis outage after finalize loses nothing: the intent is durable and publishes later (§54)', async () => {
      const bytes = minimalPdf();
      const document = await createDocument(client());
      const created = await createVersion(client(), document.id, { name: 'thesis.pdf', bytes });
      await putToStorage(created.upload, bytes);

      const outage = jest
        .spyOn(context.queue, 'publish')
        .mockRejectedValue(new Error('ECONNREFUSED redis'));
      try {
        const response = await finalize(client(), document.id, created.versionId);
        expect(response.status).toBe(200);
        expect(response.body.status).toBe('UPLOADED');
        const job = await context.adminDb.processingJob.findFirstOrThrow({
          where: { resourceId: created.versionId },
        });
        expect(job.status).toBe('PENDING');
      } finally {
        outage.mockRestore();
      }

      expect((await context.dispatcher.sweep()).published).toBe(1);
      expect((await waitForSettled(client(), document.id, created.versionId))['status']).toBe(
        'READY',
      );
    });

    it('a REJECTED version is never retryable', async () => {
      const document = await createDocument(client());
      const { versionId } = await uploadAndProcess(client(), document.id, {
        name: 'thesis.docx',
        bytes: macroDocx(),
      });
      const response = await client().post(
        `${DOCUMENTS}/${document.id}/versions/${versionId}/retry`,
      );
      expect(response.status).toBe(409);
      expect(response.body.error.code).toBe('DOCUMENT_VERSION_NOT_RETRYABLE');
    });
  });

  // -------------------------------------------------------------------------
  describe('queue semantics (§52, §58, §65, §91)', () => {
    /**
     * A job row once the worker has finished with it.
     *
     * The document reaching READY is the handler's last *document* write; the
     * ledger row is settled just after it, so reading the job the instant the
     * version settles can catch it still RUNNING. This polls for the terminal
     * state instead — and still fails if the job never reaches one.
     */
    it('a duplicate delivery of a completed job is a safe no-op', async () => {
      const document = await createDocument(client());
      const { versionId } = await uploadAndProcess(client(), document.id, {
        name: 'thesis.pdf',
        bytes: minimalPdf(),
      });
      const enqueued = await context.adminDb.processingJob.findFirstOrThrow({
        where: { resourceId: versionId },
      });
      const job = await settledJob(enqueued.id);
      expect(job.status).toBe('SUCCEEDED');

      await context.worker.processJobId(job.id);
      await context.worker.processJobId(job.id);

      expect((await getVersion(client(), document.id, versionId)).body.status).toBe('READY');
      expect(context.scanner.scannedSizes).toHaveLength(1);
      expect(
        (await context.adminDb.processingJob.findUniqueOrThrow({ where: { id: job.id } })).status,
      ).toBe('SUCCEEDED');
    });

    it('a queue message alone authorizes nothing: an unknown job id does no work', async () => {
      await expect(
        context.worker.processJobId('00000000-0000-4000-8000-000000000000'),
      ).resolves.toBeUndefined();
    });

    it('an abandoned job (worker died) is reaped and re-run', async () => {
      const bytes = minimalPdf();
      const document = await createDocument(client());
      const created = await createVersion(client(), document.id, { name: 'thesis.pdf', bytes });
      await putToStorage(created.upload, bytes);

      const outage = jest.spyOn(context.queue, 'publish').mockRejectedValue(new Error('down'));
      await finalize(client(), document.id, created.versionId);
      outage.mockRestore();

      // Simulate a worker that claimed the job, started, and died mid-stage.
      const job = await context.adminDb.processingJob.findFirstOrThrow({
        where: { resourceId: created.versionId },
      });
      const past = new Date(context.clock.now().getTime() - 60_000);
      await context.adminDb.processingJob.update({
        where: { id: job.id },
        data: { status: 'DISPATCHED', dispatchedAt: past, leaseExpiresAt: past },
      });
      await context.adminDb.processingJob.update({
        where: { id: job.id },
        data: { status: 'RUNNING', startedAt: past, leaseExpiresAt: past },
      });
      await context.adminDb
        .$executeRaw`UPDATE "document_versions" SET "status" = 'VALIDATING' WHERE "id" = ${created.versionId}::uuid`;

      const swept = await context.dispatcher.sweep();
      expect(swept.requeued).toBe(1);
      expect(swept.published).toBe(1);
      expect((await waitForSettled(client(), document.id, created.versionId))['status']).toBe(
        'READY',
      );
      const finished = await settledJob(job.id);
      expect(finished.status).toBe('SUCCEEDED');
      // Reaping an abandoned lease re-runs the work; it does not spend an
      // attempt the worker never got to use (§58).
      expect(finished.attemptCount).toBe(1);
    });
  });
});
