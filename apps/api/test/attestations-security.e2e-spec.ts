import request from 'supertest';
import {
  ATTESTATIONS,
  approve,
  createDraft,
  createInstitution,
  degreePdf,
  executableBytes,
  jpegBytes,
  orgAttestations,
  pngBomb,
  pngBytes,
  readyDraft,
  sha256,
  startReview,
  submit,
  tokenFromUrl,
  uploadArtifact,
  waitForArtifact,
  waitForPayment,
  zipPretendingToBeJpeg,
  type Institution,
} from './support/attestation-client';
import { API, type AuthClient } from './support/auth-client';
import { expectStatus } from './support/checks-client';
import { fundBalance } from './support/finance-client';
import { eicarPdf } from './support/fixtures';
import { createUser, grantOrganizationRoleTo } from './support/organization-client';
import {
  createTestContext,
  destroyTestContext,
  resetState,
  type TestContext,
} from './support/test-app';

/**
 * Attestation security: what the upload pipeline refuses, what the state
 * machine refuses at the API and at the database, who can see what, and what
 * the public page never says.
 */
describe('Certificate attestation — security and isolation (e2e)', () => {
  let context: TestContext;

  beforeAll(async () => {
    context = await createTestContext();
    await new Promise<void>((resolve) => {
      context.app.getHttpServer().listen(0, '127.0.0.1', () => resolve());
    });
  });

  afterAll(async () => {
    await destroyTestContext(context);
  });

  beforeEach(async () => {
    await resetState(context);
  });

  async function holder(email = 'holder@example.test', cash = '5000') {
    const user = await createUser(context, email);
    await fundBalance(context, user.client, cash);
    return user;
  }

  async function attested(
    university: Institution,
    client: AuthClient,
  ): Promise<{ requestId: string; url: string }> {
    const requestId = await readyDraft(client, university.typeId);
    expectStatus(await submit(client, requestId), 200, 'Submit');
    expectStatus(
      await startReview(university.owner.client, university.organizationId, requestId),
      200,
      'Start',
    );
    expectStatus(
      await approve(university.owner.client, university.organizationId, requestId),
      200,
      'Approve',
    );
    await waitForPayment(context, requestId, 'SETTLED');
    const url = await client.get(`${ATTESTATIONS}/${requestId}`);
    expectStatus(url, 200, 'Owner read');
    return { requestId, url: url.body.attestation.verificationUrl as string };
  }

  async function uploadOutcome(
    client: AuthClient,
    typeId: string,
    bytes: Buffer,
    filename: string,
  ) {
    const draft = await createDraft(client, typeId);
    const requestId = draft['id'] as string;
    await uploadArtifact(client, requestId, bytes, filename);
    return { requestId, artifact: await waitForArtifact(client, requestId) };
  }

  describe('uploads', () => {
    it('accepts PDF, PNG and JPEG by their content, and measures the exact bytes', async () => {
      const university = await createInstitution(context, 'University A', 'a@university.test');
      const user = await holder();
      for (const [bytes, filename, format] of [
        [degreePdf(), 'degree.pdf', 'PDF'],
        [pngBytes(), 'degree.png', 'PNG'],
        [jpegBytes(), 'degree.jpg', 'JPEG'],
      ] as const) {
        const { artifact } = await uploadOutcome(user.client, university.typeId, bytes, filename);
        expect(artifact).toMatchObject({
          status: 'READY',
          detectedFormat: format,
          sha256: sha256(bytes),
        });
        expect(artifact['sizeBytes']).toBe(bytes.length);
      }
    });

    it('refuses unsupported extensions before any bytes move', async () => {
      const university = await createInstitution(context, 'University A', 'a@university.test');
      const user = await holder();
      const draft = await createDraft(user.client, university.typeId);
      for (const filename of ['setup.exe', 'archive.zip', 'degree.docx', 'degree']) {
        const response = await user.client.post(`${ATTESTATIONS}/${draft['id']}/artifacts`, {
          originalFilename: filename,
          sizeBytes: 1024,
        });
        expect(response.status).toBe(422);
        expect(response.body.error.code).toBe('ATTESTATION_ARTIFACT_TYPE_NOT_ALLOWED');
      }
    });

    it('refuses a declared size over the limit', async () => {
      const university = await createInstitution(context, 'University A', 'a@university.test');
      const user = await holder();
      const draft = await createDraft(user.client, university.typeId);
      const response = await user.client.post(`${ATTESTATIONS}/${draft['id']}/artifacts`, {
        originalFilename: 'degree.pdf',
        sizeBytes: 20 * 1024 * 1024 + 1,
      });
      expect([400, 413, 422]).toContain(response.status);
    });

    it.each([
      ['an executable named .pdf', executableBytes(), 'degree.pdf'],
      ['a ZIP named .jpg', zipPretendingToBeJpeg(), 'degree.jpg'],
      ['a PNG named .jpg', pngBytes(), 'degree.jpg'],
      ['a decompression-bomb PNG', pngBomb(), 'degree.png'],
      ['the EICAR test file', eicarPdf(), 'degree.pdf'],
    ])('rejects %s, and it can never be submitted', async (_label, bytes, filename) => {
      const university = await createInstitution(context, 'University A', 'a@university.test');
      const user = await holder();
      const { requestId, artifact } = await uploadOutcome(
        user.client,
        university.typeId,
        bytes,
        filename,
      );
      expect(artifact['status']).toBe('REJECTED');
      expect(typeof artifact['rejectionCode']).toBe('string');
      const submitted = await submit(user.client, requestId);
      expect(submitted.status).toBe(409);
      expect(submitted.body.error.code).toBe('ATTESTATION_ARTIFACT_NOT_READY');
      expect(await context.adminDb.creditHold.count({ where: { ownerUserId: user.userId } })).toBe(
        0,
      );
    });

    it('refuses to attest bytes that no longer match what was measured', async () => {
      const university = await createInstitution(context, 'University A', 'a@university.test');
      const user = await holder();
      const requestId = await readyDraft(user.client, university.typeId);
      expectStatus(await submit(user.client, requestId), 200, 'Submit');
      expectStatus(
        await startReview(university.owner.client, university.organizationId, requestId),
        200,
        'Start',
      );
      const artifact = await context.adminDb.attestationArtifact.findFirstOrThrow({
        where: { requestId },
      });
      context.storage.corruptingStreams.add(artifact.cleanObjectKey!);

      const approved = await approve(university.owner.client, university.organizationId, requestId);
      expect(approved.status).toBe(409);
      expect(approved.body.error.code).toBe('ATTESTATION_ARTIFACT_INTEGRITY_FAILED');
      expect(await context.adminDb.attestation.count()).toBe(0);
      const row = await context.adminDb.attestationRequest.findUniqueOrThrow({
        where: { id: requestId },
      });
      expect([row.status, row.paymentStatus]).toEqual(['IN_REVIEW', 'RESERVED']);
    });
  });

  describe('state machine', () => {
    it('refuses illegal transitions through the API', async () => {
      const university = await createInstitution(context, 'University A', 'a@university.test');
      const user = await holder();
      const requestId = await readyDraft(user.client, university.typeId);
      const review = `${orgAttestations(university.organizationId)}/attestation-requests/${requestId}`;

      // A draft is invisible to the institution, so it cannot be decided.
      expect(
        (await approve(university.owner.client, university.organizationId, requestId)).status,
      ).toBe(404);
      expectStatus(await submit(user.client, requestId), 200, 'Submit');
      // Approval needs a review in progress.
      expect(
        (await approve(university.owner.client, university.organizationId, requestId)).status,
      ).toBe(409);
      expectStatus(
        await startReview(university.owner.client, university.organizationId, requestId),
        200,
        'Start',
      );
      // The owner cannot cancel once review has started.
      expect((await user.client.post(`${ATTESTATIONS}/${requestId}/cancel`)).status).toBe(409);
      // Nor edit what is under review.
      expect(
        (await user.client.patch(`${ATTESTATIONS}/${requestId}`, { certificateTitle: 'Changed' }))
          .status,
      ).toBe(409);
      // Approval without the reviewer's confirmation is refused.
      const unconfirmed = await approve(
        university.owner.client,
        university.organizationId,
        requestId,
        { confirm: false },
      );
      expect(unconfirmed.status).toBe(422);
      expectStatus(
        await approve(university.owner.client, university.organizationId, requestId),
        200,
        'Approve',
      );
      // A decided request is final.
      expect(
        (await university.owner.client.post(`${review}/reject`, { reason: 'Too late' })).status,
      ).toBe(409);
      expect(
        (await university.owner.client.post(`${review}/request-information`, { message: 'More?' }))
          .status,
      ).toBe(409);
      expect((await user.client.post(`${ATTESTATIONS}/${requestId}/cancel`)).status).toBe(409);
    });

    it('refuses illegal transitions and rewrites at the database', async () => {
      const university = await createInstitution(context, 'University A', 'a@university.test');
      const user = await holder();
      const draft = await readyDraft(user.client, university.typeId);
      await expect(
        context.adminDb.attestationRequest.update({
          where: { id: draft },
          data: { status: 'APPROVED' },
        }),
      ).rejects.toThrow(/may not go|only the/);

      const { requestId } = await attested(university, user.client);
      const attestation = await context.adminDb.attestation.findUniqueOrThrow({
        where: { requestId },
      });
      await expect(
        context.adminDb.attestation.update({
          where: { id: attestation.id },
          data: { certificateTitle: 'Forged' },
        }),
      ).rejects.toThrow(/immutable/);
      await expect(
        context.adminDb.attestation.update({
          where: { id: attestation.id },
          data: { validUntil: new Date('2099-01-01T00:00:00Z') },
        }),
      ).rejects.toThrow(/immutable/);
      await expect(
        context.adminDb.attestation.delete({ where: { id: attestation.id } }),
      ).rejects.toThrow();
      await expect(
        context.adminDb.attestationArtifact.update({
          where: { id: attestation.artifactId },
          data: { sha256: '0'.repeat(64) },
        }),
      ).rejects.toThrow(/frozen|immutable/);
      await expect(
        context.adminDb.attestationArtifact.update({
          where: { id: attestation.artifactId },
          data: { purgedAt: new Date() },
        }),
      ).rejects.toThrow(/retained|frozen/);
      await expect(
        context.adminDb.attestationRequestEvent.updateMany({
          where: { requestId },
          data: { message: 'rewritten' },
        }),
      ).rejects.toThrow(/append-only/);
    });
  });

  describe('isolation and permissions', () => {
    it('keeps each user’s requests to themselves', async () => {
      const university = await createInstitution(context, 'University A', 'a@university.test');
      const alice = await holder('alice@example.test');
      const bob = await holder('bob@example.test');
      const requestId = await readyDraft(alice.client, university.typeId);

      for (const path of ['', '/quote', '/receipt', '/artifact/download', '/qr?format=svg']) {
        expect((await bob.client.get(`${ATTESTATIONS}/${requestId}${path}`)).status).toBe(404);
      }
      expect((await bob.client.post(`${ATTESTATIONS}/${requestId}/submit`)).status).toBe(404);
      expect((await bob.client.post(`${ATTESTATIONS}/${requestId}/cancel`)).status).toBe(404);
      expect(
        (await bob.client.patch(`${ATTESTATIONS}/${requestId}`, { certificateTitle: 'Mine now' }))
          .status,
      ).toBe(404);
      const list = await bob.client.get(ATTESTATIONS);
      expectStatus(list, 200, 'List');
      expect(list.body).toHaveLength(0);
    });

    it('keeps each institution to its own requests, and drafts to their owners', async () => {
      const a = await createInstitution(context, 'University A', 'a@university.test');
      const b = await createInstitution(context, 'University B', 'b@university.test');
      const user = await holder();
      const draft = await readyDraft(user.client, a.typeId);
      const submitted = await readyDraft(user.client, a.typeId);
      expectStatus(await submit(user.client, submitted), 200, 'Submit');

      // University A sees the submitted request, never the draft.
      const queue = await a.owner.client.get(
        `${orgAttestations(a.organizationId)}/attestation-requests?status=ALL`,
      );
      expectStatus(queue, 200, 'Queue A');
      expect(queue.body.items.map((item: { id: string }) => item.id)).toEqual([submitted]);
      expect(
        (
          await a.owner.client.get(
            `${orgAttestations(a.organizationId)}/attestation-requests/${draft}`,
          )
        ).status,
      ).toBe(404);

      // University B sees nothing of A's, through its own org or A's.
      const other = await b.owner.client.get(
        `${orgAttestations(b.organizationId)}/attestation-requests?status=ALL`,
      );
      expectStatus(other, 200, 'Queue B');
      expect(other.body.items).toHaveLength(0);
      expect(
        (
          await b.owner.client.get(
            `${orgAttestations(b.organizationId)}/attestation-requests/${submitted}`,
          )
        ).status,
      ).toBe(404);
      expect(
        (
          await b.owner.client.get(
            `${orgAttestations(a.organizationId)}/attestation-requests/${submitted}`,
          )
        ).status,
      ).toBe(404);
      expect((await startReview(b.owner.client, b.organizationId, submitted)).status).toBe(404);
      expect((await approve(b.owner.client, a.organizationId, submitted)).status).toBe(404);
    });

    it('lets a reviewer decide but not revoke, price or read revenue; others cannot review', async () => {
      const university = await createInstitution(context, 'University A', 'a@university.test');
      const reviewer = await createUser(context, 'reviewer@university.test');
      await grantOrganizationRoleTo(context, university, reviewer, 'ORGANIZATION_REVIEWER');
      const manager = await createUser(context, 'templates@university.test');
      await grantOrganizationRoleTo(context, university, manager, 'TEMPLATE_MANAGER');
      const user = await holder();
      const base = orgAttestations(university.organizationId);

      const requestId = await readyDraft(user.client, university.typeId);
      expectStatus(await submit(user.client, requestId), 200, 'Submit');
      expect((await manager.client.get(`${base}/attestation-requests`)).status).toBe(403);
      expect((await startReview(manager.client, university.organizationId, requestId)).status).toBe(
        403,
      );

      expectStatus(
        await startReview(reviewer.client, university.organizationId, requestId),
        200,
        'Start',
      );
      expectStatus(
        await approve(reviewer.client, university.organizationId, requestId),
        200,
        'Approve',
      );
      await waitForPayment(context, requestId, 'SETTLED');
      const attestation = await context.adminDb.attestation.findUniqueOrThrow({
        where: { requestId },
      });

      expect(
        (
          await reviewer.client.post(`${base}/attestations/${attestation.id}/revoke`, {
            reason: 'Not mine to revoke',
          })
        ).status,
      ).toBe(403);
      expect((await reviewer.client.get(`${base}/attestation-revenue`)).status).toBe(403);
      expect(
        (
          await reviewer.client.put(`${base}/attestation-types/${university.typeId}/fee`, {
            currency: 'USD',
            feeMinorUnits: '1',
          })
        ).status,
      ).toBe(403);
      expect(
        (
          await reviewer.client.post(`${base}/attestation-types`, {
            nameEn: 'X',
            nameAr: 'س',
            currency: 'USD',
            feeMinorUnits: '0',
          })
        ).status,
      ).toBe(403);
      // The owner of the institution can.
      expectStatus(
        await university.owner.client.post(`${base}/attestations/${attestation.id}/revoke`, {
          reason: 'Issued in error',
        }),
        200,
        'Revoke',
      );
      // Admin-only surfaces stay admin-only.
      expect((await university.owner.client.get(`${API}/admin/attestations/finance`)).status).toBe(
        403,
      );
      expect(
        (
          await university.owner.client.get(
            `${API}/admin/organizations/${university.organizationId}/attestation-commission`,
          )
        ).status,
      ).toBe(403);
    });

    it('flags duplicate files within one institution only', async () => {
      const a = await createInstitution(context, 'University A', 'a@university.test');
      const b = await createInstitution(context, 'University B', 'b@university.test');
      const alice = await holder('alice@example.test');
      const bob = await holder('bob@example.test');
      const bytes = degreePdf('Master of Science');

      const first = await readyDraft(alice.client, a.typeId, bytes);
      expectStatus(await submit(alice.client, first), 200, 'Submit A1');
      const second = await readyDraft(bob.client, a.typeId, bytes);
      expectStatus(await submit(bob.client, second), 200, 'Submit A2');
      const elsewhere = await readyDraft(bob.client, b.typeId, bytes);
      expectStatus(await submit(bob.client, elsewhere), 200, 'Submit B');

      const reviewA = await a.owner.client.get(
        `${orgAttestations(a.organizationId)}/attestation-requests/${second}`,
      );
      expectStatus(reviewA, 200, 'Review A');
      const sameFile = JSON.stringify(reviewA.body);
      expect(sameFile).toContain(first);
      expect(sameFile).not.toContain(elsewhere);

      const reviewB = await b.owner.client.get(
        `${orgAttestations(b.organizationId)}/attestation-requests/${elsewhere}`,
      );
      expectStatus(reviewB, 200, 'Review B');
      const text = JSON.stringify(reviewB.body);
      expect(text).not.toContain(first);
      expect(text).not.toContain(second);
    });
  });

  describe('public verification', () => {
    it('answers only by token, says nothing private, and never serves the file', async () => {
      const university = await createInstitution(context, 'University A', 'a@university.test');
      const user = await holder();
      const { requestId, url } = await attested(university, user.client);
      const token = tokenFromUrl(url);
      const server = context.app.getHttpServer();

      const page = await request(server).get(`${API}/public/attestations/${token}`);
      expect(page.status).toBe(200);
      expect(page.headers['cache-control']).toContain('no-store');
      expect(page.headers['x-robots-tag']).toContain('noindex');
      expect(page.body.verificationStatus).toBe('VALID');
      const attestation = await context.adminDb.attestation.findUniqueOrThrow({
        where: { requestId },
      });
      const body = JSON.stringify(page.body);
      for (const secret of [
        user.userId,
        user.email,
        requestId,
        attestation.id,
        attestation.artifactId,
        attestation.artifactCleanObjectKey,
        attestation.approvedByUserId,
        attestation.publicTokenHash,
        attestation.publicTokenSealed,
        university.owner.email,
      ]) {
        expect(body).not.toContain(secret);
      }
      for (const key of [
        'fee',
        'grossFeeMinor',
        'institutionNote',
        'ownerUserId',
        'objectKey',
        'downloadUrl',
      ]) {
        expect(body).not.toContain(`"${key}"`);
      }

      // Unknown and malformed tokens look the same.
      const unknown = await request(server).get(
        `${API}/public/attestations/${'A'.repeat(token.length)}`,
      );
      const malformed = await request(server).get(`${API}/public/attestations/not-a-token`);
      expect([unknown.status, malformed.status]).toEqual([404, 404]);
      expect(unknown.body.error.code).toBe(malformed.body.error.code);
      // No listing, and nothing under the token but the record.
      expect((await request(server).get(`${API}/public/attestations`)).status).toBe(404);
      expect(
        (await request(server).get(`${API}/public/attestations/${token}/artifact`)).status,
      ).toBe(404);
      expect(
        (await request(server).get(`${API}/public/attestations/${token}/download`)).status,
      ).toBe(404);
    });

    it('matches a file by its digest only while the attestation is valid', async () => {
      const university = await createInstitution(context, 'University A', 'a@university.test');
      const user = await holder();
      const bytes = degreePdf();
      const { requestId } = await attested(university, user.client);
      const server = context.app.getHttpServer();
      const verify = (digest: string) =>
        request(server).post(`${API}/public/attestations/verify-file`).send({ sha256: digest });

      const hit = await verify(sha256(bytes));
      expect(hit.status).toBe(200);
      expect(hit.body.matched).toBe(true);
      expect(hit.body.attestations).toHaveLength(1);
      expect((await verify(sha256(Buffer.from('another file')))).body).toEqual({
        matched: false,
        attestations: [],
      });
      expect((await verify('not-a-digest')).status).toBe(400);

      const attestation = await context.adminDb.attestation.findUniqueOrThrow({
        where: { requestId },
      });
      expectStatus(
        await university.owner.client.post(
          `${orgAttestations(university.organizationId)}/attestations/${attestation.id}/revoke`,
          { reason: 'Issued in error' },
        ),
        200,
        'Revoke',
      );
      expect((await verify(sha256(bytes))).body.matched).toBe(false);
    });

    it('shows a revoked attestation as REVOKED, not as missing', async () => {
      const university = await createInstitution(context, 'University A', 'a@university.test');
      const user = await holder();
      const { requestId, url } = await attested(university, user.client);
      const attestation = await context.adminDb.attestation.findUniqueOrThrow({
        where: { requestId },
      });
      const base = orgAttestations(university.organizationId);
      expectStatus(
        await university.owner.client.post(`${base}/attestations/${attestation.id}/revoke`, {
          reason: 'Issued in error',
        }),
        200,
        'Revoke',
      );
      const again = await university.owner.client.post(
        `${base}/attestations/${attestation.id}/revoke`,
        {
          reason: 'Twice',
        },
      );
      expect(again.status).toBe(409);
      const page = await request(context.app.getHttpServer()).get(
        `${API}/public/attestations/${tokenFromUrl(url)}`,
      );
      expect(page.status).toBe(200);
      expect(page.body.verificationStatus).toBe('REVOKED');
      expect(page.body.revokedAt).not.toBeNull();
      expect(JSON.stringify(page.body)).not.toContain('Issued in error');
    });

    it('shows EXPIRED after the validity window, on the test clock', async () => {
      const university = await createInstitution(context, 'University A', 'a@university.test');
      const user = await holder();
      const requestId = await readyDraft(user.client, university.typeId);
      expectStatus(await submit(user.client, requestId), 200, 'Submit');
      expectStatus(
        await startReview(university.owner.client, university.organizationId, requestId),
        200,
        'Start',
      );
      expectStatus(
        await approve(university.owner.client, university.organizationId, requestId, {
          validityDays: 1,
        }),
        200,
        'Approve',
      );
      const owner = await user.client.get(`${ATTESTATIONS}/${requestId}`);
      const token = tokenFromUrl(owner.body.attestation.verificationUrl as string);
      const server = context.app.getHttpServer();
      expect(
        (await request(server).get(`${API}/public/attestations/${token}`)).body.verificationStatus,
      ).toBe('VALID');
      context.clock.advanceMinutes(3 * 24 * 60);
      expect(
        (await request(server).get(`${API}/public/attestations/${token}`)).body.verificationStatus,
      ).toBe('EXPIRED');
    });
  });
});
