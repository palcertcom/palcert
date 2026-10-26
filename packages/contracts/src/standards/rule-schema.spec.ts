import { describe, expect, it } from 'vitest';
import {
  OPERATOR_VALUE_COMPATIBILITY,
  RULE_AUTOFIX_CAPABILITIES,
  RULE_CATEGORIES,
  RULE_EVALUATION_MODES,
  RULE_OPERATORS,
  RULE_SEVERITIES,
  RULE_SEVERITY_WEIGHT,
  RULE_VALUE_TYPES,
  RuleOperator,
  RuleSeverity,
  RuleValueType,
  isOperatorValueCompatible,
  isValidRuleCode,
  operatorSupportsTolerance,
  unitRequiredFor,
} from './rule-schema.js';
import { describeRuleSchema } from './rule-builder-metadata.js';

describe('rule schema catalogue', () => {
  it('defines the twenty-three rule categories with no duplicates', () => {
    expect(RULE_CATEGORIES).toHaveLength(23);
    expect(new Set(RULE_CATEGORIES).size).toBe(RULE_CATEGORIES.length);
  });

  it('defines the fourteen operators with no duplicates', () => {
    expect(RULE_OPERATORS).toHaveLength(14);
    expect(new Set(RULE_OPERATORS).size).toBe(RULE_OPERATORS.length);
  });

  it('offers exactly three evaluation modes', () => {
    // The product rests on this partition (ADR-0002); a fourth mode would need
    // an explicit decision about whether it may certify.
    expect([...RULE_EVALUATION_MODES].sort()).toEqual(['AI_ASSISTED', 'DETERMINISTIC', 'MANUAL']);
  });

  it('gives every operator at least one accepted value type', () => {
    const empty = RULE_OPERATORS.filter(
      (operator) => (OPERATOR_VALUE_COMPATIBILITY[operator]?.length ?? 0) === 0,
    );
    expect(empty).toEqual([]);
  });

  it('only references value types that exist', () => {
    const known = new Set<string>(RULE_VALUE_TYPES);
    const unknown = RULE_OPERATORS.flatMap((operator) =>
      OPERATOR_VALUE_COMPATIBILITY[operator].filter((type) => !known.has(type)),
    );
    expect(unknown).toEqual([]);
  });

  it('makes only EXISTS and NOT_EXISTS unary', () => {
    const unary = RULE_OPERATORS.filter((operator) =>
      OPERATOR_VALUE_COMPATIBILITY[operator].includes(RuleValueType.NONE),
    );
    expect(unary).toEqual([RuleOperator.EXISTS, RuleOperator.NOT_EXISTS]);
  });

  it('never lets a unary operator also take an operand', () => {
    for (const operator of [RuleOperator.EXISTS, RuleOperator.NOT_EXISTS]) {
      expect(OPERATOR_VALUE_COMPATIBILITY[operator], operator).toEqual(['NONE']);
    }
  });

  it('weights every severity, ascending, with INFO worth nothing', () => {
    expect(Object.keys(RULE_SEVERITY_WEIGHT).sort()).toEqual([...RULE_SEVERITIES].sort());
    expect(RULE_SEVERITY_WEIGHT[RuleSeverity.INFO]).toBe(0);
    expect(RULE_SEVERITY_WEIGHT.MINOR).toBeLessThan(RULE_SEVERITY_WEIGHT.MAJOR);
    expect(RULE_SEVERITY_WEIGHT.MAJOR).toBeLessThan(RULE_SEVERITY_WEIGHT.CRITICAL);
  });

  it('names three autofix capabilities, NONE among them', () => {
    expect([...RULE_AUTOFIX_CAPABILITIES].sort()).toEqual(['ADVANCED', 'NONE', 'SAFE']);
  });
});

