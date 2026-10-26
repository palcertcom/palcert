import { API } from './support/auth-client';
import { createUser, signInGlobalRole } from './support/organization-client';
import { createTenant } from './support/organization-client';
import {
  createTestContext,
  destroyTestContext,
  resetState,
  type TestContext,
} from './support/test-app';

/**
 * Pricing (§162 items 32–36, §130).
 *
 * Two things are being protected. A price, once in force, is **history** — a
 * charge from last March must still be explained by the row it used (§28). And
 * pricing belongs to PalCert: an organization publishes a standard, it does
 * not decide what PalCert charges to be checked against it (§107).
 */
describe('Pricing (e2e)', () => {
  let context: TestContext;
  let customer: Awaited<ReturnType<typeof createUser>>;
  let finance: Awaited<ReturnType<typeof signInGlobalRole>>;

  beforeAll(async () => {
    context = await createTestContext();
  });

  afterAll(async () => {
    await destroyTestContext(context);
  });

  beforeEach(async () => {
    await resetState(context);
    customer = await createUser(context, 'student@example.com');
    finance = await signInGlobalRole(context, 'finance@example.com', 'PALCERT_FINANCE');
  });

  async function activePrice(amountMinorUnits: string): Promise<string> {
    const created = await finance.post(`${API}/admin/finance/prices`, {
      productCode: 'DOCUMENT_CHECK',
      currency: 'USD',
      amountMinorUnits,
    });
    if (created.status !== 201) {
      throw new Error(`price creation failed: ${JSON.stringify(created.body)}`);
    }
    const activated = await finance.post(
      `${API}/admin/finance/prices/${created.body.id}/activate`,
      {},
    );
    if (activated.status !== 200) {
      throw new Error(`activation failed: ${JSON.stringify(activated.body)}`);
    }
    return created.body.id as string;
  }

  it('lists PalCert’s services, with only DOCUMENT_CHECK active', async () => {
    // §25: SmartFix and ExpertFix are catalogued so pricing is ready; quoting
    // one would imply a workflow that does not exist.
    const response = await customer.client.get(`${API}/pricing/products`);

    expect(response.status).toBe(200);
    const byCode = Object.fromEntries(
      (response.body as { productCode: string; active: boolean }[]).map((p) => [
        p.productCode,
        p.active,
      ]),
    );
    expect(byCode['DOCUMENT_CHECK']).toBe(true);
    expect(byCode['SMARTFIX']).toBe(false);
    expect(byCode['EXPERTFIX']).toBe(false);
  });

  it('creates a draft price that charges nobody', async () => {
    const created = await finance.post(`${API}/admin/finance/prices`, {
      productCode: 'DOCUMENT_CHECK',
      currency: 'USD',
      amountMinorUnits: '300',
    });

    expect(created.status).toBe(201);
    expect(created.body.status).toBe('DRAFT');
    expect(created.body.amount).toEqual({ currency: 'USD', minorUnits: '300' });

    // A draft is not quotable.
    const quote = await customer.client.get(`${API}/pricing/quote?product=DOCUMENT_CHECK`);
    expect(quote.status).toBe(409);
    expect(quote.body.error.code).toBe('PRICE_NOT_AVAILABLE');
  });

  it('puts a price into force and retires the outgoing one in one step', async () => {
    // §29: never two active prices, and never none.
    const first = await activePrice('300');
    const second = await activePrice('400');

    const prices = await finance.get(`${API}/admin/finance/prices`);
    const byId = Object.fromEntries(
      (prices.body as { id: string; status: string }[]).map((p) => [p.id, p.status]),
    );
    expect(byId[first]).toBe('RETIRED');
    expect(byId[second]).toBe('ACTIVE');

    const active = await context.adminDb.priceVersion.count({
      where: { productCode: 'DOCUMENT_CHECK', currency: 'USD', status: 'ACTIVE' },
    });
    expect(active).toBe(1);
  });

  it('refuses to change an active price’s amount', async () => {
    // §28, §130: changing $3 to $4 is a new version, not an edit. Enforced by
    // a database trigger, so it holds even against direct SQL.
    const priceId = await activePrice('300');

    await expect(
      context.adminDb.priceVersion.update({
        where: { id: priceId },
        data: { amountMinor: 400n },
      }),
    ).rejects.toThrow(/immutable/);

    const unchanged = await context.adminDb.priceVersion.findUniqueOrThrow({
      where: { id: priceId },
    });
    expect(unchanged.amountMinor).toBe(300n);
  });

  it('refuses to change an active price’s currency or product', async () => {
    const priceId = await activePrice('300');

    await expect(
      context.adminDb.priceVersion.update({ where: { id: priceId }, data: { currency: 'EUR' } }),
    ).rejects.toThrow(/immutable/);
    await expect(
      context.adminDb.priceVersion.update({
        where: { id: priceId },
        data: { productCode: 'SMARTFIX' },
      }),
    ).rejects.toThrow(/immutable/);
  });

  it('lets a retired price stay retired', async () => {
    const priceId = await activePrice('300');
    await finance.post(`${API}/admin/finance/prices/${priceId}/retire`, {});

    await expect(
      context.adminDb.priceVersion.update({
        where: { id: priceId },
        data: { status: 'ACTIVE' },
      }),
    ).rejects.toThrow(/reactivated/);
  });

  it('quotes the exact active price, derived by the server', async () => {
    // §31: the client asks for a quote; it never states a price.
    await activePrice('300');

    const quote = await customer.client.get(`${API}/pricing/quote?product=DOCUMENT_CHECK`);

    expect(quote.status).toBe(200);
    expect(quote.body.amount).toEqual({ currency: 'USD', minorUnits: '300' });
    expect(quote.body.expired).toBe(false);
    expect(Date.parse(quote.body.expiresAt)).toBeGreaterThan(Date.parse(quote.body.createdAt));
  });

  it('honours a quote after the price changes', async () => {
    // §32: PalCert honours what it quoted. The new price applies to the next
    // person who asks, not retroactively to this one.
    await activePrice('300');
    const quote = await customer.client.get(`${API}/pricing/quote?product=DOCUMENT_CHECK`);
    expect(quote.body.amount.minorUnits).toBe('300');

    await activePrice('400');

    const stored = await context.adminDb.priceQuote.findUniqueOrThrow({
      where: { id: quote.body.id },
    });
    expect(stored.amountMinor).toBe(300n);

    // And a fresh quote gets the new price.
    const newer = await customer.client.get(`${API}/pricing/quote?product=DOCUMENT_CHECK`);
    expect(newer.body.amount.minorUnits).toBe('400');
  });

  it('refuses to quote a product that is not sellable yet', async () => {
    // ExpertFix is a catalogue entry with no workflow behind it. Quoting one
    // would sell somebody a service PalCert cannot perform. (SmartFix left
    // this list in Phase 12, when its workflow arrived.)
    const quote = await customer.client.get(`${API}/pricing/quote?product=EXPERTFIX`);
    expect(quote.status).toBe(409);
    expect(quote.body.error.code).toBe('SERVICE_PRODUCT_NOT_ACTIVE');
  });

  it('never lets an organization touch a price', async () => {
    // §107: a fixed business rule, and there is no endpoint through which an
    // organization could even try.
    await activePrice('300');
    const tenant = await createTenant(context, 'Islamic University of Gaza', 'owner@example.com');

    const attempted = await tenant.owner.client.post(`${API}/admin/finance/prices`, {
      productCode: 'DOCUMENT_CHECK',
      currency: 'USD',
      amountMinorUnits: '1',
    });
    expect(attempted.status).toBe(403);

    const activation = await tenant.owner.client.post(
      `${API}/admin/finance/prices/${(await context.adminDb.priceVersion.findFirstOrThrow()).id}/activate`,
      {},
    );
    expect(activation.status).toBe(403);
    expect(await context.adminDb.priceVersion.count({ where: { amountMinor: 1n } })).toBe(0);
  });

  it('keeps only one price active when two activations race', async () => {
    // §163: price activation race. The partial unique index decides.
    const first = await finance.post(`${API}/admin/finance/prices`, {
      productCode: 'DOCUMENT_CHECK',
      currency: 'USD',
      amountMinorUnits: '300',
    });
    const second = await finance.post(`${API}/admin/finance/prices`, {
      productCode: 'DOCUMENT_CHECK',
      currency: 'USD',
      amountMinorUnits: '400',
    });

    await Promise.allSettled([
      finance.post(`${API}/admin/finance/prices/${first.body.id}/activate`, {}),
      finance.post(`${API}/admin/finance/prices/${second.body.id}/activate`, {}),
    ]);

    const active = await context.adminDb.priceVersion.count({
      where: { productCode: 'DOCUMENT_CHECK', currency: 'USD', status: 'ACTIVE' },
    });
    expect(active).toBeLessThanOrEqual(1);
  });

  it('lets a customer see prices but never set one', async () => {
    await activePrice('300');

    expect((await customer.client.get(`${API}/pricing/products`)).status).toBe(200);
    expect((await customer.client.get(`${API}/admin/finance/prices`)).status).toBe(403);
    expect(
      (
        await customer.client.post(`${API}/admin/finance/prices`, {
          productCode: 'DOCUMENT_CHECK',
          currency: 'USD',
          amountMinorUnits: '1',
        })
      ).status,
    ).toBe(403);
  });
});
