import { EmailProviderKind, EmailSkipReason, OutboundEmailFailure } from '@palcert/contracts';
import type { PinoLogger } from 'nestjs-pino';
import type { ApiConfigService } from '../../../config/api-config.service';
import type { EmailDeliveryRecorder } from '../../../infrastructure/email/email-delivery-recorder';
import type {
  EmailSettingsService,
  EmailTransportDecision,
} from '../../../infrastructure/email/email-settings.service';
import { OutboundEmailError } from '../../../infrastructure/email/outbound-email';
import { MailTemplate, type LoggingMailDelivery, type MailMessage } from '../ports/mail.port';
import { ManagedMailDelivery } from './managed-mail-delivery';

const TOKEN = 'tok_SECRET_value_123';
const message: MailMessage = {
  to: 'person@example.org',
  locale: 'en',
  template: MailTemplate.PASSWORD_RESET,
  variables: {
    token: TOKEN,
    url: `https://web.test/en/reset-password?token=${TOKEN}`,
    displayName: 'Lina',
  },
};

function harness(decision: EmailTransportDecision | Error) {
  const logs: unknown[] = [];
  const logger = {
    setContext: jest.fn(),
    info: (...a: unknown[]) => logs.push(a),
    warn: (...a: unknown[]) => logs.push(a),
    error: (...a: unknown[]) => logs.push(a),
  } as unknown as PinoLogger;
  const settings = {
    transportFor:
      decision instanceof Error
        ? jest.fn().mockRejectedValue(decision)
        : jest.fn().mockResolvedValue(decision),
  } as unknown as EmailSettingsService;
  const rows: Record<string, unknown>[] = [];
  const recorder = {
    queued: jest.fn(async (input: Record<string, unknown>) => {
      rows.push(input);
      return { id: 'd1' };
    }),
    skipped: jest.fn(async (input: Record<string, unknown>) => {
      rows.push(input);
      return { id: 'd1' };
    }),
    attemptStarted: jest.fn(),
    accepted: jest.fn(),
    failed: jest.fn(),
  } as unknown as EmailDeliveryRecorder;
  const fallback = {
    send: jest.fn().mockResolvedValue(undefined),
  } as unknown as LoggingMailDelivery;
  const config = { publicWebUrl: 'https://web.test' } as ApiConfigService;
  const adapter = new ManagedMailDelivery(settings, recorder, fallback, config, logger);
  return { adapter, recorder, fallback, logs, rows };
}

function ready(send: jest.Mock): EmailTransportDecision {
  return {
    kind: 'READY',
    provider: { kind: EmailProviderKind.RESEND, name: 'resend', send },
    sender: { email: 'no-reply@palcert.com', name: 'PalCert' },
    replyTo: null,
  };
}

describe('ManagedMailDelivery', () => {
  it('hands mail to the logging adapter when no admin provider is in force', async () => {
    const h = harness({ kind: 'LEGACY' });
    await h.adapter.send(message);
    await h.adapter.drain();
    expect(h.fallback.send).toHaveBeenCalledWith(message);
    expect(h.recorder.queued).not.toHaveBeenCalled();
  });

  it('falls back to the logging adapter when settings cannot be read', async () => {
    const h = harness(new Error('db down'));
    await h.adapter.send(message);
    await h.adapter.drain();
    expect(h.fallback.send).toHaveBeenCalled();
  });

  it('sends through the provider and records metadata only', async () => {
    const send = jest
      .fn()
      .mockResolvedValue({ provider: 'resend', providerMessageId: 'em_1', accepted: true });
    const h = harness(ready(send));
    await h.adapter.send(message);
    await h.adapter.drain();
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0][0].text).toContain(TOKEN);
    expect(h.recorder.accepted).toHaveBeenCalledWith('d1', 'em_1', expect.any(Date));
    expect(JSON.stringify(h.rows)).not.toContain(TOKEN);
    expect(JSON.stringify(h.logs)).not.toContain(TOKEN);
  });

  it('returns before the provider answers and never throws on failure', async () => {
    let release!: () => void;
    const send = jest.fn(
      () =>
        new Promise((_, reject) => {
          release = () =>
            reject(new OutboundEmailError(OutboundEmailFailure.AUTHENTICATION_REJECTED));
        }),
    );
    const h = harness(ready(send));
    await expect(h.adapter.send(message)).resolves.toBeUndefined();
    await new Promise((r) => setTimeout(r, 20));
    release();
    await h.adapter.drain();
    expect(h.recorder.failed).toHaveBeenCalledWith(
      'd1',
      OutboundEmailFailure.AUTHENTICATION_REJECTED,
      true,
      expect.any(Date),
    );
    expect(JSON.stringify(h.logs)).not.toContain(TOKEN);
  });

  it('retries transient failures a bounded number of times', async () => {
    jest.useFakeTimers({ doNotFake: ['setImmediate'] });
    try {
      const send = jest
        .fn()
        .mockRejectedValue(new OutboundEmailError(OutboundEmailFailure.PROVIDER_UNAVAILABLE));
      const h = harness(ready(send));
      await h.adapter.send(message);
      const done = h.adapter.drain();
      for (let i = 0; i < 10; i += 1) {
        await Promise.resolve();
        await new Promise((r) => setImmediate(r));
        jest.advanceTimersByTime(5_000);
      }
      await done;
      expect(send).toHaveBeenCalledTimes(3);
      expect(h.recorder.failed).toHaveBeenLastCalledWith(
        'd1',
        OutboundEmailFailure.PROVIDER_UNAVAILABLE,
        true,
        expect.any(Date),
      );
    } finally {
      jest.useRealTimers();
    }
  });

  it('records a skip when the template is switched off', async () => {
    const h = harness({
      kind: 'SKIP',
      reason: EmailSkipReason.CATEGORY_DISABLED,
      providerName: 'resend',
    });
    await h.adapter.send(message);
    await h.adapter.drain();
    expect(h.recorder.skipped).toHaveBeenCalledWith(
      expect.objectContaining({ template: 'PASSWORD_RESET' }),
      'CATEGORY_DISABLED',
    );
    expect(h.fallback.send).not.toHaveBeenCalled();
  });

  it('records a configuration error instead of sending a foreign link', async () => {
    const send = jest.fn();
    const h = harness(ready(send));
    await h.adapter.send({
      ...message,
      variables: { ...message.variables, url: 'https://evil.example/x' },
    });
    await h.adapter.drain();
    expect(send).not.toHaveBeenCalled();
    expect(h.recorder.failed).toHaveBeenCalledWith(
      'd1',
      OutboundEmailFailure.CONFIGURATION_ERROR,
      true,
      expect.any(Date),
    );
  });
});
