import { NotificationType } from '@palcert/contracts';
import request from 'supertest';
import { attestationQrPng } from '../src/modules/attestations/services/attestation-verification.service';
import { AttestationHousekeepingService } from '../src/modules/attestations/services/attestation-housekeeping.service';
import { AttestationPaymentService } from '../src/modules/attestations/services/attestation-payment.service';
import {
  ATTESTATIONS,
  approve,
  availableCash,
  createInstitution,
  degreePdf,
  orgAttestations,
  readyDraft,
  reject,
  setCommission,
  sha256,
  startReview,
  submit,
  tokenFromUrl,
  uploadArtifact,
  waitForArtifact,
  waitForPayment,
  type Institution,
} from './support/attestation-client';
import { API, signIn, type AuthClient } from './support/auth-client';
import { expectStatus } from './support/checks-client';
import { fundBalance, ledgerOf } from './support/finance-client';
import { PASSWORD, createUser, signInPlatformAdmin } from './support/organization-client';
import {
  createTestContext,
  destroyTestContext,
  resetState,
  type TestContext,
} from './support/test-app';

const DAY_MINUTES = 24 * 60;

/**
 * Certificate attestation, end to end.
 *
 * The acceptance scenario from the specification, through the real HTTP
 * surface, the real worker, real object storage and the real ledger:
 *
 *   User A has $20. University A charges $10 for a degree attestation and
 *   PalCert takes 15%. User A uploads degree.pdf, sees the $10 fee and
 *   submits; $10 is reserved. University A approves for a year. The user is
 *   charged $10; the university earns $8.50; PalCert earns $1.50. Anyone with
 *   the link sees VALID; nobody can download the certificate from it.
 */
