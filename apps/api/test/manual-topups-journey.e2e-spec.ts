import { API, type AuthClient } from './support/auth-client';
import { executableBytes, pngBytes } from './support/attestation-client';
import { expectStatus } from './support/checks-client';
import {
  CATALOGUE,
  METHODS,
  OWN,
  REVIEW,
  approve,
  availableCash,
  bankMethod,
  draft,
  drainNotifications,
  enabledMethod,
  reject,
  report,
  uploadReceipt,
  waitForReceipt,
  walletMethod,
} from './support/manual-topup-client';
import { createUser, signInGlobalRole, signInPlatformAdmin } from './support/organization-client';
import {
  createTestContext,
  destroyTestContext,
  resetState,
  type TestContext,
} from './support/test-app';

/**
 * Manual top-ups, end to end: an administrator publishes where to pay, a
 * person reports a transfer, PalCert finance verifies it, and the balance
 * moves exactly once — or not at all.
 */
describe('Manual top-ups — journey (e2e)', () => {
  let context: TestContext;
  let admin: AuthClient;
  let finance: AuthClient;

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
    admin = await signInPlatformAdmin(context, 'admin@palcert.test');
    finance = await signInGlobalRole(context, 'finance@palcert.test', 'PALCERT_FINANCE');
  });

  it('credits exactly the reported amount once, after finance approves', async () => {
    const methodId = await enabledMethod(admin);

    const person = await createUser(context, 'person@example.test');
    const catalogue = await person.client.get(CATALOGUE);
    expectStatus(catalogue, 200, 'Catalogue');
    expect(catalogue.body).toHaveLength(1);
    expect(catalogue.body[0]).toMatchObject({
      code: 'JAWWAL_PAY',
      mobileNumber: '+970599000000',
      recipientName: 'PalCert Ltd',
      minAmount: { currency: 'USD', minorUnits: '500' },
    });

    // Draft, fill in, attach a receipt, submit.
    const created = await draft(person.client, methodId);
    expectStatus(created, 201, 'Draft');
    expect(created.body.status).toBe('DRAFT');
    expect(created.body.paymentMethod).toMatchObject({ code: 'JAWWAL_PAY', currency: 'USD' });
    const requestId = created.body.id as string;

    const filled = await person.client.patch(`${OWN}/${requestId}`, {
      amountMinorUnits: '15000',
      reference: 'tx-2026-0001',
      customerNote: 'Sent from my own wallet.',
    });
    expectStatus(filled, 200, 'Fill in');

    await uploadReceipt(person.client, requestId, pngBytes(8, 8));
    expect((await waitForReceipt(person.client, requestId))['status']).toBe('READY');

    const submitted = await person.client.post(`${OWN}/${requestId}/submit`);
    expectStatus(submitted, 200, 'Submit');
    expect(submitted.body).toMatchObject({ status: 'PENDING_REVIEW', cancellable: true });
    // Nothing is credited by reporting.
    expect(await availableCash(person.client)).toBe(0n);

    // Finance sees it, with its total per currency.
    const queue = await finance.get(`${REVIEW}?status=PENDING_REVIEW`);
    expectStatus(queue, 200, 'Queue');
    expect(queue.body.items).toHaveLength(1);
    expect(queue.body.items[0]).toMatchObject({
      id: requestId,
      reference: 'tx-2026-0001',
      ownerEmail: 'person@example.test',
      hasReceipt: true,
    });
    expect(queue.body.pendingTotals).toEqual([
      { currency: 'USD', count: 1, total: { currency: 'USD', minorUnits: '15000' } },
    ]);

    // The receipt opens for finance, and the viewing is on record.
    const receipt = await finance.get(`${REVIEW}/${requestId}/receipt`);
    expectStatus(receipt, 200, 'Receipt');
    expect(receipt.body.url).toMatch(/^https?:\/\//);
    expect(
      await context.adminDb.auditEvent.count({ where: { action: 'MANUAL_TOPUP_RECEIPT_VIEWED' } }),
    ).toBe(1);

    // Once review starts, the person can no longer cancel.
    expectStatus(await finance.post(`${REVIEW}/${requestId}/start-review`), 200, 'Start review');
    const cancel = await person.client.post(`${OWN}/${requestId}/cancel`);
    expectStatus(cancel, 409, 'Cancel after review');
    expect(cancel.body.error.code).toBe('MANUAL_TOPUP_TRANSITION_INVALID');

    const approved = await approve(finance, requestId);
    expectStatus(approved, 200, 'Approve');
    expect(approved.body.status).toBe('APPROVED');
    expect(approved.body.creditEntryId).toEqual(expect.any(String));

    // Exactly one CASH credit, of exactly the reported amount.
    const entries = await context.adminDb.creditLedgerEntry.findMany({
      where: { ownerUserId: person.userId },
    });
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      entryType: 'MANUAL_TOPUP_CREDIT',
      creditClass: 'CASH',
      amountMinorSigned: 15000n,
      referenceType: 'MANUAL_TOPUP_REQUEST',
      referenceId: requestId,
      reasonCode: 'MANUAL_TOPUP_APPROVED',
      idempotencyKey: `manual-topup:${requestId}:credit`,
    });
    expect(await availableCash(person.client)).toBe(15000n);

    // A retried approval by the same reviewer is the same approval.
    expectStatus(await approve(finance, requestId), 200, 'Retry approve');
    expect(await context.adminDb.creditLedgerEntry.count()).toBe(1);

    // The person's history and the reconciliation both agree.
    const own = await person.client.get(`${OWN}/${requestId}`);
    expect((own.body.events as Array<{ eventType: string }>).map((e) => e.eventType)).toEqual([
      'CREATED',
      'UPDATED',
      'RECEIPT_ATTACHED',
      'SUBMITTED',
      'REVIEW_STARTED',
      'APPROVED',
    ]);
    expect(JSON.stringify(own.body)).not.toContain('creditEntryId');
    const verified = await finance.get(`${API}/admin/finance/verify-ledger`);
    expectStatus(verified, 200, 'Verify ledger');
    expect(verified.body).toMatchObject({ consistent: true, findings: [] });
  });

  it('tells finance about a submission and the person about the decision, by in-app and email', async () => {
    const methodId = await enabledMethod(admin);
    const person = await createUser(context, 'person@example.test', 'ar');
    const requestId = await report(person.client, methodId, '2500', 'REF-77001');
    await drainNotifications(context);

    // Finance's alert: platform-scoped, so no organization, and a link to the queue.
    const alert = await context.adminDb.userNotification.findFirstOrThrow({
      where: { notificationType: 'MANUAL_TOPUP_SUBMITTED' },
    });
    expect(alert.organizationId).toBeNull();
    expect(alert.deepLink).toBe(`/en/admin/top-ups/${requestId}`);
    const event = await context.adminDb.domainEvent.findUniqueOrThrow({
      where: { id: alert.sourceEventId },
    });
    expect(event).toMatchObject({ organizationId: null, webhookEligible: false });
    expect(event.payload).toEqual({ manualTopUpRequestId: requestId });
    // The platform administrator does not hold the review permission, so is not told.
    const recipients = await context.adminDb.userNotification.findMany({
      where: { notificationType: 'MANUAL_TOPUP_SUBMITTED' },
      select: { recipientUserId: true },
    });
    expect(recipients).toHaveLength(1);
    const financeMail = context.emailProvider.lastTo('finance@palcert.test');
    expect(financeMail?.subject).toBe('A manual top-up is waiting for verification');
    expect(financeMail?.text).toContain('Amount: 25.00 USD');
    expect(financeMail?.text).toContain('Reference: REF-77001');
    // Never the customer's address, and never a receipt or a destination.
    expect(financeMail?.text).not.toContain('person@example.test');
    expect(financeMail?.text).not.toContain('+970599000000');

    expectStatus(await approve(finance, requestId, '2500'), 200, 'Approve');
    await drainNotifications(context);
    const personMail = context.emailProvider.lastTo('person@example.test');
    expect(personMail?.subject).toBe('تمت الموافقة على شحن رصيدك');
    expect(personMail?.text).toContain('المبلغ: 25.00 USD');
    expect(personMail?.html).toContain('dir="rtl"');
    const inbox = await person.client.get(`${API}/notifications`);
    expectStatus(inbox, 200, 'Inbox');
    expect(JSON.stringify(inbox.body)).toContain(`/ar/balance/top-ups/${requestId}`);
  });

  it('rejects with a reason, moves no money, and says why', async () => {
    const methodId = await enabledMethod(admin);
    const person = await createUser(context, 'person@example.test');
    const requestId = await report(person.client, methodId, '15000', 'NOPE1234');

    const missingNote = await reject(finance, requestId, 'OTHER');
    expectStatus(missingNote, 400, 'OTHER without a note');

    const rejected = await reject(
      finance,
      requestId,
      'PAYMENT_NOT_RECEIVED',
      'Nothing arrived by noon.',
    );
    expectStatus(rejected, 200, 'Reject');
    expect(rejected.body).toMatchObject({
      status: 'REJECTED',
      rejectionReason: 'PAYMENT_NOT_RECEIVED',
      rejectionNote: 'Nothing arrived by noon.',
      creditEntryId: null,
    });
    expect(await context.adminDb.creditLedgerEntry.count()).toBe(0);

    // A decided request stays decided.
    const late = await approve(finance, requestId);
    expectStatus(late, 409, 'Approve after reject');
    expect(late.body.error.code).toBe('MANUAL_TOPUP_ALREADY_DECIDED');

    await drainNotifications(context);
    const mail = context.emailProvider.lastTo('person@example.test');
    expect(mail?.subject).toBe('Your top-up could not be verified');
    expect(mail?.text).toContain('Reason: The payment has not arrived on the receiving account.');
    // The free-text note is for the page, not the email.
    expect(mail?.text).not.toContain('Nothing arrived by noon.');
  });

  it('refuses a reference already pending or credited, with one generic answer', async () => {
    const methodId = await enabledMethod(admin);
    const bankId = await enabledMethod(admin, bankMethod());
    const first = await createUser(context, 'first@example.test');
    const second = await createUser(context, 'second@example.test');

    const original = await report(first.client, methodId, '15000', 'AB-1234-CD');

    // The same reference, typed differently, by somebody else: refused.
    const copy = await draft(second.client, methodId, {
      amountMinorUnits: '15000',
      reference: 'ab 1234 cd',
    });
    const refused = await second.client.post(`${OWN}/${copy.body.id}/submit`);
    expectStatus(refused, 409, 'Duplicate reference');
    expect(refused.body.error.code).toBe('MANUAL_TOPUP_REFERENCE_UNAVAILABLE');
    // The answer says nothing about whose it is or what state it is in.
    expect(JSON.stringify(refused.body)).not.toContain(original);
    expect(JSON.stringify(refused.body)).not.toContain('first@example.test');
    expect(JSON.stringify(refused.body)).not.toMatch(/PENDING|APPROVED/);
    // The draft survives, so nothing typed is lost.
    expect((await second.client.get(`${OWN}/${copy.body.id}`)).body.status).toBe('DRAFT');

    // A different method may carry the same string: two banks, two namespaces.
    await report(second.client, bankId, '15000', 'AB1234CD');

    // Once finance rejects the original, the corrected report may be made again.
    expectStatus(await reject(finance, original, 'AMOUNT_MISMATCH'), 200, 'Reject original');
    expectStatus(await second.client.post(`${OWN}/${copy.body.id}/submit`), 200, 'Resubmit');
  });

  it('keeps the destination a person paid to, even after the method is edited', async () => {
    const methodId = await enabledMethod(admin);
    const person = await createUser(context, 'person@example.test');
    const requestId = await report(person.client, methodId);

    const current = await admin.get(`${METHODS}/${methodId}`);
    const edited = await admin.patch(`${METHODS}/${methodId}`, {
      ...walletMethod(),
      code: undefined,
      mobileNumber: '+970 56-111 2222',
      expectedVersion: current.body.version,
    });
    expectStatus(edited, 200, 'Edit');
    expect(edited.body.mobileNumber).toBe('+970561112222');

    const detail = await finance.get(`${REVIEW}/${requestId}`);
    expect(detail.body.paymentMethod.mobileNumber).toBe('+970599000000');

    // A stale edit is refused rather than silently overwriting.
    const stale = await admin.patch(`${METHODS}/${methodId}`, {
      ...walletMethod(),
      code: undefined,
      expectedVersion: current.body.version,
    });
    expectStatus(stale, 412, 'Stale edit');
  });

  it('keeps the draft when its method is switched off, and hides the method', async () => {
    const methodId = await enabledMethod(admin);
    const person = await createUser(context, 'person@example.test');
    const created = await draft(person.client, methodId, {
      amountMinorUnits: '15000',
      reference: 'KEEPME01',
    });

    const current = await admin.get(`${METHODS}/${methodId}`);
    expectStatus(
      await admin.post(`${METHODS}/${methodId}/disable`, { expectedVersion: current.body.version }),
      200,
      'Disable',
    );
    expect((await person.client.get(CATALOGUE)).body).toEqual([]);

    const submit = await person.client.post(`${OWN}/${created.body.id}/submit`);
    expectStatus(submit, 409, 'Submit to a disabled method');
    expect(submit.body.error.code).toBe('MANUAL_PAYMENT_METHOD_UNAVAILABLE');
    const kept = await person.client.get(`${OWN}/${created.body.id}`);
    expect(kept.body).toMatchObject({ status: 'DRAFT', reference: 'KEEPME01' });
  });

  it('lets a person cancel before review, and enforces the method’s limits', async () => {
    const methodId = await enabledMethod(admin);
    const person = await createUser(context, 'person@example.test');

    const tooSmall = await draft(person.client, methodId, { amountMinorUnits: '100' });
    expectStatus(tooSmall, 422, 'Below minimum');
    expect(tooSmall.body.error.code).toBe('MANUAL_TOPUP_AMOUNT_OUT_OF_RANGE');

    const incomplete = await draft(person.client, methodId);
    const early = await person.client.post(`${OWN}/${incomplete.body.id}/submit`);
    expectStatus(early, 422, 'Submit without amount');
    expect(early.body.error.code).toBe('MANUAL_TOPUP_INVALID');

    const requestId = await report(person.client, methodId);
    const cancelled = await person.client.post(`${OWN}/${requestId}/cancel`);
    expectStatus(cancelled, 200, 'Cancel');
    expect(cancelled.body.status).toBe('CANCELLED');
    const decide = await approve(finance, requestId);
    expectStatus(decide, 409, 'Approve a cancelled request');
  });

  it('accepts only scanned receipts of an allowed type', async () => {
    const methodId = await enabledMethod(admin);
    const person = await createUser(context, 'person@example.test');
    const created = await draft(person.client, methodId, {
      amountMinorUnits: '15000',
      reference: 'RECEIPT01',
    });

    const svg = await person.client.post(`${OWN}/${created.body.id}/receipt`, {
      originalFilename: 'receipt.svg',
      sizeBytes: 100,
    });
    expectStatus(svg, 422, 'SVG receipt');
    expect(svg.body.error.code).toBe('MANUAL_TOPUP_FILE_TYPE_NOT_ALLOWED');

    const large = await person.client.post(`${OWN}/${created.body.id}/receipt`, {
      originalFilename: 'receipt.pdf',
      sizeBytes: 5 * 1024 * 1024 + 1,
    });
    expectStatus(large, 400, 'Oversized receipt');

    // An executable renamed .png is judged by its bytes.
    await uploadReceipt(person.client, created.body.id as string, executableBytes(), 'receipt.png');
    expect((await waitForReceipt(person.client, created.body.id as string))['status']).toBe(
      'REJECTED',
    );
    const submit = await person.client.post(`${OWN}/${created.body.id}/submit`);
    expectStatus(submit, 409, 'Submit with a rejected receipt');
    expect(submit.body.error.code).toBe('MANUAL_TOPUP_FILE_NOT_READY');

    // Removing it lets the report go ahead without one.
    expectStatus(
      await person.client.patch(`${OWN}/${created.body.id}`, { removeReceipt: true }),
      200,
      'Remove receipt',
    );
    expectStatus(await person.client.post(`${OWN}/${created.body.id}/submit`), 200, 'Submit');
  });

  it('shows a method’s logo only after it has been scanned, and never an SVG', async () => {
    const methodId = await enabledMethod(admin);

    const svg = await admin.post(`${METHODS}/${methodId}/logo`, {
      originalFilename: 'logo.svg',
      sizeBytes: 200,
    });
    expectStatus(svg, 422, 'SVG logo');
    expect(svg.body.error.code).toBe('MANUAL_TOPUP_FILE_TYPE_NOT_ALLOWED');

    const bytes = pngBytes(16, 16);
    const created = await admin.post(`${METHODS}/${methodId}/logo`, {
      originalFilename: 'jawwal.png',
      sizeBytes: bytes.length,
    });
    expectStatus(created, 201, 'Logo creation');
    const put = await fetch(created.body.upload.url as string, {
      method: 'PUT',
      headers: created.body.upload.headers as Record<string, string>,
      body: new Uint8Array(bytes),
    });
    expect(put.status).toBe(200);
    const finalized = await admin.post(
      `${METHODS}/${methodId}/logo/${created.body.logo.id}/finalize`,
    );
    expectStatus(finalized, 200, 'Logo finalize');

    const deadline = Date.now() + 20_000;
    let logo: Record<string, unknown> | null = null;
    while (Date.now() < deadline) {
      logo = (await admin.get(`${METHODS}/${methodId}`)).body.logo as Record<string, unknown>;
      if (logo !== null && ['READY', 'REJECTED', 'FAILED'].includes(String(logo['status']))) break;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    expect(logo).toMatchObject({ status: 'READY', format: 'PNG' });

    const person = await createUser(context, 'person@example.test');
    const catalogue = await person.client.get(CATALOGUE);
    expect(catalogue.body[0].logoUrl).toMatch(/^https?:\/\//);
  });
});
