import { randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { REQUEST_ID_HEADER } from '@palcert/contracts';
import type { Params } from 'nestjs-pino';
import type { LevelWithSilent } from 'pino';
import type { ApiConfigService } from '../../config/api-config.service';

/**
 * Header and body fields that must never reach the logs (§38, §49).
 * Redaction happens in the logger itself so no call site can forget it.
 */
/** Redact a field wherever it appears: at the top level and one level in. */
function aiRedactionPaths(fields: readonly string[]): string[] {
  return fields.flatMap((field) => [field, `*.${field}`]);
}

export const LOG_REDACT_PATHS = [
  'req.headers.authorization',
  'req.headers.cookie',
  'req.headers["set-cookie"]',
  'req.headers["x-api-key"]',
  'res.headers["set-cookie"]',
  'req.body.password',
  'req.body.newPassword',
  'req.body.currentPassword',
  'req.body.token',
  'req.body.secret',
  // Listed at both levels: pino's `*.x` wildcard matches one level down, not a
  // top-level key, so `logger.info({ password })` would otherwise sail
  // straight through — which it did until Phase 20 Checkpoint 3 tested for it.
  ...aiRedactionPaths([
    'password',
    'newPassword',
    'currentPassword',
    'accessToken',
    'refreshToken',
  ]),
  // ADR-0146: the admin-managed email provider's secrets. `apiKey` is covered
  // below; the webhook signing secret is named here.
  ...aiRedactionPaths(['webhookSecret']),
  // Phase 5: a presigned URL is a bearer credential for one object.
  ...aiRedactionPaths(['presignedUrl']),
  '*.upload.url',
  '*.download.url',
  'upload.url',
  'download.url',
  // Phase 8: nothing about an AI call may reach a log. The API key is a
  // server secret; the prompt and the response carry the user's unpublished
  // research; the context bundle is the document in normalized form (§8, §81).
  //
  // Each name is listed twice on purpose: pino's `*.x` wildcard matches one
  // level down, not a top-level key, so a bare `apiKey` would otherwise sail
  // straight through.
  ...aiRedactionPaths([
    'apiKey',
    'anthropicApiKey',
    'ANTHROPIC_API_KEY',
    'systemPrompt',
    'userPrompt',
    'prompt',
    'context',
    'contextBundle',
    'providerResponse',
    'rawResponse',
    'explanationEn',
    'explanationAr',
    'summaryEn',
    'summaryAr',
  ]),
  // Phase 15: a verification code is a capability, and its sealed staging
  // copy is one key away from being the same capability. Nothing logs either
  // on purpose; this is what stops an accidental object dump from doing it.
  ...aiRedactionPaths([
    'verificationCode',
    'verificationCodeCiphertext',
    'verification_code_ciphertext',
    'certificateNumber',
  ]),
  // Phase 19: an API-client secret is shown once and is a bearer credential
  // for an organization's whole read surface. Nothing logs one on purpose —
  // `refuse()` does not even take it as a parameter — and this is what stops
  // an accidental object dump from being the exception.
  ...aiRedactionPaths([
    'clientSecret',
    'client_secret',
    'secretVerifier',
    'secret_verifier',
    'revealedSecretCiphertext',
    'revealed_secret_ciphertext',
  ]),
  // Phase 20 Checkpoint 3: observability is the one change that deliberately
  // increases how much PalCert writes down, so the list of things it must
  // never write down is extended in the same breath.
  //
  // A webhook signing secret lets anyone forge a delivery an organization will
  // believe; a payment credential is the provider account itself; an
  // `Authorization` header is whatever credential the caller presented. None
  // is logged on purpose anywhere — these paths are what stops an object dump,
  // an error serializer or a future call site from being the exception.
  ...aiRedactionPaths([
    'signingSecret',
    'signing_secret',
    'webhookSecret',
    'secretFingerprint',
    'stripeSecretKey',
    'STRIPE_SECRET_KEY',
    'webhookSigningSecret',
    'paymentSecret',
    'cardNumber',
    'authorization',
    'Authorization',
    'documentContent',
    'documentText',
    'fileContent',
  ]),
];

/**
 * A verification code in a URL is a credential, so it never reaches a log
 * (§184, §186).
 *
 * The public verification route carries the code as a path segment, which
 * means the ordinary access log would record it on every request — and an
 * access log is exactly the kind of thing that gets shipped to a third-party
 * aggregator, kept for a year and read by people who are not the holder.
 * Anyone who read one could then verify a certificate they were never shown.
 *
 * Redacted here rather than at the call site, because the call site is pino's
 * own request serializer and there is nothing to remember to do.
 */
const PUBLIC_CERTIFICATE_PATH = /(\/public\/certificates\/)[^/?#]+/;

/**
 * An API-client secret anywhere in a URL (Phase 19).
 *
 * PalCert never reads a credential from a query string — the guard accepts
 * only the `Authorization` header — so a `pcsk_` in a URL means somebody's
 * client library put it there, and the request will fail. What must not happen
 * is that the failed request writes the live secret into an access log that is
 * shipped, aggregated and kept: the call did not work, and now the credential
 * needs rotating too. Matched by its prefix, which is exactly why secrets
 * carry one.
 */
const API_CLIENT_SECRET_IN_URL = /pcsk_[A-Za-z0-9_-]+/g;

export function redactLoggedUrl(url: string): string {
  return url
    .replace(PUBLIC_CERTIFICATE_PATH, '$1[REDACTED]')
    .replace(API_CLIENT_SECRET_IN_URL, '[REDACTED]');
}

/** Health/metrics endpoints are polled constantly; log them at a lower level. */
function resolveLogLevel(req: IncomingMessage, res: ServerResponse, err?: Error): LevelWithSilent {
  if (err !== undefined || res.statusCode >= 500) return 'error';
  if (res.statusCode >= 400) return 'warn';
  // Probes and scrapes run every few seconds; at `info` they would be most of
  // the log volume and none of the information.
  if (req.url?.startsWith('/health') || req.url?.startsWith('/metrics')) return 'debug';
  return 'info';
}

/**
 * Structured JSON logging with a request correlation ID on every line (§46, §48).
 *
 * The correlation ID is taken from the inbound `x-request-id` header when
 * present (so it survives across services) and is always echoed back on the
 * response.
 */
export function buildLoggerParams(config: ApiConfigService): Params {
  return {
    pinoHttp: {
      level: config.logLevel,
      genReqId: (req: IncomingMessage, res: ServerResponse): string => {
        const incoming = req.headers[REQUEST_ID_HEADER];
        const requestId =
          typeof incoming === 'string' && incoming.length > 0 && incoming.length <= 128
            ? incoming
            : randomUUID();
        res.setHeader(REQUEST_ID_HEADER, requestId);
        return requestId;
      },
      customLogLevel: resolveLogLevel,
      redact: { paths: LOG_REDACT_PATHS, censor: '[REDACTED]' },
      // Every line identifies the build that wrote it. Without the commit, a
      // log from a partially completed rollout cannot be attributed to the
      // version that produced it, which is exactly when it matters most.
      base: {
        service: config.appName,
        version: config.appVersion,
        env: config.nodeEnv,
        commit: config.release.commit ?? 'unknown',
      },
      // Keep request logs small and free of user content.
      serializers: {
        req: (req: { id: string; method: string; url?: string; remoteAddress?: string }) => ({
          id: req.id,
          method: req.method,
          // A serializer that throws loses the whole line, so a request
          // without a URL degrades to an empty one rather than an exception.
          url: redactLoggedUrl(req.url ?? ''),
        }),
        res: (res: { statusCode: number }) => ({ statusCode: res.statusCode }),
      },
      autoLogging: true,
      ...(config.logPretty
        ? {
            transport: {
              target: 'pino-pretty',
              options: { singleLine: true, translateTime: 'SYS:HH:MM:ss.l' },
            },
          }
        : {}),
    },
  };
}
