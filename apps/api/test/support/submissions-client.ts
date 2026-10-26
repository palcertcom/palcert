import type request from 'supertest';
import { API } from './auth-client';
import type { AuthClient } from './auth-client';
import { publishCheckableStandard, startCheck, waitForCheck } from './checks-client';
import type { PublishedStandard } from './checks-client';
import { createDocument, uploadAndProcess } from './documents-client';
import { minimalDocx } from './fixtures';
import type { TestContext } from './test-app';

/** A completed check ready to hand over, and the document it examined. */
export interface SubmittableFixture {
  readonly checkId: string;
  readonly documentId: string;
  readonly versionId: string;
}

/**
 * Buy and complete one real check, the way a person would.
 *
 * Nothing here shortcuts the path: a document is uploaded and processed, a
 * check is purchased and run by the live worker, and only then is there
 * anything to submit. Tests that assert what submission does need the real
 * artifacts, because the whole point of the phase is that the bytes and
 * hashes are the ones the check measured.
 */
export async function completedCheck(
  context: TestContext,
  owner: { client: AuthClient; userId: string },
  standard: PublishedStandard,
  options: { documentName?: string; documentId?: string } = {},
): Promise<SubmittableFixture> {
  const documentId =
    options.documentId ?? (await createDocument(owner.client, options.documentName ?? 'Thesis')).id;
  const { versionId } = await uploadAndProcess(owner.client, documentId, {
    name: 'thesis.docx',
    bytes: minimalDocx(),
  });
  const created = await startCheck(context, owner, {
    documentVersionId: versionId,
    standardId: standard.standardId,
  });
  if (created.status !== 201 && created.status !== 202) {
    throw new Error(`check creation failed (${created.status}): ${JSON.stringify(created.body)}`);
  }
  const checkId = created.body.id as string;
  const settled = await waitForCheck(context, checkId);
  if (settled.status !== 'COMPLETED') {
    throw new Error(`check ${checkId} settled as ${settled.status} (${settled.failureCode})`);
  }
  return { checkId, documentId, versionId };
}

/** A verified, check-able standard owned by a tenant. */
export function publishStandardFor(
  context: TestContext,
  tenant: { organizationId: string; owner: { client: AuthClient } },
): Promise<PublishedStandard> {
  return publishCheckableStandard(context, tenant.owner.client, tenant.organizationId);
}

export function disclosureFor(client: AuthClient, checkId: string): Promise<request.Response> {
  return client.get(`${API}/submissions/checks/${checkId}/disclosure`);
}

export function submitCheck(
  client: AuthClient,
  checkId: string,
  headers: Record<string, string> = {},
): Promise<request.Response> {
  return client.post(`${API}/submissions`, { checkId }, { headers });
}

export function listSubmissions(client: AuthClient): Promise<request.Response> {
  return client.get(`${API}/submissions`);
}

export function readSubmission(
  client: AuthClient,
  submissionId: string,
): Promise<request.Response> {
  return client.get(`${API}/submissions/${submissionId}`);
}

export function submitterHistory(
  client: AuthClient,
  revisionId: string,
): Promise<request.Response> {
  return client.get(`${API}/submissions/revisions/${revisionId}/history`);
}

export function submitterComments(
  client: AuthClient,
  revisionId: string,
): Promise<request.Response> {
  return client.get(`${API}/submissions/revisions/${revisionId}/comments`);
}

export function reviewQueue(
  client: AuthClient,
  organizationId: string,
  query = '',
): Promise<request.Response> {
  return client.get(`${API}/organizations/${organizationId}/submissions${query}`);
}

export function reviewSubmission(
  client: AuthClient,
  organizationId: string,
  submissionId: string,
): Promise<request.Response> {
  return client.get(`${API}/organizations/${organizationId}/submissions/${submissionId}`);
}

export function decide(
  client: AuthClient,
  organizationId: string,
  revisionId: string,
  body: Record<string, unknown>,
): Promise<request.Response> {
  return client.post(
    `${API}/organizations/${organizationId}/submissions/revisions/${revisionId}/decision`,
    body,
  );
}

export function addComment(
  client: AuthClient,
  organizationId: string,
  revisionId: string,
  body: string,
): Promise<request.Response> {
  return client.post(
    `${API}/organizations/${organizationId}/submissions/revisions/${revisionId}/comments`,
    { body },
  );
}

export function organizationDocument(
  client: AuthClient,
  organizationId: string,
  revisionId: string,
): Promise<request.Response> {
  return client.post(
    `${API}/organizations/${organizationId}/submissions/revisions/${revisionId}/document`,
    {},
  );
}

export function organizationReport(
  client: AuthClient,
  organizationId: string,
  revisionId: string,
): Promise<request.Response> {
  return client.post(
    `${API}/organizations/${organizationId}/submissions/revisions/${revisionId}/report`,
    {},
  );
}

/**
 * Wait for the preparation worker to finish copying one revision's evidence.
 *
 * Submission returns 202 and the organization sees nothing until the copy is
 * verified, so every test that looks at a queue has to wait for this first.
 */
export async function waitForRevision(
  context: TestContext,
  revisionId: string,
  timeoutMs = 30_000,
): Promise<{ processingStatus: string; institutionDecisionStatus: string | null }> {
  const deadline = Date.now() + timeoutMs;
  let last = 'PREPARING';
  while (Date.now() < deadline) {
    const row = await context.adminDb.submissionRevision.findUniqueOrThrow({
      where: { id: revisionId },
    });
    last = row.processingStatus;
    if (row.processingStatus !== 'PREPARING') {
      return {
        processingStatus: row.processingStatus,
        institutionDecisionStatus: row.institutionDecisionStatus,
      };
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`revision ${revisionId} did not finish preparing in ${timeoutMs} ms (${last})`);
}

/** Submit a completed check and wait for it to be really handed over. */
export async function submitAndPrepare(
  context: TestContext,
  client: AuthClient,
  checkId: string,
): Promise<{ revisionId: string; submissionId: string }> {
  const response = await submitCheck(client, checkId);
  if (response.status !== 202) {
    throw new Error(`submission failed (${response.status}): ${JSON.stringify(response.body)}`);
  }
  const revisionId = response.body.id as string;
  const state = await waitForRevision(context, revisionId);
  if (state.processingStatus !== 'READY') {
    throw new Error(`revision ${revisionId} prepared as ${state.processingStatus}`);
  }
  return { revisionId, submissionId: response.body.submissionId as string };
}
