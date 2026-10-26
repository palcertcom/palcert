import { request as httpsRequest, type RequestOptions } from 'node:https';
import { checkServerIdentity, type PeerCertificate } from 'node:tls';

import { WebhookErrorCode } from '@palcert/contracts';

import {
  resolveWebhookDestination,
  WebhookDestinationError,
  type PinnedDestination,
} from './webhook-destination';

/**
 * The only way Phase 17 opens a socket to a customer-controlled address.
 *
 * Narrow on purpose. There is no `fetch`, no options bag a caller can widen,
 * no method parameter, no agent parameter, no header parameter, no redirect
 * handling and no way to pass a CA. Everything an attacker would want to
 * influence is fixed here, because a generic HTTP client with a policy applied
 * by its callers is a policy that holds until somebody adds a caller.
 *
 * One request is one physical socket. `agent: false` makes Node build a
 * throwaway agent for this request alone, so nothing is pooled and no TLS
 * session is resumed across attempts. That matters beyond tidiness: a pooled
 * socket is a socket whose destination was validated for a previous request,
 * and reusing one would mean a later attempt reaching an address this
 * attempt's DNS check never saw.
 */

export interface SafeWebhookRequest {
  /** The normalized hostname from the stored configuration. Never an IP. */
  readonly host: string;
  readonly port: number;
  /** Path and nothing else — the URL policy already refused query and fragment. */
  readonly path: string;
  /**
   * The exact bytes to send.
   *
   * A Buffer, not a string, and deliberately so. The canonical body is produced
   * once, hashed as bytes, signed as those bytes and sent as those bytes; a
   * string here would mean this client re-encoded it, and a signature computed
   * over one encoding of a body that was sent in another is a signature the
   * receiver cannot verify and nobody can reproduce.
   */
  readonly body: Buffer;
  /** `t=<unix>,v1=<hex>`, computed over those exact bytes. */
  readonly signature: string;
  readonly eventTypeHeader: string;
  readonly deliveryIdHeader: string;
  /** Absent for control messages, which project no event (§22). */
  readonly eventIdHeader?: string;
}

export interface SafeWebhookLimits {
  readonly dnsTimeoutMs: number;
  readonly connectTimeoutMs: number;
  readonly tlsTimeoutMs: number;
  readonly totalTimeoutMs: number;
  readonly maxRequestBytes: number;
  /**
   * Bounds the response *headers*. There is no response-body bound, because
   * there is no response body: PalCert reads none at all, which is stricter
   * than any cap and is why no cap is configured. A knob that suggested bytes
   * were being counted when none are read would be a lie in the config file.
   */
  readonly maxResponseHeaderBytes: number;
}

export interface SafeWebhookResponse {
  readonly statusCode: number;
  /**
   * Only the headers PalCert acts on, lowercased.
   *
   * Never the whole set: a receiver's headers are that receiver's text, and
   * PalCert does not keep third-party text in an organization's rows.
   */
  readonly retryAfter: string | undefined;
  readonly challengeEcho: string | undefined;
  readonly durationMs: number;
  readonly pinnedAddress: string;
}

export class SafeWebhookHttpError extends Error {
  constructor(
    readonly code: WebhookErrorCode,
    message: string,
    readonly statusCode?: number,
  ) {
    super(message);
    this.name = 'SafeWebhookHttpError';
  }
}

const CHALLENGE_HEADER = 'palcert-webhook-challenge';
const RETRY_AFTER_HEADER = 'retry-after';

export class SafeWebhookHttpClient {
  constructor(private readonly limits: SafeWebhookLimits) {}

  /**
   * Send one request, to one address, once.
   *
   * The deadline covers everything from here to the response's headers,
   * including DNS: a receiver that stalls the handshake costs exactly as much
   * worker time as one that stalls the body, and a per-stage timeout without
   * an overall one just means several stalls in a row.
   */
  async send(request: SafeWebhookRequest): Promise<SafeWebhookResponse> {
    const startedAt = Date.now();
    // Used as given. Nothing here re-encodes, re-serializes or copies it.
    const bodyBytes = request.body;
    if (bodyBytes.byteLength > this.limits.maxRequestBytes) {
      throw new SafeWebhookHttpError(
        WebhookErrorCode.URL_POLICY_VIOLATION,
        'the webhook body exceeds the configured request limit',
      );
    }

    const destination = await this.resolve(request.host);
    const remaining = this.limits.totalTimeoutMs - (Date.now() - startedAt);
    if (remaining <= 0) {
      throw new SafeWebhookHttpError(
        WebhookErrorCode.REQUEST_TIMEOUT,
        'the webhook deadline elapsed during resolution',
      );
    }

    const response = await this.dispatch(request, destination, bodyBytes, remaining);
    return { ...response, durationMs: Date.now() - startedAt, pinnedAddress: destination.address };
  }

