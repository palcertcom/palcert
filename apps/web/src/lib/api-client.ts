'use client';

import type {
  SmartFixAIPlanning,
  StandardImportPreviewView,
  StandardImportProvenanceView,
  StandardImportResultView,
} from '@palcert/contracts';

/**
 * Browser API client.
 *
 * Two things it must always do:
 *
 *  - `credentials: 'include'`, because authentication is a cookie, never a
 *    token held in JavaScript.
 *  - echo the CSRF cookie into the `x-csrf-token` header on unsafe requests,
 *    which is the half of the double-submit check an attacker cannot forge.
 */
/**
 * Where the browser sends API requests.
 *
 * **Empty means same-origin, and that is the production answer.** The release
 * topology serves the API under `/api/` on the same host as the web app, which
 * is why the session cookie is first-party and why the CSRF origin check has
 * something meaningful to compare against. A relative base is therefore not a
 * shortcut — it is a statement of that topology.
 *
 * It used to default to `http://localhost:4000`, and `NEXT_PUBLIC_*` values are
 * inlined into the client bundle at build time, so the published web image
 * carried that literal string: every browser API call from a deployed
 * PalCert would have gone to port 4000 on the *user's own machine*. Nothing
 * caught it, because every release check is a server-side `curl` and "`/en`
 * returns 200" is satisfied by server-rendered HTML that has not yet made a
 * single API call (Phase 20 Checkpoint 7).
 *
 * Local development still sets the variable, because there the web app is on
 * :3000 and the API on :4000 — genuinely different origins.
 */
const API_BASE = process.env.NEXT_PUBLIC_API_URL ?? '';

/** The absolute URL of an API path, for requests that are not JSON (images, files). */
export function apiUrl(path: string): string {
  return `${API_BASE}/api/v1${path}`;
}
const CSRF_COOKIE = 'palcert_csrf';
const CSRF_HEADER = 'x-csrf-token';

export interface ApiErrorBody {
  readonly error: {
    readonly code: string;
    readonly message: string;
    readonly details?: Record<string, unknown>;
    readonly requestId?: string;
  };
}

export class ApiError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: number,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

