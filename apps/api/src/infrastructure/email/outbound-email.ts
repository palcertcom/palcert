import {
  OutboundEmailFailure,
  isHeaderSafe,
  isValidEmailAddress,
  type EmailProviderKind,
} from '@palcert/contracts';

/**
 * The bottom layer both mail producers share (ADR-0146): one message, one
 * provider, one normalized result.
 *
 * Neither producer reaches a provider any other way, and nothing above this
 * layer ever sees the provider credential: an `OutboundEmailProvider` is
 * constructed holding it and exposes no way to read it back.
 */
export interface OutboundEmailMessage {
  readonly from: { readonly email: string; readonly name: string };
  readonly to: string;
  readonly replyTo?: string | null;
  readonly subject: string;
  readonly text: string;
  readonly html: string;
  /** Lets the provider recognise a retry of the same logical message. */
  readonly idempotencyKey?: string;
  /** Non-secret labels the provider echoes back in webhooks. */
  readonly tags?: readonly { readonly name: string; readonly value: string }[];
}

export interface OutboundEmailResult {
  readonly provider: string;
  readonly providerMessageId: string | null;
  readonly accepted: true;
}

/**
 * A send that did not succeed, as a category.
 *
 * Carries no provider text. The HTTP status is kept for metrics and tests; it
 * is a number and says nothing about the message or the recipient.
 */
export class OutboundEmailError extends Error {
  constructor(
    readonly failure: OutboundEmailFailure,
    readonly httpStatus: number | null = null,
  ) {
    super(`outbound email failed: ${failure}`);
    this.name = 'OutboundEmailError';
  }
}

export interface OutboundEmailProvider {
  readonly kind: EmailProviderKind;
  /** The lower-case label recorded on delivery rows, e.g. `resend`. */
  readonly name: string;
  send(message: OutboundEmailMessage): Promise<OutboundEmailResult>;
}

/**
 * Refuse a message that could inject a header or name a malformed party,
 * before anything reaches the wire. Subject lines are produced by PalCert's
 * own templates, so a control character in one is a bug, not user input.
 */
export function assertSendable(message: OutboundEmailMessage): void {
  if (!isHeaderSafeSubject(message.subject) || !isHeaderSafe(message.from.name)) {
    throw new OutboundEmailError(OutboundEmailFailure.CONFIGURATION_ERROR);
  }
  if (!isValidEmailAddress(message.from.email)) {
    throw new OutboundEmailError(OutboundEmailFailure.SENDER_REJECTED);
  }
  if (
    message.replyTo !== undefined &&
    message.replyTo !== null &&
    !isValidEmailAddress(message.replyTo)
  ) {
    throw new OutboundEmailError(OutboundEmailFailure.CONFIGURATION_ERROR);
  }
  if (!isValidEmailAddress(message.to)) {
    throw new OutboundEmailError(OutboundEmailFailure.RECIPIENT_REJECTED);
  }
}

/** Subjects may contain quotes; they may never contain a control character. */
function isHeaderSafeSubject(value: string): boolean {
  // eslint-disable-next-line no-control-regex -- matching control characters is the point
  return value.length > 0 && value.length <= 998 && !/[\u0000-\u001f\u007f]/.test(value);
}
