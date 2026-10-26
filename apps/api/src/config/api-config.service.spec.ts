import { apiEnvSchema, loadEnv } from '@palcert/config';
import { ApiConfigService } from './api-config.service';

const rawEnv = {
  NODE_ENV: 'development',
  DATABASE_URL: 'postgresql://palcert:palcert@localhost:5432/palcert',
  REDIS_URL: 'redis://localhost:6379',
  STORAGE_ENDPOINT: 'http://localhost:9000',
  STORAGE_BUCKET: 'palcert-documents',
  STORAGE_QUARANTINE_BUCKET: 'palcert-quarantine',
  STORAGE_DERIVED_BUCKET: 'palcert-derived',
  STORAGE_ACCESS_KEY_ID: 'key',
  STORAGE_SECRET_ACCESS_KEY: 'secret',
  AUTH_MFA_SECRET_KEY: Buffer.alloc(32, 7).toString('base64'),
  CERTIFICATE_VERIFICATION_SECRET_KEY: Buffer.alloc(32, 9).toString('base64'),
  API_CLIENT_REVEAL_SECRET_KEY: Buffer.alloc(32, 10).toString('base64'),
};

describe('ApiConfigService', () => {
  it('exposes validated values', () => {
    const config = new ApiConfigService(loadEnv(apiEnvSchema, rawEnv));

    expect(config.port).toBe(4000);
    expect(config.host).toBe('0.0.0.0');
    expect(config.isProduction).toBe(false);
    expect(config.rateLimit).toEqual({ ttlSeconds: 60, limit: 120 });
    expect(config.documentEngineUrl).toBe('http://localhost:8000');
  });

  it('parses and trims the CORS origin allow-list', () => {
    const config = new ApiConfigService(
      loadEnv(apiEnvSchema, {
        ...rawEnv,
        API_CORS_ORIGINS: 'http://localhost:3000, https://palcert.com ,',
      }),
    );

    expect(config.corsOrigins).toEqual(['http://localhost:3000', 'https://palcert.com']);
  });

  it('exposes the session policy, with stricter values for privileged roles', () => {
    const config = new ApiConfigService(loadEnv(apiEnvSchema, rawEnv));

    expect(config.sessionPolicy).toEqual({
      idleMinutes: 60,
      absoluteMinutes: 720,
      privilegedIdleMinutes: 15,
      privilegedAbsoluteMinutes: 480,
      pendingMfaMinutes: 5,
      reauthWindowMinutes: 15,
    });
  });

  it('decodes the MFA key to exactly 32 bytes', () => {
    const config = new ApiConfigService(loadEnv(apiEnvSchema, rawEnv));

    expect(config.mfaPolicy.secretKey).toHaveLength(32);
    expect(config.mfaPolicy.recoveryCodeCount).toBe(10);
  });

  it('marks cookies Secure only in production', () => {
    const development = new ApiConfigService(loadEnv(apiEnvSchema, rawEnv));
    expect(development.cookiePolicy.secure).toBe(false);
    expect(development.cookiePolicy.sameSite).toBe('lax');

    const production = new ApiConfigService(
      loadEnv(apiEnvSchema, {
        ...rawEnv,
        NODE_ENV: 'production',
        STORAGE_SERVER_SIDE_ENCRYPTION: 'AES256',
        STORAGE_ENDPOINT: 'https://storage.example.test',
        // Required in production from Phase 20 Checkpoint 9: browsers upload
        // to the web origin, the only one its CSP lets them connect to.
        STORAGE_PUBLIC_ENDPOINT: 'https://palcert.com',
        // Required in production from Phase 20 Checkpoint 7: a deployment
        // behind a proxy has to say which upstreams may assert a client's
        // address, or the per-IP throttles collapse everyone onto the proxy.
        API_TRUSTED_PROXIES: 'uniquelocal',
        API_DOCS_ENABLED: 'false',
        API_CORS_ORIGINS: 'https://palcert.com',
        APP_PUBLIC_WEB_URL: 'https://palcert.com',
      }),
    );
    expect(production.cookiePolicy.secure).toBe(true);
  });

  describe('webhookOwnHosts', () => {
    /**
     * PalCert's own hostnames are refused as webhook destinations, so that an
     * endpoint pointed at PalCert cannot turn its outbound requests into
     * inbound ones carrying whatever trust the network grants them.
     *
     * The Checkpoint 20.1 audit raised F-003 on the grounds that
     * `WEBHOOK_OWN_HOSTS` defaults to empty in production. Re-examined in
     * 20.7: the list is not the variable. The public web host is *derived*
     * from `APP_PUBLIC_WEB_URL`, which production requires, and unioned with
     * whatever the variable adds — so an empty variable never means "nothing
     * is refused". Asserted here so it stays that way.
     */
    it('always refuses PalCert’s own public host, even with nothing configured', () => {
      const config = new ApiConfigService(
        loadEnv(apiEnvSchema, {
          ...rawEnv,
          APP_PUBLIC_WEB_URL: 'https://palcert.example',
          WEBHOOK_OWN_HOSTS: '',
        }),
      );
      expect(config.webhookOwnHosts).toContain('palcert.example');
    });

    it('unions the configured hosts with the derived one, lower-cased', () => {
      const config = new ApiConfigService(
        loadEnv(apiEnvSchema, {
          ...rawEnv,
          APP_PUBLIC_WEB_URL: 'https://palcert.example',
          WEBHOOK_OWN_HOSTS: 'API.palcert.example, hooks.palcert.example ',
        }),
      );
      expect([...config.webhookOwnHosts].sort()).toEqual([
        'api.palcert.example',
        'hooks.palcert.example',
        'palcert.example',
      ]);
    });
  });

  describe('trustedProxies', () => {
    /**
     * The value Express's `trust proxy` is set from (Phase 20 Checkpoint 7).
     *
     * `false` is not a default to skip past: it means no forwarded header is
     * believed and `req.ip` is the address that opened the socket. Everything
     * that reads a client address — the per-IP login throttle, the public
     * verification guard, every audit record — depends on which of these two
     * shapes comes back.
     */
    it('believes nobody when nothing is configured', () => {
      const config = new ApiConfigService(loadEnv(apiEnvSchema, rawEnv));
      expect(config.trustedProxies).toBe(false);
    });

    it('believes nobody when the value is empty or only separators', () => {
      for (const value of ['', '  ', ',', ' , ']) {
        const config = new ApiConfigService(
          loadEnv(apiEnvSchema, { ...rawEnv, API_TRUSTED_PROXIES: value }),
        );
        expect(config.trustedProxies).toBe(false);
      }
    });

    it('passes a configured list through as entries, trimmed', () => {
      const config = new ApiConfigService(
        loadEnv(apiEnvSchema, {
          ...rawEnv,
          API_TRUSTED_PROXIES: 'uniquelocal, 10.0.0.1 , 192.168.0.0/16',
        }),
      );
      expect(config.trustedProxies).toEqual(['uniquelocal', '10.0.0.1', '192.168.0.0/16']);
    });
  });

  it('reports production mode correctly', () => {
    const config = new ApiConfigService(
      loadEnv(apiEnvSchema, {
        ...rawEnv,
        NODE_ENV: 'production',
        STORAGE_SERVER_SIDE_ENCRYPTION: 'AES256',
        STORAGE_ENDPOINT: 'https://storage.example.test',
        // Required in production from Phase 20 Checkpoint 9: browsers upload
        // to the web origin, the only one its CSP lets them connect to.
        STORAGE_PUBLIC_ENDPOINT: 'https://palcert.com',
        // Required in production from Phase 20 Checkpoint 7: a deployment
        // behind a proxy has to say which upstreams may assert a client's
        // address, or the per-IP throttles collapse everyone onto the proxy.
        API_TRUSTED_PROXIES: 'uniquelocal',
        API_DOCS_ENABLED: 'false',
        API_CORS_ORIGINS: 'https://palcert.com',
        APP_PUBLIC_WEB_URL: 'https://palcert.com',
      }),
    );

    expect(config.isProduction).toBe(true);
    expect(config.docsEnabled).toBe(false);
  });
});
