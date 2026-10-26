import { Injectable } from '@nestjs/common';
import {
  AIFailureKind,
  AIProviderError,
  AIProviderPort,
  type DiscoveredCitation,
  type EvidenceDiscoveryProviderResponse,
  type EvidenceDiscoveryRequest,
  type RuleProposalKind,
  type RuleProposalProviderResponse,
  type RuleProposalRequest,
  type AIProviderCapabilities,
  type AIReportSupplementProviderResponse,
  type AIReportSupplementRequest,
  type AIRuleAssessmentProviderResponse,
  type AIRuleAssessmentRequest,
  type AITokenCountRequest,
  type AITokenCountResult,
  type Assessment,
} from '@palcert/contracts';

/** The provider name recorded for a review produced by the double. */
export const FAKE_PROVIDER = 'fake';

/**
 * A deterministic AI provider, for tests only (§3, §94).
 *
 * It exists so the suites can exercise every path through the AI layer —
 * success, refusal, rate limiting, malformed output, hallucinated evidence —
 * without a network, a credential, or a bill, and without the flakiness of
 * asserting on real model prose.
 *
 * It must never serve a real user, and configuration validation refuses it in
 * production. The reason is not tidiness: the double invents assessments, and
 * presenting invented assessments to someone as a review of their thesis would
 * be the most dishonest thing this codebase could do.
 */
@Injectable()
export class FakeAIProvider extends AIProviderPort {
  /** How the next call behaves. Tests set this. */
  mode:
    | 'normal'
    | 'rate-limited'
    | 'overloaded'
    | 'timeout'
    | 'network'
    | 'authentication'
    | 'invalid-request'
    | 'refusal'
    | 'malformed'
    | 'unknown-node'
    | 'unknown-rule'
    | 'missing-rule'
    | 'duplicate-rule'
    // Phase 9 extraction failure modes.
    | 'no-citations'
    | 'unknown-source'
    | 'unknown-block'
    | 'unknown-evidence' = 'normal';

  /** What a normal assessment concludes. */
  assessment: Assessment = 'SATISFIED';
  /** Fails this many times before succeeding, for retry tests. */
  failuresBeforeSuccess = 0;
  private failuresSoFar = 0;

  configuredModel = 'fake-model-1';
  available = true;

  /** Every request it received, for privacy and prompt assertions. */
  readonly assessmentCalls: AIRuleAssessmentRequest[] = [];
  readonly supplementCalls: AIReportSupplementRequest[] = [];
  readonly discoveryCalls: EvidenceDiscoveryRequest[] = [];
  readonly proposalCalls: RuleProposalRequest[] = [];

  /** What Pass A "finds" in a PDF. */
  citedText = 'The left margin must be 30 mm.';
  /** What Pass B proposes. Tests set this to exercise each kind (§44). */
  proposalKinds: RuleProposalKind[] = ['EXPLICIT_REQUIREMENT'];
  /**
   * When set, the PDF at position i is cited with entry i (and each must be
   * text that PDF contains), so a run can hold several distinct evidence
   * items. Unset, every PDF is cited with `citedText`.
   */
  citedTextsByDocument: string[] | null = null;
  /** Cite every supplied item (up to 20) rather than the first: more links. */
  citeAllSuppliedEvidence = false;
  /** An invalid rule definition, to exercise the INVALID_PROPOSAL path (§59). */
  proposeInvalidRule = false;

  getCapabilities(): AIProviderCapabilities {
    return {
      provider: FAKE_PROVIDER,
      configuredModel: this.configuredModel,
      supportsTokenCounting: true,
      supportsStructuredOutput: true,
      supportsEffort: false,
      maxInputTokens: 60_000,
      maxOutputTokens: 8_000,
    };
  }

  async countTokens(request: AITokenCountRequest): Promise<AITokenCountResult> {
    // A stable, monotonic approximation. Tests that care about budgets set the
    // budget rather than depending on a tokenizer.
    const characters = request.systemPrompt.length + request.userPrompt.length;
    return { inputTokens: Math.ceil(characters / 4), exact: false };
  }

