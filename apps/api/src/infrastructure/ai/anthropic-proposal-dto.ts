import {
  ExtractionContract,
  RULE_PROPOSAL_JSON_SCHEMA,
  validateExtractionContract,
  type PalCertRuleProposalOutput,
} from '@palcert/contracts';

/**
 * The provider-facing shape of a rule proposal (Pass B), and the only road
 * from it to PalCert's canonical `PalCertRuleProposalOutput`.
 *
 * Why a second shape at all: the canonical schema expresses a rule's scope and
 * expected value as two `oneOf` trees (five scopes, eight value kinds) inside
 * an array, with nine optional properties around them. Anthropic compiles a
 * structured-output schema into a grammar, and that combination made the
 * grammar too large to compile ("The compiled grammar is too large …"), so
 * every extraction failed at Pass B.
 *
 * This shape is deliberately flat:
 *
 * - no `oneOf`/`anyOf` anywhere: a discriminator field (`scopeKind`,
 *   `expectedType`) plus one field per possible value;
 * - no optional properties: every field is required, and a field that does
 *   not apply carries a fixed neutral value (`""`, `0`, `[]`,
 *   `NOT_APPLICABLE`);
 * - the suggested rule is a list of zero or one, not an optional object;
 * - the closed vocabularies stay closed: `enum`s are sent as they are, drawn
 *   from the canonical schema so the two can never disagree.
 *
 * Nothing about it is trusted. The response is checked field by field, every
 * discriminator combination is checked, the canonical object is built from it,
 * and that object must then pass the full canonical schema
 * (`validateExtractionContract`) before anyone sees it.
 */

/** A value for an enum field that does not apply to this rule. */
export const NOT_APPLICABLE = 'NOT_APPLICABLE';

type Json = Record<string, unknown>;

const DEFS = (RULE_PROPOSAL_JSON_SCHEMA as unknown as { $defs: Record<string, Json> }).$defs;

function enumOf(name: string): string[] {
  return [...(DEFS[name]!.enum as string[])];
}

/** The discriminator values of a canonical `oneOf`, read from the schema itself. */
function discriminatorsOf(name: string, key: string): string[] {
  const branches = DEFS[name]!.oneOf as Array<{ properties: Record<string, { const: string }> }>;
  return branches.map((branch) => branch.properties[key]!.const);
}

export const VOCABULARY = {
  proposalKinds: [
    ...((DEFS.RuleProposal!.properties as Record<string, Json>).kind as { enum: string[] }).enum,
  ],
  categories: enumOf('RuleCategory'),
  evaluationModes: enumOf('RuleEvaluationMode'),
  scopeKinds: discriminatorsOf('RuleScope', 'kind'),
  elementTypes: enumOf('RuleElementType'),
  pageSelectors: enumOf('RulePageSelector'),
  operators: enumOf('RuleOperator'),
  expectedTypes: discriminatorsOf('RuleExpectedValue', 'type'),
  patterns: enumOf('RulePatternName'),
  units: enumOf('RuleUnit'),
  severities: enumOf('RuleSeverity'),
  autofix: enumOf('RuleAutofixCapability'),
  origins: enumOf('RuleOrigin'),
} as const;

const str = (description: string): Json => ({ type: 'string', description });
const num = (description: string): Json => ({ type: 'number', description });
const bool = (description: string): Json => ({ type: 'boolean', description });
const oneOfValues = (values: readonly string[], description: string): Json => ({
  type: 'string',
  enum: [...values],
  description,
});
const orNotApplicable = (values: readonly string[]): string[] => [...values, NOT_APPLICABLE];

