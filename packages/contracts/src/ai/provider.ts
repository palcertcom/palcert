import type { AIContextBundle } from './context.generated.js';
import type {
  AIReportSupplementResponse,
  AIRuleAssessmentResponse,
} from './assessment.generated.js';
import type { AIFailureKind, AIInvocationPurpose } from './review.js';
import type { AIFormattingRequest, AIFormattingProposal } from '../smartfix/ai-formatting.js';
import type {
  EvidenceDiscoveryProviderResponse,
  EvidenceDiscoveryRequest,
  RuleProposalProviderResponse,
  RuleProposalRequest,
} from '../extraction/provider.js';

/**
 * The AI provider port (§3).
 *
 * PalCert business logic depends on this interface and never on Anthropic. Not
 * for architectural symmetry — there is exactly one real adapter in Phase 8,
 * and no empty stubs were written to make the diagram look balanced — but
 * because a provider is a third party whose API, pricing, availability and
 * terms change on their schedule, not PalCert's. A compliance platform that
 * cannot change vendor without rewriting its domain has made someone else's
 * roadmap into its own.
 *
 * The contract is narrow on purpose: structured context in, validated
 * structured analysis out. No tools, no document bytes, no credentials, no
 * database, no callbacks (§21, §22, §99).
 */

export interface AIProviderCapabilities {
  readonly provider: string;
  readonly configuredModel: string;
  /** Whether `countTokens` is real here, or PalCert must estimate (§49). */
  readonly supportsTokenCounting: boolean;
  /** Whether the provider constrains output to a supplied JSON Schema (§53). */
  readonly supportsStructuredOutput: boolean;
  /** Whether this provider/model accepts an effort setting (§7). */
  readonly supportsEffort: boolean;
  readonly maxInputTokens: number;
  readonly maxOutputTokens: number;
}

export interface AITokenCountRequest {
  readonly signal?: AbortSignal;
  readonly purpose: AIInvocationPurpose;
  readonly systemPrompt: string;
  readonly userPrompt: string;
}

export interface AITokenCountResult {
  readonly inputTokens: number;
  /** False when the number is PalCert's own estimate rather than the provider's. */
  readonly exact: boolean;
}

/** What every provider call reports back about itself, for the ledger (§47). */
export interface AIProviderUsage {
  readonly providerRequestId: string | null;
  /** What the provider says it ran — not necessarily what was configured (§4). */
  readonly providerReturnedModel: string | null;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadTokens: number | null;
  readonly cacheWriteTokens: number | null;
  readonly latencyMs: number;
}

export interface AIRuleAssessmentRequest {
  /** Correlation only. The provider never resolves it against anything. */
  readonly reviewId: string;
  readonly context: AIContextBundle;
  readonly systemPrompt: string;
  readonly userPrompt: string;
  /** The exact rule codes that must come back — no more, no fewer (§35). */
  readonly requestedRuleCodes: readonly string[];
}

export interface AIRuleAssessmentProviderResponse {
  readonly output: AIRuleAssessmentResponse;
  readonly usage: AIProviderUsage;
}

export interface AIReportSupplementRequest {
  readonly reviewId: string;
  readonly systemPrompt: string;
  readonly userPrompt: string;
}

export interface AIReportSupplementProviderResponse {
  readonly output: AIReportSupplementResponse;
  readonly usage: AIProviderUsage;
}

/**
 * A provider failure in PalCert's own terms.
 *
 * Carries no provider stack trace and no response body: those reach the logs
 * and the user only as a stable code (§55, §81).
 */
export class AIProviderError extends Error {
  constructor(
    readonly kind: AIFailureKind,
    message: string,
    /** Seconds the provider asked us to wait, when it said (§56). */
    readonly retryAfterSeconds: number | null = null,
  ) {
    super(message);
    this.name = 'AIProviderError';
  }
}

/**
 * The port itself.
 *
 * An abstract class rather than an interface so Nest can inject it by token,
 * matching how every other port in the codebase is wired.
 */
export abstract class AIProviderPort {
  /** Formatting suggestions only: no executable code, XML, content rewrites or verdicts. */
  abstract proposeFormatting(request: AIFormattingRequest): Promise<{
    output: AIFormattingProposal;
    usage: AIProviderUsage;
  }>;
  abstract getCapabilities(): AIProviderCapabilities;

  /** Optional: absent where a provider offers no counting endpoint (§49). */
  abstract countTokens(request: AITokenCountRequest): Promise<AITokenCountResult>;

  abstract assessRules(request: AIRuleAssessmentRequest): Promise<AIRuleAssessmentProviderResponse>;

  abstract generateReportSupplement(
    request: AIReportSupplementRequest,
  ): Promise<AIReportSupplementProviderResponse>;

  /**
   * Bounded probe, for the AI-specific health surface only.
   *
   * Deliberately not part of the platform's own readiness: PalCert's
   * deterministic product must keep working when a provider does not (§57).
   */
  abstract checkAvailability(): Promise<{ ok: boolean; message?: string }>;

  // -------------------------------------------------------------------------
  // Rule extraction (Phase 9)
  //
  // Two calls rather than one, because the current provider API cannot serve
  // one: citations and structured outputs are mutually exclusive in a single
  // request. Evidence discovery needs grounded quotations; rule structuring
  // needs a constrained object. So they are separate calls with separate
  // contracts, and the separation is a stated architectural invariant rather
  // than an implementation detail (§23, §85, §138).
  // -------------------------------------------------------------------------

  /**
   * Pass A. Citations on, structured output off, no tools.
   *
   * Produces evidence and nothing else: a citation is the part of the response
   * that can be checked against the document, and the model's surrounding prose
   * is deliberately not persisted (§25, §86).
   */
  abstract discoverGuidelineEvidence(
    request: EvidenceDiscoveryRequest,
  ): Promise<EvidenceDiscoveryProviderResponse>;

  /**
   * Pass B. Structured output on, citations off, no tools.
   *
   * Receives only verified evidence and deterministic observations — never the
   * source document again (§103).
   */
  abstract extractRuleProposals(
    request: RuleProposalRequest,
  ): Promise<RuleProposalProviderResponse>;
}
