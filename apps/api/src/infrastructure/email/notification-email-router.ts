import { Injectable } from '@nestjs/common';
import {
  EmailDeliveryCategory,
  EmailFailureCode,
  EmailSkipReason,
  NotificationEmailError,
  NotificationEmailProviderPort,
  OutboundEmailFailure,
  isRetryableEmailFailure,
  type NotificationEmailMessage,
  type NotificationEmailResult,
} from '@palcert/contracts';
import { PinoLogger } from 'nestjs-pino';
import { EmailDeliveryRecorder } from './email-delivery-recorder';
import { EmailSettingsService, type EmailTransportDecision } from './email-settings.service';
import { OutboundEmailError, type OutboundEmailProvider } from './outbound-email';

/** Who the message is for, in the notification pipeline's own terms. */
export interface NotificationEmailContext {
  readonly notificationDeliveryId: string;
  readonly notificationType: string;
}

/**
 * Which provider sends one workflow notification (ADR-0146).
 *
 * The Phase 16 pipeline is untouched: fan-out, preferences, mandatory types,
 * the attempt ledger, the retry ladder and the stable Message-ID all stay in
 * `NotificationEmailService`. What changes is only where it gets its
 * `NotificationEmailProviderPort` — per send, from here, instead of once at
 * boot — so an administrator's change applies to the next delivery.
 *
 *   admin-managed Resend, enabled  → Resend (or a CHANNEL_DISABLED skip when
 *                                    the workflow switch is off)
 *   otherwise                      → the environment-configured provider,
 *                                    exactly as before
 */
@Injectable()
export class NotificationEmailRouter {
  constructor(
    private readonly legacy: NotificationEmailProviderPort,
    private readonly settings: EmailSettingsService,
    private readonly recorder: EmailDeliveryRecorder,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext(NotificationEmailRouter.name);
  }

  /** The provider label for a delivery row before any attempt is made. */
  get defaultProviderName(): string {
    return this.legacy.provider;
  }

  async resolve(context: NotificationEmailContext): Promise<NotificationEmailProviderPort> {
    let decision: EmailTransportDecision;
    try {
      decision = await this.settings.transportFor({ category: 'WORKFLOW' });
    } catch {
      decision = { kind: 'LEGACY' };
    }

    if (decision.kind === 'LEGACY') return this.legacy;
    if (decision.kind === 'SKIP') {
      if (decision.reason === EmailSkipReason.CATEGORY_DISABLED) {
        return new SwitchedOffNotificationProvider(decision.providerName);
      }
      return new UnusableNotificationProvider(decision.providerName, context, this.recorder);
    }
    return new ManagedNotificationProvider(decision, context, this.recorder, this.logger);
  }
}

/** Workflow mail switched off by an administrator: the pipeline records CHANNEL_DISABLED. */
class SwitchedOffNotificationProvider extends NotificationEmailProviderPort {
  readonly enabled = false;
  constructor(readonly provider: string) {
    super();
  }
  send(): Promise<NotificationEmailResult> {
    return Promise.reject(
      new NotificationEmailError(
        EmailFailureCode.CONFIGURATION_REJECTED,
        'workflow email is switched off',
      ),
    );
  }
}

/** Enabled but the credential cannot be opened (root key missing or wrong). Fails closed. */
class UnusableNotificationProvider extends NotificationEmailProviderPort {
  readonly enabled = true;
  constructor(
    readonly provider: string,
    private readonly context: NotificationEmailContext,
    private readonly recorder: EmailDeliveryRecorder,
  ) {
    super();
  }
  async send(message: NotificationEmailMessage): Promise<NotificationEmailResult> {
    const row = await this.recorder.workflowAttempt({
      category: EmailDeliveryCategory.WORKFLOW,
      template: this.context.notificationType,
      provider: this.provider,
      recipient: message.to,
      notificationDeliveryId: this.context.notificationDeliveryId,
    });
    await this.recorder.failed(row.id, OutboundEmailFailure.CONFIGURATION_ERROR, true, new Date());
    throw new NotificationEmailError(
      EmailFailureCode.CONFIGURATION_REJECTED,
      'the email provider credential is unavailable',
    );
  }
}

class ManagedNotificationProvider extends NotificationEmailProviderPort {
  readonly enabled = true;
  readonly provider: string;
  private readonly transport: OutboundEmailProvider;

  constructor(
    private readonly decision: Extract<EmailTransportDecision, { kind: 'READY' }>,
    private readonly context: NotificationEmailContext,
    private readonly recorder: EmailDeliveryRecorder,
    private readonly logger: PinoLogger,
  ) {
    super();
    this.transport = decision.provider;
    this.provider = decision.provider.name;
  }

  async send(message: NotificationEmailMessage): Promise<NotificationEmailResult> {
    const row = await this.recorder.workflowAttempt({
      category: EmailDeliveryCategory.WORKFLOW,
      template: this.context.notificationType,
      provider: this.provider,
      recipient: message.to,
      notificationDeliveryId: this.context.notificationDeliveryId,
    });
    await this.recorder.attemptStarted(row.id);
    try {
      const result = await this.transport.send({
        from: this.decision.sender,
        replyTo: this.decision.replyTo,
        to: message.to,
        subject: message.subject,
        text: message.text,
        html: message.html,
        // One key per logical delivery, matching the stable Message-ID: a
        // retry after an accepted-but-unrecorded send is recognised by the
        // provider instead of reaching the recipient twice.
        idempotencyKey: `palcert-notification-${this.context.notificationDeliveryId}`,
        tags: [
          { name: 'category', value: 'workflow' },
          { name: 'template', value: this.context.notificationType.toLowerCase() },
        ],
      });
      await this.recorder.accepted(row.id, result.providerMessageId, new Date());
      return { accepted: true, providerMessageId: result.providerMessageId };
    } catch (error) {
      const failure =
        error instanceof OutboundEmailError ? error.failure : OutboundEmailFailure.UNKNOWN;
      const code = notificationCodeFor(failure);
      await this.recorder.failed(row.id, failure, !isRetryableEmailFailure(failure), new Date());
      this.logger.warn(
        { emailDeliveryId: row.id, failure },
        'workflow email was not accepted by the email provider',
      );
      throw new NotificationEmailError(code, `email provider failure: ${failure}`);
    }
  }
}

/** Map the shared categories onto the Phase 16 vocabulary the retry ladder understands. */
export function notificationCodeFor(failure: OutboundEmailFailure): EmailFailureCode {
  switch (failure) {
    case OutboundEmailFailure.RECIPIENT_REJECTED:
      return EmailFailureCode.RECIPIENT_REJECTED;
    case OutboundEmailFailure.PROVIDER_REJECTED:
      return EmailFailureCode.PROVIDER_REJECTED;
    case OutboundEmailFailure.AUTHENTICATION_REJECTED:
    case OutboundEmailFailure.SENDER_REJECTED:
    case OutboundEmailFailure.CONFIGURATION_ERROR:
      return EmailFailureCode.CONFIGURATION_REJECTED;
    case OutboundEmailFailure.PROVIDER_UNAVAILABLE:
    case OutboundEmailFailure.RATE_LIMITED:
    case OutboundEmailFailure.UNKNOWN:
    default:
      return EmailFailureCode.PROVIDER_UNAVAILABLE;
  }
}
