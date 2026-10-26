import { randomBytes } from 'node:crypto';
import { sha256Hex } from '../checks/report.js';
import { base32Decode } from '../certificates/verification-code.js';
import { serializeCanonical } from '../standards/canonical.js';

/**
 * Certificate attestation.
 *
 * A PalCert user uploads a certificate they already hold. An institution
 * reviews that exact file and, if it agrees, PalCert records an immutable
 * attestation over the file's SHA-256.
 *
 * The vocabulary matters, so it is stated once here and used everywhere:
 *
 *   - the **submitted certificate** is the user's file. PalCert did not issue
 *     it and never claims to have; the institution does not re-issue it.
 *   - the **attestation** is PalCert's record that a named institution
 *     reviewed that exact artifact and considered it genuine for a stated
 *     period. It is the only thing PalCert vouches for.
 *
 * Two state machines are kept apart on purpose. The *request* workflow
 * (DRAFT → SUBMITTED → IN_REVIEW → …) describes a case moving through an
 * institution's queue. The *verification* status (VALID, EXPIRED, REVOKED)
 * describes an approved attestation as a verifier sees it today. Folding them
 * into one enum would make "approved" and "valid" the same word, and they are
 * not: an approved attestation can expire.
 */

// ---------------------------------------------------------------------------
// Request workflow
// ---------------------------------------------------------------------------

export const AttestationRequestStatus = {
  /** Being prepared by the user. The institution cannot see it. */
  DRAFT: 'DRAFT',
  /** Handed to the institution. Any fee is reserved from the user's balance. */
  SUBMITTED: 'SUBMITTED',
  /** A reviewer has started. The user can no longer cancel. */
  IN_REVIEW: 'IN_REVIEW',
  /** The institution asked the user for something. */
  NEEDS_INFORMATION: 'NEEDS_INFORMATION',
  APPROVED: 'APPROVED',
  REJECTED: 'REJECTED',
  CANCELLED: 'CANCELLED',
} as const;

export type AttestationRequestStatus =
  (typeof AttestationRequestStatus)[keyof typeof AttestationRequestStatus];

export const ATTESTATION_REQUEST_STATUSES: readonly AttestationRequestStatus[] =
  Object.values(AttestationRequestStatus);

/** The terminal states. Exactly one of them ends every submitted request. */
export const TERMINAL_ATTESTATION_REQUEST_STATUSES: readonly AttestationRequestStatus[] = [
  AttestationRequestStatus.APPROVED,
  AttestationRequestStatus.REJECTED,
  AttestationRequestStatus.CANCELLED,
];

export function isTerminalAttestationRequestStatus(status: AttestationRequestStatus): boolean {
  return TERMINAL_ATTESTATION_REQUEST_STATUSES.includes(status);
}

/**
 * Every transition a request may make, and nothing else.
 *
 * There is no status PATCH anywhere in PalCert: each edge below is one named
 * action with its own endpoint, its own permission and its own audit event.
 * The same table is enforced by a database trigger, so a service that forgot
 * to consult it would still be refused.
 */
export const ATTESTATION_REQUEST_TRANSITIONS: Readonly<
  Record<AttestationRequestStatus, readonly AttestationRequestStatus[]>
> = {
  DRAFT: [AttestationRequestStatus.SUBMITTED, AttestationRequestStatus.CANCELLED],
  SUBMITTED: [AttestationRequestStatus.IN_REVIEW, AttestationRequestStatus.CANCELLED],
  IN_REVIEW: [
    AttestationRequestStatus.NEEDS_INFORMATION,
    AttestationRequestStatus.APPROVED,
    AttestationRequestStatus.REJECTED,
  ],
  // The user's answer returns the case to the institution's queue as
  // SUBMITTED, so a reviewer consciously picks it up again. The institution
  // may also close a case that stopped answering.
  NEEDS_INFORMATION: [AttestationRequestStatus.SUBMITTED, AttestationRequestStatus.REJECTED],
  APPROVED: [],
  REJECTED: [],
  CANCELLED: [],
};

