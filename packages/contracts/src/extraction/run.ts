/**
 * Rule extraction runs, evidence and proposals (Phase 9, §37, §38, §44, §65).
 *
 * The defining rule of the phase is one sentence: **AI proposes, an authorized
 * human decides.** Everything here is built so that sentence cannot be broken
 * by forgetting something.
 *
 * - An extraction run produces *proposals*, never rules.
 * - A proposal's AI content is immutable; the human decision is a separate row.
 * - A proposal can be accepted only through the ordinary Phase 3 rule path,
 *   with the ordinary Phase 3 validation, by someone with the permission.
 */

/**
 * How far the extraction got.
 *
 * Deliberately separate from proposal review status (§38): "the provider timed
 * out" and "a person has not looked at this yet" are unrelated facts, and a
 * single field would eventually be read as if they were the same one.
 */
export const RuleExtractionStatus = {
  CREATED: 'CREATED',
  QUEUED: 'QUEUED',
  DISCOVERING_EVIDENCE: 'DISCOVERING_EVIDENCE',
  GENERATING_PROPOSALS: 'GENERATING_PROPOSALS',
  VALIDATING: 'VALIDATING',
  COMPLETED: 'COMPLETED',
  FAILED: 'FAILED',
  CANCELLED: 'CANCELLED',
} as const;

export type RuleExtractionStatus = (typeof RuleExtractionStatus)[keyof typeof RuleExtractionStatus];

export const RULE_EXTRACTION_STATUSES: readonly RuleExtractionStatus[] =
  Object.values(RuleExtractionStatus);

export const RULE_EXTRACTION_TRANSITIONS: Readonly<
  Record<RuleExtractionStatus, readonly RuleExtractionStatus[]>
> = {
  CREATED: ['QUEUED', 'FAILED', 'CANCELLED'],
  QUEUED: ['DISCOVERING_EVIDENCE', 'FAILED', 'CANCELLED'],
  // Re-entrant: at-least-once delivery may re-claim a stage it already holds.
  DISCOVERING_EVIDENCE: ['DISCOVERING_EVIDENCE', 'GENERATING_PROPOSALS', 'FAILED'],
  GENERATING_PROPOSALS: ['GENERATING_PROPOSALS', 'VALIDATING', 'FAILED'],
  VALIDATING: ['VALIDATING', 'COMPLETED', 'FAILED'],
  // A finished run is history. A new model, prompt or source set is a new run
  // and never a rewrite of this one (§39).
  COMPLETED: [],
  FAILED: [],
  CANCELLED: [],
};

export function canTransitionExtraction(
  from: RuleExtractionStatus,
  to: RuleExtractionStatus,
): boolean {
  return RULE_EXTRACTION_TRANSITIONS[from].includes(to);
}

export const TERMINAL_EXTRACTION_STATUSES: readonly RuleExtractionStatus[] = [
  RuleExtractionStatus.COMPLETED,
  RuleExtractionStatus.FAILED,
  RuleExtractionStatus.CANCELLED,
];

export function isExtractionTerminal(status: RuleExtractionStatus): boolean {
  return TERMINAL_EXTRACTION_STATUSES.includes(status);
}

/** Only before the work has reached a provider (§106 of Phase 8, same reasoning). */
export function isExtractionCancellable(status: RuleExtractionStatus): boolean {
  return status === RuleExtractionStatus.CREATED || status === RuleExtractionStatus.QUEUED;
}

/** What one provider call inside an extraction was for (§80). */
export const ExtractionInvocationPurpose = {
  /** Pass A: citations on, structured output off. Produces evidence only. */
  GUIDELINE_EVIDENCE_DISCOVERY: 'GUIDELINE_EVIDENCE_DISCOVERY',
  /** Pass B: structured output on, citations off. Produces proposals. */
  GUIDELINE_RULE_STRUCTURING: 'GUIDELINE_RULE_STRUCTURING',
  /** Deterministic template observations turned into labelled proposals. */
  TEMPLATE_RULE_PROPOSAL: 'TEMPLATE_RULE_PROPOSAL',
} as const;

export type ExtractionInvocationPurpose =
  (typeof ExtractionInvocationPurpose)[keyof typeof ExtractionInvocationPurpose];

/**
 * Extraction-specific failures, alongside the Phase 8 provider failures.
 *
 * The Phase 8 `AIFailureKind` vocabulary is reused verbatim for anything that
 * happened at the provider; these describe things that went wrong on PalCert's
 * side of the boundary, where the remedy is different.
 */
