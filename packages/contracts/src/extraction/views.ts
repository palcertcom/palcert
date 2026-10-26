import type {
  AutomationSupport,
  EvidenceKind,
  EvidenceLocatorType,
  ObservationUniformity,
  ProposalConflictStatus,
  ProposalRejectionReason,
  ProposalValidationStatus,
  RuleExtractionStatus,
  RuleProposalKind,
  RuleProposalStatus,
} from './run.js';
import type {
  StandardSourceAuthority,
  StandardSourceKind,
  StandardSourceStatus,
} from './source.js';

/**
 * What Phase 9 returns over HTTP (§131, §132).
 *
 * Three things are deliberately absent from every shape here: the raw provider
 * response, the prompt, and any provider file identifier. An organization sees
 * what PalCert concluded and the evidence it rests on — never PalCert's own
 * conversation with a third party.
 */

export interface StandardSourceView {
  readonly id: string;
  readonly standardVersionId: string;
  readonly sourceKind: StandardSourceKind;
  readonly status: StandardSourceStatus;
  readonly authority: StandardSourceAuthority | null;
  readonly originalFilename: string;
  readonly declaredMimeType: string | null;
  readonly detectedMimeType: string | null;
  readonly detectedFormat: string | null;
  readonly sizeBytes: number | null;
  readonly sha256: string | null;
  readonly pageCount: number | null;
  readonly rejectionCode: string | null;
  readonly failureCode: string | null;
  readonly retryable: boolean;
  /** True once accepted-rule provenance depends on it, so it cannot be deleted (§101). */
  readonly retentionLocked: boolean;
  /**
   * Legacy equation objects (MathType, Equation 3.0) the ingest accepted in
   * safe mode — classified structurally, kept with their previews, never
   * executed. Zero for everything else.
   */
  readonly legacyEquationCount: number;
  readonly uploadExpiresAt: string | null;
  readonly uploadedByUserId: string | null;
  readonly createdAt: string;
  readonly readyAt: string | null;
  readonly rejectedAt: string | null;
  readonly failedAt: string | null;
}

export interface CreateStandardSourceResponse {
  readonly source: StandardSourceView;
  readonly upload: {
    readonly method: 'PUT';
    readonly url: string;
    readonly headers: Readonly<Record<string, string>>;
    readonly expiresAt: string;
  };
}

export interface OrganizationAIConsentView {
  readonly granted: boolean;
  readonly consentVersion: string | null;
  readonly providerCategory: string | null;
  readonly acceptedAt: string | null;
  readonly acceptedByUserId: string | null;
  /** True when the notice changed since the organization last agreed (§15). */
  readonly renewalRequired: boolean;
}

export interface ExtractionUsageView {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly invocationCount: number;
}

export interface ExtractionSummaryView {
  readonly sourcesProcessed: number;
  readonly evidenceBlocks: number;
  readonly templateObservations: number;
  readonly explicitRequirementProposals: number;
  readonly templateInferenceProposals: number;
  readonly ambiguousRequirements: number;
  readonly conflictingRequirements: number;
  readonly unrepresentableRequirements: number;
  readonly invalidProposals: number;
}

export interface RuleExtractionRunView {
  readonly id: string;
  readonly standardVersionId: string;
  readonly status: RuleExtractionStatus;
  readonly failureKind: string | null;
  readonly baseStandardRevision: number;
  readonly provider: string;
  readonly configuredModel: string;
  readonly providerReturnedModel: string | null;
  readonly promptVersion: string;
  readonly contextBuilderVersion: string;
  readonly proposalSchemaVersion: number;
  readonly sourceSetHash: string;
  readonly extractionRunHash: string | null;
  readonly sourceAssetIds: readonly string[];
  readonly summary: ExtractionSummaryView | null;
  readonly usage: ExtractionUsageView | null;
  readonly createdByUserId: string | null;
  readonly createdAt: string;
  readonly startedAt: string | null;
  readonly completedAt: string | null;
  readonly failedAt: string | null;
}

export interface SourceEvidenceView {
  readonly id: string;
  readonly sourceAssetId: string;
  readonly sourceKind: StandardSourceKind;
  readonly sourceFilename: string;
  readonly evidenceKind: EvidenceKind;
  readonly locatorType: EvidenceLocatorType;
  readonly startPage: number | null;
  readonly endPage: number | null;
  readonly nodeIds: readonly string[];
  readonly startCharIndex: number | null;
  readonly endCharIndex: number | null;
  /** Bounded, escaped on render. Never raw HTML (§152). */
  readonly excerpt: string;
  readonly excerptHash: string;
}

export interface TemplateObservationView {
  readonly id: string;
  readonly sourceAssetId: string;
  readonly sourceFilename: string;
  readonly scopeKey: string;
  readonly scope: unknown;
  readonly property: string;
  readonly unit: string | null;
  readonly modalValue: string | null;
  readonly occurrenceCount: number;
  readonly matchingCount: number;
  readonly distinctValueCount: number;
  readonly uniformity: ObservationUniformity;
  /** The top few observed values and their counts. Bounded (§135). */
  readonly distribution: readonly { readonly value: string; readonly count: number }[];
  readonly observationHash: string;
}

export interface ProposalValidationIssueView {
  readonly path: string;
  readonly message: string;
}

export interface RuleProposalConflictView {
  readonly status: ProposalConflictStatus;
  /** The draft rule this collides with, when there is one. */
  readonly existingRuleId: string | null;
  readonly existingRuleCode: string | null;
  /** The other proposals involved in a cross-source disagreement (§62). */
  readonly relatedProposalIds: readonly string[];
  readonly detail: string | null;
}

