import { hkdfSync } from 'node:crypto';
import {
  AppError,
  AttestationArtifactFormat,
  AttestationPaymentStatus,
  AttestationRequestStatus,
  OWNER_CANCELLABLE_STATUSES,
  PalCertErrorCode,
  attestationVerificationStatus,
  formatCommissionPercent,
  money,
  type AttestationArtifactView,
  type AttestationConfirmedMetadataView,
  type AttestationFeeSnapshotView,
  type AttestationRecordView,
  type AttestationRequestEventView,
  type AttestationRequestListItemView,
  type AttestationRequestOwnerView,
  type AttestationSubmittedMetadata,
  type MoneyView,
} from '@palcert/contracts';
import type {
  Attestation,
  AttestationArtifact,
  AttestationRequest,
  AttestationRequestEvent,
} from '@palcert/database';
import { openSecret, sealSecret } from '../../common/crypto/secret-box';

/** The nil UUID, recorded as the actor for work PalCert does on its own. */
export const SYSTEM_ACTOR = '00000000-0000-0000-0000-000000000000';

// ---------------------------------------------------------------------------
// The public token's envelope
// ---------------------------------------------------------------------------

/**
 * The key that seals an attestation's public token.
 *
 * Derived from the certificate verification key with HKDF and a label of its
 * own, rather than a new secret an operator would have to provision: the two
 * protect the same kind of thing (a public verification capability) with the
 * same custody, and a separate derivation means neither envelope can be
 * opened as the other. PostgreSQL never holds it, so a database read alone
 * yields no working link.
 */
export function attestationTokenKey(certificateVerificationKey: Buffer): Buffer {
  return Buffer.from(
    hkdfSync(
      'sha256',
      certificateVerificationKey,
      Buffer.from('palcert', 'utf8'),
      Buffer.from('attestation-public-token:v1', 'utf8'),
      32,
    ),
  );
}

const ENVELOPE_VERSION = 1;

export function sealAttestationToken(token: string, key: Buffer): string {
  return JSON.stringify({ v: ENVELOPE_VERSION, ...sealSecret(token, key) });
}

export function openAttestationToken(sealed: string, key: Buffer): string | null {
  try {
    const envelope = JSON.parse(sealed) as {
      v?: unknown;
      ciphertext?: unknown;
      iv?: unknown;
      authTag?: unknown;
    };
    if (
      envelope.v !== ENVELOPE_VERSION ||
      typeof envelope.ciphertext !== 'string' ||
      typeof envelope.iv !== 'string' ||
      typeof envelope.authTag !== 'string'
    ) {
      return null;
    }
    return openSecret(
      { ciphertext: envelope.ciphertext, iv: envelope.iv, authTag: envelope.authTag },
      key,
    );
  } catch {
    return null;
  }
}