export function canTransitionAttestationRequest(
  from: AttestationRequestStatus,
  to: AttestationRequestStatus,
): boolean {
  return ATTESTATION_REQUEST_TRANSITIONS[from].includes(to);
}

/**
 * The owner may cancel only before a reviewer has picked the case up.
 *
 * Once IN_REVIEW the institution is doing work it is being paid for, and a
 * cancellation would be a refund by another name. Policy, stated in one place.
 */
export const OWNER_CANCELLABLE_STATUSES: readonly AttestationRequestStatus[] = [
  AttestationRequestStatus.DRAFT,
  AttestationRequestStatus.SUBMITTED,
];

// ---------------------------------------------------------------------------
// Request history
// ---------------------------------------------------------------------------

export const AttestationRequestEventType = {
  CREATED: 'CREATED',
  SUBMITTED: 'SUBMITTED',
  REVIEW_STARTED: 'REVIEW_STARTED',
  ASSIGNED: 'ASSIGNED',
  INFORMATION_REQUESTED: 'INFORMATION_REQUESTED',
  INFORMATION_PROVIDED: 'INFORMATION_PROVIDED',
  APPROVED: 'APPROVED',
  REJECTED: 'REJECTED',
  CANCELLED: 'CANCELLED',
  REVOKED: 'REVOKED',
  PAYMENT_RESERVED: 'PAYMENT_RESERVED',
  PAYMENT_SETTLED: 'PAYMENT_SETTLED',
  PAYMENT_RELEASED: 'PAYMENT_RELEASED',
} as const;

export type AttestationRequestEventType =
  (typeof AttestationRequestEventType)[keyof typeof AttestationRequestEventType];

export const ATTESTATION_REQUEST_EVENT_TYPES: readonly AttestationRequestEventType[] =
  Object.values(AttestationRequestEventType);

/** Who wrote a history entry. Never inferred from a null actor. */
export const AttestationActorSide = {
  OWNER: 'OWNER',
  ORGANIZATION: 'ORGANIZATION',
  SYSTEM: 'SYSTEM',
} as const;

export type AttestationActorSide = (typeof AttestationActorSide)[keyof typeof AttestationActorSide];

// ---------------------------------------------------------------------------
// Verification status of an approved attestation
// ---------------------------------------------------------------------------

export const AttestationVerificationStatus = {
  VALID: 'VALID',
  EXPIRED: 'EXPIRED',
  REVOKED: 'REVOKED',
} as const;

export type AttestationVerificationStatus =
  (typeof AttestationVerificationStatus)[keyof typeof AttestationVerificationStatus];

export const ATTESTATION_VERIFICATION_STATUSES: readonly AttestationVerificationStatus[] =
  Object.values(AttestationVerificationStatus);

/**
 * What a verifier sees right now.
 *
 * EXPIRED is derived at read time from the stored `validUntil`, never written
 * by a midnight job, so no clock skew in a worker can show a stale VALID.
 * `validUntil` is a *valid-through* instant: the attestation is valid at every
 * instant strictly before it and expired from it onwards. Revocation outranks
 * expiry. An attestation whose `validFrom` is still in the future is reported
 * as VALID with that date shown, because it is not invalid — only not yet in
 * force — and a verifier reads the date.
 */
export function attestationVerificationStatus(params: {
  readonly revokedAt: Date | null;
  readonly validUntil: Date | null;
  readonly now: Date;
}): AttestationVerificationStatus {
  if (params.revokedAt !== null) return AttestationVerificationStatus.REVOKED;
  if (params.validUntil !== null && params.validUntil.getTime() <= params.now.getTime()) {
    return AttestationVerificationStatus.EXPIRED;
  }
  return AttestationVerificationStatus.VALID;
}

// ---------------------------------------------------------------------------
// Payment state (a projection; the ledger and holds are the authority)
// ---------------------------------------------------------------------------