  /**
   * Protected rather than private only so a test can pin a destination the
   * policy would refuse — there is no public surface for it, no constructor
   * option and no parameter, so production code has no way to supply one.
   */
  protected async resolve(host: string): Promise<PinnedDestination> {
    try {
      return await resolveWebhookDestination(host, { timeoutMs: this.limits.dnsTimeoutMs });
    } catch (error) {
      if (error instanceof WebhookDestinationError) {
        throw new SafeWebhookHttpError(error.code, error.message);
      }
      throw error;
    }
  }

  private dispatch(
    request: SafeWebhookRequest,
    destination: PinnedDestination,
    body: Buffer,
    deadlineMs: number,
  ): Promise<Omit<SafeWebhookResponse, 'durationMs' | 'pinnedAddress'>> {
    const headers: Record<string, string> = {
      // `Host` carries the name; the socket carries the address. Both are
      // fixed here, so the certificate is checked against the name the
      // organization configured and not against whatever DNS answered with.
      host: request.port === 443 ? request.host : `${request.host}:${request.port}`,
      'content-type': 'application/json',
      'content-length': String(body.byteLength),
      'user-agent': 'PalCert-Webhooks/1',
      accept: 'application/json',
      'palcert-signature': request.signature,
      'palcert-event-type': request.eventTypeHeader,
      'palcert-delivery-id': request.deliveryIdHeader,
    };
    if (request.eventIdHeader !== undefined) {
      headers['palcert-event-id'] = request.eventIdHeader;
    }

    const options: RequestOptions = {
      method: 'POST',
      // The pinned address, literally. Not the hostname: resolving again
      // inside the socket layer is the gap the pin exists to close.
      host: destination.address,
      port: request.port,
      path: request.path,
      headers,
      // A throwaway agent per request: no pooling, no TLS session resumption,
      // and no proxy agent anybody could have installed globally.
      agent: false,
      // SNI and certificate validation both use the configured hostname.
      servername: request.host,
      rejectUnauthorized: true,
      checkServerIdentity: (_host: string, cert: PeerCertificate) =>
        // Node would otherwise check the certificate against the IP we
        // connected to, which no public certificate names.
        checkServerIdentity(request.host, cert),
      maxHeaderSize: this.limits.maxResponseHeaderBytes,
      // Node reads no proxy environment here; stated so a future reader does
      // not "fix" its absence by adding one.
      setHost: false,
    };

    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = (fn: () => void): void => {
        if (settled) return;
        settled = true;
        clearTimeout(deadline);
        clearStageTimers();
        fn();
      };

      const req = httpsRequest(options);

      const deadline = setTimeout(() => {
        finish(() => {
          req.destroy();
          reject(
            new SafeWebhookHttpError(
              WebhookErrorCode.REQUEST_TIMEOUT,
              'the webhook request exceeded its deadline',
            ),
          );
        });
      }, deadlineMs);
      deadline.unref?.();

      /*
       * Per-stage deadlines, because a receiver can stall at three different
       * places and they are not the same failure.
       *
       * A TCP connect that never completes is a host that is not listening or
       * is dropping packets. A TLS handshake that never completes is a host
       * that *is* listening and has decided to hold the connection open
       * without ever proving who it is — which is the cheapest way to tie up a
       * worker, and the one a single `timeout` option does not catch, because
       * Node's socket timeout measures inactivity rather than progress.
       *
       * The total deadline above still wins: these bound each phase, it bounds
       * the sum, and a request that passes every stage check can still be
       * killed by it.
       */
      let connectTimer: NodeJS.Timeout | undefined;
      let tlsTimer: NodeJS.Timeout | undefined;

      const clearStageTimers = (): void => {
        if (connectTimer !== undefined) clearTimeout(connectTimer);
        if (tlsTimer !== undefined) clearTimeout(tlsTimer);
      };

      const failStage = (code: WebhookErrorCode, message: string): void => {
        finish(() => {
          req.destroy();
          reject(new SafeWebhookHttpError(code, message));
        });
      };

      req.on('socket', (socket) => {
        connectTimer = setTimeout(() => {
          failStage(
            WebhookErrorCode.CONNECT_TIMEOUT,
            'the webhook endpoint did not accept a connection in time',
          );
        }, this.limits.connectTimeoutMs);
        connectTimer.unref?.();

        socket.once('connect', () => {
          if (connectTimer !== undefined) clearTimeout(connectTimer);
          tlsTimer = setTimeout(() => {
            failStage(
              WebhookErrorCode.TLS_INTERRUPTED,
              'the webhook endpoint did not complete a TLS handshake in time',
            );
          }, this.limits.tlsTimeoutMs);
          tlsTimer.unref?.();
        });

        socket.once('secureConnect', () => {
          if (tlsTimer !== undefined) clearTimeout(tlsTimer);
        });
      });

      req.on('error', (error: NodeJS.ErrnoException) => {
        finish(() => reject(classifyTransportError(error)));
      });

      req.on('response', (res) => {
        const statusCode = res.statusCode ?? 0;
        const retryAfter = headerValue(res.headers[RETRY_AFTER_HEADER]);
        const challengeEcho = headerValue(res.headers[CHALLENGE_HEADER]);

        // The body is not read, stored or logged. It is a third party's text
        // and PalCert has no use for it: the status code is the answer.
        // Destroying the response discards whatever is in flight without
        // buffering it, which is also what stops a receiver returning
        // gigabytes into PalCert's memory.
        res.destroy();

        finish(() => resolve({ statusCode, retryAfter, challengeEcho }));
      });

      req.end(body);
    });
  }
}