const RULE_FIELDS: Record<string, Json> = {
  ruleCode: str(
    'Rule code: segments of upper-case letters A-Z and digits 0-9, separated by single dots, ' +
      'starting with a letter (^[A-Z][A-Z0-9]*(\\.[A-Z0-9]+)*$). No underscores, hyphens, spaces ' +
      'or lower case: MARGINS.LEFT, TITLE.PAGE.FONT, HEADING1.SIZE.',
  ),
  category: oneOfValues(VOCABULARY.categories, 'Rule category.'),
  evaluationMode: oneOfValues(VOCABULARY.evaluationModes, 'How the rule is evaluated.'),
  scopeKind: oneOfValues(
    VOCABULARY.scopeKinds,
    'What the rule applies to. Decides which of sectionKey, elementType, elementLevel and pageSelector apply.',
  ),
  property: str(
    'The property from the supplied catalogue. For scopeKind METADATA, the metadata field.',
  ),
  sectionKey: str('For scopeKind SECTION only: the section key (upper case). Otherwise "".'),
  elementType: oneOfValues(
    orNotApplicable(VOCABULARY.elementTypes),
    'For scopeKind ELEMENT only. Otherwise NOT_APPLICABLE.',
  ),
  elementLevel: {
    type: 'integer',
    description: 'For scopeKind ELEMENT only: level 1-9, or 0 for any level. Otherwise 0.',
  },
  pageSelector: oneOfValues(
    orNotApplicable(VOCABULARY.pageSelectors),
    'For scopeKind PAGE only. Otherwise NOT_APPLICABLE.',
  ),
  operator: oneOfValues(VOCABULARY.operators, 'Comparison operator.'),
  expectedType: oneOfValues(
    VOCABULARY.expectedTypes,
    'Kind of expected value. Decides which one expected* field applies; every other expected* field keeps its neutral value.',
  ),
  expectedNumber: num('For NUMBER only. Otherwise 0.'),
  expectedText: str('For STRING only. Otherwise "".'),
  expectedBoolean: bool('For BOOLEAN only. Otherwise false.'),
  expectedMin: num('For NUMBER_RANGE only: lower bound. Otherwise 0.'),
  expectedMax: num('For NUMBER_RANGE only: upper bound. Otherwise 0.'),
  expectedStrings: {
    type: 'array',
    items: { type: 'string' },
    description: 'For STRING_LIST only. Otherwise [].',
  },
  expectedNumbers: {
    type: 'array',
    items: { type: 'number' },
    description: 'For NUMBER_LIST only. Otherwise [].',
  },
  expectedPattern: oneOfValues(
    orNotApplicable(VOCABULARY.patterns),
    'For PATTERN only: the pattern by name. Otherwise NOT_APPLICABLE.',
  ),
  patternArgument: str(
    'For PATTERN only, when the pattern takes one (e.g. STARTS_WITH). Otherwise "".',
  ),
  unit: oneOfValues(orNotApplicable(VOCABULARY.units), 'Unit of the value, or NOT_APPLICABLE.'),
  severity: oneOfValues(VOCABULARY.severities, 'Severity.'),
  blocking: bool('Whether a failure blocks certification.'),
  autofix: oneOfValues(VOCABULARY.autofix, 'Autofix capability.'),
  origin: oneOfValues(VOCABULARY.origins, 'Where the requirement comes from.'),
  titleEn: str('Short English title.'),
  titleAr: str('Short Arabic title.'),
  guidanceEn: str('English guidance for the author, or "".'),
  guidanceAr: str('Arabic guidance for the author, or "".'),
};

const PROPOSAL_FIELDS: Record<string, Json> = {
  proposalKey: str('Your own handle for this proposal: letters, digits, . _ : - only.'),
  kind: oneOfValues(VOCABULARY.proposalKinds, 'Kind of proposal.'),
  evidenceIds: {
    type: 'array',
    items: { type: 'string' },
    description: 'Only evidence identifiers supplied to you.',
  },
  interpretationEn: str('What the source requires, in English.'),
  interpretationAr: str('The same reading, in Arabic.'),
  ambiguityNote: str('For AMBIGUOUS_REQUIREMENT: what a person must decide. Otherwise "".'),
  requiresClarification: bool('Whether a person must clarify before this can become a rule.'),
  relatedProposalKeys: {
    type: 'array',
    items: { type: 'string' },
    description: 'proposalKeys of related proposals in this response, or [].',
  },
  suggestedRule: {
    type: 'array',
    description:
      'Exactly one rule definition when the requirement can be expressed with the supplied vocabulary, otherwise an empty list. Never more than one.',
    items: objectOf(RULE_FIELDS),
  },
};

function objectOf(properties: Record<string, Json>): Json {
  return {
    type: 'object',
    additionalProperties: false,
    required: Object.keys(properties),
    properties,
  };
}

