import { createHash } from 'node:crypto';
import { API, type AuthClient } from './auth-client';
import { fundForAI } from './ai-billing-client';
import type { TestContext } from './test-app';

/**
 * Driving Phase 9 over HTTP, the way an institution would.
 *
 * Every helper goes through the real API: there is no back door that writes a
 * source, a run or a proposal straight into the database, because a test that
 * used one would prove nothing about the authorization it skipped.
 */

export interface UploadedSource {
  readonly id: string;
  readonly sha256: string;
}

/** Create, upload, finalize and wait for one source to become READY. */
export async function uploadSource(
  context: TestContext,
  client: AuthClient,
  organizationId: string,
  versionId: string,
  input: {
    sourceKind: 'GUIDELINE_PDF' | 'GUIDELINE_DOCX' | 'TEMPLATE_DOCX';
    filename: string;
    bytes: Buffer;
    authority?: 'PRIMARY' | 'SUPPLEMENTARY' | 'REFERENCE';
    expectReady?: boolean;
  },
): Promise<UploadedSource> {
  const base = `${API}/organizations/${organizationId}/standard-versions/${versionId}/sources`;
  const sha256 = createHash('sha256').update(input.bytes).digest('hex');

  const created = await client.post(base, {
    sourceKind: input.sourceKind,
    originalFilename: input.filename,
    sizeBytes: input.bytes.length,
    sha256,
    ...(input.authority === undefined ? {} : { authority: input.authority }),
  });
  if (created.status !== 201) {
    throw new Error(`source create failed: ${created.status} ${JSON.stringify(created.body)}`);
  }

  const sourceId = created.body.source.id as string;
  await putToStorage(created.body.upload, input.bytes);

  const finalized = await client.post(`${base}/${sourceId}/finalize`, {});
  if (finalized.status !== 200) {
    throw new Error(`finalize failed: ${finalized.status} ${JSON.stringify(finalized.body)}`);
  }

  if (input.expectReady === false) return { id: sourceId, sha256 };
  await waitForSource(context, sourceId);
  return { id: sourceId, sha256 };
}

/** The upload itself, exactly as a browser would perform it. */
export async function putToStorage(
  upload: { url: string; headers: Record<string, string> },
  bytes: Buffer,
): Promise<void> {
  const response = await fetch(upload.url, {
    method: 'PUT',
    headers: upload.headers,
    body: new Uint8Array(bytes),
  });
  if (!response.ok) {
    throw new Error(`storage PUT failed: ${response.status} ${await response.text()}`);
  }
}

/** Wait for the ingest worker to settle a source. */
export async function waitForSource(
  context: TestContext,
  sourceId: string,
  timeoutMs = 30_000,
): Promise<{ status: string; rejectionCode: string | null; failureCode: string | null }> {
  const deadline = Date.now() + timeoutMs;
  let last = 'AWAITING_UPLOAD';
  while (Date.now() < deadline) {
    const row = await context.adminDb.standardSourceAsset.findUniqueOrThrow({
      where: { id: sourceId },
    });
    last = row.status;
    if (['READY', 'REJECTED', 'FAILED', 'CANCELLED'].includes(row.status)) {
      return {
        status: row.status,
        rejectionCode: row.rejectionCode,
        failureCode: row.failureCode,
      };
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`source ${sourceId} did not settle in ${timeoutMs} ms (last ${last})`);
}

/** Agree, for the organization, to external AI processing. */
export async function grantOrganizationAIConsent(
  client: AuthClient,
  organizationId: string,
): Promise<void> {
  const response = await client.post(`${API}/organizations/${organizationId}/ai-consent`, {});
  if (response.status !== 200) {
    throw new Error(`consent failed: ${response.status} ${JSON.stringify(response.body)}`);
  }
}

/** The authenticated user behind a client: the member who will pay. */
export async function userIdOf(client: AuthClient): Promise<string> {
  const me = await client.get(`${API}/users/me`);
  if (me.status !== 200) throw new Error(`users/me failed: ${me.status}`);
  return me.body.id as string;
}

/**
 * A request body for starting an extraction, the way the product sends one
 * since ADR-0149: the caller's own funded AI_RULE_EXTRACTION quote, plus the
 * chosen sources. The caller pays, never the organization.
 */
export async function extractionBody(
  context: TestContext,
  client: AuthClient,
  sourceAssetIds?: readonly string[],
): Promise<{ priceQuoteId: string; sourceAssetIds?: string[] }> {
  const { quoteId } = await fundForAI(context, await userIdOf(client), 'AI_RULE_EXTRACTION');
  return {
    priceQuoteId: quoteId,
    ...(sourceAssetIds === undefined ? {} : { sourceAssetIds: [...sourceAssetIds] }),
  };
}

/** Start an extraction and wait for it to settle. */
export async function runExtraction(
  context: TestContext,
  client: AuthClient,
  organizationId: string,
  versionId: string,
  sourceAssetIds?: readonly string[],
): Promise<{ runId: string; status: string; failureKind: string | null }> {
  const started = await client.post(
    `${API}/organizations/${organizationId}/standard-versions/${versionId}/extractions`,
    await extractionBody(context, client, sourceAssetIds),
  );
  if (started.status !== 202) {
    throw new Error(`extraction failed: ${started.status} ${JSON.stringify(started.body)}`);
  }
  const runId = started.body.id as string;
  const settled = await waitForExtraction(context, runId);
  return { runId, ...settled };
}

export async function waitForExtraction(
  context: TestContext,
  runId: string,
  timeoutMs = 30_000,
): Promise<{ status: string; failureKind: string | null }> {
  const deadline = Date.now() + timeoutMs;
  let last = 'CREATED';
  while (Date.now() < deadline) {
    const row = await context.adminDb.ruleExtractionRun.findUniqueOrThrow({ where: { id: runId } });
    last = row.status;
    if (['COMPLETED', 'FAILED', 'CANCELLED'].includes(row.status)) {
      return { status: row.status, failureKind: row.failureKind };
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`extraction ${runId} did not settle in ${timeoutMs} ms (last ${last})`);
}

export function extractionPath(organizationId: string, versionId: string, runId: string): string {
  return `${API}/organizations/${organizationId}/standard-versions/${versionId}/extractions/${runId}`;
}

/** The draft's current revision, for the If-Match every decision carries. */
export async function draftRevision(context: TestContext, versionId: string): Promise<number> {
  const version = await context.adminDb.standardVersion.findUniqueOrThrow({
    where: { id: versionId },
  });
  return version.revision;
}

/**
 * A short guideline PDF whose text states one requirement.
 *
 * Synthetic on purpose: no real institution's guidelines are committed to this
 * repository, and none are ever sent anywhere in CI (§149).
 */
export function guidelineText(requirement: string): string {
  return `Thesis formatting guidelines. ${requirement}`;
}