function headerValue(value: string | string[] | undefined): string | undefined {
  if (value === undefined) return undefined;
  const first = Array.isArray(value) ? value[0] : value;
  if (first === undefined) return undefined;
  // Bounded: a header PalCert acts on must not itself be an attack surface.
  return first.slice(0, 256);
}

/**
 * Turn a Node socket error into one of PalCert's own codes.
 *
 * The remote side's message never survives this function. Delivery rows are
 * read by support staff, and an error page or a TLS alert routinely echoes the
 * request back into its own text.
 */
function classifyTransportError(error: NodeJS.ErrnoException): SafeWebhookHttpError {
  const code = error.code ?? '';
  if (code === 'ECONNRESET' || code === 'EPIPE') {
    return new SafeWebhookHttpError(
      WebhookErrorCode.CONNECTION_RESET,
      'the webhook connection was reset',
    );
  }
  if (code === 'ETIMEDOUT' || code === 'ESOCKETTIMEDOUT') {
    return new SafeWebhookHttpError(
      WebhookErrorCode.CONNECT_TIMEOUT,
      'the webhook endpoint did not answer in time',
    );
  }
  if (code === 'ECONNREFUSED' || code === 'EHOSTUNREACH' || code === 'ENETUNREACH') {
    return new SafeWebhookHttpError(
      WebhookErrorCode.CONNECTION_RESET,
      'the webhook endpoint refused the connection',
    );
  }
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') {
    return new SafeWebhookHttpError(
      WebhookErrorCode.DNS_TEMPORARY_FAILURE,
      'the webhook host could not be resolved',
    );
  }
  if (
    code.startsWith('ERR_TLS') ||
    code.startsWith('CERT_') ||
    code === 'UNABLE_TO_VERIFY_LEAF_SIGNATURE' ||
    code === 'DEPTH_ZERO_SELF_SIGNED_CERT' ||
    code === 'SELF_SIGNED_CERT_IN_CHAIN' ||
    code === 'ERR_SSL_WRONG_VERSION_NUMBER' ||
    /certificate|altnames|self[- ]signed/i.test(error.message)
  ) {
    // Never retried. A certificate that does not validate will not start
    // validating in twelve hours, and retrying would only keep sending signed
    // PalCert requests at something that has not proved who it is.
    return new SafeWebhookHttpError(
      WebhookErrorCode.TLS_IDENTITY_INVALID,
      'the webhook endpoint did not present a valid certificate for its hostname',
    );
  }
  return new SafeWebhookHttpError(
    WebhookErrorCode.TLS_INTERRUPTED,
    'the webhook connection was interrupted',
  );
}
