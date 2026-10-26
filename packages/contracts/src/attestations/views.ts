import type { MoneyView } from '../finance/money.js';
import type {
  AttestationActorSide,
  AttestationArtifactFormat,
  AttestationArtifactStatus,
  AttestationMetadataField,
  AttestationPaymentStatus,
  AttestationRequestEventType,
  AttestationRequestStatus,
  AttestationSubmittedMetadata,
  AttestationVerificationStatus,
} from './attestation.js';

/**
 * The shapes each audience receives.
 *
 * Separate interfaces on purpose, not one shape with fields hidden by the UI:
 * a verifier's view has no user id, no email, no storage key, no reviewer and
 * no money, and the way to guarantee that is for those fields not to exist on
 * the type the public route returns.
 */

// ---------------------------------------------------------------------------
// Catalogue (what a user chooses from)
// ---------------------------------------------------------------------------

export interface AttestationCatalogueOrganizationView {
  readonly id: string;
  readonly displayName: string;
  readonly slug: string;
  readonly verified: boolean;
  readonly typeCount: number;
}

export interface AttestationTypePublicView {
  readonly id: string;
  readonly organizationId: string;
  readonly nameEn: string;
  readonly nameAr: string;
  readonly descriptionEn: string | null;
  readonly descriptionAr: string | null;
  readonly instructionsEn: string | null;
  readonly instructionsAr: string | null;
  readonly fee: MoneyView;
  readonly defaultValidityDays: number | null;
  readonly requiredFields: readonly AttestationMetadataField[];
  readonly allowedFormats: readonly AttestationArtifactFormat[];
  readonly maxFileBytes: number;
}

/** The institution's own view of a type it configures. */
export interface AttestationTypeView extends AttestationTypePublicView {
  readonly enabled: boolean;
  readonly allowNoExpiry: boolean;
  readonly reviewerMayOverrideValidity: boolean;
  readonly reminderDays: readonly number[];
  readonly createdAt: string;
  readonly updatedAt: string;
}

// ---------------------------------------------------------------------------
// Artifacts
// ---------------------------------------------------------------------------

export interface AttestationArtifactView {
  readonly id: string;
  readonly status: AttestationArtifactStatus;
  readonly originalFilename: string;
  readonly detectedFormat: AttestationArtifactFormat | null;
  readonly detectedMimeType: string | null;
  readonly sizeBytes: number | null;
  /** Present once PalCert has measured the exact bytes. */
  readonly sha256: string | null;
  readonly rejectionCode: string | null;
  readonly createdAt: string;
  readonly readyAt: string | null;
}

export interface AttestationUploadAuthorizationView {
  readonly method: 'PUT';
  readonly url: string;
  readonly headers: Record<string, string>;
  readonly expiresAt: string;
}

export interface CreateAttestationArtifactResponse {
  readonly artifact: AttestationArtifactView;
  readonly upload: AttestationUploadAuthorizationView;
}

// ---------------------------------------------------------------------------
// Money
// ---------------------------------------------------------------------------

/** What the user is told about the money. No split: that is not theirs to see. */
export interface AttestationOwnerFeeView {
  readonly fee: MoneyView;
  readonly paymentStatus: AttestationPaymentStatus;
}

/** What the institution and PalCert finance see. */
export interface AttestationFeeSnapshotView {
  readonly gross: MoneyView;
  readonly platformFee: MoneyView;
  readonly institutionNet: MoneyView;
  /** e.g. `"15.00"` */
  readonly platformCommissionPercent: string;
  readonly institutionSharePercent: string;
  readonly pricedAt: string | null;
  readonly paymentStatus: AttestationPaymentStatus;
}

export interface AttestationQuoteView {
  readonly attestationTypeId: string;
  readonly fee: MoneyView;
  /** What the user can spend right now, in the fee's currency. */
  readonly availableBalance: MoneyView;
  readonly sufficient: boolean;
  readonly shortfall: MoneyView;
}

// ---------------------------------------------------------------------------
// Request history
// ---------------------------------------------------------------------------

export interface AttestationRequestEventView {
  readonly id: string;
  readonly eventType: AttestationRequestEventType;
  readonly actorSide: AttestationActorSide;
  readonly fromStatus: AttestationRequestStatus | null;
  readonly toStatus: AttestationRequestStatus | null;
  /** The reviewer's question, the user's answer, or a reason. Never money. */
  readonly message: string | null;
  readonly createdAt: string;
}

// ---------------------------------------------------------------------------
// The attestation record
// ---------------------------------------------------------------------------

