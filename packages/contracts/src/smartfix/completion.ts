/** The paid workflow only offers plans previewed to resolve the whole standard. */
import { SMARTFIX_ENGINE_VERSION } from './constants.js';

export function canCompleteSmartFixPlan(plan: {
  readonly fixEngineVersion: unknown;
  readonly refusalCode: unknown;
  readonly actionCount: number;
  readonly rules: unknown;
  readonly aiPlanning?: unknown;
}): boolean {
  return (
    plan.fixEngineVersion === SMARTFIX_ENGINE_VERSION &&
    (plan.aiPlanning === undefined ||
      plan.aiPlanning === null ||
      (typeof plan.aiPlanning === 'object' &&
        'stopReason' in plan.aiPlanning &&
        plan.aiPlanning.stopReason === 'VERIFIED')) &&
    plan.refusalCode === null &&
    plan.actionCount > 0 &&
    Array.isArray(plan.rules) &&
    plan.rules.length > 0 &&
    plan.rules.every(
      (rule: unknown) =>
        typeof rule === 'object' &&
        rule !== null &&
        'fixability' in rule &&
        rule.fixability === 'FIXABLE' &&
        'ruleCode' in rule &&
        typeof rule.ruleCode === 'string' &&
        rule.ruleCode.length > 0,
    )
  );
}

export interface SmartFixRuleVerdict {
  readonly outcome: string;
  readonly evaluationMode: string;
}

/** Missing, failed, errored and unknown verdicts all prevent delivery. */
export function evaluateSmartFixCompletion(
  expected: readonly string[],
  targeted: ReadonlySet<string>,
  before: ReadonlyMap<string, SmartFixRuleVerdict>,
  after: ReadonlyMap<string, SmartFixRuleVerdict>,
): { resolved: string[]; unresolved: string[]; regressed: string[] } {
  const accepted = (code: string): boolean => {
    const outcome = after.get(code)?.outcome;
    return outcome === 'PASS' || outcome === 'NOT_APPLICABLE';
  };
  // Include unexpected results too: a failure cannot disappear by being absent
  // from the plan, or from an incomplete original run.
  const all = new Set([...expected, ...targeted, ...before.keys(), ...after.keys()]);
  return {
    resolved: [...targeted].filter(accepted).sort(),
    unresolved: [...all].filter((code) => !accepted(code)).sort(),
    regressed: [...before]
      .filter(
        ([code, previous]) =>
          previous.outcome === 'PASS' &&
          previous.evaluationMode === 'DETERMINISTIC' &&
          !accepted(code),
      )
      .map(([code]) => code)
      .sort(),
  };
}
