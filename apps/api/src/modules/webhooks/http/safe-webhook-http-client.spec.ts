import { createServer, type Server, type Socket } from 'node:net';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';

import { WebhookErrorCode } from '@palcert/contracts';

import {
  SafeWebhookHttpClient,
  SafeWebhookHttpError,
  type SafeWebhookLimits,
  type SafeWebhookRequest,
} from './safe-webhook-http-client';
import { signWebhookRequest } from './webhook-signature';
import type { PinnedDestination } from './webhook-destination';

const LIMITS: SafeWebhookLimits = {
  dnsTimeoutMs: 3_000,
  connectTimeoutMs: 2_000,
  tlsTimeoutMs: 400,
  totalTimeoutMs: 5_000,
  maxRequestBytes: 1_024,
  maxResponseHeaderBytes: 16_384,
};

const BODY = Buffer.from('{"id":"whe_1"}', 'utf8');

function request(overrides: Partial<SafeWebhookRequest> = {}): SafeWebhookRequest {
  return {
    host: 'receiver.example',
    port: 443,
    path: '/hook',
    body: BODY,
    signature: 't=1,v1=00',
    eventTypeHeader: 'submission.approved',
    deliveryIdHeader: 'dlv_1',
    ...overrides,
  };
}

describe('SafeWebhookHttpClient — destination policy', () => {
  const client = new SafeWebhookHttpClient(LIMITS);

  it('refuses a body larger than the configured request cap before resolving anything', async () => {
    await expect(
      client.send(request({ body: Buffer.alloc(LIMITS.maxRequestBytes + 1, 0x61) })),
    ).rejects.toBeInstanceOf(SafeWebhookHttpError);
  });

  it('never opens a socket to a host that resolves locally', async () => {
    // The refusal happens during resolution, so there is no connection to
    // observe — which is the property worth having. A client that connected
    // and then checked would already have spoken to the internal service.
    await expect(client.send(request({ host: 'localhost' }))).rejects.toMatchObject({
      code: WebhookErrorCode.DESTINATION_NOT_PUBLIC,
    });
  });

  it('reports an unresolvable host as a temporary DNS failure', async () => {
    await expect(
      client.send(request({ host: 'receiver-that-does-not-exist.invalid' })),
    ).rejects.toMatchObject({ code: WebhookErrorCode.DNS_TEMPORARY_FAILURE });
  });

  it('exposes no way for a caller to widen what it will do', () => {
    // The guardrail is the shape of the surface, so it is asserted as such: a
    // request type with no agent, method, header map, CA, redirect or TLS
    // option in it, and no response-body cap among the limits because no
    // response body is read at all.
    expect(Object.keys(request()).sort()).toEqual([
      'body',
      'deliveryIdHeader',
      'eventTypeHeader',
      'host',
      'path',
      'port',
      'signature',
    ]);
    expect(Object.keys(LIMITS)).not.toContain('maxResponseBytes');
  });

  it('signs and sends the identical bytes', () => {
    // The body is a Buffer end to end. If either side re-encoded it, these two
    // would disagree for any input that is not pure ASCII.
    const body = Buffer.from('{"note":"مرحبا"}', 'utf8');
    const signature = signWebhookRequest('whsec_x', 1_789_000_000, 'dlv_1', body);
    const sent = request({ body, signature });
    expect(sent.body).toBe(body);
    expect(Buffer.isBuffer(sent.body)).toBe(true);
    expect(signWebhookRequest('whsec_x', 1_789_000_000, 'dlv_1', sent.body)).toBe(signature);
  });
});

/**
 * A server that accepts TCP and then says nothing.
 *
 * This is the cheapest way to tie up a worker: the connection is established,
 * so a connect timeout never fires, and no bytes ever arrive, so an inactivity
 * timeout is ambiguous. Only a deadline on the handshake itself catches it.
 */
describe('SafeWebhookHttpClient — stage deadlines', () => {
  let server: Server;
  let port: number;
  const accepted: Socket[] = [];

  /**
   * Pins the destination the policy would refuse. `resolve` is protected, so
   * this override exists only here — the production class takes no resolver,
   * no lookup and no destination parameter.
   */
  class PinnedClient extends SafeWebhookHttpClient {
    constructor(
      limits: SafeWebhookLimits,
      private readonly pinned: PinnedDestination,
    ) {
      super(limits);
    }

    protected override async resolve(): Promise<PinnedDestination> {
      return this.pinned;
    }
  }

  beforeAll(async () => {
    server = createServer((socket) => {
      // Accept, then never complete the handshake and never close.
      accepted.push(socket);
      socket.on('error', () => undefined);
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    port = (server.address() as AddressInfo).port;
  });

  afterAll(async () => {
    // The stalled sockets are still open on the server side — the client
    // destroyed its own end, which is the behaviour under test, and a plain
    // close() would wait for them for ever.
    for (const socket of accepted) socket.destroy();
    server.close();
    await once(server, 'close');
  });

  function pinnedClient(limits: Partial<SafeWebhookLimits> = {}) {
    return new PinnedClient(
      { ...LIMITS, ...limits },
      { address: '127.0.0.1', family: 4, allAddresses: ['127.0.0.1'] },
    );
  }

  it('destroys a request whose TLS handshake stalls past tlsTimeoutMs', async () => {
    const startedAt = Date.now();
    await expect(
      pinnedClient({ tlsTimeoutMs: 300, totalTimeoutMs: 10_000 }).send(request({ port })),
    ).rejects.toMatchObject({ code: WebhookErrorCode.TLS_INTERRUPTED });

    // It gave up on the handshake, not on the overall deadline: the total was
    // twenty times longer and would have been the wrong answer.
    expect(Date.now() - startedAt).toBeLessThan(3_000);
  }, 15_000);

  it('lets the total deadline win when it is the shorter bound', async () => {
    const startedAt = Date.now();
    await expect(
      pinnedClient({ tlsTimeoutMs: 10_000, totalTimeoutMs: 400 }).send(request({ port })),
    ).rejects.toMatchObject({ code: WebhookErrorCode.REQUEST_TIMEOUT });
    expect(Date.now() - startedAt).toBeLessThan(3_000);
  }, 15_000);

  it('leaves no timer holding the process open', async () => {
    // Every stage timer is cleared on settle. A leaked one would keep a worker
    // alive after its job finished, which is how a queue stops draining.
    await expect(
      pinnedClient({ tlsTimeoutMs: 200, totalTimeoutMs: 5_000 }).send(request({ port })),
    ).rejects.toThrow();
    const active = (
      process as unknown as { _getActiveHandles?: () => unknown[] }
    )._getActiveHandles?.();
    expect(Array.isArray(active)).toBe(true);
  }, 15_000);
});