export const AttestationPaymentStatus = {
  /** No fee: nothing is reserved and nothing will be charged. */
  NOT_REQUIRED: 'NOT_REQUIRED',
  /** Not yet submitted, so nothing is reserved yet. */
  UNPAID: 'UNPAID',
  /** The fee is held against the user's balance. */
  RESERVED: 'RESERVED',
  /** Approved: the hold was captured and split between institution and PalCert. */
  SETTLED: 'SETTLED',
  /** Rejected or cancelled: the hold was released in full. */
  RELEASED: 'RELEASED',
} as const;

export type AttestationPaymentStatus =
  (typeof AttestationPaymentStatus)[keyof typeof AttestationPaymentStatus];

/**
 * The refund and release policy, stated in code so the UI can quote it.
 *
 *   rejected by the institution       → full release, nothing charged
 *   cancelled by the user pre-review  → full release, nothing charged
 *   approved                          → captured and settled
 *   revoked after approval            → nothing refunded automatically
 *
 * A refund after revocation is a deliberate finance act through the existing
 * admin refund and adjustment tools, never a side effect of revoking.
 */
export const ATTESTATION_REFUND_POLICY = {
  rejected: 'RELEASE_IN_FULL',
  cancelledBeforeReview: 'RELEASE_IN_FULL',
  approved: 'CAPTURE_AND_SETTLE',
  revokedAfterApproval: 'NO_AUTOMATIC_REFUND',
} as const;

// ---------------------------------------------------------------------------
// Artifacts
// ---------------------------------------------------------------------------

export const AttestationArtifactFormat = {
  PDF: 'PDF',
  PNG: 'PNG',
  JPEG: 'JPEG',
  WEBP: 'WEBP',
} as const;

export type AttestationArtifactFormat =
  (typeof AttestationArtifactFormat)[keyof typeof AttestationArtifactFormat];

export const ATTESTATION_ARTIFACT_FORMATS: readonly AttestationArtifactFormat[] =
  Object.values(AttestationArtifactFormat);

export function isAttestationArtifactFormat(value: string): value is AttestationArtifactFormat {
  return (ATTESTATION_ARTIFACT_FORMATS as readonly string[]).includes(value);
}

/** The one MIME type PalCert serves each format as. Never the browser's claim. */
export const ATTESTATION_ARTIFACT_MIME_TYPES: Readonly<Record<AttestationArtifactFormat, string>> =
  {
    PDF: 'application/pdf',
    PNG: 'image/png',
    JPEG: 'image/jpeg',
    WEBP: 'image/webp',
  };

/**
 * What a filename's extension *suggests*. Advisory only: the bytes decide, and
 * a `.pdf` whose content is a PNG is refused rather than reclassified.
 */
export const ATTESTATION_ARTIFACT_EXTENSIONS: Readonly<Record<string, AttestationArtifactFormat>> =
  {
    '.pdf': 'PDF',
    '.png': 'PNG',
    '.jpg': 'JPEG',
    '.jpeg': 'JPEG',
    '.webp': 'WEBP',
  };

export function attestationFormatForFilename(filename: string): AttestationArtifactFormat | null {
  const dot = filename.lastIndexOf('.');
  if (dot < 0) return null;
  return ATTESTATION_ARTIFACT_EXTENSIONS[filename.slice(dot).toLowerCase()] ?? null;
}

/**
 * 20 MB: the same ceiling PalCert already applies to a PDF upload, so an
 * attestation artifact is never the largest thing the pipeline accepts.
 */
export const DEFAULT_ATTESTATION_MAX_FILE_BYTES = 20 * 1024 * 1024;
export const ABSOLUTE_ATTESTATION_MAX_FILE_BYTES = 20 * 1024 * 1024;

export const AttestationArtifactStatus = {
  AWAITING_UPLOAD: 'AWAITING_UPLOAD',
  UPLOADED: 'UPLOADED',
  VALIDATING: 'VALIDATING',
  SCANNING: 'SCANNING',
  READY: 'READY',
  REJECTED: 'REJECTED',
  FAILED: 'FAILED',
  UPLOAD_EXPIRED: 'UPLOAD_EXPIRED',
  CANCELLED: 'CANCELLED',
} as const;

