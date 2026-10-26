import { describe, expect, it } from 'vitest';
import {
  AI_OPERATION_REGISTRY,
  AIOperation,
  AIOperationClassification,
  aiPurchaseIdempotencyKey,
  billableAIOperation,
} from './billing.js';
import {
  AI_SERVICE_PRODUCT_CODES,
  ServiceProductCode,
  isAIServiceProduct,
} from '../finance/pricing.js';

describe('AI operation registry (ADR-0149)', () => {
  it('classifies every operation', () => {
    expect(Object.keys(AI_OPERATION_REGISTRY).sort()).toEqual(Object.values(AIOperation).sort());
  });

  it('bills exactly the two customer-initiated services', () => {
    const billable = Object.entries(AI_OPERATION_REGISTRY)
      .filter(([, entry]) => entry.classification === AIOperationClassification.BILLABLE_AI_SERVICE)
      .map(([operation]) => operation)
      .sort();
    expect(billable).toEqual([AIOperation.AI_REVIEW, AIOperation.AI_RULE_EXTRACTION]);
    expect([...AI_SERVICE_PRODUCT_CODES].sort()).toEqual([
      ServiceProductCode.AI_REVIEW,
      ServiceProductCode.AI_RULE_EXTRACTION,
    ]);
  });

  it('gives every internal operation a stated reason', () => {
    for (const entry of Object.values(AI_OPERATION_REGISTRY)) {
      if (entry.classification === AIOperationClassification.INTERNAL_AI_OPERATION) {
        expect(entry.reason.length).toBeGreaterThan(10);
      }
    }
  });

  it('refuses to bill an internal operation', () => {
    expect(() => billableAIOperation(AIOperation.AI_REVIEW_BENCHMARK)).toThrow();
    expect(() => aiPurchaseIdempotencyKey(AIOperation.PROVIDER_HEALTH_PROBE, 'x')).toThrow();
  });

  it('derives one purchase key per resource, distinct across services', () => {
    expect(aiPurchaseIdempotencyKey(AIOperation.AI_REVIEW, 'r1')).toBe('ai-review:r1');
    expect(aiPurchaseIdempotencyKey(AIOperation.AI_RULE_EXTRACTION, 'r1')).toBe(
      'ai-rule-extraction:r1',
    );
  });

  it('recognises AI products and nothing else', () => {
    expect(isAIServiceProduct(ServiceProductCode.AI_REVIEW)).toBe(true);
    expect(isAIServiceProduct(ServiceProductCode.DOCUMENT_CHECK)).toBe(false);
    expect(isAIServiceProduct(ServiceProductCode.SMARTFIX)).toBe(false);
  });
});
