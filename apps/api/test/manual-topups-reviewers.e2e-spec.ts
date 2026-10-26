import { registerAndVerify, type AuthClient } from './support/auth-client';
import { expectStatus } from './support/checks-client';
import {
  METHODS,
  REVIEW,
  approve,
  availableCash,
  drainNotifications,
  report,
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
 * Payment-method reviewers (ADR-0148): an administrator names the finance
 * staff who review a method's top-ups, and the submission alert goes to
 * them — re-checked against their authority — instead of to all of finance.
 */
describe('Manual top-ups — payment-method reviewers (e2e)', () => {
  let context: TestContext;
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
    admin = await signInPlatformAdmin(context, 'admin@palcert.test');
  });

  /** A PalCert user holding `role` through a GLOBAL grant. Returns their id. */
  async function staff(email: string, role = 'PALCERT_FINANCE'): Promise<string> {
    const user = await registerAndVerify(context, email);
    const found = await context.adminDb.role.findUniqueOrThrow({ where: { code: role } });
    await context.adminDb.$executeRawUnsafe('SET row_security = off');
    await context.adminDb.userRole.create({
      data: { userId: user.userId, roleId: found.id, organizationId: null, scope: 'GLOBAL' },
    });
    return user.userId;
  }

  async function revokeFinance(userId: string): Promise<void> {
    const role = await context.adminDb.role.findUniqueOrThrow({
      where: { code: 'PALCERT_FINANCE' },
    });
    await context.adminDb.$executeRawUnsafe('SET row_security = off');
    await context.adminDb.userRole.deleteMany({ where: { userId, roleId: role.id } });
  }

  async function method(reviewerUserIds: string[], code = 'JAWWAL_PAY'): Promise<string> {
    const created = await admin.post(METHODS, walletMethod({ code, reviewerUserIds }));
    expectStatus(created, 201, 'Create method');
    const enabled = await admin.post(`${METHODS}/${created.body.id}/enable`, {
      expectedVersion: created.body.version,
    });
    expectStatus(enabled, 200, 'Enable method');
    return created.body.id as string;
  }

  /** Who got the submission alert for one request, by user id. */
  async function alerted(requestId: string): Promise<string[]> {
    const events = await context.adminDb.domainEvent.findMany({
      where: { aggregateId: requestId, eventType: 'MANUAL_TOPUP_SUBMITTED' },
      select: { id: true },
    });
    const rows = await context.adminDb.userNotification.findMany({
      where: { sourceEventId: { in: events.map((e) => e.id) } },
      select: { recipientUserId: true },
    });
    return rows.map((row) => row.recipientUserId).sort();
  }

  async function emailDelivery(requestId: string, userId: string) {
    const events = await context.adminDb.domainEvent.findMany({
      where: { aggregateId: requestId, eventType: 'MANUAL_TOPUP_SUBMITTED' },
      select: { id: true },
    });
    const notification = await context.adminDb.userNotification.findFirstOrThrow({
      where: { sourceEventId: { in: events.map((e) => e.id) }, recipientUserId: userId },
    });
    return context.adminDb.notificationDelivery.findUniqueOrThrow({
      where: { notificationId_channel: { notificationId: notification.id, channel: 'EMAIL' } },
    });
  }

  describe('assignment', () => {
    it('lists only active platform finance reviewers as candidates', async () => {
      const financeA = await staff('finance.a@palcert.test');
      await staff('auditor@palcert.test', 'PALCERT_AUDITOR');
      await createUser(context, 'person@example.test');

      const candidates = await admin.get(`${METHODS}/reviewer-candidates`);
      expectStatus(candidates, 200, 'Candidates');
      expect(candidates.body).toEqual([
        {
          userId: financeA,
          displayName: null,
          email: 'finance.a@palcert.test',
          emailVerified: true,
          roles: ['PALCERT_FINANCE'],
        },
      ]);
      // The administrator, the auditor and an ordinary user are not offered.
      const emails = (candidates.body as Array<{ email: string }>).map((c) => c.email);
      expect(emails).not.toContain('admin@palcert.test');
      expect(emails).not.toContain('auditor@palcert.test');
      expect(emails).not.toContain('person@example.test');

      // An ordinary user cannot list staff at all.
      const person = await createUser(context, 'curious@example.test');
      expectStatus(await person.client.get(`${METHODS}/reviewer-candidates`), 403, 'Person');
    });

    it('offers an existing account once it is given the Finance role, and not before', async () => {
      // The operator's own account: an administrator who later also becomes finance.
      const adminId = await idOf('admin@palcert.test');
      const before = await admin.get(`${METHODS}/reviewer-candidates`);
      expect((before.body as Array<{ userId: string }>).map((c) => c.userId)).not.toContain(
        adminId,
      );

      const granted = await admin.post(`/api/v1/admin/users/${adminId}/roles`, {
        roleCode: 'PALCERT_FINANCE',
      });
      expect([200, 201]).toContain(granted.status);
      const after = await admin.get(`${METHODS}/reviewer-candidates`);
      expect(after.body).toContainEqual(
        expect.objectContaining({ userId: adminId, roles: ['PALCERT_FINANCE'] }),
      );
      const methodId = await method([adminId]);
      const view = await admin.get(`${METHODS}/${methodId}`);
      expect(view.body.reviewers).toEqual([
        expect.objectContaining({ userId: adminId, eligible: true }),
      ]);
    });

    it('assigns one or more finance reviewers and shows them on the method', async () => {
      const a = await staff('finance.a@palcert.test');
      const b = await staff('finance.b@palcert.test');
      const methodId = await method([a, b]);

      const view = await admin.get(`${METHODS}/${methodId}`);
      expectStatus(view, 200, 'Method');
      expect(
        (view.body.reviewers as Array<{ email: string; eligible: boolean }>).map((r) => [
          r.email,
          r.eligible,
        ]),
      ).toEqual([
        ['finance.a@palcert.test', true],
        ['finance.b@palcert.test', true],
      ]);
      expect(
        await context.adminDb.auditEvent.count({
          where: { action: 'MANUAL_PAYMENT_METHOD_CREATED', targetId: methodId },
        }),
      ).toBe(1);
    });

    it('refuses a duplicate, a non-reviewer administrator and an unknown address', async () => {
      const a = await staff('finance.a@palcert.test');
      const adminUser = await context.adminDb.user.findFirstOrThrow({
        where: { normalizedEmail: 'admin@palcert.test' },
      });

      const duplicate = await admin.post(METHODS, walletMethod({ reviewerUserIds: [a, a] }));
      expectStatus(duplicate, 422, 'Duplicate');
      expect(duplicate.body.error.code).toBe('MANUAL_PAYMENT_METHOD_INVALID');

      const notFinance = await admin.post(
        METHODS,
        walletMethod({ reviewerUserIds: [adminUser.id] }),
      );
      expectStatus(notFinance, 422, 'Administrator without review permission');
      expect(notFinance.body.error.code).toBe('MANUAL_PAYMENT_METHOD_REVIEWER_INELIGIBLE');

      // A free-text address is not a user id and never reaches the service.
      const email = await admin.post(
        METHODS,
        walletMethod({ reviewerUserIds: ['someone@example.com'] }),
      );
      expectStatus(email, 400, 'Email instead of a user');

      // Nothing was created by any of those.
      expect(await context.adminDb.manualPaymentMethod.count()).toBe(0);
    });

    it('enforces eligibility in the database, whatever the caller', async () => {
      const methodId = await method([await staff('finance.a@palcert.test')]);
      const outsider = await createUser(context, 'outsider@example.test');
      await expect(
        context.adminDb.$executeRawUnsafe(
          `INSERT INTO manual_payment_method_reviewers (payment_method_id, user_id)
           VALUES ('${methodId}', '${outsider.userId}')`,
        ),
      ).rejects.toThrow(/finance:manual-topup:review/);
    });

    it('will not offer, or keep offering, a method nobody reviews', async () => {
      const created = await admin.post(METHODS, walletMethod({ reviewerUserIds: [] }));
      expectStatus(created, 201, 'Create');
      const enable = await admin.post(`${METHODS}/${created.body.id}/enable`, {
        expectedVersion: created.body.version,
      });
      expectStatus(enable, 422, 'Enable without reviewers');
      expect(enable.body.error.code).toBe('MANUAL_PAYMENT_METHOD_REVIEWER_REQUIRED');
      expect(enable.body.error.message).toBe(
        'Assign at least one finance reviewer before offering this payment method to customers.',
      );

      const a = await staff('finance.a@palcert.test');
      const methodId = await method([a], 'PALPAY');
      const current = await admin.get(`${METHODS}/${methodId}`);
      const emptied = await admin.patch(`${METHODS}/${methodId}`, {
        ...walletMethod({ reviewerUserIds: [] }),
        code: undefined,
        expectedVersion: current.body.version,
      });
      expectStatus(emptied, 422, 'Remove the last reviewer of an offered method');
      expect(emptied.body.error.code).toBe('MANUAL_PAYMENT_METHOD_REVIEWER_REQUIRED');
      // The refusal rolled the whole edit back.
      const after = await admin.get(`${METHODS}/${methodId}`);
      expect(after.body.version).toBe(current.body.version);
      expect(after.body.reviewers).toHaveLength(1);
    });
  });

  describe('routing', () => {
    it('alerts the assigned reviewers only, by in-app and email', async () => {
      const a = await staff('finance.a@palcert.test');
      const b = await staff('finance.b@palcert.test');
      const methodId = await method([a]);
      const person = await createUser(context, 'person@example.test');

      const requestId = await report(person.client, methodId, '2500', 'REF-1001');
      await drainNotifications(context);

      expect(await alerted(requestId)).toEqual([a]);
      expect(context.emailProvider.lastTo('finance.a@palcert.test')?.text).toContain(
        'Reference: REF-1001',
      );
      expect(context.emailProvider.lastTo('finance.b@palcert.test')).toBeUndefined();
      expect(b).not.toBe(a);

      const routed = await context.adminDb.auditEvent.findFirstOrThrow({
        where: { action: 'MANUAL_TOPUP_REVIEWERS_RESOLVED', targetId: requestId },
      });
      expect(routed.afterState).toMatchObject({ routing: 'METHOD_REVIEWERS', notified: 1 });
    });

    it('skips an assigned reviewer who lost the permission', async () => {
      const a = await staff('finance.a@palcert.test');
      const c = await staff('finance.c@palcert.test');
      const methodId = await method([a, c]);
      await revokeFinance(a);

      const person = await createUser(context, 'person@example.test');
      const requestId = await report(person.client, methodId, '2500', 'REF-1002');
      await drainNotifications(context);

      expect(await alerted(requestId)).toEqual([c]);
      const view = await admin.get(`${METHODS}/${methodId}`);
      const reviewerA = (view.body.reviewers as Array<{ userId: string; eligible: boolean }>).find(
        (r) => r.userId === a,
      );
      expect(reviewerA?.eligible).toBe(false);
    });

    it('falls back to every finance reviewer when no assignee still qualifies, and records it', async () => {
      const a = await staff('finance.a@palcert.test');
      const b = await staff('finance.b@palcert.test');
      const methodId = await method([a]);
      await revokeFinance(a);

      const person = await createUser(context, 'person@example.test');
      const requestId = await report(person.client, methodId, '2500', 'REF-1003');
      await drainNotifications(context);

      expect(await alerted(requestId)).toEqual([b]);
      const fallback = await context.adminDb.auditEvent.findFirstOrThrow({
        where: { action: 'MANUAL_TOPUP_REVIEWER_FALLBACK', targetId: requestId },
      });
      expect(fallback.actorType).toBe('SYSTEM');
      expect(fallback.afterState).toMatchObject({
        routing: 'FALLBACK_NO_ELIGIBLE',
        assignedReviewers: 1,
        eligibleAssignedReviewers: 0,
        notified: 1,
      });
    });

    it('keeps the global audience for a method offered before assignment existed', async () => {
      const a = await staff('finance.a@palcert.test');
      const b = await staff('finance.b@palcert.test');
      // An existing method: offered, nobody assigned (as every method was before ADR-0148).
      const created = await admin.post(METHODS, walletMethod({ reviewerUserIds: [] }));
      await context.adminDb.$executeRawUnsafe('SET row_security = off');
      await context.adminDb.manualPaymentMethod.update({
        where: { id: created.body.id as string },
        data: { enabled: true, version: { increment: 1 } },
      });

      const person = await createUser(context, 'person@example.test');
      const requestId = await report(person.client, created.body.id as string, '2500', 'REF-1004');
      await drainNotifications(context);

      expect(await alerted(requestId)).toEqual([a, b].sort());
      const routed = await context.adminDb.auditEvent.findFirstOrThrow({
        where: { action: 'MANUAL_TOPUP_REVIEWERS_RESOLVED', targetId: requestId },
      });
      expect(routed.afterState).toMatchObject({ routing: 'GLOBAL_NOT_CONFIGURED', notified: 2 });
    });

    it('records a submission nobody in PalCert could be told about', async () => {
      const created = await admin.post(METHODS, walletMethod({ reviewerUserIds: [] }));
      await context.adminDb.$executeRawUnsafe('SET row_security = off');
      await context.adminDb.manualPaymentMethod.update({
        where: { id: created.body.id as string },
        data: { enabled: true, version: { increment: 1 } },
      });
      const person = await createUser(context, 'person@example.test');
      const requestId = await report(person.client, created.body.id as string, '2500', 'REF-1005');
      await drainNotifications(context);

      expect(await alerted(requestId)).toEqual([]);
      expect(
        await context.adminDb.auditEvent.count({
          where: { action: 'MANUAL_TOPUP_NO_REVIEWER_AVAILABLE', targetId: requestId },
        }),
      ).toBe(1);
      const report_ = await admin.get(`${REVIEW}/${requestId}/notifications`);
      expectStatus(report_, 200, 'Report');
      expect(report_.body).toMatchObject({ noReviewerAvailable: true, recipients: [] });
    });

    it('never treats assignment as authority: a reviewer still needs approve to approve', async () => {
      const finance = await signInGlobalRole(context, 'finance.a@palcert.test', 'PALCERT_FINANCE');
      const a = await idOf('finance.a@palcert.test');
      const methodId = await method([a]);
      const person = await createUser(context, 'person@example.test');
      const requestId = await report(person.client, methodId, '2500', 'REF-1006');

      // The administrator can see the queue but, assigned or not, cannot decide.
      expectStatus(await approve(admin, requestId, '2500'), 403, 'Administrator approve');
      expectStatus(await approve(finance, requestId, '2500'), 200, 'Finance approve');
      expect(await availableCash(person.client)).toBe(2500n);
      expect(
        await context.adminDb.creditLedgerEntry.count({
          where: { entryType: 'MANUAL_TOPUP_CREDIT', referenceId: requestId },
        }),
      ).toBe(1);
      // Approving again changes nothing.
      expectStatus(await approve(finance, requestId, '2500'), 200, 'Same reviewer retry');
      expect(await availableCash(person.client)).toBe(2500n);
    });
  });

  describe('email eligibility and diagnostics', () => {
    it('skips with a reason, keeps the in-app copy, and shows both to an administrator', async () => {
      const verified = await staff('finance.a@palcert.test');
      const unverified = await staff('finance.b@palcert.test');
      const optedOut = await staff('finance.c@palcert.test');
      const methodId = await method([verified, unverified, optedOut]);

      await context.adminDb.$executeRawUnsafe('SET row_security = off');
      await context.adminDb.user.update({
        where: { id: unverified },
        data: { emailVerifiedAt: null },
      });
      await context.adminDb.notificationPreference.create({
        data: {
          userId: optedOut,
          notificationType: 'MANUAL_TOPUP_SUBMITTED',
          emailEnabled: false,
        },
      });

      const person = await createUser(context, 'person@example.test');
      const requestId = await report(person.client, methodId, '2500', 'REF-2001');
      await drainNotifications(context);

      expect((await emailDelivery(requestId, verified)).status).toBe('DELIVERED');
      expect(await emailDelivery(requestId, unverified)).toMatchObject({
        status: 'SKIPPED',
        skipReason: 'NO_VERIFIED_EMAIL',
      });
      expect(await emailDelivery(requestId, optedOut)).toMatchObject({
        status: 'SKIPPED',
        skipReason: 'PREFERENCE_DISABLED',
      });
      // The mail that did go out carries no receipt and no customer address.
      const mail = context.emailProvider.lastTo('finance.a@palcert.test');
      expect(mail?.text).toContain('Submitted: ');
      expect(`${mail?.text} ${mail?.html}`).not.toMatch(/receipt|person@example\.test/i);

      const report_ = await admin.get(`${REVIEW}/${requestId}/notifications`);
      expectStatus(report_, 200, 'Delivery report');
      expect(report_.body.routing).toBe('METHOD_REVIEWERS');
      const byId = new Map(
        (report_.body.recipients as Array<Record<string, unknown>>).map((r) => [r['userId'], r]),
      );
      expect(byId.get(verified)).toMatchObject({
        emailMasked: 'f***@palcert.test',
        inAppStatus: 'DELIVERED',
        emailStatus: 'DELIVERED',
        assigned: true,
      });
      expect(byId.get(unverified)).toMatchObject({
        inAppStatus: 'DELIVERED',
        emailStatus: 'SKIPPED',
        emailSkipReason: 'NO_VERIFIED_EMAIL',
        emailVerified: false,
      });
      expect(byId.get(optedOut)).toMatchObject({ emailSkipReason: 'PREFERENCE_DISABLED' });
      // Masked, never the full address.
      expect(JSON.stringify(report_.body)).not.toContain('finance.a@palcert.test');
    });

    it('records CHANNEL_DISABLED when email is switched off, and AUTHORIZATION_REVOKED at send', async () => {
      const a = await staff('finance.a@palcert.test');
      const c = await staff('finance.c@palcert.test');
      const methodId = await method([a, c]);
      const person = await createUser(context, 'person@example.test');

      context.emailProvider.enabled = false;
      const first = await report(person.client, methodId, '2500', 'REF-3001');
      await drainNotifications(context);
      expect(await emailDelivery(first, a)).toMatchObject({
        status: 'SKIPPED',
        skipReason: 'CHANNEL_DISABLED',
      });
      context.emailProvider.enabled = true;

      // Fan-out happens, then the reviewer loses the permission before the send.
      const second = await report(person.client, methodId, '2500', 'REF-3002');
      const fanout = await context.adminDb.processingJob.findMany({
        where: { jobType: 'NOTIFICATION_FANOUT', status: { in: ['PENDING', 'DISPATCHED'] } },
      });
      for (const job of fanout) await context.worker.processJobId(job.id);
      await revokeFinance(c);
      await drainNotifications(context);
      expect(await emailDelivery(second, c)).toMatchObject({
        status: 'SKIPPED',
        skipReason: 'AUTHORIZATION_REVOKED',
      });
      expect((await emailDelivery(second, a)).status).toBe('DELIVERED');
    });

    it('shows the delivery report to administrators only', async () => {
      const finance = await signInGlobalRole(context, 'finance.a@palcert.test', 'PALCERT_FINANCE');
      const a = await idOf('finance.a@palcert.test');
      const methodId = await method([a]);
      const person = await createUser(context, 'person@example.test');
      const requestId = await report(person.client, methodId, '2500', 'REF-4001');
      await drainNotifications(context);

      expectStatus(await finance.get(`${REVIEW}/${requestId}/notifications`), 403, 'Finance');
      // The staff directory behind the picker is for administrators too.
      expectStatus(await finance.get(`${METHODS}/reviewer-candidates`), 403, 'Finance candidates');
      expectStatus(await person.client.get(`${REVIEW}/${requestId}/notifications`), 403, 'Owner');
      const report_ = await admin.get(`${REVIEW}/${requestId}/notifications`);
      expectStatus(report_, 200, 'Administrator');
      expect(report_.body.assignedReviewers).toEqual([
        expect.objectContaining({ userId: a, eligible: true, notified: true }),
      ]);
    });
  });

  async function idOf(email: string): Promise<string> {
    const user = await context.adminDb.user.findFirstOrThrow({
      where: { normalizedEmail: email },
    });
    return user.id;
  }
});
