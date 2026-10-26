import { describe, expect, it } from 'vitest';
import {
  FINANCIAL_LOCK_ORDER,
  PurchaseFailureCode,
  SERVICE_PURCHASE_STATUSES,
  SERVICE_RESOURCE_TYPES,
  ServicePurchaseStatus,
  ServiceResourceType,
  canTransitionPurchase,
  purchaseHoldIdempotencyKey,
  purchaseReservesCredit,
  purchaseWasCharged,
} from './purchases.js';
import { FUNDING_ORDER, CreditClass } from './ledger.js';

describe('service purchase lifecycle', () => {
  it('lists every status exactly once', () => {
    expect(SERVICE_PURCHASE_STATUSES).toEqual([
      'RESERVED',
      'PROCESSING',
      'DELIVERED',
      'RELEASED',
      'REFUNDED',
      'RECONCILIATION_REQUIRED',
    ]);
    expect(SERVICE_RESOURCE_TYPES).toEqual([
      ServiceResourceType.DOCUMENT_CHECK,
      ServiceResourceType.SMARTFIX,
      ServiceResourceType.AI_REVIEW,
      ServiceResourceType.AI_RULE_EXTRACTION,
    ]);
  });

  it('allows only the forward moves', () => {
    expect(canTransitionPurchase('RESERVED', 'PROCESSING')).toBe(true);
    expect(canTransitionPurchase('RESERVED', 'RELEASED')).toBe(true);
    expect(canTransitionPurchase('PROCESSING', 'DELIVERED')).toBe(true);
    expect(canTransitionPurchase('PROCESSING', 'RELEASED')).toBe(true);
    expect(canTransitionPurchase('DELIVERED', 'REFUNDED')).toBe(true);
  });

  it('never lets a settled purchase reserve money again', () => {
    // §48: a retry is a new purchase. Reopening this one would rewrite the
    // billing history of an attempt that really happened.
    for (const from of ['DELIVERED', 'RELEASED', 'REFUNDED'] as const) {
      expect(canTransitionPurchase(from, ServicePurchaseStatus.RESERVED)).toBe(false);
      expect(canTransitionPurchase(from, ServicePurchaseStatus.PROCESSING)).toBe(false);
    }
  });

  it('never lets a released purchase become delivered', () => {
    // The single most expensive wrong transition: it would charge for a
    // service that was already declared non-billable.
    expect(canTransitionPurchase('RELEASED', 'DELIVERED')).toBe(false);
    expect(canTransitionPurchase('RELEASED', 'REFUNDED')).toBe(false);
  });

  it('leaves reconciliation terminal, and reachable from everywhere else', () => {
    // §94: an impossible financial state is escalated to a person, and a
    // worker cannot quietly decide it is fine again.
    for (const from of SERVICE_PURCHASE_STATUSES) {
      if (from === ServicePurchaseStatus.RECONCILIATION_REQUIRED) continue;
      expect(canTransitionPurchase(from, ServicePurchaseStatus.RECONCILIATION_REQUIRED)).toBe(true);
    }
    for (const to of SERVICE_PURCHASE_STATUSES) {
      expect(canTransitionPurchase(ServicePurchaseStatus.RECONCILIATION_REQUIRED, to)).toBe(false);
    }
  });

  it('knows which statuses still hold the customer’s money', () => {
    expect(purchaseReservesCredit('RESERVED')).toBe(true);
    expect(purchaseReservesCredit('PROCESSING')).toBe(true);
    expect(purchaseReservesCredit('DELIVERED')).toBe(false);
    expect(purchaseReservesCredit('RELEASED')).toBe(false);
  });

  it('knows which statuses mean money actually moved', () => {
    expect(purchaseWasCharged('DELIVERED')).toBe(true);
    // A refunded purchase was charged and then compensated; the charge is
    // still in the ledger and pretending otherwise would lose it.
    expect(purchaseWasCharged('REFUNDED')).toBe(true);
    expect(purchaseWasCharged('RESERVED')).toBe(false);
    expect(purchaseWasCharged('PROCESSING')).toBe(false);
    expect(purchaseWasCharged('RELEASED')).toBe(false);
  });

  it('names no failure code that means the document failed its rules', () => {
    // §31, §96: a NON_COMPLIANT result is a delivered service. If a purchase
    // failure code could express "the document was bad", someone would
    // eventually release money for it.
    const codes = Object.keys(PurchaseFailureCode).join(' ');
    expect(codes).not.toMatch(/COMPLIAN|VIOLATION|SCORE|REVIEW_REQUIRED|INDETERMINATE/);
  });

  it('derives a hold key that two deliveries of one reservation agree on', () => {
    expect(purchaseHoldIdempotencyKey('p-1', CreditClass.PROMOTIONAL)).toBe(
      'purchase:p-1:PROMOTIONAL',
    );
    expect(purchaseHoldIdempotencyKey('p-1', CreditClass.CASH)).not.toBe(
      purchaseHoldIdempotencyKey('p-1', CreditClass.PROMOTIONAL),
    );
  });

  it('ends its lock order where the funding order begins', () => {
    // §12, §81: accounts are the last thing locked, and they are locked in
    // the funding order, so a promotional-then-cash purchase and a
    // cash-only one never take the same two rows in opposite orders.
    expect(FINANCIAL_LOCK_ORDER.at(-1)).toBe('customer_credit_accounts');
    expect(FUNDING_ORDER).toEqual([CreditClass.PROMOTIONAL, CreditClass.CASH]);
  });
});
