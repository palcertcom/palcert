import type {
  AdminWithdrawalRequestView,
  OrganizationEarningsView,
  PayoutDestinationInput,
  PayoutDestinationView,
  PlatformFundsView,
  UserWithdrawableView,
  WithdrawalDestinationRevealView,
  WithdrawalNotificationReportView,
  WithdrawalPolicyView,
  WithdrawalProofUploadResponse,
  WithdrawalQueueView,
  WithdrawalReconciliationView,
  WithdrawalRequestView,
  WithdrawalReviewerCandidateView,
  WithdrawalReviewerView,
  WithdrawalScope,
  WithdrawalStatus,
} from '@palcert/contracts/finance/withdrawals';
import { apiRequest, type DownloadAuthorizationResponse } from './api-client';

/**
 * Withdrawals and payouts, as the browser calls them (ADR-0150).
 *
 * Nothing here moves money by itself. A requester can ask and cancel;
 * finance can approve and record a transfer made outside PalCert. Every
 * permission, limit and separation-of-duties rule is the API's to enforce —
 * a hidden button is only a courtesy.
 */
function query(params: Readonly<Record<string, string | number | undefined>>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== '') search.set(key, String(value));
  }
  const text = search.toString();
  return text.length > 0 ? `?${text}` : '';
}

const id = (value: string): string => encodeURIComponent(value);

export interface Page<T> {
  readonly items: T[];
  readonly nextCursor: string | null;
}

export interface SubmitInput {
  readonly currency: string;
  readonly amountMinorUnits: string;
  readonly destinationId: string;
  readonly note?: string;
}

export interface HistoryParams {
  readonly status?: WithdrawalStatus;
  readonly cursor?: string;
  readonly limit?: number;
}

/** A destination body: absent fields are omitted, never sent as null. */
function destinationBody(input: PayoutDestinationInput): Record<string, string> {
  const body: Record<string, string> = {
    type: input.type,
    label: input.label,
    beneficiaryName: input.beneficiaryName,
  };
  for (const key of [
    'currency',
    'bankName',
    'iban',
    'accountNumber',
    'branch',
    'mobileNumber',
    'instructions',
  ] as const) {
    const value = input[key];
    if (value !== null && value.trim() !== '') body[key] = value;
  }
  return body;
}

/** The routes one beneficiary's destinations and requests live under. */
export interface PayoutScopeApi {
  readonly destinations: (includeArchived?: boolean) => Promise<PayoutDestinationView[]>;
  readonly createDestination: (input: PayoutDestinationInput) => Promise<PayoutDestinationView>;
  readonly updateDestination: (
    destinationId: string,
    input: PayoutDestinationInput,
    expectedVersion: number,
  ) => Promise<PayoutDestinationView>;
  readonly archiveDestination: (
    destinationId: string,
    expectedVersion: number,
  ) => Promise<PayoutDestinationView>;
  readonly submit: (input: SubmitInput, idempotencyKey: string) => Promise<WithdrawalRequestView>;
  readonly list: (params?: HistoryParams) => Promise<Page<WithdrawalRequestView>>;
  readonly cancel: (requestId: string, expectedVersion: number) => Promise<WithdrawalRequestView>;
}

function scopeApi(destinationsPath: string, requestsPath: string): PayoutScopeApi {
  return {
    destinations: (includeArchived = false) =>
      apiRequest<PayoutDestinationView[]>(
        `${destinationsPath}${query({ includeArchived: includeArchived ? 'true' : undefined })}`,
      ),
    createDestination: (input) =>
      apiRequest<PayoutDestinationView>(destinationsPath, {
        method: 'POST',
        body: destinationBody(input),
      }),
    updateDestination: (destinationId, input, expectedVersion) =>
      apiRequest<PayoutDestinationView>(`${destinationsPath}/${id(destinationId)}`, {
        method: 'PATCH',
        body: { ...destinationBody(input), expectedVersion },
      }),
    archiveDestination: (destinationId, expectedVersion) =>
      apiRequest<PayoutDestinationView>(`${destinationsPath}/${id(destinationId)}/archive`, {
        method: 'POST',
        body: { expectedVersion },
      }),
    submit: (input, idempotencyKey) =>
      apiRequest<WithdrawalRequestView>(requestsPath, {
        method: 'POST',
        body: input,
        headers: { 'Idempotency-Key': idempotencyKey },
      }),
    list: (params = {}) =>
      apiRequest<Page<WithdrawalRequestView>>(`${requestsPath}${query({ ...params })}`),
    cancel: (requestId, expectedVersion) =>
      apiRequest<WithdrawalRequestView>(`${requestsPath}/${id(requestId)}/cancel`, {
        method: 'POST',
        body: { expectedVersion },
      }),
  };
}