export interface RuleProposalView {
  readonly id: string;
  readonly extractionRunId: string;
  readonly proposalKey: string;
  readonly kind: RuleProposalKind;
  readonly status: RuleProposalStatus;
  readonly validationStatus: ProposalValidationStatus;
  readonly validationIssues: readonly ProposalValidationIssueView[];
  readonly automationSupport: AutomationSupport;
  readonly conflict: RuleProposalConflictView;
  /** The AI's suggested rule, exactly as proposed. Never edited in place (§65). */
  readonly suggestedRule: unknown | null;
  readonly suggestedRuleCode: string | null;
  readonly interpretationEn: string;
  readonly interpretationAr: string;
  readonly ambiguityNote: string | null;
  readonly requiresClarification: boolean;
  readonly evidenceIds: readonly string[];
  readonly observationIds: readonly string[];
  readonly displayOrder: number;
  readonly decision: RuleProposalDecisionView | null;
  /**
   * What a review table needs about the proposal's grounding, without a
   * request per row: where it came from and, for a template inference, what
   * was measured. Present on the list; the detail view carries the full
   * evidence instead.
   */
  readonly summary?: RuleProposalSummaryView;
}

export interface RuleProposalSummaryView {
  /** The sources the proposal's evidence and observations belong to. */
  readonly sources: readonly {
    readonly sourceAssetId: string;
    readonly sourceFilename: string;
    readonly sourceKind: StandardSourceKind;
  }[];
  readonly evidenceCount: number;
  readonly observationCount: number;
  /** The first cited observation, by stored order. Null for a proposal with none. */
  readonly observation: {
    readonly property: string;
    readonly unit: string | null;
    readonly modalValue: string | null;
    readonly occurrenceCount: number;
    readonly matchingCount: number;
    readonly uniformity: ObservationUniformity;
  } | null;
}

export interface RuleProposalDecisionView {
  readonly decision: RuleProposalStatus;
  readonly reviewedByUserId: string | null;
  readonly reviewedAt: string;
  readonly resultingRuleId: string | null;
  readonly rejectionReason: ProposalRejectionReason | null;
  readonly reviewNotes: string | null;
  /** What the human actually accepted, when they changed it (§68). */
  readonly acceptedRule: unknown | null;
}

export interface RuleProposalDetailView extends RuleProposalView {
  readonly evidence: readonly SourceEvidenceView[];
  readonly observations: readonly TemplateObservationView[];
}

/** One accepted rule's provenance, for "where did this rule come from?" (§76). */
export interface RuleProvenanceView {
  readonly standardRuleId: string;
  readonly extractionRunId: string;
  readonly proposalId: string;
  readonly sourceAssetId: string;
  readonly sourceFilename: string;
  readonly sourceKind: StandardSourceKind;
  readonly sourceSha256: string;
  readonly evidenceKind: EvidenceKind;
  readonly locatorType: EvidenceLocatorType;
  readonly startPage: number | null;
  readonly endPage: number | null;
  readonly nodeIds: readonly string[];
  readonly createdAt: string;
}

/** Counters for the version page (§156). */
export interface StandardVersionExtractionCountersView {
  readonly sources: number;
  readonly extractionRuns: number;
  readonly pendingProposals: number;
  readonly acceptedProposals: number;
  readonly rejectedProposals: number;
  readonly conflicts: number;
}

/**
 * Where a running extraction has got to, derived from what is stored: the run's
 * status, its provider invocations and the evidence it has persisted. Nothing
 * here is estimated from elapsed time, so a page that reloads reads the same
 * answer (and a total that is not yet known is null, never a guess).
 */
export const ExtractionProgressStage = {
  PREPARING_SOURCE: 'PREPARING_SOURCE',
  ANALYSING_SOURCE: 'ANALYSING_SOURCE',
  MEASURING_TEMPLATE: 'MEASURING_TEMPLATE',
  GENERATING_PROPOSALS: 'GENERATING_PROPOSALS',
  /** Validation and saving commit together, in one step. */
  VALIDATING: 'VALIDATING',
  COMPLETED: 'COMPLETED',
  FAILED: 'FAILED',
  CANCELLED: 'CANCELLED',
} as const;

export type ExtractionProgressStage =
  (typeof ExtractionProgressStage)[keyof typeof ExtractionProgressStage];

export interface ExtractionProgressView {
  readonly runId: string;
  readonly status: RuleExtractionStatus;
  readonly stage: ExtractionProgressStage;
  readonly failureKind: string | null;
  /** Proposal-generation calls settled in the current attempt. */
  readonly completedBatches: number;
  /**
   * How many proposal-generation calls the stored evidence divides into. Null
   * until that evidence is saved. Generation may stop early when the run's
   * proposal cap is reached; a finished run reports the calls it made.
   */
  readonly totalBatches: number | null;
  readonly successfulBatches: number;
  readonly failedBatches: number;
  /** Null until evidence is saved. */
  readonly evidenceCount: number | null;
  readonly observationCount: number | null;
  /** Null until the proposals are saved, which happens all at once. */
  readonly proposalCount: number | null;
  readonly elapsedSeconds: number | null;
  readonly cancellable: boolean;
  readonly startedAt: string | null;
  readonly finishedAt: string | null;
}

/** How many proposal-generation calls Pass B makes for a given amount of evidence. */
export function ruleStructuringBatchCount(input: {
  readonly items: number;
  readonly maxRulesPerRequest: number;
}): number {
  // Mirrors the worker's Pass B batching: at most half the per-call proposal
  // budget in items, and one call even when there is nothing to send.
  const itemsPerCall = Math.max(1, Math.ceil(input.maxRulesPerRequest / 2));
  return Math.max(1, Math.ceil(input.items / itemsPerCall));
}
