import { SmartFixPlanningBillingService } from './smartfix-planning-billing.service';
import { FakeClock } from '../../auth/ports/clock.port';

function fixture(status = 'PLANNING', aiReservationTtlSeconds = 7200) {
  const clock = new FakeClock();
  const row = {
    id: 'reservation',
    ownerUserId: 'user',
    checkId: 'check',
    servicePurchaseId: 'purchase',
    planId: status === 'PLANNING' ? null : 'reservation',
    status,
    createdAt: clock.now(),
    expiresAt: clock.plusMinutes(60),
  };
  const tx = {
    $queryRaw: jest.fn(),
    smartFixPlanningReservation: {
      findFirst: jest.fn(async () => row),
      findMany: jest.fn(async () => [{ id: row.id, ownerUserId: row.ownerUserId }]),
      update: jest.fn(async ({ data }) => Object.assign(row, data)),
      create: jest.fn(async ({ data }) => data),
    },
    servicePurchase: { findFirst: jest.fn(async () => ({ id: 'purchase' })) },
  };
  const tenant = {
    withUser: jest.fn(async (_user, work) => work(tx)),
    withPlatformAdmin: jest.fn(async (_scope, work) => work(tx)),
  };
  const billing = {
    audit: jest.fn(),
    reserve: jest.fn(),
    assertReservationLive: jest.fn(),
    markProcessing: jest.fn(),
    release: jest.fn(),
  };
  const service = new SmartFixPlanningBillingService(
    tenant as never,
    billing as never,
    clock,
    { payments: { aiReservationTtlSeconds } } as never,
    { setContext: jest.fn(), error: jest.fn() } as never,
  );
  return { service, tx, billing, row, clock };
}