/**
 * The schema sent to the provider. Constant, so the provider compiles it once
 * and serves it from its schema cache; the per-request proposal limit is in
 * the prompt and enforced here, not written into the schema.
 */
export const ANTHROPIC_PROPOSAL_SCHEMA: Json = {
  ...objectOf({
    proposals: {
      type: 'array',
      description:
        'The proposals, no more than the number the request allows. An empty list is correct when the evidence supports none.',
      items: objectOf(PROPOSAL_FIELDS),
    },
  }),
};

// ---------------------------------------------------------------------------
// Checking and conversion
// ---------------------------------------------------------------------------

/** Why a provider answer was refused. A code, never model text. */
export type ProposalRejection =
  | 'NOT_AN_OBJECT'
  | 'FIELD_MISSING_OR_WRONG_TYPE'
  | 'UNKNOWN_FIELD'
  | 'VALUE_OUTSIDE_VOCABULARY'
  | 'TOO_MANY_PROPOSALS'
  | 'DUPLICATE_PROPOSAL_KEY'
  | 'MORE_THAN_ONE_RULE'
  | 'SCOPE_INCONSISTENT'
  | 'EXPECTED_VALUE_INCONSISTENT'
  | 'CANONICAL_SCHEMA_FAILED';

/** One canonical validation failure, reduced to structure: where, and which rule. */
export interface CanonicalIssue {
  /** A JSON pointer made of field names and indices, e.g. /proposals/0/suggestedRule/ruleCode. */
  readonly path: string;
  /** The validator's rule, e.g. "must match pattern" — never the value that broke it. */
  readonly issue: string;
}

/**
 * 1 for a message that only says "this was not the other branch of a union"
 * (the scope and the expected value are oneOf trees, and Ajv reports every
 * branch that did not match), 0 for everything else. Sorting by it puts the
 * real cause — "must match pattern", "must be <= 9" — first.
 */
function unionNoise(message: string): number {
  return /must be equal to constant|must match exactly one schema|must NOT have additional properties|must have required property/.test(
    message,
  )
    ? 1
    : 0;
}

/** At most this many issues are kept: enough to locate the fault, no more. */
export const MAX_REPORTED_ISSUES = 3;

export class ProposalConversionError extends Error {
  constructor(
    readonly reason: ProposalRejection,
    /** Where, as a path of field names and indices — never a value. */
    readonly at: string,
    /** For CANONICAL_SCHEMA_FAILED: the first few failures, structural only. */
    readonly issues: readonly CanonicalIssue[] = [],
  ) {
    super(`${reason} at ${at}`);
    this.name = 'ProposalConversionError';
  }
}

/**
 * A validator issue with anything that could carry content removed.
 *
 * Ajv's messages state the rule and quote PalCert's own schema (a pattern, an
 * allowed value), never the rejected value — but the quoted part is dropped
 * anyway, so this does not depend on that remaining true. The path keeps only
 * pointer characters; a key that is not a plain identifier becomes "?".
 */
export function sanitizedIssue(raw: { path: string; message: string }): CanonicalIssue {
  const path =
    raw.path
      .split('/')
      .map((segment) => (segment === '' || /^[A-Za-z0-9_]{1,64}$/.test(segment) ? segment : '?'))
      .join('/') || '/';
  const issue =
    raw.message
      .replace(/"[^"]*"|'[^']*'|`[^`]*`/g, '')
      .replace(/[^A-Za-z0-9 <>=,.:-]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 80) || 'is invalid';
  return { path, issue };
}

interface RuleDto {
  ruleCode: string;
  category: string;
  evaluationMode: string;
  scopeKind: string;
  property: string;
  sectionKey: string;
  elementType: string;
  elementLevel: number;
  pageSelector: string;
  operator: string;
  expectedType: string;
  expectedNumber: number;
  expectedText: string;
  expectedBoolean: boolean;
  expectedMin: number;
  expectedMax: number;
  expectedStrings: string[];
  expectedNumbers: number[];
  expectedPattern: string;
  patternArgument: string;
  unit: string;
  severity: string;
  blocking: boolean;
  autofix: string;
  origin: string;
  titleEn: string;
  titleAr: string;
  guidanceEn: string;
  guidanceAr: string;
}

