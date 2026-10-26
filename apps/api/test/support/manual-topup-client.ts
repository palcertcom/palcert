import { ProcessingJobType } from '@palcert/contracts';
import type request from 'supertest';
import { API, type AuthClient } from './auth-client';
import { expectStatus } from './checks-client';
import type { TestContext } from './test-app';

export const METHODS = `${API}/admin/payment-methods`;
export const REVIEW = `${API}/admin/manual-topups`;
export const OWN = `${API}/balance/manual-topups`;
export const CATALOGUE = `${API}/balance/manual-payment-methods`;

/** A valid IBAN (ISO 13616 example), so the checksum path is real. */
export const VALID_IBAN = 'GB82WEST12345698765432';

export function walletMethod(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    code: 'JAWWAL_PAY',
    type: 'MOBILE_WALLET',
    nameEn: 'Jawwal Pay',
    nameAr: 'جوال باي',
    descriptionEn: 'Send from the Jawwal Pay app.',
    descriptionAr: 'أرسل من تطبيق جوال باي.',
    currency: 'USD',
    recipientName: 'PalCert Ltd',
    mobileNumber: '+970 59-900 0000',
    instructionsEn: 'Use your PalCert email as the transfer note.',
    instructionsAr: 'استخدم بريدك في PalCert كملاحظة للتحويل.',
    minAmountMinorUnits: '500',
    maxAmountMinorUnits: '500000',
    displayOrder: 1,
    ...overrides,
  };
}

export function bankMethod(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    code: 'BANK_OF_PALESTINE',
    type: 'BANK_ACCOUNT',
    nameEn: 'Bank of Palestine',
    nameAr: 'بنك فلسطين',
    currency: 'USD',
    recipientName: 'PalCert Ltd',
    bankName: 'Bank of Palestine',
    iban: VALID_IBAN,
    branchName: 'Ramallah',
    minAmountMinorUnits: '1000',
    maxAmountMinorUnits: '1000000',
    displayOrder: 2,
    ...overrides,
  };
}

/**
 * Create a method and switch it on. Returns its id.
 *
 * Offering a method needs at least one eligible reviewer (ADR-0148), so unless
 * the body names its own, every current reviewer candidate is assigned.
 */
export async function enabledMethod(
  admin: AuthClient,
  body: Record<string, unknown> = walletMethod(),
): Promise<string> {
  let payload = body;
  if (!('reviewerUserIds' in body)) {
    const candidates = await admin.get(`${METHODS}/reviewer-candidates`);
    expectStatus(candidates, 200, 'Reviewer candidates');
    payload = {
      ...body,
      reviewerUserIds: (candidates.body as Array<{ userId: string }>).map((c) => c.userId),
    };
  }
  const created = await admin.post(METHODS, payload);
  expectStatus(created, 201, 'Create method');
  const enabled = await admin.post(`${METHODS}/${created.body.id}/enable`, {
    expectedVersion: created.body.version,
  });
  expectStatus(enabled, 200, 'Enable method');
  return created.body.id as string;
}

export async function draft(
  client: AuthClient,
  paymentMethodId: string,
  fields: Record<string, unknown> = {},
): Promise<request.Response> {
  return client.post(OWN, { paymentMethodId, ...fields });
}

/** Draft and submit a complete report. Returns the request id. */
export async function report(
  client: AuthClient,
  paymentMethodId: string,
  amountMinorUnits = '15000',
  reference = `TX${Math.random().toString(36).slice(2, 10).toUpperCase()}`,
): Promise<string> {
  const created = await draft(client, paymentMethodId, { amountMinorUnits, reference });
  expectStatus(created, 201, 'Draft');
  const submitted = await client.post(`${OWN}/${created.body.id}/submit`);
  expectStatus(submitted, 200, 'Submit');
  return created.body.id as string;
}

export async function approve(
  finance: AuthClient,
  requestId: string,
  amountMinorUnits = '15000',
  currency = 'USD',
): Promise<request.Response> {
  return finance.post(`${REVIEW}/${requestId}/approve`, {
    confirmAmountMinorUnits: amountMinorUnits,
    confirmCurrency: currency,
  });
}

export async function reject(
  finance: AuthClient,
  requestId: string,
  reason = 'REFERENCE_NOT_FOUND',
  note?: string,
): Promise<request.Response> {
  return finance.post(`${REVIEW}/${requestId}/reject`, {
    reason,
    ...(note === undefined ? {} : { note }),
  });
}

/** PUT bytes to a presigned URL the API handed out, and finalize. */
export async function uploadReceipt(
  client: AuthClient,
  requestId: string,
  bytes: Buffer,
  filename = 'receipt.png',
): Promise<{ receiptId: string; response: request.Response }> {
  const created = await client.post(`${OWN}/${requestId}/receipt`, {
    originalFilename: filename,
    sizeBytes: bytes.length,
  });
  expectStatus(created, 201, `Receipt creation (${filename})`);
  const receiptId = created.body.receipt.id as string;
  const put = await fetch(created.body.upload.url as string, {
    method: 'PUT',
    headers: created.body.upload.headers as Record<string, string>,
    body: new Uint8Array(bytes),
  });
  if (put.status !== 200) throw new Error(`storage PUT failed with ${put.status}`);
  const finalized = await client.post(`${OWN}/${requestId}/receipt/${receiptId}/finalize`);
  expectStatus(finalized, 200, 'Receipt finalize');
  return { receiptId, response: finalized };
}

const SETTLED = new Set(['READY', 'REJECTED', 'FAILED', 'UPLOAD_EXPIRED']);

export async function waitForReceipt(
  client: AuthClient,
  requestId: string,
  timeoutMs = 20_000,
): Promise<Record<string, unknown>> {
  const deadline = Date.now() + timeoutMs;
  let last: Record<string, unknown> | null = null;
  while (Date.now() < deadline) {
    const response = await client.get(`${OWN}/${requestId}`);
    expectStatus(response, 200, 'Request read');
    last = response.body.receipt as Record<string, unknown> | null;
    if (last !== null && SETTLED.has(String(last['status']))) return last;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`receipt on ${requestId} did not settle (last ${JSON.stringify(last)})`);
}

/** Run every pending fan-out and email job, repeatedly, until none is left. */
export async function drainNotifications(context: TestContext): Promise<void> {
  for (let pass = 0; pass < 5; pass += 1) {
    const jobs = await context.adminDb.processingJob.findMany({
      where: {
        jobType: {
          in: [ProcessingJobType.NOTIFICATION_FANOUT, ProcessingJobType.NOTIFICATION_EMAIL_SEND],
        },
        status: { in: ['PENDING', 'DISPATCHED', 'RETRY_PENDING'] },
      },
    });
    if (jobs.length === 0) return;
    for (const job of jobs) await context.worker.processJobId(job.id);
  }
}

/** The cash balance a person can spend, from the API. */
export async function availableCash(client: AuthClient, currency = 'USD'): Promise<bigint> {
  const response = await client.get(`${API}/balance?currency=${currency}`);
  expectStatus(response, 200, 'Balance');
  return BigInt(response.body.cash.minorUnits as string);
}
