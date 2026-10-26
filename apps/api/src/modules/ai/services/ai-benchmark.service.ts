import { Injectable } from '@nestjs/common';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import {
  AIProviderError,
  AIProviderPort,
  requiresHumanReview,
  type AIContextBundle,
  type Assessment,
} from '@palcert/contracts';
import { PromptId, promptTemplate } from '../../../infrastructure/ai/prompt-registry';
import { buildRuleAssessmentPrompt } from '../../../infrastructure/ai/prompt-builder';
import { AIContextBuilder } from './ai-context-builder.service';
import { AIOutputValidator } from './ai-output-validator.service';

/**
 * A reusable evaluation harness for AI providers (§98).
 *
 * Its purpose is to make "is this model good enough" a measured question
 * rather than an argument. It runs the committed synthetic corpus through
 * whichever provider is configured and reports the metrics that actually
 * matter for a compliance product — how often the assessment agreed, how often
 * evidence was fabricated, how often structured output failed — so a future
 * comparison between vendors, or a model upgrade, changes configuration rather
 * than product logic (§95).
 *
 * Assertions are structural, never textual: LLM prose is not byte-deterministic
 * and a suite that asserted on wording would fail for reasons unrelated to
 * whether the assessment was right (§97).
 */

export interface BenchmarkCase {
  readonly id: string;
  readonly ruleCode: string;
  readonly blocking: boolean;
  readonly nodes: ReadonlyArray<{ nodeId: string; text: string; headingLevel?: number }>;
  readonly metadata?: AIContextBundle['metadata'];
  readonly truncated?: boolean;
  readonly expect: {
    readonly assessment: Assessment;
    readonly evidenceSufficiency?: 'SUFFICIENT' | 'INSUFFICIENT';
    readonly requiresHumanReview: boolean;
    readonly allowedEvidenceNodeIds: readonly string[];
    readonly note?: string;
  };
}

export interface BenchmarkResult {
  readonly caseId: string;
  readonly ruleCode: string;
  readonly expected: Assessment;
  readonly actual: Assessment | null;
  readonly agreed: boolean;
  /** True when the model cited an id PalCert never supplied. */
  readonly unsupportedEvidence: boolean;
  /** True when PalCert's own validation refused the response. */
  readonly structuredOutputFailed: boolean;
  readonly requiresHumanReviewCorrect: boolean;
  readonly latencyMs: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly failureKind: string | null;
}

export interface BenchmarkSummary {
  readonly provider: string;
  readonly configuredModel: string;
  readonly promptVersion: string;
  readonly contextBuilderVersion: string;
  readonly caseCount: number;
  /** Share of cases where the assessment matched the corpus expectation. */
  readonly assessmentAgreement: number;
  readonly unsupportedEvidenceRate: number;
  readonly unknownNodeRate: number;
  readonly structuredOutputFailureRate: number;
  readonly humanReviewCorrectRate: number;
  readonly totalInputTokens: number;
  readonly totalOutputTokens: number;
  readonly medianLatencyMs: number;
  readonly results: readonly BenchmarkResult[];
}

@Injectable()
export class AIBenchmarkHarness {
  constructor(
    private readonly provider: AIProviderPort,
    private readonly contextBuilder: AIContextBuilder,
    private readonly validator: AIOutputValidator,
  ) {}

  /** The committed synthetic corpus. No real manuscripts, ever (§93, §96). */
  loadCorpus(path = defaultCorpusPath()): readonly BenchmarkCase[] {
    const raw = JSON.parse(readFileSync(path, 'utf8')) as { cases: BenchmarkCase[] };
    return raw.cases;
  }

  async run(cases: readonly BenchmarkCase[]): Promise<BenchmarkSummary> {
    const capabilities = this.provider.getCapabilities();
    const template = promptTemplate(PromptId.AI_RULE_ASSESSMENT);
    const results: BenchmarkResult[] = [];

    for (const benchmarkCase of cases) {
      results.push(await this.runCase(benchmarkCase, template.system));
    }

    const latencies = results.map((result) => result.latencyMs).sort((a, b) => a - b);
    return {
      provider: capabilities.provider,
      configuredModel: capabilities.configuredModel,
      promptVersion: template.version,
      contextBuilderVersion: this.contextBuilder.version,
      caseCount: results.length,
      assessmentAgreement: share(results, (result) => result.agreed),
      unsupportedEvidenceRate: share(results, (result) => result.unsupportedEvidence),
      unknownNodeRate: share(results, (result) => result.unsupportedEvidence),
      structuredOutputFailureRate: share(results, (result) => result.structuredOutputFailed),
      humanReviewCorrectRate: share(results, (result) => result.requiresHumanReviewCorrect),
      totalInputTokens: results.reduce((sum, result) => sum + result.inputTokens, 0),
      totalOutputTokens: results.reduce((sum, result) => sum + result.outputTokens, 0),
      medianLatencyMs:
        latencies.length === 0 ? 0 : (latencies[Math.floor(latencies.length / 2)] ?? 0),
      results,
    };
  }

