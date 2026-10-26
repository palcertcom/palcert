/**
 * Well-formed Pass B answers in the provider wire shape, for tests.
 *
 * Every field that does not apply carries its neutral value, exactly as the
 * schema descriptions tell the model to.
 */

export function wireRule(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    ruleCode: 'GUIDELINE.MARGIN.LEFT',
    category: 'MARGINS',
    evaluationMode: 'DETERMINISTIC',
    scopeKind: 'PAGE',
    property: 'marginLeft',
    sectionKey: '',
    elementType: 'NOT_APPLICABLE',
    elementLevel: 0,
    pageSelector: 'ALL',
    operator: 'EQUALS',
    expectedType: 'NUMBER',
    expectedNumber: 30,
    expectedText: '',
    expectedBoolean: false,
    expectedMin: 0,
    expectedMax: 0,
    expectedStrings: [],
    expectedNumbers: [],
    expectedPattern: 'NOT_APPLICABLE',
    patternArgument: '',
    unit: 'MILLIMETRE',
    severity: 'MAJOR',
    blocking: false,
    autofix: 'NONE',
    origin: 'ORGANIZATION_POLICY',
    titleEn: 'Left margin 30 mm',
    titleAr: 'الهامش الأيسر 30 مم',
    guidanceEn: '',
    guidanceAr: '',
    ...overrides,
  };
}

export function wireProposal(
  overrides: Record<string, unknown> = {},
  rule: Record<string, unknown> | null = wireRule(),
): Record<string, unknown> {
  return {
    proposalKey: 'p-1',
    kind: 'EXPLICIT_REQUIREMENT',
    evidenceIds: ['ev-1'],
    interpretationEn: 'The left margin is 30 mm on every page.',
    interpretationAr: 'الهامش الأيسر 30 مم في كل صفحة.',
    ambiguityNote: '',
    requiresClarification: false,
    relatedProposalKeys: [],
    suggestedRule: rule === null ? [] : [rule],
    ...overrides,
  };
}

/** An answer with one rule changed. */
export function answerWithRule(overrides: Record<string, unknown>): Record<string, unknown> {
  return { proposals: [wireProposal({}, wireRule(overrides))] };
}
