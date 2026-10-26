import { describe, expect, it } from 'vitest';
import {
  INSTITUTION_DECISION_STATUSES,
  InstitutionDecisionStatus,
  SUBMISSION_DECISION_REASONS,
  SUBMISSION_PROCESSING_STATUSES,
  SubmissionFailureCode,
  SubmissionProcessingStatus,
  allowedDecisionTransitions,
  decisionRequiresComment,
  isPermanentSubmissionFailure,
  isTerminalDecision,
  isValidDecisionTransition,
} from './submission.js';
import {
  SUBMISSION_EVIDENCE_CANONICALIZATION_VERSION,
  SUBMISSION_EVIDENCE_SCHEMA_VERSION,
  canonicalSubmissionEvidence,
  computeSubmissionEvidenceHash,
  type SubmissionEvidence,
} from './evidence.js';
import { SUBMISSION_NOT_SHARED_ITEMS, SUBMISSION_SHARED_ITEMS } from './views.js';

describe('institution decision vocabulary', () => {
  it('is exactly the five statuses, and nothing that smuggles in a verdict', () => {
    // §4: no PASSED, no FAILED, no TECHNICALLY_APPROVED. PalCert's measurement
    // lives in ComplianceDetermination; this is the human's answer.
    expect([...INSTITUTION_DECISION_STATUSES].sort()).toEqual([
      'APPROVED',
      'REJECTED',
      'REVISION_REQUESTED',
      'SUBMITTED',
      'UNDER_REVIEW',
    ]);
  });

  it('does not store NOT_SUBMITTED as a decision', () => {
    expect(INSTITUTION_DECISION_STATUSES).not.toContain('NOT_SUBMITTED');
  });

  it('keeps processing status out of the decision vocabulary', () => {
    // §5: a storage-copy failure is not an institution rejection, and the two
    // sets of words must not overlap at all.
    for (const processing of SUBMISSION_PROCESSING_STATUSES) {
      expect(INSTITUTION_DECISION_STATUSES).not.toContain(processing as never);
    }
    expect([...SUBMISSION_PROCESSING_STATUSES].sort()).toEqual(['FAILED', 'PREPARING', 'READY']);
  });
});

describe('decision state machine', () => {
  it('allows review to start from SUBMITTED only', () => {
    expect(allowedDecisionTransitions(InstitutionDecisionStatus.SUBMITTED)).toContain(
      InstitutionDecisionStatus.UNDER_REVIEW,
    );
    expect(allowedDecisionTransitions(InstitutionDecisionStatus.UNDER_REVIEW)).not.toContain(
      InstitutionDecisionStatus.UNDER_REVIEW,
    );
  });

  it('allows a decision directly from SUBMITTED or from UNDER_REVIEW (§46)', () => {
    for (const from of [
      InstitutionDecisionStatus.SUBMITTED,
      InstitutionDecisionStatus.UNDER_REVIEW,
    ]) {
      for (const to of [
        InstitutionDecisionStatus.APPROVED,
        InstitutionDecisionStatus.REJECTED,
        InstitutionDecisionStatus.REVISION_REQUESTED,
      ]) {
        expect([from, to, isValidDecisionTransition(from, to)]).toEqual([from, to, true]);
      }
    }
  });

  it('makes approval and rejection terminal (§47)', () => {
    for (const terminal of [
      InstitutionDecisionStatus.APPROVED,
      InstitutionDecisionStatus.REJECTED,
    ]) {
      expect(isTerminalDecision(terminal)).toBe(true);
      expect(allowedDecisionTransitions(terminal)).toEqual([]);
    }
  });

  it('makes REVISION_REQUESTED terminal for the revision, not for the case (§48)', () => {
    // The old revision keeps that status for ever. The author's answer is a
    // new revision, which is why nothing leads out of this state here.
    expect(allowedDecisionTransitions(InstitutionDecisionStatus.REVISION_REQUESTED)).toEqual([]);
    // But it is not a *terminal decision*: the case continues.
    expect(isTerminalDecision(InstitutionDecisionStatus.REVISION_REQUESTED)).toBe(false);
  });

  it('refuses to reopen a decided revision', () => {
    for (const to of INSTITUTION_DECISION_STATUSES) {
      expect(isValidDecisionTransition(InstitutionDecisionStatus.APPROVED, to)).toBe(false);
      expect(isValidDecisionTransition(InstitutionDecisionStatus.REJECTED, to)).toBe(false);
    }
  });

  it('never allows a revision to go back to SUBMITTED', () => {
    for (const from of INSTITUTION_DECISION_STATUSES) {
      expect(isValidDecisionTransition(from, InstitutionDecisionStatus.SUBMITTED)).toBe(false);
    }
  });
});