export const ExtractionFailureKind = {
  /** A bound source is no longer READY, or its digest no longer matches (§120). */
  SOURCE_INTEGRITY_FAILED: 'SOURCE_INTEGRITY_FAILED',
  /** The source is larger than the provider or the configuration allows (§89). */
  SOURCE_TOO_LARGE: 'SOURCE_TOO_LARGE',
  /** A template source has no analysis to observe, so there is nothing to say. */
  ANALYSIS_UNAVAILABLE: 'ANALYSIS_UNAVAILABLE',
  /** Evidence discovery found nothing citable in any source. */
  NO_EVIDENCE_DISCOVERED: 'NO_EVIDENCE_DISCOVERED',
  /** One source finished and another failed; the run is not "complete" (§110). */
  PARTIAL_SOURCE_FAILURE: 'PARTIAL_SOURCE_FAILURE',
  /**
   * PalCert's own database could not commit the run's results in time or had
   * to abort the transaction (Prisma P2028, P2034). Infrastructure, never the
   * AI provider. Retried: every write is idempotent on its unique key.
   */
  DATABASE_TRANSACTION_FAILED: 'DATABASE_TRANSACTION_FAILED',
  /** PalCert's own database was unreachable. Infrastructure; retried. */
  DATABASE_UNAVAILABLE: 'DATABASE_UNAVAILABLE',
} as const;

export type ExtractionFailureKind =
  (typeof ExtractionFailureKind)[keyof typeof ExtractionFailureKind];

export const EXTRACTION_FAILURE_KINDS: readonly ExtractionFailureKind[] =
  Object.values(ExtractionFailureKind);

// ---------------------------------------------------------------------------
// Evidence
// ---------------------------------------------------------------------------

/**
 * What kind of thing the evidence is, which decides how far it may be trusted.
 *
 * `EXPLICIT_TEXT` is a quotation the provider grounded in a citation. Nothing
 * else is — and in particular a `TEMPLATE_OBSERVATION` is a measurement of one
 * document, not a statement of policy (§4).
 */
export const EvidenceKind = {
  /** A cited passage of a normative document. Provider-grounded (§25). */
  EXPLICIT_TEXT: 'EXPLICIT_TEXT',
  /**
   * Something readable only in the page's layout, with no text citation to
   * anchor it. Weaker provenance, and labelled as such rather than dressed up
   * as a quotation (§87).
   */
  VISUAL_EVIDENCE: 'VISUAL_EVIDENCE',
  /** A deterministic measurement of a template. Never a requirement (§33). */
  TEMPLATE_OBSERVATION: 'TEMPLATE_OBSERVATION',
} as const;

export type EvidenceKind = (typeof EvidenceKind)[keyof typeof EvidenceKind];

export const EVIDENCE_KINDS: readonly EvidenceKind[] = Object.values(EvidenceKind);

/** Where in its source a piece of evidence sits. */
export const EvidenceLocatorType = {
  /** 1-based page range, from a provider `page_location` citation. */
  PDF_PAGE: 'PDF_PAGE',
  /** PalCert node ids, from a provider `content_block_location` citation. */
  DOCX_NODE: 'DOCX_NODE',
  /** Character range, from a provider `char_location` citation. */
  TEXT_CHAR: 'TEXT_CHAR',
  /** A fact scope, for a deterministic template observation. */
  FACT_SCOPE: 'FACT_SCOPE',
  /** Nothing precise. Only legitimate for VISUAL_EVIDENCE (§88). */
  NONE: 'NONE',
} as const;

export type EvidenceLocatorType = (typeof EvidenceLocatorType)[keyof typeof EvidenceLocatorType];

export const EVIDENCE_LOCATOR_TYPES: readonly EvidenceLocatorType[] =
  Object.values(EvidenceLocatorType);

// ---------------------------------------------------------------------------
// Template observations
// ---------------------------------------------------------------------------

/**
 * How consistent a template is about one property.
 *
 * This is the honest replacement for a confidence number (§34). "187 of 196
 * body paragraphs are 12 pt" is a fact a reviewer can act on; "confidence 0.93"
 * is a number that means nothing and invites them not to look.
 */
export const ObservationUniformity = {
  /** Every occurrence agrees. */
  UNIFORM: 'UNIFORM',
  /** One value dominates, with a few exceptions. */
  MOSTLY_UNIFORM: 'MOSTLY_UNIFORM',
  /** No value dominates. Proposing a requirement from this would be invention. */
  MIXED: 'MIXED',
  /** Too few occurrences to say anything at all. */
  INSUFFICIENT_SAMPLE: 'INSUFFICIENT_SAMPLE',
} as const;

export type ObservationUniformity =
  (typeof ObservationUniformity)[keyof typeof ObservationUniformity];

export const OBSERVATION_UNIFORMITIES: readonly ObservationUniformity[] =
  Object.values(ObservationUniformity);

