import { Injectable } from '@nestjs/common';
import {
  NotificationEmailProviderPort,
  type NotificationEmailMessage,
  type NotificationEmailResult,
} from '@palcert/contracts';

export const DISABLED_EMAIL_PROVIDER = 'disabled';

/**
 * A deployment that does not send workflow mail (§115).
 *
 * This is a legitimate production configuration, not a stub: PalCert is usable
 * with in-app notifications alone, and a deployment without an SMTP relay
 * should say so rather than accumulate retries against a transport that was
 * never going to exist.
 *
 * `enabled` is false, so the send worker records `CHANNEL_DISABLED` skips and
 * never calls `send`. The throw is the second lock: if a future change routed
 * a message here anyway, the delivery fails loudly instead of being recorded
 * as delivered — which would be worse than not sending, because the record
 * would lie.
 */
@Injectable()
export class DisabledEmailProvider extends NotificationEmailProviderPort {
  readonly provider = DISABLED_EMAIL_PROVIDER;
  readonly enabled = false;

  async send(_message: NotificationEmailMessage): Promise<NotificationEmailResult> {
    throw new Error('workflow email is disabled in this deployment');
  }
}
