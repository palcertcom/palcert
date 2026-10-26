import { inspect } from 'node:util';
import { OutboundEmailFailure } from '@palcert/contracts';
import { OutboundEmailError, type OutboundEmailMessage } from './outbound-email';
import { ResendEmailProvider, classifyResendFailure } from './resend-email-provider';

const KEY = 're_TESTONLY_notarealkey_7XQ';

const message: OutboundEmailMessage = {
  from: { email: 'no-reply@palcert.com', name: 'PalCert' },
  to: 'person@example.org',
  replyTo: 'support@palcert.com',
  subject: 'PalCert email configuration test',
  text: 'hello',
  html: '<p>hello</p>',
  idempotencyKey: 'palcert-email-1',
  tags: [{ name: 'category', value: 'test' }],
};

function respond(status: number, body: unknown): jest.Mock {
  return jest.fn().mockResolvedValue(new Response(JSON.stringify(body), { status }));
}

function provider(fetchImpl: jest.Mock): ResendEmailProvider {
  return new ResendEmailProvider(KEY, {
    baseUrl: 'https://api.resend.test/',
    timeoutMs: 1_000,
    fetch: fetchImpl as unknown as typeof fetch,
  });
}

describe('ResendEmailProvider', () => {
  it('posts the documented request and returns the provider id', async () => {
    const fetchImpl = respond(200, { id: 'em_123' });
    const result = await provider(fetchImpl).send(message);

    expect(result).toEqual({ provider: 'resend', providerMessageId: 'em_123', accepted: true });
    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.resend.test/emails');
    expect(init.method).toBe('POST');
    expect(init.redirect).toBe('error');
    const headers = init.headers as Record<string, string>;
    expect(headers.Authorization).toBe(`Bearer ${KEY}`);
    expect(headers['Idempotency-Key']).toBe('palcert-email-1');
    expect(JSON.parse(init.body as string)).toEqual({
      from: 'PalCert <no-reply@palcert.com>',
      to: ['person@example.org'],
      subject: 'PalCert email configuration test',
      text: 'hello',
      html: '<p>hello</p>',
      reply_to: 'support@palcert.com',
      tags: [{ name: 'category', value: 'test' }],
    });
  });

  it.each([
    [401, { name: 'missing_api_key' }, OutboundEmailFailure.AUTHENTICATION_REJECTED],
    [403, { name: 'restricted_api_key' }, OutboundEmailFailure.AUTHENTICATION_REJECTED],
    [
      403,
      { name: 'validation_error', message: 'The palcert.com domain is not verified' },
      OutboundEmailFailure.SENDER_REJECTED,
    ],
    [422, { name: 'invalid_from_address' }, OutboundEmailFailure.SENDER_REJECTED],
    [
      422,
      { name: 'validation_error', message: 'Invalid `to` field' },
      OutboundEmailFailure.RECIPIENT_REJECTED,
    ],
    [422, { name: 'missing_required_field' }, OutboundEmailFailure.PROVIDER_REJECTED],
    [429, { name: 'rate_limit_exceeded' }, OutboundEmailFailure.RATE_LIMITED],
    [429, { name: 'daily_quota_exceeded' }, OutboundEmailFailure.RATE_LIMITED],
    [409, { name: 'concurrent_idempotent_requests' }, OutboundEmailFailure.PROVIDER_UNAVAILABLE],
    [409, { name: 'invalid_idempotent_request' }, OutboundEmailFailure.PROVIDER_REJECTED],
    [500, { name: 'application_error' }, OutboundEmailFailure.PROVIDER_UNAVAILABLE],
    [503, {}, OutboundEmailFailure.PROVIDER_UNAVAILABLE],
    [404, {}, OutboundEmailFailure.CONFIGURATION_ERROR],
    [418, {}, OutboundEmailFailure.UNKNOWN],
  ])('classifies HTTP %i %j as %s without keeping provider text', async (status, body, failure) => {
    const error = await provider(respond(status, body))
      .send(message)
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(OutboundEmailError);
    expect((error as OutboundEmailError).failure).toBe(failure);
    expect((error as Error).message).not.toMatch(/palcert\.com|verified|to` field/);
  });

  it('reports a network failure or timeout as PROVIDER_UNAVAILABLE', async () => {
    const fetchImpl = jest.fn().mockRejectedValue(new Error(`connect failed with Bearer ${KEY}`));
    const error = await provider(fetchImpl)
      .send(message)
      .catch((e: unknown) => e);
    expect((error as OutboundEmailError).failure).toBe(OutboundEmailFailure.PROVIDER_UNAVAILABLE);
    expect(JSON.stringify(error)).not.toContain(KEY);
    expect((error as Error).message).not.toContain(KEY);
  });

  it('refuses header injection before anything reaches the wire', async () => {
    const fetchImpl = respond(200, { id: 'x' });
    await expect(
      provider(fetchImpl).send({ ...message, subject: 'Hi\r\nBcc: evil@example.com' }),
    ).rejects.toBeInstanceOf(OutboundEmailError);
    await expect(
      provider(fetchImpl).send({ ...message, to: 'a@example.org\r\nBcc: evil@example.com' }),
    ).rejects.toMatchObject({ failure: OutboundEmailFailure.RECIPIENT_REJECTED });
    await expect(
      provider(fetchImpl).send({
        ...message,
        from: { email: 'no-reply@palcert.com', name: 'Pal"Cert' },
      }),
    ).rejects.toBeInstanceOf(OutboundEmailError);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('never exposes the API key through serialization or inspection', () => {
    const instance = provider(respond(200, {}));
    expect(JSON.stringify(instance)).not.toContain(KEY);
    expect(inspect(instance, { depth: 5 })).not.toContain(KEY);
    expect(Object.values(instance)).not.toContain(KEY);
  });

  it('classifier is total', () => {
    expect(classifyResendFailure(400)).toBe(OutboundEmailFailure.PROVIDER_REJECTED);
    expect(classifyResendFailure(302)).toBe(OutboundEmailFailure.UNKNOWN);
  });
});