  async assessRules(request: AIRuleAssessmentRequest): Promise<AIRuleAssessmentProviderResponse> {
    this.assessmentCalls.push(request);
    this.maybeFail();

    const supplied = request.context.nodes.map((node) => node.nodeId);
    const codes = [...request.requestedRuleCodes];

    if (this.mode === 'unknown-rule') codes.push('ADMIN.BYPASS');
    if (this.mode === 'missing-rule') codes.pop();
    if (this.mode === 'duplicate-rule' && codes[0] !== undefined) codes.push(codes[0]);

    // With nothing to cite, a well-prompted model answers
    // INSUFFICIENT_EVIDENCE rather than concluding anyway — and PalCert's
    // validator rejects any other answer, so the double behaves the same way.
    const verdict: Assessment =
      supplied.length === 0 && this.mode !== 'unknown-node'
        ? 'INSUFFICIENT_EVIDENCE'
        : this.assessment;

    const assessments = codes.map((ruleCode) => ({
      ruleCode,
      assessment: verdict,
      reasonCode:
        verdict === 'SATISFIED'
          ? ('REQUIREMENT_MET' as const)
          : verdict === 'NOT_SATISFIED'
            ? ('REQUIREMENT_NOT_MET' as const)
            : ('EVIDENCE_NOT_PRESENT' as const),
      evidenceSufficiency:
        verdict === 'INSUFFICIENT_EVIDENCE' ? ('INSUFFICIENT' as const) : ('SUFFICIENT' as const),
      evidenceNodeIds:
        this.mode === 'unknown-node'
          ? ['fake-secret-node']
          : verdict === 'INSUFFICIENT_EVIDENCE'
            ? []
            : supplied.slice(0, 2),
      explanationEn: `Assessment of ${ruleCode} from the supplied evidence.`,
      explanationAr: `تقييم ${ruleCode} بناءً على الأدلة المقدمة.`,
    }));

    return {
      // The generated type models `minItems: 1` as a non-empty tuple; the
      // double always produces at least one entry, except in the deliberate
      // missing-rule case the validator is meant to reject.
      output: { schemaVersion: 1, assessments } as AIRuleAssessmentProviderResponse['output'],
      usage: this.usage(),
    };
  }

  async generateReportSupplement(
    request: AIReportSupplementRequest,
  ): Promise<AIReportSupplementProviderResponse> {
    this.supplementCalls.push(request);
    this.maybeFail();

    return {
      output: {
        schemaVersion: 1,
        summaryEn:
          'The check measured the document against the selected standard. Some requirements were met and others need attention.',
        summaryAr:
          'فحص المستند وفق المعيار المحدد. استُوفيت بعض المتطلبات ويحتاج بعضها الآخر إلى مراجعة.',
        priorityRecommendations: [
          {
            priority: 'HIGH',
            relatedRuleCodes: [],
            textEn: 'Review the findings listed in the technical report and adjust the document.',
            textAr: 'راجع النتائج المذكورة في التقرير الفني وعدّل المستند.',
          },
        ],
      },
      usage: this.usage(),
    };
  }

  // -------------------------------------------------------------------------
  // Rule extraction (Phase 9)
  // -------------------------------------------------------------------------

  /**
   * Pass A, deterministically.
   *
   * Cites the first block or page of every document it is given, which is
   * enough for the suites to assert the whole grounding pipeline — citation to
   * locator to node id to evidence row — without a network or a bill.
   */
  async discoverGuidelineEvidence(
    request: EvidenceDiscoveryRequest,
  ): Promise<EvidenceDiscoveryProviderResponse> {
    this.discoveryCalls.push(request);
    this.maybeFail();

    const citations: DiscoveredCitation[] = [];
    for (const [documentIndex, document] of request.documents.entries()) {
      if (this.mode === 'no-citations') break;
      if (document.kind === 'PDF') {
        citations.push({
          kind: 'PDF_PAGE',
          sourceAssetId:
            this.mode === 'unknown-source'
              ? '00000000-0000-4000-8000-000000000000'
              : document.sourceAssetId,
          citedText: this.citedTextsByDocument?.[documentIndex] ?? this.citedText,
          startPage: 1,
          endPage: 1,
        });
      } else if (document.blocks.length > 0) {
        citations.push({
          kind: 'DOCX_BLOCK',
          sourceAssetId: document.sourceAssetId,
          citedText: document.blocks[0] ?? this.citedText,
          startBlockIndex: this.mode === 'unknown-block' ? document.blocks.length + 50 : 0,
          endBlockIndex: this.mode === 'unknown-block' ? document.blocks.length + 51 : 1,
        });
      }
    }

    return { citations, ungroundedBlockCount: 1, usage: this.usage() };
  }