function readCsrfCookie(): string | undefined {
  if (typeof document === 'undefined') return undefined;
  const match = document.cookie
    .split(';')
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${CSRF_COOKIE}=`));
  return match === undefined ? undefined : decodeURIComponent(match.slice(CSRF_COOKIE.length + 1));
}

export interface ApiRequestOptions {
  readonly method?: string;
  readonly body?: unknown;
  /**
   * Extra request headers. Used for `If-Match` on standards edits, which is
   * required rather than optional: without it the server refuses the write
   * instead of quietly applying last-write-wins.
   */
  readonly headers?: Record<string, string>;
}

/** A response together with the headers a caller needs to act on. */
export interface ApiResponseWithMeta<T> {
  readonly data: T;
  /** The `ETag`, which for a standard version is its revision. */
  readonly etag: string | null;
}

export async function apiRequest<T>(path: string, options: ApiRequestOptions = {}): Promise<T> {
  return (await apiRequestWithMeta<T>(path, options)).data;
}

export async function apiRequestWithMeta<T>(
  path: string,
  options: ApiRequestOptions = {},
): Promise<ApiResponseWithMeta<T>> {
  const method = options.method ?? 'GET';
  const headers: Record<string, string> = { Accept: 'application/json', ...options.headers };

  if (options.body !== undefined) headers['Content-Type'] = 'application/json';

  if (method !== 'GET' && method !== 'HEAD') {
    const csrf = readCsrfCookie();
    if (csrf !== undefined) headers[CSRF_HEADER] = csrf;
  }

  let response: Response;
  try {
    response = await fetch(`${API_BASE}/api/v1${path}`, {
      method,
      headers,
      credentials: 'include',
      ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
    });
  } catch {
    throw new ApiError('NETWORK_ERROR', 'The server could not be reached.', 0);
  }

  const etag = response.headers.get('ETag');

  if (response.status === 204) return { data: undefined as T, etag };

  const payload: unknown = await response.json().catch(() => undefined);

  if (!response.ok) {
    const body = payload as ApiErrorBody | undefined;
    throw new ApiError(
      body?.error?.code ?? 'INTERNAL_ERROR',
      body?.error?.message ?? 'Request failed',
      response.status,
      body?.error?.details,
    );
  }

  return { data: payload as T, etag };
}

export interface UserProfileResponse {
  id: string;
  email: string;
  displayName: string | null;
  status: string;
  preferredLocale: string;
  emailVerified: boolean;
  mfaEnrolled: boolean;
  mfaRequired: boolean;
  roles: string[];
  permissions: string[];
  createdAt: string;
  lastLoginAt: string | null;
}

export interface SessionSummaryResponse {
  id: string;
  createdAt: string;
  lastActivityAt: string;
  absoluteExpiresAt: string;
  idleExpiresAt: string;
  assuranceLevel: string;
  ipAddress: string | null;
  userAgent: string | null;
  current: boolean;
}

export type LoginStatus = 'AUTHENTICATED' | 'MFA_REQUIRED' | 'MFA_ENROLLMENT_REQUIRED';

// --- Organizations (Phase 2) -------------------------------------------------

export interface OrganizationSummaryResponse {
  id: string;
  slug: string;
  displayName: string;
  type: string;
  status: string;
  verificationStatus: string;
  countryCode: string;
}

export interface OrganizationProfileResponse extends OrganizationSummaryResponse {
  legalName: string;
  website: string | null;
  defaultLocale: string;
  timezone: string;
  createdAt: string;
  updatedAt: string;
  memberCount: number;
}

export interface UserOrganizationResponse {
  organization: OrganizationSummaryResponse;
  membershipId: string;
  membershipStatus: string;
  roles: string[];
  joinedAt: string;
}

export interface OrganizationMemberResponse {
  membershipId: string;
  userId: string;
  email: string;
  displayName: string | null;
  status: string;
  roles: string[];
  joinedAt: string;
  suspendedAt: string | null;
}

export interface OrganizationInvitationResponse {
  id: string;
  email: string;
  roleCode: string;
  status: string;
  invitedByUserId: string;
  expiresAt: string;
  createdAt: string;
}

export interface VerificationResponse {
  status: string;
  requestedAt: string | null;
  reviewedAt: string | null;
  decisionReason: string | null;
  canRequest: boolean;
}

export interface PageResponse<T> {
  items: T[];
  nextCursor: string | null;
}

export interface CreateOrganizationInput {
  type: string;
  displayName: string;
  legalName: string;
  countryCode: string;
  timezone: string;
  slug?: string;
  website?: string;
  defaultLocale?: string;
}

function pageQuery(page: { cursor?: string; limit?: number } = {}): string {
  const params = new URLSearchParams();
  if (page.cursor !== undefined) params.set('cursor', page.cursor);
  if (page.limit !== undefined) params.set('limit', String(page.limit));
  const query = params.toString();
  return query === '' ? '' : `?${query}`;
}

export const organizationApi = {
  create: (body: CreateOrganizationInput) =>
    apiRequest<OrganizationProfileResponse>('/organizations', { method: 'POST', body }),

  mine: () => apiRequest<UserOrganizationResponse[]>('/organizations'),

  get: (organizationId: string) =>
    apiRequest<OrganizationProfileResponse>(`/organizations/${organizationId}`),

  update: (organizationId: string, body: Partial<CreateOrganizationInput>) =>
    apiRequest<OrganizationProfileResponse>(`/organizations/${organizationId}`, {
      method: 'PATCH',
      body,
    }),

  members: (organizationId: string, page?: { cursor?: string; limit?: number }) =>
    apiRequest<PageResponse<OrganizationMemberResponse>>(
      `/organizations/${organizationId}/members${pageQuery(page)}`,
    ),

  updateMember: (organizationId: string, membershipId: string, status: string) =>
    apiRequest<OrganizationMemberResponse>(
      `/organizations/${organizationId}/members/${membershipId}`,
      { method: 'PATCH', body: { status } },
    ),

  removeMember: (organizationId: string, membershipId: string) =>
    apiRequest<OrganizationMemberResponse>(
      `/organizations/${organizationId}/members/${membershipId}`,
      { method: 'DELETE', body: {} },
    ),

  assignRole: (organizationId: string, membershipId: string, roleCode: string) =>
    apiRequest<{ roles: string[] }>(
      `/organizations/${organizationId}/members/${membershipId}/roles`,
      { method: 'POST', body: { roleCode } },
    ),

  /** Needs a recent sign-in; the new owner is granted before the old one steps down. */
  transferOwnership: (organizationId: string, toMembershipId: string, stepDown: boolean) =>
    apiRequest<{ newOwnerUserId: string; previousOwnerRetainedOwnership: boolean }>(
      `/organizations/${organizationId}/ownership-transfer`,
      { method: 'POST', body: { toMembershipId, stepDown } },
    ),

  removeRole: (organizationId: string, membershipId: string, roleCode: string) =>
    apiRequest<{ roles: string[] }>(
      `/organizations/${organizationId}/members/${membershipId}/roles/${roleCode}`,
      { method: 'DELETE', body: {} },
    ),

  invitations: (organizationId: string, page?: { cursor?: string; limit?: number }) =>
    apiRequest<PageResponse<OrganizationInvitationResponse>>(
      `/organizations/${organizationId}/invitations${pageQuery(page)}`,
    ),

  invite: (organizationId: string, body: { email: string; roleCode: string }) =>
    apiRequest<OrganizationInvitationResponse>(`/organizations/${organizationId}/invitations`, {
      method: 'POST',
      body,
    }),

  revokeInvitation: (organizationId: string, invitationId: string) =>
    apiRequest<void>(`/organizations/${organizationId}/invitations/${invitationId}`, {
      method: 'DELETE',
      body: {},
    }),

  verification: (organizationId: string) =>
    apiRequest<VerificationResponse>(`/organizations/${organizationId}/verification`),

  requestVerification: (organizationId: string, note?: string) =>
    apiRequest<VerificationResponse>(`/organizations/${organizationId}/verification`, {
      method: 'POST',
      body: note === undefined ? {} : { note },
    }),

  previewInvitation: (token: string) =>
    apiRequest<{
      organizationDisplayName: string;
      roleCode: string;
      expiresAt: string;
      requiresRegistration: boolean;
    }>('/invitations/preview', { method: 'POST', body: { token } }),

  acceptInvitation: (token: string) =>
    apiRequest<{ organizationId: string; roleCode: string }>('/invitations/accept', {
      method: 'POST',
      body: { token },
    }),
};

export const authApi = {
  register: (body: { email: string; password: string; displayName?: string; locale: string }) =>
    apiRequest<{ acknowledged: boolean }>('/auth/register', { method: 'POST', body }),

  login: (body: { email: string; password: string }) =>
    apiRequest<{ status: LoginStatus }>('/auth/login', { method: 'POST', body }),

  logout: () => apiRequest<void>('/auth/logout', { method: 'POST', body: {} }),

  logoutAll: () =>
    apiRequest<{ revoked: number }>('/auth/logout-all', { method: 'POST', body: {} }),

  verifyEmail: (token: string) =>
    apiRequest<{ acknowledged: boolean }>('/auth/email/verify', {
      method: 'POST',
      body: { token },
    }),

  resendVerification: (email: string) =>
    apiRequest<{ acknowledged: boolean }>('/auth/email/resend', {
      method: 'POST',
      body: { email },
    }),

  forgotPassword: (email: string) =>
    apiRequest<{ acknowledged: boolean }>('/auth/password/forgot', {
      method: 'POST',
      body: { email },
    }),

  resetPassword: (body: { token: string; newPassword: string }) =>
    apiRequest<{ acknowledged: boolean }>('/auth/password/reset', { method: 'POST', body }),

  changePassword: (body: { currentPassword: string; newPassword: string }) =>
    apiRequest<{ acknowledged: boolean }>('/auth/password/change', { method: 'POST', body }),

  /** Needs both the password and a current code: neither alone removes the second factor. */
  disableMfa: (body: { password: string; code: string }) =>
    apiRequest<{ acknowledged: boolean }>('/auth/mfa', { method: 'DELETE', body }),

  me: () => apiRequest<UserProfileResponse>('/users/me'),

  updateMe: (body: { displayName?: string; preferredLocale?: string }) =>
    apiRequest<UserProfileResponse>('/users/me', { method: 'PATCH', body }),

  sessions: () => apiRequest<SessionSummaryResponse[]>('/auth/sessions'),

  revokeSession: (id: string) =>
    apiRequest<void>(`/auth/sessions/${id}`, { method: 'DELETE', body: {} }),

  mfaEnroll: () =>
    apiRequest<{ provisioningUri: string; qrCodeDataUrl: string; secret: string }>(
      '/auth/mfa/enroll',
      { method: 'POST', body: {} },
    ),

  mfaConfirm: (code: string) =>
    apiRequest<{ recoveryCodes: string[] }>('/auth/mfa/confirm', {
      method: 'POST',
      body: { code },
    }),

  mfaChallenge: (body: { code: string; useRecoveryCode?: boolean }) =>
    apiRequest<{ status: LoginStatus }>('/auth/mfa/challenge', { method: 'POST', body }),
};

// ---------------------------------------------------------------------------
// Standards (Phase 3)
// ---------------------------------------------------------------------------

export interface DocumentTypeResponse {
  id: string;
  systemCategory: string;
  name: string;
  nameAr: string | null;
  description: string | null;
  descriptionAr: string | null;
  status: string;
  standardCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface StandardResponse {
  id: string;
  documentTypeId: string;
  documentTypeName: string;
  documentTypeCategory: string;
  code: string;
  checkAvailability?: string;
  nameEn: string;
  nameAr: string;
  descriptionEn: string | null;
  descriptionAr: string | null;
  status: string;
  versionCount: number;
  publishedVersionId: string | null;
  publishedVersionLabel: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface StandardVersionResponse {
  id: string;
  standardId: string;
  versionLabel: string;
  status: string;
  effectiveFrom: string | null;
  effectiveUntil: string | null;
  ruleCount: number;
  contentHash: string | null;
  canonicalizationVersion: number | null;
  ruleSchemaVersion: number;
  revision: number;
  publishedAt: string | null;
  publishedByUserId: string | null;
  archivedAt: string | null;
  /** Set when publishing a newer version replaced this one; null otherwise. */
  supersededAt: string | null;
  supersededByVersionId: string | null;
  supersededByVersionLabel: string | null;
  clonedFromVersionId: string | null;
  /** Where the version was imported from, when it came from a portable package. */
  importProvenance: StandardImportProvenanceResponse | null;
  createdAt: string;
  updatedAt: string;
}

export type StandardImportProvenanceResponse = StandardImportProvenanceView;
export type StandardImportPreviewResponse = StandardImportPreviewView;
export type StandardImportResultResponse = StandardImportResultView;

export interface StandardImportRequest {
  package: string;
  packageHash: string;
  mode: 'NEW_STANDARD' | 'EXISTING_STANDARD';
  standardId?: string;
  code?: string;
  nameEn?: string;
  nameAr?: string;
  documentTypeId?: string;
  versionLabel: string;
  acknowledgeDuplicate?: boolean;
}

export interface StandardVersionUsageResponse {
  standardVersionId: string;
  submissionCount: number;
  certificateCount: number;
}

export interface RuleResponse {
  id: string;
  ruleCode: string;
  category: string;
  evaluationMode: string;
  scope: Record<string, unknown>;
  operator: string;
  expected: Record<string, unknown>;
  unit: string | null;
  tolerance: number | null;
  severity: string;
  blocking: boolean;
  autofix: string;
  origin: string;
  originReference: string | null;
  titleEn: string;
  titleAr: string;
  descriptionEn: string | null;
  descriptionAr: string | null;
  guidanceEn: string | null;
  guidanceAr: string | null;
  displayOrder: number;
  ruleSchemaVersion: number;
  createdAt: string;
  updatedAt: string;
}

export interface RuleValidationIssueResponse {
  ruleCode: string | null;
  path: string;
  code: string;
  message: string;
}

export interface StandardVersionValidationResponse {
  valid: boolean;
  ruleCount: number;
  issues: RuleValidationIssueResponse[];
}

export interface RuleSchemaResponse {
  ruleSchemaVersion: number;
  supportedRuleSchemaVersions: number[];
  blockingAnyModeFromSchemaVersion: number;
  categories: string[];
  evaluationModes: string[];
  severities: string[];
  autofixCapabilities: string[];
  origins: string[];
  units: string[];
  valueTypes: string[];
  scopeKinds: string[];
  elementTypes: string[];
  pageSelectors: string[];
  patterns: { name: string; requiresArgument: boolean }[];
  operators: {
    operator: string;
    valueTypes: string[];
    unary: boolean;
    supportsTolerance: boolean;
  }[];
  unitRequiredFor: string[];
}

export interface StandardVersionSnapshotResponse {
  standardVersionId: string;
  contentHash: string;
  canonicalizationVersion: number;
  ruleSchemaVersion: number;
  ruleCount: number;
  canonical: Record<string, unknown>;
  hashVerified: boolean;
  createdAt: string;
}

/**
 * `If-Match` is built from the version's revision on every draft mutation.
 *
 * Expressed here once rather than at each call site, so it cannot be forgotten
 * on a new endpoint — a forgotten header is a 400, not a silent overwrite, but
 * it is still a bug the user sees.
 */
function ifMatch(revision: number): { headers: Record<string, string> } {
  return { headers: { 'If-Match': `"${String(revision)}"` } };
}

export const standardsApi = {
  ruleSchema: () => apiRequest<RuleSchemaResponse>('/standards/rule-schema'),

  // --- document types ------------------------------------------------------
  documentTypes: (organizationId: string, page?: { cursor?: string; limit?: number }) =>
    apiRequest<PageResponse<DocumentTypeResponse>>(
      `/organizations/${organizationId}/document-types${pageQuery(page)}`,
    ),

  createDocumentType: (
    organizationId: string,
    body: { systemCategory: string; name: string; nameAr?: string },
  ) =>
    apiRequest<DocumentTypeResponse>(`/organizations/${organizationId}/document-types`, {
      method: 'POST',
      body,
    }),

  archiveDocumentType: (organizationId: string, documentTypeId: string) =>
    apiRequest<DocumentTypeResponse>(
      `/organizations/${organizationId}/document-types/${documentTypeId}/archive`,
      { method: 'POST', body: {} },
    ),

  restoreDocumentType: (organizationId: string, documentTypeId: string) =>
    apiRequest<DocumentTypeResponse>(
      `/organizations/${organizationId}/document-types/${documentTypeId}/restore`,
      { method: 'POST', body: {} },
    ),

  // --- standards -----------------------------------------------------------
  standards: (
    organizationId: string,
    page?: { cursor?: string; limit?: number; search?: string },
  ) => {
    const query = new URLSearchParams();
    if (page?.cursor !== undefined) query.set('cursor', page.cursor);
    if (page?.limit !== undefined) query.set('limit', String(page.limit));
    if (page?.search !== undefined && page.search !== '') query.set('search', page.search);
    const suffix = query.toString() === '' ? '' : `?${query.toString()}`;
    return apiRequest<PageResponse<StandardResponse>>(
      `/organizations/${organizationId}/standards${suffix}`,
    );
  },

  standard: (organizationId: string, standardId: string) =>
    apiRequest<StandardResponse>(`/organizations/${organizationId}/standards/${standardId}`),

  createStandard: (
    organizationId: string,
    body: { documentTypeId: string; code: string; nameEn: string; nameAr: string },
  ) =>
    apiRequest<StandardResponse>(`/organizations/${organizationId}/standards`, {
      method: 'POST',
      body,
    }),

  updateStandard: (
    organizationId: string,
    standardId: string,
    body: { nameEn?: string; nameAr?: string; descriptionEn?: string; descriptionAr?: string },
  ) =>
    apiRequest<StandardResponse>(`/organizations/${organizationId}/standards/${standardId}`, {
      method: 'PATCH',
      body,
    }),

  setCheckAvailability: (
    organizationId: string,
    standardId: string,
    checkAvailability: 'PRIVATE' | 'PUBLIC_CHECKABLE',
  ) =>
    apiRequest<StandardResponse>(
      `/organizations/${organizationId}/standards/${standardId}/check-availability`,
      { method: 'PATCH', body: { checkAvailability } },
    ),

  restoreStandard: (organizationId: string, standardId: string) =>
    apiRequest<StandardResponse>(
      `/organizations/${organizationId}/standards/${standardId}/restore`,
      { method: 'POST', body: {} },
    ),

  updateVersion: (
    organizationId: string,
    standardId: string,
    versionId: string,
    body: { versionLabel?: string; effectiveFrom?: string; effectiveUntil?: string },
  ) =>
    apiRequest<StandardVersionResponse>(
      `/organizations/${organizationId}/standards/${standardId}/versions/${versionId}`,
      { method: 'PATCH', body },
    ),

  updateDocumentType: (
    organizationId: string,
    documentTypeId: string,
    body: { name?: string; nameAr?: string; description?: string; descriptionAr?: string },
  ) =>
    apiRequest<DocumentTypeResponse>(
      `/organizations/${organizationId}/document-types/${documentTypeId}`,
      { method: 'PATCH', body },
    ),

  archiveStandard: (organizationId: string, standardId: string) =>
    apiRequest<StandardResponse>(
      `/organizations/${organizationId}/standards/${standardId}/archive`,
      { method: 'POST', body: {} },
    ),

  // --- versions ------------------------------------------------------------
  versions: (organizationId: string, standardId: string, page?: { cursor?: string }) =>
    apiRequest<PageResponse<StandardVersionResponse>>(
      `/organizations/${organizationId}/standards/${standardId}/versions${pageQuery(page)}`,
    ),

  version: (organizationId: string, standardId: string, versionId: string) =>
    apiRequest<StandardVersionResponse>(
      `/organizations/${organizationId}/standards/${standardId}/versions/${versionId}`,
    ),

  createVersion: (organizationId: string, standardId: string, versionLabel: string) =>
    apiRequest<StandardVersionResponse>(
      `/organizations/${organizationId}/standards/${standardId}/versions`,
      { method: 'POST', body: { versionLabel } },
    ),

  cloneVersion: (
    organizationId: string,
    standardId: string,
    versionId: string,
    versionLabel: string,
    upgradeRuleSchema = false,
  ) =>
    apiRequest<StandardVersionResponse>(
      `/organizations/${organizationId}/standards/${standardId}/versions/${versionId}/clone`,
      { method: 'POST', body: { versionLabel, upgradeRuleSchema } },
    ),

  /**
   * `replacesVersionId` is the version the author saw in force when they
   * confirmed (null for none). If the standard has moved on since, the server
   * refuses rather than replacing a version the author never saw.
   */
  publishVersion: (
    organizationId: string,
    standardId: string,
    versionId: string,
    replacesVersionId?: string | null,
  ) =>
    apiRequest<StandardVersionResponse>(
      `/organizations/${organizationId}/standards/${standardId}/versions/${versionId}/publish`,
      { method: 'POST', body: replacesVersionId === undefined ? {} : { replacesVersionId } },
    ),

  /**
   * Download a version as a portable `.palcert.json` package. Fetched rather
   * than linked so a refusal (an empty version, a lost session) is shown as a
   * message instead of being saved as a file.
   */
  exportVersion: async (
    organizationId: string,
    standardId: string,
    versionId: string,
  ): Promise<{ fileName: string; text: string }> => {
    let response: Response;
    try {
      response = await fetch(
        `${API_BASE}/api/v1/organizations/${organizationId}/standards/${standardId}/versions/${versionId}/export`,
        { credentials: 'include', headers: { Accept: 'application/json' } },
      );
    } catch {
      throw new ApiError('NETWORK_ERROR', 'The server could not be reached.', 0);
    }
    const text = await response.text();
    if (!response.ok) {
      let body: ApiErrorBody | undefined;
      try {
        body = JSON.parse(text) as ApiErrorBody;
      } catch {
        body = undefined;
      }
      throw new ApiError(
        body?.error?.code ?? 'INTERNAL_ERROR',
        body?.error?.message ?? 'Request failed',
        response.status,
        body?.error?.details,
      );
    }
    const disposition = response.headers.get('content-disposition') ?? '';
    const match = /filename="([^"]+)"/.exec(disposition);
    return { fileName: match?.[1] ?? 'standard.palcert.json', text };
  },

  previewImport: (organizationId: string, packageText: string) =>
    apiRequest<StandardImportPreviewResponse>(
      `/organizations/${organizationId}/standards/import/preview`,
      { method: 'POST', body: { package: packageText } },
    ),

  importStandard: (organizationId: string, body: StandardImportRequest) =>
    apiRequest<StandardImportResultResponse>(`/organizations/${organizationId}/standards/import`, {
      method: 'POST',
      body,
    }),

  versionUsage: (organizationId: string, standardId: string, versionId: string) =>
    apiRequest<StandardVersionUsageResponse>(
      `/organizations/${organizationId}/standards/${standardId}/versions/${versionId}/usage`,
    ),

  archiveVersion: (organizationId: string, standardId: string, versionId: string) =>
    apiRequest<StandardVersionResponse>(
      `/organizations/${organizationId}/standards/${standardId}/versions/${versionId}/archive`,
      { method: 'POST', body: {} },
    ),

  validateVersion: (organizationId: string, standardId: string, versionId: string) =>
    apiRequest<StandardVersionValidationResponse>(
      `/organizations/${organizationId}/standards/${standardId}/versions/${versionId}/validation`,
    ),

  snapshot: (organizationId: string, standardId: string, versionId: string) =>
    apiRequest<StandardVersionSnapshotResponse>(
      `/organizations/${organizationId}/standards/${standardId}/versions/${versionId}/snapshot`,
    ),

  // --- rules ---------------------------------------------------------------
  rules: (
    organizationId: string,
    standardId: string,
    versionId: string,
    page?: { cursor?: string; limit?: number },
  ) =>
    apiRequest<PageResponse<RuleResponse>>(
      `/organizations/${organizationId}/standards/${standardId}/versions/${versionId}/rules${pageQuery(page)}`,
    ),

  /**
   * Every rule mutation returns the parent version's new revision in the ETag.
   * It is handed back to the caller so the next edit can send it as `If-Match`
   * without a re-read.
   */
  createRule: (
    organizationId: string,
    standardId: string,
    versionId: string,
    revision: number,
    body: Record<string, unknown>,
  ) =>
    apiRequestWithMeta<RuleResponse>(
      `/organizations/${organizationId}/standards/${standardId}/versions/${versionId}/rules`,
      { method: 'POST', body, ...ifMatch(revision) },
    ),

  updateRule: (
    organizationId: string,
    standardId: string,
    versionId: string,
    ruleId: string,
    revision: number,
    body: Record<string, unknown>,
  ) =>
    apiRequestWithMeta<RuleResponse>(
      `/organizations/${organizationId}/standards/${standardId}/versions/${versionId}/rules/${ruleId}`,
      { method: 'PATCH', body, ...ifMatch(revision) },
    ),

  deleteRule: (
    organizationId: string,
    standardId: string,
    versionId: string,
    ruleId: string,
    revision: number,
  ) =>
    apiRequestWithMeta<void>(
      `/organizations/${organizationId}/standards/${standardId}/versions/${versionId}/rules/${ruleId}`,
      { method: 'DELETE', body: {}, ...ifMatch(revision) },
    ),

  reorderRules: (
    organizationId: string,
    standardId: string,
    versionId: string,
    revision: number,
    ruleIds: readonly string[],
  ) =>
    apiRequestWithMeta<void>(
      `/organizations/${organizationId}/standards/${standardId}/versions/${versionId}/rules/reorder`,
      { method: 'POST', body: { ruleIds }, ...ifMatch(revision) },
    ),
};

/** Read a revision back out of an ETag, for the next If-Match. */
export function revisionFromETag(etag: string | null, fallback: number): number {
  if (etag === null) return fallback;
  const parsed = Number.parseInt(etag.replaceAll('"', '').replace(/^W\//, ''), 10);
  return Number.isNaN(parsed) ? fallback : parsed;
}

// --- Documents (Phase 5) ------------------------------------------------------

export interface DocumentVersionResponse {
  id: string;
  documentId: string;
  versionNumber: number;
  status: string;
  originalFilename: string;
  declaredMimeType: string | null;
  detectedMimeType: string | null;
  detectedFormat: string | null;
  sizeBytes: number | null;
  sha256: string | null;
  rejectionCode: string | null;
  failureCode: string | null;
  retryable: boolean;
  uploadExpiresAt: string | null;
  createdAt: string;
  uploadedAt: string | null;
  validatedAt: string | null;
  scannedAt: string | null;
  readyAt: string | null;
  rejectedAt: string | null;
  failedAt: string | null;
}

export interface DocumentResponse {
  id: string;
  displayName: string;
  status: string;
  latestVersion: DocumentVersionResponse | null;
  createdAt: string;
  updatedAt: string;
}

/** Short-lived bearer material: used once, immediately, never stored. */
export interface UploadAuthorizationResponse {
  method: 'PUT';
  url: string;
  headers: Record<string, string>;
  expiresAt: string;
}

export interface CreateDocumentVersionResponse {
  version: DocumentVersionResponse;
  upload: UploadAuthorizationResponse;
}

export interface DownloadAuthorizationResponse {
  method: 'GET';
  url: string;
  expiresAt: string;
  filename: string;
}

export const documentsApi = {
  list: (page?: { cursor?: string; limit?: number }) =>
    apiRequest<PageResponse<DocumentResponse>>(`/documents${pageQuery(page)}`),

  create: (displayName: string) =>
    apiRequest<DocumentResponse>('/documents', { method: 'POST', body: { displayName } }),

  get: (documentId: string) => apiRequest<DocumentResponse>(`/documents/${documentId}`),

  rename: (documentId: string, displayName: string) =>
    apiRequest<DocumentResponse>(`/documents/${documentId}`, {
      method: 'PATCH',
      body: { displayName },
    }),

  remove: (documentId: string) =>
    apiRequest<void>(`/documents/${documentId}`, { method: 'DELETE', body: {} }),

  versions: (documentId: string, page?: { cursor?: string; limit?: number }) =>
    apiRequest<PageResponse<DocumentVersionResponse>>(
      `/documents/${documentId}/versions${pageQuery(page)}`,
    ),

  version: (documentId: string, versionId: string) =>
    apiRequest<DocumentVersionResponse>(`/documents/${documentId}/versions/${versionId}`),

  createVersion: (
    documentId: string,
    file: {
      originalFilename: string;
      sizeBytes: number;
      declaredMimeType?: string;
      sha256?: string;
    },
    idempotencyKey: string,
  ) =>
    apiRequest<CreateDocumentVersionResponse>(`/documents/${documentId}/versions`, {
      method: 'POST',
      body: file,
      headers: { 'Idempotency-Key': idempotencyKey },
    }),

  finalize: (documentId: string, versionId: string) =>
    apiRequest<DocumentVersionResponse>(`/documents/${documentId}/versions/${versionId}/finalize`, {
      method: 'POST',
      body: {},
    }),

  cancel: (documentId: string, versionId: string) =>
    apiRequest<DocumentVersionResponse>(`/documents/${documentId}/versions/${versionId}/cancel`, {
      method: 'POST',
      body: {},
    }),

  retry: (documentId: string, versionId: string) =>
    apiRequest<DocumentVersionResponse>(`/documents/${documentId}/versions/${versionId}/retry`, {
      method: 'POST',
      body: {},
    }),

  downloadAuthorization: (documentId: string, versionId: string) =>
    apiRequest<DownloadAuthorizationResponse>(
      `/documents/${documentId}/versions/${versionId}/download-authorization`,
      { method: 'POST', body: {} },
    ),
};

/**
 * The browser half of a direct-to-storage upload (§23, §78).
 *
 * A plain XHR PUT to the presigned URL with exactly the headers the API
 * returned, reporting progress. Nothing about PalCert's own API is involved;
 * this is the one place the browser talks to object storage.
 */
export function uploadToStorage(
  authorization: UploadAuthorizationResponse,
  file: Blob,
  onProgress: (fraction: number) => void,
  signal?: AbortSignal,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open(authorization.method, authorization.url, true);
    for (const [name, value] of Object.entries(authorization.headers)) {
      // The browser sets Content-Length itself and forbids scripts from doing so.
      if (name.toLowerCase() === 'content-length') continue;
      xhr.setRequestHeader(name, value);
    }
    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable) onProgress(event.loaded / event.total);
    };
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        onProgress(1);
        resolve();
      } else {
        reject(
          new ApiError('UPLOAD_TRANSFER_FAILED', `Storage responded ${xhr.status}`, xhr.status),
        );
      }
    };
    xhr.onerror = () =>
      reject(new ApiError('NETWORK_ERROR', 'The upload could not be completed.', 0));
    xhr.onabort = () => reject(new ApiError('UPLOAD_CANCELLED', 'The upload was cancelled.', 0));
    signal?.addEventListener('abort', () => xhr.abort());
    xhr.send(file);
  });
}

// ---------------------------------------------------------------------------
// Checks and the standard catalogue (Phase 7)
// ---------------------------------------------------------------------------

export interface CatalogueOrganizationResponse {
  id: string;
  displayName: string;
  slug: string;
  verificationStatus: string;
  standardCount: number;
}

export interface CatalogueDocumentTypeResponse {
  id: string;
  organizationId: string;
  name: string;
  nameAr: string | null;
  systemCategory: string;
  standardCount: number;
}

export interface CatalogueStandardResponse {
  id: string;
  organizationId: string;
  organizationName: string;
  documentTypeId: string;
  documentTypeName: string;
  code: string;
  nameEn: string;
  nameAr: string;
  descriptionEn: string | null;
  descriptionAr: string | null;
  standardVersionId: string;
  versionLabel: string;
  ruleCount: number;
  effectiveFrom: string | null;
}

export interface CheckScoreResponse {
  value: string | null;
  display: number | null;
  coverage: string | null;
  complete: boolean;
}

export interface CheckCountsResponse {
  totalRules: number;
  passedRules: number;
  failedRules: number;
  notApplicableRules: number;
  reviewRequiredRules: number;
  indeterminateRules: number;
  blockingFailures: number;
  criticalFailures: number;
  majorFailures: number;
  minorFailures: number;
  infoFailures: number;
  totalViolations: number;
}

/** Counters and classifications from a PDF analysis. No document content. */
export interface PdfDocumentResponse {
  textLayer: 'NATIVE_TEXT' | 'IMAGE_ONLY' | 'HYBRID' | 'EMPTY_OR_UNKNOWN';
  tagged: boolean;
  pageCount: number;
  imageOnlyPages: number;
  nativeTextPages: number;
}

export interface CheckResponse {
  id: string;
  documentId: string;
  documentVersionId: string;
  documentVersionNumber: number;
  documentName: string;
  documentFormat: 'DOCX' | 'PDF' | null;
  pdfDocument: PdfDocumentResponse | null;
  organizationId: string;
  organizationName: string;
  documentTypeName: string;
  standardId: string;
  standardCode: string;
  standardName: string;
  standardVersionId: string;
  standardVersionLabel: string;
  status: string;
  determination: string | null;
  score: CheckScoreResponse | null;
  counts: CheckCountsResponse | null;
  failureCode: string | null;
  retryable: boolean;
  reportId: string | null;
  currentRunId: string | null;
  /** What this check cost, and where that money stands. Null for a legacy free check. */
  billing: ServiceBillingResponse | null;
  /** True exactly when this check predates paid checks and carries no purchase. */
  legacyFree: boolean;
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
  failedAt: string | null;
}

/**
 * The billing block on a check (Phase 11 §50, §88).
 *
 * Three amounts, because "reserved" and "charged" are different states and a
 * customer shown only a price cannot tell which one they are in. No hold id,
 * no account id, no ledger id.
 */
export interface ServiceBillingResponse {
  purchaseId: string;
  productCode: string;
  status: string;
  amount: MoneyResponse;
  reserved: MoneyResponse;
  charged: MoneyResponse;
  failureCode: string | null;
  createdAt: string;
  deliveredAt: string | null;
  releasedAt: string | null;
  refundedAt: string | null;
}

export interface CheckViolationResponse {
  id: string;
  reasonCode: string;
  nodeId: string | null;
  path: string[];
  elementType: string | null;
  sectionKey: string | null;
  ordinal: number | null;
  page: number | null;
  expectedValue: string | null;
  expectedUnit: string | null;
  actualValue: string | null;
  actualUnit: string | null;
  tolerance: string | null;
}

export interface CheckRuleResultResponse {
  id: string;
  ruleCode: string;
  category: string;
  severity: string;
  blocking: boolean;
  evaluationMode: string;
  outcome: string;
  reasonCode: string;
  requiresReview: boolean;
  displayOrder: number;
  titleEn: string | null;
  titleAr: string | null;
  guidanceEn: string | null;
  guidanceAr: string | null;
  matchedFactCount: number;
  evaluatedFactCount: number;
  passedFactCount: number;
  failedFactCount: number;
  indeterminateFactCount: number;
  totalViolationCount: number;
  returnedViolationCount: number;
  violationsTruncated: boolean;
  violations?: CheckViolationResponse[];
}

export interface CheckReportMetadataResponse {
  id: string;
  checkId: string;
  checkRunId: string;
  reportSchemaVersion: number;
  reportCanonicalizationVersion: number;
  reportHash: string;
  evaluationHash: string;
  createdAt: string;
}

export const catalogueApi = {
  organizations: () => apiRequest<CatalogueOrganizationResponse[]>('/catalogue/organizations'),

  documentTypes: (organizationId: string) =>
    apiRequest<CatalogueDocumentTypeResponse[]>(
      `/catalogue/organizations/${organizationId}/document-types`,
    ),

  standards: (documentTypeId: string) =>
    apiRequest<CatalogueStandardResponse[]>(
      `/catalogue/document-types/${documentTypeId}/standards`,
    ),

  /**
   * What this standard can be checked for, in this document's format.
   *
   * Free, and the server answers it without opening the document — so it is
   * safe to call while the user is still deciding whether to buy the check.
   */
  compatibility: (standardId: string, documentVersionId: string) =>
    apiRequest<StandardCompatibilityResponse>(
      `/catalogue/standards/${standardId}/compatibility?documentVersionId=${documentVersionId}`,
    ),
};

export interface RuleCompatibilityResponse {
  readonly ruleCode: string;
  readonly property: string;
  readonly support: 'EXACT' | 'DERIVED' | 'UNSUPPORTED';
  readonly note: string;
}

export interface StandardCompatibilityResponse {
  readonly format: 'DOCX' | 'PDF';
  readonly level: 'FULL' | 'PARTIAL' | 'NONE';
  readonly totalRules: number;
  readonly supportedRules: number;
  readonly unsupportedRules: number;
  readonly rules: readonly RuleCompatibilityResponse[];
  readonly unsupportedProperties: readonly string[];
}

export const checksApi = {
  /**
   * Where the exact canonical report bytes can be fetched. A link, not a
   * request: parsing and re-serializing the JSON would change the bytes the
   * report fingerprint was computed over.
   */
  reportArtifactUrl: (checkId: string) =>
    `${API_BASE}/api/v1/checks/${encodeURIComponent(checkId)}/report/artifact`,

  list: (query: { cursor?: string; limit?: number; status?: string; documentId?: string } = {}) => {
    const params = new URLSearchParams();
    if (query.cursor !== undefined) params.set('cursor', query.cursor);
    if (query.limit !== undefined) params.set('limit', String(query.limit));
    if (query.status !== undefined) params.set('status', query.status);
    if (query.documentId !== undefined) params.set('documentId', query.documentId);
    const suffix = params.toString();
    return apiRequest<PageResponse<CheckResponse>>(`/checks${suffix === '' ? '' : `?${suffix}`}`);
  },

  /**
   * Start a paid check (Phase 11 §17).
   *
   * The quote is named, never the amount. There is no parameter here for a
   * price, and the server would ignore one if there were.
   */
  create: (
    documentVersionId: string,
    standardId: string,
    priceQuoteId: string,
    idempotencyKey: string,
  ) =>
    apiRequest<CheckResponse>('/checks', {
      method: 'POST',
      body: { documentVersionId, standardId, priceQuoteId },
      headers: { 'Idempotency-Key': idempotencyKey },
    }),

  /** Stop a check that has not yet produced a report, releasing its reservation. */
  cancel: (checkId: string) =>
    apiRequest<CheckResponse>(`/checks/${checkId}/cancel`, { method: 'POST', body: {} }),

  get: (checkId: string) => apiRequest<CheckResponse>(`/checks/${checkId}`),

  results: (checkId: string, query: { cursor?: string; limit?: number; outcome?: string } = {}) => {
    const params = new URLSearchParams();
    if (query.cursor !== undefined) params.set('cursor', query.cursor);
    if (query.limit !== undefined) params.set('limit', String(query.limit));
    if (query.outcome !== undefined) params.set('outcome', query.outcome);
    const suffix = params.toString();
    return apiRequest<PageResponse<CheckRuleResultResponse>>(
      `/checks/${checkId}/results${suffix === '' ? '' : `?${suffix}`}`,
    );
  },

  report: (checkId: string) => apiRequest<CheckReportMetadataResponse>(`/checks/${checkId}/report`),

  retry: (checkId: string) =>
    apiRequest<CheckResponse>(`/checks/${checkId}/retry`, { method: 'POST', body: {} }),
};

// ---------------------------------------------------------------------------
// AI review (Phase 8)
// ---------------------------------------------------------------------------

export interface AIConsentResponse {
  granted: boolean;
  consentVersion: string | null;
  consentedAt: string | null;
  providerCategory: string | null;
  renewalRequired: boolean;
}

export interface AIReviewUsageResponse {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number | null;
  cacheWriteTokens: number | null;
  invocationCount: number;
}

export interface AIReviewResponse {
  id: string;
  checkId: string;
  status: string;
  failureKind: string | null;
  provider: string;
  configuredModel: string;
  providerReturnedModel: string | null;
  promptVersion: string;
  contextBuilderVersion: string;
  aiReviewSchemaVersion: number;
  aiReviewHash: string | null;
  assessmentCount: number;
  humanReviewRequiredCount: number;
  insufficientEvidenceCount: number;
  contextTruncated: boolean;
  usage: AIReviewUsageResponse | null;
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
  failedAt: string | null;
}

export interface AIRuleAssessmentResponseView {
  id: string;
  ruleCode: string;
  titleEn: string | null;
  titleAr: string | null;
  severity: string;
  blocking: boolean;
  assessment: string;
  reasonCode: string;
  evidenceSufficiency: string;
  uncertaintyReasons: string[];
  evidenceNodeIds: string[];
  explanationEn: string;
  explanationAr: string;
  requiresHumanReview: boolean;
  deterministicOutcome: string | null;
}

export interface AIPriorityRecommendationResponse {
  priority: string;
  relatedRuleCodes: string[];
  textEn: string;
  textAr: string;
}

export interface AISupplementResponse {
  summaryEn: string;
  summaryAr: string;
  priorityRecommendations: AIPriorityRecommendationResponse[];
}

export const aiApi = {
  consent: () => apiRequest<AIConsentResponse>('/ai/consent'),

  grantConsent: () => apiRequest<AIConsentResponse>('/ai/consent', { method: 'POST', body: {} }),

  withdrawConsent: () =>
    apiRequest<AIConsentResponse>('/ai/consent', { method: 'DELETE', body: {} }),

  reviews: (checkId: string) => apiRequest<AIReviewResponse[]>(`/checks/${checkId}/ai-reviews`),

  /** ADR-0149: an AI review is bought with the caller's own AI_REVIEW quote. */
  startReview: (checkId: string, priceQuoteId: string, idempotencyKey: string) =>
    apiRequest<AIReviewResponse>(`/checks/${checkId}/ai-reviews`, {
      method: 'POST',
      body: { priceQuoteId },
      headers: { 'Idempotency-Key': idempotencyKey },
    }),

  review: (checkId: string, reviewId: string) =>
    apiRequest<AIReviewResponse>(`/checks/${checkId}/ai-reviews/${reviewId}`),

  assessments: (checkId: string, reviewId: string) =>
    apiRequest<AIRuleAssessmentResponseView[]>(
      `/checks/${checkId}/ai-reviews/${reviewId}/assessments`,
    ),

  supplement: (checkId: string, reviewId: string) =>
    apiRequest<AISupplementResponse>(`/checks/${checkId}/ai-reviews/${reviewId}/supplement`),

  /** Only while the review is still waiting; the server refuses once it has started. */
  cancelReview: (checkId: string, reviewId: string) =>
    apiRequest<AIReviewResponse>(`/checks/${checkId}/ai-reviews/${reviewId}/cancel`, {
      method: 'POST',
      body: {},
    }),
};

// ---------------------------------------------------------------------------
// Standard sources and rule extraction (Phase 9)
// ---------------------------------------------------------------------------

export interface StandardSourceResponse {
  id: string;
  standardVersionId: string;
  sourceKind: string;
  status: string;
  authority: string | null;
  originalFilename: string;
  declaredMimeType: string | null;
  detectedMimeType: string | null;
  detectedFormat: string | null;
  sizeBytes: number | null;
  sha256: string | null;
  pageCount: number | null;
  rejectionCode: string | null;
  failureCode: string | null;
  retryable: boolean;
  /** True once an accepted rule's provenance depends on it, so it cannot be removed. */
  retentionLocked: boolean;
  /** Legacy equation objects accepted in safe mode (never executed). */
  legacyEquationCount?: number;
  uploadExpiresAt: string | null;
  uploadedByUserId: string | null;
  createdAt: string;
  readyAt: string | null;
  rejectedAt: string | null;
  failedAt: string | null;
}

export interface CreateStandardSourceResponse {
  source: StandardSourceResponse;
  upload: UploadAuthorizationResponse;
}

export interface OrganizationAIConsentResponse {
  granted: boolean;
  consentVersion: string | null;
  providerCategory: string | null;
  acceptedAt: string | null;
  acceptedByUserId: string | null;
  renewalRequired: boolean;
}

export interface ExtractionSummaryResponse {
  sourcesProcessed: number;
  evidenceBlocks: number;
  templateObservations: number;
  explicitRequirementProposals: number;
  templateInferenceProposals: number;
  ambiguousRequirements: number;
  conflictingRequirements: number;
  unrepresentableRequirements: number;
  invalidProposals: number;
}

export interface ExtractionRunResponse {
  id: string;
  standardVersionId: string;
  status: string;
  failureKind: string | null;
  baseStandardRevision: number;
  provider: string;
  configuredModel: string;
  providerReturnedModel: string | null;
  promptVersion: string;
  contextBuilderVersion: string;
  proposalSchemaVersion: number;
  sourceSetHash: string;
  extractionRunHash: string | null;
  sourceAssetIds: string[];
  summary: ExtractionSummaryResponse | null;
  usage: { inputTokens: number; outputTokens: number; invocationCount: number } | null;
  createdByUserId: string | null;
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
  failedAt: string | null;
}

export interface SourceEvidenceResponse {
  id: string;
  sourceAssetId: string;
  sourceKind: string;
  sourceFilename: string;
  evidenceKind: string;
  locatorType: string;
  startPage: number | null;
  endPage: number | null;
  nodeIds: string[];
  startCharIndex: number | null;
  endCharIndex: number | null;
  excerpt: string;
  excerptHash: string;
}

export interface TemplateObservationResponse {
  id: string;
  sourceAssetId: string;
  sourceFilename: string;
  scopeKey: string;
  property: string;
  unit: string | null;
  modalValue: string | null;
  occurrenceCount: number;
  matchingCount: number;
  distinctValueCount: number;
  uniformity: string;
  distribution: { value: string; count: number }[];
  observationHash: string;
}

export interface ProposalDecisionResponse {
  decision: string;
  reviewedByUserId: string | null;
  reviewedAt: string;
  resultingRuleId: string | null;
  rejectionReason: string | null;
  reviewNotes: string | null;
  acceptedRule: Record<string, unknown> | null;
}

export interface RuleProposalResponse {
  id: string;
  extractionRunId: string;
  proposalKey: string;
  kind: string;
  status: string;
  validationStatus: string;
  validationIssues: { path: string; message: string }[];
  automationSupport: string;
  conflict: {
    status: string;
    existingRuleId: string | null;
    existingRuleCode: string | null;
    relatedProposalIds: string[];
    detail: string | null;
  };
  suggestedRule: Record<string, unknown> | null;
  suggestedRuleCode: string | null;
  interpretationEn: string;
  interpretationAr: string;
  ambiguityNote: string | null;
  requiresClarification: boolean;
  evidenceIds: string[];
  observationIds: string[];
  displayOrder: number;
  decision: ProposalDecisionResponse | null;
  /** On the list only: what the review table shows without a request per row. */
  summary?: RuleProposalSummaryResponse;
}

export interface RuleProposalSummaryResponse {
  sources: { sourceAssetId: string; sourceFilename: string; sourceKind: string }[];
  evidenceCount: number;
  observationCount: number;
  observation: {
    property: string;
    unit: string | null;
    modalValue: string | null;
    occurrenceCount: number;
    matchingCount: number;
    uniformity: string;
  } | null;
}

/** Where a running extraction has got to, read back from what it stored. */
export interface ExtractionProgressResponse {
  runId: string;
  status: string;
  stage: string;
  failureKind: string | null;
  completedBatches: number;
  /** Null until the evidence is saved; never an estimate. */
  totalBatches: number | null;
  successfulBatches: number;
  failedBatches: number;
  evidenceCount: number | null;
  observationCount: number | null;
  /** Null until the proposals are saved. */
  proposalCount: number | null;
  elapsedSeconds: number | null;
  cancellable: boolean;
  startedAt: string | null;
  finishedAt: string | null;
}

export interface RuleProposalDetailResponse extends RuleProposalResponse {
  evidence: SourceEvidenceResponse[];
  observations: TemplateObservationResponse[];
}

export interface RuleProvenanceResponse {
  standardRuleId: string;
  extractionRunId: string;
  proposalId: string;
  sourceAssetId: string;
  sourceFilename: string;
  sourceKind: string;
  sourceSha256: string;
  evidenceKind: string;
  locatorType: string;
  startPage: number | null;
  endPage: number | null;
  nodeIds: string[];
  createdAt: string;
}

export interface ExtractionCountersResponse {
  sources: number;
  extractionRuns: number;
  pendingProposals: number;
  acceptedProposals: number;
  rejectedProposals: number;
  conflicts: number;
}

/**
 * The Phase 9 endpoints.
 *
 * Every path is organization-scoped, because a Standard's sources belong to the
 * institution rather than to whoever uploaded them — the opposite of a personal
 * document, and deliberately a different authorization model (§6).
 */
export const extractionApi = {
  // --- organization AI consent ---------------------------------------------
  consent: (organizationId: string) =>
    apiRequest<OrganizationAIConsentResponse>(`/organizations/${organizationId}/ai-consent`),

  grantConsent: (organizationId: string) =>
    apiRequest<OrganizationAIConsentResponse>(`/organizations/${organizationId}/ai-consent`, {
      method: 'POST',
      body: {},
    }),

  revokeConsent: (organizationId: string) =>
    apiRequest<OrganizationAIConsentResponse>(`/organizations/${organizationId}/ai-consent`, {
      method: 'DELETE',
      body: {},
    }),

  // --- sources -------------------------------------------------------------
  sources: (organizationId: string, versionId: string) =>
    apiRequest<StandardSourceResponse[]>(
      `/organizations/${organizationId}/standard-versions/${versionId}/sources`,
    ),

  createSource: (
    organizationId: string,
    versionId: string,
    body: {
      sourceKind: string;
      originalFilename: string;
      sizeBytes: number;
      declaredMimeType?: string;
      sha256?: string;
      authority?: string;
    },
    idempotencyKey: string,
  ) =>
    apiRequest<CreateStandardSourceResponse>(
      `/organizations/${organizationId}/standard-versions/${versionId}/sources`,
      { method: 'POST', body, headers: { 'Idempotency-Key': idempotencyKey } },
    ),

  finalizeSource: (organizationId: string, versionId: string, sourceId: string) =>
    apiRequest<StandardSourceResponse>(
      `/organizations/${organizationId}/standard-versions/${versionId}/sources/${sourceId}/finalize`,
      { method: 'POST', body: {} },
    ),

  source: (organizationId: string, versionId: string, sourceId: string) =>
    apiRequest<StandardSourceResponse>(
      `/organizations/${organizationId}/standard-versions/${versionId}/sources/${sourceId}`,
    ),

  sourceDownload: (organizationId: string, versionId: string, sourceId: string) =>
    apiRequest<DownloadAuthorizationResponse>(
      `/organizations/${organizationId}/standard-versions/${versionId}/sources/${sourceId}/download-authorization`,
      { method: 'POST', body: {} },
    ),

  deleteSource: (organizationId: string, versionId: string, sourceId: string) =>
    apiRequest<void>(
      `/organizations/${organizationId}/standard-versions/${versionId}/sources/${sourceId}`,
      { method: 'DELETE' },
    ),

  // --- extraction runs -----------------------------------------------------
  runs: (organizationId: string, versionId: string) =>
    apiRequest<ExtractionRunResponse[]>(
      `/organizations/${organizationId}/standard-versions/${versionId}/extractions`,
    ),

  /**
   * ADR-0149: bought with the CALLER'S own AI_RULE_EXTRACTION quote — the member
   * who starts it pays, never the organization.
   */
  startRun: (
    organizationId: string,
    versionId: string,
    priceQuoteId: string,
    idempotencyKey: string,
    sourceAssetIds?: readonly string[],
  ) =>
    apiRequest<ExtractionRunResponse>(
      `/organizations/${organizationId}/standard-versions/${versionId}/extractions`,
      {
        method: 'POST',
        body: {
          priceQuoteId,
          ...(sourceAssetIds === undefined ? {} : { sourceAssetIds: [...sourceAssetIds] }),
        },
        headers: { 'Idempotency-Key': idempotencyKey },
      },
    ),

  run: (organizationId: string, versionId: string, runId: string) =>
    apiRequest<ExtractionRunResponse>(
      `/organizations/${organizationId}/standard-versions/${versionId}/extractions/${runId}`,
    ),

  cancelRun: (organizationId: string, versionId: string, runId: string) =>
    apiRequest<ExtractionRunResponse>(
      `/organizations/${organizationId}/standard-versions/${versionId}/extractions/${runId}/cancel`,
      { method: 'POST', body: {} },
    ),

  /** Small enough to poll while a run is active. */
  runProgress: (organizationId: string, versionId: string, runId: string) =>
    apiRequest<ExtractionProgressResponse>(
      `/organizations/${organizationId}/standard-versions/${versionId}/extractions/${runId}/progress`,
    ),

  // --- proposals -----------------------------------------------------------
  proposals: (organizationId: string, versionId: string, runId: string) =>
    apiRequest<RuleProposalResponse[]>(
      `/organizations/${organizationId}/standard-versions/${versionId}/extractions/${runId}/proposals`,
    ),

  proposal: (organizationId: string, versionId: string, runId: string, proposalId: string) =>
    apiRequest<RuleProposalDetailResponse>(
      `/organizations/${organizationId}/standard-versions/${versionId}/extractions/${runId}/proposals/${proposalId}`,
    ),

  /**
   * Accept one proposal, optionally as the reviewer edited it.
   *
   * The revision goes out as `If-Match`, exactly as a hand-written rule edit
   * does: accepting a proposal changes the draft, and a reviewer working from a
   * stale page must be told rather than silently overwriting someone else.
   */
  acceptProposal: (
    organizationId: string,
    versionId: string,
    runId: string,
    proposalId: string,
    revision: number,
    body: { rule?: Record<string, unknown>; origin?: string; reviewNotes?: string } = {},
  ) =>
    apiRequestWithMeta<RuleProposalResponse>(
      `/organizations/${organizationId}/standard-versions/${versionId}/extractions/${runId}/proposals/${proposalId}/accept`,
      { method: 'POST', body, headers: { 'If-Match': `"${revision}"` } },
    ),

  rejectProposal: (
    organizationId: string,
    versionId: string,
    runId: string,
    proposalId: string,
    body: { reason?: string; reviewNotes?: string } = {},
  ) =>
    apiRequest<RuleProposalResponse>(
      `/organizations/${organizationId}/standard-versions/${versionId}/extractions/${runId}/proposals/${proposalId}/reject`,
      { method: 'POST', body },
    ),

  acceptSelected: (
    organizationId: string,
    versionId: string,
    runId: string,
    proposalIds: readonly string[],
    revision: number,
  ) =>
    apiRequestWithMeta<{ accepted: string[]; skipped: { id: string; reason: string }[] }>(
      `/organizations/${organizationId}/standard-versions/${versionId}/extractions/${runId}/proposals/accept-selected`,
      {
        method: 'POST',
        body: { proposalIds: [...proposalIds] },
        headers: { 'If-Match': `"${revision}"` },
      },
    ),

  /** Reject a named list in one transaction; anything already decided is skipped. */
  rejectSelected: (
    organizationId: string,
    versionId: string,
    runId: string,
    proposalIds: readonly string[],
    body: { reason?: string; reviewNotes?: string } = {},
  ) =>
    apiRequest<{ rejected: string[]; skipped: { id: string; reason: string }[] }>(
      `/organizations/${organizationId}/standard-versions/${versionId}/extractions/${runId}/proposals/reject-selected`,
      { method: 'POST', body: { proposalIds: [...proposalIds], ...body } },
    ),

  // --- provenance and counters ---------------------------------------------
  provenance: (organizationId: string, versionId: string, ruleId: string) =>
    apiRequest<RuleProvenanceResponse[]>(
      `/organizations/${organizationId}/standard-versions/${versionId}/rules/${ruleId}/provenance`,
    ),

  counters: (organizationId: string, versionId: string) =>
    apiRequest<ExtractionCountersResponse>(
      `/organizations/${organizationId}/standard-versions/${versionId}/extraction-counters`,
    ),
};

// ---------------------------------------------------------------------------
// PalCert Balance, pricing and payments (Phase 10)
// ---------------------------------------------------------------------------

/**
 * An amount of money.
 *
 * `minorUnits` is a **string** of integer minor units — "2000" is USD 20.00 —
 * because a JavaScript number is exact only below 2^53 and money should not
 * depend on that. Nothing in the browser does arithmetic on it; formatting
 * goes through `formatMoney`, which slices digits rather than dividing.
 */
export interface MoneyResponse {
  currency: string;
  minorUnits: string;
}

export interface BalanceSummaryResponse {
  currency: string;
  available: MoneyResponse;
  reserved: MoneyResponse;
  cash: MoneyResponse;
  promotional: MoneyResponse;
  accounts: {
    currency: string;
    creditClass: string;
    ledgerBalance: MoneyResponse;
    reserved: MoneyResponse;
    available: MoneyResponse;
  }[];
}

export interface LedgerEntryResponse {
  publicId: string;
  entryType: string;
  creditClass: string;
  amount: MoneyResponse;
  reasonCode: string | null;
  /** The service a hold or capture paid for, when it paid for one. */
  serviceProductCode?: string | null;
  reversalOfEntryId: string | null;
  createdAt: string;
}

export interface CreditHoldResponse {
  id: string;
  status: string;
  purpose: string;
  amount: MoneyResponse;
  creditClass: string;
  expiresAt: string | null;
  createdAt: string;
  capturedAt: string | null;
  releasedAt: string | null;
  expiredAt: string | null;
}

export interface BalanceTopUpResponse {
  id: string;
  status: string;
  amount: MoneyResponse;
  provider: string;
  failureCode: string | null;
  createdAt: string;
  expiresAt: string | null;
  succeededAt: string | null;
  failedAt: string | null;
  cancelledAt: string | null;
}

export interface CreateTopUpResponse {
  topUp: BalanceTopUpResponse;
  /** Short-lived and sensitive: used once, immediately, and never stored. */
  checkoutUrl: string;
  expiresAt: string;
}

export interface PaymentRefundResponse {
  id: string;
  topUpId: string;
  status: string;
  amount: MoneyResponse;
  reason: string | null;
  failureCode: string | null;
  createdAt: string;
  succeededAt: string | null;
  failedAt: string | null;
}

export interface ServiceProductResponse {
  productCode: string;
  active: boolean;
  nameEn: string;
  nameAr: string;
  descriptionEn: string | null;
  descriptionAr: string | null;
}

export interface PriceQuoteResponse {
  id: string;
  productCode: string;
  amount: MoneyResponse;
  createdAt: string;
  expiresAt: string;
  expired: boolean;
}

export const balanceApi = {
  balance: (currency?: string) =>
    apiRequest<BalanceSummaryResponse>(
      `/balance${currency === undefined ? '' : `?currency=${currency}`}`,
    ),

  currencies: () => apiRequest<string[]>('/balance/currencies'),

  transactions: (options: { limit?: number; cursor?: string } = {}) => {
    const query = new URLSearchParams();
    if (options.limit !== undefined) query.set('limit', String(options.limit));
    if (options.cursor !== undefined) query.set('cursor', options.cursor);
    const suffix = query.toString() === '' ? '' : `?${query.toString()}`;
    return apiRequest<{ items: LedgerEntryResponse[]; nextCursor: string | null }>(
      `/balance/transactions${suffix}`,
    );
  },

  holds: () => apiRequest<CreditHoldResponse[]>('/balance/holds'),

  createTopUp: (body: { currency: string; amountMinorUnits: string }, idempotencyKey: string) =>
    apiRequest<CreateTopUpResponse>('/balance/top-ups', {
      method: 'POST',
      body,
      headers: { 'Idempotency-Key': idempotencyKey },
    }),

  topUps: () => apiRequest<BalanceTopUpResponse[]>('/balance/top-ups'),

  topUp: (topUpId: string) => apiRequest<BalanceTopUpResponse>(`/balance/top-ups/${topUpId}`),

  refunds: () => apiRequest<PaymentRefundResponse[]>('/balance/refunds'),

  products: () => apiRequest<ServiceProductResponse[]>('/pricing/products'),

  quote: (product: string, currency?: string) =>
    apiRequest<PriceQuoteResponse>(
      `/pricing/quote?product=${product}${currency === undefined ? '' : `&currency=${currency}`}`,
    ),

  /**
   * Whether adding credit is possible right now (Phase 20 Checkpoint 8).
   *
   * The API has answered this since Phase 10, for exactly the reason its own
   * comment gives: "Reporting it here lets the UI say exactly that instead of
   * offering a button that cannot work." The balance screen was instead
   * inferring it from `/balance/currencies`, which is a ledger read and knows
   * nothing about the provider — so a deployment with payments switched off
   * still offered the form.
   *
   * It sits under `/api/health`, outside the versioned surface, which is why
   * it does not go through `apiRequest`. It reports an outage as a 200 with
   * `available: false`, never a 5xx, so a failure here is a failure to reach
   * PalCert at all.
   */
  paymentsAvailability: async (): Promise<PaymentsAvailability> => {
    const response = await fetch(`${API_BASE}/api/health/payments`, {
      credentials: 'include',
      headers: { Accept: 'application/json' },
    });
    if (!response.ok) throw new Error(`payments availability: ${response.status}`);
    return (await response.json()) as PaymentsAvailability;
  },
};

export interface PaymentsAvailability {
  /** Whether this deployment offers paid top-ups at all. */
  readonly enabled: boolean;
  /** Whether the provider can be reached right now. */
  readonly available: boolean;
  readonly provider: string;
}

// ---------------------------------------------------------------------------
// SmartFix (Phase 12)
// ---------------------------------------------------------------------------

export interface SmartFixPlanRuleResponse {
  ruleCode: string;
  fixability: string;
  reasonCode: string | null;
  targetCount: number;
  fixableTargetCount: number;
}

export interface SmartFixPlanResponse {
  reservation?: { status: string; priceQuoteId: string; amount: MoneyResponse };
  aiPlanning?: SmartFixAIPlanning;
  id: string;
  checkId: string;
  documentVersionId: string;
  createdAt: string;
  expiresAt: string;
  fixEngineVersion: string;
  /** Set when the document cannot be corrected at all. */
  refusalCode: string | null;
  ruleCount: number;
  fixableRuleCount: number;
  actionCount: number;
  rules: SmartFixPlanRuleResponse[];
}

export interface SmartFixRequestResponse {
  id: string;
  planId: string;
  checkId: string;
  status: string;
  failureCode: string | null;
  /** Null until the correction is delivered, because it is not yours before then. */
  correctedDocumentVersionId: string | null;
  recheckCheckId: string | null;
  createdAt: string;
  deliveredAt: string | null;
}

export interface SmartFixManifestEntryResponse {
  actionId: string;
  ruleCode: string;
  actionType: string;
  nodeId: string;
  scriptChannel?: string;
  sectionIndex?: number;
  before?: { kind: string; number?: string; text?: string; flag?: boolean; unit?: string };
  after: { kind: string; number?: string; text?: string; flag?: boolean; unit?: string };
  partName: string;
}

export interface SmartFixManifestResponse {
  requestId: string;
  fixEngineVersion: string;
  entryCount: number;
  changedParts: string[];
  textUnchanged: boolean;
  mediaUnchanged: boolean;
  fieldsUnchanged: boolean;
  relationshipsUnchanged: boolean;
  entries: SmartFixManifestEntryResponse[];
}

export const smartFixApi = {
  /** Deterministic preview is free; AI reserves the quoted SMARTFIX price. */
  plan: (
    checkId: string,
    options: { useAI?: boolean; formattingAIConsentVersion?: string; priceQuoteId?: string } = {},
  ) =>
    apiRequest<SmartFixPlanResponse>(
      `/smartfix/checks/${checkId}/${options.useAI ? 'ai-plan' : 'plan'}`,
      {
        method: 'POST',
        body: options,
      },
    ),

  getPlan: (planId: string) => apiRequest<SmartFixPlanResponse>(`/smartfix/plans/${planId}`),
  cancelPlan: (planId: string) =>
    apiRequest<{ cancelled: true }>(`/smartfix/plans/${planId}/cancel`, {
      method: 'POST',
      body: {},
    }),

  /**
   * Buy and start a correction.
   *
   * The plan is named, never its contents: what runs is the plan the user just
   * read, and the server would ignore a fresh one if it were offered.
   */
  start: (planId: string, priceQuoteId: string) =>
    apiRequest<SmartFixRequestResponse>('/smartfix/requests', {
      method: 'POST',
      body: { planId, priceQuoteId },
    }),

  get: (requestId: string) =>
    apiRequest<SmartFixRequestResponse>(`/smartfix/requests/${requestId}`),

  forCheck: (checkId: string) =>
    apiRequest<SmartFixRequestResponse[]>(`/smartfix/checks/${checkId}/requests`),

  manifest: (requestId: string) =>
    apiRequest<SmartFixManifestResponse>(`/smartfix/requests/${requestId}/manifest`),

  cancel: (requestId: string) =>
    apiRequest<SmartFixRequestResponse>(`/smartfix/requests/${requestId}/cancel`, {
      method: 'POST',
      body: {},
    }),
};

// ---------------------------------------------------------------------------
// Official submissions (Phase 14)
// ---------------------------------------------------------------------------

export interface SubmissionTechnicalSummaryResponse {
  readonly determination: string;
  readonly score: string | null;
  readonly scoreCoverage: string | null;
  readonly scoreComplete: boolean;
  readonly totalRules: number;
  readonly passedRules: number;
  readonly failedRules: number;
  readonly reviewRequiredRules: number;
  readonly indeterminateRules: number;
  readonly notApplicableRules: number;
}

export interface SubmissionStandardResponse {
  readonly standardId: string;
  readonly standardVersionId: string;
  readonly standardCode: string;
  readonly standardName: string;
  readonly standardVersionLabel: string;
  readonly standardContentHash: string;
}

export interface SubmitterIdentityResponse {
  readonly userId: string;
  readonly displayName: string | null;
  readonly email: string;
}

export interface SubmissionDisclosureResponse {
  readonly organizationId: string;
  readonly organizationName: string;
  readonly documentTypeName: string;
  readonly documentVersionNumber: number;
  readonly documentFormat: string;
  readonly standard: SubmissionStandardResponse;
  readonly technical: SubmissionTechnicalSummaryResponse;
  readonly submitter: SubmitterIdentityResponse;
  readonly shared: readonly string[];
  readonly notShared: readonly string[];
}

export interface SubmissionRevisionResponse {
  readonly id: string;
  readonly submissionId: string;
  readonly revisionNumber: number;
  readonly processingStatus: string;
  readonly failureCode: string | null;
  readonly retryable: boolean;
  readonly institutionDecisionStatus: string | null;
  readonly documentVersionId: string;
  readonly documentVersionNumber: number;
  readonly documentSha256: string;
  readonly documentFormat: string;
  readonly checkId: string;
  readonly reportId: string;
  readonly reportHash: string;
  readonly evaluationHash: string;
  readonly standard: SubmissionStandardResponse;
  readonly technical: SubmissionTechnicalSummaryResponse;
  readonly evidenceHash: string | null;
  readonly createdAt: string;
  readonly submittedAt: string | null;
  readonly reviewStartedAt: string | null;
  readonly decidedAt: string | null;
}

export interface OfficialSubmissionResponse {
  readonly id: string;
  readonly organizationId: string;
  readonly organizationName: string;
  readonly documentTypeId: string;
  readonly documentTypeName: string;
  readonly documentId: string;
  readonly documentName: string;
  readonly currentRevision: SubmissionRevisionResponse | null;
  readonly revisionCount: number;
  readonly displayStatus: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface SubmissionDecisionEventResponse {
  readonly id: string;
  readonly submissionRevisionId: string;
  readonly eventSource: string;
  readonly fromStatus: string | null;
  readonly toStatus: string;
  readonly reasonCode: string | null;
  readonly actorUserId: string | null;
  readonly createdAt: string;
}

export interface SubmissionCommentResponse {
  readonly id: string;
  readonly submissionRevisionId: string;
  readonly authorSide: string;
  readonly authorUserId: string;
  readonly body: string;
  readonly createdAt: string;
}

export interface SubmissionQueueEntryResponse {
  readonly submissionId: string;
  readonly revisionId: string;
  readonly revisionNumber: number;
  readonly documentTypeId: string;
  readonly documentTypeName: string;
  readonly institutionDecisionStatus: string;
  readonly technical: SubmissionTechnicalSummaryResponse;
  readonly standardCode: string;
  readonly standardVersionLabel: string;
  readonly submitter: SubmitterIdentityResponse;
  readonly submittedAt: string;
  readonly decidedAt: string | null;
}

export interface OrganizationSubmissionRevisionResponse {
  readonly id: string;
  readonly submissionId: string;
  readonly revisionNumber: number;
  readonly institutionDecisionStatus: string;
  readonly documentFormat: string;
  readonly documentSha256: string;
  readonly reportHash: string;
  readonly evaluationHash: string;
  readonly evidenceHash: string;
  readonly standard: SubmissionStandardResponse;
  readonly technical: SubmissionTechnicalSummaryResponse;
  readonly submittedAt: string;
  readonly reviewStartedAt: string | null;
  readonly decidedAt: string | null;
  readonly isCurrent: boolean;
}

export interface OrganizationSubmissionResponse {
  readonly id: string;
  readonly organizationId: string;
  readonly documentTypeId: string;
  readonly documentTypeName: string;
  readonly submitter: SubmitterIdentityResponse;
  readonly currentRevisionId: string;
  readonly revisions: readonly OrganizationSubmissionRevisionResponse[];
  readonly createdAt: string;
  readonly updatedAt: string;
}

/**
 * The author's side.
 *
 * `submit` is the only call in this client that shares anything with anybody,
 * and it is reached only from a button the person pressed after reading
 * `disclosure`.
 */
export const submissionsApi = {
  disclosure: (checkId: string) =>
    apiRequest<SubmissionDisclosureResponse>(`/submissions/checks/${checkId}/disclosure`),

  submit: (checkId: string, idempotencyKey: string) =>
    apiRequest<SubmissionRevisionResponse>('/submissions', {
      method: 'POST',
      body: { checkId },
      headers: { 'Idempotency-Key': idempotencyKey },
    }),

  list: () => apiRequest<OfficialSubmissionResponse[]>('/submissions'),

  get: (submissionId: string) =>
    apiRequest<OfficialSubmissionResponse>(`/submissions/${submissionId}`),

  history: (revisionId: string) =>
    apiRequest<SubmissionDecisionEventResponse[]>(`/submissions/revisions/${revisionId}/history`),

  comments: (revisionId: string) =>
    apiRequest<SubmissionCommentResponse[]>(`/submissions/revisions/${revisionId}/comments`),

  document: (revisionId: string) =>
    apiRequest<DownloadAuthorizationResponse>(`/submissions/revisions/${revisionId}/document`, {
      method: 'POST',
      body: {},
    }),

  report: (revisionId: string) =>
    apiRequest<DownloadAuthorizationResponse>(`/submissions/revisions/${revisionId}/report`, {
      method: 'POST',
      body: {},
    }),
};

/** The receiving institution's side. Every path is organization-scoped. */
export const submissionReviewApi = {
  queue: (organizationId: string, status?: string) =>
    apiRequest<SubmissionQueueEntryResponse[]>(
      `/organizations/${organizationId}/submissions${status === undefined ? '' : `?status=${status}`}`,
    ),

  get: (organizationId: string, submissionId: string) =>
    apiRequest<OrganizationSubmissionResponse>(
      `/organizations/${organizationId}/submissions/${submissionId}`,
    ),

  history: (organizationId: string, revisionId: string) =>
    apiRequest<SubmissionDecisionEventResponse[]>(
      `/organizations/${organizationId}/submissions/revisions/${revisionId}/history`,
    ),

  comments: (organizationId: string, revisionId: string) =>
    apiRequest<SubmissionCommentResponse[]>(
      `/organizations/${organizationId}/submissions/revisions/${revisionId}/comments`,
    ),

  /**
   * Record a decision.
   *
   * `expectedStatus` is what the reviewer's screen showed. Sending it turns a
   * silent last-write-wins into a conflict the person can see and resolve.
   */
  decide: (
    organizationId: string,
    revisionId: string,
    body: {
      toStatus: string;
      reasonCode?: string;
      comment?: string;
      expectedStatus?: string;
    },
  ) =>
    apiRequest<SubmissionDecisionEventResponse>(
      `/organizations/${organizationId}/submissions/revisions/${revisionId}/decision`,
      { method: 'POST', body },
    ),

  comment: (organizationId: string, revisionId: string, body: string) =>
    apiRequest<SubmissionCommentResponse>(
      `/organizations/${organizationId}/submissions/revisions/${revisionId}/comments`,
      { method: 'POST', body: { body } },
    ),

  document: (organizationId: string, revisionId: string) =>
    apiRequest<DownloadAuthorizationResponse>(
      `/organizations/${organizationId}/submissions/revisions/${revisionId}/document`,
      { method: 'POST', body: {} },
    ),

  report: (organizationId: string, revisionId: string) =>
    apiRequest<DownloadAuthorizationResponse>(
      `/organizations/${organizationId}/submissions/revisions/${revisionId}/report`,
      { method: 'POST', body: {} },
    ),
};

export interface CertificateResponse {
  readonly id: string;
  /** Read from the immutable claim, so it is null until one has been issued. */
  readonly certificateNumber: string | null;
  readonly issuanceStatus: string;
  readonly submissionId: string;
  readonly submissionRevisionId: string;
  readonly organizationId: string;
  readonly organizationName: string;
  readonly documentTypeName: string;
  readonly documentFormat: string;
  readonly standardCode: string;
  readonly standardName: string;
  readonly standardVersionLabel: string;
  readonly technicalResult: string;
  readonly institutionDecision: string;
  readonly issuedAt: string | null;
  readonly validUntil: string | null;
  readonly revokedAt: string | null;
  readonly revocationReason: string | null;
  readonly documentSha256: string;
  readonly reportHash: string;
  readonly standardContentHash: string;
  readonly submissionEvidenceHash: string;
  readonly certificateClaimHash: string | null;
  readonly certificateArtifactSha256: string | null;
  /** Private to the two parties. Never rendered into a page a stranger loads. */
  readonly verificationCode: string | null;
  readonly verificationUrl: string | null;
}

export interface CertificateEventResponse {
  readonly id: string;
  readonly eventType: string;
  readonly eventSource: string;
  readonly reasonCode: string | null;
  readonly createdAt: string;
}

export interface SubmissionCertificateStatusResponse {
  readonly eligible: boolean;
  readonly reason: string | null;
  readonly certificate: CertificateResponse | null;
}

/**
 * The public verification response (§99–§107).
 *
 * Deliberately a different type from `CertificateResponse`, and deliberately
 * smaller. Reusing one type for both surfaces is how a field that belongs to
 * the holder ends up on a page a stranger can load, so the boundary is drawn
 * in the type system as well as on the server.
 */
export interface PublicCertificateVerificationResponse {
  readonly certificateNumber: string;
  readonly verificationStatus: string;
  readonly organizationName: string;
  readonly documentTypeName: string;
  readonly documentFormat: string;
  readonly standardName: string;
  readonly standardCode: string;
  readonly standardVersionLabel: string;
  readonly technicalResult: string;
  readonly institutionDecision: string;
  readonly issuedAt: string;
  readonly validUntil: string | null;
  readonly revokedAt: string | null;
  readonly revocationReason: string | null;
  readonly documentSha256: string;
  readonly reportHash: string;
  readonly standardContentHash: string;
  readonly submissionEvidenceHash: string;
  readonly certificateClaimHash: string;
  readonly certificateArtifactSha256: string;
}

/** The subject's own certificates. Read and download; never create (§190). */
export const certificatesApi = {
  list: () => apiRequest<CertificateResponse[]>('/certificates'),

  get: (certificateId: string) => apiRequest<CertificateResponse>(`/certificates/${certificateId}`),

  forRevision: (revisionId: string) =>
    apiRequest<SubmissionCertificateStatusResponse>(`/certificates/revisions/${revisionId}`),

  events: (certificateId: string) =>
    apiRequest<CertificateEventResponse[]>(`/certificates/${certificateId}/events`),

  download: (certificateId: string) =>
    apiRequest<DownloadAuthorizationResponse>(`/certificates/${certificateId}/download`, {
      method: 'POST',
      body: {},
    }),
};

/** The institution's side: what its approvals produced, and withdrawing one. */
/** One row of an organization's certificate register: no verification code, no link. */
export interface OrganizationCertificateListEntryResponse {
  readonly id: string;
  readonly certificateNumber: string | null;
  readonly issuanceStatus: string;
  readonly submissionId: string;
  readonly holder: { readonly displayName: string | null; readonly email: string } | null;
  readonly documentTypeName: string;
  readonly documentFormat: string;
  readonly standardCode: string;
  readonly standardName: string;
  readonly standardVersionLabel: string;
  readonly issuedAt: string | null;
  readonly revokedAt: string | null;
  readonly revocationReason: string | null;
  readonly createdAt: string;
}

export type OrganizationCertificateFilter = 'ISSUED' | 'REVOKED' | 'IN_PREPARATION' | 'FAILED';

export const certificateReviewApi = {
  list: (
    organizationId: string,
    query: {
      readonly status?: OrganizationCertificateFilter;
      readonly q?: string;
      readonly cursor?: string;
      readonly limit?: number;
    } = {},
  ) => {
    const params = new URLSearchParams();
    if (query.status !== undefined) params.set('status', query.status);
    if (query.q !== undefined && query.q.trim().length > 0) params.set('q', query.q.trim());
    if (query.cursor !== undefined) params.set('cursor', query.cursor);
    if (query.limit !== undefined) params.set('limit', String(query.limit));
    const suffix = params.toString();
    return apiRequest<PageResponse<OrganizationCertificateListEntryResponse>>(
      `/organizations/${organizationId}/certificates${suffix.length > 0 ? `?${suffix}` : ''}`,
    );
  },

  get: (organizationId: string, certificateId: string) =>
    apiRequest<CertificateResponse>(
      `/organizations/${organizationId}/certificates/${certificateId}`,
    ),

  events: (organizationId: string, certificateId: string) =>
    apiRequest<CertificateEventResponse[]>(
      `/organizations/${organizationId}/certificates/${certificateId}/events`,
    ),

  download: (organizationId: string, certificateId: string) =>
    apiRequest<DownloadAuthorizationResponse>(
      `/organizations/${organizationId}/certificates/${certificateId}/download`,
      { method: 'POST', body: {} },
    ),

  revoke: (
    organizationId: string,
    certificateId: string,
    body: { reasonCode: string; comment?: string },
  ) =>
    apiRequest<CertificateResponse>(
      `/organizations/${organizationId}/certificates/${certificateId}/revocation`,
      { method: 'POST', body },
    ),
};

/**
 * Verification, for whoever holds a code.
 *
 * Sent without credentials: a verifier is not signing in, and a page that
 * quietly used the reader's session could show a different answer to a
 * logged-in stranger than to an anonymous one.
 */
export async function verifyCertificate(
  verificationCode: string,
): Promise<PublicCertificateVerificationResponse> {
  const response = await fetch(
    `${API_BASE}/api/v1/public/certificates/${encodeURIComponent(verificationCode)}`,
    { method: 'GET', credentials: 'omit', headers: { accept: 'application/json' } },
  );
  const payload: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const body = payload as ApiErrorBody | null;
    throw new ApiError(
      body?.error?.code ?? (response.status === 429 ? 'RATE_LIMITED' : 'UNKNOWN'),
      body?.error?.message ?? 'Verification failed.',
      response.status,
    );
  }
  return payload as PublicCertificateVerificationResponse;
}

// --- Phase 16: notifications -----------------------------------------------

export interface UserNotificationResponse {
  readonly id: string;
  readonly notificationType: string;
  readonly title: string;
  readonly body: string;
  readonly locale: string;
  /** An application route. Never a bearer link, never a storage URL. */
  readonly deepLink: string;
  readonly createdAt: string;
  readonly readAt: string | null;
}

export interface NotificationPageResponse {
  readonly items: readonly UserNotificationResponse[];
  readonly nextCursor: string | null;
}

export interface UnreadNotificationCountResponse {
  readonly unread: number;
}

export interface NotificationPreferenceResponse {
  readonly notificationType: string;
  readonly emailEnabled: boolean;
  /** Why one row has no switch, so the screen can explain rather than refuse. */
  readonly mandatory: boolean;
}

/**
 * A person's own notifications.
 *
 * There is no organization counterpart to this client, here or in the API. A
 * notification is a private copy; the record that an institution was informed
 * is the submission's own history.
 */
export const notificationsApi = {
  list: (params: { cursor?: string; limit?: number } = {}) => {
    const query = new URLSearchParams();
    if (params.cursor !== undefined) query.set('cursor', params.cursor);
    if (params.limit !== undefined) query.set('limit', String(params.limit));
    const suffix = query.toString();
    return apiRequest<NotificationPageResponse>(
      suffix.length > 0 ? `/notifications?${suffix}` : '/notifications',
    );
  },

  unreadCount: () => apiRequest<UnreadNotificationCountResponse>('/notifications/unread-count'),

  markRead: (notificationId: string) =>
    apiRequest<UserNotificationResponse>(`/notifications/${notificationId}/read`, {
      method: 'POST',
      body: {},
    }),

  markAllRead: () =>
    apiRequest<{ marked: number }>('/notifications/read-all', { method: 'POST', body: {} }),

  preferences: () => apiRequest<NotificationPreferenceResponse[]>('/notifications/preferences'),

  setPreference: (notificationType: string, emailEnabled: boolean) =>
    apiRequest<NotificationPreferenceResponse>(`/notifications/preferences/${notificationType}`, {
      method: 'PUT',
      body: { emailEnabled },
    }),
};

// --- Webhooks (Phase 17) -----------------------------------------------------

export interface WebhookPendingConfigResponse {
  readonly configVersionId: string;
  readonly destination: string;
  readonly subscribedEventTypes: readonly string[];
  readonly configVersion: number;
  readonly status: string;
  readonly lastVerificationError: string | null;
  readonly lastVerificationAt: string | null;
  readonly createdAt: string;
}

export interface WebhookEndpointResponse {
  readonly id: string;
  readonly organizationId: string;
  readonly description: string;
  readonly status: string;
  readonly destination: string;
  readonly subscribedEventTypes: readonly string[];
  readonly configVersion: number;
  readonly configStatus: string;
  readonly verifiedAt: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly pendingConfig: WebhookPendingConfigResponse | null;
}

/**
 * The one response that carries a credential.
 *
 * Nothing in the client stores it. It is held in React state until the person
 * dismisses the panel, and that is the whole of its life in the browser —
 * `localStorage`, `sessionStorage`, the URL and the history would each outlive
 * the page, and a secret that outlives the page is a secret nobody decided to
 * keep.
 */
export interface WebhookSecretResponse {
  readonly endpointId: string;
  readonly operationId: string;
  readonly configVersion: number;
  readonly signingSecret: string;
  readonly recoverableUntil: string;
}

export interface WebhookDeliveryResponse {
  readonly id: string;
  readonly endpointId: string;
  /** Null for a control message, which projects no event. */
  readonly eventType: string | null;
  readonly kind: string;
  readonly status: string;
  readonly skipReason: string | null;
  readonly attemptCount: number;
  readonly nextAttemptAt: string | null;
  readonly lastErrorCode: string | null;
  readonly responseStatusCode: number | null;
  readonly replayOfDeliveryId: string | null;
  readonly createdAt: string;
  readonly completedAt: string | null;
}

export interface WebhookAttemptResponse {
  readonly id: string;
  readonly deliveryId: string;
  readonly attemptNumber: number;
  readonly outcome: string | null;
  readonly errorCode: string | null;
  readonly responseStatusCode: number | null;
  readonly durationMs: number | null;
  readonly startedAt: string;
  readonly finishedAt: string | null;
}

export interface WebhookVerificationAttemptResponse extends WebhookAttemptResponse {
  readonly operationId: string;
  readonly configVersionId: string;
}

export interface WebhookConfigVersionResponse {
  readonly id: string;
  readonly endpointId: string;
  readonly configVersion: number;
  readonly status: string;
  readonly destination: string;
  readonly lastVerificationError: string | null;
  readonly lastVerificationAt: string | null;
  readonly createdAt: string;
  readonly verifiedAt: string | null;
  readonly retiredAt: string | null;
}

export interface WebhookRotationPendingResponse {
  readonly endpointId: string;
  readonly currentConfigVersion: number | null;
  readonly unsettledOldConfigDeliveries: number;
}

/** A durable management intent recorded against an endpoint. */
export interface WebhookOperationResponse {
  readonly id: string;
  readonly operation: string;
  readonly endpointId: string | null;
  readonly configVersionId: string | null;
  readonly deliveryId: string | null;
  readonly settledAt: string | null;
  readonly settledErrorCode: string | null;
  readonly createdAt: string;
}

export interface WebhookDeliveryPageResponse {
  readonly items: readonly WebhookDeliveryResponse[];
  readonly nextCursor: string | null;
}

/**
 * An idempotency key belongs to the *action*, not to the request.
 *
 * Generating one inside the request method defeats the whole mechanism: a
 * caller whose response was lost retries, gets a fresh key, and creates a
 * second endpoint or mints a second secret — which is the exact failure the
 * server-side machinery exists to prevent. So every durable mutation takes the
 * key as an argument, and the caller keeps it for as long as the action means
 * the same thing.
 *
 * `newIdempotencyKey` is exported for callers to mint one per action.
 */
export function newIdempotencyKey(): string {
  return crypto.randomUUID();
}

function idempotency(key: string): Record<string, string> {
  return { 'Idempotency-Key': key };
}

export const webhooksApi = {
  listEndpoints: (organizationId: string) =>
    apiRequest<WebhookEndpointResponse[]>(`/organizations/${organizationId}/webhooks/endpoints`),

  getEndpoint: (organizationId: string, endpointId: string) =>
    apiRequest<WebhookEndpointResponse>(
      `/organizations/${organizationId}/webhooks/endpoints/${endpointId}`,
    ),

  createEndpoint: (
    organizationId: string,
    body: { description: string; url: string; eventTypes: readonly string[] },
    key: string,
  ) =>
    apiRequest<WebhookSecretResponse>(`/organizations/${organizationId}/webhooks/endpoints`, {
      method: 'POST',
      body,
      headers: idempotency(key),
    }),

  operations: (organizationId: string, endpointId: string) =>
    apiRequest<WebhookOperationResponse[]>(
      `/organizations/${organizationId}/webhooks/endpoints/${endpointId}/operations`,
    ),

  updateDescription: (organizationId: string, endpointId: string, description: string) =>
    apiRequest<void>(
      `/organizations/${organizationId}/webhooks/endpoints/${endpointId}/description`,
      { method: 'PUT', body: { description } },
    ),

  updateUrl: (organizationId: string, endpointId: string, url: string, key: string) =>
    apiRequest<{ operationId: string; configVersion: number }>(
      `/organizations/${organizationId}/webhooks/endpoints/${endpointId}/url`,
      { method: 'PUT', body: { url }, headers: idempotency(key) },
    ),

  verify: (organizationId: string, endpointId: string, key: string) =>
    apiRequest<{ operationId: string; configVersion: number }>(
      `/organizations/${organizationId}/webhooks/endpoints/${endpointId}/verify`,
      { method: 'POST', body: {}, headers: idempotency(key) },
    ),

  lifecycle: (organizationId: string, endpointId: string, action: 'pause' | 'resume' | 'disable') =>
    apiRequest<void>(
      `/organizations/${organizationId}/webhooks/endpoints/${endpointId}/${action}`,
      { method: 'POST', body: {} },
    ),

  replaceSubscriptions: (
    organizationId: string,
    endpointId: string,
    eventTypes: readonly string[],
  ) =>
    apiRequest<readonly string[]>(
      `/organizations/${organizationId}/webhooks/endpoints/${endpointId}/subscriptions`,
      { method: 'PUT', body: { eventTypes } },
    ),

  test: (organizationId: string, endpointId: string, key: string) =>
    apiRequest<{ deliveryId: string }>(
      `/organizations/${organizationId}/webhooks/endpoints/${endpointId}/test`,
      { method: 'POST', body: {}, headers: idempotency(key) },
    ),

  rotateSecret: (organizationId: string, endpointId: string, key: string) =>
    apiRequest<WebhookSecretResponse>(
      `/organizations/${organizationId}/webhooks/endpoints/${endpointId}/rotate-secret`,
      { method: 'POST', body: {}, headers: idempotency(key) },
    ),

  rotationPending: (organizationId: string, endpointId: string) =>
    apiRequest<WebhookRotationPendingResponse>(
      `/organizations/${organizationId}/webhooks/endpoints/${endpointId}/rotation-pending`,
    ),

  deliveries: (organizationId: string, params: { endpointId?: string; cursor?: string } = {}) => {
    const query = new URLSearchParams();
    if (params.endpointId !== undefined) query.set('endpointId', params.endpointId);
    if (params.cursor !== undefined) query.set('cursor', params.cursor);
    const suffix = query.toString();
    return apiRequest<WebhookDeliveryPageResponse>(
      `/organizations/${organizationId}/webhooks/deliveries${suffix.length > 0 ? `?${suffix}` : ''}`,
    );
  },

  attempts: (organizationId: string, deliveryId: string) =>
    apiRequest<readonly WebhookAttemptResponse[]>(
      `/organizations/${organizationId}/webhooks/deliveries/${deliveryId}/attempts`,
    ),

  replay: (organizationId: string, deliveryId: string, key: string) =>
    apiRequest<{ deliveryId: string }>(
      `/organizations/${organizationId}/webhooks/deliveries/${deliveryId}/replay`,
      { method: 'POST', body: {}, headers: idempotency(key) },
    ),

  verificationAttempts: (organizationId: string, endpointId: string) =>
    apiRequest<readonly WebhookVerificationAttemptResponse[]>(
      `/organizations/${organizationId}/webhooks/endpoints/${endpointId}/verification-attempts`,
    ),

  configVersions: (organizationId: string, endpointId: string) =>
    apiRequest<readonly WebhookConfigVersionResponse[]>(
      `/organizations/${organizationId}/webhooks/endpoints/${endpointId}/config-versions`,
    ),
};

// --- API clients (Phase 19) -------------------------------------------------

/**
 * A credential holder, as an administrator sees it.
 *
 * Mirrors `ApiClientView` deliberately field for field, including the fact
 * that there is nowhere on it to put a secret. A screen cannot render what the
 * type cannot hold.
 */
export interface ApiClientResponse {
  readonly apiClientId: string;
  readonly organizationId: string;
  readonly clientId: string;
  readonly displayName: string;
  readonly description: string | null;
  readonly status: string;
  readonly scopes: readonly string[];
  readonly createdAt: string;
  readonly createdByUserId: string;
  readonly expiresAt: string | null;
  readonly revokedAt: string | null;
  readonly disabledAt: string | null;
  readonly lastUsedAt: string | null;
  readonly liveSecretCount: number;
  readonly rotationOverlapEndsAt: string | null;
}

/**
 * The one response that carries a credential.
 *
 * Held in React state until the person dismisses the panel, and put nowhere
 * else — not `localStorage`, not the URL, not a store that outlives the page.
 */
export interface ApiClientSecretResponse {
  readonly client: ApiClientResponse;
  readonly clientSecret: string;
  readonly previousSecretRetiresAt: string | null;
}

/** What a scope unlocks, served rather than hard-coded into the screen. */
export interface ApiClientScopeResponse {
  readonly scope: string;
  readonly operations: readonly string[];
  readonly write: boolean;
}

export const apiClientsApi = {
  scopes: (organizationId: string) =>
    apiRequest<readonly ApiClientScopeResponse[]>(
      `/organizations/${organizationId}/api-clients/scopes`,
    ),

  list: (organizationId: string) =>
    apiRequest<readonly ApiClientResponse[]>(`/organizations/${organizationId}/api-clients`),

  create: (
    organizationId: string,
    body: {
      displayName: string;
      description?: string;
      scopes: readonly string[];
      expiresAt?: string;
    },
    key: string,
  ) =>
    apiRequest<ApiClientSecretResponse>(`/organizations/${organizationId}/api-clients`, {
      method: 'POST',
      body,
      headers: idempotency(key),
    }),

  rotateSecret: (
    organizationId: string,
    apiClientId: string,
    overlapSeconds: number,
    key: string,
  ) =>
    apiRequest<ApiClientSecretResponse>(
      `/organizations/${organizationId}/api-clients/${apiClientId}/secret`,
      { method: 'POST', body: { overlapSeconds }, headers: idempotency(key) },
    ),

  setEnabled: (organizationId: string, apiClientId: string, enabled: boolean) =>
    apiRequest<ApiClientResponse>(
      `/organizations/${organizationId}/api-clients/${apiClientId}/enabled`,
      { method: 'POST', body: { enabled } },
    ),

  revoke: (organizationId: string, apiClientId: string) =>
    apiRequest<ApiClientResponse>(
      `/organizations/${organizationId}/api-clients/${apiClientId}/revocation`,
      { method: 'POST', body: {} },
    ),
};

// ---------------------------------------------------------------------------
// PalCert staff administration
// ---------------------------------------------------------------------------
//
// Every route below is refused by the API to anyone without the matching
// `admin:*`, `pricing:*` or `finance:*` permission. The console hides what a
// person cannot use; the API is what actually decides.

export interface AdminOverviewResponse {
  readonly generatedAt: string;
  readonly organizations: {
    readonly total: number;
    readonly byStatus: Readonly<Record<string, number>>;
    readonly byVerificationStatus: Readonly<Record<string, number>>;
    readonly pendingVerificationRequests: number;
  };
  readonly users: { readonly total: number; readonly byStatus: Readonly<Record<string, number>> };
}

export interface AdminVerificationRequestResponse {
  readonly id: string;
  readonly status: string;
  readonly requestedAt: string;
  readonly submissionNote: string | null;
  readonly reviewedAt: string | null;
  readonly decisionReason: string | null;
  /** Present only for staff who may decide verification. */
  readonly internalNotes?: string | null;
}

export interface AdminOrganizationDetailResponse {
  readonly organization: OrganizationProfileResponse;
  readonly suspendedAt: string | null;
  readonly suspensionReason: string | null;
  readonly verificationRequests: readonly AdminVerificationRequestResponse[];
}

export interface PendingVerificationResponse {
  readonly requestId: string;
  readonly organizationId: string;
  readonly organizationName: string;
  readonly requestedAt: string;
  readonly submissionNote: string | null;
}

/** One row of the staff user list: no roles, no permissions, no hash. */
export interface AdminUserSummaryResponse {
  readonly id: string;
  readonly email: string;
  readonly displayName: string | null;
  readonly status: string;
  readonly emailVerified: boolean;
  readonly createdAt: string;
  readonly lastLoginAt: string | null;
}

/** The API's page size for the staff user list. */
export const ADMIN_USER_PAGE_SIZE = 50;

export const adminApi = {
  overview: () => apiRequest<AdminOverviewResponse>('/admin/overview'),

  organizations: (query: { readonly cursor?: string; readonly limit?: number } = {}) => {
    const params = new URLSearchParams();
    if (query.cursor !== undefined) params.set('cursor', query.cursor);
    if (query.limit !== undefined) params.set('limit', String(query.limit));
    const suffix = params.toString();
    return apiRequest<PageResponse<OrganizationProfileResponse>>(
      `/admin/organizations${suffix.length > 0 ? `?${suffix}` : ''}`,
    );
  },

  verificationQueue: () =>
    apiRequest<PendingVerificationResponse[]>('/admin/organizations/verification-queue'),

  organization: (organizationId: string) =>
    apiRequest<AdminOrganizationDetailResponse>(`/admin/organizations/${organizationId}`),

  decideVerification: (
    organizationId: string,
    body: { approve: boolean; decisionReason?: string; internalNotes?: string },
  ) =>
    apiRequest<{ status: string }>(`/admin/organizations/${organizationId}/verification`, {
      method: 'POST',
      body,
    }),

  suspendOrganization: (organizationId: string, reason?: string) =>
    apiRequest<{ id: string; status: string }>(`/admin/organizations/${organizationId}/suspend`, {
      method: 'POST',
      body: reason === undefined || reason.trim() === '' ? {} : { reason: reason.trim() },
    }),

  reactivateOrganization: (organizationId: string) =>
    apiRequest<{ id: string; status: string }>(
      `/admin/organizations/${organizationId}/reactivate`,
      { method: 'POST', body: {} },
    ),

  users: (query: { readonly q?: string; readonly cursor?: string } = {}) => {
    const params = new URLSearchParams();
    if (query.q !== undefined && query.q.trim().length > 0) params.set('q', query.q.trim());
    if (query.cursor !== undefined) params.set('cursor', query.cursor);
    const suffix = params.toString();
    return apiRequest<AdminUserSummaryResponse[]>(
      `/admin/users${suffix.length > 0 ? `?${suffix}` : ''}`,
    );
  },

  user: (userId: string) => apiRequest<UserProfileResponse>(`/admin/users/${userId}`),

  suspendUser: (userId: string, reason?: string) =>
    apiRequest<UserProfileResponse>(`/admin/users/${userId}/suspend`, {
      method: 'POST',
      body: reason === undefined || reason.trim() === '' ? {} : { reason: reason.trim() },
    }),

  reactivateUser: (userId: string) =>
    apiRequest<UserProfileResponse>(`/admin/users/${userId}/reactivate`, {
      method: 'POST',
      body: {},
    }),

  grantRole: (userId: string, roleCode: string) =>
    apiRequest<UserProfileResponse>(`/admin/users/${userId}/roles`, {
      method: 'POST',
      body: { roleCode },
    }),

  removeRole: (userId: string, roleCode: string) =>
    apiRequest<UserProfileResponse>(
      `/admin/users/${userId}/roles/${encodeURIComponent(roleCode)}`,
      { method: 'DELETE', body: {} },
    ),
};

export interface PriceVersionResponse {
  readonly id: string;
  readonly productCode: string;
  readonly marketCode: string;
  readonly amount: MoneyResponse;
  readonly status: string;
  readonly effectiveFrom: string | null;
  readonly effectiveUntil: string | null;
  readonly createdAt: string;
  readonly activatedAt: string | null;
}

export interface AdminBalanceResponse extends BalanceSummaryResponse {
  readonly ownerUserId: string;
}

export interface AdminServicePurchaseResponse {
  readonly purchaseId: string;
  readonly productCode: string;
  readonly status: string;
  readonly amount: MoneyResponse;
  readonly reserved: MoneyResponse;
  readonly charged: MoneyResponse;
  readonly failureCode: string | null;
  readonly createdAt: string;
  readonly deliveredAt: string | null;
  readonly releasedAt: string | null;
  readonly refundedAt: string | null;
  readonly resourceType: string;
  readonly resourceId: string;
  readonly currency: string;
  readonly allocations: readonly {
    readonly creditClass: string;
    readonly amount: MoneyResponse;
    readonly holdStatus: string;
  }[];
}

export interface LedgerVerificationResponse {
  readonly checkedAt: string;
  readonly accountsChecked: number;
  readonly entriesChecked: number;
  readonly findings: readonly { code: string; detail: string; subjectId: string }[];
  readonly consistent: boolean;
}

/** Purchases per product and currency (ADR-0149). One row per currency; never summed across. */
export interface PurchaseSummaryRowResponse {
  productCode: string;
  currency: string;
  purchaseCount: number;
  reservedCount: number;
  reservedAmount: MoneyResponse;
  capturedCount: number;
  capturedAmount: MoneyResponse;
  releasedCount: number;
  refundedCount: number;
  refundedAmount: MoneyResponse;
  reconciliationCount: number;
}

export interface PurchaseSummaryResponse {
  from: string | null;
  to: string | null;
  rows: PurchaseSummaryRowResponse[];
}

export interface AdminPurchaseReportRowResponse {
  purchaseId: string;
  productCode: string;
  resourceType: string;
  resourceId: string;
  status: string;
  amount: MoneyResponse;
  payer: { userId: string; email: string; displayName: string | null };
  organization: { id: string; name: string } | null;
  failureCode: string | null;
  createdAt: string;
  deliveredAt: string | null;
  releasedAt: string | null;
}

export interface PurchaseReportFilter {
  productCode?: string;
  currency?: string;
  from?: string;
  to?: string;
  status?: string;
  limit?: number;
}

function purchaseReportQuery(filter: PurchaseReportFilter): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(filter)) {
    if (value !== undefined && value !== '') params.set(key, String(value));
  }
  const query = params.toString();
  return query === '' ? '' : `?${query}`;
}

export const financeAdminApi = {
  purchaseSummary: (filter: PurchaseReportFilter = {}) =>
    apiRequest<PurchaseSummaryResponse>(
      `/admin/finance/purchases/summary${purchaseReportQuery(filter)}`,
    ),

  purchaseReport: (filter: PurchaseReportFilter = {}) =>
    apiRequest<AdminPurchaseReportRowResponse[]>(
      `/admin/finance/purchases${purchaseReportQuery(filter)}`,
    ),
  prices: () => apiRequest<PriceVersionResponse[]>('/admin/finance/prices'),

  createPrice: (body: {
    productCode: string;
    currency: string;
    amountMinorUnits: string;
    marketCode?: string;
  }) => apiRequest<PriceVersionResponse>('/admin/finance/prices', { method: 'POST', body }),

  activatePrice: (priceVersionId: string) =>
    apiRequest<PriceVersionResponse>(`/admin/finance/prices/${priceVersionId}/activate`, {
      method: 'POST',
      body: {},
    }),

  retirePrice: (priceVersionId: string) =>
    apiRequest<PriceVersionResponse>(`/admin/finance/prices/${priceVersionId}/retire`, {
      method: 'POST',
      body: {},
    }),

  balance: (ownerUserId: string, currency?: string) =>
    apiRequest<AdminBalanceResponse>(
      `/admin/finance/customers/${ownerUserId}/balance${
        currency === undefined ? '' : `?currency=${encodeURIComponent(currency)}`
      }`,
    ),

  payments: (ownerUserId: string) =>
    apiRequest<BalanceTopUpResponse[]>(`/admin/finance/customers/${ownerUserId}/payments`),

  purchases: (ownerUserId: string) =>
    apiRequest<AdminServicePurchaseResponse[]>(`/admin/finance/customers/${ownerUserId}/purchases`),

  adjust: (body: {
    ownerUserId: string;
    currency: string;
    creditClass: string;
    amountMinorUnits: string;
    reasonCode: string;
    idempotencyKey: string;
    note?: string;
  }) => apiRequest<LedgerEntryResponse>('/admin/finance/adjustments', { method: 'POST', body }),

  refund: (body: { topUpId: string; amountMinorUnits: string; reason: string }) =>
    apiRequest<PaymentRefundResponse>('/admin/finance/refunds', { method: 'POST', body }),

  refundById: (refundId: string) =>
    apiRequest<PaymentRefundResponse>(`/admin/finance/refunds/${refundId}`),

  verifyLedger: () => apiRequest<LedgerVerificationResponse>('/admin/finance/verify-ledger'),
};
