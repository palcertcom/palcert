import { canonicalizeJson, sha256Hex } from '../checks/report.js';
import type { ComplianceDetermination } from '../checks/check.js';
import type { DocumentFormat } from '../documents/document.js';

/**
 * The evidence hash of one official submission revision (§137, §187).
 *
 * A submission revision is a claim: *these exact bytes, measured against these
 * exact rules, produced this exact report, and were handed to this
 * organization as revision N.* The evidence hash is that claim in 64
 * characters, so Phase 15 can issue a certificate that references a
 * submission without reconstructing it from tables that have moved on.
 *
 * Two decisions shape what goes in.
 *
 * **The institution's decision is deliberately excluded** (§138). A decision is
 * a human event that happens *after* the evidence was handed over, and it can
 * happen more than once in a case's life. Including it would mean the evidence
 * hash changed every time a reviewer clicked a button, which would make it
 * useless as an identifier for the evidence. Decisions have their own
 * append-only history, and Phase 15 will reference both.
 *
 * **Only identity and integrity go in**, never counts or scores. The
 * determination is included because it is part of what was handed over and
 * Phase 15's rule depends on it; the score is not, because it is derived from
 * the report the report hash already covers.
 *
 * Canonicalization is the report's own (RFC 8785, no fractional numbers), so
 * there is one canonical-JSON implementation in the codebase rather than two
 * that can drift.
 */

/** Bumped when a field is added, removed or renamed. */
export const SUBMISSION_EVIDENCE_SCHEMA_VERSION = 1;

/** Bumped when the same input would serialize differently. */
export const SUBMISSION_EVIDENCE_CANONICALIZATION_VERSION = 1;

/**
 * Exactly what the evidence hash covers.
 *
 * Every field is an identity or a digest. Nothing here is a count, a name, an
 * email, a filename, or anything a person wrote — an evidence hash that
 * changed when somebody renamed their document would be describing the wrong
 * thing.
 */
export interface SubmissionEvidence {
  readonly evidenceSchemaVersion: number;
  readonly evidenceCanonicalizationVersion: number;

  readonly organizationId: string;
  readonly documentTypeId: string;
  readonly documentId: string;
  readonly revisionNumber: number;

  /** The exact bytes submitted. */
  readonly documentVersionId: string;
  readonly documentSha256: string;
  readonly documentFormat: DocumentFormat;

  /** The exact technical result handed over. */
  readonly checkId: string;
  readonly checkRunId: string;
  readonly reportId: string;
  readonly reportHash: string;
  readonly evaluationHash: string;
  readonly determination: ComplianceDetermination;

  /** The exact rules it was measured against. */
  readonly standardId: string;
  readonly standardVersionId: string;
  readonly standardContentHash: string;
}

/**
 * Hash one revision's evidence.
 *
 * Refuses a version it does not implement rather than hashing under the wrong
 * rules: a hash computed by the wrong canonicalization is worse than no hash,
 * because it looks like one.
 */
export function computeSubmissionEvidenceHash(evidence: SubmissionEvidence): string {
  if (evidence.evidenceSchemaVersion !== SUBMISSION_EVIDENCE_SCHEMA_VERSION) {
    throw new Error(
      `cannot hash submission evidence at schema version ${evidence.evidenceSchemaVersion}`,
    );
  }
  if (evidence.evidenceCanonicalizationVersion !== SUBMISSION_EVIDENCE_CANONICALIZATION_VERSION) {
    throw new Error(
      'cannot hash submission evidence canonicalized at version ' +
        String(evidence.evidenceCanonicalizationVersion),
    );
  }
  return sha256Hex(canonicalizeJson(evidence));
}

/** The canonical bytes, for a golden fixture to pin (§188). */
export function canonicalSubmissionEvidence(evidence: SubmissionEvidence): string {
  return canonicalizeJson(evidence);
}