  /**
   * Pass B, deterministically.
   *
   * Produces one proposal per configured kind, citing only evidence PalCert
   * actually supplied — except in the failure modes, which cite something
   * PalCert never sent so the validator's rejection path is exercised.
   */
  async extractRuleProposals(request: RuleProposalRequest): Promise<RuleProposalProviderResponse> {
    this.proposalCalls.push(request);
    this.maybeFail();

    const evidenceIds =
      this.mode === 'unknown-evidence'
        ? ['evidence-palcert-never-sent']
        : request.suppliedEvidenceIds.slice(0, this.citeAllSuppliedEvidence ? 20 : 1);

    // A well-behaved provider: never more than the call allows.
    const kinds = this.proposalKinds.slice(0, request.maxProposals ?? this.proposalKinds.length);
    const proposals = kinds.map((kind, index) => ({
      proposalKey: `fake-${index + 1}`,
      kind,
      evidenceIds,
      interpretationEn: `Extracted ${kind} from the supplied evidence.`,
      interpretationAr: `مستخلص ${kind} من الأدلة المقدمة.`,
      requiresClarification: kind === 'AMBIGUOUS_REQUIREMENT',
      ...(kind === 'AMBIGUOUS_REQUIREMENT'
        ? { ambiguityNote: 'The source does not say which value is required.' }
        : {}),
      ...(kind === 'EXPLICIT_REQUIREMENT' || kind === 'TEMPLATE_INFERENCE'
        ? { suggestedRule: this.suggestedRuleFor(kind, index) }
        : {}),
    }));

    return {
      output: { proposals } as RuleProposalProviderResponse['output'],
      usage: this.usage(),
    };
  }

  async checkAvailability(): Promise<{ ok: boolean; message?: string }> {
    return this.available ? { ok: true } : { ok: false, message: 'unavailable' };
  }

  reset(): void {
    this.mode = 'normal';
    this.assessment = 'SATISFIED';
    this.failuresBeforeSuccess = 0;
    this.failuresSoFar = 0;
    this.configuredModel = 'fake-model-1';
    this.available = true;
    this.assessmentCalls.length = 0;
    this.supplementCalls.length = 0;
    this.discoveryCalls.length = 0;
    this.proposalCalls.length = 0;
    this.citedText = 'The left margin must be 30 mm.';
    this.proposalKinds = ['EXPLICIT_REQUIREMENT'];
    this.citedTextsByDocument = null;
    this.citeAllSuppliedEvidence = false;
    this.proposeInvalidRule = false;
  }

  /**
   * A rule definition for a proposal of the given kind.
   *
   * Valid by default, so the ordinary path is exercised; `proposeInvalidRule`
   * makes it fail PalCert's own validator (an operator that does not accept the
   * operand shape) without failing the provider's schema, which is exactly the
   * case §59 describes.
   */
  private suggestedRuleFor(kind: RuleProposalKind, index: number): Record<string, unknown> {
    const base = {
      ruleCode:
        kind === 'TEMPLATE_INFERENCE' ? `TEMPLATE.RULE.${index}` : `GUIDELINE.RULE.${index}`,
      category: 'MARGINS',
      evaluationMode: 'DETERMINISTIC',
      scope: { kind: 'PAGE', pages: 'ALL', property: 'marginLeft' },
      operator: 'EQUALS',
      expected: { type: 'NUMBER', number: 30 },
      unit: 'MILLIMETRE',
      severity: 'MAJOR',
      blocking: false,
      autofix: 'NONE',
      origin: 'ORGANIZATION_POLICY',
      titleEn: 'Left margin 30 mm',
      titleAr: 'الهامش الأيسر 30 مم',
    };
    if (!this.proposeInvalidRule) return base;
    // BETWEEN takes a range, never a single number: schema-valid output that
    // PalCert's rule validator must refuse.
    return { ...base, operator: 'BETWEEN' };
  }

  private usage(): AIRuleAssessmentProviderResponse['usage'] {
    return {
      providerRequestId: 'fake-request-1',
      providerReturnedModel: this.configuredModel,
      inputTokens: 1_000,
      outputTokens: 200,
      cacheReadTokens: null,
      cacheWriteTokens: null,
      latencyMs: 5,
    };
  }

  private maybeFail(): void {
    if (this.failuresBeforeSuccess > this.failuresSoFar) {
      this.failuresSoFar += 1;
      throw new AIProviderError(AIFailureKind.OVERLOADED, 'the provider is overloaded', 0);
    }

    switch (this.mode) {
      case 'rate-limited':
        throw new AIProviderError(AIFailureKind.RATE_LIMITED, 'rate limited', 0);
      case 'overloaded':
        throw new AIProviderError(AIFailureKind.OVERLOADED, 'the provider is overloaded', 0);
      case 'timeout':
        throw new AIProviderError(AIFailureKind.TIMEOUT, 'the provider timed out');
      case 'network':
        throw new AIProviderError(AIFailureKind.NETWORK, 'the provider was unreachable');
      case 'authentication':
        throw new AIProviderError(AIFailureKind.AUTHENTICATION, 'the credential was rejected');
      case 'invalid-request':
        throw new AIProviderError(AIFailureKind.INVALID_REQUEST, 'the request was rejected');
      case 'refusal':
        throw new AIProviderError(
          AIFailureKind.PROVIDER_REFUSAL,
          'the provider declined to answer this request',
        );
      case 'malformed':
        throw new AIProviderError(
          AIFailureKind.OUTPUT_INVALID,
          'the provider response failed PalCert validation',
        );
      default:
        break;
    }
  }
}
