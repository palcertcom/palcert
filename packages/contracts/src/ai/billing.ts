import { ServiceProductCode } from '../finance/pricing.js';
import { ServiceResourceType } from '../finance/purchases.js';

/**
 * Which AI work PalCert sells, and which it does for itself (ADR-0149).
 *
 * Every code path that can reach an external AI provider is named here and
 * declares one of two things:
 *
 * - **BILLABLE_AI_SERVICE** — a customer asked for it. It may only start once
 *   a ServicePurchase has reserved the price from the initiating user's
 *   PalCert Balance, and it is charged on COMPLETED, released otherwise.
 * - **INTERNAL_AI_OPERATION** — PalCert's own tooling (benchmarks, the health
 *   probe). No customer asked for it and no customer pays for it.
 *
 * The architecture test in the API walks every provider call site and fails
 * when one is not listed here, so a future AI feature cannot ship without a
 * deliberate decision about who pays for it.
 *
 * Authorization and billing are separate questions. A permission decides who
 * may use a feature; this registry decides what it costs. No role, platform or
 * organization, is ever free.
 */
export const AIOperationClassification = {
  BILLABLE_AI_SERVICE: 'BILLABLE_AI_SERVICE',
  INTERNAL_AI_OPERATION: 'INTERNAL_AI_OPERATION',
} as const;

export type AIOperationClassification =
  (typeof AIOperationClassification)[keyof typeof AIOperationClassification];

export interface BillableAIOperation {
  readonly classification: typeof AIOperationClassification.BILLABLE_AI_SERVICE;
  readonly productCode: ServiceProductCode;
  readonly resourceType: ServiceResourceType;
  /** Prefix of the purchase's idempotency key: `<prefix>:<resource id>`. */
  readonly idempotencyPrefix: string;
  /** AI is included in this product; settlement follows its verified delivery. */
  readonly bundled?: true;
}

export interface InternalAIOperation {
  readonly classification: typeof AIOperationClassification.INTERNAL_AI_OPERATION;
  /** Why no customer is charged. */
  readonly reason: string;
}

export const AIOperation = {
  AI_REVIEW: 'AI_REVIEW',
  AI_RULE_EXTRACTION: 'AI_RULE_EXTRACTION',
  SMARTFIX_FORMATTING: 'SMARTFIX_FORMATTING',
  AI_REVIEW_BENCHMARK: 'AI_REVIEW_BENCHMARK',
  EXTRACTION_BENCHMARK: 'EXTRACTION_BENCHMARK',
  PROVIDER_HEALTH_PROBE: 'PROVIDER_HEALTH_PROBE',
} as const;

export type AIOperation = (typeof AIOperation)[keyof typeof AIOperation];

export const AI_OPERATION_REGISTRY: Readonly<
  Record<AIOperation, BillableAIOperation | InternalAIOperation>
> = {
  AI_REVIEW: {
    classification: AIOperationClassification.BILLABLE_AI_SERVICE,
    productCode: ServiceProductCode.AI_REVIEW,
    resourceType: ServiceResourceType.AI_REVIEW,
    idempotencyPrefix: 'ai-review',
  },
  AI_RULE_EXTRACTION: {
    classification: AIOperationClassification.BILLABLE_AI_SERVICE,
    productCode: ServiceProductCode.AI_RULE_EXTRACTION,
    resourceType: ServiceResourceType.AI_RULE_EXTRACTION,
    idempotencyPrefix: 'ai-rule-extraction',
  },
  SMARTFIX_FORMATTING: {
    classification: AIOperationClassification.BILLABLE_AI_SERVICE,
    productCode: ServiceProductCode.SMARTFIX,
    resourceType: ServiceResourceType.SMARTFIX,
    idempotencyPrefix: 'smartfix-formatting',
    bundled: true,
  },
  AI_REVIEW_BENCHMARK: {
    classification: AIOperationClassification.INTERNAL_AI_OPERATION,
    reason: 'Evaluation harness over the committed synthetic corpus; no route exposes it.',
  },
  EXTRACTION_BENCHMARK: {
    classification: AIOperationClassification.INTERNAL_AI_OPERATION,
    reason: 'Evaluation harness over the committed synthetic corpus; no route exposes it.',
  },
  PROVIDER_HEALTH_PROBE: {
    classification: AIOperationClassification.INTERNAL_AI_OPERATION,
    reason: 'Readiness probe; sends no customer content.',
  },
};

export function billableAIOperation(operation: AIOperation): BillableAIOperation {
  const entry = AI_OPERATION_REGISTRY[operation];
  if (entry.classification !== AIOperationClassification.BILLABLE_AI_SERVICE) {
    throw new Error(`${operation} is not a billable AI service`);
  }
  return entry;
}

/**
 * The purchase's idempotency key, derived from the resource it pays for.
 *
 * One resource, one purchase: a retried request, a browser retry or a worker
 * redelivery reaches the same key and so the same reservation.
 */
export function aiPurchaseIdempotencyKey(operation: AIOperation, resourceId: string): string {
  return `${billableAIOperation(operation).idempotencyPrefix}:${resourceId}`;
}
