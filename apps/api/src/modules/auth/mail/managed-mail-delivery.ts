import { Injectable, type OnApplicationShutdown } from '@nestjs/common';
import {
  AuthEmailTemplate,
  EmailDeliveryCategory,
  OutboundEmailFailure,
  isRetryableEmailFailure,
} from '@palcert/contracts';
import { PinoLogger } from 'nestjs-pino';
import { ApiConfigService } from '../../../config/api-config.service';
import { EmailDeliveryRecorder } from '../../../infrastructure/email/email-delivery-recorder';
import {
  EmailSettingsService,
  type EmailTransportDecision,
} from '../../../infrastructure/email/email-settings.service';
import { OutboundEmailError } from '../../../infrastructure/email/outbound-email';
import { LoggingMailDelivery, MailDeliveryPort, type MailMessage } from '../ports/mail.port';
import { renderAuthMail } from './auth-mail-templates';

/** Backoff between attempts of one authentication message. */
const RETRY_DELAYS_MS = [1_000, 4_000] as const;

/**
 * The real transport behind `MailDeliveryPort` (ADR-0146).
 *
 * When an administrator has enabled the admin-managed provider, this sends
 * authentication mail through it; otherwise it hands the message to the
 * logging adapter, which is exactly what PalCert did before.
 *
 * Two properties the auth services rely on:
 *
 *  - **`send` never throws and never waits for the provider.** Registration,
 *    password reset and verification resend must respond the same way, in the
 *    same time, whether or not an account exists and whether or not the
 *    provider is up. The message is dispatched after `send` returns; a
 *    provider failure is recorded as delivery metadata and never reaches the
 *    caller.
 *  - **The credential stays in memory.** The token-bearing link is rendered
 *    into a message object that lives for one dispatch. Delivery rows record
 *    the template, recipient and outcome only; logs carry the template, the
 *    delivery id and a failure category.
 *
 * The trade-off is explicit: a process that stops mid-dispatch loses that one
 * message, and the person asks for another. In exchange, nothing about an
 * account's existence leaks through response timing.
 */
@Injectable()
export class ManagedMailDelivery extends MailDeliveryPort implements OnApplicationShutdown {
  private readonly inFlight = new Set<Promise<void>>();

  constructor(
    private readonly settings: EmailSettingsService,
    private readonly recorder: EmailDeliveryRecorder,
    private readonly fallback: LoggingMailDelivery,
    private readonly config: ApiConfigService,
    private readonly logger: PinoLogger,
  ) {
    super();
    this.logger.setContext(ManagedMailDelivery.name);
  }

  send(message: MailMessage): Promise<void> {
    const task = new Promise<void>((resolve) => {
      setImmediate(() => {
        this.dispatch(message)
          .catch(() => {
            this.logger.error(
              { template: message.template },
              'authentication mail dispatch failed',
            );
          })
          .finally(resolve);
      });
    });
    this.inFlight.add(task);
    void task.finally(() => this.inFlight.delete(task));
    return Promise.resolve();
  }

  /** Wait for every dispatched message to settle. For tests and shutdown. */
  async drain(): Promise<void> {
    while (this.inFlight.size > 0) {
      await Promise.allSettled([...this.inFlight]);
    }
  }

  async onApplicationShutdown(): Promise<void> {
    await this.drain();
  }

  private async dispatch(message: MailMessage): Promise<void> {
    let decision: EmailTransportDecision;
    try {
      decision = await this.settings.transportFor({
        category: 'AUTH',
        template: message.template as AuthEmailTemplate,
      });
    } catch {
      // Settings unreadable: behave as PalCert did before the feature.
      decision = { kind: 'LEGACY' };
    }

    if (decision.kind === 'LEGACY') {
      await this.fallback.send(message);
      return;
    }

    const base = {
      category: EmailDeliveryCategory.AUTH,
      template: message.template,
      recipient: message.to,
    };

    if (decision.kind === 'SKIP') {
      const row = await this.recorder.skipped(
        { ...base, provider: decision.providerName },
        decision.reason,
      );
      this.logger.info(
        { deliveryId: row.id, template: message.template, reason: decision.reason },
        'authentication mail not sent through the email provider',
      );
      return;
    }

    const row = await this.recorder.queued({ ...base, provider: decision.provider.name });

    let rendered;
    try {
      rendered = renderAuthMail(message, this.config.publicWebUrl);
    } catch {
      await this.recorder.failed(
        row.id,
        OutboundEmailFailure.CONFIGURATION_ERROR,
        true,
        new Date(),
      );
      this.logger.error(
        { deliveryId: row.id, template: message.template },
        'authentication mail could not be rendered',
      );
      return;
    }

    for (let attempt = 0; ; attempt += 1) {
      await this.recorder.attemptStarted(row.id);
      try {
        const result = await decision.provider.send({
          from: decision.sender,
          replyTo: decision.replyTo,
          to: message.to,
          subject: rendered.subject,
          text: rendered.text,
          html: rendered.html,
          idempotencyKey: `palcert-email-${row.id}`,
          tags: [
            { name: 'category', value: 'auth' },
            { name: 'template', value: message.template.toLowerCase() },
          ],
        });
        await this.recorder.accepted(row.id, result.providerMessageId, new Date());
        this.logger.info(
          { deliveryId: row.id, template: message.template },
          'authentication mail accepted by the email provider',
        );
        return;
      } catch (error) {
        const failure =
          error instanceof OutboundEmailError ? error.failure : OutboundEmailFailure.UNKNOWN;
        const delay = RETRY_DELAYS_MS[attempt];
        const final = !isRetryableEmailFailure(failure) || delay === undefined;
        await this.recorder.failed(row.id, failure, final, new Date());
        this.logger.warn(
          { deliveryId: row.id, template: message.template, failure, final },
          'authentication mail was not accepted by the email provider',
        );
        if (final) return;
        await sleep(delay);
      }
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
