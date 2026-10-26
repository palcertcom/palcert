import { describe, expect, it } from 'vitest';
import {
  RuleAutofixCapability,
  RuleCategory,
  RuleEvaluationMode,
  RuleOperator,
  RuleOrigin,
  RulePatternName,
  RuleSeverity,
  RuleUnit,
  type RuleDefinition,
} from './rule-schema.js';
import {
  containsControlCharacters,
  containsMarkup,
  validateRuleDefinition,
} from './rule-validation.js';

/** A minimal rule that validates cleanly; each test perturbs one thing. */
function validRule(overrides: Partial<RuleDefinition> = {}): Partial<RuleDefinition> {
  return {
    ruleCode: 'MARGIN.TOP.MIN',
    category: RuleCategory.MARGINS,
    evaluationMode: RuleEvaluationMode.DETERMINISTIC,
    scope: { kind: 'DOCUMENT', property: 'marginTop' },
    operator: RuleOperator.GREATER_THAN_OR_EQUAL,
    expected: { type: 'NUMBER', number: 25 },
    unit: RuleUnit.MILLIMETRE,
    tolerance: 0.5,
    severity: RuleSeverity.MAJOR,
    blocking: true,
    autofix: RuleAutofixCapability.SAFE,
    origin: RuleOrigin.ORGANIZATION_POLICY,
    originReference: 'Graduate Studies Handbook, s. 4.2',
    displayOrder: 1,
    titleEn: 'Top margin at least 25 mm',
    titleAr: 'الهامش العلوي 25 مم على الأقل',
    descriptionEn: null,
    descriptionAr: null,
    guidanceEn: null,
    guidanceAr: null,
    ...overrides,
  };
}

const pathsOf = (rule: Partial<RuleDefinition>): string[] =>
  validateRuleDefinition(rule).issues.map((issue) => issue.path);

const codesFor = (rule: Partial<RuleDefinition>, path: string): string[] =>
  validateRuleDefinition(rule)
    .issues.filter((issue) => issue.path === path)
    .map((issue) => issue.code);

describe('validateRuleDefinition — the happy path', () => {
  it('accepts a well-formed deterministic rule', () => {
    const result = validateRuleDefinition(validRule());
    expect(result.issues).toEqual([]);
    expect(result.valid).toBe(true);
  });

  it('accepts a unary rule with no operand and no unit', () => {
    const result = validateRuleDefinition(
      validRule({
        ruleCode: 'ABSTRACT.PRESENT',
        operator: RuleOperator.EXISTS,
        expected: { type: 'NONE' },
        unit: null,
        tolerance: null,
        scope: { kind: 'SECTION', sectionKey: 'ABSTRACT', property: 'wordCount' },
      }),
    );
    expect(result.issues).toEqual([]);
  });

  it('accepts a pattern rule using a named PalCert pattern', () => {
    const result = validateRuleDefinition(
      validRule({
        ruleCode: 'REF.DOI.FORMAT',
        operator: RuleOperator.MATCHES_PATTERN,
        expected: { type: 'PATTERN', pattern: RulePatternName.DOI },
        unit: null,
        tolerance: null,
        scope: { kind: 'ELEMENT', elementType: 'REFERENCE_ENTRY', property: 'doi' },
      }),
    );
    expect(result.issues).toEqual([]);
  });
});

