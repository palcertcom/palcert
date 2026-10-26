/**
 * The PalCert rule model.
 *
 * ## Rules are data
 *
 * A rule is a *declaration*, never a program. There is no expression language,
 * no `eval`, no embedded JavaScript, Python, SQL or shell. Every rule is a
 * closed tuple of enumerated choices plus typed literal values, which means:
 *
 *  - an attacker who obtains write access to the rules table gains data, not
 *    code execution;
 *  - a rule can be validated completely before it is ever evaluated;
 *  - a rule can be canonicalized and hashed, which is what makes a published
 *    standard verifiable (§Phase 3).
 *
 * Anything that cannot be expressed as this tuple is `MANUAL` or `AI_ASSISTED`
 * — a question put to a human or a model — not a new operator smuggled in as a
 * string. Growing the operator list is a deliberate, versioned schema change.
 *
 * ## Schema versioning
 *
 * `RULE_SCHEMA_VERSION` is stamped on every stored rule. The evaluator refuses
 * a rule whose schema version it does not implement, rather than guessing.
 * Bumping it is a migration, not a patch.
 *
 * ### Version 2 (Phase 4)
 *
 * Version 1 required `blocking` rules to be `DETERMINISTIC`. That was too
 * restrictive for the real product: a scientific journal may legitimately make
 * blind-review anonymization, an ethics declaration or a conflict-of-interest
 * statement a *blocking* requirement, and judging those needs a model or a
 * person.
 *
 * Version 2 therefore permits `blocking` in any evaluation mode. The safety
 * property it replaces the old invariant with is not weaker, only relocated:
 *
 *   > A rule may be blocking regardless of evaluation mode, but an unresolved
 *   > non-deterministic blocking rule prevents a final compliance decision
 *   > until it has been resolved.
 *
 * The engine enforces that by returning `INDETERMINATE` with
 * `requiresReview: true` for every AI-assisted and manual rule; it never
 * fabricates a verdict. Compliance aggregation (Phase 7) is what must refuse
 * to finalise while such a result is outstanding.
 *
 * Version 1 rules keep version 1 semantics forever. Validation is
 * version-aware, published v1 content is never rewritten, and published v1
 * hashes are unchanged — see `assertVersionedInvariants` below and ADR-0030.
 */
export const RULE_SCHEMA_VERSION = 2;

/**
 * Every rule-schema version this release can validate and evaluate.
 *
 * A rule stamped with anything else is refused explicitly rather than
 * evaluated on a guess: silently applying v2 semantics to a hypothetical v3
 * rule would be a wrong verdict presented as a confident one.
 */
export const SUPPORTED_RULE_SCHEMA_VERSIONS: readonly number[] = [1, 2];

export function isSupportedRuleSchemaVersion(version: number): boolean {
  return SUPPORTED_RULE_SCHEMA_VERSIONS.includes(version);
}

/**
 * The first version in which a blocking rule may be non-deterministic.
 *
 * Named rather than inlined so the one place that decides this is greppable.
 */
export const BLOCKING_ANY_MODE_FROM_SCHEMA_VERSION = 2;

// ---------------------------------------------------------------------------
// Category
// ---------------------------------------------------------------------------

/**
 * What aspect of a document a rule is about.
 *
 * Categories drive report grouping and the "which sections of my document are
 * failing" view, so they are a fixed vocabulary rather than free tags: two
 * organizations calling the same thing "Refs" and "Bibliography" would make
 * cross-organization reporting meaningless.
 */
export const RuleCategory = {
  PAGE_SETUP: 'PAGE_SETUP',
  MARGINS: 'MARGINS',
  TYPOGRAPHY: 'TYPOGRAPHY',
  SPACING: 'SPACING',
  ALIGNMENT: 'ALIGNMENT',
  PAGINATION: 'PAGINATION',
  HEADINGS: 'HEADINGS',
  TITLE_PAGE: 'TITLE_PAGE',
  ABSTRACT: 'ABSTRACT',
  KEYWORDS: 'KEYWORDS',
  TABLE_OF_CONTENTS: 'TABLE_OF_CONTENTS',
  SECTION_STRUCTURE: 'SECTION_STRUCTURE',
  TABLES: 'TABLES',
  FIGURES: 'FIGURES',
  CAPTIONS: 'CAPTIONS',
  EQUATIONS: 'EQUATIONS',
  CITATIONS: 'CITATIONS',
  REFERENCES: 'REFERENCES',
  LANGUAGE_QUALITY: 'LANGUAGE_QUALITY',
  TERMINOLOGY: 'TERMINOLOGY',
  RESEARCH_ETHICS: 'RESEARCH_ETHICS',
  DOCUMENT_METADATA: 'DOCUMENT_METADATA',
  FILE_TECHNICAL: 'FILE_TECHNICAL',
} as const;