/**
 * Convert a provider answer into PalCert's canonical output.
 *
 * Throws `ProposalConversionError` on anything malformed or inconsistent, and
 * on a canonical object that fails the full canonical schema. Only a value that
 * has passed `validateExtractionContract(PROPOSAL_OUTPUT)` is ever returned.
 */
export function toCanonicalProposals(
  value: unknown,
  limits: { maxProposals: number },
  /** Told how many rule codes had to be rewritten: counts only, never a value. */
  onRuleCodesRewritten?: (summary: RuleCodeRewrites) => void,
): PalCertRuleProposalOutput {
  const root = objectWith(value, ['proposals'], '$');
  const proposals = arrayAt(root, 'proposals', '$');
  if (proposals.length > limits.maxProposals) {
    throw new ProposalConversionError('TOO_MANY_PROPOSALS', '$.proposals');
  }

  const keys = new Set<string>();
  const canonical = proposals.map((entry, index) => {
    const at = `$.proposals[${index}]`;
    const proposal = objectWith(entry, Object.keys(PROPOSAL_FIELDS), at);

    const proposalKey = stringAt(proposal, 'proposalKey', at);
    if (keys.has(proposalKey)) throw new ProposalConversionError('DUPLICATE_PROPOSAL_KEY', at);
    keys.add(proposalKey);

    const rules = arrayAt(proposal, 'suggestedRule', at);
    if (rules.length > 1)
      throw new ProposalConversionError('MORE_THAN_ONE_RULE', `${at}.suggestedRule`);

    const ambiguityNote = stringAt(proposal, 'ambiguityNote', at);
    const related = stringsAt(proposal, 'relatedProposalKeys', at);

    return {
      proposalKey,
      kind: enumAt(proposal, 'kind', VOCABULARY.proposalKinds, at),
      evidenceIds: stringsAt(proposal, 'evidenceIds', at),
      ...(rules.length === 1
        ? {
            suggestedRule: canonicalRule(
              ruleDto(rules[0], `${at}.suggestedRule[0]`),
              `${at}.suggestedRule[0]`,
            ),
          }
        : {}),
      interpretationEn: stringAt(proposal, 'interpretationEn', at),
      interpretationAr: stringAt(proposal, 'interpretationAr', at),
      ...(ambiguityNote === '' ? {} : { ambiguityNote }),
      requiresClarification: booleanAt(proposal, 'requiresClarification', at),
      ...(related.length === 0 ? {} : { relatedProposalKeys: related }),
    };
  });

  const rewrites = normalizeRuleCodes(canonical);
  if (rewrites.normalized + rewrites.fallback + rewrites.deduplicated > 0) {
    onRuleCodesRewritten?.(rewrites);
  }

  const output = { proposals: canonical };
  // The canonical schema has the last word: lengths, patterns, bounds and
  // vocabulary exactly as PalCert defines them.
  const verdict = validateExtractionContract(ExtractionContract.PROPOSAL_OUTPUT, output);
  if (!verdict.valid) {
    const issues = [...verdict.issues]
      .sort((left, right) => unionNoise(left.message) - unionNoise(right.message))
      .slice(0, MAX_REPORTED_ISSUES)
      .map(sanitizedIssue);
    throw new ProposalConversionError('CANONICAL_SCHEMA_FAILED', issues[0]?.path ?? '/', issues);
  }
  return output as unknown as PalCertRuleProposalOutput;
}

