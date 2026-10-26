import { RULE_SEVERITY_WEIGHT, type RuleSeverity } from '../standards/rule-schema.js';

/**
 * The deterministic compliance score (§11–§14).
 *
 * Four decisions shape it, and each exists to stop a specific wrong number.
 *
 * **Only deterministic rules count.** An AI-assisted or manual rule has no
 * verdict in Phase 7, and a score that moved when one was added would be a
 * number nobody could reproduce from the evidence.
 *
 * **A rule counts once.** A body-font rule that failed in seventy-three
 * paragraphs is one failed rule with seventy-three violations, not
 * seventy-three failures. Weighting by violation count would let a single
 * formatting slip in a long document dominate every other requirement.
 *
 * **Arithmetic is exact.** Weights are integers and the score is a ratio, so
 * it is computed as a fraction and rendered as a decimal string. Binary
 * floating point would make a score a reader recomputes disagree in the last
 * digit, which for a compliance number is indefensible.
 *
 * **An unresolved rule is not a passed rule.** Unresolved deterministic weight
 * is tracked separately and reported as coverage, so "92%" can never be shown
 * as authoritative when a third of the requirements could not be evaluated
 * (§13).
 *
 * **Advisory rules are not scored at all** (Phase 18, Checkpoint 16). They are
 * always INDETERMINATE, so scoring them would report reduced coverage for a
 * standard whose authoritative rules were all evaluated — and the score is an
 * authoritative number, which means a non-authoritative rule must not be able
 * to move it in either direction. A standard of nothing but advisory rules
 * therefore has no score, which `null` already means: nothing scorable
 * resolved.
 */

export interface ScorableRule {
  readonly severity: RuleSeverity;
  readonly evaluationMode: 'DETERMINISTIC' | 'AI_ASSISTED' | 'MANUAL';
  readonly outcome: 'PASS' | 'FAIL' | 'NOT_APPLICABLE' | 'INDETERMINATE' | 'ERROR';
  /**
   * What kind of evidence produced the result (Phase 18, Checkpoint 16).
   *
   * Optional, and absent means authoritative — which is what every caller
   * predating advisory evidence meant.
   */
  readonly evidenceLevel?: string;
}

export interface DeterministicScore {
  /**
   * 0–100 as an exact decimal string, or null when nothing scorable resolved.
   *
   * Null is not zero. A standard made entirely of manual rules has no
   * deterministic score, and rendering that as 0% would be a failing grade for
   * a document PalCert never examined.
   */
  readonly value: string | null;
  /**
   * Resolved share of the scorable weight, 0–1, or null when nothing is
   * scorable at all.
   */
  readonly coverage: string | null;
  /** True only when no deterministic rule was left unresolved. */
  readonly complete: boolean;
  readonly passedWeight: string;
  readonly evaluatedWeight: string;
  readonly unresolvedWeight: string;
}

/** Exact rational arithmetic over small integers, rendered as a decimal. */
function ratioToDecimal(numerator: bigint, denominator: bigint, scale: number): string {
  if (denominator === 0n) return '0';
  const factor = 10n ** BigInt(scale);
  // Round half away from zero, computed in integers so the result never
  // depends on a floating-point representation.
  const scaled = (numerator * factor * 2n + denominator) / (denominator * 2n);
  const whole = scaled / factor;
  const fraction = scaled % factor;
  if (fraction === 0n) return whole.toString();
  const digits = fraction.toString().padStart(scale, '0').replace(/0+$/, '');
  return `${whole.toString()}.${digits}`;
}

/** How many fractional digits the score and coverage carry. */
export const SCORE_DECIMAL_PLACES = 4;

export function computeDeterministicScore(rules: readonly ScorableRule[]): DeterministicScore {
  let passedWeight = 0n;
  let evaluatedWeight = 0n;
  let unresolvedWeight = 0n;

  for (const rule of rules) {
    // AI-assisted and manual rules never contribute (§11).
    if (rule.evaluationMode !== 'DETERMINISTIC') continue;
    // Neither does advisory evidence, and for a sharper reason: the score and
    // its coverage are authoritative numbers. An advisory rule is always
    // INDETERMINATE, so counting it would land in `unresolvedWeight` and
    // report "coverage 0.5" for a standard whose authoritative half PalCert
    // evaluated completely — describing a heuristic detector's silence as a
    // failure to read the document.
    if (rule.evidenceLevel === 'ADVISORY') continue;

    const weight = BigInt(RULE_SEVERITY_WEIGHT[rule.severity]);
    // An INFO rule weighs nothing by design: it is advisory, and letting it
    // move the score would make advice indistinguishable from a requirement.
    if (weight === 0n) continue;

    switch (rule.outcome) {
      case 'PASS':
        passedWeight += weight;
        evaluatedWeight += weight;
        break;
      case 'FAIL':
        // Counted as evaluated but not passed: the rule was decided, badly.
        evaluatedWeight += weight;
        break;
      case 'NOT_APPLICABLE':
        // Excluded entirely. A rule that does not apply is not a rule this
        // document either met or missed.
        break;
      case 'INDETERMINATE':
      case 'ERROR':
        unresolvedWeight += weight;
        break;
    }
  }

  const scorableWeight = evaluatedWeight + unresolvedWeight;

  return {
    value:
      evaluatedWeight > 0n
        ? ratioToDecimal(passedWeight * 100n, evaluatedWeight, SCORE_DECIMAL_PLACES)
        : null,
    coverage:
      scorableWeight > 0n
        ? ratioToDecimal(evaluatedWeight, scorableWeight, SCORE_DECIMAL_PLACES)
        : null,
    complete: unresolvedWeight === 0n,
    passedWeight: passedWeight.toString(),
    evaluatedWeight: evaluatedWeight.toString(),
    unresolvedWeight: unresolvedWeight.toString(),
  };
}

/**
 * The score as a whole number for display, or null.
 *
 * Rounding happens here and nowhere else: the stored value keeps its precision
 * so a later audit can recompute it exactly (§12).
 */
export function scoreForDisplay(score: DeterministicScore): number | null {
  if (score.value === null) return null;
  return Math.round(Number(score.value));
}
