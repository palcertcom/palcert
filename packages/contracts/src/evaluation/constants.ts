/**
 * Runtime constants for the evaluation contracts.
 *
 * The generated types are compile-time only; these are the values the API and
 * tests need at runtime. Each is asserted against the JSON Schema by
 * `evaluation-parity.spec.ts`, so adding an enum member to the schema without
 * adding it here fails CI.
 */

/**
 * The fact-schema version this release produces and understands.
 *
 * An extractor stamps it on every `DocumentFactSet`. An engine that does not
 * implement a version refuses the set rather than guessing at its meaning.
 */
export const FACT_SCHEMA_VERSION = 2;

export const SUPPORTED_FACT_SCHEMA_VERSIONS: readonly number[] = [1, 2];

/**
 * Element types a fact set may use, per fact-schema version.
 *
 * Version 2 (Phase 6) adds `ENDNOTE` and `TEXTBOX`, because WordprocessingML
 * keeps them in their own stories and filing them under `PARAGRAPH` would let
 * a rule about body text fail on a text box. Rules may name the new types at
 * any version — a rule selecting nothing is already meaningful — but a fact
 * set that *declares* version 1 may not contain them, or "version 1" would
 * quietly mean two different vocabularies.
 */
export const FACT_SCHEMA_VERSION_ELEMENT_TYPES: Readonly<Record<number, readonly string[]>> = {
  1: [
    'HEADING',
    'PARAGRAPH',
    'TABLE',
    'FIGURE',
    'CAPTION',
    'LIST',
    'FOOTNOTE',
    'CITATION',
    'REFERENCE_ENTRY',
    'EQUATION',
    'HEADER',
    'FOOTER',
  ],
  2: [
    'HEADING',
    'PARAGRAPH',
    'TABLE',
    'FIGURE',
    'CAPTION',
    'LIST',
    'FOOTNOTE',
    'ENDNOTE',
    'TEXTBOX',
    'CITATION',
    'REFERENCE_ENTRY',
    'EQUATION',
    'HEADER',
    'FOOTER',
  ],
};

/** The location-schema version this release produces. */
export const LOCATION_SCHEMA_VERSION = 1;

/**
 * The deterministic evaluation engine's own version.
 *
 * Deliberately *not* the application's git commit: the engine's behaviour must
 * be identifiable on its own, so that a result recorded today can still be
 * explained after a hundred unrelated deployments. It changes when evaluation
 * semantics change, and only then.
 */
export const EVALUATION_ENGINE_NAME = 'palcert-deterministic';
export const EVALUATION_ENGINE_VERSION = '1.0.0';

export const EvaluationOutcomeValue = {
  PASS: 'PASS',
  FAIL: 'FAIL',
  NOT_APPLICABLE: 'NOT_APPLICABLE',
  INDETERMINATE: 'INDETERMINATE',
  ERROR: 'ERROR',
} as const;

export const EVALUATION_OUTCOMES: readonly string[] = Object.values(EvaluationOutcomeValue);

export const EvidenceLevelValue = {
  NONE: 'NONE',
  DETERMINISTIC: 'DETERMINISTIC',
  /**
   * The rule's facts were recognized rather than read (Phase 18, Checkpoint
   * 15). Always paired with INDETERMINATE: the observation is reported and
   * never becomes the PASS or FAIL an exact rule produces.
   */
  ADVISORY: 'ADVISORY',
  AI_PROVISIONAL: 'AI_PROVISIONAL',
  HUMAN_CONFIRMED: 'HUMAN_CONFIRMED',
} as const;

/**
 * Evidence levels a certification decision may rest on.
 *
 * Everything else is an observation: ADVISORY is heuristic, AI_PROVISIONAL is
 * a model's opinion, NONE is nothing at all. Exported so the determination and
 * the certificate gate ask one question rather than each keeping a list.
 */
export const AUTHORITATIVE_EVIDENCE_LEVELS: readonly string[] = [
  EvidenceLevelValue.DETERMINISTIC,
  EvidenceLevelValue.HUMAN_CONFIRMED,
];

export const EVIDENCE_LEVELS: readonly string[] = Object.values(EvidenceLevelValue);