/**
 * The thresholds, written once and applied everywhere.
 *
 * Deterministic by construction: the same template always produces the same
 * uniformity, which is what makes template observations testable without a
 * model in the loop.
 */
export const OBSERVATION_THRESHOLDS = {
  /** Below this many occurrences, nothing is claimed. */
  minimumSample: 3,
  /** Share of occurrences matching the modal value for MOSTLY_UNIFORM. */
  mostlyUniformShare: 0.9,
} as const;

export function classifyUniformity(
  occurrenceCount: number,
  matchingCount: number,
): ObservationUniformity {
  if (occurrenceCount < OBSERVATION_THRESHOLDS.minimumSample) {
    return ObservationUniformity.INSUFFICIENT_SAMPLE;
  }
  if (matchingCount === occurrenceCount) return ObservationUniformity.UNIFORM;
  if (matchingCount / occurrenceCount >= OBSERVATION_THRESHOLDS.mostlyUniformShare) {
    return ObservationUniformity.MOSTLY_UNIFORM;
  }
  return ObservationUniformity.MIXED;
}

/**
 * Whether an observation is consistent enough to be worth proposing at all.
 *
 * A MIXED template is evidence that the institution has *not* settled on a
 * value. Turning the modal value into a requirement anyway would be PalCert
 * inventing policy (§33).
 */
export function isProposableObservation(uniformity: ObservationUniformity): boolean {
  return (
    uniformity === ObservationUniformity.UNIFORM ||
    uniformity === ObservationUniformity.MOSTLY_UNIFORM
  );
}

// ---------------------------------------------------------------------------
// Proposals
// ---------------------------------------------------------------------------

/**
 * How much authority the source gives a proposal, and what PalCert can do with
 * it (§44).
 *
 * Not every extracted requirement becomes a usable rule, and pretending
 * otherwise is how a system quietly discards the requirements it cannot
 * represent (§48, §53).
 */
export const RuleProposalKind = {
  /** The source states it. Must cite grounded evidence (§54, §160). */
  EXPLICIT_REQUIREMENT: 'EXPLICIT_REQUIREMENT',
  /** A template does it consistently. Provenance is inference, not policy (§46). */
  TEMPLATE_INFERENCE: 'TEMPLATE_INFERENCE',
  /** The source requires *something* but does not say what (§47). */
  AMBIGUOUS_REQUIREMENT: 'AMBIGUOUS_REQUIREMENT',
  /** Two sources require incompatible things. PalCert does not pick (§62). */
  CONFLICTING_REQUIREMENT: 'CONFLICTING_REQUIREMENT',
  /** A real requirement the rule schema cannot express (§48). */
  UNREPRESENTABLE_REQUIREMENT: 'UNREPRESENTABLE_REQUIREMENT',
} as const;

export type RuleProposalKind = (typeof RuleProposalKind)[keyof typeof RuleProposalKind];

export const RULE_PROPOSAL_KINDS: readonly RuleProposalKind[] = Object.values(RuleProposalKind);

/** Kinds that must carry a concrete rule definition to be acceptable. */
export const PROPOSAL_KINDS_REQUIRING_RULE: readonly RuleProposalKind[] = [
  RuleProposalKind.EXPLICIT_REQUIREMENT,
  RuleProposalKind.TEMPLATE_INFERENCE,
];

export function proposalRequiresRuleDefinition(kind: RuleProposalKind): boolean {
  return PROPOSAL_KINDS_REQUIRING_RULE.includes(kind);
}

/**
 * Kinds a human may accept into the draft.
 *
 * An ambiguous, conflicting or unrepresentable proposal is information for the
 * reviewer, not a rule waiting to be clicked. Accepting one would mean PalCert
 * had decided something it explicitly said it could not.
 */
export function proposalIsAcceptable(kind: RuleProposalKind): boolean {
  return proposalRequiresRuleDefinition(kind);
}

/**
 * Where the AI's proposal stands with the human reviewer.
 *
 * Separate from the extraction's own status, and separate from the proposal
 * content, which never changes (§65).
 */
export const RuleProposalStatus = {
  PENDING_REVIEW: 'PENDING_REVIEW',
  ACCEPTED: 'ACCEPTED',
  MODIFIED_AND_ACCEPTED: 'MODIFIED_AND_ACCEPTED',
  REJECTED: 'REJECTED',
  /** A later run covered the same ground; kept for history, not for action. */
  SUPERSEDED: 'SUPERSEDED',
} as const;

export type RuleProposalStatus = (typeof RuleProposalStatus)[keyof typeof RuleProposalStatus];

export const RULE_PROPOSAL_STATUSES: readonly RuleProposalStatus[] =
  Object.values(RuleProposalStatus);

export function isProposalDecided(status: RuleProposalStatus): boolean {
  return status !== RuleProposalStatus.PENDING_REVIEW;
}

