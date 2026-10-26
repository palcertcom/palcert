import type { DocumentFormat } from '../documents/document.js';
import {
  isAuthoritativeSupport,
  type PropertySupport,
  supportFor,
  supportNoteFor,
} from './property-support.js';

/**
 * What a standard can actually be checked for against one document format
 * (Phase 13 §63-§66).
 *
 * The point of computing this before payment is that "we support PDF" and "we
 * can answer *your* standard's rules from a PDF" are different claims, and
 * only the second one is worth money. A thesis standard that is mostly about
 * margins and styles has almost nothing a PDF can answer; one about page size,
 * fonts and page counts has nearly everything.
 *
 * Two deliberate refusals live here:
 *
 * * The preview is **static**: it is computed from the standard's rules and
 *   the property support registry, without opening the document. A user must
 *   be able to see it before deciding to pay, and opening the document is the
 *   work they have not paid for yet (§63).
 * * It never promises **full** coverage. Even a fully supported standard can
 *   come back INDETERMINATE on a scan, and the preview says so rather than
 *   implying a result (§64).
 */

/** One rule's prospects, as far as the format alone decides them. */
export interface RuleCompatibility {
  readonly ruleCode: string;
  readonly property: string;
  readonly support: PropertySupport;
  /** Why, in the registry's own words. Shown to the user, so never a code. */
  readonly note: string;
}

export type CompatibilityLevel =
  /** Every rule maps to a property this format can answer authoritatively. */
  | 'FULL'
  /** Some rules can be answered; the rest will be INDETERMINATE. */
  | 'PARTIAL'
  /** Nothing in this standard can be answered from this format. */
  | 'NONE';

export interface StandardFormatCompatibility {
  readonly format: DocumentFormat;
  readonly level: CompatibilityLevel;
  readonly totalRules: number;
  readonly supportedRules: number;
  readonly unsupportedRules: number;
  /**
   * Rules resting on ADVISORY properties (Phase 18, Checkpoint 15).
   *
   * Counted separately from both `supportedRules` and `unsupportedRules`, and
   * the three add up to `totalRules`. An advisory rule is neither: the format
   * has something to say about it and will never decide it, so folding it into
   * either number would misstate what the user is about to pay for.
   */
  readonly advisoryRules: number;
  /** Every rule, so the UI can list what will and will not be checked. */
  readonly rules: readonly RuleCompatibility[];
  /** Distinct properties the format cannot answer, for a compact summary. */
  readonly unsupportedProperties: readonly string[];
  /** Distinct properties the format can only observe, never decide. */
  readonly advisoryProperties: readonly string[];
}

/** The property a rule is about, as the published snapshot records it. */
export interface CompatibilityRuleInput {
  readonly ruleCode: string;
  readonly scope: { readonly property?: string | null };
}

/**
 * Compute one standard's compatibility with one format.
 *
 * A rule with no property is counted as unsupported rather than skipped: a
 * rule PalCert cannot map to a measurement is a rule it cannot answer, and
 * quietly dropping it from the denominator would inflate the percentage the
 * user reads before paying.
 */
export function compatibilityFor(
  format: DocumentFormat,
  rules: readonly CompatibilityRuleInput[],
): StandardFormatCompatibility {
  const entries: RuleCompatibility[] = rules.map((rule) => {
    const property = rule.scope.property ?? '';
    const support = property === '' ? 'UNSUPPORTED' : supportFor(format, property);
    return {
      ruleCode: rule.ruleCode,
      property,
      support,
      note:
        property === ''
          ? 'This rule is not about a measurable document property.'
          : (supportNoteFor(format, property) ?? 'This property is not in the support registry.'),
    };
  });

  // Three disjoint buckets, not two. An ADVISORY rule used to be impossible;
  // now it is a rule the format can observe and can never decide, and calling
  // it "supported" would let a standard made entirely of advisory rules read
  // as FULL — the single most misleading thing this preview could say, because
  // it is the number shown to somebody deciding whether to pay.
  const supported = entries.filter((entry) => isAuthoritativeSupport(entry.support));
  const advisory = entries.filter((entry) => entry.support === 'ADVISORY');
  const unsupported = entries.filter((entry) => entry.support === 'UNSUPPORTED');

  let level: CompatibilityLevel;
  if (entries.length === 0 || supported.length === 0) {
    // No authoritative rule at all. Advisory observations do not rescue this:
    // nothing in the standard can be *answered* from this format.
    level = 'NONE';
  } else if (unsupported.length === 0 && advisory.length === 0) {
    level = 'FULL';
  } else {
    level = 'PARTIAL';
  }

  return {
    format,
    level,
    totalRules: entries.length,
    supportedRules: supported.length,
    unsupportedRules: unsupported.length,
    advisoryRules: advisory.length,
    rules: entries,
    unsupportedProperties: [
      ...new Set(unsupported.map((entry) => entry.property).filter((name) => name !== '')),
    ].sort(),
    advisoryProperties: [
      ...new Set(advisory.map((entry) => entry.property).filter((name) => name !== '')),
    ].sort(),
  };
}
