import {
  AppError,
  MANUAL_PAYMENT_METHOD_SNAPSHOT_VERSION,
  ManualTopUpStatus,
  PalCertErrorCode,
  money,
  type ManualPaymentMethodSnapshot,
  type ManualPaymentMethodType,
  type ManualTopUpEventView,
  type ManualTopUpFileFormat,
  type ManualTopUpFileStatus,
  type ManualTopUpReceiptView,
  type ManualTopUpRejectionReason,
  type ManualTopUpRequestView,
} from '@palcert/contracts';
import type {
  ManualPaymentMethod,
  ManualTopUpReceipt,
  ManualTopUpRequest,
  ManualTopUpRequestEvent,
} from '@palcert/database';

/** Who is asking, for the audit record. */
export interface RequestContext {
  readonly requestId: string | null;
  readonly ipAddress: string | null;
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export function requestNotFound(): AppError {
  return new AppError(PalCertErrorCode.MANUAL_TOPUP_NOT_FOUND, {
    message: 'That top-up request could not be found.',
  });
}

export function methodNotFound(): AppError {
  return new AppError(PalCertErrorCode.MANUAL_PAYMENT_METHOD_NOT_FOUND, {
    message: 'That payment method could not be found.',
  });
}

export function transitionInvalid(status: ManualTopUpStatus, action: string): AppError {
  return new AppError(PalCertErrorCode.MANUAL_TOPUP_TRANSITION_INVALID, {
    message: `A ${status.toLowerCase().replace('_', ' ')} top-up request cannot be ${action}.`,
    details: { status },
  });
}

export function alreadyDecided(status: ManualTopUpStatus): AppError {
  return new AppError(PalCertErrorCode.MANUAL_TOPUP_ALREADY_DECIDED, {
    message: 'This top-up request has already been decided.',
    details: { status },
  });
}

/**
 * The one answer to a reference that cannot be used, whatever the reason.
 *
 * Deliberately says nothing about whether the reference exists, whose it is,
 * or what state that request is in: a precise error would let anybody probe
 * which transfers have been reported.
 */
export function referenceUnavailable(): AppError {
  return new AppError(PalCertErrorCode.MANUAL_TOPUP_REFERENCE_UNAVAILABLE, {
    message:
      'This transfer reference cannot be used for this payment method. Check the reference, ' +
      'or contact PalCert support if you believe it is correct.',
  });
}

export function storageUnavailable(cause: unknown): AppError {
  return new AppError(PalCertErrorCode.SERVICE_UNAVAILABLE, {
    message: 'Storage is temporarily unavailable. Please try again.',
    cause,
  });
}

export function cleanText(value: string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  const trimmed = value.normalize('NFC').trim();
  return trimmed.length === 0 ? null : trimmed;
}

/** A Prisma unique violation, optionally on a named constraint or column. */
export function isUniqueViolation(error: unknown, target?: string): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const candidate = error as { code?: unknown; meta?: { target?: unknown } };
  if (candidate.code !== 'P2002') return false;
  if (target === undefined) return true;
  const recorded = candidate.meta?.target;
  return Array.isArray(recorded)
    ? recorded.some((name) => String(name).includes(target))
    : String(recorded ?? '').includes(target);
}

// ---------------------------------------------------------------------------
// The snapshot
// ---------------------------------------------------------------------------

/** Freeze where this person is being told to send money. */
export function snapshotOf(
  method: ManualPaymentMethod,
  capturedAt: Date,
): ManualPaymentMethodSnapshot {
  return {
    snapshotVersion: MANUAL_PAYMENT_METHOD_SNAPSHOT_VERSION,
    methodId: method.id,
    methodVersion: method.version,
    code: method.code,
    type: method.type as ManualPaymentMethodType,
    nameEn: method.nameEn,
    nameAr: method.nameAr,
    currency: method.currency,
    recipientName: method.recipientName,
    mobileNumber: method.mobileNumber,
    iban: method.iban,
    bankName: method.bankName,
    accountNumber: method.accountNumber,
    branchName: method.branchName,
    instructionsEn: method.instructionsEn,
    instructionsAr: method.instructionsAr,
    minAmountMinor: method.minAmountMinor.toString(),
    maxAmountMinor: method.maxAmountMinor.toString(),
    capturedAt: capturedAt.toISOString(),
  };
}