export type AttestationArtifactStatus =
  (typeof AttestationArtifactStatus)[keyof typeof AttestationArtifactStatus];

// ---------------------------------------------------------------------------
// Metadata
// ---------------------------------------------------------------------------

/**
 * The fields a user describes their certificate with.
 *
 * `certificateTitle` is always required. The others are required when the
 * attestation type says so. Everything here is *submitted* metadata — the
 * user's word — and is stored apart from the metadata a reviewer confirms.
 */
export const AttestationMetadataField = {
  CERTIFICATE_TITLE: 'certificateTitle',
  CERTIFICATE_TYPE: 'certificateType',
  ISSUING_ORGANIZATION: 'issuingOrganization',
  ISSUE_DATE: 'issueDate',
  REFERENCE_NUMBER: 'referenceNumber',
  RECIPIENT_NAME: 'recipientName',
  DESCRIPTION: 'description',
} as const;

export type AttestationMetadataField =
  (typeof AttestationMetadataField)[keyof typeof AttestationMetadataField];

export const ATTESTATION_METADATA_FIELDS: readonly AttestationMetadataField[] =
  Object.values(AttestationMetadataField);

/** Fields a type may make mandatory. The title is mandatory for every type. */
export const CONFIGURABLE_REQUIRED_FIELDS: readonly AttestationMetadataField[] = [
  AttestationMetadataField.CERTIFICATE_TYPE,
  AttestationMetadataField.ISSUING_ORGANIZATION,
  AttestationMetadataField.ISSUE_DATE,
  AttestationMetadataField.REFERENCE_NUMBER,
  AttestationMetadataField.RECIPIENT_NAME,
  AttestationMetadataField.DESCRIPTION,
];

export const ATTESTATION_TEXT_LIMITS = {
  certificateTitle: 300,
  certificateType: 200,
  issuingOrganization: 300,
  referenceNumber: 120,
  recipientName: 200,
  description: 2000,
  notesForReviewer: 2000,
  reviewerMessage: 2000,
  ownerResponse: 2000,
  rejectionReason: 2000,
  revocationReason: 2000,
  institutionNote: 2000,
  typeName: 200,
  typeDescription: 2000,
  typeInstructions: 4000,
} as const;

export interface AttestationSubmittedMetadata {
  readonly certificateTitle: string;
  readonly certificateType: string | null;
  readonly issuingOrganization: string | null;
  /** `YYYY-MM-DD`. A calendar date, deliberately not an instant. */
  readonly issueDate: string | null;
  readonly referenceNumber: string | null;
  readonly recipientName: string | null;
  readonly description: string | null;
}

export const ISO_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/** A real calendar date in `YYYY-MM-DD`, not merely the right shape. */
export function isCalendarDate(value: string): boolean {
  if (!ISO_DATE_PATTERN.test(value)) return false;
  const [y, m, d] = value.split('-').map(Number) as [number, number, number];
  const date = new Date(Date.UTC(y, m - 1, d));
  return date.getUTCFullYear() === y && date.getUTCMonth() === m - 1 && date.getUTCDate() === d;
}

// ---------------------------------------------------------------------------
// Fees and commission
// ---------------------------------------------------------------------------

/** Commission is stored in basis points: 1500 = 15.00%. Integer, never a float. */
export const COMMISSION_BPS_SCALE = 10_000;
export const MIN_COMMISSION_BPS = 0;
export const MAX_COMMISSION_BPS = 10_000;

/** No configured rate means PalCert takes nothing until an administrator says otherwise. */
export const DEFAULT_COMMISSION_BPS = 0;

export function isValidCommissionBps(value: number): boolean {
  return Number.isInteger(value) && value >= MIN_COMMISSION_BPS && value <= MAX_COMMISSION_BPS;
}

/** `"15.5"` → 1550. Refuses anything with more than two decimals. */
export function parseCommissionPercent(value: string): number | null {
  const match = /^(\d{1,3})(?:\.(\d{1,2}))?$/.exec(value.trim());
  if (match === null) return null;
  const whole = Number(match[1]);
  const fraction = Number((match[2] ?? '').padEnd(2, '0'));
  const bps = whole * 100 + fraction;
  return isValidCommissionBps(bps) ? bps : null;
}

