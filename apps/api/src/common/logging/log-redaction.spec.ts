import pino from 'pino';
import type { ApiConfigService } from '../../config/api-config.service';
import { buildLoggerParams, redactLoggedUrl } from './logger.config';

const config = {
  logLevel: 'trace',
  logPretty: false,
  appName: 'palcert-api',
  appVersion: '0.1.0',
  nodeEnv: 'test',
  release: { commit: 'abc1234' },
} as unknown as ApiConfigService;

/**
 * Every value PalCert must never write down (Phase 20 Checkpoint 3, §12).
 *
 * Each one is a distinctive string, so the assertion is "this exact secret
 * does not appear anywhere in the serialized line" rather than "a field that
 * happens to be named right was censored". A redaction that only covers the
 * field name people remembered is not a redaction.
 */
const FORBIDDEN = {
  password: 'sup3r-secret-password',
  clientSecret: 'pcsk_livesecretvalue0123456789',
  signingSecret: 'whsec_live_signing_value_0123',
  stripeSecretKey: 'sk_live_paymentprovidersecret', // gitleaks:allow (planted; the redactor must remove it)
  authorization: 'Bearer eyJhbGciOiJIUzI1NiJ9.forged',
  documentContent: 'the applicant declares under penalty of perjury',
  verificationCode: 'CAP-9Z8Y7X6W5V4U',
} as const;

/**
 * A pino logger wired exactly as the application's is, writing to a buffer.
 *
 * Asserting on the real serializer output is the whole point: the redaction
 * paths are configuration, and configuration that is only unit-tested against
 * itself proves nothing about what lands on disk.
 */
function captured(): { logger: pino.Logger; lines: () => string } {
  const chunks: string[] = [];
  const options = buildLoggerParams(config).pinoHttp as pino.LoggerOptions;
  const logger = pino({ ...options, level: 'trace' }, {
    write: (chunk: string) => chunks.push(chunk),
  } as pino.DestinationStream);
  return { logger, lines: () => chunks.join('') };
}

describe('log redaction', () => {
  it('identifies the build that wrote every line', () => {
    const { logger, lines } = captured();
    logger.info('hello');
    const line = JSON.parse(lines()) as Record<string, unknown>;
    expect(line.service).toBe('palcert-api');
    expect(line.env).toBe('test');
    expect(line.commit).toBe('abc1234');
    expect(line.time).toEqual(expect.any(Number));
    expect(line.level).toEqual(expect.any(Number));
  });

  it.each(Object.entries(FORBIDDEN))(
    'never writes a %s, at the top level or nested',
    (field, value) => {
      const { logger, lines } = captured();

      logger.info({ [field]: value }, 'top level');
      logger.info({ detail: { [field]: value } }, 'nested one level');
      logger.error({ err: new Error('failed'), [field]: value }, 'alongside an error');

      const output = lines();
      expect(output).not.toContain(value);
      expect(output).toContain('[REDACTED]');
    },
  );

  it('never writes a request Authorization or cookie header', () => {
    const { logger, lines } = captured();

    logger.info(
      {
        req: {
          id: 'req-1',
          method: 'GET',
          url: '/api/v1/documents',
          headers: {
            authorization: FORBIDDEN.authorization,
            cookie: 'palcert_session=abcdef',
            'x-api-key': 'key-1234',
          },
        },
      },
      'request',
    );

    const output = lines();
    expect(output).not.toContain(FORBIDDEN.authorization);
    expect(output).not.toContain('palcert_session=abcdef');
    expect(output).not.toContain('key-1234');
  });

  it('never writes a Set-Cookie back to the client', () => {
    const { logger, lines } = captured();
    logger.info({ res: { headers: { 'set-cookie': 'palcert_session=abcdef; HttpOnly' } } }, 'res');
    expect(lines()).not.toContain('palcert_session=abcdef');
  });

  it('never writes a capability out of a URL an access log would record', () => {
    expect(redactLoggedUrl('/api/v1/public/certificates/CAP-9Z8Y7X6W5V4U')).not.toContain(
      FORBIDDEN.verificationCode,
    );
    expect(
      redactLoggedUrl('/api/v1/documents?client_secret=pcsk_livesecretvalue0123456789'),
    ).not.toContain(FORBIDDEN.clientSecret);
  });

  it('never writes document text carried on an AI or analysis payload', () => {
    const { logger, lines } = captured();
    logger.info(
      {
        prompt: FORBIDDEN.documentContent,
        contextBundle: FORBIDDEN.documentContent,
        providerResponse: FORBIDDEN.documentContent,
        analysis: { documentText: FORBIDDEN.documentContent },
      },
      'analysis',
    );
    expect(lines()).not.toContain(FORBIDDEN.documentContent);
  });
});