export type RuleCategory = (typeof RuleCategory)[keyof typeof RuleCategory];

export const RULE_CATEGORIES: readonly RuleCategory[] = Object.values(RuleCategory);

// ---------------------------------------------------------------------------
// Evaluation mode
// ---------------------------------------------------------------------------

/**
 * How a rule is decided.
 *
 * This is the boundary the whole product rests on (ADR-0002): a
 * `DETERMINISTIC` rule is measured and its verdict is reproducible; an
 * `AI_ASSISTED` rule is judged and its verdict is advisory; a `MANUAL` rule is
 * asked of a person. Certificates may only ever be issued on the strength of
 * the first kind, so the distinction is stored on the rule rather than inferred
 * at evaluation time.
 */
export const RuleEvaluationMode = {
  DETERMINISTIC: 'DETERMINISTIC',
  AI_ASSISTED: 'AI_ASSISTED',
  MANUAL: 'MANUAL',
} as const;

export type RuleEvaluationMode = (typeof RuleEvaluationMode)[keyof typeof RuleEvaluationMode];

export const RULE_EVALUATION_MODES: readonly RuleEvaluationMode[] =
  Object.values(RuleEvaluationMode);

// ---------------------------------------------------------------------------
// Severity, blocking, autofix, origin
// ---------------------------------------------------------------------------

export const RuleSeverity = {
  INFO: 'INFO',
  MINOR: 'MINOR',
  MAJOR: 'MAJOR',
  CRITICAL: 'CRITICAL',
} as const;

export type RuleSeverity = (typeof RuleSeverity)[keyof typeof RuleSeverity];

export const RULE_SEVERITIES: readonly RuleSeverity[] = Object.values(RuleSeverity);

/**
 * Numeric weight used by scoring (Phase 8). Defined here, next to the severity
 * it describes, so scoring can never disagree with the catalogue.
 */
export const RULE_SEVERITY_WEIGHT: Readonly<Record<RuleSeverity, number>> = {
  INFO: 0,
  MINOR: 1,
  MAJOR: 4,
  CRITICAL: 10,
};

/**
 * How far an automatic correction may go.
 *
 * `SAFE` changes cannot alter meaning (a margin, a font size, a caption
 * position). `ADVANCED` changes may touch wording and therefore always require
 * explicit human acceptance. `NONE` means SmartFix must not offer anything.
 * Declaring this on the rule — not on the fixer — is what stops a future
 * SmartFix implementation from quietly rewriting prose that the standard's
 * author never intended it to touch.
 */
export const RuleAutofixCapability = {
  NONE: 'NONE',
  SAFE: 'SAFE',
  ADVANCED: 'ADVANCED',
} as const;

export type RuleAutofixCapability =
  (typeof RuleAutofixCapability)[keyof typeof RuleAutofixCapability];

export const RULE_AUTOFIX_CAPABILITIES: readonly RuleAutofixCapability[] =
  Object.values(RuleAutofixCapability);

/** Where the rule came from. Provenance matters when a standard is disputed. */
export const RuleOrigin = {
  ORGANIZATION_POLICY: 'ORGANIZATION_POLICY',
  NATIONAL_REGULATION: 'NATIONAL_REGULATION',
  PUBLISHER_GUIDELINE: 'PUBLISHER_GUIDELINE',
  STYLE_GUIDE: 'STYLE_GUIDE',
  ACCESSIBILITY_STANDARD: 'ACCESSIBILITY_STANDARD',
  PALCERT_TEMPLATE: 'PALCERT_TEMPLATE',
  OTHER: 'OTHER',
} as const;

export type RuleOrigin = (typeof RuleOrigin)[keyof typeof RuleOrigin];

export const RULE_ORIGINS: readonly RuleOrigin[] = Object.values(RuleOrigin);

// ---------------------------------------------------------------------------
// Scope — *what* the rule is measured against
// ---------------------------------------------------------------------------

export const RuleScopeKind = {
  /** The document as a whole. */
  DOCUMENT: 'DOCUMENT',
  /** A named logical section, e.g. `ABSTRACT`, `METHODOLOGY`. */
  SECTION: 'SECTION',
  /** Every occurrence of a structural element, optionally at one level. */
  ELEMENT: 'ELEMENT',
  /** A document metadata field, e.g. `title`, `author`, `language`. */
  METADATA: 'METADATA',
  /** A page or class of pages. */
  PAGE: 'PAGE',
} as const;

