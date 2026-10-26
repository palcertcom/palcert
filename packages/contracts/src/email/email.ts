/**
 * Transactional email: the shared vocabulary.
 *
 * Two producers send mail through PalCert and they stay separate (ADR-0118,
 * ADR-0146):
 *
 *   - **Authentication mail** — verification, password reset, invitation,
 *     password-changed notice. Some of it carries a single-use credential in a
 *     link. That credential exists only in memory while the message is
 *     composed and handed to the provider; it is never stored, logged or
 *     recorded in delivery history.
 *   - **Workflow notification mail** — submission, certificate and attestation
 *     events. It never carries a credential, and its pipeline has no type a
 *     credential could travel through.
 *
 * What the two share is the bottom layer only: which provider, which sender,
 * and the provider credential (encrypted at rest, decrypted only to send).
 *
 * Pure and dependency-free so the web app can use the same validators.
 */

/** Which provider an administrator has chosen. `DISABLED` is a real choice. */
export const EmailProviderKind = {
  DISABLED: 'DISABLED',
  RESEND: 'RESEND',
} as const;
export type EmailProviderKind = (typeof EmailProviderKind)[keyof typeof EmailProviderKind];
export const EMAIL_PROVIDER_KINDS: readonly EmailProviderKind[] = Object.values(EmailProviderKind);

/** Who produced a message. Recorded on every delivery row. */
export const EmailDeliveryCategory = {
  AUTH: 'AUTH',
  WORKFLOW: 'WORKFLOW',
  TEST: 'TEST',
} as const;
export type EmailDeliveryCategory =
  (typeof EmailDeliveryCategory)[keyof typeof EmailDeliveryCategory];
export const EMAIL_DELIVERY_CATEGORIES: readonly EmailDeliveryCategory[] =
  Object.values(EmailDeliveryCategory);

/**
 * The templates PalCert's own transactional mail uses.
 *
 * Workflow deliveries are recorded under their notification type instead, so
 * the delivery console names what the recipient was told about.
 */
export const AuthEmailTemplate = {
  EMAIL_VERIFICATION: 'EMAIL_VERIFICATION',
  PASSWORD_RESET: 'PASSWORD_RESET',
  PASSWORD_CHANGED: 'PASSWORD_CHANGED',
  ORGANIZATION_INVITATION: 'ORGANIZATION_INVITATION',
} as const;
export type AuthEmailTemplate = (typeof AuthEmailTemplate)[keyof typeof AuthEmailTemplate];
export const AUTH_EMAIL_TEMPLATES: readonly AuthEmailTemplate[] = Object.values(AuthEmailTemplate);

export const CONFIGURATION_TEST_TEMPLATE = 'CONFIGURATION_TEST';

/**
 * A provider-level message's lifecycle, as PalCert knows it.
 *
 * `ACCEPTED` means the provider took the message; `DELIVERED`, `DELAYED`,
 * `BOUNCED`, `COMPLAINED` and `FAILED` arrive later, from the provider's
 * signed webhook. Without a webhook a delivery stays `ACCEPTED`, which is the
 * honest answer: PalCert handed it over and has not been told more.
 */
export const EmailDeliveryStatus = {
  QUEUED: 'QUEUED',
  ACCEPTED: 'ACCEPTED',
  DELAYED: 'DELAYED',
  DELIVERED: 'DELIVERED',
  BOUNCED: 'BOUNCED',
  COMPLAINED: 'COMPLAINED',
  FAILED: 'FAILED',
  SKIPPED: 'SKIPPED',
} as const;
export type EmailDeliveryStatus = (typeof EmailDeliveryStatus)[keyof typeof EmailDeliveryStatus];
export const EMAIL_DELIVERY_STATUSES: readonly EmailDeliveryStatus[] =
  Object.values(EmailDeliveryStatus);

/**
 * How far along a status is, so out-of-order provider events cannot move a
 * delivery backwards. A `delivered` event that arrives after `bounced` is
 * ignored; a `complained` after `delivered` is recorded (it implies delivery).
 * `SKIPPED` is final and never touched by provider events.
 */
