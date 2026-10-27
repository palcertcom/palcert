import { describe, expect, it } from 'vitest';
import { parseAIFormattingProposal } from './ai-formatting.js';
import { canCompleteSmartFixPlan } from './completion.js';
import { SMARTFIX_ENGINE_VERSION } from './constants.js';

const target = { ruleCode: 'أي.معيار.FONT', kind: 'STRING', value: 'Times New Roman' };
describe('AI formatting boundary', () => {
  it('accepts formatting values with arbitrary rule codes', () => {
    expect(parseAIFormattingProposal({ targets: [target] })).toEqual({ targets: [target] });
  });
  it.each([
    null,
    { targets: [], verdict: 'PASS' },
    { targets: [target, target] },
    { targets: [{ ...target, nodeId: 'main/body/p:1' }] },
    { targets: [{ ...target, value: 'x'.repeat(257) }] },
    ...['NaN', 'Infinity', '1e6', ''].map((value) => ({
      targets: [{ ...target, kind: 'NUMBER', value }],
    })),
    { targets: [{ ...target, kind: 'BOOLEAN', value: 'yes' }] },
    { targets: [{ ...target, kind: 'XML', value: '<w:t/>' }] },
  ])('rejects malformed, executable or verdict-bearing payloads', (value) => {
    expect(() => parseAIFormattingProposal(value)).toThrow();
  });
  it('does not offer a plan whose AI preview stopped unresolved', () => {
    const plan = {
      fixEngineVersion: SMARTFIX_ENGINE_VERSION,
      refusalCode: null,
      actionCount: 1,
      rules: [{ ruleCode: 'FONT', fixability: 'FIXABLE' }],
    };
    expect(canCompleteSmartFixPlan({ ...plan, aiPlanning: { stopReason: 'NO_PROGRESS' } })).toBe(
      false,
    );
    expect(canCompleteSmartFixPlan({ ...plan, aiPlanning: { stopReason: 'VERIFIED' } })).toBe(true);
  });
});
