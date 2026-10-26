import type {
  AdminManualPaymentMethodView,
  AdminManualTopUpQueueView,
  AdminManualTopUpRequestView,
  ManualPaymentMethodLogoUploadResponse,
  ManualPaymentMethodView,
  ManualTopUpNotificationReportView,
  ManualTopUpReceiptUploadResponse,
  ManualTopUpReviewerCandidateView,
  ManualTopUpRequestView,
  ManualTopUpStatus,
} from '@palcert/contracts/finance/manual-topups';
import { apiRequest, type DownloadAuthorizationResponse } from './api-client';

/**
 * Manual top-ups, as the browser calls them.
 *
 * Nothing here can credit a balance. A person can report a transfer and
 * cancel their own report; only PalCert finance, through the admin routes,
 * can approve one — and the API decides that, not this file.
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

export interface FileDeclaration {
  readonly originalFilename: string;
  readonly sizeBytes: number;
  readonly declaredMimeType?: string;
}

export interface DraftFields {
  readonly amountMinorUnits?: string | null;
  readonly reference?: string | null;
  readonly customerNote?: string | null;
  readonly removeReceipt?: boolean;
}

export const manualTopUpsApi = {
  methods: () => apiRequest<ManualPaymentMethodView[]>('/balance/manual-payment-methods'),

  create: (paymentMethodId: string, fields: DraftFields, idempotencyKey: string) =>
    apiRequest<ManualTopUpRequestView>('/balance/manual-topups', {
      method: 'POST',
      body: { paymentMethodId, ...fields },
      headers: { 'Idempotency-Key': idempotencyKey },
    }),

  list: (params: { status?: ManualTopUpStatus; cursor?: string; limit?: number } = {}) =>
    apiRequest<{ items: ManualTopUpRequestView[]; nextCursor: string | null }>(
      `/balance/manual-topups${query(params)}`,
    ),

  get: (requestId: string) =>
    apiRequest<ManualTopUpRequestView>(`/balance/manual-topups/${id(requestId)}`),

  update: (requestId: string, fields: DraftFields) =>
    apiRequest<ManualTopUpRequestView>(`/balance/manual-topups/${id(requestId)}`, {
      method: 'PATCH',
      body: fields,
    }),

  createReceipt: (requestId: string, file: FileDeclaration, idempotencyKey: string) =>
    apiRequest<ManualTopUpReceiptUploadResponse>(
      `/balance/manual-topups/${id(requestId)}/receipt`,
      {
        method: 'POST',
        body: file,
        headers: { 'Idempotency-Key': idempotencyKey },
      },
    ),

  finalizeReceipt: (requestId: string, receiptId: string) =>
    apiRequest<ManualTopUpRequestView>(
      `/balance/manual-topups/${id(requestId)}/receipt/${id(receiptId)}/finalize`,
      { method: 'POST' },
    ),

  receipt: (requestId: string) =>
    apiRequest<DownloadAuthorizationResponse>(
      `/balance/manual-topups/${id(requestId)}/receipt/download`,
    ),

  submit: (requestId: string) =>
    apiRequest<ManualTopUpRequestView>(`/balance/manual-topups/${id(requestId)}/submit`, {
      method: 'POST',
    }),

  cancel: (requestId: string) =>
    apiRequest<ManualTopUpRequestView>(`/balance/manual-topups/${id(requestId)}/cancel`, {
      method: 'POST',
    }),
};

export interface PaymentMethodInput {
  readonly code?: string;
  readonly type: string;
  readonly nameEn: string;
  readonly nameAr: string;
  readonly descriptionEn: string | null;
  readonly descriptionAr: string | null;
  readonly currency: string;
  readonly recipientName: string | null;
  readonly mobileNumber: string | null;
  readonly iban: string | null;
  readonly bankName: string | null;
  readonly accountNumber: string | null;
  readonly branchName: string | null;
  readonly instructionsEn: string | null;
  readonly instructionsAr: string | null;
  readonly minAmountMinorUnits: string;
  readonly maxAmountMinorUnits: string;
  readonly displayOrder: number;
  readonly reviewerUserIds: readonly string[];
}

export interface QueueParams {
  readonly status?: ManualTopUpStatus;
  readonly paymentMethodId?: string;
  readonly currency?: string;
  readonly reference?: string;
  readonly cursor?: string;
  readonly limit?: number;
}

export const paymentMethodsAdminApi = {
  list: () => apiRequest<AdminManualPaymentMethodView[]>('/admin/payment-methods'),
  reviewerCandidates: () =>
    apiRequest<ManualTopUpReviewerCandidateView[]>('/admin/payment-methods/reviewer-candidates'),
  get: (methodId: string) =>
    apiRequest<AdminManualPaymentMethodView>(`/admin/payment-methods/${id(methodId)}`),
  create: (input: PaymentMethodInput) =>
    apiRequest<AdminManualPaymentMethodView>('/admin/payment-methods', {
      method: 'POST',
      body: input,
    }),
  update: (methodId: string, input: PaymentMethodInput, expectedVersion: number) =>
    apiRequest<AdminManualPaymentMethodView>(`/admin/payment-methods/${id(methodId)}`, {
      method: 'PATCH',
      body: { ...input, code: undefined, expectedVersion },
    }),
  setEnabled: (methodId: string, enabled: boolean, expectedVersion: number) =>
    apiRequest<AdminManualPaymentMethodView>(
      `/admin/payment-methods/${id(methodId)}/${enabled ? 'enable' : 'disable'}`,
      { method: 'POST', body: { expectedVersion } },
    ),
  archive: (methodId: string, expectedVersion: number) =>
    apiRequest<AdminManualPaymentMethodView>(`/admin/payment-methods/${id(methodId)}/archive`, {
      method: 'POST',
      body: { expectedVersion },
    }),
  createLogo: (methodId: string, file: FileDeclaration, idempotencyKey: string) =>
    apiRequest<ManualPaymentMethodLogoUploadResponse>(
      `/admin/payment-methods/${id(methodId)}/logo`,
      { method: 'POST', body: file, headers: { 'Idempotency-Key': idempotencyKey } },
    ),
  finalizeLogo: (methodId: string, logoId: string) =>
    apiRequest<AdminManualPaymentMethodView>(
      `/admin/payment-methods/${id(methodId)}/logo/${id(logoId)}/finalize`,
      { method: 'POST' },
    ),
  removeLogo: (methodId: string, expectedVersion: number) =>
    apiRequest<AdminManualPaymentMethodView>(`/admin/payment-methods/${id(methodId)}/logo/remove`, {
      method: 'POST',
      body: { expectedVersion },
    }),
};

export const manualTopUpsAdminApi = {
  queue: (params: QueueParams = {}) =>
    apiRequest<AdminManualTopUpQueueView>(
      `/admin/manual-topups${query(params as Record<string, string | number | undefined>)}`,
    ),
  get: (requestId: string) =>
    apiRequest<AdminManualTopUpRequestView>(`/admin/manual-topups/${id(requestId)}`),
  receipt: (requestId: string) =>
    apiRequest<DownloadAuthorizationResponse>(`/admin/manual-topups/${id(requestId)}/receipt`),
  notificationReport: (requestId: string) =>
    apiRequest<ManualTopUpNotificationReportView>(
      `/admin/manual-topups/${id(requestId)}/notifications`,
    ),
  startReview: (requestId: string) =>
    apiRequest<AdminManualTopUpRequestView>(`/admin/manual-topups/${id(requestId)}/start-review`, {
      method: 'POST',
    }),
  approve: (requestId: string, confirmAmountMinorUnits: string, confirmCurrency: string) =>
    apiRequest<AdminManualTopUpRequestView>(`/admin/manual-topups/${id(requestId)}/approve`, {
      method: 'POST',
      body: { confirmAmountMinorUnits, confirmCurrency },
    }),
  reject: (requestId: string, reason: string, note: string | null) =>
    apiRequest<AdminManualTopUpRequestView>(`/admin/manual-topups/${id(requestId)}/reject`, {
      method: 'POST',
      body: { reason, ...(note === null || note.trim() === '' ? {} : { note }) },
    }),
};
