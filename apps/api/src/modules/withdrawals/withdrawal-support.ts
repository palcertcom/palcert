import {
  AppError,
  PalCertErrorCode,
  PayoutDestinationType,
  WithdrawalScope,
  WithdrawalStatus,
  money,
  withdrawalReference,
  type PayoutDestinationSummary,
  type PayoutDestinationView,
  type WithdrawalActorSide,
  type WithdrawalEventType,
  type WithdrawalEventView,
  type WithdrawalRejectionReason,
  type WithdrawalRequestView,
} from '@palcert/contracts';
import type {
  PayoutDestination,
  WithdrawalProof,
  WithdrawalRequest,
  WithdrawalRequestEvent,
} from '@palcert/database';
import type { SealedMaterial } from '../../common/crypto/aead-keyring';

/** Who is asking, for the audit record. */
export interface RequestContext {
  readonly requestId: string | null;
  readonly ipAddress: string | null;
}

/**
 * Whose money a call is about. Built only by controllers, from the route and
 * the authenticated principal — never from a request body — so a beneficiary
 * cannot be forged by naming somebody else in a payload.
 */
export type WithdrawalOwner =
  | { readonly scope: typeof WithdrawalScope.USER; readonly userId: string }
  | {
      readonly scope: typeof WithdrawalScope.ORGANIZATION;
      readonly userId: string;
      readonly organizationId: string;
    }
  | { readonly scope: typeof WithdrawalScope.PLATFORM; readonly userId: string };

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export function withdrawalNotFound(): AppError {
  return new AppError(PalCertErrorCode.WITHDRAWAL_NOT_FOUND, {
    message: 'That withdrawal request could not be found.',
  });
}

export function destinationNotFound(): AppError {
  return new AppError(PalCertErrorCode.PAYOUT_DESTINATION_NOT_FOUND, {
    message: 'That payout destination could not be found.',
  });
}

export function transitionInvalid(status: WithdrawalStatus, action: string): AppError {
  return new AppError(PalCertErrorCode.WITHDRAWAL_TRANSITION_INVALID, {
    message: `A ${status.toLowerCase().replace('_', ' ')} withdrawal cannot be ${action}.`,
    details: { status },
  });
}

export function alreadyDecided(status: WithdrawalStatus): AppError {
  return new AppError(PalCertErrorCode.WITHDRAWAL_ALREADY_DECIDED, {
    message: 'This withdrawal request has already been decided.',
    details: { status },
  });
}

export function staleVersion(current: number): AppError {
  return new AppError(PalCertErrorCode.WITHDRAWAL_CONFLICT, {
    message: 'This withdrawal changed since you opened it. Reload it and try again.',
    details: { version: current },
  });
}

export function separationOfDuties(message: string): AppError {
  return new AppError(PalCertErrorCode.WITHDRAWAL_SEPARATION_OF_DUTIES, { message });
}

export function invalid(field: string, message: string): AppError {
  return new AppError(PalCertErrorCode.VALIDATION_FAILED, { message, details: { field } });
}

export function cleanText(value: string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  const trimmed = value.normalize('NFC').trim();
  return trimmed.length === 0 ? null : trimmed;
}