/** A person's own money. */
export const userWithdrawalsApi = {
  ...scopeApi('/balance/payout-destinations', '/balance/withdrawals'),
  withdrawable: (currency: string) =>
    apiRequest<UserWithdrawableView>(`/balance/withdrawable${query({ currency })}`),
  get: (requestId: string) =>
    apiRequest<WithdrawalRequestView>(`/balance/withdrawals/${id(requestId)}`),
  proof: (requestId: string) =>
    apiRequest<DownloadAuthorizationResponse>(`/balance/withdrawals/${id(requestId)}/proof`),
};

/** An organization's earnings, from the verified tenant in the path. */
export function organizationPayoutsApi(organizationId: string) {
  const base = `/organizations/${id(organizationId)}/payouts`;
  return {
    ...scopeApi(`${base}/destinations`, base),
    earnings: () => apiRequest<OrganizationEarningsView>(`${base}/earnings`),
    get: (requestId: string) => apiRequest<WithdrawalRequestView>(`${base}/${id(requestId)}`),
    proof: (requestId: string) =>
      apiRequest<DownloadAuthorizationResponse>(`${base}/${id(requestId)}/proof`),
  };
}

/** PalCert's own revenue and treasury. */
export const platformFundsApi = {
  ...scopeApi('/admin/platform-funds/destinations', '/admin/platform-funds/withdrawals'),
  funds: () => apiRequest<PlatformFundsView>('/admin/platform-funds'),
};

export interface QueueParams {
  readonly status?: WithdrawalStatus;
  readonly scope?: WithdrawalScope;
  readonly currency?: string;
  readonly organizationId?: string;
  readonly requesterUserId?: string;
  readonly from?: string;
  readonly to?: string;
  readonly cursor?: string;
  readonly limit?: number;
}

