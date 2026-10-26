import {
  ExtractionContract,
  RULE_PROPOSAL_JSON_SCHEMA,
  validateExtractionContract,
} from '@palcert/contracts';
import {
  ANTHROPIC_PROPOSAL_SCHEMA,
  MAX_REPORTED_ISSUES,
  NOT_APPLICABLE,
  normalizeRuleCode,
  sanitizedIssue,
  ProposalConversionError,
  VOCABULARY,
  toCanonicalProposals,
  type ProposalRejection,
} from './anthropic-proposal-dto';
import { answerWithRule, wireProposal, wireRule } from './anthropic-proposal-dto.fixtures';
import {
  providerOutputFormat,
  unsupportedKeywords,
  type JsonSchema,
} from './provider-output-schema';

/**
 * Pass B's provider wire shape, and the only road from it to PalCert's
 * canonical proposal output.
 *
 * The canonical schema compiled to a grammar Anthropic refused as too large
 * ("The compiled grammar is too large …", 400 on 8443). These tests pin the
 * flat replacement: what it sends, how it converts, what it refuses, and that
 * the canonical schema still has the last word.
 */

const LIMITS = { maxProposals: 10 };
const RAW = RULE_PROPOSAL_JSON_SCHEMA as unknown as JsonSchema;

function convert(answer: unknown) {
  return toCanonicalProposals(answer, LIMITS);
}

function rejection(answer: unknown): ProposalRejection {
  try {
    convert(answer);
  } catch (error) {
    if (error instanceof ProposalConversionError) return error.reason;
    throw error;
  }
  throw new Error('expected the answer to be refused');
}

function firstRule(answer: unknown): Record<string, unknown> {
  return convert(answer).proposals[0]!.suggestedRule as unknown as Record<string, unknown>;
}

// --- structural measures of a schema, as the provider would compile it -----

interface Complexity {
  /** Alternatives in every anyOf/oneOf, summed. */
  unionBranches: number;
  /** Object properties not listed in `required`. */
  optionalProperties: number;
  /** Schema nodes, after resolving nothing (a $ref is one node). */
  nodes: number;
  /** Objects whose content is a union of objects: the shape that failed. */
  unionsOfObjects: number;
}

function complexity(schema: unknown): Complexity {
  const total: Complexity = {
    unionBranches: 0,
    optionalProperties: 0,
    nodes: 0,
    unionsOfObjects: 0,
  };
  const walk = (value: unknown): void => {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return;
    const node = value as JsonSchema;
    total.nodes += 1;
    for (const key of ['anyOf', 'oneOf']) {
      const branches = node[key];
      if (Array.isArray(branches)) {
        total.unionBranches += branches.length;
        if (branches.some((branch) => (branch as JsonSchema).type === 'object')) {
          total.unionsOfObjects += 1;
        }
        branches.forEach(walk);
      }
    }
    if (node.properties !== undefined) {
      const required = new Set((node.required as string[] | undefined) ?? []);
      for (const [name, child] of Object.entries(node.properties as JsonSchema)) {
        if (!required.has(name)) total.optionalProperties += 1;
        walk(child);
      }
    }
    for (const key of ['$defs', 'definitions']) {
      if (node[key] !== undefined) Object.values(node[key] as JsonSchema).forEach(walk);
    }
    if (node.items !== undefined) walk(node.items);
    if (Array.isArray(node.allOf)) node.allOf.forEach(walk);
  };
  walk(schema);
  return total;
}

