import { CITATION_PROJECTION_REGISTRY } from './citation-projection.generated.js';

/**
 * The Phase 18 deterministic projector allow-list (§17 of the architecture).
 *
 * The typed reading of `contracts/registries/citation-projection.json`, which
 * Python reads directly. Neither runtime holds a private copy, because this
 * table decides which citation observations are permitted to produce a
 * compliance verdict — and a disagreement about that is a disagreement about
 * whether somebody's thesis passes.
 *
 * Checkpoint 2 defines the authority. No projector implements it yet, and no
 * analyzer emits any of these four properties.
 */

/** How a property earns the right to produce a verdict. */
export const CitationProjectionKind = {
  /** An exhaustively enumerable count. Exact, never a lower bound. */
  EXACT_COUNT: 'EXACT_COUNT',
  /** A per-element value read from structure, on an element structure names. */
  EXACT_ELEMENT_VALUE: 'EXACT_ELEMENT_VALUE',
  /** Emitted only when true, read with EXISTS; absence is never a failure. */
  EXACT_POSITIVE_MARKER: 'EXACT_POSITIVE_MARKER',
  /**
   * A lower bound from heuristic discovery (Phase 18, Checkpoint 15).
   *
   * Earns no verdict at all: the evaluator returns INDETERMINATE on any fact
   * whose provenance is HEURISTIC, so the number is reported and never
   * decides.
   */
  ADVISORY_COUNT: 'ADVISORY_COUNT',
  /** The same, for a recognition emitted only when true. */
  ADVISORY_POSITIVE_MARKER: 'ADVISORY_POSITIVE_MARKER',
} as const;

export type CitationProjectionKind =
  (typeof CitationProjectionKind)[keyof typeof CitationProjectionKind];

/** Which coverage statuses a property may be emitted under. */
export const CitationCoveragePolicy = {
  /**
   * A count is COMPLETE or it is UNAVAILABLE — never PARTIAL.
   *
   * PARTIAL protects only against a false pass, and a partial count is a
   * *wrong* value rather than a missing one, so a rule would fail a compliant
   * document on it. UNAVAILABLE is caught before aggregation and answers
   * INDETERMINATE, which is the truth.
   */
  COMPLETE_OR_UNAVAILABLE: 'COMPLETE_OR_UNAVAILABLE',
  /** A per-element value: a missing element cannot make a present one wrong. */
  COMPLETE_PARTIAL_OR_UNAVAILABLE: 'COMPLETE_PARTIAL_OR_UNAVAILABLE',
  /** Positive-only evidence, which can pass or be indeterminate but not fail. */
  POSITIVE_ONLY_PARTIAL_OR_UNAVAILABLE: 'POSITIVE_ONLY_PARTIAL_OR_UNAVAILABLE',
  /**
   * The only policy an advisory row may carry, and PARTIAL the only status it
   * may be emitted under. A heuristic population is a lower bound by
   * construction, so COMPLETE would claim an exhaustiveness the contract
   * cannot prove.
   */
  ADVISORY_PARTIAL_ONLY: 'ADVISORY_PARTIAL_ONLY',
} as const;

export type CitationCoveragePolicy =
  (typeof CitationCoveragePolicy)[keyof typeof CitationCoveragePolicy];

/**
 * Which evidence a row is allowed to read.
 *
 * Stated in the registry rather than inferred from the projection kind, so a
 * future row cannot quietly mix the two populations into one number: a fact
 * counting both declared and recognized objects could carry neither
 * provenance honestly, and provenance is what the evaluator's advisory gate
 * keys on.
 */
export const CitationEvidenceClass = {
  EXACT: 'EXACT',
  HEURISTIC: 'HEURISTIC',
} as const;

export type CitationEvidenceClass =
  (typeof CitationEvidenceClass)[keyof typeof CitationEvidenceClass];

export interface CitationProjectedProperty {
  readonly scopeKind: 'DOCUMENT' | 'ELEMENT';
  /** Present only for ELEMENT scope, and then always named explicitly. */
  readonly elementType?: string;
  readonly property: string;
  readonly valueKind: 'NUMBER' | 'BOOLEAN';
  readonly unit?: string;
  readonly projectionKind: CitationProjectionKind;
  readonly coveragePolicy: CitationCoveragePolicy;
  readonly evidenceClass: CitationEvidenceClass;
  readonly formats: readonly string[];
}

/** Is this row advisory — reported, and never allowed to decide? */
export function isAdvisoryProjection(entry: CitationProjectedProperty): boolean {
  return entry.evidenceClass === CitationEvidenceClass.HEURISTIC;
}

/** The registry's version. A change to what may be projected changes it. */
export const CITATION_PROJECTION_REGISTRY_VERSION: number =
  CITATION_PROJECTION_REGISTRY.registryVersion;

/** Every property Phase 18 may project, and nothing else. */
export const CITATION_PROJECTED_PROPERTIES: readonly CitationProjectedProperty[] =
  CITATION_PROJECTION_REGISTRY.properties as readonly CitationProjectedProperty[];

const BY_KEY = new Map<string, CitationProjectedProperty>(
  CITATION_PROJECTED_PROPERTIES.map((entry) => [
    key(entry.scopeKind, entry.property, entry.elementType),
    entry,
  ]),
);

function key(scopeKind: string, property: string, elementType?: string): string {
  return `${scopeKind}:${elementType ?? ''}:${property}`;
}

/**
 * The allow-list entry for a scope and property, or `undefined`.
 *
 * `undefined` means "not projectable", which is the answer for every citation
 * observation Phase 18 makes except these four. A projector must treat it as
 * a refusal rather than as a gap to fill in.
 */
export function citationProjectionFor(
  scopeKind: string,
  property: string,
  elementType?: string,
): CitationProjectedProperty | undefined {
  return BY_KEY.get(key(scopeKind, property, elementType));
}

/** Whether a scope and property may be projected at all. */
export function isCitationProjectable(
  scopeKind: string,
  property: string,
  elementType?: string,
): boolean {
  return citationProjectionFor(scopeKind, property, elementType) !== undefined;
}
