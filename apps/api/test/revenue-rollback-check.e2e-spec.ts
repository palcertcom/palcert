import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import * as path from 'node:path';
import { API, type AuthClient } from './support/auth-client';
import { createTenant, createUser, signInPlatformAdmin } from './support/organization-client';
import {
  publishCheckableStandard,
  startCheck,
  waitForCheck,
  type PublishedStandard,
} from './support/checks-client';
import { createDocument, uploadAndProcess } from './support/documents-client';
import { minimalDocx } from './support/fixtures';
import {
  chargesForPurchase,
  ensureCheckPrice,
  grantCredit,
  quoteForCheck,
  reserveForSyntheticCheck,
} from './support/paid-check-client';
import {
  createTestContext,
  destroyTestContext,
  resetState,
  type TestContext,
} from './support/test-app';
import { BalanceService } from '../src/modules/finance/services/balance.service';
import { reauthenticate, userIdOf } from './support/withdrawal-client';

const SCRIPT = path.resolve(
  __dirname,
  '../../../scripts/release/check-service-revenue-rollback.sh',
);

interface Verdict {
  readonly status: number;
  readonly output: string;
}

/** The release gate exactly as an operator runs it, against this database. */
function rollbackCheck(): Verdict {
  try {
    const output = execFileSync('bash', [SCRIPT], {
      encoding: 'utf8',
      env: { ...process.env, DATABASE_ADMIN_URL: process.env.DATABASE_ADMIN_URL },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { status: 0, output };
  } catch (error) {
    const details = error as { status?: number; stdout?: string; stderr?: string };
    return {
      status: details.status ?? 1,
      output: `${details.stdout ?? ''}${details.stderr ?? ''}`,
    };
  }
}

/**
 * Rolling the application back to a release that predates institution revenue
 * is a financial question, not only a schema one: that release does not read
 * service_revenue_entries, while the database triggers keep creating them.
 * A rate of 0% today proves nothing about what earlier rates left behind.
 */
describe('Service revenue rollback gate (e2e)', () => {
  let context: TestContext;
  let admin: AuthClient;
  let student: Awaited<ReturnType<typeof createUser>>;
  let institution: Awaited<ReturnType<typeof createTenant>>;
  let standard: PublishedStandard;
  beforeAll(async () => {
    context = await createTestContext();
  });
  afterAll(async () => {
    await destroyTestContext(context);
  });
  beforeEach(async () => {
    await resetState(context);
    admin = await signInPlatformAdmin(context, 'rollback-admin@example.test');
    student = await createUser(context, 'rollback-student@example.test');
    institution = await createTenant(context, 'Rollback University', 'rollback-owner@example.test');
    standard = await publishCheckableStandard(
      context,
      institution.owner.client,
      institution.organizationId,
    );
  });
  async function setRate(percent: string) {
    await reauthenticate(context, await userIdOf(context, 'rollback-admin@example.test'));
    const response = await admin.put(
      `${API}/admin/organizations/${institution.organizationId}/revenue-shares/DOCUMENT_CHECK`,
      { institutionPercent: percent, reason: 'Rollback gate test' },
    );
    expect(response.status).toBe(200);
  }
  async function deliveredCheck(amount = 1000n) {
    const doc = await createDocument(student.client, 'Thesis');
    const { versionId } = await uploadAndProcess(student.client, doc.id, {
      name: 'thesis.docx',
      bytes: minimalDocx(),
    });
    await ensureCheckPrice(context, amount);
    await grantCredit(context, student.userId, amount);
    const quote = await quoteForCheck(context, student.userId);
    const started = await startCheck(context, student, {
      documentVersionId: versionId,
      standardId: standard.standardId,
      priceQuoteId: quote.id,
    });
    expect(started.status).toBe(202);
    expect((await waitForCheck(context, started.body.id)).status).toBe('COMPLETED');
    return {
      checkId: String(started.body.id),
      purchaseId: String(started.body.billing.purchaseId),
    };
  }

  it('allows the rollback when no institution share was ever recorded, pending or configured', async () => {
    // A delivered check at the default 0%: an entry exists, with nothing for the institution.
    const { purchaseId } = await deliveredCheck();
    expect(
      await context.adminDb.serviceRevenueEntry.findFirstOrThrow({ where: { purchaseId } }),
    ).toMatchObject({ institutionMinor: 0n });
    const verdict = rollbackCheck();
    expect(verdict.output).toContain('COMPATIBLE');
    expect(verdict.status).toBe(0);
  });

  it('refuses while a non-zero rate is in force, and allows it once the rate is 0% with nothing recorded', async () => {
    await setRate('50');
    const refused = rollbackCheck();
    expect(refused.status).toBe(3);
    expect(refused.output).toMatch(/REFUSE DOCUMENT_CHECK: 1 institution/);
    await setRate('0');
    expect(rollbackCheck().status).toBe(0);
  });

  it('still refuses after every rate is back to 0% when shares were recorded, even fully refunded', async () => {
    await setRate('50');
    const { purchaseId } = await deliveredCheck();
    await setRate('0');
    const recorded = rollbackCheck();
    expect(recorded.status).toBe(3);
    expect(recorded.output).toContain('REFUSE USD: 1 entr(y/ies) for 1 institution(s)');
    expect(recorded.output).toContain('institution share captured 500, reversed 0, net 500');
    expect(recorded.output).toContain('ok: every rate in force is 0%');

    const [charge] = await chargesForPurchase(context, purchaseId);
    await context.app
      .get(BalanceService)
      .refundServiceCharge({ ownerUserId: student.userId, ledgerEntryId: charge!.id });
    const refunded = rollbackCheck();
    expect(refunded.status).toBe(3);
    expect(refunded.output).toContain('captured 500, reversed -500, net 0');
  });

  it('refuses while an unsettled purchase holds a non-zero rate snapshot', async () => {
    // The template check is delivered at 0%, so only the pending purchase below can refuse.
    const { checkId: templateId } = await deliveredCheck();
    await setRate('50');
    const template = await context.adminDb.documentCheck.findUniqueOrThrow({
      where: { id: templateId },
    });
    const checkId = randomUUID();
    const servicePurchaseId = await reserveForSyntheticCheck(context, student.userId, checkId);
    await context.adminDb.documentCheck.create({
      data: {
        ...template,
        id: checkId,
        servicePurchaseId,
        idempotencyKey: null,
        currentRunId: null,
        status: 'EVALUATING',
        completedAt: null,
      },
    });
    expect(
      await context.adminDb.serviceRevenueSnapshot.findUniqueOrThrow({
        where: { purchaseId: servicePurchaseId },
      }),
    ).toMatchObject({ institutionBps: 5000 });
    await setRate('0');
    const verdict = rollbackCheck();
    expect(verdict.status).toBe(3);
    expect(verdict.output).toContain(
      'REFUSE 1 purchase(s) RESERVED with a snapshotted rate up to 5000 bps',
    );
    expect(verdict.output).toContain(
      'ok: no entry has ever given an institution a non-zero amount',
    );
  });

  it('refuses while a non-zero rate is scheduled to take effect later', async () => {
    // Written directly: the database clock decides what "later" is, and the
    // API runs on this suite's fixed clock.
    await context.adminDb.organizationServiceShare.create({
      data: {
        organizationId: institution.organizationId,
        productCode: 'DOCUMENT_CHECK',
        institutionBps: 2500,
        effectiveFrom: new Date(Date.now() + 30 * 86_400_000),
        changedByUserId: await userIdOf(context, 'rollback-admin@example.test'),
        changeReason: 'Scheduled agreement',
      },
    });
    const verdict = rollbackCheck();
    expect(verdict.status).toBe(3);
    expect(verdict.output).toContain('REFUSE 1 scheduled non-zero rate(s)');
    expect(verdict.output).toContain('ok: every rate in force is 0%');
  });
});
