import { createTransport, type Transporter } from 'nodemailer';
import {
  EmailFailureCode,
  NotificationEmailError,
  NotificationEmailProviderPort,
  assertNoHeaderInjection,
  type NotificationEmailMessage,
  type NotificationEmailResult,
} from '@palcert/contracts';
import type { ApiConfigService } from '../../config/api-config.service';

export const SMTP_EMAIL_PROVIDER = 'smtp';

/**
 * The reference transport: plain SMTP through nodemailer.
 *
 * Two things about this adapter are deliberate and load-bearing.
 *
 * **The library is given exactly six fields.** nodemailer accepts `raw`,
 * `attachments`, `alternatives`, `icalEvent`, `amp`, `watchHtml`, `path` and
 * `href`; every one of those is a way to put arbitrary bytes, a local file or
 * a fetched URL into outbound mail, and none is needed to tell somebody their
 * submission was approved. The object literal below is written out in full
 * rather than spread from the message, so adding a field is an edit somebody
 * has to make on purpose and a test can notice.
 *
 * **File and URL access are switched off.** `disableFileAccess` and
 * `disableUrlAccess` are nodemailer's own belt-and-braces for the same
 * concern: with them set, even a field that did smuggle a path or a URL
 * through cannot cause the library to read the filesystem or make a request.
 *
 * The version is pinned exactly, without `@types/nodemailer`: nodemailer 10
 * ships its own types, and the DefinitelyTyped package describes an older
 * library. Installing it would let this file compile against a shape the
 * runtime does not have.
 */
export class SmtpEmailProvider extends NotificationEmailProviderPort {
  readonly provider = SMTP_EMAIL_PROVIDER;
  readonly enabled = true;

  private readonly transporter: Transporter;
  private readonly from: string;

  constructor(config: ApiConfigService) {
    super();
    const settings = config.notificationEmail;

    if (settings.smtp.host === undefined || settings.from === undefined) {
      // Configuration validation refuses this combination at boot; the second
      // lock is here because a half-configured transport that starts and then
      // fails every send is harder to diagnose than one that refuses to exist.
      throw new Error('the SMTP email provider needs NOTIFICATION_SMTP_HOST and _EMAIL_FROM');
    }

    // The sender is the only header value PalCert composes from configuration,
    // so it is the only place a CR/LF could start a second header line. The
    // schema already refuses a newline in the display name; this re-checks the
    // composed value, because the composition is what actually reaches a header.
    assertNoHeaderInjection('NOTIFICATION_EMAIL_FROM', settings.from);
    assertNoHeaderInjection('NOTIFICATION_EMAIL_FROM_NAME', settings.fromName);
    this.from = `"${settings.fromName.replace(/["\\]/g, '')}" <${settings.from}>`;

    this.transporter = createTransport({
      host: settings.smtp.host,
      port: settings.smtp.port,
      secure: settings.smtp.secure,
      auth:
        settings.smtp.user !== undefined && settings.smtp.password !== undefined
          ? { user: settings.smtp.user, pass: settings.smtp.password }
          : undefined,
      // Bounded, so one unreachable relay cannot hold a worker's lease open
      // until it expires and the job is redelivered to a second worker.
      connectionTimeout: settings.smtp.timeoutMs,
      greetingTimeout: settings.smtp.timeoutMs,
      socketTimeout: settings.smtp.timeoutMs,
      disableFileAccess: true,
      disableUrlAccess: true,
    });
  }

  async send(message: NotificationEmailMessage): Promise<NotificationEmailResult> {
    try {
      const info = await this.transporter.sendMail({
        to: message.to,
        from: this.from,
        subject: message.subject,
        text: message.text,
        html: message.html,
        messageId: message.messageId,
        disableFileAccess: true,
        disableUrlAccess: true,
      });

      const providerMessageId =
        typeof (info as { messageId?: unknown }).messageId === 'string'
          ? (info as { messageId: string }).messageId
          : null;

      return { accepted: true, providerMessageId };
    } catch (error) {
      throw new NotificationEmailError(classifySmtpFailure(error), smtpFailureSummary(error));
    }
  }
}

/**
 * Turn a transport failure into one of four codes (§56).
 *
 * The distinction is the whole of the retry policy: a connection that timed
 * out says nothing about the address, while a mailbox that does not exist will
 * not start existing because PalCert asked again twelve hours later.
 */
export function classifySmtpFailure(error: unknown): EmailFailureCode {
  const code =
    typeof (error as { code?: unknown })?.code === 'string' ? (error as { code: string }).code : '';
  const responseCode =
    typeof (error as { responseCode?: unknown })?.responseCode === 'number'
      ? (error as { responseCode: number }).responseCode
      : 0;
  const command =
    typeof (error as { command?: unknown })?.command === 'string'
      ? (error as { command: string }).command
      : '';

  // Network-level: nothing was said about the message at all.
  if (
    code === 'ECONNECTION' ||
    code === 'ETIMEDOUT' ||
    code === 'ESOCKET' ||
    code === 'EDNS' ||
    code === 'ECONNRESET' ||
    code === 'ECONNREFUSED'
  ) {
    return EmailFailureCode.PROVIDER_UNAVAILABLE;
  }

  // The relay refused our credentials or our sender. Asking again with the
  // same configuration produces the same answer.
  if (code === 'EAUTH' || responseCode === 530 || responseCode === 535) {
    return EmailFailureCode.CONFIGURATION_REJECTED;
  }
  if (responseCode === 550 && /MAIL(\s|$)|FROM/i.test(command)) {
    return EmailFailureCode.CONFIGURATION_REJECTED;
  }

  // A permanent 5xx naming the recipient.
  if (code === 'EENVELOPE' || (responseCode >= 550 && responseCode <= 553)) {
    return EmailFailureCode.RECIPIENT_REJECTED;
  }

  // Any other permanent 5xx is about the message or the transaction.
  if (responseCode >= 500 && responseCode < 600) {
    return EmailFailureCode.PROVIDER_REJECTED;
  }

  // A 4xx is the relay asking us to come back later, which is what the ladder
  // is for. So is anything unrecognised: retrying a handful of times is the
  // safer default when the failure is not understood.
  return EmailFailureCode.PROVIDER_UNAVAILABLE;
}

/**
 * PalCert's own words for the failure.
 *
 * Never the relay's response text: a bounce banner routinely echoes the
 * envelope back, including the recipient address, and this string is logged
 * and stored. The code carries the meaning; the sentence carries no data.
 */
export function smtpFailureSummary(error: unknown): string {
  const code = classifySmtpFailure(error);
  switch (code) {
    case EmailFailureCode.PROVIDER_UNAVAILABLE:
      return 'the mail relay could not be reached or did not complete the transaction';
    case EmailFailureCode.CONFIGURATION_REJECTED:
      return 'the mail relay refused this deployment’s credentials or sender';
    case EmailFailureCode.RECIPIENT_REJECTED:
      return 'the mail relay permanently refused the recipient';
    case EmailFailureCode.PROVIDER_REJECTED:
    default:
      return 'the mail relay permanently refused the message';
  }
}