describe('decision policy', () => {
  it('requires a reason for a rejection and a revision request (§70)', () => {
    expect(decisionRequiresComment(InstitutionDecisionStatus.REJECTED)).toBe(true);
    expect(decisionRequiresComment(InstitutionDecisionStatus.REVISION_REQUESTED)).toBe(true);
    expect(decisionRequiresComment(InstitutionDecisionStatus.APPROVED)).toBe(false);
  });

  it('keeps reason codes administrative, never academic (§111, §112)', () => {
    // PalCert cannot define scientific merit across every institution, and a
    // code that implied it would put PalCert's name on a human judgement.
    const codes = SUBMISSION_DECISION_REASONS.join(' ').toLowerCase();
    for (const forbidden of ['novelty', 'quality', 'merit', 'significance', 'originality']) {
      expect([forbidden, codes.includes(forbidden)]).toEqual([forbidden, false]);
    }
  });
});

describe('preparation failures', () => {
  it('treats an integrity mismatch as permanent and storage as transient', () => {
    // The same bytes will not start matching on the third attempt; a storage
    // outage might.
    expect(
      isPermanentSubmissionFailure(SubmissionFailureCode.SUBMISSION_SOURCE_INTEGRITY_FAILED),
    ).toBe(true);
    expect(
      isPermanentSubmissionFailure(SubmissionFailureCode.SUBMISSION_REPORT_INTEGRITY_FAILED),
    ).toBe(true);
    expect(
      isPermanentSubmissionFailure(SubmissionFailureCode.SUBMISSION_SNAPSHOT_STORAGE_FAILED),
    ).toBe(false);
  });

  it('never expresses a failure as an institution decision (§35)', () => {
    const failures = Object.values(SubmissionFailureCode).join(' ');
    for (const decision of INSTITUTION_DECISION_STATUSES) {
      expect([decision, failures.includes(decision)]).toEqual([decision, false]);
    }
    expect(SubmissionProcessingStatus.FAILED).not.toBe(InstitutionDecisionStatus.REJECTED);
  });
});

describe('pre-submission disclosure', () => {
  it('names what is shared and what is not, with no overlap (§21)', () => {
    expect(SUBMISSION_SHARED_ITEMS.length).toBeGreaterThan(0);
    expect(SUBMISSION_NOT_SHARED_ITEMS.length).toBeGreaterThan(0);
    const shared = new Set(SUBMISSION_SHARED_ITEMS);
    for (const item of SUBMISSION_NOT_SHARED_ITEMS) {
      expect([item, shared.has(item)]).toEqual([item, false]);
    }
  });

  it('promises AI review, SmartFix internals and finance are withheld', () => {
    // §22, §23, §24: each is named explicitly, because "we only share what you
    // submit" is a promise a person cannot verify and a list is one they can.
    expect(SUBMISSION_NOT_SHARED_ITEMS).toContain('AI_REVIEW');
    expect(SUBMISSION_NOT_SHARED_ITEMS).toContain('SMARTFIX_PLAN_AND_MANIFEST');
    expect(SUBMISSION_NOT_SHARED_ITEMS).toContain('BALANCE_AND_PAYMENTS');
    expect(SUBMISSION_NOT_SHARED_ITEMS).toContain('OTHER_DOCUMENT_VERSIONS');
    expect(SUBMISSION_NOT_SHARED_ITEMS).toContain('OTHER_CHECKS');
  });
});

// ---------------------------------------------------------------------------
// Evidence hash (§137, §187, §188)
// ---------------------------------------------------------------------------

function evidence(overrides: Partial<SubmissionEvidence> = {}): SubmissionEvidence {
  return {
    evidenceSchemaVersion: SUBMISSION_EVIDENCE_SCHEMA_VERSION,
    evidenceCanonicalizationVersion: SUBMISSION_EVIDENCE_CANONICALIZATION_VERSION,
    organizationId: '11111111-1111-4111-8111-111111111111',
    documentTypeId: '22222222-2222-4222-8222-222222222222',
    documentId: '33333333-3333-4333-8333-333333333333',
    revisionNumber: 1,
    documentVersionId: '44444444-4444-4444-8444-444444444444',
    documentSha256: 'a'.repeat(64),
    documentFormat: 'DOCX',
    checkId: '55555555-5555-4555-8555-555555555555',
    checkRunId: '66666666-6666-4666-8666-666666666666',
    reportId: '77777777-7777-4777-8777-777777777777',
    reportHash: 'b'.repeat(64),
    evaluationHash: 'c'.repeat(64),
    determination: 'COMPLIANT',
    standardId: '88888888-8888-4888-8888-888888888888',
    standardVersionId: '99999999-9999-4999-8999-999999999999',
    standardContentHash: 'd'.repeat(64),
    ...overrides,
  };
}