  private async runCase(
    benchmarkCase: BenchmarkCase,
    systemPrompt: string,
  ): Promise<BenchmarkResult> {
    const context = this.buildContext(benchmarkCase);
    const userPrompt = buildRuleAssessmentPrompt(context, [benchmarkCase.ruleCode]);
    const startedAt = Date.now();

    try {
      const response = await this.provider.assessRules({
        reviewId: `benchmark-${benchmarkCase.id}`,
        context,
        systemPrompt,
        userPrompt,
        requestedRuleCodes: [benchmarkCase.ruleCode],
      });

      const validated = this.validator.validateAssessments({
        response: response.output,
        requestedRuleCodes: [benchmarkCase.ruleCode],
        context,
      });
      const assessment = validated.assessments[0]!;
      const humanReview = requiresHumanReview(
        { blocking: benchmarkCase.blocking },
        assessment.assessment,
      );

      return {
        caseId: benchmarkCase.id,
        ruleCode: benchmarkCase.ruleCode,
        expected: benchmarkCase.expect.assessment,
        actual: assessment.assessment,
        agreed: assessment.assessment === benchmarkCase.expect.assessment,
        unsupportedEvidence: false,
        structuredOutputFailed: false,
        requiresHumanReviewCorrect: humanReview === benchmarkCase.expect.requiresHumanReview,
        latencyMs: response.usage.latencyMs,
        inputTokens: response.usage.inputTokens,
        outputTokens: response.usage.outputTokens,
        failureKind: null,
      };
    } catch (error) {
      const kind = error instanceof AIProviderError ? error.kind : 'UNKNOWN_PROVIDER_ERROR';
      // A rejected response is a measurement, not a crash: "how often does this
      // model return something PalCert cannot accept" is one of the numbers the
      // harness exists to produce.
      const unsupportedEvidence =
        error instanceof AIProviderError && /never supplied/.test(error.message);
      return {
        caseId: benchmarkCase.id,
        ruleCode: benchmarkCase.ruleCode,
        expected: benchmarkCase.expect.assessment,
        actual: null,
        agreed: false,
        unsupportedEvidence,
        structuredOutputFailed: kind === 'OUTPUT_INVALID',
        requiresHumanReviewCorrect: false,
        latencyMs: Date.now() - startedAt,
        inputTokens: 0,
        outputTokens: 0,
        failureKind: kind,
      };
    }
  }

  private buildContext(benchmarkCase: BenchmarkCase): AIContextBundle {
    const built = this.contextBuilder.build({
      purpose: 'RULE_ASSESSMENT',
      artifact: {
        structuralModel: {
          paragraphs: benchmarkCase.nodes.map((node) => ({
            locator: { nodeId: node.nodeId },
            text: node.text,
            ...(node.headingLevel === undefined ? {} : { headingLevel: node.headingLevel }),
          })),
        },
      },
      rules: [
        {
          ruleCode: benchmarkCase.ruleCode,
          severity: 'MAJOR',
          blocking: benchmarkCase.blocking,
        },
      ],
      deterministicFindings: [],
      ...(benchmarkCase.metadata === undefined ? {} : { metadata: benchmarkCase.metadata }),
    });

    if (benchmarkCase.truncated !== true) return built;
    return { ...built, truncation: { truncated: true, reason: 'CHARACTER_BUDGET' } };
  }
}

function share(
  results: readonly BenchmarkResult[],
  predicate: (r: BenchmarkResult) => boolean,
): number {
  if (results.length === 0) return 0;
  return results.filter(predicate).length / results.length;
}

function defaultCorpusPath(): string {
  // Resolved from this file, so the harness works from any working directory.
  return resolve(dirname(__filename), '../../../../../../contracts/fixtures/ai/golden-corpus.json');
}
