import { randomUUID } from 'node:crypto';
import type request from 'supertest';
import { CreditClass, LedgerEntryType, LedgerReasonCode } from '@palcert/contracts';
import { API } from './auth-client';
import type { AuthClient } from './auth-client';
import type { TestContext } from './test-app';
import { TenantPrismaService } from '../../src/infrastructure/tenant/tenant-prisma.service';
import { CreditLedgerService } from '../../src/modules/finance/services/credit-ledger.service';
import { PricingService } from '../../src/modules/finance/services/pricing.service';
import { ServicePurchaseService } from '../../src/modules/finance/services/service-purchase.service';

/** What a DOCUMENT_CHECK costs in these tests unless a test says otherwise: $3. */
export const CHECK_PRICE_MINOR = 300n;

/**
 * Put a DOCUMENT_CHECK price into force (§32, §33).
 *
 * Written straight through the admin client rather than the HTTP surface,
 * because pricing is not what these tests are about — they are about what
 * happens once a price exists. Idempotent, so a test that funds twice does not
 * trip the one-active-price index.
 */
export async function ensureCheckPrice(
  context: TestContext,
  amountMinor: bigint = CHECK_PRICE_MINOR,
  currency = 'USD',
): Promise<string> {
  const existing = await context.adminDb.priceVersion.findFirst({
    where: { productCode: 'DOCUMENT_CHECK', currency, marketCode: 'GLOBAL', status: 'ACTIVE' },
  });
  if (existing !== null) {
    if (existing.amountMinor === amountMinor) return existing.id;
    // An active price is immutable, so changing it means retiring it and
    // activating a successor — exactly what production does (§15).
    await context.adminDb.priceVersion.update({
      where: { id: existing.id },
      data: { status: 'RETIRED', retiredAt: new Date() },
    });
  }

  const created = await context.adminDb.priceVersion.create({
    data: {
      productCode: 'DOCUMENT_CHECK',
      currency,
      marketCode: 'GLOBAL',
      amountMinor,
      status: 'ACTIVE',
      activatedAt: new Date(),
    },
  });
  return created.id;
}

/**
 * Give a customer spendable credit without going near the payment provider.
 *
 * Appended through the real ledger service, so the balance a test spends is a
 * balance derived from real ledger entries rather than a number a fixture
 * invented. Promotional credit has no self-service path at all — a grant is
 * the only way it can exist — which is exactly what the mixed-funding tests
 * need to exercise.
 */
export async function grantCredit(
  context: TestContext,
  ownerUserId: string,
  amountMinor: bigint,
  creditClass: CreditClass = CreditClass.CASH,
  currency = 'USD',
): Promise<void> {
  if (amountMinor <= 0n) {
    throw new Error('grantCredit grants credit; use chargebackDebit to take it away');
  }
  const ledger = context.app.get(CreditLedgerService);
  await context.app
    .get(TenantPrismaService)
    .withPlatformAdmin(
      { actorUserId: ownerUserId, reason: 'test fixture granting customer credit' },
      async (tx) => {
        const account = await ledger.accountFor(tx, { ownerUserId, currency, creditClass });
        await ledger.append(tx, {
          ownerUserId,
          accountId: account.id,
          currency,
          creditClass,
          entryType:
            creditClass === CreditClass.PROMOTIONAL
              ? LedgerEntryType.PROMOTIONAL_CREDIT
              : LedgerEntryType.ADMIN_CREDIT,
          amountMinorSigned: amountMinor,
          reasonCode:
            creditClass === CreditClass.PROMOTIONAL
              ? LedgerReasonCode.PROMOTION
              : LedgerReasonCode.GOODWILL,
          idempotencyKey: `test-grant:${randomUUID()}`,
        });
      },
    );
}

/** Ask PalCert what a check costs, exactly as the New Check screen does. */
export async function quoteForCheck(
  context: TestContext,
  ownerUserId: string,
  currency = 'USD',
): Promise<{ id: string; amountMinor: bigint; priceVersionId: string }> {
  const quote = await context.app
    .get(PricingService)
    .createQuote({ ownerUserId, productCode: 'DOCUMENT_CHECK', currency });
  const row = await context.adminDb.priceQuote.findUniqueOrThrow({ where: { id: quote.id } });
  return {
    id: quote.id,
    amountMinor: BigInt(quote.amount.minorUnits),
    priceVersionId: row.priceVersionId,
  };
}

/**
 * Everything a customer needs before they can buy a check.
 *
 * The default grant is comfortably more than one check so that a test which
 * only cares about the check itself does not have to think about money.
 */
