import { EvidenceLevelValue } from '../evaluation/constants.js';
import { ComplianceDetermination } from './check.js';

/**
 * Turning rule outcomes into one answer (§8, §9).
 *
 * The precedence is fixed and tested, because "which of these problems wins?"
 * must have exactly one answer for the same inputs for ever:
 *
 *   1. a definitive blocking FAIL          → NON_COMPLIANT
 *   2. blocking deterministic evidence
 *      that could not decide               → INDETERMINATE
 *   3. a blocking AI or manual rule
 *      still unresolved                    → REVIEW_REQUIRED
 *   4. otherwise                           → COMPLIANT
 *
 * A failure outranks an unresolved review because a document that already
 * breaks a blocking requirement does not become undecided by also having
 * something to review. Unresolved evidence outranks a pending review because
 * PalCert not being able to read the document is a stronger statement about
 * the result than a rule waiting for a human.
 *
 * Nothing is hidden by this ordering: every unresolved item is still counted
 * and reported separately (§9), so a NON_COMPLIANT result still tells the user
 * what else needs review.
 *
 * **Advisory results take no part in any of it** (Phase 18, Checkpoint 16).
 * A rule whose facts PalCert recognized rather than read is reported and
 * counted, and it enters none of the four cases above. Checkpoint 15 made such
 * a rule INDETERMINATE, which is the right verdict for the *rule*; treating it
 * as unresolved deterministic evidence then let a heuristic detector's failure
 * to recognize a citation style withhold an otherwise earned certificate. That
 * is not a safety property, it is a false negative — and the asymmetry the
 * design actually wants is that advisory evidence can neither grant a
 * determination nor take one away.
 *
 * The one thing advisory evidence does decide is the case where there is
 * nothing else: a standard with results but no authoritative ones is
 * INDETERMINATE, never COMPLIANT. Nothing authoritative was checked, so there
 * is nothing to be compliant with, and COMPLIANT there would be the most
 * dangerous answer in the system — a certificate earned by a standard that
 * decided nothing.
 */
export interface RuleOutcomeSummary {
  readonly outcome: 'PASS' | 'FAIL' | 'NOT_APPLICABLE' | 'INDETERMINATE' | 'ERROR';
  readonly blocking: boolean;
  readonly evaluationMode: 'DETERMINISTIC' | 'AI_ASSISTED' | 'MANUAL';
  readonly requiresReview: boolean;
  /**
   * What kind of evidence produced the result.
   *
   * Optional so a caller that predates Phase 18 keeps working, and absent is
   * read as authoritative — which is what every such caller meant. Only
   * `ADVISORY` changes anything here.
   */
  readonly evidenceLevel?: string;
}

export interface DeterminationInput {
  readonly results: readonly RuleOutcomeSummary[];
}

export interface DeterminationResult {
  readonly determination: ComplianceDetermination;
  /** Rules awaiting a human or a later AI phase, blocking or not (§10). */
  readonly pendingReviewCount: number;
  readonly blockingPendingReviewCount: number;
  /** Deterministic rules whose evidence could not decide. */
  readonly unresolvedDeterministicCount: number;
  readonly blockingFailureCount: number;
  /**
   * Rules answered from advisory evidence, counted and never aggregated.
   *
   * Reported so a reader can see that observations were made, without any of
   * them having moved the determination.
   */
  readonly advisoryCount: number;
}

/**
 * Was this answered from evidence PalCert read, rather than recognized?
 *
 * Absent means authoritative: `evidenceLevel` is optional on this input and
 * every caller that omits it predates advisory evidence entirely. Only the one
 * explicit value is non-authoritative here, because NONE and AI_PROVISIONAL
 * attach to outcomes this function's callers already handle by other means.
 */
function isAuthoritative(result: RuleOutcomeSummary): boolean {
  return result.evidenceLevel !== EvidenceLevelValue.ADVISORY;
}

/** Is this a rule PalCert itself decides, rather than one awaiting review? */
function isDeterministic(result: RuleOutcomeSummary): boolean {
  return result.evaluationMode === 'DETERMINISTIC';
}

/**
 * A rule that is waiting for something PalCert cannot supply yet.
 *
 * Phase 4 marks every AI-assisted and manual rule this way. Phase 7 resolves
 * none of them, and must never pretend otherwise (§82, §120).
 */
function isPendingReview(result: RuleOutcomeSummary): boolean {
  return result.requiresReview && !isDeterministic(result);
}

/**
 * Deterministic evidence that did not decide.
 *
 * `ERROR` counts here too: the engine failing on one rule is not the document's
 * fault, and it certainly is not a pass.
 */
function isUnresolvedDeterministic(result: RuleOutcomeSummary): boolean {
  return (
    isDeterministic(result) && (result.outcome === 'INDETERMINATE' || result.outcome === 'ERROR')
  );
}

export function determineCompliance(input: DeterminationInput): DeterminationResult {
  let blockingFailureCount = 0;
  let blockingUnresolvedDeterministic = 0;
  let unresolvedDeterministicCount = 0;
  let pendingReviewCount = 0;
  let blockingPendingReviewCount = 0;

  let advisoryCount = 0;
  let authoritativeCount = 0;

  for (const result of input.results) {
    if (!isAuthoritative(result)) {
      // Counted, reported, and aggregated into nothing. `blocking` is
      // deliberately not consulted: rule validation refuses a blocking
      // advisory rule outright, so one arriving here is historical content or
      // a caller bypassing validation, and honouring it would reintroduce
      // exactly the withheld certificate this checkpoint removed.
      advisoryCount += 1;
      continue;
    }
    authoritativeCount += 1;

    if (result.outcome === 'FAIL') {
      // Only a *deterministic* FAIL is definitive. Phase 4 never produces a
      // FAIL for an AI or manual rule, but guarding here means a future
      // provisional verdict cannot silently become a certification failure.
      if (result.blocking && isDeterministic(result)) blockingFailureCount += 1;
      continue;
    }

    if (isUnresolvedDeterministic(result)) {
      unresolvedDeterministicCount += 1;
      if (result.blocking) blockingUnresolvedDeterministic += 1;
      continue;
    }

    if (isPendingReview(result)) {
      pendingReviewCount += 1;
      if (result.blocking) blockingPendingReviewCount += 1;
    }
  }

  // Nothing authoritative was evaluated, although rules were. Not COMPLIANT:
  // there is nothing to have complied with. Expressed with the existing
  // INDETERMINATE rather than a new status, because that is exactly what it
  // means — "the evidence or the evaluator cannot decide" — and a status
  // invented for this case would need its own handling everywhere a
  // determination is read.
  const nothingAuthoritative = input.results.length > 0 && authoritativeCount === 0;

  const determination =
    blockingFailureCount > 0
      ? ComplianceDetermination.NON_COMPLIANT
      : blockingUnresolvedDeterministic > 0 || nothingAuthoritative
        ? ComplianceDetermination.INDETERMINATE
        : blockingPendingReviewCount > 0
          ? ComplianceDetermination.REVIEW_REQUIRED
          : ComplianceDetermination.COMPLIANT;

  return {
    determination,
    pendingReviewCount,
    blockingPendingReviewCount,
    unresolvedDeterministicCount,
    blockingFailureCount,
    advisoryCount,
  };
}