describe('one purchase from AI planning through execution', () => {
  it('reserves before creating the durable planning record', async () => {
    const { service, tx, billing } = fixture();
    tx.smartFixPlanningReservation.findFirst.mockResolvedValue(null as never);
    const order: string[] = [];
    billing.reserve.mockImplementation(async () => {
      order.push('reserve');
    });
    tx.smartFixPlanningReservation.create.mockImplementation(async ({ data }) => {
      order.push('record');
      return data;
    });
    const result = await service.reserve('user', 'check', 'quote');
    expect(order).toEqual(['reserve', 'record']);
    expect(billing.reserve).toHaveBeenCalledWith(
      tx,
      expect.objectContaining({
        payerUserId: 'user',
        priceQuoteId: 'quote',
        resourceId: result.reservation.id,
        purchaseId: result.reservation.servicePurchaseId,
      }),
    );
  });
  it.each([
    [7200, 60],
    [3600, 30],
    [600, 5],
  ])(
    'with a %i s hold, ends the approval window after %i min so execution keeps half the hold',
    async (ttlSeconds, windowMinutes) => {
      const { service, tx, clock } = fixture('PLANNING', ttlSeconds);
      tx.smartFixPlanningReservation.findFirst.mockResolvedValue(null as never);
      const { reservation } = await service.reserve('user', 'check', 'quote');
      expect(reservation.expiresAt).toEqual(clock.plusMinutes(windowMinutes));
      // The hold placed at the same instant outlives the last approval by at
      // least half its lifetime.
      const holdExpiresAt = clock.now().getTime() + ttlSeconds * 1000;
      expect(holdExpiresAt - reservation.expiresAt.getTime()).toBeGreaterThanOrEqual(
        (ttlSeconds * 1000) / 2,
      );
    },
  );
  it('does not create a reservation when balance or quote validation fails', async () => {
    const { service, tx, billing } = fixture();
    tx.smartFixPlanningReservation.findFirst.mockResolvedValue(null as never);
    billing.reserve.mockRejectedValue(new Error('insufficient balance'));
    await expect(service.reserve('user', 'check', 'quote')).rejects.toThrow('insufficient balance');
    expect(tx.smartFixPlanningReservation.create).not.toHaveBeenCalled();
  });
  it('recovers a completed plan for the same quote without another purchase', async () => {
    const { service, billing, row } = fixture('READY');
    await expect(service.reserve('user', 'check', 'quote')).resolves.toEqual({
      reservation: row,
      reused: true,
    });
    expect(billing.reserve).not.toHaveBeenCalled();
    await expect(service.reserve('user', 'other-check', 'quote')).rejects.toMatchObject({
      code: 'SMARTFIX_NOT_AVAILABLE',
    });
  });
  it('refuses an in-flight duplicate without another provider reservation', async () => {
    const { service, billing } = fixture();
    await expect(service.reserve('user', 'check', 'quote')).rejects.toMatchObject({
      code: 'SMARTFIX_NOT_AVAILABLE',
    });
    expect(billing.reserve).not.toHaveBeenCalled();
  });
  it('releases incomplete plans and never captures on planning success', async () => {
    const { service, tx, billing, row } = fixture();
    await service.finish(tx as never, 'user', row.id, false);
    expect(row.status).toBe('FAILED');
    expect(billing.release).toHaveBeenCalledWith(tx, 'purchase', 'SERVICE_FAILED');
    const good = fixture();
    await good.service.finish(good.tx as never, 'user', good.row.id, true);
    expect(good.row.status).toBe('READY');
    expect(good.billing.release).not.toHaveBeenCalled();
  });
  it('approval uses the original quote and live purchase', async () => {
    const { service, tx, billing } = fixture('READY');
    await expect(
      service.forApproval(tx as never, 'user', 'reservation', 'quote'),
    ).resolves.toMatchObject({ servicePurchaseId: 'purchase' });
    expect(billing.reserve).not.toHaveBeenCalled();
    expect(billing.assertReservationLive).toHaveBeenCalledWith(tx, 'purchase');
    tx.servicePurchase.findFirst.mockResolvedValue(null as never);
    await expect(
      service.forApproval(tx as never, 'user', 'reservation', 'different-quote'),
    ).rejects.toMatchObject({ code: 'SMARTFIX_NOT_AVAILABLE' });
  });
  it('cancels once and prevents subsequent AI calls', async () => {
    const { service, billing, row } = fixture();
    await service.release('user', row.id, true);
    await service.release('user', row.id, true);
    expect(row.status).toBe('CANCELLED');
    expect(billing.release).toHaveBeenCalledTimes(1);
    await expect(service.assertReservationLive('user', row.id)).rejects.toMatchObject({
      code: 'SMARTFIX_NOT_AVAILABLE',
    });
    expect(billing.markProcessing).not.toHaveBeenCalled();
  });
  it('leaves consumed reservations to correction settlement', async () => {
    const { service, billing, row } = fixture('CONSUMED');
    await service.release('user', row.id);
    await expect(service.release('user', row.id, true)).rejects.toMatchObject({
      code: 'SMARTFIX_NOT_AVAILABLE',
    });
    expect(billing.release).not.toHaveBeenCalled();
  });
  it('recovers a crashed planner after two minutes', async () => {
    const { service, billing, row, clock } = fixture();
    clock.advanceMinutes(2);
    await service.sweep();
    expect(row.status).toBe('FAILED');
    expect(billing.release).toHaveBeenCalledWith(
      expect.anything(),
      'purchase',
      'RESERVATION_EXPIRED',
    );
  });
  it('rechecks expiry after locking so a newly READY plan is not released', async () => {
    const { service, billing, row, clock } = fixture('READY');
    clock.advanceMinutes(2);
    await service.sweep();
    expect(row.status).toBe('READY');
    expect(billing.release).not.toHaveBeenCalled();
    clock.advanceMinutes(59);
    await service.sweep();
    expect(row.status).toBe('FAILED');
    expect(billing.release).toHaveBeenCalledTimes(1);
  });
});