describe('the Pass B schema sent to the provider', () => {
  const wire = providerOutputFormat(ANTHROPIC_PROPOSAL_SCHEMA, { transform: false }).schema;

  it('has no oneOf, anyOf or allOf anywhere', () => {
    const text = JSON.stringify(wire);
    expect(text).not.toContain('"oneOf"');
    expect(text).not.toContain('"anyOf"');
    expect(text).not.toContain('"allOf"');
    expect(complexity(wire).unionBranches).toBe(0);
  });

  it('has no optional property: every field is required', () => {
    expect(complexity(wire).optionalProperties).toBe(0);
  });

  it('contains nothing the provider rejects, and closes every object', () => {
    expect(unsupportedKeywords(wire)).toEqual([]);
  });

  it('is sent unchanged: the SDK helper does not fold its enums away', () => {
    expect(wire).toEqual(ANTHROPIC_PROPOSAL_SCHEMA);
  });

  it('keeps the closed vocabularies as enums, identical to the canonical ones', () => {
    const proposal = (wire.properties as JsonSchema).proposals as JsonSchema;
    const proposalFields = (proposal.items as JsonSchema).properties as Record<string, JsonSchema>;
    const rule = (proposalFields.suggestedRule!.items as JsonSchema).properties as Record<
      string,
      JsonSchema
    >;
    const defs = RAW.$defs as Record<string, JsonSchema>;
    const canonical = (name: string) => defs[name]!.enum as string[];

    expect(proposalFields.kind!.enum).toEqual(VOCABULARY.proposalKinds);
    expect(rule.category!.enum).toEqual(canonical('RuleCategory'));
    expect(rule.evaluationMode!.enum).toEqual(canonical('RuleEvaluationMode'));
    expect(rule.scopeKind!.enum).toEqual(['DOCUMENT', 'SECTION', 'ELEMENT', 'METADATA', 'PAGE']);
    expect(rule.elementType!.enum).toEqual([...canonical('RuleElementType'), NOT_APPLICABLE]);
    expect(rule.operator!.enum).toEqual(canonical('RuleOperator'));
    expect(rule.expectedType!.enum).toEqual([
      'NUMBER',
      'STRING',
      'BOOLEAN',
      'NUMBER_RANGE',
      'STRING_LIST',
      'NUMBER_LIST',
      'PATTERN',
      'NONE',
    ]);
    expect(rule.severity!.enum).toEqual(canonical('RuleSeverity'));
    expect(rule.autofix!.enum).toEqual(canonical('RuleAutofixCapability'));
    expect(rule.origin!.enum).toEqual(canonical('RuleOrigin'));
    expect(rule.unit!.enum).toEqual([...canonical('RuleUnit'), NOT_APPLICABLE]);
    expect(rule.pageSelector!.enum).toEqual([...canonical('RulePageSelector'), NOT_APPLICABLE]);
    expect(rule.expectedPattern!.enum).toEqual([...canonical('RulePatternName'), NOT_APPLICABLE]);
  });

  it('is structurally far smaller than the schema that failed live', () => {
    // What 2bca723 sent: the canonical schema through the SDK transform.
    const failed = complexity(providerOutputFormat(RAW).schema);
    const now = complexity(wire);

    expect(failed.unionsOfObjects).toBe(2); // RuleScope, RuleExpectedValue
    expect(failed.unionBranches).toBe(13);
    expect(failed.optionalProperties).toBeGreaterThanOrEqual(9);

    expect(now.unionsOfObjects).toBe(0);
    expect(now.unionBranches).toBe(0);
    expect(now.optionalProperties).toBe(0);
    expect(now.nodes).toBeLessThan(failed.nodes);
  });

  it('is one constant object, so the provider compiles it once', () => {
    expect(providerOutputFormat(ANTHROPIC_PROPOSAL_SCHEMA, { transform: false })).toBe(
      providerOutputFormat(ANTHROPIC_PROPOSAL_SCHEMA, { transform: false }),
    );
    expect(JSON.stringify(ANTHROPIC_PROPOSAL_SCHEMA)).not.toMatch(/\bmaxItems\b|at most \d/i);
  });
});

