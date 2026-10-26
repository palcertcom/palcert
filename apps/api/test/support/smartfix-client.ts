import { CreditClass } from '@palcert/contracts';
import type request from 'supertest';
import { API } from './auth-client';
import type { AuthClient } from './auth-client';
import { PricingService } from '../../src/modules/finance/services/pricing.service';
import { grantCredit } from './paid-check-client';
import type { TestContext } from './test-app';

/** What a SMARTFIX correction costs in these tests unless a test says otherwise: $7. */
export const SMARTFIX_PRICE_MINOR = 700n;

/**
 * Put a SMARTFIX price into force.
 *
 * Phase 10 already published the product; this activates a price for it, the
 * same way `ensureCheckPrice` does for a check. Idempotent, so a test that
 * funds twice does not trip the one-active-price index.
 */
export async function ensureSmartFixPrice(
  context: TestContext,
  amountMinor: bigint = SMARTFIX_PRICE_MINOR,
  currency = 'USD',
): Promise<string> {
  const existing = await context.adminDb.priceVersion.findFirst({
    where: { productCode: 'SMARTFIX', currency, marketCode: 'GLOBAL', status: 'ACTIVE' },
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
      productCode: 'SMARTFIX',
      currency,
      marketCode: 'GLOBAL',
      amountMinor,
      status: 'ACTIVE',
      activatedAt: new Date(),
    },
  });
  return created.id;
}

/** Ask PalCert what a correction costs, exactly as the SmartFix screen does. */
export async function quoteForSmartFix(
  context: TestContext,
  ownerUserId: string,
  currency = 'USD',
): Promise<{ id: string; amountMinor: bigint }> {
  const quote = await context.app
    .get(PricingService)
    .createQuote({ ownerUserId, productCode: 'SMARTFIX', currency });
  return { id: quote.id, amountMinor: BigInt(quote.amount.minorUnits) };
}

/** Everything a customer needs before they can buy a correction. */
export async function fundForSmartFix(
  context: TestContext,
  ownerUserId: string,
  options: { price?: bigint; grant?: bigint; currency?: string } = {},
): Promise<{ quoteId: string; amountMinor: bigint }> {
  const currency = options.currency ?? 'USD';
  const price = options.price ?? SMARTFIX_PRICE_MINOR;
  await ensureSmartFixPrice(context, price, currency);
  await grantCredit(context, ownerUserId, options.grant ?? price * 5n, CreditClass.CASH, currency);
  const quote = await quoteForSmartFix(context, ownerUserId, currency);
  return { quoteId: quote.id, amountMinor: quote.amountMinor };
}

/** Plan a correction the way the UI does. */
export function planSmartFix(client: AuthClient, checkId: string): Promise<request.Response> {
  return client.post(`${API}/smartfix/checks/${checkId}/plan`, {});
}

export function readPlan(client: AuthClient, planId: string): Promise<request.Response> {
  return client.get(`${API}/smartfix/plans/${planId}`);
}

export function startSmartFix(
  client: AuthClient,
  body: { planId: string; priceQuoteId: string },
): Promise<request.Response> {
  return client.post(`${API}/smartfix/requests`, body);
}

export function readSmartFix(client: AuthClient, requestId: string): Promise<request.Response> {
  return client.get(`${API}/smartfix/requests/${requestId}`);
}

export function readManifest(client: AuthClient, requestId: string): Promise<request.Response> {
  return client.get(`${API}/smartfix/requests/${requestId}/manifest`);
}

export function cancelSmartFix(client: AuthClient, requestId: string): Promise<request.Response> {
  return client.post(`${API}/smartfix/requests/${requestId}/cancel`, {});
}

/** The correction row, read straight from the database. */
export async function smartFixRow(context: TestContext, requestId: string) {
  return context.adminDb.smartFixRequest.findUniqueOrThrow({
    where: { id: requestId },
    include: {
      servicePurchase: { include: { allocations: { include: { hold: true } } } },
      manifest: true,
      correctedVersion: true,
      recheck: true,
    },
  });
}
