import { PalCertErrorCode } from '@palcert/contracts';
import { DocumentCheckService, type CreateCheckInput } from './document-check.service';

describe('document check creation after a concurrent idempotent request commits', () => {
  const input: CreateCheckInput = {
    documentVersionId: 'version',
    standardId: 'standard',
    priceQuoteId: 'quote',
    idempotencyKey: 'retry-key',
  };

  function setup() {
    const winner = {
      id: 'winning-check',
      ownerUserId: 'customer',
      documentVersionId: input.documentVersionId,
      standardId: input.standardId,
      servicePurchaseId: 'winning-purchase',
    };
    const tx = {
      $queryRaw: jest.fn().mockResolvedValue([]),
      documentCheck: {
        // The first request has not committed at the initial fast-path read.
        // It is visible by the time this request starts its transaction.
        findFirst: jest.fn().mockResolvedValueOnce(null).mockResolvedValue(winner),
        findUnique: jest.fn().mockResolvedValue(winner),
        create: jest.fn().mockRejectedValue(new Error('purchase does not exist')),
      },
      documentVersion: {
        findFirst: jest.fn().mockResolvedValue({
          id: input.documentVersionId,
          documentId: 'document',
          document: { status: 'READY' },
          status: 'READY',
          detectedFormat: 'DOCX',
          sha256: 'hash',
          cleanObjectKey: 'clean',
        }),
      },
      priceQuote: {
        // Reproduce the failing interleaving: this read saw an unused quote,
        // but reserve() then returned the other request's committed purchase.
        findFirst: jest.fn().mockResolvedValue({
          id: input.priceQuoteId,
          productCode: 'DOCUMENT_CHECK',
          expiresAt: new Date('2026-11-01'),
          purchase: null,
          amountMinor: 300n,
          currency: 'USD',
          priceVersionId: 'price',
        }),
      },
      servicePurchase: {
        findUnique: jest.fn().mockResolvedValue({ priceQuoteId: input.priceQuoteId }),
      },
    };
    const tenant = {
      withUser: jest.fn(async (_userId: string, work: (value: typeof tx) => Promise<unknown>) =>
        work(tx),
      ),
    };
    const reserve = jest.fn().mockResolvedValue({ id: winner.servicePurchaseId });
    const audit = jest.fn();
    const enqueueInTransaction = jest.fn();
    const dispatchNow = jest.fn();
    const service = new DocumentCheckService(
      tenant as never,
      {
        checkableStandard: jest.fn().mockResolvedValue({ standardVersionId: 'published' }),
      } as never,
      { assertCheckable: jest.fn().mockResolvedValue(undefined) } as never,
      {} as never,
      { reserve } as never,
      {} as never,
      { enqueueInTransaction } as never,
      { dispatchNow } as never,
      { audit } as never,
      { now: () => new Date('2026-10-28') } as never,
      { setContext: jest.fn() } as never,
    );
    return { service, tx, winner, reserve, audit, enqueueInTransaction, dispatchNow };
  }

  const request = { requestId: 'retry', ipAddress: null, userAgent: null };

  it('returns the committed check without trying to bind a newly allocated purchase id', async () => {
    const fixture = setup();
    expect(await fixture.service.create('customer', input, request)).toEqual(fixture.winner);
    expect(fixture.tx.priceQuote.findFirst).not.toHaveBeenCalled();
    expect(fixture.reserve).not.toHaveBeenCalled();
    expect(fixture.tx.documentCheck.create).not.toHaveBeenCalled();
    expect(fixture.audit).not.toHaveBeenCalled();
    expect(fixture.enqueueInTransaction).not.toHaveBeenCalled();
    expect(fixture.dispatchNow).not.toHaveBeenCalled();
  });

  it.each(['documentVersionId', 'standardId', 'priceQuoteId'] as const)(
    'refuses a concurrent retry changing %s',
    async (field) => {
      const fixture = setup();
      await expect(
        fixture.service.create('customer', { ...input, [field]: 'different' }, request),
      ).rejects.toMatchObject({ code: PalCertErrorCode.IDEMPOTENCY_KEY_REUSED });
      expect(fixture.reserve).not.toHaveBeenCalled();
      expect(fixture.tx.documentCheck.create).not.toHaveBeenCalled();
      expect(fixture.audit).not.toHaveBeenCalled();
    },
  );

  it('propagates a failed lock without reserving funds or returning a guessed winner', async () => {
    const fixture = setup();
    const failure = new Error('database connection lost');
    fixture.tx.$queryRaw.mockRejectedValueOnce(failure);
    await expect(fixture.service.create('customer', input, request)).rejects.toBe(failure);
    expect(fixture.reserve).not.toHaveBeenCalled();
    expect(fixture.tx.documentCheck.create).not.toHaveBeenCalled();
  });
});