describe('operator / value compatibility', () => {
  it('accepts a number for a numeric comparison', () => {
    expect(isOperatorValueCompatible(RuleOperator.GREATER_THAN, RuleValueType.NUMBER)).toBe(true);
  });

  it('refuses a string for a numeric comparison', () => {
    expect(isOperatorValueCompatible(RuleOperator.GREATER_THAN, RuleValueType.STRING)).toBe(false);
  });

  it('requires a range for BETWEEN and nothing else', () => {
    expect(OPERATOR_VALUE_COMPATIBILITY[RuleOperator.BETWEEN]).toEqual(['NUMBER_RANGE']);
  });

  it('requires a named pattern for MATCHES_PATTERN, never a raw expression', () => {
    // A caller-supplied regular expression is executable input. The schema has
    // no shape that can carry one, which is the point.
    expect(OPERATOR_VALUE_COMPATIBILITY[RuleOperator.MATCHES_PATTERN]).toEqual(['PATTERN']);
  });

  it('accepts a list only for the membership operators', () => {
    const listOperators = RULE_OPERATORS.filter((operator) =>
      OPERATOR_VALUE_COMPATIBILITY[operator].some((type) => type.endsWith('_LIST')),
    );
    expect(listOperators).toEqual([RuleOperator.IN, RuleOperator.NOT_IN]);
  });
});

describe('tolerance compatibility', () => {
  it('allows a tolerance on a numeric equality', () => {
    expect(operatorSupportsTolerance(RuleOperator.EQUALS, RuleValueType.NUMBER)).toBe(true);
  });

  it('allows a tolerance on a numeric range', () => {
    expect(operatorSupportsTolerance(RuleOperator.BETWEEN, RuleValueType.NUMBER_RANGE)).toBe(true);
  });

  it('refuses a tolerance on a string equality', () => {
    expect(operatorSupportsTolerance(RuleOperator.EQUALS, RuleValueType.STRING)).toBe(false);
  });

  it('refuses a tolerance on a membership test', () => {
    expect(operatorSupportsTolerance(RuleOperator.IN, RuleValueType.NUMBER_LIST)).toBe(false);
  });

  it('refuses a tolerance on a unary operator', () => {
    expect(operatorSupportsTolerance(RuleOperator.EXISTS, RuleValueType.NONE)).toBe(false);
  });
});

describe('unit requirement', () => {
  it('requires a unit for every numeric value shape', () => {
    expect(unitRequiredFor(RuleValueType.NUMBER)).toBe(true);
    expect(unitRequiredFor(RuleValueType.NUMBER_RANGE)).toBe(true);
    expect(unitRequiredFor(RuleValueType.NUMBER_LIST)).toBe(true);
  });

  it('does not require a unit for a non-numeric value', () => {
    expect(unitRequiredFor(RuleValueType.STRING)).toBe(false);
    expect(unitRequiredFor(RuleValueType.NONE)).toBe(false);
  });
});

describe('rule codes', () => {
  it.each(['MARGIN.TOP.MIN', 'ABSTRACT', 'FONT.BODY.SIZE', 'REF.APA7.ORDER'])(
    'accepts %s',
    (code) => expect(isValidRuleCode(code)).toBe(true),
  );

  it.each([
    'margin.top',
    'MARGIN..TOP',
    '.MARGIN',
    'MARGIN.',
    'MARGIN TOP',
    'MARGIN-TOP',
    '1MARGIN',
    '',
  ])('rejects %s', (code) => expect(isValidRuleCode(code)).toBe(false));

  it('rejects a code longer than the documented maximum', () => {
    expect(isValidRuleCode('A'.repeat(121))).toBe(false);
  });
});

describe('rule schema descriptor', () => {
  it('describes every operator the catalogue defines', () => {
    const described = describeRuleSchema().operators.map((entry) => entry.operator);
    expect(described).toEqual([...RULE_OPERATORS]);
  });

  it('agrees with the compatibility matrix it is derived from', () => {
    for (const entry of describeRuleSchema().operators) {
      expect(entry.valueTypes, entry.operator).toEqual(
        OPERATOR_VALUE_COMPATIBILITY[entry.operator],
      );
      expect(entry.supportsTolerance, entry.operator).toBe(
        operatorSupportsTolerance(entry.operator, RuleValueType.NUMBER) ||
          operatorSupportsTolerance(entry.operator, RuleValueType.NUMBER_RANGE),
      );
    }
  });

  it('marks the argument-taking patterns', () => {
    const patterns = describeRuleSchema().patterns;
    expect(patterns.find((entry) => entry.name === 'STARTS_WITH')?.requiresArgument).toBe(true);
    expect(patterns.find((entry) => entry.name === 'DOI')?.requiresArgument).toBe(false);
  });
});
