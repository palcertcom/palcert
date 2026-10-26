import { createHash } from 'node:crypto';
import { deflateSync } from 'node:zlib';
import type request from 'supertest';
import { API, type AuthClient } from './auth-client';
import { expectStatus, verifyOrganization } from './checks-client';
import { minimalPdf } from './fixtures';
import { createTenant, type TenantFixture } from './organization-client';
import type { TestContext } from './test-app';

export const ATTESTATIONS = `${API}/attestation-requests`;

export function orgAttestations(organizationId: string): string {
  return `${API}/organizations/${organizationId}`;
}

// ---------------------------------------------------------------------------
// Deterministic file fixtures
// ---------------------------------------------------------------------------

function crc32(buffer: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

/** A real, decodable PNG of the given size (grey pixels). */
export function pngBytes(width = 4, height = 3, shade = 0x80): Buffer {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8; // bit depth
  header[9] = 0; // greyscale
  const rows: Buffer[] = [];
  for (let y = 0; y < height; y += 1)
    rows.push(Buffer.concat([Buffer.from([0]), Buffer.alloc(width, shade)]));
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', header),
    pngChunk('IDAT', deflateSync(Buffer.concat(rows))),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

/** A PNG whose header claims an absurd size: a decompression bomb for a browser. */
export function pngBomb(): Buffer {
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    // IHDR claiming 50,000 × 50,000 pixels.
    pngChunk('IHDR', Buffer.from([0, 0, 0xc3, 0x50, 0, 0, 0xc3, 0x50, 8, 0, 0, 0, 0])),
    pngChunk('IDAT', deflateSync(Buffer.alloc(8))),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

/** A structurally valid baseline JPEG header with a frame, and an end marker. */
export function jpegBytes(width = 16, height = 8): Buffer {
  const app0 = Buffer.from([
    0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01,
    0x00, 0x00,
  ]);
  const sof = Buffer.from([
    0xff,
    0xc0,
    0x00,
    0x0b,
    0x08,
    (height >> 8) & 0xff,
    height & 0xff,
    (width >> 8) & 0xff,
    width & 0xff,
    0x01,
    0x01,
    0x11,
    0x00,
  ]);
  return Buffer.concat([Buffer.from([0xff, 0xd8]), app0, sof, Buffer.from([0xff, 0xd9])]);
}

/** Office document bytes (a ZIP), dressed up with an image extension. */
export function zipPretendingToBeJpeg(): Buffer {
  return Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.alloc(64, 1)]);
}

/** Windows executable bytes. */
export function executableBytes(): Buffer {
  return Buffer.concat([Buffer.from('MZ', 'latin1'), Buffer.alloc(256, 0x90)]);
}

export function degreePdf(label = 'Bachelor of Science in Computer Engineering'): Buffer {
  return minimalPdf(`${label} - degree certificate`);
}

export function sha256(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

// ---------------------------------------------------------------------------
// Institution setup
// ---------------------------------------------------------------------------

export interface Institution extends TenantFixture {
  readonly typeId: string;
}

export async function createInstitution(
  context: TestContext,
  name: string,
  ownerEmail: string,
  options: {
    readonly feeMinorUnits?: string;
    readonly currency?: string;
    readonly defaultValidityDays?: number | null;
    readonly verified?: boolean;
    readonly type?: Record<string, unknown>;
  } = {},
): Promise<Institution> {
  const tenant = await createTenant(context, name, ownerEmail);
  if (options.verified !== false) await verifyOrganization(context, tenant.organizationId);
  const type = await tenant.owner.client.post(
    `${orgAttestations(tenant.organizationId)}/attestation-types`,
    {
      nameEn: 'Degree certificate',
      nameAr: 'شهادة درجة علمية',
      descriptionEn: 'A university degree certificate.',
      instructionsEn: 'Upload a clear scan of the whole certificate.',
      currency: options.currency ?? 'USD',
      feeMinorUnits: options.feeMinorUnits ?? '1000',
      defaultValidityDays:
        options.defaultValidityDays === undefined ? 365 : options.defaultValidityDays,
      ...(options.type ?? {}),
    },
  );
  expectStatus(type, 201, 'Attestation type creation');
  return { ...tenant, typeId: type.body.id as string };
}

export async function setCommission(
  admin: AuthClient,
  organizationId: string,
  percent: string,
  reason = 'Agreed platform commission',
): Promise<request.Response> {
  return admin.put(`${API}/admin/organizations/${organizationId}/attestation-commission`, {
    percent,
    reason,
  });
}

// ---------------------------------------------------------------------------
// Owner flow
// ---------------------------------------------------------------------------

export async function createDraft(
  client: AuthClient,
  typeId: string,
  overrides: Record<string, unknown> = {},
): Promise<Record<string, unknown>> {
  const response = await client.post(ATTESTATIONS, {
    attestationTypeId: typeId,
    certificateTitle: 'Bachelor of Science in Computer Engineering',
    issuingOrganization: 'Example University',
    issueDate: '2024-06-30',
    referenceNumber: 'BSC-2024-0117',
    recipientName: 'Sara Haddad',
    ...overrides,
  });
  expectStatus(response, 201, 'Attestation draft creation');
  return response.body as Record<string, unknown>;
}

export async function uploadArtifact(
  client: AuthClient,
  requestId: string,
  bytes: Buffer,
  filename = 'degree.pdf',
): Promise<{ artifactId: string; response: request.Response }> {
  const created = await client.post(`${ATTESTATIONS}/${requestId}/artifacts`, {
    originalFilename: filename,
    sizeBytes: bytes.length,
  });
  expectStatus(created, 201, `Artifact creation (${filename})`);
  const artifactId = created.body.artifact.id as string;
  const put = await fetch(created.body.upload.url as string, {
    method: 'PUT',
    headers: created.body.upload.headers as Record<string, string>,
    body: new Uint8Array(bytes),
  });
  if (put.status !== 200)
    throw new Error(
      `storage PUT failed with ${put.status}: ${await put.text()} ${JSON.stringify(created.body.upload)}`,
    );
  const finalized = await client.post(
    `${ATTESTATIONS}/${requestId}/artifacts/${artifactId}/finalize`,
  );
  expectStatus(finalized, 200, 'Artifact finalize');
  return { artifactId, response: finalized };
}

const ARTIFACT_SETTLED = new Set(['READY', 'REJECTED', 'FAILED', 'UPLOAD_EXPIRED', 'CANCELLED']);

export async function waitForArtifact(
  client: AuthClient,
  requestId: string,
  timeoutMs = 20_000,
): Promise<Record<string, unknown>> {
  const deadline = Date.now() + timeoutMs;
  let last: Record<string, unknown> | null = null;
  while (Date.now() < deadline) {
    const response = await client.get(`${ATTESTATIONS}/${requestId}`);
    expectStatus(response, 200, 'Request read');
    last = response.body.artifact as Record<string, unknown> | null;
    if (last !== null && ARTIFACT_SETTLED.has(String(last['status']))) return last;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`artifact on ${requestId} did not settle (last ${JSON.stringify(last)})`);
}

/** Draft + upload + wait for READY. */
export async function readyDraft(
  client: AuthClient,
  typeId: string,
  bytes: Buffer = degreePdf(),
  overrides: Record<string, unknown> = {},
): Promise<string> {
  const draft = await createDraft(client, typeId, overrides);
  const requestId = draft['id'] as string;
  await uploadArtifact(client, requestId, bytes);
  const artifact = await waitForArtifact(client, requestId);
  if (artifact['status'] !== 'READY') throw new Error(`artifact ${JSON.stringify(artifact)}`);
  return requestId;
}

export async function submit(client: AuthClient, requestId: string): Promise<request.Response> {
  return client.post(`${ATTESTATIONS}/${requestId}/submit`);
}

// ---------------------------------------------------------------------------
// Institution flow
// ---------------------------------------------------------------------------

export async function startReview(
  reviewer: AuthClient,
  organizationId: string,
  requestId: string,
): Promise<request.Response> {
  return reviewer.post(
    `${orgAttestations(organizationId)}/attestation-requests/${requestId}/start-review`,
  );
}

export function approvalBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    confirm: true,
    certificateTitle: 'Bachelor of Science in Computer Engineering',
    holderName: 'Sara Haddad',
    issuingOrganization: 'Example University',
    issueDate: '2024-06-30',
    referenceNumber: 'BSC-2024-0117',
    validityDays: 365,
    ...overrides,
  };
}