export const EMAIL_DELIVERY_STATUS_RANK: Readonly<Record<EmailDeliveryStatus, number>> = {
  QUEUED: 0,
  ACCEPTED: 1,
  DELAYED: 2,
  DELIVERED: 3,
  BOUNCED: 4,
  FAILED: 4,
  COMPLAINED: 5,
  SKIPPED: 9,
};

/** Whether a provider event may move a delivery from `current` to `next`. */
export function emailStatusAdvances(
  current: EmailDeliveryStatus,
  next: EmailDeliveryStatus,
): boolean {
  if (current === EmailDeliveryStatus.SKIPPED) return false;
  return EMAIL_DELIVERY_STATUS_RANK[next] > EMAIL_DELIVERY_STATUS_RANK[current];
}

/** Why a delivery did not happen when the provider was never asked. */
export const EmailSkipReason = {
  PROVIDER_DISABLED: 'PROVIDER_DISABLED',
  CATEGORY_DISABLED: 'CATEGORY_DISABLED',
  CREDENTIAL_UNAVAILABLE: 'CREDENTIAL_UNAVAILABLE',
} as const;
export type EmailSkipReason = (typeof EmailSkipReason)[keyof typeof EmailSkipReason];

/**
 * Provider-independent failure categories.
 *
 * The provider's own response text is never stored or shown: a bounce banner
 * or validation message can echo the recipient, the sender or worse. These
 * codes carry the meaning; a fixed PalCert sentence carries no data.
 */
export const OutboundEmailFailure = {
  PROVIDER_UNAVAILABLE: 'PROVIDER_UNAVAILABLE',
  AUTHENTICATION_REJECTED: 'AUTHENTICATION_REJECTED',
  SENDER_REJECTED: 'SENDER_REJECTED',
  RECIPIENT_REJECTED: 'RECIPIENT_REJECTED',
  RATE_LIMITED: 'RATE_LIMITED',
  PROVIDER_REJECTED: 'PROVIDER_REJECTED',
  CONFIGURATION_ERROR: 'CONFIGURATION_ERROR',
  UNKNOWN: 'UNKNOWN',
} as const;
export type OutboundEmailFailure = (typeof OutboundEmailFailure)[keyof typeof OutboundEmailFailure];
export const OUTBOUND_EMAIL_FAILURES: readonly OutboundEmailFailure[] =
  Object.values(OutboundEmailFailure);

/** Failures worth trying again: the far end was busy, not certain. */
const RETRYABLE: ReadonlySet<OutboundEmailFailure> = new Set([
  OutboundEmailFailure.PROVIDER_UNAVAILABLE,
  OutboundEmailFailure.RATE_LIMITED,
  OutboundEmailFailure.UNKNOWN,
]);

export function isRetryableEmailFailure(failure: OutboundEmailFailure): boolean {
  return RETRYABLE.has(failure);
}

/** PalCert's own sentence for each failure. Safe to store, log and show to staff. */
export function outboundFailureSummary(failure: OutboundEmailFailure): string {
  switch (failure) {
    case OutboundEmailFailure.PROVIDER_UNAVAILABLE:
      return 'The email provider could not be reached or did not respond in time.';
    case OutboundEmailFailure.AUTHENTICATION_REJECTED:
      return 'The email provider rejected the configured API key.';
    case OutboundEmailFailure.SENDER_REJECTED:
      return 'The email provider rejected the sender address or sending domain.';
    case OutboundEmailFailure.RECIPIENT_REJECTED:
      return 'The email provider rejected the recipient address.';
    case OutboundEmailFailure.RATE_LIMITED:
      return 'The email provider asked PalCert to slow down or a sending quota was reached.';
    case OutboundEmailFailure.PROVIDER_REJECTED:
      return 'The email provider refused the message.';
    case OutboundEmailFailure.CONFIGURATION_ERROR:
      return 'The email configuration is incomplete or cannot be used.';
    case OutboundEmailFailure.UNKNOWN:
    default:
      return 'The email provider returned an unexpected response.';
  }
}

// ---------------------------------------------------------------------------
// Defaults and validation
// ---------------------------------------------------------------------------