describe('converting to the canonical scope', () => {
  it.each([
    [
      'DOCUMENT',
      { scopeKind: 'DOCUMENT', property: 'pageCount', pageSelector: NOT_APPLICABLE },
      { kind: 'DOCUMENT', property: 'pageCount' },
    ],
    [
      'SECTION',
      {
        scopeKind: 'SECTION',
        sectionKey: 'ABSTRACT',
        property: 'wordCount',
        pageSelector: NOT_APPLICABLE,
      },
      { kind: 'SECTION', sectionKey: 'ABSTRACT', property: 'wordCount' },
    ],
    [
      'ELEMENT at a level',
      {
        scopeKind: 'ELEMENT',
        elementType: 'HEADING',
        elementLevel: 2,
        property: 'fontSize',
        pageSelector: NOT_APPLICABLE,
      },
      { kind: 'ELEMENT', elementType: 'HEADING', level: 2, property: 'fontSize' },
    ],
    [
      'ELEMENT at any level',
      {
        scopeKind: 'ELEMENT',
        elementType: 'PARAGRAPH',
        elementLevel: 0,
        property: 'fontSize',
        pageSelector: NOT_APPLICABLE,
      },
      { kind: 'ELEMENT', elementType: 'PARAGRAPH', property: 'fontSize' },
    ],
    [
      'METADATA',
      { scopeKind: 'METADATA', property: 'title', pageSelector: NOT_APPLICABLE },
      { kind: 'METADATA', field: 'title' },
    ],
    [
      'PAGE',
      { scopeKind: 'PAGE', pageSelector: 'FIRST', property: 'marginTop' },
      { kind: 'PAGE', pages: 'FIRST', property: 'marginTop' },
    ],
  ])('%s', (_name, rule, scope) => {
    expect(firstRule(answerWithRule(rule)).scope).toEqual(scope);
  });

  it('covers every canonical scope kind', () => {
    expect(VOCABULARY.scopeKinds).toEqual(['DOCUMENT', 'SECTION', 'ELEMENT', 'METADATA', 'PAGE']);
  });
});

describe('converting to the canonical expected value', () => {
  const neutral = { expectedNumber: 0 };
  it.each([
    ['NUMBER', { expectedType: 'NUMBER', expectedNumber: 12.5 }, { type: 'NUMBER', number: 12.5 }],
    ['NUMBER zero', { expectedType: 'NUMBER', expectedNumber: 0 }, { type: 'NUMBER', number: 0 }],
    [
      'STRING',
      { ...neutral, expectedType: 'STRING', expectedText: 'Times New Roman', unit: NOT_APPLICABLE },
      { type: 'STRING', text: 'Times New Roman' },
    ],
    [
      'BOOLEAN',
      { ...neutral, expectedType: 'BOOLEAN', expectedBoolean: true, unit: NOT_APPLICABLE },
      { type: 'BOOLEAN', boolean: true },
    ],
    [
      'NUMBER_RANGE',
      { ...neutral, expectedType: 'NUMBER_RANGE', expectedMin: 25, expectedMax: 30 },
      { type: 'NUMBER_RANGE', min: 25, max: 30 },
    ],
    [
      'STRING_LIST',
      {
        ...neutral,
        expectedType: 'STRING_LIST',
        expectedStrings: ['Arial', 'Calibri'],
        unit: NOT_APPLICABLE,
      },
      { type: 'STRING_LIST', values: ['Arial', 'Calibri'] },
    ],
    [
      'NUMBER_LIST',
      { ...neutral, expectedType: 'NUMBER_LIST', expectedNumbers: [10, 12] },
      { type: 'NUMBER_LIST', values: [10, 12] },
    ],
    [
      'PATTERN with an argument',
      {
        ...neutral,
        expectedType: 'PATTERN',
        expectedPattern: 'STARTS_WITH',
        patternArgument: 'Chapter',
        unit: NOT_APPLICABLE,
      },
      { type: 'PATTERN', pattern: 'STARTS_WITH', argument: 'Chapter' },
    ],
    [
      'PATTERN without one',
      { ...neutral, expectedType: 'PATTERN', expectedPattern: 'TITLE_CASE', unit: NOT_APPLICABLE },
      { type: 'PATTERN', pattern: 'TITLE_CASE' },
    ],
    [
      'NONE',
      { ...neutral, expectedType: 'NONE', operator: 'EXISTS', unit: NOT_APPLICABLE },
      { type: 'NONE' },
    ],
  ])('%s', (_name, rule, expected) => {
    expect(firstRule(answerWithRule(rule)).expected).toEqual(expected);
  });

  it('covers every canonical value kind', () => {
    expect(VOCABULARY.expectedTypes).toHaveLength(8);
  });
});

