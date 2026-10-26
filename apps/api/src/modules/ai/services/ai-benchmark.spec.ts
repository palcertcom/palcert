import { AIBenchmarkHarness } from './ai-benchmark.service';
import { AIContextBuilder } from './ai-context-builder.service';
import { AIOutputValidator } from './ai-output-validator.service';
import { FakeAIProvider } from '../../../infrastructure/ai/fake-ai-provider';
import type { ApiConfigService } from '../../../config/api-config.service';

/**
 * The golden corpus, through the benchmark harness (§96, §97, §98).
 *
 * Run against the deterministic double, this proves the harness itself: that
 * the corpus loads, that every case produces a measurement, and that the
 * metrics a future model comparison depends on are actually computed. Run
 * against a real provider — which is opt-in and never part of normal CI — the
 * same code produces the numbers a model upgrade is judged by (§95).
 */

const config = {
  ai: {
    maxContextChars: 60_000,
    maxNodeChars: 2_000,
    maxContextNodes: 120,
    maxRulesPerRequest: 10,
  },
} as unknown as ApiConfigService;

function harness(provider: FakeAIProvider): AIBenchmarkHarness {
  return new AIBenchmarkHarness(provider, new AIContextBuilder(config), new AIOutputValidator());
}

describe('the AI golden corpus', () => {
  const provider = new FakeAIProvider();
  const subject = harness(provider);
  const corpus = subject.loadCorpus();

  beforeEach(() => provider.reset());

  it('covers the semantic cases Phase 8 is meant to handle', () => {
    const ids = corpus.map((entry) => entry.id);
    expect(ids).toEqual(
      expect.arrayContaining([
        'coi-present',
        'coi-absent',
        'ethics-present',
        'ethics-ambiguous',
        'data-availability-present',
        'anonymized-manuscript',
        'author-name-leaked',
        'affiliation-leaked-in-metadata',
        'arabic-declaration-present',
        'arabic-declaration-ambiguous',
        'prompt-injection-paragraph',
        'insufficient-context',
      ]),
    );
  });

  it('contains no real manuscript content', () => {
    // A benchmark corpus is committed, shared and copied — the opposite of
    // what unpublished research needs (§93, §96).
    const serialized = JSON.stringify(corpus);
    expect(serialized).not.toMatch(/@[a-z]+\.(com|edu|org)/i);
    expect(serialized).not.toMatch(/doi:|10\.\d{4}\//);
  });

  it('expects a blocking case to require human review whatever the verdict', () => {
    for (const entry of corpus) {
      if (!entry.blocking) continue;
      expect(entry.expect.requiresHumanReview).toBe(true);
    }
  });

  it('asserts structure rather than wording', () => {
    // LLM prose is not byte-deterministic; an expectation on wording would
    // fail for reasons unrelated to whether the assessment was right (§97).
    for (const entry of corpus) {
      const keys = Object.keys(entry.expect);
      expect(keys).not.toContain('explanationEn');
      expect(keys).not.toContain('summaryEn');
    }
  });

  it('produces a measurement for every case', async () => {
    const summary = await subject.run(corpus);

    expect(summary.caseCount).toBe(corpus.length);
    expect(summary.results).toHaveLength(corpus.length);
    expect(summary.provider).toBe('fake');
    expect(summary.promptVersion).toBe('1');
    expect(summary.contextBuilderVersion).toBe('1');
  });

  it('reports the metrics a model comparison needs', async () => {
    const summary = await subject.run(corpus.slice(0, 3));

    for (const metric of [
      summary.assessmentAgreement,
      summary.unsupportedEvidenceRate,
      summary.structuredOutputFailureRate,
      summary.humanReviewCorrectRate,
    ]) {
      expect(metric).toBeGreaterThanOrEqual(0);
      expect(metric).toBeLessThanOrEqual(1);
    }
    expect(summary.totalInputTokens).toBeGreaterThan(0);
  });

  it('counts a fabricated citation rather than crashing on it', async () => {
    // "How often does this model cite evidence it was never given" is one of
    // the numbers the harness exists to produce.
    provider.mode = 'unknown-node';
    const summary = await subject.run(corpus.slice(0, 2));

    expect(summary.unsupportedEvidenceRate).toBe(1);
    expect(summary.assessmentAgreement).toBe(0);
    expect(summary.results[0]!.failureKind).toBe('OUTPUT_INVALID');
  });

  it('counts a structured-output failure as a measurement', async () => {
    provider.mode = 'malformed';
    const summary = await subject.run(corpus.slice(0, 2));
    expect(summary.structuredOutputFailureRate).toBe(1);
  });

  it('scores agreement when the provider answers as the corpus expects', async () => {
    const satisfiedCases = corpus.filter((entry) => entry.expect.assessment === 'SATISFIED');
    provider.assessment = 'SATISFIED';

    const summary = await subject.run(satisfiedCases);
    expect(summary.assessmentAgreement).toBe(1);
    expect(summary.humanReviewCorrectRate).toBe(1);
  });
});
