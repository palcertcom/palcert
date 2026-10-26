import { Injectable } from '@nestjs/common';
import { PinoLogger } from 'nestjs-pino';

/**
 * Minimal outbound mail boundary.
 *
 * Phase 1 needs verification and reset mail, but the notification engine
 * (templates, preferences, retries, delivery logging) belongs to Phase 16.
 * `AuthService` therefore depends on this port, never on a vendor SDK, so
 * Phase 16 can supply a real transport without touching authentication code.
 */
export interface MailMessage {
  readonly to: string;
  readonly locale: string;
  readonly template: MailTemplate;
  /**
   * Template variables. Contains the raw credential token for verification and
   * reset mail — this object must never be logged.
   */
  readonly variables: Readonly<Record<string, string>>;
}

export const MailTemplate = {
  EMAIL_VERIFICATION: 'EMAIL_VERIFICATION',
  PASSWORD_RESET: 'PASSWORD_RESET',
  PASSWORD_CHANGED: 'PASSWORD_CHANGED',
  ORGANIZATION_INVITATION: 'ORGANIZATION_INVITATION',
} as const;

export type MailTemplate = (typeof MailTemplate)[keyof typeof MailTemplate];

@Injectable()
export abstract class MailDeliveryPort {
  abstract send(message: MailMessage): Promise<void>;
}

/**
 * Development transport: records that mail was produced without sending it and
 * without ever writing the token to the log.
 */
@Injectable()
export class LoggingMailDelivery extends MailDeliveryPort {
  constructor(private readonly logger: PinoLogger) {
    super();
    this.logger.setContext(LoggingMailDelivery.name);
  }

  async send(message: MailMessage): Promise<void> {
    this.logger.info(
      { template: message.template, locale: message.locale },
      'Outbound mail produced (no transport configured)',
    );
    return Promise.resolve();
  }
}

/**
 * Deterministic test transport. Tests assert on the produced message — including
 * the raw token — without any external dependency.
 */
@Injectable()
export class InMemoryMailOutbox extends MailDeliveryPort {
  private readonly messages: MailMessage[] = [];

  async send(message: MailMessage): Promise<void> {
    this.messages.push(message);
    return Promise.resolve();
  }

  all(): readonly MailMessage[] {
    return [...this.messages];
  }

  /** Most recent message sent to an address, optionally filtered by template. */
  lastTo(email: string, template?: MailTemplate): MailMessage | undefined {
    return [...this.messages]
      .reverse()
      .find(
        (message) =>
          message.to.toLowerCase() === email.toLowerCase() &&
          (template === undefined || message.template === template),
      );
  }

  clear(): void {
    this.messages.length = 0;
  }
}