describe('validateRuleDefinition — operator and value compatibility', () => {
  it('rejects a string operand for a numeric comparison', () => {
    expect(
      codesFor(
        validRule({ expected: { type: 'STRING', text: 'wide' }, unit: null, tolerance: null }),
        'expected.type',
      ),
    ).toContain('OPERATOR_INCOMPATIBLE');
  });

  it('names the accepted value types in the message, so the author can fix it', () => {
    const issue = validateRuleDefinition(
      validRule({ expected: { type: 'STRING', text: 'wide' }, unit: null, tolerance: null }),
    ).issues.find((entry) => entry.code === 'OPERATOR_INCOMPATIBLE');
    expect(issue?.message).toContain('NUMBER');
  });

  it('rejects a range operand for EQUALS', () => {
    expect(
      codesFor(
        validRule({
          operator: RuleOperator.EQUALS,
          expected: { type: 'NUMBER_RANGE', min: 1, max: 2 },
        }),
        'expected.type',
      ),
    ).toContain('OPERATOR_INCOMPATIBLE');
  });

  it('accepts a range operand for BETWEEN', () => {
    expect(
      validateRuleDefinition(
        validRule({
          operator: RuleOperator.BETWEEN,
          expected: { type: 'NUMBER_RANGE', min: 10, max: 20 },
        }),
      ).issues,
    ).toEqual([]);
  });

  it('rejects an inverted range', () => {
    expect(
      codesFor(
        validRule({
          operator: RuleOperator.BETWEEN,
          expected: { type: 'NUMBER_RANGE', min: 30, max: 10 },
        }),
        'expected.min',
      ),
    ).toEqual(['INVALID_RANGE']);
  });

  it('rejects an operand on a unary operator', () => {
    expect(
      codesFor(
        validRule({
          operator: RuleOperator.EXISTS,
          expected: { type: 'NUMBER', number: 1 },
        }),
        'expected.type',
      ),
    ).toContain('OPERATOR_INCOMPATIBLE');
  });

  it('rejects an empty list', () => {
    expect(
      codesFor(
        validRule({
          operator: RuleOperator.IN,
          expected: { type: 'STRING_LIST', values: [] },
          unit: null,
          tolerance: null,
        }),
        'expected.values',
      ),
    ).toEqual(['REQUIRED']);
  });

  it('rejects duplicate list values', () => {
    expect(
      codesFor(
        validRule({
          operator: RuleOperator.IN,
          expected: { type: 'STRING_LIST', values: ['Arial', 'Arial'] },
          unit: null,
          tolerance: null,
        }),
        'expected.values',
      ),
    ).toEqual(['DUPLICATE']);
  });

  it('rejects a non-finite number', () => {
    expect(
      codesFor(validRule({ expected: { type: 'NUMBER', number: Number.NaN } }), 'expected.number'),
    ).toEqual(['INVALID']);
  });

  it('rejects an unknown pattern name', () => {
    expect(
      codesFor(
        validRule({
          operator: RuleOperator.MATCHES_PATTERN,
          expected: { type: 'PATTERN', pattern: 'EVAL' as RulePatternName },
          unit: null,
          tolerance: null,
        }),
        'expected.pattern',
      ),
    ).toEqual(['INVALID']);
  });

  it('requires an argument for STARTS_WITH', () => {
    expect(
      codesFor(
        validRule({
          operator: RuleOperator.MATCHES_PATTERN,
          expected: { type: 'PATTERN', pattern: RulePatternName.STARTS_WITH },
          unit: null,
          tolerance: null,
        }),
        'expected.argument',
      ),
    ).toEqual(['REQUIRED']);
  });

  it('refuses an argument for a pattern that takes none', () => {
    expect(
      codesFor(
        validRule({
          operator: RuleOperator.MATCHES_PATTERN,
          expected: { type: 'PATTERN', pattern: RulePatternName.DOI, argument: 'x' },
          unit: null,
          tolerance: null,
        }),
        'expected.argument',
      ),
    ).toEqual(['NOT_APPLICABLE']);
  });
});

describe('validateRuleDefinition — units and tolerance', () => {
  it('requires a unit on a numeric rule', () => {
    expect(codesFor(validRule({ unit: null }), 'unit')).toEqual(['REQUIRED']);
  });

  it('accepts COUNT as an explicit "no physical unit"', () => {
    expect(
      validateRuleDefinition(
        validRule({
          ruleCode: 'HEADING.L1.COUNT.MIN',
          unit: RuleUnit.COUNT,
          tolerance: null,
        }),
      ).issues,
    ).toEqual([]);
  });

  it('refuses a unit on a non-numeric rule', () => {
    expect(
      codesFor(
        validRule({
          operator: RuleOperator.EQUALS,
          expected: { type: 'STRING', text: 'Times New Roman' },
          tolerance: null,
        }),
        'unit',
      ),
    ).toEqual(['NOT_APPLICABLE']);
  });

  it('refuses a tolerance where it means nothing', () => {
    expect(
      codesFor(
        validRule({
          operator: RuleOperator.EQUALS,
          expected: { type: 'STRING', text: 'Times New Roman' },
          unit: null,
          tolerance: 0.5,
        }),
        'tolerance',
      ),
    ).toEqual(['NOT_APPLICABLE']);
  });

  it('refuses a negative tolerance', () => {
    expect(codesFor(validRule({ tolerance: -1 }), 'tolerance')).toEqual(['INVALID']);
  });
});

