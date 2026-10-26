import { randomBytes } from 'node:crypto';

import { WebhookKeyUnavailableError } from '../../../common/crypto/webhook-keyring';
import { WebhookKeyringService } from './webhook-keyring.service';

/**
 * Readiness, and why it belongs to startup.
 *
 * A worker that discovers a missing key while delivering reports it against
 * somebody's endpoint: the organization watches their integration fail and the
 * actual fault is a deployment that shipped without a key. So the process
 * refuses to finish starting instead — and refuses *before* the worker module
 * exists, because this is an awaited part of the keyring's own initialization
 * rather than a promise fired into the background and hoped about.
 */
describe('WebhookKeyringService readiness', () => {
  function key(): string {
    return randomBytes(32).toString('base64');
  }

  function build(options: { readonly ring: string | null; readonly referenced: string[] }) {
    const keys = options.ring;
    const config = {
      webhooksEnabled: keys !== null,
      webhookEncryptionKeys: keys,
      webhookEncryptionActiveKid: 'k2',
    };
    const prisma = {
      $queryRawUnsafe: jest.fn().mockResolvedValue(options.referenced.map((kid) => ({ kid }))),
    };
    const logger = { setContext: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() };
    return new WebhookKeyringService(config as never, prisma as never, logger as never);
  }

  it('starts when every key stored rows refer to is present', async () => {
    const service = build({
      ring: `k1:${key()},k2:${key()}`,
      referenced: ['k1', 'k2'],
    });
    await expect(service.onModuleInit()).resolves.toBeUndefined();
    expect(service.enabled).toBe(true);
  });

  it('refuses to start when a stored row names a key the ring has retired', async () => {
    const service = build({ ring: `k2:${key()}`, referenced: ['k1', 'k2'] });
    // Names the key id so an operator knows what to restore, and never the
    // material or what it was protecting.
    await expect(service.onModuleInit()).rejects.toThrow(WebhookKeyUnavailableError);
    await expect(service.onModuleInit()).rejects.toThrow(/k1/);
  });

  it('refuses to start when sealed rows exist and no keyring is configured', async () => {
    // The hole this closes: turning the feature off does not make sealed rows
    // readable, it makes them readable by nothing. Startup is the honest place
    // to say so, rather than the first delivery.
    const service = build({ ring: null, referenced: ['k1'] });
    await expect(service.onModuleInit()).rejects.toThrow(WebhookKeyUnavailableError);
  });

  it('starts with the feature off when nothing is sealed', async () => {
    const service = build({ ring: null, referenced: [] });
    await expect(service.onModuleInit()).resolves.toBeUndefined();
    expect(service.enabled).toBe(false);
  });
});
