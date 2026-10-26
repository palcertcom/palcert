import { CreditClass } from '@palcert/contracts';
import { PricingService } from '../../src/modules/finance/services/pricing.service';
import { grantCredit } from './paid-check-client';
import type { TestContext } from './test-app';

/**
 * AI services cost money (ADR-0149). These helpers put a price into force,
 * fund the initiating user and fetch a quote, the same way the product does —
 * so tests written before AI was billed keep exercising the only path
 * production has.
 */
export type AIProductCode = 'AI_REVIEW' | 'AI_RULE_EXTRACTION';

/** Defaults: $0.50 for a review, $2.00 for an extraction. */
export const AI_PRICE_MINOR: Readonly<Record<AIProductCode, bigint>> = {
  AI_REVIEW: 50n,
  AI_RULE_EXTRACTION: 200n,
};

export async function ensureAIPrice(
  context: TestContext,
  productCode: AIProductCode,
  amountMinor: bigint = AI_PRICE_MINOR[productCode],
  currency = 'USD',
): Promise<string> {
  const existing = await context.adminDb.priceVersion.findFirst({
    where: { productCode, currency, marketCode: 'GLOBAL', status: 'ACTIVE' },
  });
  if (existing !== null) {
    if (existing.amountMinor === amountMinor) return existing.id;
    await context.adminDb.priceVersion.update({
      where: { id: existing.id },
      data: { status: 'RETIRED', retiredAt: new Date() },
    });
  }
  const created = await context.adminDb.priceVersion.create({
    data: {
      productCode,
      currency,
      marketCode: 'GLOBAL',
      amountMinor,
      status: 'ACTIVE',
      activatedAt: new Date(),
    },
  });
  return created.id;
}

/** Retire the active price, so the product cannot be quoted. */
export async function retireAIPrice(
  context: TestContext,
  productCode: AIProductCode,
  currency = 'USD',
): Promise<void> {
  await context.adminDb.priceVersion.updateMany({
    where: { productCode, currency, marketCode: 'GLOBAL', status: 'ACTIVE' },
    data: { status: 'RETIRED', retiredAt: new Date() },
  });
}

export async function quoteForAI(
  context: TestContext,
  ownerUserId: string,
  productCode: AIProductCode,
  currency = 'USD',
): Promise<{ id: string; amountMinor: bigint }> {
  const quote = await context.app
    .get(PricingService)
    .createQuote({ ownerUserId, productCode, currency });
  return { id: quote.id, amountMinor: BigInt(quote.amount.minorUnits) };
}

/**
 * Everything the initiating user needs before starting an AI service: an
 * active price, enough balance, and a fresh quote. `grant: 0n` funds nothing.
 */
export async function fundForAI(
  context: TestContext,
  ownerUserId: string,
  productCode: AIProductCode,
  options: { price?: bigint; grant?: bigint; currency?: string; creditClass?: CreditClass } = {},
): Promise<{ quoteId: string; amountMinor: bigint }> {
  const currency = options.currency ?? 'USD';
  const price = options.price ?? AI_PRICE_MINOR[productCode];
  await ensureAIPrice(context, productCode, price, currency);
  const grant = options.grant ?? price * 5n;
  if (grant > 0n) {
    await grantCredit(
      context,
      ownerUserId,
      grant,
      options.creditClass ?? CreditClass.CASH,
      currency,
    );
  }
  const quote = await quoteForAI(context, ownerUserId, productCode, currency);
  return { quoteId: quote.id, amountMinor: quote.amountMinor };
}

/** The purchase behind an AI run, with its holds, read straight from the database. */
export async function aiPurchase(context: TestContext, purchaseId: string) {
  return context.adminDb.servicePurchase.findUniqueOrThrow({
    where: { id: purchaseId },
    include: { allocations: { include: { hold: true } } },
  });
}

/** CASH available to a user, in minor units, straight from the ledger tables. */
export async function availableCash(
  context: TestContext,
  ownerUserId: string,
  currency = 'USD',
): Promise<bigint> {
  const account = await context.adminDb.customerCreditAccount.findFirst({
    where: { ownerUserId, currency, creditClass: CreditClass.CASH },
  });
  if (account === null) return 0n;
  const [ledger, held] = await Promise.all([
    context.adminDb.creditLedgerEntry.aggregate({
      where: { accountId: account.id },
      _sum: { amountMinorSigned: true },
    }),
    context.adminDb.creditHold.aggregate({
      where: { ownerUserId, currency, creditClass: CreditClass.CASH, status: 'ACTIVE' },
      _sum: { amountMinor: true },
    }),
  ]);
  return (ledger._sum.amountMinorSigned ?? 0n) - (held._sum.amountMinor ?? 0n);
}

/** A body for starting an AI review, funded for its initiating user (ADR-0149). */
export async function reviewBody(
  context: TestContext,
  ownerUserId: string,
  options: { price?: bigint; grant?: bigint } = {},
): Promise<{ priceQuoteId: string }> {
  const { quoteId } = await fundForAI(context, ownerUserId, 'AI_REVIEW', options);
  return { priceQuoteId: quoteId };
}
