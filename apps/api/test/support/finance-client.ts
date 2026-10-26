import { createHash } from 'node:crypto';
import request from 'supertest';
import { API, type AuthClient } from './auth-client';
import type { TestContext } from './test-app';
import { PaymentEventKind, PaymentObjectKind, type PaymentDisputeStatus } from '@palcert/contracts';
import type { FakeWebhookPayload } from '../../src/infrastructure/payments/fake-payment-provider';

/** Helpers the financial suites share. Nothing here asserts; they only act. */

export async function balance(client: AuthClient, currency = 'USD'): Promise<request.Response> {
  const response = await client.get(`${API}/balance?currency=${currency}`);
  return response;
}

export async function createTopUp(
  client: AuthClient,
  amountMinorUnits: string,
  currency = 'USD',
  idempotencyKey?: string,
): Promise<request.Response> {
  return client.post(
    `${API}/balance/top-ups`,
    { currency, amountMinorUnits },
    idempotencyKey === undefined ? {} : { headers: { 'Idempotency-Key': idempotencyKey } },
  );
}

/**
 * Deliver a signed provider webhook.
 *
 * Sent straight at the server with **no session cookie, no Origin and no CSRF
 * token**, because that is exactly what a payment provider sends. Posting it
 * through an authenticated client would quietly prove the wrong thing.
 *
 * The body goes as a raw string so the raw-body path is exercised rather than
 * bypassed: a test that sent a parsed object would prove nothing about
 * signature verification (§48).
 */
export async function deliverWebhook(
  context: TestContext,
  payload: FakeWebhookPayload,
  options: { signature?: string | null } = {},
): Promise<request.Response> {
  const call = request(context.app.getHttpServer())
    .post(`${API}/webhooks/payments/fake`)
    .set('Content-Type', 'application/json');
  if (options.signature !== null) {
    call.set('x-palcert-signature', options.signature ?? 't=1,v1=test');
  }
  return call.send(JSON.stringify(payload));
}

/** A payment-succeeded event for one top-up, as the provider would send it. */
export function paymentSucceeded(params: {
  readonly eventId: string;
  readonly sessionId: string;
  readonly topUpId: string;
  readonly amountMinorUnits: string;
  readonly currency?: string;
}): FakeWebhookPayload {
  return {
    id: params.eventId,
    type: 'payment.succeeded',
    kind: PaymentEventKind.PAYMENT_SUCCEEDED,
    objectKind: PaymentObjectKind.TOP_UP,
    objectId: params.sessionId,
    clientReference: params.topUpId,
    currency: params.currency ?? 'USD',
    amountMinor: params.amountMinorUnits,
  };
}

export function paymentFailed(params: {
  readonly eventId: string;
  readonly sessionId: string;
  readonly topUpId: string;
}): FakeWebhookPayload {
  return {
    id: params.eventId,
    type: 'payment.failed',
    kind: PaymentEventKind.PAYMENT_FAILED,
    objectKind: PaymentObjectKind.TOP_UP,
    objectId: params.sessionId,
    clientReference: params.topUpId,
  };
}

export function disputeOpened(params: {
  readonly eventId: string;
  readonly disputeId: string;
  readonly paymentId: string;
  readonly amountMinorUnits: string;
  readonly currency?: string;
}): FakeWebhookPayload {
  return {
    id: params.eventId,
    type: 'payment.disputed',
    kind: PaymentEventKind.PAYMENT_DISPUTED,
    objectKind: PaymentObjectKind.DISPUTE,
    objectId: params.disputeId,
    relatedPaymentId: params.paymentId,
    currency: params.currency ?? 'USD',
    amountMinor: params.amountMinorUnits,
  };
}

export function disputeReversed(params: {
  readonly eventId: string;
  readonly disputeId: string;
  readonly status: PaymentDisputeStatus;
}): FakeWebhookPayload {
  return {
    id: params.eventId,
    type: 'payment.dispute.closed',
    kind: PaymentEventKind.DISPUTE_REVERSED,
    objectKind: PaymentObjectKind.DISPUTE,
    objectId: params.disputeId,
    disputeStatus: params.status,
  };
}

/** The provider session id the double derives from a top-up id. */
export function sessionIdFor(topUpId: string): string {
  return `cs_fake_${createHash('sha256').update(topUpId).digest('hex').slice(0, 24)}`;
}

export function paymentIdFor(sessionId: string): string {
  return `pi_fake_${createHash('sha256').update(sessionId).digest('hex').slice(0, 24)}`;
}

/**
 * Take a payment all the way to credited.
 *
 * The double reports the payment as paid, then a signed webhook prompts
 * PalCert to check — which is the real flow, not a shortcut around it.
 */
export async function fundBalance(
  context: TestContext,
  client: AuthClient,
  amountMinorUnits: string,
  currency = 'USD',
): Promise<{ topUpId: string; sessionId: string; paymentId: string }> {
  const created = await createTopUp(client, amountMinorUnits, currency);
  if (created.status !== 201) {
    throw new Error(`top-up creation failed (${created.status}): ${JSON.stringify(created.body)}`);
  }
  const topUpId = created.body.topUp.id as string;
  const sessionId = sessionIdFor(topUpId);

  context.paymentProvider.paymentState = 'paid';
  await deliverWebhook(
    context,
    paymentSucceeded({
      eventId: `evt_${topUpId}`,
      sessionId,
      topUpId,
      amountMinorUnits,
      currency,
    }),
  );
  await drainPaymentJobs(context);
  context.paymentProvider.paymentState = 'unpaid';

  return { topUpId, sessionId, paymentId: paymentIdFor(sessionId) };
}

/** Run every queued payment job. The webhook only records; the worker acts. */
export async function drainPaymentJobs(context: TestContext): Promise<void> {
  for (let pass = 0; pass < 5; pass += 1) {
    const jobs = await context.adminDb.processingJob.findMany({
      where: {
        jobType: 'PAYMENT_EVENT',
        status: { in: ['PENDING', 'DISPATCHED', 'RETRY_PENDING'] },
      },
      select: { id: true },
    });
    if (jobs.length === 0) return;
    for (const job of jobs) await context.worker.processJobId(job.id);
  }
}

export async function ledgerOf(context: TestContext, ownerUserId: string) {
  return context.adminDb.creditLedgerEntry.findMany({
    where: { ownerUserId },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
  });
}

export async function ledgerTotal(context: TestContext, ownerUserId: string): Promise<bigint> {
  const entries = await ledgerOf(context, ownerUserId);
  return entries.reduce((total, entry) => total + entry.amountMinorSigned, 0n);
}
