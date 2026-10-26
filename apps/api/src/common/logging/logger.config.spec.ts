import { REQUEST_ID_HEADER } from '@palcert/contracts';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { ApiConfigService } from '../../config/api-config.service';
import { LOG_REDACT_PATHS, buildLoggerParams, redactLoggedUrl } from './logger.config';

const config = {
  logLevel: 'info',
  logPretty: false,
  appName: 'palcert-api',
  appVersion: '0.1.0',
  nodeEnv: 'test',
  release: { commit: 'abc1234' },
} as unknown as ApiConfigService;

type GenReqId = (req: IncomingMessage, res: ServerResponse) => string;
type CustomLogLevel = (req: IncomingMessage, res: ServerResponse, err?: Error) => string;

function pinoHttpOptions() {
  const params = buildLoggerParams(config);
  return params.pinoHttp as unknown as {
    genReqId: GenReqId;
    customLogLevel: CustomLogLevel;
    redact: { paths: string[]; censor: string };
    serializers: {
      req: (req: { id: string; method: string; url: string }) => {
        id: string;
        method: string;
        url: string;
      };
    };
    base: Record<string, unknown>;
    transport?: unknown;
  };
}

function fakeRes(): ServerResponse & { headers: Record<string, string> } {
  const headers: Record<string, string> = {};
  return {
    headers,
    statusCode: 200,
    setHeader(name: string, value: string) {
      headers[name] = value;
    },
  } as unknown as ServerResponse & { headers: Record<string, string> };
}