/** 1550 → `"15.50"`. Exact: built from integers, never by division. */
export function formatCommissionPercent(bps: number): string {
  return `${Math.trunc(bps / 100)}.${String(bps % 100).padStart(2, '0')}`;
}

export interface FeeSplit {
  readonly grossMinor: bigint;
  readonly platformFeeMinor: bigint;
  readonly institutionNetMinor: bigint;
  readonly platformCommissionBps: number;
  readonly institutionShareBps: number;
}

/**
 * Split a fee between the institution and PalCert.
 *
 * Integer arithmetic in minor units throughout. PalCert's share is rounded
 * half-up to the minor unit, and the institution receives exactly the rest,
 * so the two always sum to the gross — there is no third bucket a rounding
 * remainder could fall into.
 *
 *     $10.00 at 15%  → PalCert $1.50, institution $8.50
 *     $0.05  at 15%  → PalCert $0.01 (0.75 rounds up), institution $0.04
 */
export function splitAttestationFee(grossMinor: bigint, platformCommissionBps: number): FeeSplit {
  if (grossMinor < 0n) throw new Error('an attestation fee cannot be negative');
  if (!isValidCommissionBps(platformCommissionBps)) {
    throw new Error(`commission ${platformCommissionBps} bps is outside 0..10000`);
  }
  const scale = BigInt(COMMISSION_BPS_SCALE);
  const platformFeeMinor = (grossMinor * BigInt(platformCommissionBps) + scale / 2n) / scale;
  return {
    grossMinor,
    platformFeeMinor,
    institutionNetMinor: grossMinor - platformFeeMinor,
    platformCommissionBps,
    institutionShareBps: COMMISSION_BPS_SCALE - platformCommissionBps,
  };
}

// ---------------------------------------------------------------------------
// Validity
// ---------------------------------------------------------------------------

export const MAX_ATTESTATION_VALIDITY_DAYS = 36_600; // one hundred years
export const DEFAULT_REMINDER_DAYS: readonly number[] = [30, 14, 7, 1];
export const MAX_REMINDER_DAYS = 365;

