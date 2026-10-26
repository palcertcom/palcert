import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@palcert/database';
import { API, type AuthClient } from './support/auth-client';
import { expectStatus } from './support/checks-client';
import {
  METHODS,
  OWN,
  REVIEW,
  approve,
  draft,
  enabledMethod,
  reject,
  report,
  walletMethod,
} from './support/manual-topup-client';
import {
  createTenant,
  createUser,
  signInGlobalRole,
  signInPlatformAdmin,
} from './support/organization-client';
import {
  createTestContext,
  destroyTestContext,
  resetState,
  type TestContext,
} from './support/test-app';

/**
 * Who may do what with a manual top-up, what the database refuses whoever
 * asks, and what happens when two reviewers decide at once.
 */
describe('Manual top-ups — security (e2e)', () => {
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

  describe('governance', () => {
    it('lets a platform administrator configure methods and read the queue, never decide', async () => {
      const methodId = await enabledMethod(admin);
      const person = await createUser(context, 'person@example.test');
      const requestId = await report(person.client, methodId);

      expectStatus(await admin.get(REVIEW), 200, 'Admin reads the queue');
      expectStatus(await admin.get(`${REVIEW}/${requestId}`), 200, 'Admin reads a request');
      expectStatus(await admin.post(`${REVIEW}/${requestId}/start-review`), 403, 'Admin start');
      expectStatus(await approve(admin, requestId), 403, 'Admin approve');
      expectStatus(await reject(admin, requestId), 403, 'Admin reject');
      expect(await context.adminDb.creditLedgerEntry.count()).toBe(0);
    });

    it('lets finance decide but not reconfigure where people pay', async () => {
      expectStatus(await finance.get(METHODS), 200, 'Finance reads methods');
      expectStatus(await finance.post(METHODS, walletMethod()), 403, 'Finance creates a method');
    });

    it('keeps the auditor read-only and support out entirely', async () => {
      const methodId = await enabledMethod(admin);
      const person = await createUser(context, 'person@example.test');
      const requestId = await report(person.client, methodId);

      const auditor = await signInGlobalRole(context, 'auditor@palcert.test', 'PALCERT_AUDITOR');
      expectStatus(await auditor.get(REVIEW), 200, 'Auditor queue');
      expectStatus(await auditor.get(METHODS), 200, 'Auditor methods');
      expectStatus(await approve(auditor, requestId), 403, 'Auditor approve');
      expectStatus(await auditor.post(METHODS, walletMethod()), 403, 'Auditor create');

      const support = await signInGlobalRole(context, 'support@palcert.test', 'PALCERT_SUPPORT');
      expectStatus(await support.get(REVIEW), 403, 'Support queue');
      expectStatus(await support.get(METHODS), 403, 'Support methods');
    });

    it('gives an ordinary person and an organization owner no administrative reach', async () => {
      const methodId = await enabledMethod(admin);
      const person = await createUser(context, 'person@example.test');
      const requestId = await report(person.client, methodId);

      const tenant = await createTenant(context, 'Test University', 'owner@university.test');
      for (const client of [person.client, tenant.owner.client]) {
        expectStatus(await client.get(REVIEW), 403, 'Queue');
        expectStatus(await client.get(`${REVIEW}/${requestId}`), 403, 'Request');
        expectStatus(await client.get(METHODS), 403, 'Methods');
        expectStatus(await approve(client, requestId), 403, 'Approve');
      }
      // And the organization owner cannot read the member's request either.
      expectStatus(await tenant.owner.client.get(`${OWN}/${requestId}`), 404, 'Org owner read');
    });

    it('refuses to let anybody decide a top-up they reported themselves', async () => {
      const methodId = await enabledMethod(admin);
      const own = await report(finance, methodId);
      const response = await approve(finance, own);
      expectStatus(response, 403, 'Self-approval');
      expect(await context.adminDb.creditLedgerEntry.count()).toBe(0);
    });

    it('demands the exact amount as confirmation and never lets a reviewer change it', async () => {
      const methodId = await enabledMethod(admin);
      const person = await createUser(context, 'person@example.test');
      const requestId = await report(person.client, methodId, '15000');

      const wrong = await approve(finance, requestId, '20000');
      expectStatus(wrong, 422, 'Different amount');
      expect(wrong.body.error.code).toBe('MANUAL_TOPUP_CONFIRMATION_REQUIRED');
      const currency = await approve(finance, requestId, '15000', 'EUR');
      expectStatus(currency, 422, 'Different currency');
      expect(await context.adminDb.creditLedgerEntry.count()).toBe(0);
    });
  });

  describe('isolation', () => {
    it('hides one person’s request and receipt from another', async () => {
      const methodId = await enabledMethod(admin);
      const owner = await createUser(context, 'owner@example.test');
      const other = await createUser(context, 'other@example.test');
      const requestId = await report(owner.client, methodId);

      expectStatus(await other.client.get(`${OWN}/${requestId}`), 404, 'Read');
      expectStatus(
        await other.client.patch(`${OWN}/${requestId}`, { customerNote: 'x' }),
        404,
        'Edit',
      );
      expectStatus(await other.client.post(`${OWN}/${requestId}/cancel`), 404, 'Cancel');
      expectStatus(await other.client.get(`${OWN}/${requestId}/receipt/download`), 404, 'Receipt');
      expect((await other.client.get(OWN)).body.items).toEqual([]);
    });

    it('keeps drafts out of the finance queue', async () => {
      const methodId = await enabledMethod(admin);
      const person = await createUser(context, 'person@example.test');
      const created = await draft(person.client, methodId);
      expect((await finance.get(REVIEW)).body.items).toEqual([]);
      expectStatus(await finance.get(`${REVIEW}/${created.body.id}`), 404, 'Draft detail');
    });

    it('requires a recent sign-in to approve', async () => {
      const methodId = await enabledMethod(admin);
      const person = await createUser(context, 'person@example.test');
      const requestId = await report(person.client, methodId);
      // Past the re-authentication window, while staying active so the
      // (shorter, privileged) idle timeout never ends the session itself.
      for (let step = 0; step < 4; step += 1) {
        context.clock.advanceMinutes(10);
        expectStatus(await finance.get(REVIEW), 200, 'Stay active');
      }
      const stale = await approve(finance, requestId);
      expectStatus(stale, 401, 'Stale authentication');
      expect(stale.body.error.code).toBe('REAUTHENTICATION_REQUIRED');
      expect(await context.adminDb.creditLedgerEntry.count()).toBe(0);
    });
  });

  describe('races', () => {
    it('gives two simultaneous decisions exactly one winner and one credit', async () => {
      const methodId = await enabledMethod(admin);
      const second = await signInGlobalRole(context, 'finance2@palcert.test', 'PALCERT_FINANCE');
      const person = await createUser(context, 'person@example.test');

      for (let round = 0; round < 5; round += 1) {
        const requestId = await report(person.client, methodId, '1000', `RACE${round}ABCD`);
        const results = await Promise.all([
          approve(finance, requestId, '1000'),
          approve(second, requestId, '1000'),
          reject(second, requestId, 'AMOUNT_MISMATCH'),
        ]);
        const winners = results.filter((response) => response.status === 200);
        const losers = results.filter((response) => response.status === 409);
        expect([round, winners.length, losers.length]).toEqual([round, 1, 2]);
        for (const loser of losers) {
          expect(loser.body.error.code).toBe('MANUAL_TOPUP_ALREADY_DECIDED');
        }
        const credits = await context.adminDb.creditLedgerEntry.count({
          where: { referenceId: requestId },
        });
        const status = (await finance.get(`${REVIEW}/${requestId}`)).body.status as string;
        expect([round, status, credits]).toEqual([round, status, status === 'APPROVED' ? 1 : 0]);
      }
    });

    it('lets only one of two simultaneous reports of the same transfer through', async () => {
      const methodId = await enabledMethod(admin);
      const a = await createUser(context, 'a@example.test');
      const b = await createUser(context, 'b@example.test');
      const first = await draft(a.client, methodId, {
        amountMinorUnits: '1000',
        reference: 'SAMEREF1',
      });
      const second = await draft(b.client, methodId, {
        amountMinorUnits: '1000',
        reference: 'SAMEREF1',
      });
      const results = await Promise.all([
        a.client.post(`${OWN}/${first.body.id}/submit`),
        b.client.post(`${OWN}/${second.body.id}/submit`),
      ]);
      expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
    });
  });

  describe('what the database refuses, whoever asks', () => {
    let app: PrismaClient;

    beforeAll(() => {
      app = new PrismaClient({ datasources: { db: { url: process.env.DATABASE_URL! } } });
    });
    afterAll(async () => {
      await app.$disconnect();
    });

    async function asUser<T>(userId: string, work: (tx: PrismaClient) => Promise<T>): Promise<T> {
      return app.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT set_config('palcert.current_user_id', ${userId}, true)`;
        await tx.$executeRaw`SELECT set_config('palcert.current_organization_id', '', true)`;
        await tx.$executeRaw`SELECT set_config('palcert.platform_admin', 'off', true)`;
        return work(tx as unknown as PrismaClient);
      });
    }

    it('will not let an owner approve their own request, even by writing the row', async () => {
      const methodId = await enabledMethod(admin);
      const person = await createUser(context, 'person@example.test');
      const requestId = await report(person.client, methodId);

      await expect(
        asUser(
          person.userId,
          (tx) =>
            tx.$executeRaw`UPDATE "manual_topup_requests" SET "status" = 'APPROVED' WHERE "id" = ${requestId}::uuid`,
        ),
      ).rejects.toThrow();
      await expect(
        asUser(
          person.userId,
          (tx) =>
            tx.$executeRaw`UPDATE "manual_topup_requests" SET "amount_minor" = 999999 WHERE "id" = ${requestId}::uuid`,
        ),
      ).rejects.toThrow(/frozen/);
      await expect(
        asUser(
          person.userId,
          (tx) =>
            tx.$executeRaw`DELETE FROM "manual_topup_requests" WHERE "id" = ${requestId}::uuid`,
        ),
      ).rejects.toThrow();
    });

    it('allows only one manual credit per request, and only a matching one', async () => {
      const methodId = await enabledMethod(admin);
      const person = await createUser(context, 'person@example.test');
      const requestId = await report(person.client, methodId, '1000');
      expectStatus(await approve(finance, requestId, '1000'), 200, 'Approve');
      const entry = await context.adminDb.creditLedgerEntry.findFirstOrThrow({
        where: { referenceId: requestId },
      });

      await expect(
        context.adminDb.creditLedgerEntry.create({
          data: {
            ownerUserId: person.userId,
            accountId: entry.accountId,
            currency: 'USD',
            creditClass: 'CASH',
            entryType: 'MANUAL_TOPUP_CREDIT',
            amountMinorSigned: 1000n,
            referenceType: 'MANUAL_TOPUP_REQUEST',
            referenceId: requestId,
            reasonCode: 'MANUAL_TOPUP_APPROVED',
            createdByUserId: person.userId,
          },
        }),
      ).rejects.toThrow();

      // A manual credit that is not cash, or not tied to a request, is not expressible.
      await expect(
        context.adminDb.creditLedgerEntry.create({
          data: {
            ownerUserId: person.userId,
            accountId: entry.accountId,
            currency: 'USD',
            creditClass: 'CASH',
            entryType: 'MANUAL_TOPUP_CREDIT',
            amountMinorSigned: 1000n,
            createdByUserId: person.userId,
          },
        }),
      ).rejects.toThrow(/ledger_entries_manual_topup_shape/);
    });

    it('confines a NULL organization to the manual top-up notification types', async () => {
      const person = await createUser(context, 'person@example.test');
      await expect(
        context.adminDb.$executeRaw`
          INSERT INTO "domain_events" ("id", "event_type", "event_schema_version", "source_type",
            "source_id", "aggregate_type", "aggregate_id", "owner_user_id", "organization_id",
            "occurred_at", "payload", "webhook_eligible")
          VALUES (${randomUUID()}::uuid, 'SUBMISSION_APPROVED', 1, 'SUBMISSION_DECISION_EVENT',
            ${randomUUID()}::uuid, 'OFFICIAL_SUBMISSION', ${randomUUID()}::uuid,
            ${person.userId}::uuid, NULL, now(), '{}'::jsonb, false)`,
      ).rejects.toThrow(/domain_events_organization_scope/);
    });

    it('never hard-deletes a payment method, even one nobody used', async () => {
      const methodId = await enabledMethod(admin);
      await expect(
        app.$transaction(async (tx) => {
          await tx.$executeRaw`SELECT set_config('palcert.platform_admin', 'on', true)`;
          return tx.$executeRaw`DELETE FROM "manual_payment_methods" WHERE "id" = ${methodId}::uuid`;
        }),
      ).rejects.toThrow(/permission denied/);
    });
  });

  it('archives a method for good and keeps it out of the catalogue', async () => {
    const methodId = await enabledMethod(admin);
    const current = await admin.get(`${METHODS}/${methodId}`);
    const archived = await admin.post(`${METHODS}/${methodId}/archive`, {
      expectedVersion: current.body.version,
    });
    expectStatus(archived, 200, 'Archive');
    expect(archived.body).toMatchObject({ enabled: false, archivedAt: expect.any(String) });
    const enable = await admin.post(`${METHODS}/${methodId}/enable`, {
      expectedVersion: archived.body.version,
    });
    expectStatus(enable, 422, 'Enable archived');
    const person = await createUser(context, 'person@example.test');
    expect((await person.client.get(`${API}/balance/manual-payment-methods`)).body).toEqual([]);
  });
});