describe('logger configuration', () => {
  it('reuses an inbound request id so traces span services', () => {
    const { genReqId } = pinoHttpOptions();
    const res = fakeRes();

    const id = genReqId(
      { headers: { [REQUEST_ID_HEADER]: 'upstream-id' }, url: '/' } as unknown as IncomingMessage,
      res,
    );

    expect(id).toBe('upstream-id');
    expect(res.headers[REQUEST_ID_HEADER]).toBe('upstream-id');
  });

  it('generates a request id when none is supplied and echoes it back', () => {
    const { genReqId } = pinoHttpOptions();
    const res = fakeRes();

    const id = genReqId({ headers: {}, url: '/' } as unknown as IncomingMessage, res);

    expect(id).toMatch(/^[0-9a-f-]{36}$/);
    expect(res.headers[REQUEST_ID_HEADER]).toBe(id);
  });

  it('rejects an oversized inbound request id (log-injection guard)', () => {
    const { genReqId } = pinoHttpOptions();
    const res = fakeRes();

    const id = genReqId(
      { headers: { [REQUEST_ID_HEADER]: 'x'.repeat(500) }, url: '/' } as unknown as IncomingMessage,
      res,
    );

    expect(id).not.toContain('xxxxx');
    expect(id).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('never lets a verification code reach the access log', () => {
    // §184, §186: the code is a credential. An access log that recorded it
    // would let anybody who reads logs verify a certificate they were never
    // shown — and access logs get shipped, kept and read widely.
    const { serializers } = pinoHttpOptions();
    const logged = serializers.req({
      id: 'r1',
      method: 'GET',
      url: '/api/v1/public/certificates/PC-ABCD2345-EFGH6789-JKLM0123-NPQR4567',
    });
    expect(logged.url).toBe('/api/v1/public/certificates/[REDACTED]');
    expect(JSON.stringify(logged)).not.toContain('ABCD2345');

    // A bare code, a query string and a lowercase variant are all the same
    // credential.
    expect(redactLoggedUrl('/api/v1/public/certificates/abcd2345efgh6789jklm0123npqr4567')).toBe(
      '/api/v1/public/certificates/[REDACTED]',
    );
    expect(redactLoggedUrl('/api/v1/public/certificates/PC-AAAA?x=1')).toBe(
      '/api/v1/public/certificates/[REDACTED]?x=1',
    );
    // Everything else is left alone: a redactor that ate ordinary paths would
    // make the logs useless.
    expect(redactLoggedUrl('/api/v1/certificates/11111111-1111-4111-8111-111111111111')).toBe(
      '/api/v1/certificates/11111111-1111-4111-8111-111111111111',
    );
  });

  it('redacts verification capability wherever it appears in a log object', () => {
    // §184 and the Phase 15 correction: the code, the readable number and the
    // sealed staging copy are all capability material. Nothing logs them on
    // purpose — this is the net under that.
    const { redact } = pinoHttpOptions();
    for (const path of [
      'verificationCode',
      '*.verificationCode',
      'verificationCodeCiphertext',
      '*.verificationCodeCiphertext',
      '*.verification_code_ciphertext',
      'certificateNumber',
      '*.certificateNumber',
    ]) {
      expect(redact.paths).toContain(path);
    }
  });

  it('redacts credentials and secrets', () => {
    const { redact } = pinoHttpOptions();
    expect(redact.censor).toBe('[REDACTED]');
    for (const path of [
      'req.headers.authorization',
      'req.headers.cookie',
      'req.body.password',
      '*.accessToken',
    ]) {
      expect(LOG_REDACT_PATHS).toContain(path);
      expect(redact.paths).toContain(path);
    }
  });

  it('redacts an API-client secret wherever it appears (Phase 19)', () => {
    const { redact, serializers } = pinoHttpOptions();
    const secret = `pcsk_${'a'.repeat(64)}`;

    // As a field, at the top level and one level in, in either spelling: the
    // reveal response and the database row do not use the same name.
    for (const path of [
      'clientSecret',
      '*.clientSecret',
      'secretVerifier',
      '*.secretVerifier',
      'client_secret',
      'revealedSecretCiphertext',
    ]) {
      expect(LOG_REDACT_PATHS).toContain(path);
      expect(redact.paths).toContain(path);
    }

    // And in a URL, which is the one place a caller can put a credential
    // without PalCert having accepted it. The request fails either way; what
    // this stops is the failure also burning the secret into an access log.
    expect(redactLoggedUrl(`/api/v1/integration/v1/organization?s=${secret}`)).not.toContain(
      secret,
    );
    expect(redactLoggedUrl(`/api/v1/integration/v1/organization?s=${secret}`)).toContain(
      '[REDACTED]',
    );
    expect(serializers.req({ id: 'r', method: 'GET', url: `/x?s=${secret}` }).url).not.toContain(
      secret,
    );

    // The public half is not a secret and stays readable: an administrator
    // investigating a refusal needs to know which credential it was.
    expect(redactLoggedUrl('/api/v1/x?client=pcid_0123456789abcdef0123456789abcdef')).toContain(
      'pcid_0123456789abcdef0123456789abcdef',
    );
  });

  it('escalates log level with response status and demotes probe traffic', () => {
    const { customLogLevel } = pinoHttpOptions();
    const req = (url: string) => ({ url }) as unknown as IncomingMessage;
    const res = (statusCode: number) => ({ statusCode }) as unknown as ServerResponse;

    expect(customLogLevel(req('/api/v1/x'), res(200))).toBe('info');
    expect(customLogLevel(req('/api/v1/x'), res(404))).toBe('warn');
    expect(customLogLevel(req('/api/v1/x'), res(500))).toBe('error');
    expect(customLogLevel(req('/api/v1/x'), res(200), new Error('boom'))).toBe('error');
    expect(customLogLevel(req('/health/ready'), res(200))).toBe('debug');
  });

  it('tags every line with service, version, environment and build', () => {
    expect(pinoHttpOptions().base).toEqual({
      service: 'palcert-api',
      version: '0.1.0',
      env: 'test',
      commit: 'abc1234',
    });
  });

  it('does not configure a pretty transport when pretty logging is off', () => {
    expect(pinoHttpOptions().transport).toBeUndefined();
  });
});
