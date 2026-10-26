import { describe, expect, it } from 'vitest';
import { RULE_PROPOSAL_JSON_SCHEMA } from './proposal-schema.generated';
import {
  RULE_AUTOFIX_CAPABILITIES,
  RULE_CATEGORIES,
  RULE_ELEMENT_TYPES,
  RULE_EVALUATION_MODES,
  RULE_OPERATORS,
  RULE_ORIGINS,
  RULE_PAGE_SELECTORS,
  RULE_PATTERN_NAMES,
  RULE_SEVERITIES,
  RULE_UNITS,
} from '../standards/rule-schema';
import { RULE_PROPOSAL_KINDS } from './run';
import { ExtractionContract, validateExtractionContract } from './validator';

/**
 * The proposal schema is PalCert's vocabulary, not a second one (§50).
 *
 * The model may only select from the rule schema PalCert already has: existing
 * categories, operators, value types, units, patterns. Two lists of the same
 * vocabulary drift the first time someone adds an operator, and the drift shows
 * up as a model proposing something the validator then refuses for no reason a
 * reviewer could understand. These tests are what stops that.
 */

type Defs = Record<string, { enum?: readonly string[] } | undefined>;
const defs = RULE_PROPOSAL_JSON_SCHEMA.$defs as unknown as Defs;

function enumOf(name: string): readonly string[] {
  const definition = defs[name];
  if (definition?.enum === undefined) throw new Error(`${name} is not an enum in the schema`);
  return definition.enum;
}

describe('the proposal schema speaks PalCert’s rule vocabulary', () => {
  it.each([
    ['RuleCategory', RULE_CATEGORIES],
    ['RuleEvaluationMode', RULE_EVALUATION_MODES],
    ['RuleSeverity', RULE_SEVERITIES],
    ['RuleAutofixCapability', RULE_AUTOFIX_CAPABILITIES],
    ['RuleOrigin', RULE_ORIGINS],
    ['RuleUnit', RULE_UNITS],
    ['RuleOperator', RULE_OPERATORS],
    ['RuleElementType', RULE_ELEMENT_TYPES],
    ['RulePageSelector', RULE_PAGE_SELECTORS],
    ['RulePatternName', RULE_PATTERN_NAMES],
  ])('offers exactly the %s values the rule schema defines', (name, expected) => {
    expect([...enumOf(name)].sort()).toEqual([...expected].sort());
  });

  it('offers exactly the proposal kinds the domain defines', () => {
    const kinds = (
      RULE_PROPOSAL_JSON_SCHEMA.$defs.RuleProposal.properties.kind as { enum: readonly string[] }
    ).enum;
    expect([...kinds].sort()).toEqual([...RULE_PROPOSAL_KINDS].sort());
  });

  it('never lets a model author executable semantics', () => {
    // The single most important property of the whole schema (§50, ADR-0022).
    // A pattern is selected from a registry by name; there is no field anywhere
    // that could carry a regular expression, a query or an expression.
    const serialized = JSON.stringify(RULE_PROPOSAL_JSON_SCHEMA);
    expect(serialized).not.toMatch(/"regex"|"sql"|"xpath"|"script"|"expression"|"code"/i);
    // `pattern` appears only as JSON Schema's own string constraint and as the
    // registry selector, never as a value the model supplies free-form.
    const patternValue = (
      RULE_PROPOSAL_JSON_SCHEMA.$defs.RuleExpectedValue as { oneOf: readonly unknown[] }
    ).oneOf.find(
      (branch) =>
        (branch as { properties?: { type?: { const?: string } } }).properties?.type?.const ===
        'PATTERN',
    ) as { properties: { pattern: { $ref: string } } };
    expect(patternValue.properties.pattern.$ref).toBe('#/$defs/RulePatternName');
  });
});