/**
 * Read a stored snapshot back.
 *
 * Validated rather than cast: the column is JSONB, and a snapshot that did not
 * have the shape this build writes is a defect to surface, not a value to
 * render half of.
 */
export function readSnapshot(value: unknown): ManualPaymentMethodSnapshot {
  const snapshot = value as Partial<ManualPaymentMethodSnapshot> | null;
  if (
    snapshot === null ||
    typeof snapshot !== 'object' ||
    snapshot.snapshotVersion !== MANUAL_PAYMENT_METHOD_SNAPSHOT_VERSION ||
    typeof snapshot.methodId !== 'string' ||
    typeof snapshot.code !== 'string' ||
    typeof snapshot.nameEn !== 'string' ||
    typeof snapshot.nameAr !== 'string' ||
    typeof snapshot.currency !== 'string' ||
    typeof snapshot.minAmountMinor !== 'string' ||
    typeof snapshot.maxAmountMinor !== 'string'
  ) {
    throw new AppError(PalCertErrorCode.INTERNAL_ERROR, {
      message: 'An unexpected error occurred.',
      internalContext: { reason: 'manual top-up payment method snapshot has an unknown shape' },
    });
  }
  return snapshot as ManualPaymentMethodSnapshot;
}

// ---------------------------------------------------------------------------
// Views
// ---------------------------------------------------------------------------

export function receiptView(
  receipt: ManualTopUpReceipt | null | undefined,
): ManualTopUpReceiptView | null {
  if (receipt === null || receipt === undefined) return null;
  return {
    id: receipt.id,
    status: receipt.status as ManualTopUpFileStatus,
    originalFilename: receipt.originalFilename,
    format: (receipt.detectedFormat ?? null) as ManualTopUpFileFormat | null,
    sizeBytes: receipt.sizeBytes,
    rejectionCode: receipt.rejectionCode,
    createdAt: receipt.createdAt.toISOString(),
  };
}

export function eventView(event: ManualTopUpRequestEvent): ManualTopUpEventView {
  return {
    id: event.id,
    eventType: event.eventType,
    actorSide: event.actorSide,
    createdAt: event.createdAt.toISOString(),
  };
}

export type RequestRow = ManualTopUpRequest & {
  receipt?: ManualTopUpReceipt | null;
  events?: ManualTopUpRequestEvent[];
};

/** The owner's view. Carries no reviewer identity and no ledger identifier. */
export function ownerRequestView(row: RequestRow): ManualTopUpRequestView {
  const status = row.status as ManualTopUpStatus;
  return {
    id: row.id,
    status,
    amount: money(row.currency, row.amountMinor ?? 0n),
    reference: row.referenceOriginal,
    customerNote: row.customerNote,
    paymentMethod: readSnapshot(row.paymentMethodSnapshot),
    receipt: receiptView(row.receipt),
    rejectionReason: (row.rejectionReason ?? null) as ManualTopUpRejectionReason | null,
    rejectionNote: row.rejectionNote,
    cancellable:
      status === ManualTopUpStatus.DRAFT ||
      (status === ManualTopUpStatus.PENDING_REVIEW && row.reviewStartedAt === null),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    submittedAt: row.submittedAt?.toISOString() ?? null,
    reviewStartedAt: row.reviewStartedAt?.toISOString() ?? null,
    decidedAt: row.decidedAt?.toISOString() ?? null,
    cancelledAt: row.cancelledAt?.toISOString() ?? null,
    events: (row.events ?? []).map(eventView),
  };
}

export const REQUEST_INCLUDE = {
  receipt: true,
  events: { orderBy: [{ createdAt: 'asc' as const }, { id: 'asc' as const }] },
};

/** The page size bounds every list in this module uses. */
export function clampLimit(limit: number | undefined, fallback = 25): number {
  return Math.min(Math.max(limit ?? fallback, 1), 100);
}