describe('the canonical object', () => {
  it('drops every neutral and inapplicable field', () => {
    const rule = firstRule({ proposals: [wireProposal()] });
    expect(rule).toEqual({
      ruleCode: 'GUIDELINE.MARGIN.LEFT',
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
    });
  });

  it('carries guidance, ambiguity and relations only when given', () => {
    const output = convert({
      proposals: [
        wireProposal(
          { proposalKey: 'a', relatedProposalKeys: ['b'] },
          wireRule({ guidanceEn: 'Set it in Layout.', guidanceAr: 'اضبطه من التخطيط.' }),
        ),
        wireProposal(
          {
            proposalKey: 'b',
            kind: 'AMBIGUOUS_REQUIREMENT',
            ambiguityNote: 'Which spacing is not stated.',
            requiresClarification: true,
          },
          null,
        ),
      ],
    });
    const [first, second] = output.proposals;
    expect(first!.relatedProposalKeys).toEqual(['b']);
    expect((first!.suggestedRule as unknown as Record<string, unknown>).guidanceEn).toBe(
      'Set it in Layout.',
    );
    expect(second!.suggestedRule).toBeUndefined();
    expect(second!.ambiguityNote).toBe('Which spacing is not stated.');
    expect('relatedProposalKeys' in second!).toBe(false);
  });

  it('passes the ORIGINAL canonical schema, unmodified', () => {
    const output = convert({
      proposals: [
        wireProposal(),
        wireProposal({ proposalKey: 'p-2', kind: 'UNREPRESENTABLE_REQUIREMENT' }, null),
      ],
    });
    expect(validateExtractionContract(ExtractionContract.PROPOSAL_OUTPUT, output)).toEqual({
      valid: true,
      issues: [],
    });
  });

  it('an empty list is a legitimate answer', () => {
    expect(convert({ proposals: [] })).toEqual({ proposals: [] });
  });
});