export const CoverageStatusValue = {
  COMPLETE: 'COMPLETE',
  PARTIAL: 'PARTIAL',
  UNAVAILABLE: 'UNAVAILABLE',
} as const;

export const COVERAGE_STATUSES: readonly string[] = Object.values(CoverageStatusValue);

export const FactValueTypeValue = {
  STRING: 'STRING',
  NUMBER: 'NUMBER',
  BOOLEAN: 'BOOLEAN',
  ENUM: 'ENUM',
  STRING_LIST: 'STRING_LIST',
  NUMBER_LIST: 'NUMBER_LIST',
  STRUCTURED: 'STRUCTURED',
} as const;

export const FACT_VALUE_TYPES: readonly string[] = Object.values(FactValueTypeValue);

export const ReasonCodeValue = {
  SATISFIED: 'SATISFIED',
  VALUE_MISMATCH: 'VALUE_MISMATCH',
  OUTSIDE_TOLERANCE: 'OUTSIDE_TOLERANCE',
  BELOW_MINIMUM: 'BELOW_MINIMUM',
  ABOVE_MAXIMUM: 'ABOVE_MAXIMUM',
  OUTSIDE_RANGE: 'OUTSIDE_RANGE',
  REQUIRED_VALUE_MISSING: 'REQUIRED_VALUE_MISSING',
  FORBIDDEN_VALUE_PRESENT: 'FORBIDDEN_VALUE_PRESENT',
  PATTERN_MISMATCH: 'PATTERN_MISMATCH',
  NOT_IN_ALLOWED_SET: 'NOT_IN_ALLOWED_SET',
  IN_FORBIDDEN_SET: 'IN_FORBIDDEN_SET',
  NO_COMPLETE_EVIDENCE: 'NO_COMPLETE_EVIDENCE',
  NO_MATCHING_FACTS: 'NO_MATCHING_FACTS',
  SCOPE_NOT_PRESENT: 'SCOPE_NOT_PRESENT',
  UNIT_INCOMPATIBLE: 'UNIT_INCOMPATIBLE',
  UNIT_MISSING: 'UNIT_MISSING',
  VALUE_TYPE_INCOMPATIBLE: 'VALUE_TYPE_INCOMPATIBLE',
  EVALUATOR_NOT_SUPPORTED: 'EVALUATOR_NOT_SUPPORTED',
  AI_REVIEW_REQUIRED: 'AI_REVIEW_REQUIRED',
  MANUAL_REVIEW_REQUIRED: 'MANUAL_REVIEW_REQUIRED',
  FACT_SCHEMA_UNSUPPORTED: 'FACT_SCHEMA_UNSUPPORTED',
  RULE_SCHEMA_UNSUPPORTED: 'RULE_SCHEMA_UNSUPPORTED',
  RESOURCE_LIMIT_EXCEEDED: 'RESOURCE_LIMIT_EXCEEDED',
  ADVISORY_EVIDENCE_ONLY: 'ADVISORY_EVIDENCE_ONLY',
  INTERNAL_ERROR: 'INTERNAL_ERROR',
} as const;

export const REASON_CODES: readonly string[] = Object.values(ReasonCodeValue);

/**
 * Engine resource limits.
 *
 * Facts and rules arrive as untrusted structured data at a service boundary, so
 * every unbounded dimension gets a ceiling. Exceeding one is a typed error, not
 * a silent truncation — except for violations, where the count is preserved and
 * only the returned list is capped (see `MAX_RETURNED_VIOLATIONS_PER_RULE`).
 */
export const EVALUATION_LIMITS = {
  /** Rules in one evaluation request. */
  maxRules: 1000,
  /** Facts in one fact set. */
  maxFacts: 100000,
  /** Coverage entries in one fact set. */
  maxCoverageEntries: 500,
  /**
   * Violations *returned* for one rule. A document with 40,000 identical
   * violations must not produce a 40,000-element response; the true count is
   * still reported in `totalViolationCount` with `truncated: true`.
   */
  maxReturnedViolationsPerRule: 100,
  /** Violations returned across the whole response. */
  maxReturnedViolationsTotal: 5000,
  /** Any single string in a fact or expected value. */
  maxStringLength: 10000,
  /** Items in any list-valued fact or expected value. */
  maxListItems: 1000,
} as const;