export interface AttestationConfirmedMetadataView {
  readonly certificateTitle: string;
  readonly certificateType: string | null;
  readonly holderName: string | null;
  readonly issuingOrganization: string | null;
  readonly issueDate: string | null;
  readonly referenceNumber: string | null;
  readonly holderNamePublic: boolean;
  readonly referenceNumberPublic: boolean;
}

/** For the owner and the institution. Carries the verification link. */
export interface AttestationRecordView {
  readonly id: string;
  readonly reference: string;
  readonly verificationStatus: AttestationVerificationStatus;
  readonly organizationName: string;
  readonly attestationTypeName: { readonly en: string; readonly ar: string };
  readonly confirmed: AttestationConfirmedMetadataView;
  readonly artifactSha256: string;
  readonly artifactSizeBytes: number;
  readonly artifactMimeType: string;
  readonly attestationHash: string;
  readonly validFrom: string;
  readonly validUntil: string | null;
  readonly approvedAt: string;
  readonly revokedAt: string | null;
  readonly revocationReason: string | null;
  readonly institutionNote: string | null;
  /** The public URL the QR encodes. Null only if it cannot be recovered. */
  readonly verificationUrl: string | null;
  readonly previousAttestationId: string | null;
}

// ---------------------------------------------------------------------------
// Requests
// ---------------------------------------------------------------------------

interface AttestationRequestBase {
  readonly id: string;
  readonly status: AttestationRequestStatus;
  readonly organizationId: string;
  readonly organizationName: string;
  readonly attestationTypeId: string;
  readonly attestationTypeName: { readonly en: string; readonly ar: string };
  readonly submitted: AttestationSubmittedMetadata;
  readonly notesForReviewer: string | null;
  readonly artifact: AttestationArtifactView | null;
  readonly previousAttestationId: string | null;
  readonly createdAt: string;
  readonly submittedAt: string | null;
  readonly reviewStartedAt: string | null;
  readonly decidedAt: string | null;
  readonly cancelledAt: string | null;
  readonly updatedAt: string;
  /** The latest open question from the institution, if one is waiting. */
  readonly openInformationRequest: string | null;
  readonly rejectionReason: string | null;
  readonly history: readonly AttestationRequestEventView[];
  readonly attestation: AttestationRecordView | null;
}

export interface AttestationRequestOwnerView extends AttestationRequestBase {
  readonly fee: AttestationOwnerFeeView;
  readonly canCancel: boolean;
  readonly canRespond: boolean;
  readonly canSubmit: boolean;
}

export interface AttestationRequestListItemView {
  readonly id: string;
  readonly status: AttestationRequestStatus;
  readonly organizationName: string;
  readonly attestationTypeName: { readonly en: string; readonly ar: string };
  readonly certificateTitle: string;
  readonly fee: MoneyView;
  readonly paymentStatus: AttestationPaymentStatus;
  readonly submittedAt: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly verificationStatus: AttestationVerificationStatus | null;
  readonly validUntil: string | null;
  readonly attestationId: string | null;
  readonly reference: string | null;
}

export interface AttestationRequestSummaryView {
  readonly valid: number;
  readonly expiringSoon: number;
  readonly pendingReview: number;
  readonly needsInformation: number;
  readonly expired: number;
  readonly rejected: number;
}

/** The institution's view of one case. */
export interface AttestationRequestReviewView extends AttestationRequestBase {
  readonly owner: { readonly displayName: string; readonly email: string };
  readonly feeSnapshot: AttestationFeeSnapshotView;
  readonly assignedReviewer: { readonly userId: string; readonly displayName: string } | null;
  /**
   * Earlier requests *to this organization* carrying the same file bytes.
   * Never another organization's: whether some other institution has seen a
   * file is not this one's business.
   */
  readonly sameArtifactRequests: readonly {
    readonly id: string;
    readonly status: AttestationRequestStatus;
    readonly submittedAt: string | null;
  }[];
  readonly typePolicy: {
    readonly defaultValidityDays: number | null;
    readonly allowNoExpiry: boolean;
    readonly reviewerMayOverrideValidity: boolean;
  };
}

export interface AttestationQueueEntryView {
  readonly id: string;
  readonly status: AttestationRequestStatus;
  readonly ownerDisplayName: string;
  readonly certificateTitle: string;
  readonly attestationTypeId: string;
  readonly attestationTypeName: { readonly en: string; readonly ar: string };
  readonly fee: MoneyView;
  readonly paymentStatus: AttestationPaymentStatus;
  readonly assignedReviewerName: string | null;
  readonly submittedAt: string | null;
  readonly updatedAt: string;
  readonly verificationStatus: AttestationVerificationStatus | null;
  readonly validUntil: string | null;
  readonly reference: string | null;
  readonly duplicateArtifact: boolean;
}