describe('inconsistent answers are refused', () => {
  it.each<[string, Record<string, unknown>, ProposalRejection]>([
    ['a section key on a PAGE rule', { sectionKey: 'ABSTRACT' }, 'SCOPE_INCONSISTENT'],
    [
      'an ELEMENT rule without an element type',
      { scopeKind: 'ELEMENT', pageSelector: NOT_APPLICABLE },
      'SCOPE_INCONSISTENT',
    ],
    ['an element type on a PAGE rule', { elementType: 'HEADING' }, 'SCOPE_INCONSISTENT'],
    ['a level on a PAGE rule', { elementLevel: 2 }, 'SCOPE_INCONSISTENT'],
    ['a PAGE rule without a page selector', { pageSelector: NOT_APPLICABLE }, 'SCOPE_INCONSISTENT'],
    [
      'a page selector on a DOCUMENT rule',
      { scopeKind: 'DOCUMENT', pageSelector: 'ALL' },
      'SCOPE_INCONSISTENT',
    ],
    [
      'a SECTION rule without a section key',
      { scopeKind: 'SECTION', pageSelector: NOT_APPLICABLE },
      'SCOPE_INCONSISTENT',
    ],
    ['a rule with no property', { property: '' }, 'SCOPE_INCONSISTENT'],
    [
      'a STRING value carrying a number too',
      { expectedType: 'STRING', expectedText: 'x' },
      'EXPECTED_VALUE_INCONSISTENT',
    ],
    [
      'a NUMBER value carrying a list too',
      { expectedStrings: ['a'] },
      'EXPECTED_VALUE_INCONSISTENT',
    ],
    [
      'a NUMBER value carrying a pattern too',
      { expectedPattern: 'UPPERCASE' },
      'EXPECTED_VALUE_INCONSISTENT',
    ],
    [
      'a STRING value with no text',
      { expectedType: 'STRING', expectedNumber: 0 },
      'EXPECTED_VALUE_INCONSISTENT',
    ],
    [
      'a range whose minimum exceeds its maximum',
      { expectedType: 'NUMBER_RANGE', expectedNumber: 0, expectedMin: 30, expectedMax: 20 },
      'EXPECTED_VALUE_INCONSISTENT',
    ],
    [
      'an empty STRING_LIST',
      { expectedType: 'STRING_LIST', expectedNumber: 0 },
      'EXPECTED_VALUE_INCONSISTENT',
    ],
    [
      'an empty NUMBER_LIST',
      { expectedType: 'NUMBER_LIST', expectedNumber: 0 },
      'EXPECTED_VALUE_INCONSISTENT',
    ],
    [
      'a PATTERN without a pattern',
      { expectedType: 'PATTERN', expectedNumber: 0 },
      'EXPECTED_VALUE_INCONSISTENT',
    ],
    ['a category outside the vocabulary', { category: 'LAYOUT' }, 'VALUE_OUTSIDE_VOCABULARY'],
    ['an operator outside the vocabulary', { operator: 'APPROX' }, 'VALUE_OUTSIDE_VOCABULARY'],
    ['a level that is not an integer', { elementLevel: 1.5 }, 'FIELD_MISSING_OR_WRONG_TYPE'],
    ['a number sent as a string', { expectedNumber: '30' }, 'FIELD_MISSING_OR_WRONG_TYPE'],
  ])('%s', (_name, rule, reason) => {
    expect(rejection(answerWithRule(rule))).toBe(reason);
  });

  it.each<[string, unknown, ProposalRejection]>([
    ['not an object', 'proposals', 'NOT_AN_OBJECT'],
    ['no proposals list', {}, 'FIELD_MISSING_OR_WRONG_TYPE'],
    [
      'two rules on one proposal',
      { proposals: [{ ...wireProposal(), suggestedRule: [wireRule(), wireRule()] }] },
      'MORE_THAN_ONE_RULE',
    ],
    [
      'a repeated proposal key',
      { proposals: [wireProposal(), wireProposal()] },
      'DUPLICATE_PROPOSAL_KEY',
    ],
    ['an extra field', { proposals: [{ ...wireProposal(), confidence: 0.9 }] }, 'UNKNOWN_FIELD'],
    [
      'a missing field',
      {
        proposals: [
          Object.fromEntries(Object.entries(wireProposal()).filter(([key]) => key !== 'kind')),
        ],
      },
      'FIELD_MISSING_OR_WRONG_TYPE',
    ],
    [
      'an extra field inside the rule',
      { proposals: [wireProposal({}, { ...wireRule(), tolerance: 1 })] },
      'UNKNOWN_FIELD',
    ],
    [
      'a kind outside the vocabulary',
      { proposals: [wireProposal({ kind: 'GUESS' })] },
      'VALUE_OUTSIDE_VOCABULARY',
    ],
  ])('%s', (_name, answer, reason) => {
    expect(rejection(answer)).toBe(reason);
  });

  it('more proposals than the call allows', () => {
    const answer = {
      proposals: Array.from({ length: 4 }, (_, i) => wireProposal({ proposalKey: `p-${i}` })),
    };
    expect(() => toCanonicalProposals(answer, { maxProposals: 3 })).toThrow(
      ProposalConversionError,
    );
    expect(toCanonicalProposals(answer, { maxProposals: 4 }).proposals).toHaveLength(4);
  });
});

