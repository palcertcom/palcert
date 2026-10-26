import { EmailFailureCode, NotificationEmailError } from '@palcert/contracts';

const sendMail = jest.fn<Promise<unknown>, [Record<string, unknown>]>();
const createTransport = jest.fn<{ sendMail: typeof sendMail }, [Record<string, unknown>]>(() => ({
  sendMail,
}));

jest.mock('nodemailer', () => ({
  createTransport: (options: Record<string, unknown>) => createTransport(options),
}));

// Imported after the mock is registered, so the adapter picks it up.
import { SmtpEmailProvider, classifySmtpFailure, smtpFailureSummary } from './smtp-email-provider';
import type { ApiConfigService } from '../../config/api-config.service';

function configFor(overrides: Partial<{ from: string; fromName: string }> = {}): ApiConfigService {
  return {
    notificationEmail: {
      provider: 'smtp' as const,
      from: overrides.from ?? 'no-reply@palcert.test',
      fromName: overrides.fromName ?? 'PalCert',
      smtp: {
        host: 'smtp.palcert.test',
        port: 587,
        secure: false,
        user: 'relay-user',
        password: 'relay-password',
        timeoutMs: 15_000,
      },
    },
  } as unknown as ApiConfigService;
}

/** The first argument of the first call, asserted rather than assumed. */
function firstArgOf<T>(calls: Array<[T]>): T {
  const call = calls[0];
  if (call === undefined) throw new Error('expected the mock to have been called');
  return call[0];
}

const MESSAGE = {
  to: 'person@example.test',
  subject: 'Your submission was approved',
  text: 'Your submission was approved\n',
  html: '<p>Your submission was approved</p>',
  messageId: '<notification-1@palcert>',
};

describe('SmtpEmailProvider', () => {
  beforeEach(() => {
    sendMail.mockReset();
    createTransport.mockClear();
    sendMail.mockResolvedValue({ messageId: '<relay-1@smtp.palcert.test>' });
  });

  it('switches off the library’s file and URL access', () => {
    new SmtpEmailProvider(configFor());
    const options = firstArgOf(createTransport.mock.calls);
    expect(options.disableFileAccess).toBe(true);
    expect(options.disableUrlAccess).toBe(true);
    // Bounded, so an unreachable relay cannot hold a worker lease open until
    // it expires and the job is redelivered to a second worker.
    expect(options.connectionTimeout).toBe(15_000);
    expect(options.greetingTimeout).toBe(15_000);
    expect(options.socketTimeout).toBe(15_000);
  });

  it('hands the library exactly the fields the port defines, and no others', async () => {
    // The point of the assertion is the *absence*: nodemailer accepts `raw`,
    // `attachments`, `alternatives`, `icalEvent`, `amp`, `watchHtml`, `path`
    // and `href`, and every one is a way to put arbitrary bytes, a local file
    // or a fetched URL into outbound mail. None is needed to tell somebody
    // their submission was approved.
    await new SmtpEmailProvider(configFor()).send(MESSAGE);

    const sent = firstArgOf(sendMail.mock.calls);
    expect(Object.keys(sent).sort()).toEqual([
      'disableFileAccess',
      'disableUrlAccess',
      'from',
      'html',
      'messageId',
      'subject',
      'text',
      'to',
    ]);

    for (const forbidden of [
      'raw',
      'attachments',
      'alternatives',
      'icalEvent',
      'amp',
      'watchHtml',
      'path',
      'href',
      'cc',
      'bcc',
      'replyTo',
      'envelope',
    ]) {
      expect([forbidden, forbidden in sent]).toEqual([forbidden, false]);
    }
  });

  it('sends to the bare verified address and composes its own sender', async () => {
    await new SmtpEmailProvider(configFor()).send(MESSAGE);
    const sent = firstArgOf(sendMail.mock.calls);

    // Hardening §8: never `Display Name <address>` for the recipient. A display
    // name is attacker-influenced text in a field with its own quoting rules.
    expect(sent.to).toBe('person@example.test');
    expect(sent.to).not.toContain('<');

    // The sender is PalCert's own configured value, never the message's.
    expect(sent.from).toBe('"PalCert" <no-reply@palcert.test>');
  });

  it('refuses a sender that could start a second header line', () => {
    expect(() => new SmtpEmailProvider(configFor({ from: 'a@b.test\r\nBcc: c@d.test' }))).toThrow(
      /carriage return or line feed/,
    );
    expect(() => new SmtpEmailProvider(configFor({ fromName: 'PalCert\nBcc: c@d.test' }))).toThrow(
      /carriage return or line feed/,
    );
  });

  it('strips quoting characters out of the display name rather than trusting it', async () => {
    await new SmtpEmailProvider(configFor({ fromName: 'Pal"Cert\\' })).send(MESSAGE);
    const sent = firstArgOf(sendMail.mock.calls);
    expect(sent.from).toBe('"PalCert" <no-reply@palcert.test>');
  });

  it('reports the relay’s message id without reporting what the relay said', async () => {
    const result = await new SmtpEmailProvider(configFor()).send(MESSAGE);
    expect(result).toEqual({ accepted: true, providerMessageId: '<relay-1@smtp.palcert.test>' });
  });

  it('translates a failure into a code and PalCert’s own words', async () => {
    sendMail.mockRejectedValue(
      Object.assign(new Error('550 5.1.1 <person@example.test>: recipient rejected'), {
        responseCode: 550,
        command: 'RCPT TO',
      }),
    );

    const error = await new SmtpEmailProvider(configFor())
      .send(MESSAGE)
      .then(() => null)
      .catch((caught: unknown) => caught as NotificationEmailError);

    expect(error).toBeInstanceOf(NotificationEmailError);
    expect(error?.code).toBe(EmailFailureCode.RECIPIENT_REJECTED);
    // A bounce banner routinely echoes the envelope back, and this string is
    // logged and stored. The code carries the meaning; the sentence carries
    // no data.
    expect(error?.message).not.toContain('person@example.test');
  });
});