export type RuleScopeKind = (typeof RuleScopeKind)[keyof typeof RuleScopeKind];

export const RULE_SCOPE_KINDS: readonly RuleScopeKind[] = Object.values(RuleScopeKind);

export const RuleElementType = {
  HEADING: 'HEADING',
  PARAGRAPH: 'PARAGRAPH',
  TABLE: 'TABLE',
  FIGURE: 'FIGURE',
  CAPTION: 'CAPTION',
  LIST: 'LIST',
  FOOTNOTE: 'FOOTNOTE',
  /** Fact schema v2 (Phase 6): endnotes are their own WordprocessingML story. */
  ENDNOTE: 'ENDNOTE',
  /** Fact schema v2 (Phase 6): text-box content is not ordinary body text. */
  TEXTBOX: 'TEXTBOX',
  CITATION: 'CITATION',
  REFERENCE_ENTRY: 'REFERENCE_ENTRY',
  EQUATION: 'EQUATION',
  HEADER: 'HEADER',
  FOOTER: 'FOOTER',
} as const;

export type RuleElementType = (typeof RuleElementType)[keyof typeof RuleElementType];

export const RULE_ELEMENT_TYPES: readonly RuleElementType[] = Object.values(RuleElementType);

export const RulePageSelector = {
  ALL: 'ALL',
  FIRST: 'FIRST',
  LAST: 'LAST',
  ODD: 'ODD',
  EVEN: 'EVEN',
} as const;

export type RulePageSelector = (typeof RulePageSelector)[keyof typeof RulePageSelector];

export const RULE_PAGE_SELECTORS: readonly RulePageSelector[] = Object.values(RulePageSelector);

/**
 * A key naming a section, element property or metadata field.
 *
 * Constrained to a conservative identifier alphabet so a scope can never carry
 * a path traversal, a selector expression or markup into a downstream consumer.
 */
export const RULE_SCOPE_KEY_PATTERN = /^[A-Z][A-Z0-9_]{0,63}$/;
export const RULE_PROPERTY_KEY_PATTERN = /^[a-z][a-zA-Z0-9]{0,63}$/;

export interface DocumentScope {
  readonly kind: 'DOCUMENT';
  /** The measured property, e.g. `pageCount`, `wordCount`. */
  readonly property: string;
}

export interface SectionScope {
  readonly kind: 'SECTION';
  readonly sectionKey: string;
  readonly property: string;
}

export interface ElementScope {
  readonly kind: 'ELEMENT';
  readonly elementType: RuleElementType;
  /** Heading level (1–9) when `elementType` is HEADING; otherwise absent. */
  readonly level?: number;
  readonly property: string;
}

export interface MetadataScope {
  readonly kind: 'METADATA';
  readonly field: string;
}

export interface PageScope {
  readonly kind: 'PAGE';
  readonly pages: RulePageSelector;
  readonly property: string;
}

export type RuleScope = DocumentScope | SectionScope | ElementScope | MetadataScope | PageScope;

// ---------------------------------------------------------------------------
// Operators and expected values
// ---------------------------------------------------------------------------

export const RuleOperator = {
  EQUALS: 'EQUALS',
  NOT_EQUALS: 'NOT_EQUALS',
  GREATER_THAN: 'GREATER_THAN',
  GREATER_THAN_OR_EQUAL: 'GREATER_THAN_OR_EQUAL',
  LESS_THAN: 'LESS_THAN',
  LESS_THAN_OR_EQUAL: 'LESS_THAN_OR_EQUAL',
  BETWEEN: 'BETWEEN',
  IN: 'IN',
  NOT_IN: 'NOT_IN',
  CONTAINS: 'CONTAINS',
  NOT_CONTAINS: 'NOT_CONTAINS',
  MATCHES_PATTERN: 'MATCHES_PATTERN',
  EXISTS: 'EXISTS',
  NOT_EXISTS: 'NOT_EXISTS',
} as const;

export type RuleOperator = (typeof RuleOperator)[keyof typeof RuleOperator];

export const RULE_OPERATORS: readonly RuleOperator[] = Object.values(RuleOperator);

export const RuleValueType = {
  NUMBER: 'NUMBER',
  STRING: 'STRING',
  BOOLEAN: 'BOOLEAN',
  NUMBER_RANGE: 'NUMBER_RANGE',
  STRING_LIST: 'STRING_LIST',
  NUMBER_LIST: 'NUMBER_LIST',
  PATTERN: 'PATTERN',
  /** No operand at all — the operator is unary. */
  NONE: 'NONE',
} as const;