function ruleDto(value: unknown, at: string): RuleDto {
  const rule = objectWith(value, Object.keys(RULE_FIELDS), at);
  return {
    ruleCode: stringAt(rule, 'ruleCode', at),
    category: enumAt(rule, 'category', VOCABULARY.categories, at),
    evaluationMode: enumAt(rule, 'evaluationMode', VOCABULARY.evaluationModes, at),
    scopeKind: enumAt(rule, 'scopeKind', VOCABULARY.scopeKinds, at),
    property: stringAt(rule, 'property', at),
    sectionKey: stringAt(rule, 'sectionKey', at),
    elementType: enumAt(rule, 'elementType', orNotApplicable(VOCABULARY.elementTypes), at),
    elementLevel: integerAt(rule, 'elementLevel', at),
    pageSelector: enumAt(rule, 'pageSelector', orNotApplicable(VOCABULARY.pageSelectors), at),
    operator: enumAt(rule, 'operator', VOCABULARY.operators, at),
    expectedType: enumAt(rule, 'expectedType', VOCABULARY.expectedTypes, at),
    expectedNumber: numberAt(rule, 'expectedNumber', at),
    expectedText: stringAt(rule, 'expectedText', at),
    expectedBoolean: booleanAt(rule, 'expectedBoolean', at),
    expectedMin: numberAt(rule, 'expectedMin', at),
    expectedMax: numberAt(rule, 'expectedMax', at),
    expectedStrings: stringsAt(rule, 'expectedStrings', at),
    expectedNumbers: numbersAt(rule, 'expectedNumbers', at),
    expectedPattern: enumAt(rule, 'expectedPattern', orNotApplicable(VOCABULARY.patterns), at),
    patternArgument: stringAt(rule, 'patternArgument', at),
    unit: enumAt(rule, 'unit', orNotApplicable(VOCABULARY.units), at),
    severity: enumAt(rule, 'severity', VOCABULARY.severities, at),
    blocking: booleanAt(rule, 'blocking', at),
    autofix: enumAt(rule, 'autofix', VOCABULARY.autofix, at),
    origin: enumAt(rule, 'origin', VOCABULARY.origins, at),
    titleEn: stringAt(rule, 'titleEn', at),
    titleAr: stringAt(rule, 'titleAr', at),
    guidanceEn: stringAt(rule, 'guidanceEn', at),
    guidanceAr: stringAt(rule, 'guidanceAr', at),
  };
}

function canonicalRule(rule: RuleDto, at: string): Json {
  return {
    ruleCode: rule.ruleCode,
    category: rule.category,
    evaluationMode: rule.evaluationMode,
    scope: canonicalScope(rule, `${at}.scope`),
    operator: rule.operator,
    expected: canonicalExpected(rule, `${at}.expected`),
    ...(rule.unit === NOT_APPLICABLE ? {} : { unit: rule.unit }),
    severity: rule.severity,
    blocking: rule.blocking,
    autofix: rule.autofix,
    origin: rule.origin,
    titleEn: rule.titleEn,
    titleAr: rule.titleAr,
    ...(rule.guidanceEn === '' ? {} : { guidanceEn: rule.guidanceEn }),
    ...(rule.guidanceAr === '' ? {} : { guidanceAr: rule.guidanceAr }),
  };
}

/**
 * The canonical `RuleScope` for a flat rule.
 *
 * The fields a scope kind uses must be present; the ones it does not use must
 * carry their neutral value. A section key on a PAGE rule is not noise to be
 * dropped: it means the answer is unsure what the rule applies to.
 */
export function canonicalScope(rule: RuleDto, at: string): Json {
  const uses = {
    sectionKey: rule.scopeKind === 'SECTION',
    element: rule.scopeKind === 'ELEMENT',
    pageSelector: rule.scopeKind === 'PAGE',
  };
  const present = {
    sectionKey: rule.sectionKey !== '',
    elementType: rule.elementType !== NOT_APPLICABLE,
    elementLevel: rule.elementLevel !== 0,
    pageSelector: rule.pageSelector !== NOT_APPLICABLE,
  };
  const consistent =
    rule.property !== '' &&
    present.sectionKey === uses.sectionKey &&
    present.elementType === uses.element &&
    (uses.element || !present.elementLevel) &&
    present.pageSelector === uses.pageSelector;
  if (!consistent) throw new ProposalConversionError('SCOPE_INCONSISTENT', at);

  switch (rule.scopeKind) {
    case 'DOCUMENT':
      return { kind: 'DOCUMENT', property: rule.property };
    case 'SECTION':
      return { kind: 'SECTION', sectionKey: rule.sectionKey, property: rule.property };
    case 'ELEMENT':
      return {
        kind: 'ELEMENT',
        elementType: rule.elementType,
        // 0 means any level. Any other value is passed through for the
        // canonical schema to judge (1-9), never clamped into range.
        ...(rule.elementLevel === 0 ? {} : { level: rule.elementLevel }),
        property: rule.property,
      };
    case 'METADATA':
      return { kind: 'METADATA', field: rule.property };
    case 'PAGE':
      return { kind: 'PAGE', pages: rule.pageSelector, property: rule.property };
    default:
      // Unreachable: scopeKind was checked against the canonical vocabulary.
      throw new ProposalConversionError('SCOPE_INCONSISTENT', at);
  }
}

