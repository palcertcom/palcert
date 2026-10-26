import type request from 'supertest';
import { API, type AuthClient } from './auth-client';
import type { TestContext } from './test-app';
import { fundForCheck } from './paid-check-client';
import {
  addRule,
  createDocumentType,
  createStandard,
  createVersion,
  publishVersion,
  standardsBase,
  validRule,
} from './standards-client';

/**
 * Helpers for driving the check surface over HTTP.
 *
 * Like the standards client, everything goes through the real API: a fixture
 * writing check rows directly would bypass exactly the guards, the catalogue
 * eligibility and the row-level security these suites exist to prove.
 */

export function expectStatus(response: request.Response, expected: number, what: string): void {
  if (response.status !== expected) {
    throw new Error(`${what} failed (${response.status}): ${JSON.stringify(response.body)}`);
  }
}

/** Mark an organization verified, which the catalogue requires (§18). */
export async function verifyOrganization(
  context: TestContext,
  organizationId: string,
): Promise<void> {
  await context.adminDb.organization.update({
    where: { id: organizationId },
    data: { verificationStatus: 'VERIFIED' },
  });
}

export async function setCheckAvailability(
  client: AuthClient,
  organizationId: string,
  standardId: string,
  checkAvailability: 'PRIVATE' | 'PUBLIC_CHECKABLE',
): Promise<request.Response> {
  return client.patch(`${standardsBase(organizationId)}/${standardId}/check-availability`, {
    checkAvailability,
  });
}

export interface PublishedStandard {
  readonly documentTypeId: string;
  readonly standardId: string;
  readonly standardVersionId: string;
  readonly organizationId: string;
}

/**
 * An organization with a verified profile and one published, publicly
 * checkable standard — the state a student needs before they can check
 * anything at all.
 */
export async function publishCheckableStandard(
  context: TestContext,
  owner: AuthClient,
  organizationId: string,
  options: {
    rules?: Record<string, unknown>[];
    standardCode?: string;
    documentTypeName?: string;
    public?: boolean;
  } = {},
): Promise<PublishedStandard> {
  await verifyOrganization(context, organizationId);

  const documentType = await createDocumentType(owner, organizationId, {
    ...(options.documentTypeName === undefined ? {} : { name: options.documentTypeName }),
  });
  const standard = await createStandard(owner, organizationId, documentType.id, {
    code: options.standardCode ?? 'IUG.THESIS.FORMAT',
  });
  const version = await createVersion(owner, organizationId, standard.id);

  let revision = version.revision;
  for (const rule of options.rules ?? [validRule()]) {
    const added = await addRule(owner, organizationId, standard.id, version.id, revision, rule);
    revision = added.revision;
  }

  const published = await publishVersion(owner, organizationId, standard.id, version.id);
  expectStatus(published, 200, 'Version publication');

  if (options.public !== false) {
    const availability = await setCheckAvailability(
      owner,
      organizationId,
      standard.id,
      'PUBLIC_CHECKABLE',
    );
    expectStatus(availability, 200, 'Catalogue publication');
  }

  return {
    documentTypeId: documentType.id,
    standardId: standard.id,
    standardVersionId: version.id,
    organizationId,
  };
}

/**
 * An AI-assisted rule, as a standard's author would write one.
 *
 * These are the requirements that need reading rather than measuring — an
 * ethics declaration, a conflict-of-interest statement — so the deterministic
 * engine records them as INDETERMINATE with review required, and Phase 8 may
 * add an advisory assessment beside that.
 */
export function aiAssistedRule(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    ruleCode: 'COI.DECLARATION',
    category: 'RESEARCH_ETHICS',
    evaluationMode: 'AI_ASSISTED',
    scope: { kind: 'DOCUMENT', property: 'conflictOfInterestStatement' },
    operator: 'EXISTS',
    expected: { type: 'NONE' },
    severity: 'MAJOR',
    blocking: false,
    autofix: 'NONE',
    origin: 'ORGANIZATION_POLICY',
    titleEn: 'Conflict of interest declared',
    titleAr: 'الإفصاح عن تضارب المصالح',
    guidanceEn: 'State whether any author has a competing interest.',
    guidanceAr: 'بيّن ما إذا كان لأي مؤلف مصلحة متعارضة.',
    ...overrides,
  };
}