describe('classifySmtpFailure', () => {
  const cases: Array<[string, unknown, EmailFailureCode]> = [
    ['a refused connection', { code: 'ECONNREFUSED' }, EmailFailureCode.PROVIDER_UNAVAILABLE],
    ['a timeout', { code: 'ETIMEDOUT' }, EmailFailureCode.PROVIDER_UNAVAILABLE],
    ['a TLS or socket failure', { code: 'ESOCKET' }, EmailFailureCode.PROVIDER_UNAVAILABLE],
    ['a 4xx deferral', { responseCode: 451 }, EmailFailureCode.PROVIDER_UNAVAILABLE],
    ['nothing recognisable', new Error('?'), EmailFailureCode.PROVIDER_UNAVAILABLE],
    ['rejected credentials', { code: 'EAUTH' }, EmailFailureCode.CONFIGURATION_REJECTED],
    [
      'a rejected sender',
      { responseCode: 550, command: 'MAIL FROM' },
      EmailFailureCode.CONFIGURATION_REJECTED,
    ],
    [
      'an unknown mailbox',
      { responseCode: 550, command: 'RCPT TO' },
      EmailFailureCode.RECIPIENT_REJECTED,
    ],
    ['a bad envelope', { code: 'EENVELOPE' }, EmailFailureCode.RECIPIENT_REJECTED],
    [
      'a refused message',
      { responseCode: 554, command: 'DATA' },
      EmailFailureCode.PROVIDER_REJECTED,
    ],
  ];

  it.each(cases)('classifies %s', (_label, error, expected) => {
    expect(classifySmtpFailure(error)).toBe(expected);
  });

  it('never repeats the relay’s own prose', () => {
    const banner = 'Undeliverable: person@example.test is not a valid mailbox';
    const summary = smtpFailureSummary(Object.assign(new Error(banner), { responseCode: 550 }));
    expect(summary).not.toContain('person@example.test');
    expect(summary).not.toContain(banner);
    expect(summary.length).toBeGreaterThan(0);
  });
});