/**
 * The canonical `RuleExpectedValue` for a flat rule.
 *
 * Exactly the field its type uses may carry a value; every other expected*
 * field must be neutral (`expectedBoolean` excepted: `false` is both a value
 * and the neutral one, so it cannot be told apart and is simply not read).
 */
export function canonicalExpected(rule: RuleDto, at: string): Json {
  const type = rule.expectedType;
  const carries = {
    NUMBER: rule.expectedNumber !== 0,
    STRING: rule.expectedText !== '',
    NUMBER_RANGE: rule.expectedMin !== 0 || rule.expectedMax !== 0,
    STRING_LIST: rule.expectedStrings.length > 0,
    NUMBER_LIST: rule.expectedNumbers.length > 0,
    PATTERN: rule.expectedPattern !== NOT_APPLICABLE || rule.patternArgument !== '',
  } as const;
  for (const [owner, hasValue] of Object.entries(carries)) {
    if (owner !== type && hasValue)
      throw new ProposalConversionError('EXPECTED_VALUE_INCONSISTENT', at);
  }

  const invalid = (): never => {
    throw new ProposalConversionError('EXPECTED_VALUE_INCONSISTENT', at);
  };
  switch (type) {
    case 'NUMBER':
      return { type, number: rule.expectedNumber };
    case 'STRING':
      return rule.expectedText === '' ? invalid() : { type, text: rule.expectedText };
    case 'BOOLEAN':
      return { type, boolean: rule.expectedBoolean };
    case 'NUMBER_RANGE':
      return rule.expectedMin > rule.expectedMax
        ? invalid()
        : { type, min: rule.expectedMin, max: rule.expectedMax };
    case 'STRING_LIST':
      return rule.expectedStrings.length === 0 ? invalid() : { type, values: rule.expectedStrings };
    case 'NUMBER_LIST':
      return rule.expectedNumbers.length === 0 ? invalid() : { type, values: rule.expectedNumbers };
    case 'PATTERN':
      return rule.expectedPattern === NOT_APPLICABLE
        ? invalid()
        : {
            type,
            pattern: rule.expectedPattern,
            ...(rule.patternArgument === '' ? {} : { argument: rule.patternArgument }),
          };
    case 'NONE':
      return { type };
    default:
      return invalid();
  }
}

// --- field readers: each one checks, none of them coerces ------------------

function objectWith(value: unknown, fields: readonly string[], at: string): Json {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new ProposalConversionError('NOT_AN_OBJECT', at);
  }
  const object = value as Json;
  for (const key of Object.keys(object)) {
    if (!fields.includes(key)) throw new ProposalConversionError('UNKNOWN_FIELD', `${at}.${key}`);
  }
  for (const field of fields) {
    if (!(field in object))
      throw new ProposalConversionError('FIELD_MISSING_OR_WRONG_TYPE', `${at}.${field}`);
  }
  return object;
}

function wrongType(at: string, field: string): never {
  throw new ProposalConversionError('FIELD_MISSING_OR_WRONG_TYPE', `${at}.${field}`);
}

function stringAt(object: Json, field: string, at: string): string {
  const value = object[field];
  return typeof value === 'string' ? value : wrongType(at, field);
}

function numberAt(object: Json, field: string, at: string): number {
  const value = object[field];
  return typeof value === 'number' && Number.isFinite(value) ? value : wrongType(at, field);
}

function integerAt(object: Json, field: string, at: string): number {
  const value = numberAt(object, field, at);
  return Number.isInteger(value) ? value : wrongType(at, field);
}

function booleanAt(object: Json, field: string, at: string): boolean {
  const value = object[field];
  return typeof value === 'boolean' ? value : wrongType(at, field);
}

function arrayAt(object: Json, field: string, at: string): unknown[] {
  const value = object[field];
  return Array.isArray(value) ? value : wrongType(at, field);
}

