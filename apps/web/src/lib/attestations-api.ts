import type {
  AttestationCatalogueOrganizationView,
  AttestationCommissionView,
  AttestationQueueCountsView,
  AttestationQueueEntryView,
  AttestationQuoteView,
  AttestationReceiptView,
  AttestationRequestListItemView,
  AttestationRequestOwnerView,
  AttestationRequestReviewView,
  AttestationRequestStatus,
  AttestationRequestSummaryView,
  AttestationTypePublicView,
  AttestationTypeView,
  AttestationUploadAuthorizationView,
  CreateAttestationArtifactResponse,
  OrganizationAttestationDashboardView,
  OrganizationAttestationRevenueView,
  Page,
  PlatformAttestationOverviewView,
  PublicAttestationFileMatchView,
  PublicAttestationView,
} from '@palcert/contracts';
import { ApiError, apiRequest, apiUrl, type DownloadAuthorizationResponse } from './api-client';

/**
 * Certificate attestation, as the browser calls it.
 *
 * Four audiences, four groups, and each returns the view its audience is
 * allowed: the owner never receives the fee split, the institution never
 * receives the public token's hash, and the public page receives neither a
 * user nor a file.
 */

export interface AttestationMetadataInput {
  readonly certificateTitle?: string;
  readonly certificateType?: string | null;
  readonly issuingOrganization?: string | null;
  readonly issueDate?: string | null;
  readonly referenceNumber?: string | null;
  readonly recipientName?: string | null;
  readonly description?: string | null;
  readonly notesForReviewer?: string | null;
}

export interface ApproveAttestationInput {
  readonly confirm: boolean;
  readonly certificateTitle: string;
  readonly certificateType?: string | null;
  readonly holderName?: string | null;
  readonly issuingOrganization?: string | null;
  readonly issueDate?: string | null;
  readonly referenceNumber?: string | null;
  readonly holderNamePublic?: boolean;
  readonly referenceNumberPublic?: boolean;
  readonly institutionNote?: string | null;
  readonly validFrom?: string | null;
  readonly validUntil?: string | null;
  readonly validityDays?: number | null;
  readonly noExpiry?: boolean;
}

export interface AttestationTypeInput {
  readonly nameEn?: string;
  readonly nameAr?: string;
  readonly descriptionEn?: string | null;
  readonly descriptionAr?: string | null;
  readonly instructionsEn?: string | null;
  readonly instructionsAr?: string | null;
  readonly enabled?: boolean;
  readonly currency?: string;
  readonly feeMinorUnits?: string;
  readonly defaultValidityDays?: number | null;
  readonly allowNoExpiry?: boolean;
  readonly reviewerMayOverrideValidity?: boolean;
  readonly requiredFields?: readonly string[];
  readonly allowedFormats?: readonly string[];
  readonly maxFileBytes?: number;
  readonly reminderDays?: readonly number[];
}

export interface AttestationQueueQuery {
  readonly status?: string;
  readonly attestationTypeId?: string;
  readonly search?: string;
  readonly paymentStatus?: string;
  readonly validity?: string;
  readonly sort?: 'submittedAt' | 'updatedAt';
  readonly order?: 'asc' | 'desc';
  readonly cursor?: string;
  readonly limit?: number;
}

export interface AttestationRevenueQuery {
  readonly from?: string;
  readonly to?: string;
  readonly attestationTypeId?: string;
  readonly paymentStatus?: string;
  readonly search?: string;
  readonly cursor?: string;
  readonly limit?: number;
}

function query(params: object): string {
  const entries = Object.entries(params).filter(
    ([, value]) => value !== undefined && value !== null && value !== '',
  );
  if (entries.length === 0) return '';
  return `?${new URLSearchParams(entries.map(([key, value]) => [key, String(value)])).toString()}`;
}

const idempotent = (key: string) => ({ 'Idempotency-Key': key });

/** Fetch a non-JSON resource (a QR code) as a Blob, with the session. */
export async function fetchBlob(path: string): Promise<Blob> {
  let response: Response;
  try {
    response = await fetch(apiUrl(path), { credentials: 'include' });
  } catch {
    throw new ApiError('NETWORK_ERROR', 'The server could not be reached.', 0);
  }
  if (!response.ok) {
    const body = (await response.json().catch(() => undefined)) as
      { error?: { code?: string; message?: string } } | undefined;
    throw new ApiError(
      body?.error?.code ?? 'INTERNAL_ERROR',
      body?.error?.message ?? 'Request failed',
      response.status,
    );
  }
  return response.blob();
}

// ---------------------------------------------------------------------------
// The user who holds the certificate
// ---------------------------------------------------------------------------

const OWNER = '/attestation-requests';

