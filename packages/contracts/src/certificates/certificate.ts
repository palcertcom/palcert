/**
 * What a PalCert certificate is, and what it is careful never to become.
 *
 * A certificate says exactly one thing (§2):
 *
 *   PalCert confirms that the referenced official submission achieved a
 *   PalCert technical compliance determination of COMPLIANT and that the
 *   receiving organization recorded an APPROVED institution decision for that
 *   same immutable submission revision.
 *
 * It does not award a degree, accept a paper, judge scientific merit, or issue
 * the organization's decision on its behalf. The two authorities that Phase 14
 * separated stay separated: a certificate is a *derived consequence* of them
 * agreeing, not a third status that replaces either.
 */

/**
 * Where an issuance attempt has got to (§26).
 *
 * Deliberately not `APPROVED` or `COMPLIANT` — those belong to the evidence
 * this certificate is derived from, and reusing them here would be the first
 * step towards one mutable status standing for all three.
 *
 * The two failure states exist because of a conflict that is easy to miss: a
 * certificate row is unique per revision, so a single terminal FAILED would
 * permanently bar an eligible revision from ever being certified, even when
 * the failure was a storage timeout. Distinguishing them is what lets
 * reconciliation retry the recoverable case while a genuine evidence mismatch
 * stays fail-closed for good.
 */
export const CertificateIssuanceStatus = {
  /** Eligible and claimed; nothing has been rendered or stored yet. */
  PENDING: 'PENDING',
  /** Claim and artifact exist, were read back and verified. Publicly valid. */
  ISSUED: 'ISSUED',
  /** Infrastructure got in the way. Reconciliation will bring it back to PENDING. */
  FAILED_RETRYABLE: 'FAILED_RETRYABLE',
  /** The evidence itself did not verify. Never retried, never issued. */
  FAILED_PERMANENT: 'FAILED_PERMANENT',
  /** Issued, then withdrawn by an authorized party. The artifact still exists. */
  REVOKED: 'REVOKED',
} as const;

export type CertificateIssuanceStatus =
  (typeof CertificateIssuanceStatus)[keyof typeof CertificateIssuanceStatus];

export const CERTIFICATE_ISSUANCE_STATUSES: readonly CertificateIssuanceStatus[] =
  Object.values(CertificateIssuanceStatus);

/**
 * The issuance state machine (§26, and correction §4).
 *
 * `FAILED_RETRYABLE` returns to `PENDING` on the *same* certificate identity —
 * same row, same verification code, same revision binding — so a retry never
 * mints a second certificate for one approval.
 */
const ISSUANCE_TRANSITIONS: Readonly<
  Record<CertificateIssuanceStatus, readonly CertificateIssuanceStatus[]>
> = {
  PENDING: [
    CertificateIssuanceStatus.ISSUED,
    CertificateIssuanceStatus.FAILED_RETRYABLE,
    CertificateIssuanceStatus.FAILED_PERMANENT,
  ],
  FAILED_RETRYABLE: [CertificateIssuanceStatus.PENDING],
  ISSUED: [CertificateIssuanceStatus.REVOKED],
  FAILED_PERMANENT: [],
  REVOKED: [],
};

export function allowedIssuanceTransitions(
  from: CertificateIssuanceStatus,
): readonly CertificateIssuanceStatus[] {
  return ISSUANCE_TRANSITIONS[from];
}

export function isValidIssuanceTransition(
  from: CertificateIssuanceStatus,
  to: CertificateIssuanceStatus,
): boolean {
  return ISSUANCE_TRANSITIONS[from].includes(to);
}

/** Statuses an issuance attempt never leaves. */
export function isTerminalIssuance(status: CertificateIssuanceStatus): boolean {
  return (
    status === CertificateIssuanceStatus.FAILED_PERMANENT ||
    status === CertificateIssuanceStatus.REVOKED
  );
}

/** Whether reconciliation should put this attempt back in the queue. */
export function isRequeueable(status: CertificateIssuanceStatus): boolean {
  return status === CertificateIssuanceStatus.FAILED_RETRYABLE;
}

/**
 * What a verifier is told (§100).
 *
 * Separate from the issuance status on purpose. `EXPIRED` is derived at read
 * time from `validUntil` rather than written by a job at midnight (§27), and a
 * `PENDING` or failed certificate has no public status at all — the public
 * route answers not-found, so nobody can probe for certificates that do not
 * exist yet (§18, §154, §155).
 */
export const CertificateVerificationStatus = {
  VALID: 'VALID',
  REVOKED: 'REVOKED',
  EXPIRED: 'EXPIRED',
} as const;

export type CertificateVerificationStatus =
  (typeof CertificateVerificationStatus)[keyof typeof CertificateVerificationStatus];

export const CERTIFICATE_VERIFICATION_STATUSES: readonly CertificateVerificationStatus[] =
  Object.values(CertificateVerificationStatus);

/**
 * Derive what a verifier should see, right now.
 *
 * Revocation outranks expiry: a certificate that was withdrawn and has also
 * passed its validity date is reported as REVOKED, because that is the fact
 * about it that matters.
 */
export function verificationStatusOf(params: {
  readonly issuanceStatus: CertificateIssuanceStatus;
  readonly validUntil: Date | null;
  readonly now: Date;
}): CertificateVerificationStatus | null {
  if (params.issuanceStatus === CertificateIssuanceStatus.REVOKED) {
    return CertificateVerificationStatus.REVOKED;
  }
  if (params.issuanceStatus !== CertificateIssuanceStatus.ISSUED) return null;
  if (params.validUntil !== null && params.validUntil.getTime() <= params.now.getTime()) {
    return CertificateVerificationStatus.EXPIRED;
  }
  return CertificateVerificationStatus.VALID;
}

