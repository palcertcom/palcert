/**
 * Backend status values → the visual tone of their badge.
 *
 * The values are the lifecycle enums in `@palcert/contracts` (documents,
 * checks, certificates, submissions, standards, organizations, finance,
 * integrations, notifications); none is renamed or invented here. The tone
 * is a second channel only: a badge always shows the state's own label, taken
 * from the feature's message catalogue, so no state is told by colour alone.
 *
 *   success — the thing is done and good (ISSUED, APPROVED, PUBLISHED, READY)
 *   warning — something is in progress or waiting on someone (PENDING,
 *             UNDER_REVIEW, SCANNING, REVISION_REQUESTED, FAILED_RETRYABLE)
 *   danger  — a terminal bad outcome (FAILED, REJECTED, REVOKED)
 *   neutral — finished without being good or bad (DRAFT, ARCHIVED, CANCELLED,
 *             EXPIRED, RETIRED)
 */
export type StatusTone = 'success' | 'warning' | 'danger' | 'neutral' | 'gold';

const SUCCESS = [
  'ACTIVE',
  'ISSUED',
  'VALID',
  'COMPLETED',
  'SUCCEEDED',
  'READY',
  'DELIVERED',
  'APPROVED',
  'VERIFIED',
  'PUBLISHED',
  'ACCEPTED',
  'MODIFIED_AND_ACCEPTED',
  'PROCESSED',
  'WON',
  'COMPLIANT',
  'PASS',
  'SETTLED',
];

const WARNING = [
  'PENDING',
  'CREATED',
  'QUEUED',
  'RUNNING',
  'WAITING_ANALYSIS',
  'EVALUATING',
  'GENERATING_REPORT',
  'AWAITING_UPLOAD',
  'UPLOADED',
  'VALIDATING',
  'SCANNING',
  'PREPARING',
  'SUBMITTED',
  'UNDER_REVIEW',
  'REVISION_REQUESTED',
  'PENDING_REVIEW',
  'PENDING_VERIFICATION',
  'PENDING_MFA',
  'SENDING',
  'RESERVED',
  'PROCESSING',
  'RECHECKING',
  'DISPATCHED',
  'RETRY_PENDING',
  'FAILED_RETRYABLE',
  'ROTATING_OUT',
  'DISCOVERING_EVIDENCE',
  'GENERATING_PROPOSALS',
  'REQUESTED',
  'OPEN',
  'PAUSED',
  'REVIEW_REQUIRED',
  'IN_REVIEW',
  'NEEDS_INFORMATION',
];

const DANGER = [
  'FAILED',
  'FAILED_PERMANENT',
  'REJECTED',
  'REVOKED',
  'DEAD',
  'LOST',
  'RECONCILIATION_REQUIRED',
  'SUSPENDED',
  'DISABLED',
  'INVALID',
  'NON_COMPLIANT',
  'FAIL',
];

const NEUTRAL = [
  'DRAFT',
  'ARCHIVED',
  'CANCELLED',
  'EXPIRED',
  'UPLOAD_EXPIRED',
  'DELETED',
  'RETIRED',
  'SUPERSEDED',
  'RELEASED',
  'SKIPPED',
  'CLOSED',
  'REMOVED',
  'UNVERIFIED',
  'IGNORED',
  'NONE',
  'NOT_APPLICABLE',
  'REFUNDED',
  'CAPTURED',
  'INDETERMINATE',
  'UNPAID',
  'NOT_REQUIRED',
];

const TONES: ReadonlyMap<string, StatusTone> = new Map([
  ...SUCCESS.map((value) => [value, 'success'] as const),
  ...WARNING.map((value) => [value, 'warning'] as const),
  ...DANGER.map((value) => [value, 'danger'] as const),
  ...NEUTRAL.map((value) => [value, 'neutral'] as const),
]);

/** A status the map does not know is shown neutrally rather than guessed at. */
export function toneForStatus(status: string | null | undefined): StatusTone {
  if (status === null || status === undefined) return 'neutral';
  return TONES.get(status.toUpperCase()) ?? 'neutral';
}

/**
 * A standard version's tone. Published and draft must never look alike: a
 * published version is what documents are checked against and cannot change;
 * a draft is work in progress that checks never use.
 */
export function versionTone(status: string): StatusTone {
  if (status === 'PUBLISHED') return 'success';
  if (status === 'DRAFT') return 'gold';
  return toneForStatus(status);
}
