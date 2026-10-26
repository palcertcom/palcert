import { createHash } from 'node:crypto';

/**
 * What PalCert will accept as a webhook destination URL (§25–§29).
 *
 * Everything here happens before any DNS lookup, and the order matters: a URL
 * is normalized first, then judged, because an attacker's leverage is in the
 * spelling. `https://0x7f.1/` is `127.0.0.1` once WHATWG normalization has run,
 * and `https://a.test./` is `a.test` once the root dot is stripped — a check
 * written against the raw text would miss both.
 */

export const WEBHOOK_DEFAULT_PORT = 443;

/** Every reason a URL can be refused. Closed, so a message never carries the URL. */
export const WebhookUrlRejection = {
  NOT_A_URL: 'NOT_A_URL',
  SCHEME_NOT_HTTPS: 'SCHEME_NOT_HTTPS',
  CREDENTIALS_PRESENT: 'CREDENTIALS_PRESENT',
  FRAGMENT_PRESENT: 'FRAGMENT_PRESENT',
  QUERY_PRESENT: 'QUERY_PRESENT',
  IP_LITERAL_HOST: 'IP_LITERAL_HOST',
  LOOPBACK_HOST: 'LOOPBACK_HOST',
  SINGLE_LABEL_HOST: 'SINGLE_LABEL_HOST',
  MALFORMED_HOST: 'MALFORMED_HOST',
  PORT_NOT_ALLOWED: 'PORT_NOT_ALLOWED',
  PALCERT_OWN_HOST: 'PALCERT_OWN_HOST',
  TOO_LONG: 'TOO_LONG',
} as const;

export type WebhookUrlRejection = (typeof WebhookUrlRejection)[keyof typeof WebhookUrlRejection];

export interface NormalizedWebhookUrl {
  /** The URL as PalCert will send it: normalized, no default port, no trailing dot. */
  readonly url: string;
  readonly host: string;
  readonly port: number;
  readonly path: string;
  /** Digest of the normalized URL, so equality and integrity need no plaintext. */
  readonly urlSha256: string;
}

export type WebhookUrlResult =
  | { readonly ok: true; readonly value: NormalizedWebhookUrl }
  | { readonly ok: false; readonly rejection: WebhookUrlRejection };

const MAX_URL_LENGTH = 2000;

export interface WebhookUrlPolicy {
  /** Ports the deployment permits. Organizations never widen this. */
  readonly allowedPorts: readonly number[];
  /** PalCert's own hosts, refused so a webhook cannot loop back into PalCert. */
  readonly ownHosts: readonly string[];
}

/**
 * Strip one trailing dot and lower-case.
 *
 * `a.test.` and `a.test` are the same name, and WHATWG URL keeps the dot. A
 * self-host check written without this would compare `palcert.test.` against
 * `palcert.test` and let the loop through.
 */
export function normalizeHost(host: string): string {
  const lowered = host.trim().toLowerCase();
  const unbracketed = lowered.replace(/^\[|\]$/g, '');
  return unbracketed.endsWith('.') ? unbracketed.slice(0, -1) : unbracketed;
}

export function validateWebhookUrl(input: string, policy: WebhookUrlPolicy): WebhookUrlResult {
  if (input.length > MAX_URL_LENGTH) {
    return { ok: false, rejection: WebhookUrlRejection.TOO_LONG };
  }

  let parsed: URL;
  try {
    // WHATWG parsing also performs IDNA/punycode normalization, so an
    // internationalized host arrives here in its ASCII form.
    parsed = new URL(input);
  } catch {
    return { ok: false, rejection: WebhookUrlRejection.NOT_A_URL };
  }

  if (parsed.protocol !== 'https:') {
    return { ok: false, rejection: WebhookUrlRejection.SCHEME_NOT_HTTPS };
  }
  if (parsed.username.length > 0 || parsed.password.length > 0) {
    return { ok: false, rejection: WebhookUrlRejection.CREDENTIALS_PRESENT };
  }
  if (parsed.hash.length > 0) {
    return { ok: false, rejection: WebhookUrlRejection.FRAGMENT_PRESENT };
  }
  // §26: the signature authenticates PalCert, so a token in the query string
  // would be a credential in the one place logs and proxies see it.
  if (parsed.search.length > 0) {
    return { ok: false, rejection: WebhookUrlRejection.QUERY_PRESENT };
  }

  const host = normalizeHost(parsed.hostname);
  if (host.length === 0) return { ok: false, rejection: WebhookUrlRejection.MALFORMED_HOST };

  // After normalization, because `0x7f.1` only looks like a hostname before it.
  if (isIpLiteral(parsed.hostname)) {
    return { ok: false, rejection: WebhookUrlRejection.IP_LITERAL_HOST };
  }
  if (host === 'localhost' || host.endsWith('.localhost')) {
    return { ok: false, rejection: WebhookUrlRejection.LOOPBACK_HOST };
  }
  if (!host.includes('.')) {
    // A single label resolves through search domains to whatever the host's
    // resolver decides, which is not a destination an organization chose.
    return { ok: false, rejection: WebhookUrlRejection.SINGLE_LABEL_HOST };
  }
  if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/.test(host)) {
    return { ok: false, rejection: WebhookUrlRejection.MALFORMED_HOST };
  }
  if (policy.ownHosts.some((own) => normalizeHost(own) === host)) {
    return { ok: false, rejection: WebhookUrlRejection.PALCERT_OWN_HOST };
  }

  const port = parsed.port.length > 0 ? Number(parsed.port) : WEBHOOK_DEFAULT_PORT;
  if (!policy.allowedPorts.includes(port)) {
    return { ok: false, rejection: WebhookUrlRejection.PORT_NOT_ALLOWED };
  }

  const path = parsed.pathname.length > 0 ? parsed.pathname : '/';
  const url = `https://${host}${port === WEBHOOK_DEFAULT_PORT ? '' : `:${port}`}${path}`;

  return {
    ok: true,
    value: { url, host, port, path, urlSha256: createHash('sha256').update(url).digest('hex') },
  };
}

/**
 * Does this host, as WHATWG normalized it, name an address rather than a name?
 *
 * Checked on the normalized form on purpose: `0x7f.1`, `2130706433` and
 * `127.1` have all become `127.0.0.1` by the time they reach here.
 */
function isIpLiteral(hostname: string): boolean {
  const bare = hostname.replace(/^\[|\]$/g, '');
  if (bare !== hostname) return true; // bracketed: an IPv6 literal
  return /^\d{1,3}(\.\d{1,3}){3}$/.test(bare);
}