export type RuleValueType = (typeof RuleValueType)[keyof typeof RuleValueType];

export const RULE_VALUE_TYPES: readonly RuleValueType[] = Object.values(RuleValueType);

export interface NumberValue {
  readonly type: 'NUMBER';
  readonly number: number;
}
export interface StringValue {
  readonly type: 'STRING';
  readonly text: string;
}
export interface BooleanValue {
  readonly type: 'BOOLEAN';
  readonly boolean: boolean;
}
export interface NumberRangeValue {
  readonly type: 'NUMBER_RANGE';
  readonly min: number;
  readonly max: number;
}
export interface StringListValue {
  readonly type: 'STRING_LIST';
  readonly values: readonly string[];
}
export interface NumberListValue {
  readonly type: 'NUMBER_LIST';
  readonly values: readonly number[];
}
/**
 * A pattern is stored as a *named*, PalCert-implemented matcher plus literal
 * arguments — never as a caller-supplied regular expression. An arbitrary regex
 * is executable input: it is a denial-of-service vector (catastrophic
 * backtracking) and it is exactly the "unsafe DSL" this schema exists to avoid.
 */
export const RulePatternName = {
  STARTS_WITH: 'STARTS_WITH',
  ENDS_WITH: 'ENDS_WITH',
  DIGITS_ONLY: 'DIGITS_ONLY',
  LETTERS_ONLY: 'LETTERS_ONLY',
  NO_LEADING_WHITESPACE: 'NO_LEADING_WHITESPACE',
  NO_TRAILING_WHITESPACE: 'NO_TRAILING_WHITESPACE',
  SENTENCE_CASE: 'SENTENCE_CASE',
  TITLE_CASE: 'TITLE_CASE',
  UPPERCASE: 'UPPERCASE',
  ARABIC_SCRIPT: 'ARABIC_SCRIPT',
  LATIN_SCRIPT: 'LATIN_SCRIPT',
  DOI: 'DOI',
  ISSN: 'ISSN',
  ISBN: 'ISBN',
  EMAIL: 'EMAIL',
  URL: 'URL',
} as const;

export type RulePatternName = (typeof RulePatternName)[keyof typeof RulePatternName];

export const RULE_PATTERN_NAMES: readonly RulePatternName[] = Object.values(RulePatternName);

/** Patterns that take one literal string argument; the rest take none. */
export const PATTERNS_REQUIRING_ARGUMENT: readonly RulePatternName[] = [
  RulePatternName.STARTS_WITH,
  RulePatternName.ENDS_WITH,
];

export interface PatternValue {
  readonly type: 'PATTERN';
  readonly pattern: RulePatternName;
  readonly argument?: string;
}
export interface NoValue {
  readonly type: 'NONE';
}

export type RuleExpectedValue =
  | NumberValue
  | StringValue
  | BooleanValue
  | NumberRangeValue
  | StringListValue
  | NumberListValue
  | PatternValue
  | NoValue;

// ---------------------------------------------------------------------------
// Operator / value compatibility
// ---------------------------------------------------------------------------

/**
 * Which operand shapes each operator accepts.
 *
 * This matrix is the single source of truth: the API validator, the rule
 * builder UI and (from Phase 6) the evaluator all read it, so a combination
 * that the UI offers is by construction one the API accepts and the evaluator
 * understands.
 */
export const OPERATOR_VALUE_COMPATIBILITY: Readonly<
  Record<RuleOperator, readonly RuleValueType[]>
> = {
  EQUALS: ['NUMBER', 'STRING', 'BOOLEAN'],
  NOT_EQUALS: ['NUMBER', 'STRING', 'BOOLEAN'],
  GREATER_THAN: ['NUMBER'],
  GREATER_THAN_OR_EQUAL: ['NUMBER'],
  LESS_THAN: ['NUMBER'],
  LESS_THAN_OR_EQUAL: ['NUMBER'],
  BETWEEN: ['NUMBER_RANGE'],
  IN: ['STRING_LIST', 'NUMBER_LIST'],
  NOT_IN: ['STRING_LIST', 'NUMBER_LIST'],
  CONTAINS: ['STRING'],
  NOT_CONTAINS: ['STRING'],
  MATCHES_PATTERN: ['PATTERN'],
  EXISTS: ['NONE'],
  NOT_EXISTS: ['NONE'],
};

