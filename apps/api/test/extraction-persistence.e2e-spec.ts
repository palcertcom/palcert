import { AsyncLocalStorage } from 'node:async_hooks';
import { API, type AuthClient } from './support/auth-client';
import {
  grantOrganizationAIConsent,
  guidelineText,
  runExtraction,
  uploadSource,
  extractionBody,
} from './support/extraction-client';
import { minimalDocx, minimalPdf } from './support/fixtures';
import { createTenant } from './support/organization-client';
import { createStandard, createVersion, createDocumentType } from './support/standards-client';
import {
  createTestContext,
  destroyTestContext,
  resetState,
  type TestContext,
} from './support/test-app';
import {
  BACKGROUND_BATCH_TRANSACTION,
  TenantPrismaService,
  type TenantTransactionOptions,
} from '../src/infrastructure/tenant/tenant-prisma.service';

/**
 * Rule extraction's writes, at the sizes a real thesis template produces.
 *
 * On 8443 a real run failed with Prisma P2028 ("Transaction already closed …
 * timeout was 5000 ms, however 5400 ms passed"): every template observation,
 * proposal and evidence link was one sequential upsert inside a single
 * interactive transaction. It was then recorded as UNKNOWN_PROVIDER_ERROR and
 * never retried. These tests pin the replacement: bulk statements, bounded
 * transactions, nothing external inside one, an honest failure kind, and an
 * idempotent retry.
 */

const MAX_OBSERVATIONS = 200; // AI_EXTRACTION_MAX_TEMPLATE_OBSERVATIONS default

/** A Prisma P2028, shaped exactly as the client raises it. */
function transactionExpired(): Error {
  return Object.assign(
    new Error(
      'Transaction already closed: A commit cannot be executed on an expired transaction. ' +
        'The timeout for this transaction was 5000 ms, however 5400 ms passed since the start of the transaction.',
    ),
    { code: 'P2028', name: 'PrismaClientKnownRequestError', clientVersion: 'test' },
  );
}

