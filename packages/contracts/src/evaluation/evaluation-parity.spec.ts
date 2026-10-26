import { describe, expect, it } from 'vitest';
import {
  RULE_ELEMENT_TYPES,
  RULE_PAGE_SELECTORS,
  RULE_SCOPE_KINDS,
  RULE_SEVERITIES,
  RULE_EVALUATION_MODES,
  RULE_UNITS,
} from '../standards/rule-schema.js';
import {
  COVERAGE_STATUSES,
  EVALUATION_OUTCOMES,
  EVIDENCE_LEVELS,
  FACT_VALUE_TYPES,
  REASON_CODES,
} from './constants.js';
import { EVALUATION_JSON_SCHEMA } from './schema.generated.js';

type Defs = Record<string, { enum?: readonly string[] }>;
const defs = (EVALUATION_JSON_SCHEMA as unknown as { $defs: Defs }).$defs;

const enumOf = (name: string): readonly string[] => {
  const values = defs[name]?.enum;
  if (values === undefined) throw new Error(`${name} is not an enum in the evaluation schema`);
  return values;
};

/**
 * The evaluation schema restates several Phase 3 vocabularies, because the
 * Python engine reads the schema and has no access to the TypeScript
 * catalogue. Restating them is only safe if they cannot diverge — which is what
 * this file enforces. A unit added to Phase 3 but not to the schema (or the
 * reverse) fails here rather than producing a fact the engine silently drops.
 */
describe('evaluation schema ↔ Phase 3 catalogue parity', () => {
  it.each([
    ['Unit', RULE_UNITS],
    ['RuleScopeKind', RULE_SCOPE_KINDS],
    ['RuleElementType', RULE_ELEMENT_TYPES],
    ['RulePageSelector', RULE_PAGE_SELECTORS],
  ])('%s matches the Phase 3 catalogue exactly', (name, catalogue) => {
    expect([...enumOf(name)].sort()).toEqual([...catalogue].sort());
  });

  it('shares the severity vocabulary with Phase 3', () => {
    const severity = (
      defs.RuleEvaluationResult as unknown as {
        properties: { severity: { enum: string[] } };
      }
    ).properties.severity.enum;
    expect([...severity].sort()).toEqual([...RULE_SEVERITIES].sort());
  });

  it('shares the evaluation-mode vocabulary with Phase 3', () => {
    const modes = (
      defs.RuleEvaluationResult as unknown as {
        properties: { evaluationMode: { enum: string[] } };
      }
    ).properties.evaluationMode.enum;
    expect([...modes].sort()).toEqual([...RULE_EVALUATION_MODES].sort());
  });
});

/**
 * The runtime constants exist so TypeScript callers do not hand-type enum
 * members. They are only useful if they are complete.
 */
describe('evaluation schema ↔ runtime constants parity', () => {
  it.each([
    ['EvaluationOutcome', EVALUATION_OUTCOMES],
    ['EvidenceLevel', EVIDENCE_LEVELS],
    ['CoverageStatus', COVERAGE_STATUSES],
    ['FactValueType', FACT_VALUE_TYPES],
    ['ReasonCode', REASON_CODES],
  ])('%s is mirrored completely', (name, constants) => {
    expect([...enumOf(name)].sort()).toEqual([...constants].sort());
  });
});

describe('the evaluation schema itself', () => {
  it('declares Draft 2020-12, which both runtimes validate against', () => {
    expect((EVALUATION_JSON_SCHEMA as unknown as { $schema: string }).$schema).toBe(
      'https://json-schema.org/draft/2020-12/schema',
    );
  });

  it('closes every object, so an unknown field is rejected rather than ignored', () => {
    // A silently dropped field is how an extractor ends up believing it sent
    // evidence the engine never saw.
    const open: string[] = [];
    for (const [name, definition] of Object.entries(defs)) {
      const node = definition as Record<string, unknown>;
      if (node.type !== 'object') continue;
      // `structured` is deliberately open: it carries extractor-specific
      // composite observations that no Phase 4 operator interprets.
      if (name === 'FactValue' && node.unevaluatedProperties === false) continue;
      if (node.additionalProperties !== false && node.unevaluatedProperties !== false) {
        open.push(name);
      }
    }
    expect(open).toEqual([]);
  });

  it('bounds every string and array, so a hostile payload cannot be unbounded', () => {
    const unbounded: string[] = [];

    const walk = (node: unknown, path: string): void => {
      if (typeof node !== 'object' || node === null) return;
      const record = node as Record<string, unknown>;

      if (record.type === 'string' && record.maxLength === undefined && record.enum === undefined) {
        if (record.pattern === undefined) unbounded.push(path);
      }
      if (record.type === 'array' && record.maxItems === undefined) unbounded.push(path);

      for (const [key, value] of Object.entries(record)) {
        if (typeof value === 'object' && value !== null) walk(value, `${path}.${key}`);
      }
    };

    walk(defs, '$defs');
    expect(unbounded).toEqual([]);
  });
});
