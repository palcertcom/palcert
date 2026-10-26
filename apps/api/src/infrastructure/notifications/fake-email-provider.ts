import { randomUUID } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import {
  EmailFailureCode,
  NotificationEmailError,
  NotificationEmailProviderPort,
  type NotificationEmailMessage,
  type NotificationEmailResult,
} from '@palcert/contracts';

export const FAKE_EMAIL_PROVIDER = 'fake';

/**
 * A deterministic mail transport, for tests only.
 *
 * It exists so the suites can exercise the whole delivery path — success,
 * transient outage, permanent rejection, the retry ladder, the dead letter —
 * without an SMTP server, a mailbox or a network. Configuration validation
 * refuses it in production: a transport that accepts every message and sends
 * none would record deliveries that never happened.
 */
@Injectable()
export class FakeEmailProvider extends NotificationEmailProviderPort {
  readonly provider = FAKE_EMAIL_PROVIDER;

  /** Tests flip this to exercise the CHANNEL_DISABLED path. */
  enabled = true;

  /** How the next send behaves. Tests set this. */
  mode: 'accept' | 'unavailable' | 'rejected' | 'recipient-rejected' | 'misconfigured' = 'accept';

  private readonly sent: NotificationEmailMessage[] = [];

  async send(message: NotificationEmailMessage): Promise<NotificationEmailResult> {
    switch (this.mode) {
      case 'unavailable':
        throw new NotificationEmailError(
          EmailFailureCode.PROVIDER_UNAVAILABLE,
          'the fake provider is simulating an unreachable relay',
        );
      case 'rejected':
        throw new NotificationEmailError(
          EmailFailureCode.PROVIDER_REJECTED,
          'the fake provider is simulating a permanent rejection',
        );
      case 'recipient-rejected':
        throw new NotificationEmailError(
          EmailFailureCode.RECIPIENT_REJECTED,
          'the fake provider is simulating an unknown mailbox',
        );
      case 'misconfigured':
        throw new NotificationEmailError(
          EmailFailureCode.CONFIGURATION_REJECTED,
          'the fake provider is simulating a rejected sender',
        );
      case 'accept':
      default:
        this.sent.push(message);
        return { accepted: true, providerMessageId: `fake-${randomUUID()}` };
    }
  }

  all(): readonly NotificationEmailMessage[] {
    return [...this.sent];
  }

  lastTo(email: string): NotificationEmailMessage | undefined {
    return [...this.sent].reverse().find((m) => m.to.toLowerCase() === email.toLowerCase());
  }

  reset(): void {
    this.sent.length = 0;
    this.mode = 'accept';
    this.enabled = true;
  }
}