function stringsAt(object: Json, field: string, at: string): string[] {
  const values = arrayAt(object, field, at);
  return values.every((value) => typeof value === 'string')
    ? (values as string[])
    : wrongType(at, field);
}

function numbersAt(object: Json, field: string, at: string): number[] {
  const values = arrayAt(object, field, at);
  return values.every((value) => typeof value === 'number' && Number.isFinite(value))
    ? (values as number[])
    : wrongType(at, field);
}

function enumAt(object: Json, field: string, allowed: readonly string[], at: string): string {
  const value = stringAt(object, field, at);
  if (!allowed.includes(value)) {
    throw new ProposalConversionError('VALUE_OUTSIDE_VOCABULARY', `${at}.${field}`);
  }
  return value;
}

// ---------------------------------------------------------------------------
// Rule codes
// ---------------------------------------------------------------------------

/** The canonical RuleCode pattern, as PalCert's schema states it. */
const RULE_CODE = /^[A-Z][A-Z0-9]*(\.[A-Z0-9]+)*$/;
const RULE_CODE_MAX = 100;

export interface RuleCodeRewrites {
  /** Codes rewritten into canonical form (e.g. margin_left → MARGIN.LEFT). */
  readonly normalized: number;
  /** Codes with nothing safe to keep, replaced by a category-based code. */
  readonly fallback: number;
  /** Codes suffixed so that no two proposals in one answer share one. */
  readonly deduplicated: number;
}

/**
 * A model-written rule code in PalCert's canonical form, or null when nothing
 * safe is left to keep.
 *
 * A rule code is an identifier the reviewer can edit, not text the source
 * stated, so putting it into canonical form changes no meaning:
 * - ASCII letters upper-cased;
 * - every other character (whitespace, `_`, `-`, `/`, other punctuation,
 *   non-Latin script) becomes a separator;
 * - separators collapse to single dots, and leading and trailing ones go.
 *
 * Null when the result is empty, does not begin with a letter, or is longer
 * than the canonical limit — then no guess is made at what was meant.
 */
export function normalizeRuleCode(raw: string): string | null {
  const segments = raw
    .replace(/[a-z]/g, (letter) => letter.toUpperCase())
    .split(/[^A-Z0-9]+/)
    .filter((segment) => segment !== '');
  const code = segments.join('.');
  if (code === '' || !/^[A-Z]/.test(code) || code.length > RULE_CODE_MAX) return null;
  return code;
}

/** `TABLES` → `TABLES`, `TITLE_PAGE` → `TITLE.PAGE`: a category as a code prefix. */
function categoryPrefix(category: string): string {
  return normalizeRuleCode(category) ?? 'RULE';
}

/**
 * Put every suggested rule's code into canonical form, in place.
 *
 * Deterministic: the same answer always yields the same codes. A code that is
 * already canonical and unique is left exactly as it was. One that cannot be
 * normalized becomes `<CATEGORY>.RULE<n>`, where n is the proposal's
 * position (1-based) in this answer. A code already used earlier in the answer
 * gets `.2`, `.3` … appended, in answer order. None of the original values is
 * returned or logged — only counts.
 */
function normalizeRuleCodes(proposals: Array<{ suggestedRule?: Json }>): RuleCodeRewrites {
  let normalized = 0;
  let fallback = 0;
  let deduplicated = 0;
  const used = new Set<string>();

  proposals.forEach((proposal, index) => {
    const rule = proposal.suggestedRule;
    if (rule === undefined) return;
    const raw = rule.ruleCode as string;

    let code: string;
    if (RULE_CODE.test(raw) && raw.length <= RULE_CODE_MAX) {
      code = raw;
    } else {
      const candidate = normalizeRuleCode(raw);
      if (candidate !== null) {
        code = candidate;
        normalized += 1;
      } else {
        code = `${categoryPrefix(rule.category as string)}.RULE${index + 1}`;
        fallback += 1;
      }
    }

    if (used.has(code)) {
      let n = 2;
      while (used.has(`${code}.${n}`)) n += 1;
      code = `${code}.${n}`;
      deduplicated += 1;
    }
    used.add(code);
    rule.ruleCode = code;
  });

  return { normalized, fallback, deduplicated };
}
