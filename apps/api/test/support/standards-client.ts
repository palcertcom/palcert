import type request from 'supertest';
import { API, type AuthClient } from './auth-client';

/**
 * Helpers for driving the standards surface over HTTP.
 *
 * Everything goes through the real API rather than through Prisma: a fixture
 * that writes rows directly would bypass the guards, the validation and the
 * row-level security these tests exist to exercise.
 */

export const ORG_ROLE = {
  OWNER: 'ORGANIZATION_OWNER',
  ADMIN: 'ORGANIZATION_ADMIN',
  REVIEWER: 'ORGANIZATION_REVIEWER',
  TEMPLATE_MANAGER: 'TEMPLATE_MANAGER',
} as const;

export function standardsBase(organizationId: string): string {
  return `${API}/organizations/${organizationId}/standards`;
}

export function documentTypesBase(organizationId: string): string {
  return `${API}/organizations/${organizationId}/document-types`;
}

/** The revision to send back as `If-Match`, read from a response's ETag. */
export function etagOf(response: request.Response): string {
  const etag = response.headers['etag'];
  if (typeof etag !== 'string') {
    throw new Error(`Response carried no ETag (status ${response.status})`);
  }
  return etag;
}

export function ifMatch(response: request.Response): { headers: Record<string, string> } {
  return { headers: { 'If-Match': etagOf(response) } };
}

export function ifMatchRevision(revision: number): { headers: Record<string, string> } {
  return { headers: { 'If-Match': `"${revision}"` } };
}

function expectStatus(response: request.Response, expected: number, what: string): void {
  if (response.status !== expected) {
    throw new Error(`${what} failed (${response.status}): ${JSON.stringify(response.body)}`);
  }
}

export async function createDocumentType(
  client: AuthClient,
  organizationId: string,
  overrides: Partial<{ systemCategory: string; name: string; nameAr: string }> = {},
): Promise<{ id: string; body: Record<string, unknown> }> {
  const response = await client.post(documentTypesBase(organizationId), {
    systemCategory: overrides.systemCategory ?? 'THESIS',
    name: overrides.name ?? "Master's Thesis",
    ...(overrides.nameAr === undefined ? {} : { nameAr: overrides.nameAr }),
  });
  expectStatus(response, 201, 'Document type creation');
  return { id: response.body.id, body: response.body };
}

export async function createStandard(
  client: AuthClient,
  organizationId: string,
  documentTypeId: string,
  overrides: Partial<{ code: string; nameEn: string; nameAr: string }> = {},
): Promise<{ id: string; body: Record<string, unknown> }> {
  const response = await client.post(standardsBase(organizationId), {
    documentTypeId,
    code: overrides.code ?? 'IUG.THESIS.FORMAT',
    nameEn: overrides.nameEn ?? 'IUG Thesis Formatting',
    nameAr: overrides.nameAr ?? 'تنسيق رسائل الجامعة الإسلامية',
  });
  expectStatus(response, 201, 'Standard creation');
  return { id: response.body.id, body: response.body };
}

export async function createVersion(
  client: AuthClient,
  organizationId: string,
  standardId: string,
  versionLabel = '1.0',
): Promise<{ id: string; revision: number; body: Record<string, unknown> }> {
  const response = await client.post(`${standardsBase(organizationId)}/${standardId}/versions`, {
    versionLabel,
  });
  expectStatus(response, 201, 'Version creation');
  return { id: response.body.id, revision: response.body.revision, body: response.body };
}

/** A rule that validates cleanly. Each test perturbs exactly what it is about. */
export function validRule(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    ruleCode: 'MARGIN.TOP.MIN',
    category: 'MARGINS',
    evaluationMode: 'DETERMINISTIC',
    scope: { kind: 'DOCUMENT', property: 'marginTop' },
    operator: 'GREATER_THAN_OR_EQUAL',
    expected: { type: 'NUMBER', number: 25 },
    unit: 'MILLIMETRE',
    tolerance: 0.5,
    severity: 'MAJOR',
    blocking: true,
    autofix: 'SAFE',
    origin: 'ORGANIZATION_POLICY',
    titleEn: 'Top margin at least 25 mm',
    titleAr: 'الهامش العلوي 25 مم على الأقل',
    ...overrides,
  };
}

/**
 * Add a rule to a draft, keeping the caller's revision in step.
 *
 * Every rule mutation bumps the parent version's revision, so a test that adds
 * two rules must send the *new* revision the second time. Returning it here
 * keeps that bookkeeping out of the test bodies.
 */
export async function addRule(
  client: AuthClient,
  organizationId: string,
  standardId: string,
  versionId: string,
  revision: number,
  rule: Record<string, unknown> = validRule(),
): Promise<{ id: string; revision: number; body: Record<string, unknown> }> {
  const response = await client.post(
    `${standardsBase(organizationId)}/${standardId}/versions/${versionId}/rules`,
    rule,
    ifMatchRevision(revision),
  );
  expectStatus(response, 201, `Rule creation (${String(rule.ruleCode)})`);
  return {
    id: response.body.id,
    revision: Number.parseInt(etagOf(response).replaceAll('"', ''), 10),
    body: response.body,
  };
}

export async function publishVersion(
  client: AuthClient,
  organizationId: string,
  standardId: string,
  versionId: string,
  body?: { replacesVersionId?: string | null },
): Promise<request.Response> {
  return client.post(
    `${standardsBase(organizationId)}/${standardId}/versions/${versionId}/publish`,
    body,
  );
}

/**
 * A tenant with a document type, a standard and a draft carrying one rule —
 * the starting point for most publication and immutability tests.
 */
export async function seedDraft(
  client: AuthClient,
  organizationId: string,
): Promise<{
  documentTypeId: string;
  standardId: string;
  versionId: string;
  ruleId: string;
  revision: number;
}> {
  const documentType = await createDocumentType(client, organizationId);
  const standard = await createStandard(client, organizationId, documentType.id);
  const version = await createVersion(client, organizationId, standard.id);
  const rule = await addRule(client, organizationId, standard.id, version.id, version.revision);

  return {
    documentTypeId: documentType.id,
    standardId: standard.id,
    versionId: version.id,
    ruleId: rule.id,
    revision: rule.revision,
  };
}

/** Grant an organization role to an existing member, as the owner. */
export async function grantOrganizationRole(
  owner: AuthClient,
  organizationId: string,
  membershipId: string,
  roleCode: string,
): Promise<void> {
  const response = await owner.post(
    `${API}/organizations/${organizationId}/members/${membershipId}/roles`,
    { roleCode },
  );
  if (response.status !== 200 && response.status !== 201) {
    throw new Error(`Role grant failed (${response.status}): ${JSON.stringify(response.body)}`);
  }
}

export async function removeOrganizationRole(
  owner: AuthClient,
  organizationId: string,
  membershipId: string,
  roleCode: string,
): Promise<void> {
  const response = await owner.delete(
    `${API}/organizations/${organizationId}/members/${membershipId}/roles/${roleCode}`,
  );
  if (response.status !== 200 && response.status !== 204) {
    throw new Error(`Role removal failed (${response.status}): ${JSON.stringify(response.body)}`);
  }
}
