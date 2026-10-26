import { describe, expect, it } from 'vitest';
import {
  CHECK_ORCHESTRATOR_VERSION,
  CHECK_STATUS_TRANSITIONS,
  CheckFailureCode,
  CheckStatus,
  canTransitionCheck,
  canTransitionCheckRun,
  checkRunJobKey,
  isCheckSettled,
  isCheckTerminal,
  isPermanentCheckFailure,
} from './check.js';

describe('the check lifecycle', () => {
  it('never leaves a terminal status', () => {
    for (const status of Object.values(CheckStatus)) {
      if (!isCheckTerminal(status)) continue;
      expect(CHECK_STATUS_TRANSITIONS[status]).toEqual([]);
    }
  });

  it('can reach a report only through evaluation', () => {
    expect(canTransitionCheck(CheckStatus.CREATED, CheckStatus.COMPLETED)).toBe(false);
    expect(canTransitionCheck(CheckStatus.EVALUATING, CheckStatus.GENERATING_REPORT)).toBe(true);
  });

  it('allows a failed check to be retried but not a completed one', () => {
    // A completed check's report is immutable; a second opinion is a new
    // check, not a rewrite of this one (§62). A failed one may start a new
    // run, so it is settled but not terminal.
    expect(canTransitionCheck(CheckStatus.FAILED, CheckStatus.EVALUATING)).toBe(true);
    expect(isCheckTerminal(CheckStatus.FAILED)).toBe(false);
    expect(isCheckSettled(CheckStatus.FAILED)).toBe(true);
    expect(canTransitionCheck(CheckStatus.COMPLETED, CheckStatus.EVALUATING)).toBe(false);
    expect(isCheckTerminal(CheckStatus.COMPLETED)).toBe(true);
  });

  it('can park on an analysis and resume', () => {
    expect(canTransitionCheck(CheckStatus.CREATED, CheckStatus.WAITING_ANALYSIS)).toBe(true);
    expect(canTransitionCheck(CheckStatus.WAITING_ANALYSIS, CheckStatus.EVALUATING)).toBe(true);
  });

  it('lets a run finish exactly once', () => {
    expect(canTransitionCheckRun('SUCCEEDED', 'FAILED')).toBe(false);
    expect(canTransitionCheckRun('RUNNING', 'SUCCEEDED')).toBe(true);
  });
});

describe('check failure classification', () => {
  it('treats integrity and document failures as permanent', () => {
    expect(isPermanentCheckFailure(CheckFailureCode.STANDARD_SNAPSHOT_INTEGRITY_FAILED)).toBe(true);
    expect(isPermanentCheckFailure(CheckFailureCode.ANALYSIS_ARTIFACT_INVALID)).toBe(true);
    expect(isPermanentCheckFailure(CheckFailureCode.DOCUMENT_ANALYSIS_FAILED)).toBe(true);
  });

  it('treats engine and storage failures as retryable', () => {
    // Infrastructure trouble must never become a compliance verdict (§108).
    expect(isPermanentCheckFailure(CheckFailureCode.RULE_ENGINE_FAILED)).toBe(false);
    expect(isPermanentCheckFailure(CheckFailureCode.CHECK_ENGINE_ERROR)).toBe(false);
    expect(isPermanentCheckFailure(CheckFailureCode.REPORT_STORAGE_FAILED)).toBe(false);
  });
});

describe('checkRunJobKey', () => {
  it('is derived from the run, so a retry is a different job', () => {
    expect(checkRunJobKey('a')).not.toBe(checkRunJobKey('b'));
    expect(checkRunJobKey('a')).toBe(checkRunJobKey('a'));
  });
});

describe('the orchestrator version', () => {
  it('is a semantic version rather than a build identifier', () => {
    // Deliberately not a Git SHA: how a determination is computed must be
    // identifiable independently of unrelated deployments (§79).
    expect(CHECK_ORCHESTRATOR_VERSION).toMatch(/^\d+$/);
  });
});
