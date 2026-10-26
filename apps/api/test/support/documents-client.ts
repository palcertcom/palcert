import type request from 'supertest';
import { API, type AuthClient } from './auth-client';
import type { TestContext } from './test-app';

/**
 * Helpers for driving the documents surface over HTTP, plus the two things a
 * browser does outside PalCert's API: PUT the bytes to the presigned URL and
 * GET them back from the presigned download. Both go to the real
 * S3-compatible service, so what is asserted is the actual upload path.
 */

export const DOCUMENTS = `${API}/documents`;

function expectStatus(response: request.Response, expected: number, what: string): void {
  if (response.status !== expected) {
    throw new Error(`${what} failed (${response.status}): ${JSON.stringify(response.body)}`);
  }
}

export async function createDocument(
  client: AuthClient,
  displayName = 'My thesis',
): Promise<{ id: string; body: Record<string, unknown> }> {
  const response = await client.post(DOCUMENTS, { displayName });
  expectStatus(response, 201, 'Document creation');
  return { id: response.body.id, body: response.body };
}

export interface UploadGrant {
  readonly method: 'PUT';
  readonly url: string;
  readonly headers: Record<string, string>;
  readonly expiresAt: string;
}

export async function createVersion(
  client: AuthClient,
  documentId: string,
  file: {
    readonly name: string;
    readonly bytes: Buffer;
    readonly mimeType?: string;
    readonly sha256?: string;
  },
  options: { readonly idempotencyKey?: string } = {},
): Promise<{
  versionId: string;
  upload: UploadGrant;
  body: Record<string, unknown>;
  response: request.Response;
}> {
  const response = await client.post(
    `${DOCUMENTS}/${documentId}/versions`,
    {
      originalFilename: file.name,
      sizeBytes: file.bytes.length,
      ...(file.mimeType !== undefined ? { declaredMimeType: file.mimeType } : {}),
      ...(file.sha256 !== undefined ? { sha256: file.sha256 } : {}),
    },
    options.idempotencyKey !== undefined
      ? { headers: { 'Idempotency-Key': options.idempotencyKey } }
      : undefined,
  );
  expectStatus(response, 201, `Version creation (${file.name})`);
  return {
    versionId: response.body.version.id,
    upload: response.body.upload,
    body: response.body,
    response,
  };
}

/** What the browser does with the authorization: a plain PUT of the bytes. */
export async function putToStorage(
  grant: UploadGrant,
  bytes: Buffer,
): Promise<{ status: number; versionId: string | null }> {
  const response = await fetch(grant.url, {
    method: 'PUT',
    headers: grant.headers,
    body: new Uint8Array(bytes),
  });
  return { status: response.status, versionId: response.headers.get('x-amz-version-id') };
}

export async function finalize(
  client: AuthClient,
  documentId: string,
  versionId: string,
): Promise<request.Response> {
  return client.post(`${DOCUMENTS}/${documentId}/versions/${versionId}/finalize`);
}

export async function getVersion(
  client: AuthClient,
  documentId: string,
  versionId: string,
): Promise<request.Response> {
  return client.get(`${DOCUMENTS}/${documentId}/versions/${versionId}`);
}

const SETTLED = new Set(['READY', 'REJECTED', 'FAILED', 'UPLOAD_EXPIRED', 'CANCELLED']);

/**
 * Poll until processing settles.
 *
 * The worker runs for real in the test context, so tests observe the genuine
 * asynchronous path rather than calling the pipeline directly.
 */
export async function waitForSettled(
  client: AuthClient,
  documentId: string,
  versionId: string,
  timeoutMs = 20_000,
): Promise<Record<string, unknown>> {
  const deadline = Date.now() + timeoutMs;
  let last: Record<string, unknown> = {};
  while (Date.now() < deadline) {
    const response = await getVersion(client, documentId, versionId);
    expectStatus(response, 200, 'Version read');
    last = response.body;
    if (SETTLED.has(String(last['status']))) return last;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(
    `Version ${versionId} did not settle in ${timeoutMs} ms (last status ${String(last['status'])})`,
  );
}

/**
 * Wait until the staged bytes of a settled version have actually been purged.
 *
 * A version reaches READY or REJECTED in one transaction, and the quarantine
 * object is deleted and `quarantineDeletedAt` stamped in a *later* one — the
 * remote delete cannot honestly sit inside a database transaction, and the
 * purge is deliberately best-effort with a bucket lifecycle rule behind it
 * (§40). So the terminal status is an upstream signal that says nothing about
 * whether the downstream purge has happened yet; waiting on it and then
 * reading `quarantineDeletedAt` is a race the test loses under load.
 *
 * This converges on the thing actually being asserted instead. The deadline is
 * what keeps it an assertion rather than a hope: a purge that never happens
 * still fails the test, and says which version.
 */
export async function waitForQuarantinePurge(
  context: TestContext,
  versionId: string,
  timeoutMs = 20_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const row = await context.adminDb.documentVersion.findUniqueOrThrow({
      where: { id: versionId },
    });
    if (row.quarantineDeletedAt !== null) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`staged bytes of version ${versionId} were not purged in ${timeoutMs} ms`);
}

/**
 * Create a version and PUT the bytes, without insisting the PUT succeed.
 *
 * `uploadAndProcess` throws on a refused PUT, which is right for every test
 * whose bytes match their authorization. A test that deliberately contradicts
 * the authorization needs the status instead: on a storage that enforces what
 * it signed, refusal *is* the outcome under test.
 */
export async function attemptUpload(
  client: AuthClient,
  documentId: string,
  file: {
    readonly name: string;
    readonly bytes: Buffer;
    readonly mimeType?: string;
    readonly sha256?: string;
  },
  headers: Record<string, string> = {},
): Promise<{ versionId: string; putStatus: number }> {
  const created = await createVersion(client, documentId, file);
  const put = await putToStorage(
    { ...created.upload, headers: { ...created.upload.headers, ...headers } },
    file.bytes,
  );
  return { versionId: created.versionId, putStatus: put.status };
}

/** Upload, finalize and wait: the whole happy path in one call. */
export async function uploadAndProcess(
  client: AuthClient,
  documentId: string,
  file: {
    readonly name: string;
    readonly bytes: Buffer;
    readonly mimeType?: string;
    readonly sha256?: string;
  },
): Promise<{ versionId: string; version: Record<string, unknown> }> {
  const created = await createVersion(client, documentId, file);
  const put = await putToStorage(created.upload, file.bytes);
  if (put.status < 200 || put.status >= 300) throw new Error(`Storage PUT failed (${put.status})`);
  const finalized = await finalize(client, documentId, created.versionId);
  expectStatus(finalized, 200, 'Finalize');
  const version = await waitForSettled(client, documentId, created.versionId);
  return { versionId: created.versionId, version };
}

export async function downloadAuthorization(
  client: AuthClient,
  documentId: string,
  versionId: string,
): Promise<request.Response> {
  return client.post(`${DOCUMENTS}/${documentId}/versions/${versionId}/download-authorization`);
}

export async function fetchDownload(
  url: string,
): Promise<{ status: number; bytes: Buffer; headers: Headers }> {
  const response = await fetch(url);
  return {
    status: response.status,
    bytes: Buffer.from(await response.arrayBuffer()),
    headers: response.headers,
  };
}
