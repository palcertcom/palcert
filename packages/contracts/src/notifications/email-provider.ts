import type { EmailFailureCode } from './notification.js';

/**
 * The one boundary between Phase 16 and anything that sends mail (§52).
 *
 * Deliberately *not* Phase 1's `MailDeliveryPort`, and Phase 1's port is left
 * untouched. That separation is a security boundary rather than tidiness:
 * verification, password-reset and invitation mail carry single-use
 * credentials, and workflow notification mail must never be able to carry one.
 * Two ports means the notification path has no type through which a token
 * could travel, so "a reset token ended up in a notification template" is not
 * a bug that can be written here — there is nowhere to put it.
 *
 * The message surface is narrow on purpose (hardening §7). A transport library
 * will happily accept `raw`, `attachments`, `alternatives`, `icalEvent`,
 * `amp`, `watchHtml`, `path` and `href`; every one of those is a way to put
 * bytes or a file path into outbound mail, and none is needed to tell somebody
 * their submission was approved. What is not in this type cannot be set by an
 * adapter that implements it honestly, and an adapter test asserts the same
 * thing about the object actually handed to the library.
 */
export interface NotificationEmailMessage {
  /**
   * The recipient's exact verified address.
   *
   * A bare address, never `Display Name <address>` (hardening §8). A display
   * name is attacker-influenced text in a header field that has its own
   * quoting rules, and joining the two is how a header injection starts. It
   * also removes the only reason an adapter would need to know a person's name.
   */
  readonly to: string;
  /**
   * Deliberately no `from`.
   *
   * The sender belongs to the deployment, not to the message: it is composed
   * by the adapter from validated configuration and is the one header value
   * PalCert builds from a string an operator supplied. Leaving it off this
   * type means no caller can influence it, so there is no path by which a
   * notification could claim to come from somebody else.
   */
  readonly subject: string;
  readonly text: string;
  readonly html: string;
  /**
   * PalCert's own message id for this attempt, so a provider log line and a
   * delivery attempt row can be lined up without reading the message.
   */
  readonly messageId: string;
}

/** What one send attempt produced. Never the provider's own prose (§46). */
export interface NotificationEmailResult {
  readonly accepted: boolean;
  /** The provider's id for the message, when it gave one. */
  readonly providerMessageId: string | null;
}

/**
 * A send that did not succeed, classified for the retry ladder.
 *
 * The message is PalCert's own words. A provider banner can echo the envelope
 * back — including the recipient address — and this error is logged, so it
 * carries a code and a fixed sentence rather than whatever the far end said.
 */
export class NotificationEmailError extends Error {
  constructor(
    readonly code: EmailFailureCode,
    message: string,
  ) {
    super(message);
    this.name = 'NotificationEmailError';
  }
}

/**
 * An abstract class rather than an interface so Nest can inject it by token and
 * so an adapter cannot be half-implemented (ADR-0054).
 */
export abstract class NotificationEmailProviderPort {
  /** The adapter's stable name, recorded on the delivery row. */
  abstract readonly provider: string;

  /**
   * Whether this deployment sends workflow mail at all.
   *
   * False is a legitimate configuration, not a failure: a deployment with no
   * SMTP credentials records `CHANNEL_DISABLED` skips rather than piling up
   * retries against a transport that was never going to exist (§115).
   */
  abstract readonly enabled: boolean;

  abstract send(message: NotificationEmailMessage): Promise<NotificationEmailResult>;
}

/**
 * Refuse a header value that could continue onto another header line.
 *
 * Applied to the configured sender at boot rather than at send time, because a
 * deployment whose `EMAIL_FROM` contains a newline is misconfigured and should
 * be told so immediately, not on the first notification of the day.
 */
export function assertNoHeaderInjection(field: string, value: string): void {
  if (/[\r\n]/.test(value)) {
    throw new Error(`${field} must not contain a carriage return or line feed`);
  }
}
