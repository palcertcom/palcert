import { WebhookErrorCode } from '@palcert/contracts';

import {
  pinAllowedAddress,
  resolveWebhookDestination,
  WebhookDestinationError,
} from './webhook-destination';

function answers(...items: Array<[string, number]>) {
  return items.map(([address, family]) => ({ address, family }));
}

describe('pinAllowedAddress', () => {
  it('pins the first address when every answer is public', () => {
    const pinned = pinAllowedAddress(answers(['93.184.216.34', 4], ['93.184.216.35', 4]));
    expect(pinned.address).toBe('93.184.216.34');
    expect(pinned.family).toBe(4);
    expect(pinned.allAddresses).toHaveLength(2);
  });

  it('refuses a name that resolves only to addresses policy forbids', () => {
    for (const address of [
      '127.0.0.1',
      '10.0.0.5',
      '192.168.1.1',
      '172.16.0.1',
      '169.254.169.254',
      '100.64.0.1',
      '0.0.0.0',
      '224.0.0.1',
      '::1',
      'fe80::1',
      'fc00::1',
      'ff02::1',
      '::ffff:127.0.0.1',
      '64:ff9b::7f00:1',
      '2002:7f00:1::',
    ]) {
      expect(() => pinAllowedAddress(answers([address, address.includes(':') ? 6 : 4]))).toThrow(
        WebhookDestinationError,
      );
    }
  });

  it('refuses a name answering with both a public and a private address', () => {
    // Filtering down to the public answer would leave PalCert talking to a
    // host that is also an internal address, and every attempt would be a coin
    // flip the attacker gets to retry as often as PalCert retries.
    try {
      pinAllowedAddress(answers(['93.184.216.34', 4], ['10.0.0.5', 4]));
      throw new Error('expected a refusal');
    } catch (error) {
      expect(error).toBeInstanceOf(WebhookDestinationError);
      expect((error as WebhookDestinationError).code).toBe(WebhookErrorCode.DESTINATION_NOT_PUBLIC);
      expect((error as Error).message).toMatch(/both public and non-public/);
    }
  });

  it('refuses a name that resolves to nothing', () => {
    expect(() => pinAllowedAddress([])).toThrow(/did not resolve/);
  });

  it('does not let an unparseable answer through', () => {
    expect(() => pinAllowedAddress(answers(['not-an-address', 4]))).toThrow(
      WebhookDestinationError,
    );
  });
});

describe('resolveWebhookDestination', () => {
  it('refuses localhost through the real resolver', async () => {
    // The policy and the resolver are wired together here, not just the policy:
    // a name that resolves locally must be refused by the production path.
    await expect(resolveWebhookDestination('localhost', { timeoutMs: 3_000 })).rejects.toThrow(
      WebhookDestinationError,
    );
  });

  it('reports an unresolvable host as temporary rather than disabling an endpoint', async () => {
    // NXDOMAIN and a broken resolver are indistinguishable from here. Treating
    // a resolver outage as permanent would disable every endpoint at once.
    await expect(
      resolveWebhookDestination('webhook-host-that-does-not-exist.invalid', { timeoutMs: 3_000 }),
    ).rejects.toMatchObject({ code: WebhookErrorCode.DNS_TEMPORARY_FAILURE });
  });
});
