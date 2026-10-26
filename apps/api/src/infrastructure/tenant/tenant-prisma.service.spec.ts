import {
  BACKGROUND_BATCH_TRANSACTION,
  MAX_TRANSACTION_TIMEOUT_MS,
  MAX_TRANSACTION_WAIT_MS,
  TenantPrismaService,
} from './tenant-prisma.service';

/**
 * Transaction bounds. The tenant context itself is covered end to end by the
 * RLS suites; this pins what reaches Prisma's `$transaction` options.
 */
describe('TenantPrismaService transaction bounds', () => {
  function service() {
    const executed: string[] = [];
    const tx = {
      $executeRaw: (strings: TemplateStringsArray) => {
        executed.push(strings.join('?'));
        return Promise.resolve(1);
      },
    };
    const $transaction = jest.fn(
      async (work: (client: typeof tx) => Promise<unknown>, _options?: unknown) => work(tx),
    );
    const logger = { setContext: jest.fn(), warn: jest.fn() };
    const tenant = new TenantPrismaService({ $transaction } as never, logger as never);
    return { tenant, $transaction, executed };
  }
  const scope = { organizationId: 'org-1', userId: 'user-1' };

  it('leaves an ordinary request on Prisma’s default bounds', async () => {
    const { tenant, $transaction } = service();
    await tenant.withTenant(scope, async () => 'ok');
    expect($transaction.mock.calls[0]![1]).toBeUndefined();
  });

  it('passes an explicit bound for background batch work', async () => {
    const { tenant, $transaction } = service();
    await tenant.withTenant(scope, async () => 'ok', BACKGROUND_BATCH_TRANSACTION);
    expect($transaction.mock.calls[0]![1]).toEqual({ timeout: 30_000, maxWait: 5_000 });
  });

  it('clamps any bound to the ceiling, so no caller can hold a connection for minutes', async () => {
    const { tenant, $transaction } = service();
    await tenant.withTenant(scope, async () => 'ok', { timeoutMs: 600_000, maxWaitMs: 120_000 });
    expect($transaction.mock.calls[0]![1]).toEqual({
      timeout: MAX_TRANSACTION_TIMEOUT_MS,
      maxWait: MAX_TRANSACTION_WAIT_MS,
    });
  });

  it('sets the tenant context first, bounded or not', async () => {
    const { tenant, executed } = service();
    await tenant.withTenant(scope, async () => 'ok', BACKGROUND_BATCH_TRANSACTION);
    expect(executed).toHaveLength(3);
    expect(executed[0]).toContain("set_config('palcert.current_organization_id'");
    expect(executed[2]).toContain("set_config('palcert.platform_admin'");
  });
});
