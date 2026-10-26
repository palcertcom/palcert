import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import {
  AI_OPERATION_REGISTRY,
  AIOperation,
  AIOperationClassification,
  ACTIVE_SERVICE_PRODUCT_CODES,
  AI_SERVICE_PRODUCT_CODES,
  aiPurchaseIdempotencyKey,
} from '@palcert/contracts';

/**
 * No AI provider call without a decision about who pays (ADR-0149).
 *
 * Every file that calls a content-bearing method on the AI provider port must
 * be listed below against an operation in the shared registry. A billable
 * operation's file must also re-check its reservation before calling, which
 * is asserted in source. A new AI feature therefore fails this test until
 * somebody decides — deliberately, in review — whether customers pay for it.
 */
const SRC = join(__dirname, '..', '..');

/** Methods that send content to, or spend quota at, the AI provider. */
const PROVIDER_CALL =
  /\bprovider\s*\.\s*(assessRules|generateReportSupplement|countTokens|discoverGuidelineEvidence|extractRuleProposals|checkAvailability)\s*\(/;

/** Every call site, and the operation it belongs to. */
const CLASSIFIED: Readonly<Record<string, AIOperation>> = {
  'worker/ai-review-job.handler.ts': AIOperation.AI_REVIEW,
  'worker/rule-extraction-job.handler.ts': AIOperation.AI_RULE_EXTRACTION,
  'modules/ai/services/ai-benchmark.service.ts': AIOperation.AI_REVIEW_BENCHMARK,
  'modules/extraction/services/extraction-benchmark.service.ts': AIOperation.EXTRACTION_BENCHMARK,
  'health/health.service.ts': AIOperation.PROVIDER_HEALTH_PROBE,
};

/** The adapters themselves implement the port; they are not callers of it. */
const ADAPTERS = new Set([
  'infrastructure/ai/anthropic-provider.ts',
  'infrastructure/ai/fake-ai-provider.ts',
]);

function sourceFiles(directory: string): string[] {
  return readdirSync(directory).flatMap((entry) => {
    const path = join(directory, entry);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return path.endsWith('.ts') && !path.endsWith('.spec.ts') ? [path] : [];
  });
}

const CALLERS = sourceFiles(SRC)
  .map((path) => ({ path, rel: relative(SRC, path).split('\\').join('/') }))
  .filter(({ rel }) => !ADAPTERS.has(rel))
  .filter(({ path }) => PROVIDER_CALL.test(readFileSync(path, 'utf8')));

describe('AI billing classification (ADR-0149)', () => {
  it('finds the provider call sites it is meant to police', () => {
    // A test that silently checked nothing would be worse than no test.
    expect(CALLERS.length).toBeGreaterThanOrEqual(4);
  });

  it('has an explicit billing classification for every AI provider call site', () => {
    const unclassified = CALLERS.map(({ rel }) => rel).filter((rel) => !(rel in CLASSIFIED));
    expect(unclassified).toEqual([]);
  });

  it('lists no call site that no longer exists', () => {
    const found = new Set(CALLERS.map(({ rel }) => rel));
    expect(Object.keys(CLASSIFIED).filter((rel) => !found.has(rel))).toEqual([]);
  });

  it('makes every billable call site check its reservation before the provider is called', () => {
    for (const { path, rel } of CALLERS) {
      const operation = CLASSIFIED[rel];
      if (operation === undefined) continue;
      const entry = AI_OPERATION_REGISTRY[operation];
      if (entry.classification !== AIOperationClassification.BILLABLE_AI_SERVICE) continue;
      const source = readFileSync(path, 'utf8');
      expect([rel, source.includes('assertReservationLive')]).toEqual([rel, true]);
      expect([rel, source.includes('billing.capture(')]).toEqual([rel, true]);
      expect([rel, source.includes('billing.release(')]).toEqual([rel, true]);
    }
  });

  it('keeps internal operations out of any customer route', () => {
    // The benchmarks are evaluation tooling: no controller may reach them.
    const controllers = sourceFiles(SRC).filter((path) => path.endsWith('.controller.ts'));
    const offenders = controllers.filter((path) =>
      /AIBenchmarkService|ExtractionBenchmarkService/.test(readFileSync(path, 'utf8')),
    );
    expect(offenders).toEqual([]);
  });

  it('makes every billable AI product quotable and every AI product billable', () => {
    for (const entry of Object.values(AI_OPERATION_REGISTRY)) {
      if (entry.classification !== AIOperationClassification.BILLABLE_AI_SERVICE) continue;
      expect(ACTIVE_SERVICE_PRODUCT_CODES).toContain(entry.productCode);
      expect(AI_SERVICE_PRODUCT_CODES).toContain(entry.productCode);
    }
  });

  it('derives one purchase key per resource', () => {
    expect(aiPurchaseIdempotencyKey(AIOperation.AI_REVIEW, 'r1')).toBe('ai-review:r1');
    expect(aiPurchaseIdempotencyKey(AIOperation.AI_RULE_EXTRACTION, 'x1')).toBe(
      'ai-rule-extraction:x1',
    );
    expect(() => aiPurchaseIdempotencyKey(AIOperation.PROVIDER_HEALTH_PROBE, 'p')).toThrow();
  });
});