describe('Certificate attestation — journey (e2e)', () => {
  let context: TestContext;
  let university: Institution;
  let user: { email: string; userId: string; client: AuthClient };
  let admin: AuthClient;

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
    university = await createInstitution(context, 'University A', 'registrar@university-a.test', {
      feeMinorUnits: '1000',
    });
    admin = await signInPlatformAdmin(context, 'admin@palcert.test');
    expectStatus(await setCommission(admin, university.organizationId, '15'), 200, 'Commission');
    user = await createUser(context, 'user.a@example.test');
    await fundBalance(context, user.client, '2000');
  });

  async function notificationTypes(client: AuthClient): Promise<string[]> {
    const response = await client.get(`${API}/notifications?limit=100`);
    expectStatus(response, 200, 'Inbox read');
    const items = (response.body.items ?? response.body) as Array<{ notificationType: string }>;
    return items.map((item) => item.notificationType);
  }

  async function waitForNotification(client: AuthClient, type: string): Promise<void> {
    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline) {
      await context.dispatcher.sweep();
      if ((await notificationTypes(client)).includes(type)) return;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error(`notification ${type} never arrived`);
  }

  it('reserves, approves, settles 850/150, verifies publicly and never exposes the file', async () => {
    const bytes = degreePdf();
    const requestId = await readyDraft(user.client, university.typeId, bytes);

    // The artifact is fingerprinted over its exact bytes.
    const draft = await user.client.get(`${ATTESTATIONS}/${requestId}`);
    expect(draft.body.artifact.sha256).toBe(sha256(bytes));
    expect(draft.body.artifact.detectedFormat).toBe('PDF');
    expect(draft.body.status).toBe('DRAFT');
    // A draft is the owner's alone.
    const hidden = await university.owner.client.get(
      `${orgAttestations(university.organizationId)}/attestation-requests/${requestId}`,
    );
    expect(hidden.status).toBe(404);

    // The user sees the fee against their balance before submitting.
    const quote = await user.client.get(`${ATTESTATIONS}/${requestId}/quote`);
    expectStatus(quote, 200, 'Quote');
    expect(quote.body.fee).toEqual({ currency: 'USD', minorUnits: '1000' });
    expect(quote.body.availableBalance).toEqual({ currency: 'USD', minorUnits: '2000' });
    expect(quote.body.sufficient).toBe(true);

    const submitted = await submit(user.client, requestId);
    expectStatus(submitted, 200, 'Submit');
    expect(submitted.body.status).toBe('SUBMITTED');
    expect(submitted.body.fee.paymentStatus).toBe('RESERVED');

    // $10 reserved, nothing charged yet.
    expect(await availableCash(user.client)).toBe(1000n);
    const ledgerBefore = await ledgerOf(context, user.userId);
    expect(ledgerBefore.reduce((sum, entry) => sum + entry.amountMinorSigned, 0n)).toBe(2000n);

    // The institution reviews and approves for one year.
    expectStatus(
      await startReview(university.owner.client, university.organizationId, requestId),
      200,
      'Start',
    );
    const approved = await approve(university.owner.client, university.organizationId, requestId, {
      validityDays: 365,
    });
    expectStatus(approved, 200, 'Approve');
    expect(approved.body.status).toBe('APPROVED');
    const record = approved.body.attestation;
    expect(record.verificationStatus).toBe('VALID');
    expect(record.reference).toMatch(/^PC-ATT-\d{4}-[0-9A-HJKMNP-TV-Z]{8}$/);
    expect(record.artifactSha256).toBe(sha256(bytes));
    expect(record.attestationHash).toMatch(/^[0-9a-f]{64}$/);
    expect(record.attestationHash).not.toBe(record.artifactSha256);
    expect(new Date(record.validUntil).getTime() - new Date(record.validFrom).getTime()).toBe(
      365 * 24 * 60 * 60 * 1000,
    );
    expect(record.verificationUrl).toMatch(/\/verify\/attestation\/[0-9A-HJKMNP-TV-Z]{32}$/);

    // Settlement: charged $10, institution $8.50, PalCert $1.50.
    await waitForPayment(context, requestId, 'SETTLED');
    const ledger = await ledgerOf(context, user.userId);
    const charges = ledger.filter((entry) => entry.entryType === 'SERVICE_CHARGE');
    expect(charges).toHaveLength(1);
    expect(charges[0]!.amountMinorSigned).toBe(-1000n);
    expect(charges[0]!.reasonCode).toBe('ATTESTATION_FEE');
    expect(ledger.reduce((sum, entry) => sum + entry.amountMinorSigned, 0n)).toBe(1000n);
    expect(await availableCash(user.client)).toBe(1000n);

    const settlement = await context.adminDb.attestationSettlement.findUniqueOrThrow({
      where: { requestId },
      include: { entries: true },
    });
    expect(settlement.grossMinor).toBe(1000n);
    expect(settlement.platformFeeMinor).toBe(150n);
    expect(settlement.institutionNetMinor).toBe(850n);
    expect(settlement.captureEntryId).toBe(charges[0]!.id);
    const byAccount = Object.fromEntries(
      settlement.entries.map((entry) => [entry.account, entry.amountMinor]),
    );
    expect(byAccount).toEqual({ INSTITUTION: 850n, PLATFORM_COMMISSION: 150n });

    // A retried settlement changes nothing.
    const payments = context.workerApp.get(AttestationPaymentService);
    expect(await payments.settle(requestId)).toBe('NOTHING_TO_DO');
    expect((await ledgerOf(context, user.userId)).length).toBe(ledger.length);
    expect(await context.adminDb.attestationRevenueEntry.count({ where: { requestId } })).toBe(2);

    // The institution's revenue report shows the split.
    const revenue = await university.owner.client.get(
      `${orgAttestations(university.organizationId)}/attestation-revenue`,
    );
    expectStatus(revenue, 200, 'Revenue');
    expect(revenue.body.totals[0]).toMatchObject({
      currency: 'USD',
      gross: { minorUnits: '1000' },
      platformFee: { minorUnits: '150' },
      institutionNet: { minorUnits: '850' },
      settled: { minorUnits: '1000' },
    });

    // The user's receipt names the ledger entry and not the split.
    const receipt = await user.client.get(`${ATTESTATIONS}/${requestId}/receipt`);
    expectStatus(receipt, 200, 'Receipt');
    expect(receipt.body.grossFee).toEqual({ currency: 'USD', minorUnits: '1000' });
    expect(receipt.body.paymentTransactionReference).toBe(charges[0]!.id);
    expect(receipt.body.paymentStatus).toBe('SETTLED');
    expect(JSON.stringify(receipt.body)).not.toMatch(/platform|commission|institutionNet/i);

    // Public verification works without signing in, and says only public things.
    const ownerView = await user.client.get(`${ATTESTATIONS}/${requestId}`);
    const url = ownerView.body.attestation.verificationUrl as string;
    const token = tokenFromUrl(url);
    const publicView = await request(context.app.getHttpServer()).get(
      `${API}/public/attestations/${token}`,
    );
    expect(publicView.status).toBe(200);
    const body = publicView.body;
    expect(body.verificationStatus).toBe('VALID');
    expect(body.verifiedBy).toBe('PalCert');
    expect(body.organization).toEqual({ name: 'University A', verified: true });
    expect(body.certificate.title).toBe('Bachelor of Science in Computer Engineering');
    expect(body.certificate.holderName).toBe('Sara Haddad');
    expect(body.artifactSha256).toBe(sha256(bytes));
    expect(body.validUntil).toBe(record.validUntil);
    const serialized = JSON.stringify(body);
    for (const secret of [
      user.email,
      user.userId,
      requestId,
      university.organizationId,
      'users/',
      'staging/',
    ]) {
      expect(serialized).not.toContain(secret);
    }
    for (const field of [
      'fee',
      'email',
      'ownerUserId',
      'approvedByUserId',
      'institutionNote',
      'url',
      'key',
    ]) {
      expect(Object.keys(body)).not.toContain(field);
    }
    expect(publicView.headers['cache-control']).toBe('no-store');
    expect(publicView.headers['x-robots-tag']).toContain('noindex');

    // The QR is the verification URL and nothing else.
    const qr = await user.client.get(`${ATTESTATIONS}/${requestId}/qr`);
    expect(qr.status).toBe(200);
    expect(qr.headers['content-type']).toContain('image/png');
    expect(Buffer.compare(qr.body as Buffer, await attestationQrPng(url))).toBe(0);
    const svg = await user.client.get(`${ATTESTATIONS}/${requestId}/qr?format=svg`);
    expect(svg.headers['content-type']).toContain('image/svg+xml');

    // The original is private: no public route serves it.
    const server = context.app.getHttpServer();
    for (const path of [
      `${API}/public/attestations/${token}/artifact`,
      `${API}/public/attestations/${token}/download`,
    ]) {
      expect((await request(server).get(path)).status).toBe(404);
    }
    // Another user cannot reach it either.
    const stranger = await createUser(context, 'stranger@example.test');
    expect(
      (await stranger.client.get(`${ATTESTATIONS}/${requestId}/artifact/download`)).status,
    ).toBe(404);
    expect((await stranger.client.get(`${ATTESTATIONS}/${requestId}`)).status).toBe(404);

    // Notifications: the owner was told, and the reviewers were told.
    await waitForNotification(user.client, NotificationType.ATTESTATION_APPROVED);
    const ownerTypes = await notificationTypes(user.client);
    expect(ownerTypes).toContain(NotificationType.ATTESTATION_SUBMITTED);
    await waitForNotification(
      university.owner.client,
      NotificationType.ATTESTATION_READY_FOR_REVIEW,
    );

    // Audit, without bytes.
    const audits = await context.adminDb.auditEvent.findMany({
      where: { action: { startsWith: 'ATTESTATION' } },
      select: { action: true, afterState: true },
    });
    const actions = new Set(audits.map((row) => row.action));
    for (const action of [
      'ATTESTATION_TYPE_CREATED',
      'ATTESTATION_REQUEST_CREATED',
      'ATTESTATION_ARTIFACT_READY',
      'ATTESTATION_SUBMITTED',
      'ATTESTATION_PAYMENT_RESERVED',
      'ATTESTATION_REVIEW_STARTED',
      'ATTESTATION_APPROVED',
      'ATTESTATION_PAYMENT_SETTLED',
    ]) {
      expect([action, actions.has(action)]).toEqual([action, true]);
    }
    expect(
      await context.adminDb.auditEvent.count({
        where: { action: 'ORGANIZATION_ATTESTATION_COMMISSION_CHANGED' },
      }),
    ).toBe(1);
    const auditText = JSON.stringify(audits);
    expect(auditText).not.toContain(sha256(bytes));
    expect(auditText).not.toContain(token);
  });

  it('releases the whole reservation on rejection: $0 spent, $20 available, no revenue, no record', async () => {
    const requestId = await readyDraft(user.client, university.typeId);
    expectStatus(await submit(user.client, requestId), 200, 'Submit');
    expect(await availableCash(user.client)).toBe(1000n);

    expectStatus(
      await startReview(university.owner.client, university.organizationId, requestId),
      200,
      'Start',
    );
    const rejected = await reject(university.owner.client, university.organizationId, requestId);
    expectStatus(rejected, 200, 'Reject');
    await waitForPayment(context, requestId, 'RELEASED');

    expect(await availableCash(user.client)).toBe(2000n);
    const ledger = await ledgerOf(context, user.userId);
    expect(ledger.filter((entry) => entry.entryType === 'SERVICE_CHARGE')).toHaveLength(0);
    expect(ledger.reduce((sum, entry) => sum + entry.amountMinorSigned, 0n)).toBe(2000n);
    expect(await context.adminDb.attestationSettlement.count()).toBe(0);
    expect(await context.adminDb.attestationRevenueEntry.count()).toBe(0);
    expect(await context.adminDb.attestation.count()).toBe(0);

    const owner = await user.client.get(`${ATTESTATIONS}/${requestId}`);
    expect(owner.body.status).toBe('REJECTED');
    expect(owner.body.rejectionReason).toBe('The certificate number does not match our registry.');
    expect(owner.body.fee.paymentStatus).toBe('RELEASED');
    expect(
      await context.adminDb.auditEvent.count({ where: { action: 'ATTESTATION_PAYMENT_RELEASED' } }),
    ).toBe(1);
    await waitForNotification(user.client, NotificationType.ATTESTATION_REJECTED);
  });

  it('lets the owner cancel before review, releasing exactly once, and refuses once review starts', async () => {
    const first = await readyDraft(user.client, university.typeId);
    expectStatus(await submit(user.client, first), 200, 'Submit');
    const cancelled = await user.client.post(`${ATTESTATIONS}/${first}/cancel`);
    expectStatus(cancelled, 200, 'Cancel');
    expect(cancelled.body.status).toBe('CANCELLED');
    expect(cancelled.body.fee.paymentStatus).toBe('RELEASED');
    expect(await availableCash(user.client)).toBe(2000n);
    // A repeated cancel is a no-op, not a second release.
    expectStatus(await user.client.post(`${ATTESTATIONS}/${first}/cancel`), 200, 'Cancel again');
    expect(
      await context.adminDb.creditHold.count({
        where: { ownerUserId: user.userId, status: 'RELEASED' },
      }),
    ).toBe(1);

    const second = await readyDraft(user.client, university.typeId);
    expectStatus(await submit(user.client, second), 200, 'Submit');
    expectStatus(
      await startReview(university.owner.client, university.organizationId, second),
      200,
      'Start',
    );
    const refused = await user.client.post(`${ATTESTATIONS}/${second}/cancel`);
    expect(refused.status).toBe(409);
    expect(refused.body.error.code).toBe('ATTESTATION_TRANSITION_INVALID');
    expect(await availableCash(user.client)).toBe(1000n);
  });

  it('blocks submission when the balance is short, and reserves nothing', async () => {
    const poor = await createUser(context, 'poor@example.test');
    await fundBalance(context, poor.client, '500');
    const requestId = await readyDraft(poor.client, university.typeId);
    const quote = await poor.client.get(`${ATTESTATIONS}/${requestId}/quote`);
    expect(quote.body.sufficient).toBe(false);
    expect(quote.body.shortfall).toEqual({ currency: 'USD', minorUnits: '500' });

    const refused = await submit(poor.client, requestId);
    expect(refused.status).toBe(402);
    expect(refused.body.error.code).toBe('INSUFFICIENT_BALANCE');
    const after = await poor.client.get(`${ATTESTATIONS}/${requestId}`);
    expect(after.body.status).toBe('DRAFT');
    expect(await context.adminDb.creditHold.count({ where: { ownerUserId: poor.userId } })).toBe(0);
  });

  it('sends the 30/14/7/1-day reminders and the expiry notice once each, on a test clock', async () => {
    const requestId = await readyDraft(user.client, university.typeId);
    expectStatus(await submit(user.client, requestId), 200, 'Submit');
    expectStatus(
      await startReview(university.owner.client, university.organizationId, requestId),
      200,
      'Start',
    );
    expectStatus(
      await approve(university.owner.client, university.organizationId, requestId, {
        validityDays: 60,
      }),
      200,
      'Approve',
    );
    const housekeeping = context.workerApp.get(AttestationHousekeepingService);
    const attestation = await context.adminDb.attestation.findUniqueOrThrow({
      where: { requestId },
    });
    const until = attestation.validUntil!.getTime();

    const stages: number[] = [];
    // Walk the clock from approval to past expiry, sweeping twice at every
    // step: the second sweep must never produce anything.
    for (const daysBefore of [45, 30, 20, 14, 10, 7, 3, 1, 0, -2]) {
      context.clock.set(new Date(until - daysBefore * DAY_MINUTES * 60_000));
      const first = await housekeeping.sendDueReminders();
      const second = await housekeeping.sendDueReminders();
      expect(second).toBe(0);
      if (first > 0) stages.push(daysBefore);
    }
    expect(stages).toEqual([30, 14, 7, 1, 0]);

    const reminders = await context.adminDb.attestationReminder.findMany({
      where: { attestationId: attestation.id },
      orderBy: { stage: 'desc' },
    });
    expect(reminders.map((row) => row.stage)).toEqual([30, 14, 7, 1, 0]);
    const events = await context.adminDb.domainEvent.findMany({
      where: { sourceType: 'ATTESTATION_REMINDER' },
      select: { eventType: true },
    });
    expect(events.filter((row) => row.eventType === 'ATTESTATION_EXPIRING')).toHaveLength(4);
    expect(events.filter((row) => row.eventType === 'ATTESTATION_EXPIRED')).toHaveLength(1);
    expect(
      await context.adminDb.auditEvent.count({ where: { action: 'ATTESTATION_EXPIRED' } }),
    ).toBe(1);

    // Sixty days passed on the test clock, so the old session has expired.
    const fresh = await signIn(context, user.email, PASSWORD);

    // Fan-out is idempotent too: each reminder is one notification.
    await waitForNotification(fresh, NotificationType.ATTESTATION_EXPIRED);
    await context.dispatcher.sweep();
    const types = await notificationTypes(fresh);
    expect(types.filter((type) => type === NotificationType.ATTESTATION_EXPIRING)).toHaveLength(4);
    expect(types.filter((type) => type === NotificationType.ATTESTATION_EXPIRED)).toHaveLength(1);

    // And the verifier sees EXPIRED.
    const owner = await fresh.get(`${ATTESTATIONS}/${requestId}`);
    expect(owner.body.attestation.verificationStatus).toBe('EXPIRED');
    // No money moved in any of this.
    const charges = (await ledgerOf(context, user.userId)).filter(
      (entry) => entry.entryType === 'SERVICE_CHARGE',
    );
    expect(charges).toHaveLength(1);
  });

  it('renews by creating a new request linked to the old attestation, never editing it', async () => {
    const firstId = await readyDraft(user.client, university.typeId);
    expectStatus(await submit(user.client, firstId), 200, 'Submit');
    expectStatus(
      await startReview(university.owner.client, university.organizationId, firstId),
      200,
      'Start',
    );
    const approved = await approve(university.owner.client, university.organizationId, firstId, {
      validityDays: 30,
    });
    const previous = approved.body.attestation;

    const renewalDraft = await user.client.post(ATTESTATIONS, {
      attestationTypeId: university.typeId,
      certificateTitle: 'Bachelor of Science in Computer Engineering',
      previousAttestationId: previous.id,
    });
    expectStatus(renewalDraft, 201, 'Renewal draft');
    expect(renewalDraft.body.previousAttestationId).toBe(previous.id);

    const before = await context.adminDb.attestation.findUniqueOrThrow({
      where: { id: previous.id },
    });
    const renewalId = renewalDraft.body.id as string;
    await uploadArtifact(user.client, renewalId, degreePdf());
    await waitForArtifact(user.client, renewalId);
    expectStatus(await submit(user.client, renewalId), 200, 'Submit renewal');
    expectStatus(
      await startReview(university.owner.client, university.organizationId, renewalId),
      200,
      'Start',
    );
    const renewed = await approve(university.owner.client, university.organizationId, renewalId, {
      validityDays: 365,
    });
    expectStatus(renewed, 200, 'Approve renewal');
    expect(renewed.body.attestation.previousAttestationId).toBe(previous.id);

    const after = await context.adminDb.attestation.findUniqueOrThrow({
      where: { id: previous.id },
    });
    expect(after).toEqual(before);
  });
});