/** Bounded free text, or a validation error naming the field. */
export function boundedText(
  value: string | null | undefined,
  max: number,
  field: string,
): string | null {
  const text = cleanText(value);
  if (text !== null && text.length > max) {
    throw invalid(field, `This may be at most ${max} characters.`);
  }
  return text;
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

export function clampLimit(limit: number | undefined, fallback = 25): number {
  return Math.min(Math.max(limit ?? fallback, 1), 100);
}

// ---------------------------------------------------------------------------
// Destinations and snapshots
// ---------------------------------------------------------------------------

export const DESTINATION_SNAPSHOT_VERSION = 1;

/**
 * The masked, in-the-clear half of a request's frozen destination. The full
 * details are sealed beside it on the request row; editing or archiving the
 * saved destination later changes neither (spec §14).
 */
export interface DestinationSnapshot extends PayoutDestinationSummary {
  readonly snapshotVersion: number;
  readonly destinationId: string;
  readonly destinationVersion: number;
  readonly capturedAt: string;
}

export function readSummary(value: unknown): PayoutDestinationSummary {
  const summary = value as Partial<PayoutDestinationSummary> | null;
  const type =
    summary !== null &&
    typeof summary === 'object' &&
    (Object.values(PayoutDestinationType) as unknown[]).includes(summary.type)
      ? (summary.type as PayoutDestinationType)
      : null;
  if (summary === null || type === null || typeof summary.label !== 'string') {
    throw new AppError(PalCertErrorCode.INTERNAL_ERROR, {
      message: 'An unexpected error occurred.',
      internalContext: { reason: 'payout destination summary has an unknown shape' },
    });
  }
  return {
    type,
    label: summary.label,
    beneficiaryName: summary.beneficiaryName ?? '',
    bankName: summary.bankName ?? null,
    ibanMasked: summary.ibanMasked ?? null,
    accountNumberMasked: summary.accountNumberMasked ?? null,
    mobileNumberMasked: summary.mobileNumberMasked ?? null,
    currency: summary.currency ?? null,
  };
}

export function sealedOf(row: {
  detailsCiphertext: string;
  detailsIv: string;
  detailsAuthTag: string;
  detailsKid: string;
}): SealedMaterial {
  return {
    kid: row.detailsKid,
    ciphertext: row.detailsCiphertext,
    iv: row.detailsIv,
    authTag: row.detailsAuthTag,
  };
}

export function requestSealedOf(row: WithdrawalRequest): SealedMaterial {
  return {
    kid: row.destinationSealedKid,
    ciphertext: row.destinationSealedCiphertext,
    iv: row.destinationSealedIv,
    authTag: row.destinationSealedAuthTag,
  };
}

export function destinationView(row: PayoutDestination): PayoutDestinationView {
  return {
    ...readSummary(row.summary),
    id: row.id,
    scope: row.scope as WithdrawalScope,
    organizationId: row.organizationId,
    version: row.version,
    archivedAt: row.archivedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Request views
// ---------------------------------------------------------------------------

export type RequestRow = WithdrawalRequest & {
  events?: WithdrawalRequestEvent[];
  proofs?: Pick<WithdrawalProof, 'id' | 'status'>[];
};

export const REQUEST_INCLUDE = {
  events: { orderBy: [{ createdAt: 'asc' as const }, { id: 'asc' as const }] },
  proofs: { select: { id: true, status: true } },
};

/** States from which the requester may still withdraw the request (spec §26). */
export const REQUESTER_CANCELLABLE: readonly WithdrawalStatus[] = [
  WithdrawalStatus.PENDING_REVIEW,
  WithdrawalStatus.APPROVED,
];

export function eventView(
  event: WithdrawalRequestEvent,
  names: ReadonlyMap<string, { displayName: string | null }>,
  showNotes: boolean,
): WithdrawalEventView {
  return {
    id: event.id,
    eventType: event.eventType as WithdrawalEventType,
    actorSide: event.actorSide as WithdrawalActorSide,
    actorDisplayName:
      event.actorUserId === null ? null : (names.get(event.actorUserId)?.displayName ?? null),
    note: showNotes ? event.note : null,
    createdAt: event.createdAt.toISOString(),
  };
}

/** The requester's view: their own request, with no finance-internal identity. */
export function requestView(
  row: RequestRow,
  extras: {
    readonly organizationName: string | null;
    readonly names: ReadonlyMap<string, { displayName: string | null }>;
  },
): WithdrawalRequestView {
  const status = row.status as WithdrawalStatus;
  const snapshot = readSummary(row.destinationSnapshot);
  return {
    id: row.id,
    reference: withdrawalReference(row.id),
    scope: row.scope as WithdrawalScope,
    status,
    amount: money(row.currency, row.amountMinor),
    organizationId: row.organizationId,
    organizationName: extras.organizationName,
    beneficiaryName: snapshot.beneficiaryName,
    destination: snapshot,
    requesterNote: row.requesterNote,
    rejectionReason: (row.rejectionReason ?? null) as WithdrawalRejectionReason | null,
    rejectionNote: row.rejectionNote,
    externalTransferReference: row.externalTransferReference,
    hasProof: (row.proofs ?? []).some((proof) => proof.status === 'READY'),
    cancellable: REQUESTER_CANCELLABLE.includes(status),
    submittedAt: row.submittedAt?.toISOString() ?? null,
    approvedAt: row.approvedAt?.toISOString() ?? null,
    rejectedAt: row.rejectedAt?.toISOString() ?? null,
    cancelledAt: row.cancelledAt?.toISOString() ?? null,
    executedAt: row.executedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
    version: row.version,
    // A requester sees what happened and who on their own side acted; a
    // finance note on a failed attempt is internal and is not shown.
    events: (row.events ?? []).map((event) =>
      eventView(event, extras.names, event.actorSide === 'REQUESTER'),
    ),
  };
}