export function verificationUrlFor(publicWebUrl: string, token: string): string {
  return `${publicWebUrl.replace(/\/+$/, '')}/verify/attestation/${token}`;
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export function requestNotFound(): AppError {
  return new AppError(PalCertErrorCode.ATTESTATION_REQUEST_NOT_FOUND, {
    message: 'No such attestation request.',
  });
}

export function transitionInvalid(status: AttestationRequestStatus, action: string): AppError {
  return new AppError(PalCertErrorCode.ATTESTATION_TRANSITION_INVALID, {
    message: `A request that is ${status} cannot be ${action}.`,
    details: { status, action },
  });
}

export function storageUnavailable(cause: unknown): AppError {
  return new AppError(PalCertErrorCode.SERVICE_UNAVAILABLE, {
    message: 'Storage is temporarily unavailable. Please try again.',
    cause,
  });
}

// ---------------------------------------------------------------------------
// Row shapes and mapping
// ---------------------------------------------------------------------------

export type RequestRow = AttestationRequest & {
  artifacts?: AttestationArtifact[];
  events?: AttestationRequestEvent[];
  attestation?: Attestation | null;
};

export function isoDate(value: Date | null): string | null {
  return value === null ? null : value.toISOString().slice(0, 10);
}

export function parseIsoDate(value: string | null | undefined): Date | null {
  if (value === null || value === undefined || value === '') return null;
  return new Date(`${value}T00:00:00.000Z`);
}

export function submittedMetadata(row: AttestationRequest): AttestationSubmittedMetadata {
  return {
    certificateTitle: row.certificateTitle,
    certificateType: row.certificateType,
    issuingOrganization: row.issuingOrganization,
    issueDate: isoDate(row.issueDate),
    referenceNumber: row.referenceNumber,
    recipientName: row.recipientName,
    description: row.description,
  };
}

export function artifactView(
  row: AttestationArtifact | null | undefined,
): AttestationArtifactView | null {
  if (row === null || row === undefined) return null;
  return {
    id: row.id,
    status: row.status,
    originalFilename: row.originalFilename,
    detectedFormat: (row.detectedFormat as AttestationArtifactFormat | null) ?? null,
    detectedMimeType: row.detectedMimeType,
    sizeBytes: row.sizeBytes,
    sha256: row.sha256,
    rejectionCode: row.rejectionCode,
    createdAt: row.createdAt.toISOString(),
    readyAt: row.readyAt?.toISOString() ?? null,
  };
}

export function eventView(row: AttestationRequestEvent): AttestationRequestEventView {
  return {
    id: row.id,
    eventType: row.eventType,
    actorSide: row.actorSide,
    fromStatus: row.fromStatus,
    toStatus: row.toStatus,
    message: row.message,
    createdAt: row.createdAt.toISOString(),
  };
}

export function confirmedView(row: Attestation): AttestationConfirmedMetadataView {
  return {
    certificateTitle: row.certificateTitle,
    certificateType: row.certificateType,
    holderName: row.holderName,
    issuingOrganization: row.issuingOrganization,
    issueDate: isoDate(row.issueDate),
    referenceNumber: row.referenceNumber,
    holderNamePublic: row.holderNamePublic,
    referenceNumberPublic: row.referenceNumberPublic,
  };
}

export function recordView(
  row: Attestation,
  params: { readonly now: Date; readonly verificationUrl: string | null },
): AttestationRecordView {
  return {
    id: row.id,
    reference: row.reference,
    verificationStatus: attestationVerificationStatus({
      revokedAt: row.revokedAt,
      validUntil: row.validUntil,
      now: params.now,
    }),
    organizationName: row.organizationName,
    attestationTypeName: { en: row.typeNameEn, ar: row.typeNameAr },
    confirmed: confirmedView(row),
    artifactSha256: row.artifactSha256,
    artifactSizeBytes: row.artifactSizeBytes,
    artifactMimeType: row.artifactMimeType,
    attestationHash: row.attestationHash,
    validFrom: row.validFrom.toISOString(),
    validUntil: row.validUntil?.toISOString() ?? null,
    approvedAt: row.approvedAt.toISOString(),
    revokedAt: row.revokedAt?.toISOString() ?? null,
    revocationReason: row.revocationReason,
    institutionNote: row.institutionNote,
    verificationUrl: params.verificationUrl,
    previousAttestationId: row.previousAttestationId,
  };
}

/** The fee as the owner sees it: the snapshot once priced, the live fee before. */
export function ownerFee(
  row: AttestationRequest,
  liveFee: { readonly currency: string; readonly feeMinor: bigint } | null,
): MoneyView {
  if (row.grossFeeMinor !== null && row.currency !== null) {
    return money(row.currency, row.grossFeeMinor);
  }
  if (liveFee !== null) return money(liveFee.currency, liveFee.feeMinor);
  return money('USD', 0n);
}

export function feeSnapshotView(row: AttestationRequest): AttestationFeeSnapshotView {
  const currency = row.currency ?? 'USD';
  const bps = row.platformCommissionBps ?? 0;
  return {
    gross: money(currency, row.grossFeeMinor ?? 0n),
    platformFee: money(currency, row.platformFeeMinor ?? 0n),
    institutionNet: money(currency, row.institutionNetMinor ?? 0n),
    platformCommissionPercent: formatCommissionPercent(bps),
    institutionSharePercent: formatCommissionPercent(10_000 - bps),
    pricedAt: row.pricedAt?.toISOString() ?? null,
    paymentStatus: row.paymentStatus as AttestationPaymentStatus,
  };
}

export function currentArtifact(row: RequestRow): AttestationArtifact | null {
  if (row.currentArtifactId === null) return null;
  return row.artifacts?.find((artifact) => artifact.id === row.currentArtifactId) ?? null;
}

export function ownerRequestView(
  row: RequestRow,
  params: {
    readonly now: Date;
    readonly verificationUrl: string | null;
    readonly liveFee: { readonly currency: string; readonly feeMinor: bigint } | null;
  },
): AttestationRequestOwnerView {
  const status = row.status as AttestationRequestStatus;
  const artifact = currentArtifact(row);
  return {
    id: row.id,
    status,
    organizationId: row.organizationId,
    organizationName: row.organizationName,
    attestationTypeId: row.attestationTypeId,
    attestationTypeName: { en: row.typeNameEn, ar: row.typeNameAr },
    submitted: submittedMetadata(row),
    notesForReviewer: row.notesForReviewer,
    artifact: artifactView(artifact),
    previousAttestationId: row.previousAttestationId,
    createdAt: row.createdAt.toISOString(),
    submittedAt: row.submittedAt?.toISOString() ?? null,
    reviewStartedAt: row.reviewStartedAt?.toISOString() ?? null,
    decidedAt: row.decidedAt?.toISOString() ?? null,
    cancelledAt: row.cancelledAt?.toISOString() ?? null,
    updatedAt: row.updatedAt.toISOString(),
    openInformationRequest: row.openInformationRequest,
    rejectionReason: row.rejectionReason,
    history: (row.events ?? []).map(eventView),
    attestation:
      row.attestation === null || row.attestation === undefined
        ? null
        : recordView(row.attestation, { now: params.now, verificationUrl: params.verificationUrl }),
    fee: {
      fee: ownerFee(row, params.liveFee),
      paymentStatus: row.paymentStatus as AttestationPaymentStatus,
    },
    canCancel: OWNER_CANCELLABLE_STATUSES.includes(status),
    canRespond: status === AttestationRequestStatus.NEEDS_INFORMATION,
    canSubmit: status === AttestationRequestStatus.DRAFT && artifact?.status === 'READY',
  };
}

export function listItemView(row: RequestRow, now: Date): AttestationRequestListItemView {
  const attestation = row.attestation ?? null;
  return {
    id: row.id,
    status: row.status as AttestationRequestStatus,
    organizationName: row.organizationName,
    attestationTypeName: { en: row.typeNameEn, ar: row.typeNameAr },
    certificateTitle: row.certificateTitle,
    fee: ownerFee(row, null),
    paymentStatus: row.paymentStatus as AttestationPaymentStatus,
    submittedAt: row.submittedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    verificationStatus:
      attestation === null
        ? null
        : attestationVerificationStatus({
            revokedAt: attestation.revokedAt,
            validUntil: attestation.validUntil,
            now,
          }),
    validUntil: attestation?.validUntil?.toISOString() ?? null,
    attestationId: attestation?.id ?? null,
    reference: attestation?.reference ?? null,
  };
}

/** Trimmed text, or null for blank. Never silently truncated: DTOs bound length. */
export function cleanText(value: string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  const trimmed = value.normalize('NFC').trim();
  return trimmed.length === 0 ? null : trimmed;
}

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