export async function fundForCheck(
  context: TestContext,
  ownerUserId: string,
  options: { price?: bigint; grant?: bigint; currency?: string } = {},
): Promise<{ quoteId: string; amountMinor: bigint }> {
  const currency = options.currency ?? 'USD';
  const price = options.price ?? CHECK_PRICE_MINOR;
  await ensureCheckPrice(context, price, currency);
  await grantCredit(context, ownerUserId, options.grant ?? price * 10n, CreditClass.CASH, currency);
  const quote = await quoteForCheck(context, ownerUserId, currency);
  return { quoteId: quote.id, amountMinor: quote.amountMinor };
}

/** The customer's own view of a check, including its billing block. */
export async function readCheck(client: AuthClient, checkId: string): Promise<request.Response> {
  return client.get(`${API}/checks/${checkId}`);
}

/** Cancel a check the way the UI does. */
export async function cancelCheck(client: AuthClient, checkId: string): Promise<request.Response> {
  return client.post(`${API}/checks/${checkId}/cancel`, {});
}

/** The purchase behind a check, read straight from the database. */
export async function purchaseOf(context: TestContext, checkId: string) {
  const check = await context.adminDb.documentCheck.findUniqueOrThrow({ where: { id: checkId } });
  if (check.servicePurchaseId === null) return null;
  return context.adminDb.servicePurchase.findUniqueOrThrow({
    where: { id: check.servicePurchaseId },
    include: { allocations: { include: { hold: true } } },
  });
}

/** Every SERVICE_CHARGE a customer has ever incurred, oldest first. */
export async function serviceCharges(context: TestContext, ownerUserId: string) {
  return context.adminDb.creditLedgerEntry.findMany({
    where: { ownerUserId, entryType: 'SERVICE_CHARGE' },
    orderBy: { createdAt: 'asc' },
  });
}

/**
 * Reserve a purchase for a check a test is about to build by hand.
 *
 * A few integrity tests construct a `document_checks` row directly, because
 * the API deliberately cannot produce the state they want to prove PalCert
 * survives. Since Phase 11 the database requires every new check to name a
 * purchase that describes it, so those tests need a real one — reserved
 * through the real service, against real credit.
 */
export async function reserveForSyntheticCheck(
  context: TestContext,
  ownerUserId: string,
  checkId: string,
  currency = 'USD',
): Promise<string> {
  await ensureCheckPrice(context, CHECK_PRICE_MINOR, currency);
  await grantCredit(context, ownerUserId, CHECK_PRICE_MINOR * 2n, CreditClass.CASH, currency);
  const quote = await quoteForCheck(context, ownerUserId, currency);
  const purchaseId = randomUUID();

  await context.app.get(TenantPrismaService).withUser(ownerUserId, (tx) =>
    context.app.get(ServicePurchaseService).reserve(tx, {
      ownerUserId,
      purchaseId,
      productCode: 'DOCUMENT_CHECK',
      resourceType: 'DOCUMENT_CHECK',
      resourceId: checkId,
      quote: {
        id: quote.id,
        priceVersionId: quote.priceVersionId,
        currency,
        amountMinor: quote.amountMinor,
      },
    }),
  );

  return purchaseId;
}

/** The ledger charges raised against one purchase's own reservations. */
export async function chargesForPurchase(
  context: TestContext,
  purchaseId: string,
): Promise<{ id: string; amountMinorSigned: bigint; creditClass: string }[]> {
  const allocations = await context.adminDb.servicePurchaseAllocation.findMany({
    where: { purchaseId },
    select: { holdId: true },
  });
  return context.adminDb.creditLedgerEntry.findMany({
    where: {
      entryType: 'SERVICE_CHARGE',
      referenceType: 'CREDIT_HOLD',
      referenceId: { in: allocations.map((allocation) => allocation.holdId) },
    },
    select: { id: true, amountMinorSigned: true, creditClass: true },
    orderBy: { createdAt: 'asc' },
  });
}

/**
 * A bank reversing a payment, which can take a balance below zero (§91).
 *
 * Written as a real `CHARGEBACK_DEBIT` rather than a generic adjustment,
 * because that is the one legitimate way a PalCert balance goes negative and
 * the tests that care are testing exactly that situation.
 */
export async function chargebackDebit(
  context: TestContext,
  ownerUserId: string,
  amountMinor: bigint,
  currency = 'USD',
): Promise<void> {
  const ledger = context.app.get(CreditLedgerService);
  await context.app
    .get(TenantPrismaService)
    .withPlatformAdmin(
      { actorUserId: ownerUserId, reason: 'test fixture recording a chargeback' },
      async (tx) => {
        const account = await ledger.accountFor(tx, {
          ownerUserId,
          currency,
          creditClass: CreditClass.CASH,
        });
        await ledger.append(tx, {
          ownerUserId,
          accountId: account.id,
          currency,
          creditClass: CreditClass.CASH,
          entryType: LedgerEntryType.CHARGEBACK_DEBIT,
          amountMinorSigned: -amountMinor,
          reasonCode: LedgerReasonCode.PROVIDER_DISPUTE,
          idempotencyKey: `test-chargeback:${randomUUID()}`,
        });
      },
    );
}
