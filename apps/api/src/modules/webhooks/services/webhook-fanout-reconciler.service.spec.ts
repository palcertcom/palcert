import { ProcessingJobType } from '@palcert/contracts';

import { WebhookFanoutReconciler } from './webhook-fanout-reconciler.service';

/**
 * What the reconciler's bounded scan does and does not promise.
 *
 * It is oldest-first, bounded, and carries no cursor between passes. The claim
 * worth testing is the one a comment used to overstate: one event that cannot
 * be enqueued does not stop the pass for the events behind it.
 */
describe('WebhookFanoutReconciler', () => {
  function build(orphans: string[], failing: string[]) {
    const enqueueInTransaction = jest.fn(
      async (_tx: unknown, params: { resourceId: string; type: string }) => {
        if (failing.includes(params.resourceId)) {
          throw new Error(`cannot enqueue ${params.resourceId}`);
        }
        return { id: `job-${params.resourceId}` };
      },
    );

    const prisma = {
      $queryRawUnsafe: jest.fn().mockResolvedValue(orphans.map((id) => ({ id }))),
      $transaction: jest.fn(async (fn: (tx: unknown) => Promise<unknown>) => fn({})),
    };

    const service = new WebhookFanoutReconciler(
      prisma as never,
      { enqueueInTransaction } as never,
      { dispatchNow: jest.fn() } as never,
      { now: () => new Date('2026-06-01T12:00:00.000Z') } as never,
      { setContext: jest.fn(), info: jest.fn(), warn: jest.fn() } as never,
    );

    return { service, enqueueInTransaction };
  }

  it('keeps going past an event it cannot enqueue', async () => {
    const { service, enqueueInTransaction } = build(['a', 'b', 'c'], ['b']);

    // Two of three created, and the failure is in the middle: the events behind
    // it were still reached in this same pass.
    expect(await service.reconcile()).toBe(2);
    expect(enqueueInTransaction).toHaveBeenCalledTimes(3);
    expect(enqueueInTransaction.mock.calls.map((call) => call[1].resourceId)).toEqual([
      'a',
      'b',
      'c',
    ]);
  });

  it('creates the fan-out job and nothing else', async () => {
    const { service, enqueueInTransaction } = build(['a'], []);
    await service.reconcile();
    expect(enqueueInTransaction).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        type: ProcessingJobType.WEBHOOK_FANOUT,
        resourceType: 'DOMAIN_EVENT',
        resourceId: 'a',
      }),
    );
  });
});