export const attestationsApi = {
  catalogue: () =>
    apiRequest<AttestationCatalogueOrganizationView[]>('/attestation-catalogue/organizations'),

  catalogueTypes: (organizationId: string) =>
    apiRequest<AttestationTypePublicView[]>(
      `/attestation-catalogue/organizations/${organizationId}/types`,
    ),

  list: (status?: AttestationRequestStatus) =>
    apiRequest<AttestationRequestListItemView[]>(`${OWNER}${query({ status })}`),

  summary: () => apiRequest<AttestationRequestSummaryView>(`${OWNER}/summary`),

  get: (requestId: string) => apiRequest<AttestationRequestOwnerView>(`${OWNER}/${requestId}`),

  create: (
    input: AttestationMetadataInput & {
      readonly attestationTypeId: string;
      readonly previousAttestationId?: string | null;
    },
    idempotencyKey: string,
  ) =>
    apiRequest<AttestationRequestOwnerView>(OWNER, {
      method: 'POST',
      body: input,
      headers: idempotent(idempotencyKey),
    }),

  update: (requestId: string, input: AttestationMetadataInput) =>
    apiRequest<AttestationRequestOwnerView>(`${OWNER}/${requestId}`, {
      method: 'PATCH',
      body: input,
    }),

  quote: (requestId: string) => apiRequest<AttestationQuoteView>(`${OWNER}/${requestId}/quote`),

  submit: (requestId: string) =>
    apiRequest<AttestationRequestOwnerView>(`${OWNER}/${requestId}/submit`, {
      method: 'POST',
      body: {},
    }),

  cancel: (requestId: string) =>
    apiRequest<AttestationRequestOwnerView>(`${OWNER}/${requestId}/cancel`, {
      method: 'POST',
      body: {},
    }),

  respond: (requestId: string, message: string, metadata?: AttestationMetadataInput) =>
    apiRequest<AttestationRequestOwnerView>(`${OWNER}/${requestId}/respond`, {
      method: 'POST',
      body: { message, ...(metadata === undefined ? {} : { metadata }) },
    }),

  receipt: (requestId: string) =>
    apiRequest<AttestationReceiptView>(`${OWNER}/${requestId}/receipt`),

  qrPath: (requestId: string, format: 'png' | 'svg') => `${OWNER}/${requestId}/qr?format=${format}`,

  createArtifact: (
    requestId: string,
    input: {
      readonly originalFilename: string;
      readonly sizeBytes: number;
      readonly declaredMimeType?: string;
    },
    idempotencyKey: string,
  ) =>
    apiRequest<CreateAttestationArtifactResponse>(`${OWNER}/${requestId}/artifacts`, {
      method: 'POST',
      body: input,
      headers: idempotent(idempotencyKey),
    }),

  finalizeArtifact: (requestId: string, artifactId: string) =>
    apiRequest<CreateAttestationArtifactResponse['artifact']>(
      `${OWNER}/${requestId}/artifacts/${artifactId}/finalize`,
      { method: 'POST', body: {} },
    ),

  reauthorizeUpload: (requestId: string, artifactId: string) =>
    apiRequest<AttestationUploadAuthorizationView>(
      `${OWNER}/${requestId}/artifacts/${artifactId}/upload-authorization`,
      { method: 'POST', body: {} },
    ),

  downloadArtifact: (requestId: string) =>
    apiRequest<DownloadAuthorizationResponse>(`${OWNER}/${requestId}/artifact/download`),
};

// ---------------------------------------------------------------------------
// The institution
// ---------------------------------------------------------------------------

const org = (organizationId: string) => `/organizations/${organizationId}`;