describe('Rule extraction persistence (e2e)', () => {
  let context: TestContext;
  let owner: AuthClient;
  let organizationId: string;
  let versionId: string;

  /** Set while a tenant transaction's callback is running, for this async chain. */
  const insideTransaction = new AsyncLocalStorage<true>();
  const original = TenantPrismaService.prototype.withTenant;
  /** Every tenant transaction the worker opened for this run: its bound and its duration. */
  let transactions: Array<{ options: TenantTransactionOptions | undefined; ms: number }>;
  /** Called inside a bulk extraction transaction, after its work: may throw. */
  let injectAfterBulkWork: ((call: number) => void) | null;
  let bulkCalls: number;
  /** External calls made while a transaction was open. Must stay empty. */
  let externalCallsInsideTransactions: string[];

  beforeAll(async () => {
    context = await createTestContext();

    jest.spyOn(TenantPrismaService.prototype, 'withTenant').mockImplementation(async function (
      this: TenantPrismaService,
      scope,
      work,
      options,
    ) {
      const started = Date.now();
      const bulk = options === BACKGROUND_BATCH_TRANSACTION;
      const call = bulk ? ++bulkCalls : 0;
      try {
        return await original.call(
          this,
          scope,
          (tx) =>
            insideTransaction.run(true, async () => {
              const result = await work(tx);
              if (bulk) injectAfterBulkWork?.(call);
              return result;
            }),
          options,
        );
      } finally {
        transactions.push({ options, ms: Date.now() - started });
      }
    } as typeof original);

    // Every external call the extraction makes, checked for an open transaction.
    const watch = <T extends object>(target: T, methods: (keyof T)[], label: string): void => {
      for (const method of methods) {
        const real = (target[method] as unknown as (...args: unknown[]) => unknown).bind(target);
        (target as Record<keyof T, unknown>)[method] = (...args: unknown[]) => {
          if (insideTransaction.getStore() === true) {
            externalCallsInsideTransactions.push(`${label}.${String(method)}`);
          }
          return real(...args);
        };
      }
    };
    watch(
      context.aiProvider,
      ['discoverGuidelineEvidence', 'extractRuleProposals', 'countTokens'],
      'ai',
    );
    watch(context.documentEngine, ['analyzeDocument', 'describeDocxProperties'], 'engine');
  });

  afterAll(async () => {
    jest.restoreAllMocks();
    await destroyTestContext(context);
  });

  beforeEach(async () => {
    await resetState(context);
    transactions = [];
    injectAfterBulkWork = null;
    bulkCalls = 0;
    externalCallsInsideTransactions = [];

    const tenant = await createTenant(
      context,
      'Islamic University of Gaza',
      'registrar@example.com',
    );
    owner = tenant.owner.client;
    organizationId = tenant.organizationId;
    const documentType = await createDocumentType(owner, organizationId);
    const standard = await createStandard(owner, organizationId, documentType.id);
    versionId = (await createVersion(owner, organizationId, standard.id)).id;
    await grantOrganizationAIConsent(owner, organizationId);
  });

  /**
   * A thesis template with more measurable properties than a run may keep,
   * plus guidelines, answered with as many proposals and links as allowed.
   */
  async function largeRun(): Promise<void> {
    context.documentEngine.extraFacts = Array.from({ length: MAX_OBSERVATIONS + 50 }, (_, i) => ({
      provenance: { sourceKind: 'OOXML' },
      scope: { kind: 'DOCUMENT', property: `templateMetric${i}` },
      unit: 'COUNT',
      value: { number: String(i + 1), type: 'NUMBER' },
    }));
    await uploadSource(context, owner, organizationId, versionId, {
      sourceKind: 'TEMPLATE_DOCX',
      filename: 'PhD_Template_00.docx',
      bytes: minimalDocx(),
    });
    const requirements = [
      'The left margin must be 30 mm.',
      'The right margin must be 25 mm.',
      'Body text must be 12 pt.',
    ];
    for (const [index, requirement] of requirements.entries()) {
      await uploadSource(context, owner, organizationId, versionId, {
        sourceKind: 'GUIDELINE_PDF',
        filename: `guidelines-${index + 1}.pdf`,
        bytes: minimalPdf(guidelineText(requirement)),
      });
    }
    context.aiProvider.citedTextsByDocument = requirements;
    // Five proposals per call (the test batch size), each citing every item
    // it was given: the most rows and links the run can produce.
    context.aiProvider.proposalKinds = Array.from({ length: 5 }, () => 'TEMPLATE_INFERENCE');
    context.aiProvider.citeAllSuppliedEvidence = true;
  }

  /** As `runExtraction`, with room for the worker's retries of a large run. */
  async function runExtractionWithRetries() {
    const started = await owner.post(
      `${API}/organizations/${organizationId}/standard-versions/${versionId}/extractions`,
      await extractionBody(context, owner),
    );
    expect(started.status).toBe(202);
    const runId = started.body.id as string;
    // A retry is re-published by the outbox sweep once its backoff has passed;
    // the tests drive that sweep instead of waiting on its production timer.
    const deadline = Date.now() + 150_000;
    while (Date.now() < deadline) {
      const row = await context.adminDb.ruleExtractionRun.findUniqueOrThrow({
        where: { id: runId },
      });
      if (['COMPLETED', 'FAILED', 'CANCELLED'].includes(row.status)) {
        return { runId, status: row.status, failureKind: row.failureKind };
      }
      // The test clock is frozen; move it past the retry's backoff first.
      context.clock.advanceMinutes(2 / 60);
      await context.dispatcher.sweep();
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    throw new Error(`extraction ${runId} did not settle`);
  }

  async function counts(runId: string) {
    const [evidence, observations, proposals, links] = await Promise.all([
      context.adminDb.sourceEvidence.count({ where: { extractionRunId: runId } }),
      context.adminDb.templateObservation.count({ where: { extractionRunId: runId } }),
      context.adminDb.ruleProposal.count({ where: { extractionRunId: runId } }),
      context.adminDb.ruleProposalEvidence.count({
        where: { proposal: { extractionRunId: runId } },
      }),
    ]);
    return { evidence, observations, proposals, links };
  }

  it('keeps the maximum observation count and a full set of proposals, within the old 5 s budget', async () => {
    await largeRun();
    const { runId, status, failureKind } = await runExtraction(
      context,
      owner,
      organizationId,
      versionId,
    );
    expect([status, failureKind]).toEqual(['COMPLETED', null]);

    const written = await counts(runId);
    expect(written.observations).toBe(MAX_OBSERVATIONS);
    expect(written.evidence).toBe(3);
    // 203 items in batches of 3, 5 proposals a call: the 150 cap is reached after 30 calls.
    expect(written.proposals).toBe(150);
    expect(written.links).toBeGreaterThanOrEqual(300);

    // The same rows the old code wrote one round trip at a time. Every
    // transaction, the two bulk ones included, now finishes far inside even
    // Prisma's default 5 s.
    const bulk = transactions.filter((entry) => entry.options === BACKGROUND_BATCH_TRANSACTION);
    expect(bulk).toHaveLength(2); // evidence + observations; proposals + settlement
    expect(Math.max(...transactions.map((entry) => entry.ms))).toBeLessThan(5_000);

    const run = await context.adminDb.ruleExtractionRun.findUniqueOrThrow({ where: { id: runId } });
    expect(run.observationCount).toBe(MAX_OBSERVATIONS);
    const pending = await context.adminDb.ruleProposal.count({
      where: { extractionRunId: runId, status: 'PENDING_REVIEW' },
    });
    expect(pending).toBe(150);
  }, 120_000);

  it('never calls the AI provider or the Document Engine inside a database transaction', async () => {
    await largeRun();
    const { status } = await runExtraction(context, owner, organizationId, versionId);
    expect(status).toBe('COMPLETED');
    // The watch really saw the calls, outside any transaction.
    expect(context.aiProvider.proposalCalls.length).toBeGreaterThan(0);
    expect(context.documentEngine.calls.length).toBeGreaterThan(0);
    expect(externalCallsInsideTransactions).toEqual([]);
  }, 120_000);

  it('retries after a transaction timeout, and ends with no duplicate evidence or proposals', async () => {
    await largeRun();
    // The first attempt's final transaction (proposals + settlement) expires
    // after doing all its work, exactly as on 8443. It must roll back whole.
    let injected = 0;
    injectAfterBulkWork = (call) => {
      if (call === 2 && injected === 0) {
        injected += 1;
        throw transactionExpired();
      }
    };

    const { runId, status, failureKind } = await runExtractionWithRetries();
    expect(injected).toBe(1);
    expect([status, failureKind]).toEqual(['COMPLETED', null]);

    // The first attempt's evidence committed; the retry found it by hash.
    const written = await counts(runId);
    expect(written.evidence).toBe(3);
    expect(written.observations).toBe(MAX_OBSERVATIONS);
    expect(written.proposals).toBe(150);
    const distinctKeys = await context.adminDb.ruleProposal.groupBy({
      by: ['proposalKey'],
      where: { extractionRunId: runId },
    });
    expect(distinctKeys).toHaveLength(150);
    const duplicateLinks = await context.adminDb.$queryRaw<{ n: bigint }[]>`
      SELECT count(*)::bigint AS n FROM (
        SELECT proposal_id, source_evidence_id, template_observation_id
          FROM rule_proposal_evidence
         GROUP BY 1, 2, 3 HAVING count(*) > 1) AS d`;
    expect(Number(duplicateLinks[0]!.n)).toBe(0);

    // Two structuring passes ran (the first rolled back), which is the price
    // of a retry — and nothing from the first survives as a proposal.
    const structuring = await context.adminDb.extractionInvocation.count({
      where: { extractionRunId: runId, purpose: 'GUIDELINE_RULE_STRUCTURING' },
    });
    // 150 proposals at 5 per call is 30 calls; the cap stops Pass B there.
    expect(structuring).toBe(2 * 30);
  }, 300_000);

  it('records a persistent P2028 as a database failure, never as the AI provider', async () => {
    await uploadSource(context, owner, organizationId, versionId, {
      sourceKind: 'GUIDELINE_PDF',
      filename: 'guidelines.pdf',
      bytes: minimalPdf(guidelineText('The left margin must be 30 mm.')),
    });
    injectAfterBulkWork = () => {
      throw transactionExpired();
    };

    const { runId, status, failureKind } = await runExtractionWithRetries();
    expect(status).toBe('FAILED');
    expect(failureKind).toBe('DATABASE_TRANSACTION_FAILED');
    expect(failureKind).not.toBe('UNKNOWN_PROVIDER_ERROR');

    const run = await context.adminDb.ruleExtractionRun.findUniqueOrThrow({ where: { id: runId } });
    expect(run.failureDetail).toBe('PalCert could not save the results in time');
    // Retried by the worker's ladder (QUEUE_MAX_ATTEMPTS=3) before giving up.
    expect(bulkCalls).toBeGreaterThanOrEqual(3);
    // Nothing half-written: every attempt's transaction rolled back.
    expect((await counts(runId)).proposals).toBe(0);

    // What the browser sees: PalCert's kind, and no Prisma detail at all.
    const shown = await owner.get(
      `${API}/organizations/${organizationId}/standard-versions/${versionId}/extractions/${runId}`,
    );
    expect(shown.status).toBe(200);
    expect(shown.body.failureKind).toBe('DATABASE_TRANSACTION_FAILED');
    const body = JSON.stringify(shown.body);
    for (const leak of ['P2028', 'Transaction already closed', 'Prisma', '5400 ms']) {
      expect(body).not.toContain(leak);
    }
  }, 300_000);

  it('keeps every batched write inside its own tenant', async () => {
    await largeRun();
    const { runId, status } = await runExtraction(context, owner, organizationId, versionId);
    expect(status).toBe('COMPLETED');

    const other = await createTenant(context, 'Another University', 'other@example.com');
    const tenantDb = context.workerApp.get(TenantPrismaService);
    const seenBy = (orgId: string, userId: string) =>
      original.call(tenantDb, { organizationId: orgId, userId }, async (tx) => ({
        evidence: await tx.sourceEvidence.count({ where: { extractionRunId: runId } }),
        observations: await tx.templateObservation.count({ where: { extractionRunId: runId } }),
        proposals: await tx.ruleProposal.count({ where: { extractionRunId: runId } }),
        links: await tx.ruleProposalEvidence.count({
          where: { proposal: { extractionRunId: runId } },
        }),
      }));

    const own = await seenBy(organizationId, (await owner.get(`${API}/users/me`)).body.id);
    const foreign = await seenBy(other.organizationId, other.owner.userId);
    const all = await counts(runId);

    expect(own).toEqual(all);
    expect(foreign).toEqual({ evidence: 0, observations: 0, proposals: 0, links: 0 });

    // Every row carries its organization, so RLS decided visibility, not luck.
    for (const table of [
      'source_evidence',
      'template_observations',
      'rule_proposals',
      'rule_proposal_evidence',
    ]) {
      const foreignRows = await context.adminDb.$queryRawUnsafe<{ n: bigint }[]>(
        `SELECT count(*)::bigint AS n FROM ${table} WHERE organization_id <> $1::uuid`,
        organizationId,
      );
      expect([table, Number(foreignRows[0]!.n)]).toEqual([table, 0]);
    }
  }, 120_000);
});
