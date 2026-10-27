import { CAPABILITY_REGISTRY_VERSION, SMARTFIX_ENGINE_VERSION } from '@palcert/contracts';
import { SmartFixFinalizeService } from './smartfix-finalize.service';
import { SmartFixRequestService } from './smartfix-request.service';

// Unit boundaries: exercise the real request/finalization methods without IO.
jest.mock(
  '../../../infrastructure/tenant/tenant-prisma.service',
  () => ({ TenantPrismaService: class {} }),
  { virtual: true },
);
jest.mock(
  '../../../infrastructure/queue/processing-job.service',
  () => ({ ProcessingJobService: class {} }),
  { virtual: true },
);
jest.mock(
  '../../../infrastructure/queue/outbox-dispatcher',
  () => ({ OutboxDispatcher: class {} }),
  { virtual: true },
);
jest.mock('../../auth/ports/clock.port', () => ({ ClockPort: class {} }), { virtual: true });
jest.mock(
  '../../auth/services/security-event.service',
  () => ({ SecurityEventService: class {} }),
  { virtual: true },
);
jest.mock(
  '../../finance/services/service-purchase.service',
  () => ({ ServicePurchaseService: class {} }),
  { virtual: true },
);
jest.mock('../../checks/services/catalogue.service', () => ({ CatalogueService: class {} }), {
  virtual: true,
});
jest.mock('./smartfix-plan.service', () => ({ SmartFixPlanService: class {} }), { virtual: true });
jest.mock('./smartfix-settlement.service', () => ({ SmartFixSettlementService: class {} }), {
  virtual: true,
});
jest.mock(
  './smartfix-execution.service',
  () => ({
    SmartFixFailure: class extends Error {
      constructor(
        readonly code: string,
        detail: string,
      ) {
        super(detail);
      }
    },
  }),
  { virtual: true },
);

const logger = { setContext: jest.fn() };
const clock = { now: () => new Date('2026-10-23T00:00:00Z') };
const source = { standardVersionId: 'standard-version', standardContentHash: 'sha256:standard' };
const fixed = { ruleCode: 'FONT', fixability: 'FIXABLE' };
const engine = {
  fixEngineVersion: SMARTFIX_ENGINE_VERSION,
  capabilityRegistryVersion: CAPABILITY_REGISTRY_VERSION,
};

describe('SmartFix full completion orchestration', () => {
  it.each(['NOT_SUPPORTED', 'PARTIALLY_FIXABLE'])(
    'blocks %s before reserving or enqueuing',
    async (fixability) => {
      const tenant = { withUser: jest.fn() };
      const purchases = { reserve: jest.fn() };
      const jobs = { enqueueInTransaction: jest.fn() };
      const plans = {
        byId: jest.fn(async () => ({
          id: 'plan',
          refusalCode: null,
          actionCount: 1,
          fixEngineVersion: SMARTFIX_ENGINE_VERSION,
          expiresAt: new Date('2026-10-24T00:00:00Z'),
        })),
        artifact: jest.fn(async () => ({
          plan: { engine, rules: [fixed, { ruleCode: 'OTHER', fixability }] },
        })),
      };
      const service = new SmartFixRequestService(
        tenant as never,
        plans as never,
        purchases as never,
        {} as never,
        jobs as never,
        {} as never,
        {} as never,
        clock as never,
        logger as never,
        {} as never,
      );
      await expect(
        service.start('user', { planId: 'plan', priceQuoteId: 'quote' }, {} as never),
      ).rejects.toMatchObject({ code: 'SMARTFIX_NOT_AVAILABLE' });
      expect(tenant.withUser).not.toHaveBeenCalled();
      expect(purchases.reserve).not.toHaveBeenCalled();
      expect(jobs.enqueueInTransaction).not.toHaveBeenCalled();
    },
  );

  function finalizer(outcomes: Record<string, string>, snapshotHash = source.standardContentHash) {
    const plans = { artifact: jest.fn(async () => ({ plan: { source, rules: [fixed] } })) };
    const catalogue = {
      snapshotForVersion: jest.fn(async () => ({
        contentHash: snapshotHash,
        canonical: { rules: [{ ruleCode: 'FONT' }, { ruleCode: 'OTHER' }] },
      })),
    };
    const tenant = {
      withUser: jest.fn(async (_user: string, action: (tx: unknown) => unknown) =>
        action({
          checkRuleResult: {
            findMany: jest.fn(async ({ where }: { where: { run: { checkId: string } } }) =>
              Object.entries(
                where.run.checkId === 'before' ? { FONT: 'FAIL', OTHER: 'FAIL' } : outcomes,
              ).map(([ruleCode, outcome]) => ({
                ruleCode,
                outcome,
                evaluationMode: 'DETERMINISTIC',
                checkRunId: where.run.checkId,
              })),
            ),
          },
        }),
      ),
    };
    return new SmartFixFinalizeService(
      tenant as never,
      plans as never,
      catalogue as never,
      {} as never,
      {} as never,
      clock as never,
      logger as never,
    );
  }
  const params = { planId: 'plan', originalCheckId: 'before', recheckId: 'after' };

  it.each(['FAIL', 'INDETERMINATE', 'ERROR'])(
    'blocks an untargeted %s in the actual finalizer',
    async (outcome) => {
      await expect(
        finalizer({ FONT: 'PASS', OTHER: outcome }).validate('user', params),
      ).resolves.toMatchObject({ resolved: ['FONT'], unresolved: ['OTHER'] });
    },
  );
  it('blocks a missing published rule result', async () => {
    await expect(finalizer({ FONT: 'PASS' }).validate('user', params)).resolves.toMatchObject({
      unresolved: ['OTHER'],
    });
  });
  it('validates a completely passing recheck', async () => {
    await expect(
      finalizer({ FONT: 'PASS', OTHER: 'PASS' }).validate('user', params),
    ).resolves.toEqual({ resolved: ['FONT'], unresolved: [], regressed: [] });
  });
  it('refuses a different source standard snapshot', async () => {
    await expect(
      finalizer({ FONT: 'PASS', OTHER: 'PASS' }, 'changed').validate('user', params),
    ).rejects.toMatchObject({ code: 'SMARTFIX_TARGETS_NOT_RESOLVED' });
  });
});