/** One entry in the append-only certificate history (§59). */
export const CertificateEventType = {
  ISSUED: 'ISSUED',
  REVOKED: 'REVOKED',
} as const;

export type CertificateEventType = (typeof CertificateEventType)[keyof typeof CertificateEventType];

export const CERTIFICATE_EVENT_TYPES: readonly CertificateEventType[] =
  Object.values(CertificateEventType);

/**
 * Who did it (§60).
 *
 * Shown rather than inferred, for the same reason Phase 14 records a decision
 * event's source: an event with no actor could mean "PalCert issued this" or
 * "somebody was not recorded", and those must not look alike.
 */
export const CertificateEventSource = {
  /** PalCert's own issuance workflow. Never a person. */
  SYSTEM: 'SYSTEM',
  /** A named, authorized member of the approving organization. */
  ORGANIZATION: 'ORGANIZATION',
  /** PalCert staff, through audited platform elevation only (§64). */
  PALCERT_ADMIN: 'PALCERT_ADMIN',
} as const;

export type CertificateEventSource =
  (typeof CertificateEventSource)[keyof typeof CertificateEventSource];

export const CERTIFICATE_EVENT_SOURCES: readonly CertificateEventSource[] =
  Object.values(CertificateEventSource);

/**
 * Why a certificate was withdrawn (§66).
 *
 * Administrative categories only. PalCert cannot adjudicate why an institution
 * changed its mind, and a reason code that implied it could would be PalCert
 * putting its name on somebody else's judgement.
 */
export const CertificateRevocationReason = {
  ISSUED_IN_ERROR: 'ISSUED_IN_ERROR',
  EVIDENCE_INTEGRITY_FAILURE: 'EVIDENCE_INTEGRITY_FAILURE',
  ADMINISTRATIVE_CORRECTION: 'ADMINISTRATIVE_CORRECTION',
  SECURITY_INCIDENT: 'SECURITY_INCIDENT',
  OTHER: 'OTHER',
} as const;

export type CertificateRevocationReason =
  (typeof CertificateRevocationReason)[keyof typeof CertificateRevocationReason];

export const CERTIFICATE_REVOCATION_REASONS: readonly CertificateRevocationReason[] = Object.values(
  CertificateRevocationReason,
);

/** The longest private revocation note anyone may record. */
export const CERTIFICATE_REVOCATION_COMMENT_MAX_LENGTH = 2000;

/**
 * Why an issuance attempt stopped (§85, §86).
 *
 * The split is the whole point: the first four mean the evidence did not
 * verify, and retrying would only re-prove that. The rest mean PalCert's own
 * machinery was briefly unavailable, which says nothing about the submission.
 */
export const CertificateFailureCode = {
  /** The stored document no longer hashes to what the submission recorded. */
  DOCUMENT_SNAPSHOT_MISMATCH: 'DOCUMENT_SNAPSHOT_MISMATCH',
  /** The stored report no longer hashes to its recorded report hash. */
  REPORT_SNAPSHOT_MISMATCH: 'REPORT_SNAPSHOT_MISMATCH',
  /** The Phase 14 evidence hash does not recompute from its own inputs. */
  EVIDENCE_HASH_MISMATCH: 'EVIDENCE_HASH_MISMATCH',
  /** No matching organization-sourced APPROVED event for this revision. */
  APPROVAL_EVENT_INVALID: 'APPROVAL_EVENT_INVALID',
  /** The revision stopped being eligible before the claim was built. */
  NO_LONGER_ELIGIBLE: 'NO_LONGER_ELIGIBLE',
  /** A stored artifact did not read back as what was written. */
  ARTIFACT_VERIFICATION_FAILED: 'ARTIFACT_VERIFICATION_FAILED',
  /** Object storage was unavailable or refused the write. */
  STORAGE_UNAVAILABLE: 'STORAGE_UNAVAILABLE',
  /** The renderer could not produce the certificate. */
  RENDERER_FAILED: 'RENDERER_FAILED',
} as const;

export type CertificateFailureCode =
  (typeof CertificateFailureCode)[keyof typeof CertificateFailureCode];

export const CERTIFICATE_FAILURE_CODES: readonly CertificateFailureCode[] =
  Object.values(CertificateFailureCode);

/**
 * Failures that mean the evidence is wrong, not that PalCert had a bad minute.
 *
 * These never retry. An automatic retry on a digest mismatch would be PalCert
 * repeatedly asking whether the bytes had changed their mind.
 */
export const PERMANENT_CERTIFICATE_FAILURES: readonly CertificateFailureCode[] = [
  CertificateFailureCode.DOCUMENT_SNAPSHOT_MISMATCH,
  CertificateFailureCode.REPORT_SNAPSHOT_MISMATCH,
  CertificateFailureCode.EVIDENCE_HASH_MISMATCH,
  CertificateFailureCode.APPROVAL_EVENT_INVALID,
  CertificateFailureCode.NO_LONGER_ELIGIBLE,
];

export function isPermanentCertificateFailure(code: CertificateFailureCode): boolean {
  return PERMANENT_CERTIFICATE_FAILURES.includes(code);
}

/** The issuance status a given failure lands the attempt in. */
export function issuanceStatusForFailure(code: CertificateFailureCode): CertificateIssuanceStatus {
  return isPermanentCertificateFailure(code)
    ? CertificateIssuanceStatus.FAILED_PERMANENT
    : CertificateIssuanceStatus.FAILED_RETRYABLE;
}