export function isValidReminderSchedule(days: readonly number[]): boolean {
  if (days.length > 8) return false;
  const seen = new Set<number>();
  for (const day of days) {
    if (!Number.isInteger(day) || day < 1 || day > MAX_REMINDER_DAYS || seen.has(day)) return false;
    seen.add(day);
  }
  return true;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/** `validFrom + days`, exactly, in UTC. */
export function addValidityDays(validFrom: Date, days: number): Date {
  return new Date(validFrom.getTime() + days * DAY_MS);
}

/**
 * Which reminder, if any, is due now.
 *
 * Reminders fire from the latest stage whose window has opened. When an
 * attestation is approved with only five days left, the 30-, 14- and 7-day
 * reminders are all "due" at once — sending three would be noise, so only the
 * nearest (7) is sent, and the earlier stages are never sent afterwards.
 * Expiry itself is stage `0`.
 *
 * Returns null when nothing new is due, given the stages already sent.
 */
export function dueReminderStage(params: {
  readonly validUntil: Date;
  readonly now: Date;
  readonly scheduleDays: readonly number[];
  readonly alreadySent: readonly number[];
}): number | null {
  const remainingMs = params.validUntil.getTime() - params.now.getTime();
  const smallestSent = params.alreadySent.length === 0 ? Infinity : Math.min(...params.alreadySent);
  if (remainingMs <= 0) {
    return smallestSent === 0 ? null : 0;
  }
  const open = params.scheduleDays.filter((day) => remainingMs <= day * DAY_MS);
  if (open.length === 0) return null;
  const stage = Math.min(...open);
  return stage < smallestSent ? stage : null;
}

// ---------------------------------------------------------------------------
// Public verification token and human reference
// ---------------------------------------------------------------------------

const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

function crockford(bytes: Uint8Array): string {
  let symbols = '';
  let buffer = 0;
  let bits = 0;
  for (const byte of bytes) {
    buffer = (buffer << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      symbols += CROCKFORD[(buffer >>> bits) & 0b11111];
    }
  }
  if (bits > 0) symbols += CROCKFORD[(buffer << (5 - bits)) & 0b11111];
  return symbols;
}

/** 160 random bits. Finding an attestation requires having been given its token. */
export const ATTESTATION_TOKEN_BYTES = 20;
export const ATTESTATION_TOKEN_SYMBOLS = 32;

export function generateAttestationToken(): string {
  return crockford(randomBytes(ATTESTATION_TOKEN_BYTES));
}

/**
 * The canonical token, or null.
 *
 * Case-insensitive, tolerant of the dashes a person may copy, and of the
 * Crockford look-alikes (I, L → 1; O → 0). Anything else is refused, and a
 * refusal and an unknown token get the same public answer.
 */
export function canonicalizeAttestationToken(input: string): string | null {
  const compact = input.trim().toUpperCase().replace(/[-\s]/g, '');
  if (compact.length !== ATTESTATION_TOKEN_SYMBOLS) return null;
  const normalized = compact.replace(/[IL]/g, '1').replace(/O/g, '0');
  for (const symbol of normalized) {
    if (!CROCKFORD.includes(symbol)) return null;
  }
  // Round-trips as 160 whole bits, so a token that decodes to anything else
  // is malformed rather than merely unknown.
  try {
    base32Decode(normalized);
  } catch {
    return null;
  }
  return normalized;
}

/** The only lookup key PalCert stores. One-way: the row discloses no token. */
export function attestationTokenHash(canonicalToken: string): string {
  return sha256Hex(`palcert-attestation-token:v1:${canonicalToken}`);
}

export const ATTESTATION_REFERENCE_PREFIX = 'PC-ATT';

/**
 * `PC-ATT-2026-7K3M9QXR`: printable, unique, and 40 random bits so that
 * consecutive references say nothing about how many attestations exist.
 * Not a capability — the public token is — so it is safe to print, search
 * for, and read over the phone.
 */
export function generateAttestationReference(year: number): string {
  return `${ATTESTATION_REFERENCE_PREFIX}-${year}-${crockford(randomBytes(5))}`;
}

export const ATTESTATION_REFERENCE_PATTERN = /^PC-ATT-\d{4}-[0-9A-HJKMNP-TV-Z]{8}$/;

// ---------------------------------------------------------------------------
// Attestation manifest and its hash
// ---------------------------------------------------------------------------

export const ATTESTATION_MANIFEST_VERSION = 1;

/**
 * Everything an attestation asserts, and nothing that changes afterwards.
 *
 * `artifactSha256` is the fingerprint of the exact bytes the user submitted.
 * `attestationHash` is a second, different digest: of this manifest, so the
 * record itself — who attested what, when, for how long — has an identity
 * that a later edit would visibly break. Revocation is deliberately absent:
 * revoking changes the status of an attestation, not what it said.
 */
export interface AttestationManifest {
  readonly manifestVersion: number;
  readonly reference: string;
  readonly organizationId: string;
  readonly organizationName: string;
  readonly attestationTypeId: string;
  readonly attestationTypeNameEn: string;
  readonly artifact: {
    readonly sha256: string;
    readonly sizeBytes: number;
    readonly mimeType: string;
  };
  readonly certificate: {
    readonly title: string;
    readonly type: string | null;
    readonly holderName: string | null;
    readonly issuingOrganization: string | null;
    readonly issueDate: string | null;
    readonly referenceNumber: string | null;
  };
  readonly validFrom: string;
  readonly validUntil: string | null;
  readonly approvedAt: string;
  readonly approvedByUserId: string;
  readonly previousAttestationId: string | null;
}

export function attestationManifestHash(manifest: AttestationManifest): string {
  return sha256Hex(serializeCanonical(manifest));
}

export const SHA256_HEX_PATTERN = /^[0-9a-f]{64}$/;
