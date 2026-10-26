import type request from 'supertest';
import { API, type AuthClient } from './auth-client';
import { expectStatus } from './checks-client';
import { approve as approveTopUp, enabledMethod, report } from './manual-topup-client';
import type { TestContext } from './test-app';

export const OWN = `${API}/balance/withdrawals`;
export const OWN_DESTINATIONS = `${API}/balance/payout-destinations`;
export const WITHDRAWABLE = `${API}/balance/withdrawable`;
export const ADMIN = `${API}/admin/withdrawals`;
export const PLATFORM = `${API}/admin/platform-funds`;
export const SETTINGS = `${API}/admin/withdrawal-settings`;

export function orgPayouts(organizationId: string): string {
  return `${API}/organizations/${organizationId}/payouts`;
}

/** A valid IBAN (ISO 13616 example), so the checksum path is real. */
export const IBAN_A = 'GB82WEST12345698765432';
export const IBAN_B = 'DE89370400440532013000';

export function bankDestination(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    type: 'BANK_ACCOUNT',
    label: 'My bank',
    beneficiaryName: 'Lina Haddad',
    currency: 'USD',
    bankName: 'Bank of Palestine',
    iban: IBAN_A,
    ...overrides,
  };
}

export async function createDestination(
  client: AuthClient,
  base: string = OWN_DESTINATIONS,
  body: Record<string, unknown> = bankDestination(),
): Promise<{ id: string; version: number }> {
  const created = await client.post(base, body);
  expectStatus(created, 201, 'Destination');
  return { id: created.body.id as string, version: created.body.version as number };
}

export async function submit(
  client: AuthClient,
  destinationId: string,
  amountMinorUnits: string,
  base: string = OWN,
  currency = 'USD',
): Promise<request.Response> {
  return client.post(base, { currency, amountMinorUnits, destinationId });
}

export async function withdrawable(client: AuthClient, currency = 'USD'): Promise<bigint> {
  const response = await client.get(`${WITHDRAWABLE}?currency=${currency}`);
  expectStatus(response, 200, 'Withdrawable');
  return BigInt(response.body.withdrawable.minorUnits as string);
}

/** Set both clearing periods, through the admin API. */
export async function setClearing(
  admin: AuthClient,
  userDays: number,
  organizationDays: number,
): Promise<void> {
  const current = await admin.get(`${SETTINGS}/policy`);
  expectStatus(current, 200, 'Policy');
  const updated = await admin.put(`${SETTINGS}/policy`, {
    userManualTopUpClearingDays: userDays,
    organizationClearingDays: organizationDays,
    expectedVersion: current.body.version,
  });
  expectStatus(updated, 200, 'Policy update');
}

/**
 * Give a person verified real money: a manual top-up reported and approved by
 * finance. The only inflow that ever becomes withdrawable (D1–D3).
 */
export async function manualTopUp(
  admin: AuthClient,
  finance: AuthClient,
  client: AuthClient,
  amountMinorUnits: string,
  methodId?: string,
): Promise<string> {
  const method = methodId ?? (await enabledMethod(admin));
  const requestId = await report(client, method, amountMinorUnits);
  expectStatus(await approveTopUp(finance, requestId, amountMinorUnits), 200, 'Top-up approval');
  return method;
}

export async function detail(finance: AuthClient, requestId: string): Promise<request.Response> {
  const response = await finance.get(`${ADMIN}/${requestId}`);
  expectStatus(response, 200, 'Admin detail');
  return response;
}

export async function approve(
  finance: AuthClient,
  requestId: string,
  amountMinorUnits: string,
  currency = 'USD',
): Promise<request.Response> {
  const current = await detail(finance, requestId);
  return finance.post(`${ADMIN}/${requestId}/approve`, {
    expectedVersion: current.body.version,
    confirmAmountMinorUnits: amountMinorUnits,
    confirmCurrency: currency,
  });
}

export async function startExecution(
  finance: AuthClient,
  requestId: string,
): Promise<request.Response> {
  const current = await detail(finance, requestId);
  return finance.post(`${ADMIN}/${requestId}/start-execution`, {
    expectedVersion: current.body.version,
  });
}

export async function markPaid(
  finance: AuthClient,
  requestId: string,
  amountMinorUnits: string,
  reference = 'BANK-TX-0001',
  currency = 'USD',
): Promise<request.Response> {
  const current = await detail(finance, requestId);
  return finance.post(`${ADMIN}/${requestId}/mark-paid`, {
    expectedVersion: current.body.version,
    externalTransferReference: reference,
    confirmAmountMinorUnits: amountMinorUnits,
    confirmCurrency: currency,
  });
}

/**
 * Simulate a fresh step-up on a session: advance the clock and stamp the
 * session's last authentication, as a completed re-authentication would.
 */
export async function reauthenticate(context: TestContext, userId: string): Promise<void> {
  context.clock.set(new Date(context.clock.now().getTime() + 60_000));
  await context.adminDb.$executeRawUnsafe('SET row_security = off');
  await context.adminDb.session.updateMany({
    where: { userId, revokedAt: null },
    data: { mfaCompletedAt: context.clock.now() },
  });
}

export async function userIdOf(context: TestContext, email: string): Promise<string> {
  const user = await context.adminDb.user.findFirstOrThrow({ where: { email } });
  return user.id;
}