describe('validateRuleDefinition — scope', () => {
  it('rejects an unknown scope kind', () => {
    expect(
      codesFor(
        validRule({ scope: { kind: 'FILESYSTEM', property: 'path' } as never }),
        'scope.kind',
      ),
    ).toEqual(['INVALID']);
  });

  it('rejects a section key that is not an UPPER_SNAKE_CASE identifier', () => {
    expect(
      codesFor(
        validRule({
          scope: { kind: 'SECTION', sectionKey: '../etc/passwd', property: 'wordCount' },
        }),
        'scope.sectionKey',
      ),
    ).toEqual(['INVALID']);
  });

  it('rejects a property that is not a lowerCamelCase identifier', () => {
    expect(
      codesFor(
        validRule({ scope: { kind: 'DOCUMENT', property: 'margin top' } }),
        'scope.property',
      ),
    ).toEqual(['INVALID']);
  });

  it('allows a heading level on a heading', () => {
    expect(
      validateRuleDefinition(
        validRule({
          scope: { kind: 'ELEMENT', elementType: 'HEADING', level: 2, property: 'fontSize' },
          unit: RuleUnit.POINT,
        }),
      ).issues,
    ).toEqual([]);
  });

  it('refuses a heading level on a table', () => {
    expect(
      codesFor(
        validRule({
          scope: { kind: 'ELEMENT', elementType: 'TABLE', level: 2, property: 'fontSize' },
          unit: RuleUnit.POINT,
        }),
        'scope.level',
      ),
    ).toEqual(['NOT_APPLICABLE']);
  });

  it('refuses a heading level outside 1-9', () => {
    expect(
      codesFor(
        validRule({
          scope: { kind: 'ELEMENT', elementType: 'HEADING', level: 0, property: 'fontSize' },
          unit: RuleUnit.POINT,
        }),
        'scope.level',
      ),
    ).toEqual(['INVALID']);
  });
});

describe('rule schema v1 vs v2 — the blocking invariant', () => {
  const v1 = { schemaVersion: 1 } as const;
  const v2 = { schemaVersion: 2 } as const;

  const blockingCodes = (rule: Partial<RuleDefinition>, options: { schemaVersion: number }) =>
    validateRuleDefinition(rule, options)
      .issues.filter((issue) => issue.path === 'blocking')
      .map((issue) => issue.code);

  it('refuses a blocking AI-assisted rule under v1', () => {
    // The historical invariant, still applied to historical content.
    expect(
      blockingCodes(validRule({ evaluationMode: RuleEvaluationMode.AI_ASSISTED }), v1),
    ).toEqual(['NOT_APPLICABLE']);
  });

  it('refuses a blocking manual rule under v1', () => {
    expect(blockingCodes(validRule({ evaluationMode: RuleEvaluationMode.MANUAL }), v1)).toEqual([
      'NOT_APPLICABLE',
    ]);
  });

  it('accepts a blocking AI-assisted rule under v2', () => {
    // A journal may make blind-review anonymization blocking even though
    // judging it needs a model or a person. The safety property moves to the
    // engine: such a rule resolves to INDETERMINATE + requiresReview, and a
    // final compliance decision cannot be taken while it is outstanding.
    expect(
      validateRuleDefinition(validRule({ evaluationMode: RuleEvaluationMode.AI_ASSISTED }), v2)
        .issues,
    ).toEqual([]);
  });

  it('accepts a blocking manual rule under v2', () => {
    expect(
      validateRuleDefinition(
        validRule({ evaluationMode: RuleEvaluationMode.MANUAL, autofix: 'NONE' }),
        v2,
      ).issues,
    ).toEqual([]);
  });

  it('validates against the current version when none is named', () => {
    expect(
      validateRuleDefinition(validRule({ evaluationMode: RuleEvaluationMode.AI_ASSISTED })).issues,
    ).toEqual([]);
  });

  it('refuses a rule schema version this release does not implement', () => {
    // Not evaluated on a guess: a v99 rule may mean something this code has
    // never heard of.
    const result = validateRuleDefinition(validRule(), { schemaVersion: 99 });
    expect(result.valid).toBe(false);
    expect(result.issues).toEqual([
      {
        path: 'ruleSchemaVersion',
        code: 'RULE_SCHEMA_UNSUPPORTED',
        message: 'Rule schema version 99 is not supported by this release.',
      },
    ]);
  });

  it('keeps every other invariant identical across versions', () => {
    // v2 relaxed exactly one rule. A malformed operand must still be refused
    // in both, or the amendment would have quietly widened more than intended.
    for (const options of [v1, v2]) {
      const issues = validateRuleDefinition(
        validRule({
          operator: RuleOperator.GREATER_THAN,
          expected: { type: 'STRING', text: 'wide' },
          unit: null,
          tolerance: null,
          blocking: false,
        }),
        options,
      ).issues;
      expect(issues.map((issue) => issue.code)).toContain('OPERATOR_INCOMPATIBLE');
    }
  });

  it('still refuses autofix on a manual rule under v2', () => {
    expect(
      validateRuleDefinition(
        validRule({
          evaluationMode: RuleEvaluationMode.MANUAL,
          blocking: false,
          autofix: RuleAutofixCapability.SAFE,
        }),
        v2,
      ).issues.map((issue) => issue.path),
    ).toContain('autofix');
  });
});