export const DEFAULT_SENDING_DOMAIN = 'palcert.com';
export const DEFAULT_FROM_EMAIL = 'no-reply@palcert.com';
export const DEFAULT_FROM_NAME = 'PalCert';

export const EMAIL_TEXT_LIMITS = {
  address: 254,
  fromName: 100,
  domain: 253,
  apiKey: 200,
  webhookSecret: 200,
} as const;

/**
 * A mailbox address PalCert will put in a header.
 *
 * Deliberately stricter than RFC 5322: no quoted local parts, no comments, no
 * whitespace, no control characters, a dotted domain. An address that needs
 * the exotic parts of the grammar is not one an administrator is configuring
 * as a sender, and refusing it removes every header-injection path at once.
 */
const ADDRESS =
  /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]{1,64}@(?=.{1,253}$)(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)+[A-Za-z]{2,63}$/;
const DOMAIN = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;

export function isValidEmailAddress(value: string): boolean {
  return value.length <= EMAIL_TEXT_LIMITS.address && ADDRESS.test(value) && !value.includes('..');
}

export function isValidSendingDomain(value: string): boolean {
  return DOMAIN.test(value);
}

/** True when a value could not start a second header line or smuggle markup. */
export function isHeaderSafe(value: string): boolean {
  // C0 controls (including CR, LF, TAB), DEL, and the characters that would
  // let a display name escape its quoting.
  // eslint-disable-next-line no-control-regex -- matching control characters is the point
  return !/[\u0000-\u001f\u007f"<>\\]/.test(value);
}

/** The domain part of an address, lower-cased. */
export function emailDomainOf(address: string): string {
  return (address.split('@')[1] ?? '').toLowerCase();
}

/**
 * Whether an address belongs to the sending domain (or one of its subdomains).
 * A mismatch is a warning, not an error: Resend refuses it, but the operator
 * may be part-way through moving domains.
 */
export function addressMatchesDomain(address: string, domain: string): boolean {
  const own = emailDomainOf(address);
  const expected = domain.toLowerCase();
  return own === expected || own.endsWith(`.${expected}`);
}

/**
 * Shape of a Resend API key. Not a proof it works — only the test send is —
 * but it catches a pasted webhook secret, a stray quote or a truncated paste.
 */
export function isPlausibleResendApiKey(value: string): boolean {
  return /^re_[A-Za-z0-9_-]{8,190}$/.test(value);
}

/** Shape of a Resend (Svix) webhook signing secret. */
export function isPlausibleWebhookSecret(value: string): boolean {
  return /^whsec_[A-Za-z0-9+/=]{16,190}$/.test(value);
}

/**
 * The non-secret display hint stored beside the encrypted key: the prefix and
 * the last three characters, nothing else. Three characters of a long random
 * key reveal nothing useful and let an operator tell two keys apart.
 */
export function apiKeyDisplayHint(apiKey: string): string {
  const prefix = apiKey.startsWith('re_') ? 're_' : '';
  return `${prefix}••••••••${apiKey.slice(-3)}`;
}

export function webhookSecretDisplayHint(secret: string): string {
  return `whsec_••••••••${secret.slice(-3)}`;
}

/** Warnings an administrator should see. Codes, so the UI words them. */
export const EmailSettingsWarning = {
  FROM_OUTSIDE_DOMAIN: 'FROM_OUTSIDE_DOMAIN',
  API_KEY_MISSING: 'API_KEY_MISSING',
  DOMAIN_MISSING: 'DOMAIN_MISSING',
  ENCRYPTION_UNAVAILABLE: 'ENCRYPTION_UNAVAILABLE',
  WEBHOOK_SECRET_MISSING: 'WEBHOOK_SECRET_MISSING',
} as const;
export type EmailSettingsWarning = (typeof EmailSettingsWarning)[keyof typeof EmailSettingsWarning];

/** Header-safe, length-limited free text (a display name). */
export function isValidFromName(value: string): boolean {
  return (
    value.trim().length > 0 && value.length <= EMAIL_TEXT_LIMITS.fromName && isHeaderSafe(value)
  );
}
