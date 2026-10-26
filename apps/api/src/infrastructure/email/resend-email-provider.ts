import { inspect } from 'node:util';
import { EmailProviderKind, OutboundEmailFailure } from '@palcert/contracts';
import {
  OutboundEmailError,
  assertSendable,
  type OutboundEmailMessage,
  type OutboundEmailProvider,
  type OutboundEmailResult,
} from './outbound-email';

/**
 * Resend, over its HTTPS API (ADR-0146).
 *
 * Written against `POST /emails` directly rather than through the `resend`
 * SDK: the call is one authenticated JSON request, and owning it lets PalCert
 * fix the base URL, bound the time and the response size, refuse redirects
 * (a redirect would carry the bearer token somewhere else), and classify every
 * failure without ever surfacing the provider's text.
 *
 * The API key lives in a private field with no accessor. `toJSON` and
 * `util.inspect` describe the adapter without it, so an accidental log line or
 * serialized error cannot carry it.
 */
export interface ResendTransportOptions {
  /** Fixed in production; a local fake in tests. Never from the database. */
  readonly baseUrl: string;
  readonly timeoutMs: number;
  /** Injected in unit tests. */
  readonly fetch?: typeof fetch;
}

const MAX_RESPONSE_BYTES = 64 * 1024;

export class ResendEmailProvider implements OutboundEmailProvider {
  readonly kind = EmailProviderKind.RESEND;
  readonly name = 'resend';
  readonly #apiKey: string;
  readonly #options: ResendTransportOptions;

  constructor(apiKey: string, options: ResendTransportOptions) {
    this.#apiKey = apiKey;
    this.#options = options;
  }

  async send(message: OutboundEmailMessage): Promise<OutboundEmailResult> {
    assertSendable(message);

    const body: Record<string, unknown> = {
      from: `${message.from.name} <${message.from.email}>`,
      to: [message.to],
      subject: message.subject,
      text: message.text,
      html: message.html,
    };
    if (message.replyTo) body.reply_to = message.replyTo;
    if (message.tags !== undefined && message.tags.length > 0) {
      body.tags = message.tags.map((tag) => ({ name: tag.name, value: tag.value }));
    }

    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.#apiKey}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
      'User-Agent': 'PalCert',
    };
    if (message.idempotencyKey !== undefined) {
      headers['Idempotency-Key'] = message.idempotencyKey.slice(0, 256);
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.#options.timeoutMs);
    let response: Response;
    let text: string;
    try {
      response = await (this.#options.fetch ?? fetch)(
        `${trimSlash(this.#options.baseUrl)}/emails`,
        {
          method: 'POST',
          headers,
          body: JSON.stringify(body),
          redirect: 'error',
          signal: controller.signal,
        },
      );
      text = await readBounded(response);
    } catch {
      // Network error, TLS failure, timeout, refused redirect: the provider
      // could not be asked. The underlying error is not kept — its message
      // can include the URL and, for some fetch implementations, headers.
      throw new OutboundEmailError(OutboundEmailFailure.PROVIDER_UNAVAILABLE);
    } finally {
      clearTimeout(timer);
    }

    const parsed = parseJson(text);
    if (response.ok) {
      const id = typeof parsed?.id === 'string' && parsed.id.length <= 200 ? parsed.id : null;
      return { provider: this.name, providerMessageId: id, accepted: true };
    }

    throw new OutboundEmailError(
      classifyResendFailure(
        response.status,
        typeof parsed?.name === 'string' ? parsed.name : undefined,
        typeof parsed?.message === 'string' ? parsed.message : undefined,
      ),
      response.status,
    );
  }

  toJSON(): Record<string, string> {
    return { provider: this.name };
  }

  [inspect.custom](): string {
    return 'ResendEmailProvider { apiKey: [redacted] }';
  }
}

/**
 * Resend's error response, as a category.
 *
 * `name` and `message` are read here to choose a category and then dropped.
 * They are never logged, stored or returned: a validation message can quote
 * the address or the domain it rejected.
 */
export function classifyResendFailure(
  status: number,
  name?: string,
  message?: string,
): OutboundEmailFailure {
  const lowerName = (name ?? '').toLowerCase();
  const lowerMessage = (message ?? '').toLowerCase();

  if (status === 401) return OutboundEmailFailure.AUTHENTICATION_REJECTED;
  if (status === 403) {
    if (
      lowerName.includes('api_key') ||
      lowerName === 'invalid_permission' ||
      lowerName.includes('suspended')
    ) {
      return OutboundEmailFailure.AUTHENTICATION_REJECTED;
    }
    // Unverified domain, or a testing key sending outside the account owner.
    if (lowerMessage.includes('domain') || lowerName.includes('from')) {
      return OutboundEmailFailure.SENDER_REJECTED;
    }
    if (lowerMessage.includes('testing') || lowerMessage.includes('own email')) {
      return OutboundEmailFailure.RECIPIENT_REJECTED;
    }
    return OutboundEmailFailure.PROVIDER_REJECTED;
  }
  if (status === 429) return OutboundEmailFailure.RATE_LIMITED;
  if (status === 409) {
    return lowerName.includes('concurrent')
      ? OutboundEmailFailure.PROVIDER_UNAVAILABLE
      : OutboundEmailFailure.PROVIDER_REJECTED;
  }
  if (status === 400 || status === 422) {
    if (lowerName.includes('idempot')) return OutboundEmailFailure.CONFIGURATION_ERROR;
    if (/(^|_)from(_|$)/.test(lowerName) || /\bfrom\b|sender|domain/.test(lowerMessage)) {
      return OutboundEmailFailure.SENDER_REJECTED;
    }
    if (/(^|_)to(_|$)/.test(lowerName)) return OutboundEmailFailure.RECIPIENT_REJECTED;
    if (/\bto\b|recipient/.test(lowerMessage)) return OutboundEmailFailure.RECIPIENT_REJECTED;
    return OutboundEmailFailure.PROVIDER_REJECTED;
  }
  if (status === 404) return OutboundEmailFailure.CONFIGURATION_ERROR;
  if (status >= 500) return OutboundEmailFailure.PROVIDER_UNAVAILABLE;
  return OutboundEmailFailure.UNKNOWN;
}

function trimSlash(value: string): string {
  return value.endsWith('/') ? value.slice(0, -1) : value;
}

async function readBounded(response: Response): Promise<string> {
  const reader = response.body?.getReader();
  if (reader === undefined) return '';
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_RESPONSE_BYTES) {
      await reader.cancel();
      break;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf8');
}

function parseJson(text: string): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(text);
    return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}