/** PalCert finance's queue and actions. */
export const withdrawalAdminApi = {
  queue: (params: QueueParams = {}) =>
    apiRequest<WithdrawalQueueView>(`/admin/withdrawals${query({ ...params })}`),
  get: (requestId: string) =>
    apiRequest<AdminWithdrawalRequestView>(`/admin/withdrawals/${id(requestId)}`),
  revealDestination: (requestId: string) =>
    apiRequest<WithdrawalDestinationRevealView>(`/admin/withdrawals/${id(requestId)}/destination`),
  notifications: (requestId: string) =>
    apiRequest<WithdrawalNotificationReportView>(
      `/admin/withdrawals/${id(requestId)}/notifications`,
    ),
  startReview: (requestId: string) =>
    apiRequest<AdminWithdrawalRequestView>(`/admin/withdrawals/${id(requestId)}/start-review`, {
      method: 'POST',
    }),
  approve: (request: AdminWithdrawalRequestView) =>
    apiRequest<AdminWithdrawalRequestView>(`/admin/withdrawals/${id(request.id)}/approve`, {
      method: 'POST',
      body: {
        expectedVersion: request.version,
        confirmAmountMinorUnits: request.amount.minorUnits,
        confirmCurrency: request.amount.currency,
      },
    }),
  reject: (request: AdminWithdrawalRequestView, reason: string, note: string | null) =>
    apiRequest<AdminWithdrawalRequestView>(`/admin/withdrawals/${id(request.id)}/reject`, {
      method: 'POST',
      body: { expectedVersion: request.version, reason, ...(note ? { note } : {}) },
    }),
  startExecution: (request: AdminWithdrawalRequestView) =>
    apiRequest<AdminWithdrawalRequestView>(`/admin/withdrawals/${id(request.id)}/start-execution`, {
      method: 'POST',
      body: { expectedVersion: request.version },
    }),
  markPaid: (request: AdminWithdrawalRequestView, reference: string, note: string | null) =>
    apiRequest<AdminWithdrawalRequestView>(`/admin/withdrawals/${id(request.id)}/mark-paid`, {
      method: 'POST',
      body: {
        expectedVersion: request.version,
        externalTransferReference: reference,
        confirmAmountMinorUnits: request.amount.minorUnits,
        confirmCurrency: request.amount.currency,
        ...(note ? { note } : {}),
      },
    }),
  markFailed: (request: AdminWithdrawalRequestView, note: string) =>
    apiRequest<AdminWithdrawalRequestView>(`/admin/withdrawals/${id(request.id)}/mark-failed`, {
      method: 'POST',
      body: { expectedVersion: request.version, note },
    }),
  release: (request: AdminWithdrawalRequestView, note: string) =>
    apiRequest<AdminWithdrawalRequestView>(`/admin/withdrawals/${id(request.id)}/release`, {
      method: 'POST',
      body: { expectedVersion: request.version, note },
    }),
  createProof: (
    requestId: string,
    file: { originalFilename: string; sizeBytes: number; declaredMimeType?: string },
    idempotencyKey: string,
  ) =>
    apiRequest<WithdrawalProofUploadResponse>(`/admin/withdrawals/${id(requestId)}/proofs`, {
      method: 'POST',
      body: file,
      headers: { 'Idempotency-Key': idempotencyKey },
    }),
  finalizeProof: (requestId: string, proofId: string) =>
    apiRequest<AdminWithdrawalRequestView>(
      `/admin/withdrawals/${id(requestId)}/proofs/${id(proofId)}/finalize`,
      { method: 'POST' },
    ),
  proof: (requestId: string) =>
    apiRequest<DownloadAuthorizationResponse>(`/admin/withdrawals/${id(requestId)}/proof`),
};

/** Policy, limits, reviewers and the consistency check. */
export const withdrawalSettingsApi = {
  policy: () => apiRequest<WithdrawalPolicyView>('/admin/withdrawal-settings/policy'),
  updatePolicy: (input: {
    userManualTopUpClearingDays: number;
    organizationClearingDays: number;
    expectedVersion: number;
  }) =>
    apiRequest<WithdrawalPolicyView>('/admin/withdrawal-settings/policy', {
      method: 'PUT',
      body: input,
    }),
  setLimit: (
    currency: string,
    minAmountMinorUnits: string | null,
    maxAmountMinorUnits: string | null,
  ) =>
    apiRequest<WithdrawalPolicyView>('/admin/withdrawal-settings/limits', {
      method: 'PUT',
      body: {
        currency,
        ...(minAmountMinorUnits === null ? {} : { minAmountMinorUnits }),
        ...(maxAmountMinorUnits === null ? {} : { maxAmountMinorUnits }),
      },
    }),
  reviewers: () => apiRequest<WithdrawalReviewerView[]>('/admin/withdrawal-settings/reviewers'),
  candidates: () =>
    apiRequest<WithdrawalReviewerCandidateView[]>(
      '/admin/withdrawal-settings/reviewers/candidates',
    ),
  replaceReviewers: (userIds: string[]) =>
    apiRequest<WithdrawalReviewerView[]>('/admin/withdrawal-settings/reviewers', {
      method: 'PUT',
      body: { userIds },
    }),
  reconcile: () =>
    apiRequest<WithdrawalReconciliationView>('/admin/withdrawal-settings/reconciliation', {
      method: 'POST',
    }),
};
