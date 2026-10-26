import request from 'supertest';
import { API, type AuthClient } from './auth-client';
import type { TestContext } from './test-app';

/**
 * Wait for the live worker to finish issuing, or report why it did not.
 *
 * Issuance is asynchronous by design (§71), so every test that asserts a
 * certificate exists has to wait for the same worker a person would.
 */
export async function waitForCertificate(
  context: TestContext,
  revisionId: string,
  timeoutMs = 30_000,
): Promise<{ issuanceStatus: string; failureCode: string | null; id: string }> {
  const deadline = Date.now() + timeoutMs;
  let last = 'none';
  while (Date.now() < deadline) {
    const row = await context.adminDb.complianceCertificate.findFirst({
      where: { submissionRevisionId: revisionId },
    });
    if (row !== null) {
      last = row.issuanceStatus;
      if (row.issuanceStatus !== 'PENDING') {
        return { issuanceStatus: row.issuanceStatus, failureCode: row.failureCode, id: row.id };
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`certificate for ${revisionId} did not settle in ${timeoutMs} ms (${last})`);
}

/**
 * Give the worker time to *not* issue a certificate.
 *
 * The negative cases are the point of this phase, and "no row yet" is what a
 * test sees both when nothing will ever be issued and when the worker has not
 * got there. Draining the queue and then asserting is the difference between
 * proving the rule and racing it.
 */
export async function settleWithoutCertificate(
  context: TestContext,
  revisionId: string,
): Promise<void> {
  await context.dispatcher.sweep();
  await new Promise((resolve) => setTimeout(resolve, 300));
  const row = await context.adminDb.complianceCertificate.findFirst({
    where: { submissionRevisionId: revisionId },
  });
  if (row !== null) {
    throw new Error(`a certificate was issued for ${revisionId} (${row.issuanceStatus})`);
  }
}

export function listCertificates(client: AuthClient): Promise<request.Response> {
  return client.get(`${API}/certificates`);
}

export function readCertificate(
  client: AuthClient,
  certificateId: string,
): Promise<request.Response> {
  return client.get(`${API}/certificates/${certificateId}`);
}

export function certificateForRevision(
  client: AuthClient,
  revisionId: string,
): Promise<request.Response> {
  return client.get(`${API}/certificates/revisions/${revisionId}`);
}

export function certificateEvents(
  client: AuthClient,
  certificateId: string,
): Promise<request.Response> {
  return client.get(`${API}/certificates/${certificateId}/events`);
}

export function downloadCertificate(
  client: AuthClient,
  certificateId: string,
): Promise<request.Response> {
  return client.post(`${API}/certificates/${certificateId}/download`, {});
}

export function organizationCertificate(
  client: AuthClient,
  organizationId: string,
  certificateId: string,
): Promise<request.Response> {
  return client.get(`${API}/organizations/${organizationId}/certificates/${certificateId}`);
}

export function revokeCertificate(
  client: AuthClient,
  organizationId: string,
  certificateId: string,
  body: Record<string, unknown>,
): Promise<request.Response> {
  return client.post(
    `${API}/organizations/${organizationId}/certificates/${certificateId}/revocation`,
    body,
  );
}

/**
 * Verify a code the way a stranger does.
 *
 * Deliberately not through `AuthClient`: the route is unauthenticated, and a
 * test that sent a session cookie would not be testing what a verifier meets.
 */
export function verify(context: TestContext, code: string): request.Test {
  return request(context.app.getHttpServer())
    .get(`${API}/public/certificates/${encodeURIComponent(code)}`)
    .set('accept', 'application/json');
}