describe('validateRuleDefinition — remaining safety invariants', () => {
  it('allows a non-blocking AI-assisted rule', () => {
    expect(
      validateRuleDefinition(
        validRule({
          evaluationMode: RuleEvaluationMode.AI_ASSISTED,
          blocking: false,
          autofix: RuleAutofixCapability.ADVANCED,
        }),
      ).issues,
    ).toEqual([]);
  });

  it('refuses autofix on a manual rule', () => {
    expect(
      codesFor(
        validRule({ evaluationMode: RuleEvaluationMode.MANUAL, blocking: false }),
        'autofix',
      ),
    ).toEqual(['NOT_APPLICABLE']);
  });
});

describe('validateRuleDefinition — untrusted text', () => {
  it.each([
    ['titleEn', '<script>alert(1)</script>'],
    ['titleAr', '<img src=x onerror=alert(1)>'],
    ['descriptionEn', 'See <b>here</b>'],
    ['guidanceEn', '</textarea><svg onload=alert(1)>'],
  ])('refuses markup in %s', (field, value) => {
    expect(codesFor(validRule({ [field]: value }), field)).toContain('MARKUP_NOT_ALLOWED');
  });

  it('refuses markup in a string operand', () => {
    expect(
      codesFor(
        validRule({
          operator: RuleOperator.EQUALS,
          expected: { type: 'STRING', text: '<script>x</script>' },
          unit: null,
          tolerance: null,
        }),
        'expected.text',
      ),
    ).toContain('MARKUP_NOT_ALLOWED');
  });

  it('refuses a bidi override that would make the text read differently', () => {
    expect(codesFor(validRule({ titleEn: `Top margin \u202Etxet neddih` }), 'titleEn')).toContain(
      'CONTROL_CHARACTERS',
    );
  });

  it('allows ordinary Arabic text, which is not a control character', () => {
    expect(containsControlCharacters('الهامش العلوي 25 مم')).toBe(false);
  });

  it('allows a mathematical less-than sign, which is not markup', () => {
    expect(containsMarkup('spacing < 1.5')).toBe(false);
  });

  it('requires both locales for the title', () => {
    expect(codesFor(validRule({ titleAr: '   ' }), 'titleAr')).toEqual(['REQUIRED']);
    expect(codesFor(validRule({ titleEn: '' }), 'titleEn')).toEqual(['REQUIRED']);
  });

  it('enforces the documented maximum title length', () => {
    expect(codesFor(validRule({ titleEn: 'a'.repeat(201) }), 'titleEn')).toEqual(['TOO_LONG']);
  });
});

describe('validateRuleDefinition — required fields', () => {
  it('reports every missing field at once rather than the first', () => {
    const paths = pathsOf({});
    expect(paths).toContain('ruleCode');
    expect(paths).toContain('category');
    expect(paths).toContain('scope');
    expect(paths).toContain('expected');
    expect(paths).toContain('operator');
    expect(paths).toContain('titleEn');
    expect(paths).toContain('titleAr');
  });

  it('rejects an unknown category', () => {
    expect(codesFor(validRule({ category: 'ANYTHING' as RuleCategory }), 'category')).toEqual([
      'INVALID',
    ]);
  });
});