/** Why a reviewer said no. Useful product feedback; never sent to a provider (§70). */
export const ProposalRejectionReason = {
  NOT_A_REQUIREMENT: 'NOT_A_REQUIREMENT',
  DUPLICATE: 'DUPLICATE',
  SOURCE_OUTDATED: 'SOURCE_OUTDATED',
  INCORRECT_INTERPRETATION: 'INCORRECT_INTERPRETATION',
  AMBIGUOUS: 'AMBIGUOUS',
  NOT_APPLICABLE: 'NOT_APPLICABLE',
  OTHER: 'OTHER',
} as const;

export type ProposalRejectionReason =
  (typeof ProposalRejectionReason)[keyof typeof ProposalRejectionReason];

export const PROPOSAL_REJECTION_REASONS: readonly ProposalRejectionReason[] =
  Object.values(ProposalRejectionReason);

/**
 * Whether PalCert can actually measure the proposed rule today (§52, §53).
 *
 * PalCert-derived from the analyzer's own property catalogue, never taken from
 * the model. A requirement PalCert cannot check is still a real requirement and
 * is shown as one — the honest answer is "found, not yet automatable", not
 * silence.
 */
export const AutomationSupport = {
  SUPPORTED_DOCX: 'SUPPORTED_DOCX',
  PARTIAL_DOCX: 'PARTIAL_DOCX',
  NOT_CURRENTLY_MEASURABLE: 'NOT_CURRENTLY_MEASURABLE',
  /** The rule is not deterministic, so analyzer coverage is not the question. */
  NOT_APPLICABLE: 'NOT_APPLICABLE',
} as const;

export type AutomationSupport = (typeof AutomationSupport)[keyof typeof AutomationSupport];

export const AUTOMATION_SUPPORTS: readonly AutomationSupport[] = Object.values(AutomationSupport);

/** Whether a proposal collides with something already in the draft (§61). */
export const ProposalConflictStatus = {
  NONE: 'NONE',
  /** A draft rule already uses the proposed rule code. */
  EXISTING_RULE_CODE: 'EXISTING_RULE_CODE',
  /** A draft rule measures the same thing with an incompatible expectation. */
  EXISTING_RULE_EXPECTATION: 'EXISTING_RULE_EXPECTATION',
  /** Two sources disagree. PalCert does not choose between them (§62, §63). */
  CROSS_SOURCE: 'CROSS_SOURCE',
} as const;

export type ProposalConflictStatus =
  (typeof ProposalConflictStatus)[keyof typeof ProposalConflictStatus];

export const PROPOSAL_CONFLICT_STATUSES: readonly ProposalConflictStatus[] =
  Object.values(ProposalConflictStatus);

/** Whether PalCert's own validation accepted the AI's rule definition (§58, §59). */
export const ProposalValidationStatus = {
  VALID: 'VALID',
  /** Structurally well-formed AI output carrying a rule the schema refuses. */
  INVALID: 'INVALID',
  /** No rule definition was offered, and none was required for this kind. */
  NOT_APPLICABLE: 'NOT_APPLICABLE',
} as const;

export type ProposalValidationStatus =
  (typeof ProposalValidationStatus)[keyof typeof ProposalValidationStatus];

export const PROPOSAL_VALIDATION_STATUSES: readonly ProposalValidationStatus[] =
  Object.values(ProposalValidationStatus);

/**
 * Whether a proposal may be accepted as it stands (§75).
 *
 * Every condition is one a reviewer would otherwise have to check by eye, and
 * the same function gates single acceptance and bulk acceptance, so the two can
 * never drift apart.
 */
export function proposalIsReadyToAccept(proposal: {
  readonly kind: RuleProposalKind;
  readonly status: RuleProposalStatus;
  readonly validationStatus: ProposalValidationStatus;
  readonly conflictStatus: ProposalConflictStatus;
}): boolean {
  return (
    proposal.status === RuleProposalStatus.PENDING_REVIEW &&
    proposalIsAcceptable(proposal.kind) &&
    proposal.validationStatus === ProposalValidationStatus.VALID &&
    proposal.conflictStatus === ProposalConflictStatus.NONE
  );
}

// ---------------------------------------------------------------------------
// Versions
// ---------------------------------------------------------------------------

export const EXTRACTION_SCHEMA_VERSION = 1;
export const PROPOSAL_SCHEMA_VERSION = 1;
export const EXTRACTION_CANONICALIZATION_VERSION = 1;
export const EXTRACTION_CONTEXT_BUILDER_VERSION = '1';

/** The queue key for one extraction, so a duplicate delivery is a no-op (§113). */
export function extractionJobKey(runId: string): string {
  return `rule-extraction:${runId}`;
}