describe('the proposal contract validator', () => {
  const explicit = {
    proposalKey: 'p-1',
    kind: 'EXPLICIT_REQUIREMENT',
    evidenceIds: ['e-1'],
    interpretationEn: 'The left margin must be 30 mm.',
    interpretationAr: 'يجب أن يكون الهامش الأيسر 30 مم.',
    requiresClarification: false,
    suggestedRule: {
      ruleCode: 'PAGE.MARGIN.LEFT',
      category: 'MARGINS',
      evaluationMode: 'DETERMINISTIC',
      scope: { kind: 'PAGE', pages: 'ALL', property: 'marginLeft' },
      operator: 'EQUALS',
      expected: { type: 'NUMBER', number: 30 },
      unit: 'MILLIMETRE',
      severity: 'MAJOR',
      blocking: false,
      autofix: 'NONE',
      origin: 'ORGANIZATION_POLICY',
      titleEn: 'Left margin 30 mm',
      titleAr: 'الهامش الأيسر 30 مم',
    },
  };

  it('accepts a well-formed explicit requirement', () => {
    const result = validateExtractionContract(ExtractionContract.PROPOSAL_OUTPUT, {
      proposals: [explicit],
    });
    expect(result.issues).toEqual([]);
    expect(result.valid).toBe(true);
  });

  it('accepts an empty proposal list, because finding nothing is an answer', () => {
    // A model that invents requirements to look thorough is worse than one that
    // says the evidence supports none (§159).
    expect(
      validateExtractionContract(ExtractionContract.PROPOSAL_OUTPUT, { proposals: [] }).valid,
    ).toBe(true);
  });

  it('rejects a made-up category', () => {
    const result = validateExtractionContract(ExtractionContract.PROPOSAL_OUTPUT, {
      proposals: [{ ...explicit, suggestedRule: { ...explicit.suggestedRule, category: 'VIBES' } }],
    });
    expect(result.valid).toBe(false);
  });

  it('rejects an invented property key shape', () => {
    const result = validateExtractionContract(ExtractionContract.PROPOSAL_OUTPUT, {
      proposals: [
        {
          ...explicit,
          suggestedRule: {
            ...explicit.suggestedRule,
            scope: { kind: 'PAGE', pages: 'ALL', property: 'Beautiful Formatting!' },
          },
        },
      ],
    });
    expect(result.valid).toBe(false);
  });

  it('accepts every expected-value shape the rule schema itself accepts', () => {
    // The mismatch this test exists to prevent: a proposal schema that models
    // an operand differently from the rule schema produces output the model
    // was told was correct and PalCert then refuses, for a reason no reviewer
    // could understand (§50).
    const shapes = [
      { operator: 'EQUALS', expected: { type: 'NUMBER', number: 30 } },
      { operator: 'EQUALS', expected: { type: 'STRING', text: 'Times New Roman' } },
      { operator: 'EQUALS', expected: { type: 'BOOLEAN', boolean: true } },
      { operator: 'BETWEEN', expected: { type: 'NUMBER_RANGE', min: 20, max: 40 } },
      { operator: 'IN', expected: { type: 'STRING_LIST', values: ['APA', 'MLA'] } },
      { operator: 'IN', expected: { type: 'NUMBER_LIST', values: [11, 12] } },
      { operator: 'MATCHES_PATTERN', expected: { type: 'PATTERN', pattern: 'TITLE_CASE' } },
      { operator: 'EXISTS', expected: { type: 'NONE' } },
    ];
    for (const shape of shapes) {
      const result = validateExtractionContract(ExtractionContract.PROPOSAL_OUTPUT, {
        proposals: [{ ...explicit, suggestedRule: { ...explicit.suggestedRule, ...shape } }],
      });
      expect(result.issues, JSON.stringify(shape)).toEqual([]);
    }
  });

  it('rejects a measurement that is not a number', () => {
    const result = validateExtractionContract(ExtractionContract.PROPOSAL_OUTPUT, {
      proposals: [
        {
          ...explicit,
          suggestedRule: {
            ...explicit.suggestedRule,
            expected: { type: 'NUMBER', number: 'thirty' },
          },
        },
      ],
    });
    expect(result.valid).toBe(false);
  });

  it('rejects an unknown field, so a model cannot smuggle one through', () => {
    const result = validateExtractionContract(ExtractionContract.PROPOSAL_OUTPUT, {
      proposals: [{ ...explicit, autoAccept: true }],
    });
    expect(result.valid).toBe(false);
    expect(JSON.stringify(result.issues)).toMatch(/additional/i);
  });

  it('accepts an unrepresentable requirement with no rule at all', () => {
    // The point of the kind: a real requirement PalCert cannot express is
    // reported, not discarded and not forced into an unrelated property (§48).
    const result = validateExtractionContract(ExtractionContract.PROPOSAL_OUTPUT, {
      proposals: [
        {
          proposalKey: 'p-2',
          kind: 'UNREPRESENTABLE_REQUIREMENT',
          evidenceIds: ['e-2'],
          interpretationEn: 'The discussion must engage critically with the literature.',
          interpretationAr: 'يجب أن تتعامل المناقشة نقدياً مع الأدبيات.',
          requiresClarification: true,
        },
      ],
    });
    expect(result.issues).toEqual([]);
  });
});