export function isOperatorValueCompatible(
  operator: RuleOperator,
  valueType: RuleValueType,
): boolean {
  return OPERATOR_VALUE_COMPATIBILITY[operator]?.includes(valueType) ?? false;
}

/**
 * Operators for which a numeric tolerance is meaningful.
 *
 * A tolerance on `EQUALS "Times New Roman"` is nonsense, and silently ignoring
 * it would leave an author believing they had configured something. It is
 * rejected instead.
 */
export const TOLERANCE_COMPATIBLE_OPERATORS: readonly RuleOperator[] = [
  RuleOperator.EQUALS,
  RuleOperator.NOT_EQUALS,
  RuleOperator.GREATER_THAN,
  RuleOperator.GREATER_THAN_OR_EQUAL,
  RuleOperator.LESS_THAN,
  RuleOperator.LESS_THAN_OR_EQUAL,
  RuleOperator.BETWEEN,
];

export function operatorSupportsTolerance(
  operator: RuleOperator,
  valueType: RuleValueType,
): boolean {
  if (!TOLERANCE_COMPATIBLE_OPERATORS.includes(operator)) return false;
  return valueType === RuleValueType.NUMBER || valueType === RuleValueType.NUMBER_RANGE;
}

// ---------------------------------------------------------------------------
// Units
// ---------------------------------------------------------------------------

/**
 * Physical and typographic units.
 *
 * A bare number is ambiguous — "margin equals 2" is 2 what? Numeric rules
 * therefore carry a unit, and `COUNT` is the explicit "a plain count" choice
 * rather than an omission, so a missing unit is always an authoring mistake.
 */
export const RuleUnit = {
  COUNT: 'COUNT',
  MILLIMETRE: 'MILLIMETRE',
  CENTIMETRE: 'CENTIMETRE',
  INCH: 'INCH',
  POINT: 'POINT',
  PIXEL: 'PIXEL',
  PERCENT: 'PERCENT',
  LINES: 'LINES',
  WORDS: 'WORDS',
  CHARACTERS: 'CHARACTERS',
  PAGES: 'PAGES',
  MEGABYTE: 'MEGABYTE',
  DPI: 'DPI',
} as const;

export type RuleUnit = (typeof RuleUnit)[keyof typeof RuleUnit];

export const RULE_UNITS: readonly RuleUnit[] = Object.values(RuleUnit);

/** Value types for which a unit is required rather than optional. */
export function unitRequiredFor(valueType: RuleValueType): boolean {
  return (
    valueType === RuleValueType.NUMBER ||
    valueType === RuleValueType.NUMBER_RANGE ||
    valueType === RuleValueType.NUMBER_LIST
  );
}

// ---------------------------------------------------------------------------
// The rule itself
// ---------------------------------------------------------------------------

/**
 * `ruleCode` is the stable, human-meaningful identity of a rule *within a
 * standard version*, e.g. `MARGIN.TOP.MIN`. Findings and reports quote it, so
 * it must be readable and must not change; the database id is an
 * implementation detail that never leaves the API boundary as an identifier of
 * meaning.
 */
export const RULE_CODE_PATTERN = /^[A-Z][A-Z0-9]*(\.[A-Z0-9]+)*$/;
export const RULE_CODE_MAX_LENGTH = 120;

export function isValidRuleCode(value: string): boolean {
  return value.length <= RULE_CODE_MAX_LENGTH && RULE_CODE_PATTERN.test(value);
}

/** The localized, author-written text of a rule. Both locales are mandatory. */
export interface RuleText {
  readonly titleEn: string;
  readonly titleAr: string;
  readonly descriptionEn: string | null;
  readonly descriptionAr: string | null;
  readonly guidanceEn: string | null;
  readonly guidanceAr: string | null;
}

/** A rule as the API returns it. */
export interface RuleView extends RuleText {
  readonly id: string;
  readonly ruleCode: string;
  readonly category: RuleCategory;
  readonly evaluationMode: RuleEvaluationMode;
  readonly scope: RuleScope;
  readonly operator: RuleOperator;
  readonly expected: RuleExpectedValue;
  readonly unit: RuleUnit | null;
  readonly tolerance: number | null;
  readonly severity: RuleSeverity;
  readonly blocking: boolean;
  readonly autofix: RuleAutofixCapability;
  readonly origin: RuleOrigin;
  readonly originReference: string | null;
  readonly displayOrder: number;
  readonly ruleSchemaVersion: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/** The semantic part of a rule — everything the content hash covers. */
export type RuleDefinition = Omit<RuleView, 'id' | 'createdAt' | 'updatedAt' | 'ruleSchemaVersion'>;