export interface AttestationQueueCountsView {
  readonly pending: number;
  readonly inReview: number;
  readonly awaitingInformation: number;
  readonly approved: number;
  readonly rejected: number;
  readonly revoked: number;
  readonly expired: number;
}

export interface OrganizationAttestationDashboardView {
  readonly pendingReview: number;
  readonly needsAttention: number;
  readonly approvedThisMonth: number;
  readonly rejectedThisMonth: number;
  readonly expiringSoon: number;
  /** Absent unless the caller may read attestation finance. */
  readonly revenueThisMonth:
    | readonly {
        readonly gross: MoneyView;
        readonly institutionNet: MoneyView;
      }[]
    | null;
}

// ---------------------------------------------------------------------------
// Public verification
// ---------------------------------------------------------------------------

/**
 * Everything a verifier may learn. No user id, no email, no storage key, no
 * reviewer, no money, no private note — the fields do not exist here.
 */
export interface PublicAttestationView {
  readonly verifiedBy: 'PalCert';
  readonly reference: string;
  readonly verificationStatus: AttestationVerificationStatus;
  readonly organization: {
    readonly name: string;
    /** The organization's verification by PalCert, as it stands now. */
    readonly verified: boolean;
  };
  readonly attestationType: { readonly en: string; readonly ar: string };
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
  readonly attestedAt: string;
  readonly revokedAt: string | null;
  readonly artifactSha256: string;
  readonly artifactMimeType: string;
  readonly attestationHash: string;
}

export interface PublicAttestationFileMatchView {
  readonly matched: boolean;
  /** VALID attestations of exactly these bytes. Public fields only. */
  readonly attestations: readonly PublicAttestationView[];
}

// ---------------------------------------------------------------------------
// Receipts and finance
// ---------------------------------------------------------------------------

export interface AttestationReceiptView {
  readonly requestId: string;
  readonly attestationReference: string | null;
  readonly institution: string;
  readonly attestationType: { readonly en: string; readonly ar: string };
  readonly grossFee: MoneyView;
  readonly paymentStatus: AttestationPaymentStatus;
  readonly paidAt: string | null;
  /** The ledger entry that charged the balance. */
  readonly paymentTransactionReference: string | null;
}

export interface AttestationSettlementLineView {
  readonly requestId: string;
  readonly attestationReference: string | null;
  readonly attestationTypeName: { readonly en: string; readonly ar: string };
  readonly ownerDisplayName: string;
  readonly status: AttestationRequestStatus;
  readonly paymentStatus: AttestationPaymentStatus;
  readonly gross: MoneyView;
  readonly platformFee: MoneyView;
  readonly institutionNet: MoneyView;
  readonly platformCommissionPercent: string;
  readonly submittedAt: string | null;
  readonly settledAt: string | null;
  readonly releasedAt: string | null;
  readonly transactionReference: string | null;
}

export interface AttestationRevenueTotalsView {
  readonly currency: string;
  readonly gross: MoneyView;
  readonly platformFee: MoneyView;
  readonly institutionNet: MoneyView;
  readonly pendingReserved: MoneyView;
  readonly settled: MoneyView;
  readonly released: MoneyView;
}

export interface OrganizationAttestationRevenueView {
  readonly totals: readonly AttestationRevenueTotalsView[];
  readonly lines: readonly AttestationSettlementLineView[];
  readonly nextCursor: string | null;
}

export interface AttestationCommissionView {
  readonly organizationId: string;
  readonly currentPercent: string;
  readonly currentEffectiveFrom: string | null;
  readonly isDefault: boolean;
  readonly history: readonly {
    readonly id: string;
    readonly percent: string;
    readonly effectiveFrom: string;
    readonly changedByUserId: string;
    readonly changedByName: string | null;
    readonly changeReason: string;
    readonly createdAt: string;
  }[];
}

export interface PlatformAttestationFinanceRowView {
  readonly organizationId: string;
  readonly organizationName: string;
  readonly currency: string;
  readonly currentCommissionPercent: string;
  readonly gross: MoneyView;
  readonly platformRevenue: MoneyView;
  readonly institutionNet: MoneyView;
  readonly approved: number;
  readonly rejected: number;
  readonly pending: number;
}

export interface PlatformAttestationOverviewView {
  readonly requests: number;
  readonly approvals: number;
  readonly rejections: number;
  readonly valid: number;
  readonly expired: number;
  readonly revoked: number;
  readonly byCurrency: readonly {
    readonly currency: string;
    readonly gross: MoneyView;
    readonly platformCommission: MoneyView;
    readonly organizationNet: MoneyView;
  }[];
  readonly organizations: readonly PlatformAttestationFinanceRowView[];
}