describe('the canonical schema still has the last word', () => {
  // Each answer is internally consistent — the converter builds it happily —
  // and violates a constraint only the canonical schema knows.
  it.each<[string, unknown]>([
    [
      'a heading level of 10 (maximum 9)',
      answerWithRule({
        scopeKind: 'ELEMENT',
        elementType: 'HEADING',
        elementLevel: 10,
        pageSelector: NOT_APPLICABLE,
      }),
    ],
    [
      'a heading level of -1 (minimum 1)',
      answerWithRule({
        scopeKind: 'ELEMENT',
        elementType: 'HEADING',
        elementLevel: -1,
        pageSelector: NOT_APPLICABLE,
      }),
    ],
    [
      'a proposal key with a space (pattern)',
      { proposals: [wireProposal({ proposalKey: 'has space' })] },
    ],
    [
      'an empty interpretation (minLength)',
      { proposals: [wireProposal({ interpretationEn: '' })] },
    ],
    [
      'a 2001-character interpretation (maxLength)',
      { proposals: [wireProposal({ interpretationAr: 'x'.repeat(2001) })] },
    ],
    ['a 301-character title (maxLength)', answerWithRule({ titleAr: 'x'.repeat(301) })],
    [
      'a lower-case section key (pattern)',
      answerWithRule({
        scopeKind: 'SECTION',
        sectionKey: 'abstract',
        pageSelector: NOT_APPLICABLE,
      }),
    ],
    [
      'a property that is not a property key (pattern)',
      answerWithRule({ property: 'Margin Left' }),
    ],
    ['an empty title (minLength)', answerWithRule({ titleEn: '' })],
    [
      '21 evidence ids (maxItems)',
      {
        proposals: [wireProposal({ evidenceIds: Array.from({ length: 21 }, (_, i) => `ev-${i}`) })],
      },
    ],
    ['an empty evidence id (minLength)', { proposals: [wireProposal({ evidenceIds: [''] })] }],
    [
      'a 501-character STRING value (maxLength)',
      answerWithRule({
        expectedType: 'STRING',
        expectedNumber: 0,
        expectedText: 'x'.repeat(501),
        unit: NOT_APPLICABLE,
      }),
    ],
  ])('%s', (_name, answer) => {
    expect(rejection(answer)).toBe('CANONICAL_SCHEMA_FAILED');
  });

  it('201 proposals fail the canonical maxItems even when a call allowed them', () => {
    const answer = {
      proposals: Array.from({ length: 201 }, (_, i) => wireProposal({ proposalKey: `p-${i}` })),
    };
    expect(() => toCanonicalProposals(answer, { maxProposals: 500 })).toThrow(
      'CANONICAL_SCHEMA_FAILED',
    );
  });
});

