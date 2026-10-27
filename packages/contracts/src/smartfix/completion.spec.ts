import { describe, expect, it } from 'vitest';
import { canCompleteSmartFixPlan, evaluateSmartFixCompletion } from './completion.js';
import { SMARTFIX_ENGINE_VERSION } from './constants.js';

const plan = {
  fixEngineVersion: SMARTFIX_ENGINE_VERSION,
  refusalCode: null,
  actionCount: 2,
  rules: [{ ruleCode: 'FONT', fixability: 'FIXABLE' }],
};
const row = (outcome: string) => ({ outcome, evaluationMode: 'DETERMINISTIC' });

describe('full SmartFix completion', () => {
  it('offers only a current, complete preview', () => {
    expect(canCompleteSmartFixPlan(plan)).toBe(true);
    for (const overrides of [
      { fixEngineVersion: '1.0.0' },
      { refusalCode: 'REFUSED' },
      { actionCount: 0 },
      { rules: [] },
      { rules: null },
      { rules: [null] },
      { rules: [{}] },
      { rules: [{ ruleCode: 'FONT', fixability: 'PARTIALLY_FIXABLE' }] },
      { rules: [...plan.rules, { ruleCode: 'UNKNOWN', fixability: 'NOT_SUPPORTED' }] },
    ])
      expect(canCompleteSmartFixPlan({ ...plan, ...overrides })).toBe(false);
  });
  it.each(['FAIL', 'INDETERMINATE', 'ERROR'])('blocks an untargeted %s rule', (outcome) => {
    const before = new Map([
      ['FONT', row('FAIL')],
      ['OTHER', row(outcome)],
    ]);
    const after = new Map([
      ['FONT', row('PASS')],
      ['OTHER', row(outcome)],
    ]);
    expect(evaluateSmartFixCompletion(['FONT', 'OTHER'], new Set(['FONT']), before, after)).toEqual(
      { resolved: ['FONT'], unresolved: ['OTHER'], regressed: [] },
    );
  });
  it('requires every rule in the published standard, including missing results', () => {
    const result = evaluateSmartFixCompletion(
      ['FONT', 'MISSING'],
      new Set(['FONT']),
      new Map(),
      new Map([['FONT', row('PASS')]]),
    );
    expect(result.unresolved).toEqual(['MISSING']);
  });
  it('accepts a complete recheck and explicitly inapplicable rules', () => {
    const after = new Map([
      ['FONT', row('PASS')],
      ['ABSENT', row('NOT_APPLICABLE')],
    ]);
    expect(
      evaluateSmartFixCompletion(['FONT', 'ABSENT'], new Set(['FONT']), new Map(), after)
        .unresolved,
    ).toEqual([]);
  });
  it('treats lost evidence of a previously passing rule as a regression', () => {
    const before = new Map([['FONT', row('PASS')]]);
    expect(evaluateSmartFixCompletion(['FONT'], new Set(), before, new Map()).regressed).toEqual([
      'FONT',
    ]);
  });
  it('rejects the original 8 failed and 13 indeterminate residuals even after all targets pass', () => {
    const after = new Map([
      ['FONT', row('PASS')],
      ...Array.from({ length: 21 }, (_, i): [string, ReturnType<typeof row>] => [
        'RESIDUAL.' + i,
        row(i < 8 ? 'FAIL' : 'INDETERMINATE'),
      ]),
    ]);
    expect(
      evaluateSmartFixCompletion([...after.keys()], new Set(['FONT']), new Map(), after).unresolved,
    ).toHaveLength(21);
  });
});
