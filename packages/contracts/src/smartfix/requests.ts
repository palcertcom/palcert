/**
 * The life of one paid correction (Phase 12 §59, §79, §80).
 *
 * A **SmartFixPlan** is free: PalCert reads a completed check and says exactly
 * what it would change. A **SmartFixRequest** is the paid execution of one
 * approved plan, and the separation matters commercially as well as
 * technically — the user sees the complete list of changes, in full, before
 * any money moves.
 *
 * The request's statuses are a different axis from the purchase's. A request
 * can be RECHECKING while its purchase is still PROCESSING, because the
 * purchase is charged only at delivery and the recheck is what decides whether
 * there is anything to deliver.
 */

import { ServicePurchaseStatus } from '../finance/purchases.js';

/** What SmartFix can be asked about. Phase 12 corrects DOCX and nothing else. */
export const SMARTFIX_SUPPORTED_FORMATS: readonly string[] = ['DOCX'];

/** Where a correction is in its life. */
export const SmartFixRequestStatus = {
  /** Balance reserved. Nothing has been written and nothing charged. */
  RESERVED: 'RESERVED',
  /** Transforming the document and ingesting the result. */
  PROCESSING: 'PROCESSING',
  /** The automatic recheck is running against the corrected version. */
  RECHECKING: 'RECHECKING',
  /** The recheck finished; verifying the targets and looking for regressions. */
  VALIDATING: 'VALIDATING',
  /** Delivered to the user, and only now charged. */
  DELIVERED: 'DELIVERED',
  /** Something went wrong. The reservation was released; nothing was charged. */
  FAILED: 'FAILED',
  /** The user stopped it before delivery. Released; nothing charged. */
  CANCELLED: 'CANCELLED',
} as const;

export type SmartFixRequestStatus =
  (typeof SmartFixRequestStatus)[keyof typeof SmartFixRequestStatus];

export const SMARTFIX_REQUEST_STATUSES: readonly SmartFixRequestStatus[] =
  Object.values(SmartFixRequestStatus);

/**
 * The permitted moves.
 *
 * There is no way back, and no way from VALIDATING to CANCELLED: once the
 * recheck has run, the only remaining questions are whether it justifies
 * delivery and whether the user should be charged. Letting a cancellation land
 * there would leave a corrected document that was verified, not delivered, and
 * not paid for — a state nobody could explain.
 */
const REQUEST_TRANSITIONS: Readonly<
  Record<SmartFixRequestStatus, readonly SmartFixRequestStatus[]>
> = {
  RESERVED: ['PROCESSING', 'FAILED', 'CANCELLED'],
  PROCESSING: ['RECHECKING', 'FAILED', 'CANCELLED'],
  RECHECKING: ['VALIDATING', 'FAILED', 'CANCELLED'],
  VALIDATING: ['DELIVERED', 'FAILED'],
  DELIVERED: [],
  FAILED: [],
  CANCELLED: [],
};

export function canTransitionSmartFixRequest(
  from: SmartFixRequestStatus,
  to: SmartFixRequestStatus,
): boolean {
  return REQUEST_TRANSITIONS[from].includes(to);
}

/** Whether a request is still holding the user's balance. */
export function smartFixHoldsBalance(status: SmartFixRequestStatus): boolean {
  return (
    status === SmartFixRequestStatus.RESERVED ||
    status === SmartFixRequestStatus.PROCESSING ||
    status === SmartFixRequestStatus.RECHECKING ||
    status === SmartFixRequestStatus.VALIDATING
  );
}

/** Whether a request has finished, one way or another. */
export function smartFixIsSettled(status: SmartFixRequestStatus): boolean {
  return !smartFixHoldsBalance(status);
}

/**
 * Why a correction ended without delivery.
 *
 * Every one of these releases the reservation and charges nothing. A document
 * that still fails its rules afterwards is *not* here: that is a delivered
 * correction with an honest result, and the user was told before they paid
 * exactly which rules it would address.
 */
export const SmartFixFailureCode = {
  /** The user stopped it. */
  CANCELLED_BY_CUSTOMER: 'CANCELLED_BY_CUSTOMER',
  /** The plan expired, or the document or standard moved underneath it. */
  PLAN_STALE: 'PLAN_STALE',
  /** The source document could not be read or is not correctable. */
  SOURCE_UNSUITABLE: 'SOURCE_UNSUITABLE',
  /** The mutation engine refused, or could not apply the plan completely. */
  CORRECTION_REFUSED: 'CORRECTION_REFUSED',
  /** The corrected bytes did not survive PalCert's own secure ingestion. */
  OUTPUT_REJECTED: 'OUTPUT_REJECTED',
  /** The corrected document could not be analyzed. */
  OUTPUT_UNREADABLE: 'OUTPUT_UNREADABLE',
  /** The automatic recheck did not complete. */
  RECHECK_FAILED: 'RECHECK_FAILED',
  /** A rule SmartFix targeted still fails. Nothing is delivered, nothing charged. */
  TARGETS_NOT_RESOLVED: 'SMARTFIX_TARGETS_NOT_RESOLVED',
  /** A rule that used to pass now fails. The correction is discarded (§101). */
  REGRESSION_DETECTED: 'SMARTFIX_REGRESSION_DETECTED',
  /** PalCert failed for a reason that is PalCert's own. */
  SERVICE_FAILED: 'SERVICE_FAILED',
} as const;

export type SmartFixFailureCode = (typeof SmartFixFailureCode)[keyof typeof SmartFixFailureCode];

export const SMARTFIX_FAILURE_CODES: readonly SmartFixFailureCode[] =
  Object.values(SmartFixFailureCode);

/** Why a check exists, and therefore whether it was paid for on its own. */
export const CheckPurpose = {
  USER_REQUESTED: 'USER_REQUESTED',
  SMARTFIX_RECHECK: 'SMARTFIX_RECHECK',
} as const;

export type CheckPurpose = (typeof CheckPurpose)[keyof typeof CheckPurpose];

/** Where a document version's bytes came from. */
export const DocumentVersionOrigin = {
  USER_UPLOAD: 'USER_UPLOAD',
  SMARTFIX: 'SMARTFIX',
} as const;

export type DocumentVersionOrigin =
  (typeof DocumentVersionOrigin)[keyof typeof DocumentVersionOrigin];

/**
 * The purchase status a request status implies.
 *
 * Written here so the two axes are reconciled in one place rather than in
 * every service that touches both. The database asserts the same pairing at
 * COMMIT; this is what lets the code get it right on the way there.
 */
export function purchaseStatusForRequest(
  status: SmartFixRequestStatus,
): ServicePurchaseStatus | null {
  switch (status) {
    case SmartFixRequestStatus.RESERVED:
      return ServicePurchaseStatus.RESERVED;
    case SmartFixRequestStatus.PROCESSING:
    case SmartFixRequestStatus.RECHECKING:
    case SmartFixRequestStatus.VALIDATING:
      return ServicePurchaseStatus.PROCESSING;
    case SmartFixRequestStatus.DELIVERED:
      return ServicePurchaseStatus.DELIVERED;
    case SmartFixRequestStatus.FAILED:
    case SmartFixRequestStatus.CANCELLED:
      return ServicePurchaseStatus.RELEASED;
    default:
      return null;
  }
}

/**
 * How long a free plan stays executable.
 *
 * A plan is a snapshot of one document against one set of rules, and both move
 * on. Executing a stale plan would apply changes the user approved against a
 * document that is no longer the one they were looking at — so the plan
 * expires, and the source digest is re-checked even inside that window.
 */
export const SMARTFIX_PLAN_TTL_MINUTES = 60;