export const attestationReviewApi = {
  queue: (organizationId: string, params: AttestationQueueQuery = {}) =>
    apiRequest<Page<AttestationQueueEntryView>>(
      `${org(organizationId)}/attestation-requests${query(params)}`,
    ),

  counts: (organizationId: string) =>
    apiRequest<AttestationQueueCountsView>(`${org(organizationId)}/attestation-requests/counts`),

  dashboard: (organizationId: string) =>
    apiRequest<OrganizationAttestationDashboardView>(
      `${org(organizationId)}/attestation-dashboard`,
    ),

  get: (organizationId: string, requestId: string) =>
    apiRequest<AttestationRequestReviewView>(
      `${org(organizationId)}/attestation-requests/${requestId}`,
    ),

  artifact: (organizationId: string, requestId: string, disposition: 'inline' | 'attachment') =>
    apiRequest<DownloadAuthorizationResponse>(
      `${org(organizationId)}/attestation-requests/${requestId}/artifact?disposition=${disposition}`,
    ),

  startReview: (organizationId: string, requestId: string) =>
    apiRequest<AttestationRequestReviewView>(
      `${org(organizationId)}/attestation-requests/${requestId}/start-review`,
      { method: 'POST', body: {} },
    ),

  assign: (organizationId: string, requestId: string, reviewerUserId: string | null) =>
    apiRequest<AttestationRequestReviewView>(
      `${org(organizationId)}/attestation-requests/${requestId}/assign`,
      { method: 'POST', body: { reviewerUserId } },
    ),

  requestInformation: (organizationId: string, requestId: string, message: string) =>
    apiRequest<AttestationRequestReviewView>(
      `${org(organizationId)}/attestation-requests/${requestId}/request-information`,
      { method: 'POST', body: { message } },
    ),

  reject: (organizationId: string, requestId: string, reason: string) =>
    apiRequest<AttestationRequestReviewView>(
      `${org(organizationId)}/attestation-requests/${requestId}/reject`,
      { method: 'POST', body: { reason } },
    ),

  approve: (organizationId: string, requestId: string, input: ApproveAttestationInput) =>
    apiRequest<AttestationRequestReviewView>(
      `${org(organizationId)}/attestation-requests/${requestId}/approve`,
      { method: 'POST', body: input },
    ),

  revoke: (organizationId: string, attestationId: string, reason: string) =>
    apiRequest<AttestationRequestReviewView>(
      `${org(organizationId)}/attestations/${attestationId}/revoke`,
      { method: 'POST', body: { reason } },
    ),

  qrPath: (organizationId: string, attestationId: string, format: 'png' | 'svg') =>
    `${org(organizationId)}/attestations/${attestationId}/qr?format=${format}`,

  types: (organizationId: string) =>
    apiRequest<AttestationTypeView[]>(`${org(organizationId)}/attestation-types`),

  type: (organizationId: string, typeId: string) =>
    apiRequest<AttestationTypeView>(`${org(organizationId)}/attestation-types/${typeId}`),

  createType: (organizationId: string, input: AttestationTypeInput) =>
    apiRequest<AttestationTypeView>(`${org(organizationId)}/attestation-types`, {
      method: 'POST',
      body: input,
    }),

  updateType: (organizationId: string, typeId: string, input: AttestationTypeInput) =>
    apiRequest<AttestationTypeView>(`${org(organizationId)}/attestation-types/${typeId}`, {
      method: 'PATCH',
      body: input,
    }),

  setFee: (organizationId: string, typeId: string, currency: string, feeMinorUnits: string) =>
    apiRequest<AttestationTypeView>(`${org(organizationId)}/attestation-types/${typeId}/fee`, {
      method: 'PUT',
      body: { currency, feeMinorUnits },
    }),

  revenue: (organizationId: string, params: AttestationRevenueQuery = {}) =>
    apiRequest<OrganizationAttestationRevenueView>(
      `${org(organizationId)}/attestation-revenue${query(params)}`,
    ),
};

// ---------------------------------------------------------------------------
// PalCert staff
// ---------------------------------------------------------------------------

export const attestationAdminApi = {
  commission: (organizationId: string) =>
    apiRequest<AttestationCommissionView>(
      `/admin/organizations/${organizationId}/attestation-commission`,
    ),

  setCommission: (
    organizationId: string,
    input: {
      readonly percent: string;
      readonly reason: string;
      readonly effectiveFrom?: string | null;
    },
  ) =>
    apiRequest<AttestationCommissionView>(
      `/admin/organizations/${organizationId}/attestation-commission`,
      { method: 'PUT', body: input },
    ),

  overview: (
    params: { readonly from?: string; readonly to?: string; readonly organizationId?: string } = {},
  ) => apiRequest<PlatformAttestationOverviewView>(`/admin/attestations/finance${query(params)}`),

  organizationRevenue: (organizationId: string, params: AttestationRevenueQuery = {}) =>
    apiRequest<OrganizationAttestationRevenueView>(
      `/admin/organizations/${organizationId}/attestation-revenue${query(params)}`,
    ),
};

// ---------------------------------------------------------------------------
// Anyone
// ---------------------------------------------------------------------------

export const publicAttestationsApi = {
  verify: (token: string) =>
    apiRequest<PublicAttestationView>(`/public/attestations/${encodeURIComponent(token)}`),

  /** The browser hashes the file; only the digest is sent. */
  verifyDigest: (sha256: string) =>
    apiRequest<PublicAttestationFileMatchView>('/public/attestations/verify-file', {
      method: 'POST',
      body: { sha256 },
    }),
};

/** SHA-256 of a file, computed in the browser. The file never leaves the device. */
export async function sha256OfFile(file: Blob): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', await file.arrayBuffer());
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}