/** A rule only a person can judge. It must never be sent to a model (§23). */
export function manualRule(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return aiAssistedRule({
    ruleCode: 'SUPERVISOR.SIGNOFF',
    evaluationMode: 'MANUAL',
    titleEn: 'Supervisor sign-off present',
    titleAr: 'توقيع المشرف موجود',
    ...overrides,
  });
}

/**
 * Start a check the way the product does since Phase 11: with a quote.
 *
 * A caller that already has a quote passes it. A caller that does not — which
 * is every test written before checks were paid for — gets one, along with the
 * price and the balance it needs. That keeps those tests about what they were
 * always about, while running them down the only path production has.
 */
export async function startCheck(
  context: TestContext,
  owner: { client: AuthClient; userId: string },
  body: { documentVersionId: string; standardId: string; priceQuoteId?: string },
  headers: Record<string, string> = {},
): Promise<request.Response> {
  const priceQuoteId = body.priceQuoteId ?? (await fundForCheck(context, owner.userId)).quoteId;
  return owner.client.post(
    `${API}/checks`,
    { documentVersionId: body.documentVersionId, standardId: body.standardId, priceQuoteId },
    { headers },
  );
}

/**
 * Wait for the live worker to settle a check.
 *
 * The test context runs the real worker on the real queue, so checks travel
 * the path production uses rather than being driven by calling the handler.
 */
export async function waitForCheck(
  context: TestContext,
  checkId: string,
  timeoutMs = 30_000,
): Promise<{ status: string; failureCode: string | null }> {
  const deadline = Date.now() + timeoutMs;
  let last = 'CREATED';
  while (Date.now() < deadline) {
    const row = await context.adminDb.documentCheck.findUniqueOrThrow({ where: { id: checkId } });
    last = row.status;
    if (row.status === 'COMPLETED' || row.status === 'FAILED' || row.status === 'CANCELLED') {
      return { status: row.status, failureCode: row.failureCode };
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`check ${checkId} did not settle in ${timeoutMs} ms (last ${last})`);
}

/**
 * Drive a check's evaluation job until it dies or the check settles.
 *
 * The test context runs on a fake clock, so a retry's backoff never becomes
 * due on its own. Advancing the clock and sweeping is how a test exercises the
 * real retry ladder rather than waiting for wall time that never passes.
 */
export async function exhaustCheckAttempts(
  context: TestContext,
  checkId: string,
  maxRounds = 10,
): Promise<{ status: string; failureCode: string | null }> {
  for (let round = 0; round < maxRounds; round += 1) {
    const check = await context.adminDb.documentCheck.findUniqueOrThrow({ where: { id: checkId } });
    if (check.status === 'COMPLETED' || check.status === 'FAILED') {
      return { status: check.status, failureCode: check.failureCode };
    }
    context.clock.advanceMinutes(5);
    await context.dispatcher.sweep();
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  const check = await context.adminDb.documentCheck.findUniqueOrThrow({ where: { id: checkId } });
  throw new Error(
    `check ${checkId} did not settle after ${maxRounds} rounds (last ${check.status})`,
  );
}

/** Wait until an attempt has been recorded against the check's current run. */
export async function waitForRunFailureRecorded(
  context: TestContext,
  checkId: string,
  timeoutMs = 20_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const run = await context.adminDb.checkRun.findFirst({
      where: { checkId },
      orderBy: { attemptNumber: 'desc' },
    });
    if (run !== null && (run.failureCode !== null || run.status === 'FAILED')) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`no attempt recorded for check ${checkId} in ${timeoutMs} ms`);
}