export async function approve(
  reviewer: AuthClient,
  organizationId: string,
  requestId: string,
  overrides: Record<string, unknown> = {},
): Promise<request.Response> {
  return reviewer.post(
    `${orgAttestations(organizationId)}/attestation-requests/${requestId}/approve`,
    approvalBody(overrides),
  );
}

export async function reject(
  reviewer: AuthClient,
  organizationId: string,
  requestId: string,
  reason = 'The certificate number does not match our registry.',
): Promise<request.Response> {
  return reviewer.post(
    `${orgAttestations(organizationId)}/attestation-requests/${requestId}/reject`,
    {
      reason,
    },
  );
}

/** Wait until the decision's payment job has moved the money. */
export async function waitForPayment(
  context: TestContext,
  requestId: string,
  expected: 'SETTLED' | 'RELEASED',
  timeoutMs = 20_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let last = '';
  while (Date.now() < deadline) {
    const row = await context.adminDb.attestationRequest.findUniqueOrThrow({
      where: { id: requestId },
      select: { paymentStatus: true },
    });
    last = row.paymentStatus;
    if (last === expected) return;
    // Nudge the queue in case the immediate dispatch lost a race with the reset.
    const jobs = await context.adminDb.processingJob.findMany({
      where: {
        jobType: 'ATTESTATION_PAYMENT',
        resourceId: requestId,
        status: { in: ['PENDING', 'RETRY_PENDING'] },
      },
      select: { id: true },
    });
    for (const job of jobs) await context.worker.processJobId(job.id);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`payment for ${requestId} is ${last}, not ${expected}`);
}

/** Minor units of available CASH in one currency, from the balance API. */
export async function availableCash(client: AuthClient, currency = 'USD'): Promise<bigint> {
  const response = await client.get(`${API}/balance?currency=${currency}`);
  expectStatus(response, 200, 'Balance read');
  const accounts = (response.body.accounts ?? []) as Array<Record<string, unknown>>;
  const cash = accounts.find((account) => account['creditClass'] === 'CASH');
  const available = cash?.['available'] as { minorUnits: string } | undefined;
  return BigInt(available?.minorUnits ?? '0');
}

export function tokenFromUrl(url: string): string {
  const token = url.split('/').pop();
  if (token === undefined) throw new Error(`no token in ${url}`);
  return token;
}