describe('submission evidence hash', () => {
  /**
   * The golden (§188).
   *
   * If a serialization refactor changes this value, official submissions
   * already handed to institutions would stop verifying — so the constant is
   * written out rather than computed, and moving it deliberately means bumping
   * SUBMISSION_EVIDENCE_CANONICALIZATION_VERSION.
   */
  const GOLDEN_CANONICAL =
    '{"checkId":"55555555-5555-4555-8555-555555555555",' +
    '"checkRunId":"66666666-6666-4666-8666-666666666666",' +
    '"determination":"COMPLIANT",' +
    `"documentFormat":"DOCX","documentId":"33333333-3333-4333-8333-333333333333",` +
    `"documentSha256":"${'a'.repeat(64)}",` +
    '"documentTypeId":"22222222-2222-4222-8222-222222222222",' +
    '"documentVersionId":"44444444-4444-4444-8444-444444444444",' +
    '"evaluationHash":"' +
    'c'.repeat(64) +
    '","evidenceCanonicalizationVersion":1,"evidenceSchemaVersion":1,' +
    '"organizationId":"11111111-1111-4111-8111-111111111111",' +
    `"reportHash":"${'b'.repeat(64)}",` +
    '"reportId":"77777777-7777-4777-8777-777777777777","revisionNumber":1,' +
    `"standardContentHash":"${'d'.repeat(64)}",` +
    '"standardId":"88888888-8888-4888-8888-888888888888",' +
    '"standardVersionId":"99999999-9999-4999-8999-999999999999"}';

  it('canonicalizes to the golden bytes', () => {
    expect(canonicalSubmissionEvidence(evidence())).toBe(GOLDEN_CANONICAL);
  });

  it('hashes to the golden digest', () => {
    expect(computeSubmissionEvidenceHash(evidence())).toBe(
      'd3776a691b6f1e61c5fee443fca38c63faa0accf441c836b9f6b974386651343',
    );
  });

  it('is stable regardless of the order fields were built in', () => {
    const forward = evidence();
    const reordered: SubmissionEvidence = {
      standardVersionId: forward.standardVersionId,
      standardContentHash: forward.standardContentHash,
      standardId: forward.standardId,
      determination: forward.determination,
      evaluationHash: forward.evaluationHash,
      reportHash: forward.reportHash,
      reportId: forward.reportId,
      checkRunId: forward.checkRunId,
      checkId: forward.checkId,
      documentFormat: forward.documentFormat,
      documentSha256: forward.documentSha256,
      documentVersionId: forward.documentVersionId,
      revisionNumber: forward.revisionNumber,
      documentId: forward.documentId,
      documentTypeId: forward.documentTypeId,
      organizationId: forward.organizationId,
      evidenceCanonicalizationVersion: forward.evidenceCanonicalizationVersion,
      evidenceSchemaVersion: forward.evidenceSchemaVersion,
    };
    expect(computeSubmissionEvidenceHash(reordered)).toBe(computeSubmissionEvidenceHash(forward));
  });

  it('changes when any bound identity changes', () => {
    const base = computeSubmissionEvidenceHash(evidence());
    const variants: Partial<SubmissionEvidence>[] = [
      { revisionNumber: 2 },
      { documentSha256: 'e'.repeat(64) },
      { reportHash: 'e'.repeat(64) },
      { standardContentHash: 'e'.repeat(64) },
      { determination: 'NON_COMPLIANT' },
      { organizationId: '00000000-0000-4000-8000-000000000000' },
      { documentTypeId: '00000000-0000-4000-8000-000000000000' },
    ];
    for (const variant of variants) {
      expect([variant, computeSubmissionEvidenceHash(evidence(variant))]).not.toEqual([
        variant,
        base,
      ]);
    }
  });

  it('excludes the institution decision, so a decision never rewrites it (§138)', () => {
    // The whole point: a reviewer clicking Approve must not change the hash of
    // the evidence they were handed. There is no field for it to change.
    const canonical = canonicalSubmissionEvidence(evidence());
    for (const status of INSTITUTION_DECISION_STATUSES) {
      expect([status, canonical.includes(status)]).toEqual([status, false]);
    }
    expect(canonical).not.toContain('decision');
  });

  it('refuses to hash under a version it does not implement', () => {
    expect(() => computeSubmissionEvidenceHash(evidence({ evidenceSchemaVersion: 2 }))).toThrow(
      /schema version 2/,
    );
    expect(() =>
      computeSubmissionEvidenceHash(evidence({ evidenceCanonicalizationVersion: 9 })),
    ).toThrow(/canonicalized at version 9/);
  });
});