describe('diagnosing a canonical failure', () => {
  function failure(answer: unknown): ProposalConversionError {
    try {
      convert(answer);
    } catch (error) {
      if (error instanceof ProposalConversionError) return error;
      throw error;
    }
    throw new Error('expected the answer to be refused');
  }

  it.each<[string, unknown, string, string]>([
    [
      'an empty evidence id',
      { proposals: [wireProposal({ evidenceIds: [''] })] },
      '/proposals/0/evidenceIds/0',
      'must NOT have fewer than 1 characters',
    ],
    [
      'a heading level of 10',
      answerWithRule({
        scopeKind: 'ELEMENT',
        elementType: 'HEADING',
        elementLevel: 10,
        pageSelector: NOT_APPLICABLE,
      }),
      '/proposals/0/suggestedRule/scope/level',
      'must be <= 9',
    ],
    [
      'a section key in mixed case',
      answerWithRule({
        scopeKind: 'SECTION',
        sectionKey: 'Abstract',
        pageSelector: NOT_APPLICABLE,
      }),
      '/proposals/0/suggestedRule/scope/sectionKey',
      'must match pattern',
    ],
    [
      'a property in snake case',
      answerWithRule({ property: 'margin_left' }),
      '/proposals/0/suggestedRule/scope/property',
      'must match pattern',
    ],
    [
      'a proposal key with a space',
      { proposals: [wireProposal({ proposalKey: 'p 1' })] },
      '/proposals/0/proposalKey',
      'must match pattern',
    ],
    [
      'an over-long title, in the second proposal',
      {
        proposals: [
          wireProposal(),
          wireProposal({ proposalKey: 'p-2' }, wireRule({ titleEn: 'x'.repeat(301) })),
        ],
      },
      '/proposals/1/suggestedRule/titleEn',
      'must NOT have more than 300 characters',
    ],
  ])('names the canonical path and rule for %s', (_name, answer, path, issue) => {
    const error = failure(answer);
    expect(error.reason).toBe('CANONICAL_SCHEMA_FAILED');
    expect(error.at).toBe(path);
    expect(error.issues[0]).toEqual({ path, issue });
  });

  it('keeps at most three issues, the real cause first', () => {
    const error = failure(
      answerWithRule({
        scopeKind: 'ELEMENT',
        elementType: 'HEADING',
        elementLevel: 10,
        pageSelector: NOT_APPLICABLE,
      }),
    );
    expect(error.issues.length).toBeLessThanOrEqual(MAX_REPORTED_ISSUES);
    expect(error.issues[0]!.issue).toBe('must be <= 9');
  });

  it('never carries the value that failed, or any quoted text', () => {
    const secret = 'CONFIDENTIAL_THESIS_TEXT';
    const error = failure(
      answerWithRule({ ruleCode: `${secret}.lower_case`, titleEn: `${secret} ${'x'.repeat(400)}` }),
    );
    const everything = JSON.stringify({
      at: error.at,
      issues: error.issues,
      message: error.message,
    });
    expect(everything).not.toContain(secret);
    expect(everything).not.toContain('lower_case');
    for (const text of [
      error.at,
      error.message,
      ...error.issues.flatMap((i) => [i.path, i.issue]),
    ]) {
      expect(text).not.toMatch(/["'`^$]/);
    }
  });

  it('sanitizes a path segment that is not a plain identifier, and a quoted message', () => {
    expect(
      sanitizedIssue({
        path: '/proposals/0/some key with spaces',
        message: 'must match pattern "^[A-Z]+$"',
      }),
    ).toEqual({ path: '/proposals/0/?', issue: 'must match pattern' });
  });

  it('leaves the canonical schema exactly as it was', () => {
    const before = JSON.stringify(RULE_PROPOSAL_JSON_SCHEMA);
    failure(answerWithRule({ titleEn: '' }));
    expect(JSON.stringify(RULE_PROPOSAL_JSON_SCHEMA)).toBe(before);
    const defs = (RULE_PROPOSAL_JSON_SCHEMA as unknown as { $defs: Record<string, JsonSchema> })
      .$defs;
    expect(defs.RuleCode!.pattern).toBe('^[A-Z][A-Z0-9]*(\\.[A-Z0-9]+)*$');
    expect(defs.ScopeKey!.pattern).toBe('^[A-Z][A-Z0-9_]{0,63}$');
    expect(defs.PropertyKey!.pattern).toBe('^[a-z][a-zA-Z0-9]{0,63}$');
    expect(defs.ProposalKey!.pattern).toBe('^[A-Za-z0-9._:-]{1,64}$');
  });
});

describe('rule codes are put into canonical form', () => {
  const CANONICAL = /^[A-Z][A-Z0-9]*(\.[A-Z0-9]+)*$/;

  it.each<[string, string, string]>([
    ['underscores', 'margin_left', 'MARGIN.LEFT'],
    ['lower case', 'margins.left', 'MARGINS.LEFT'],
    ['spaces', 'Title Page Font', 'TITLE.PAGE.FONT'],
    ['hyphens and dots', 'title-page.font', 'TITLE.PAGE.FONT'],
    [
      'slashes and repeated punctuation',
      '..TABLES//caption--font__size..',
      'TABLES.CAPTION.FONT.SIZE',
    ],
    ['a digit inside a segment', 'heading1_size', 'HEADING1.SIZE'],
    ['a letter after a digit segment', 'HEADING.1', 'HEADING.1'],
    ['Latin mixed with Arabic', 'هامش margin_top', 'MARGIN.TOP'],
  ])('%s', (_name, raw, expected) => {
    expect(normalizeRuleCode(raw)).toBe(expected);
    expect(expected).toMatch(CANONICAL);
  });

  it.each<[string, string]>([
    ['a leading digit', '3.table'],
    ['only Arabic', 'قاعدة الهامش'],
    ['only punctuation', '__--..//'],
    ['empty', ''],
    ['longer than 100 characters', `A${'B'.repeat(120)}`],
  ])('gives up on %s rather than guessing', (_name, raw) => {
    expect(normalizeRuleCode(raw)).toBeNull();
  });

  function codes(answer: unknown): string[] {
    return convert(answer).proposals.map(
      (proposal) => (proposal.suggestedRule as unknown as { ruleCode: string }).ruleCode,
    );
  }

  it('leaves an already-canonical, unique code exactly as it was', () => {
    expect(codes({ proposals: [wireProposal()] })).toEqual(['GUIDELINE.MARGIN.LEFT']);
  });

  it('reproduces the 8443 failure: proposal 4 with a non-canonical code now converts', () => {
    // The live diagnostic: at=/proposals/4/suggestedRule/ruleCode issue=must match pattern.
    const answer = {
      proposals: Array.from({ length: 5 }, (_, index) =>
        wireProposal(
          { proposalKey: `p-${index}` },
          wireRule({ ruleCode: index === 4 ? 'template.line_spacing' : `TEMPLATE.RULE${index}` }),
        ),
      ),
    };
    const output = convert(answer);
    expect(codes(answer)[4]).toBe('TEMPLATE.LINE.SPACING');
    expect(validateExtractionContract(ExtractionContract.PROPOSAL_OUTPUT, output).valid).toBe(true);
  });

  it('falls back to <category>.RULE<n> for a code with nothing safe in it', () => {
    const answer = {
      proposals: [
        wireProposal({ proposalKey: 'a' }),
        wireProposal({ proposalKey: 'b' }),
        wireProposal({ proposalKey: 'c' }, wireRule({ category: 'TABLES', ruleCode: '3.table' })),
        wireProposal({ proposalKey: 'd' }, wireRule({ category: 'TITLE_PAGE', ruleCode: 'قاعدة' })),
      ],
    };
    const result = codes(answer);
    expect(result[2]).toBe('TABLES.RULE3');
    expect(result[3]).toBe('TITLE.PAGE.RULE4');
  });

  it('makes codes unique within one answer, deterministically and in order', () => {
    const answer = {
      proposals: [
        wireProposal({ proposalKey: 'a' }, wireRule({ ruleCode: 'MARGIN.LEFT' })),
        wireProposal({ proposalKey: 'b' }, wireRule({ ruleCode: 'margin_left' })),
        wireProposal({ proposalKey: 'c' }, wireRule({ ruleCode: 'Margin-Left' })),
        wireProposal({ proposalKey: 'd' }, wireRule({ ruleCode: 'MARGIN.LEFT.2' })),
      ],
    };
    expect(codes(answer)).toEqual([
      'MARGIN.LEFT',
      'MARGIN.LEFT.2',
      'MARGIN.LEFT.3',
      'MARGIN.LEFT.2.2',
    ]);
    expect(codes(answer)).toEqual(codes(answer));
  });

  it('reports counts of what it rewrote, never a value', () => {
    const seen: unknown[] = [];
    toCanonicalProposals(
      {
        proposals: [
          wireProposal({ proposalKey: 'a' }, wireRule({ ruleCode: 'SECRET_TEXT.one' })),
          wireProposal({ proposalKey: 'b' }, wireRule({ ruleCode: '9.bad' })),
          wireProposal({ proposalKey: 'c' }, wireRule({ ruleCode: 'secret-text.one' })),
          wireProposal({ proposalKey: 'd' }),
        ],
      },
      LIMITS,
      (summary) => seen.push(summary),
    );
    expect(seen).toEqual([{ normalized: 2, fallback: 1, deduplicated: 1 }]);
    expect(JSON.stringify(seen)).not.toMatch(/SECRET|secret|bad/);
  });

  it('says nothing when there was nothing to rewrite', () => {
    const seen: unknown[] = [];
    toCanonicalProposals({ proposals: [wireProposal()] }, LIMITS, (summary) => seen.push(summary));
    expect(seen).toEqual([]);
  });

  it('every code that leaves the converter matches the canonical pattern', () => {
    const inputs = ['a', 'Ä_b', '__x__', '1', 'x'.repeat(150), 'ok.CODE', 'ß-ç', 'A..B', ' '];
    const answer = {
      proposals: inputs.map((ruleCode, index) =>
        wireProposal({ proposalKey: `p${index}` }, wireRule({ ruleCode })),
      ),
    };
    for (const code of codes(answer)) {
      expect(code).toMatch(CANONICAL);
      expect(code.length).toBeLessThanOrEqual(100);
    }
  });

  it('still refuses what normalization does not touch', () => {
    expect(rejection(answerWithRule({ ruleCode: 'margin_left', titleEn: '' }))).toBe(
      'CANONICAL_SCHEMA_FAILED',
    );
  });

  it('tells the model the exact format, but sends no pattern keyword', () => {
    const text = JSON.stringify(ANTHROPIC_PROPOSAL_SCHEMA);
    expect(text).toContain('^[A-Z][A-Z0-9]*(\\\\.[A-Z0-9]+)*$');
    expect(unsupportedKeywords(ANTHROPIC_PROPOSAL_SCHEMA)).toEqual([]);
  });
});
