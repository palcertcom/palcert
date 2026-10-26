import { describe, expect, it } from 'vitest';
import { apiEnvSchema, webEnvSchema } from './env.schema.js';
import { ConfigurationError, isSensitiveConfigKey, loadEnv, redactConfig } from './load-env.js';

const validApiEnv = {
  NODE_ENV: 'development',
  DATABASE_URL: 'postgresql://palcert:palcert@localhost:5432/palcert',
  REDIS_URL: 'redis://localhost:6379',
  STORAGE_ENDPOINT: 'http://localhost:9000',
  STORAGE_BUCKET: 'palcert-documents',
  STORAGE_QUARANTINE_BUCKET: 'palcert-quarantine',
  STORAGE_DERIVED_BUCKET: 'palcert-derived',
  STORAGE_ACCESS_KEY_ID: 'local-access-key',
  STORAGE_SECRET_ACCESS_KEY: 'local-secret-key',
  AUTH_MFA_SECRET_KEY: Buffer.alloc(32, 7).toString('base64'),
  CERTIFICATE_VERIFICATION_SECRET_KEY: Buffer.alloc(32, 9).toString('base64'),
  API_CLIENT_REVEAL_SECRET_KEY: Buffer.alloc(32, 10).toString('base64'),
};

describe('loadEnv (API)', () => {
  it('accepts a valid development environment and applies defaults', () => {
    const env = loadEnv(apiEnvSchema, validApiEnv);
    expect(env.API_PORT).toBe(4000);
    expect(env.LOG_LEVEL).toBe('info');
    expect(env.DATABASE_POOL_MAX).toBe(10);
    expect(env.STORAGE_FORCE_PATH_STYLE).toBe(true);
  });

  it('coerces numeric and boolean values from strings', () => {
    const env = loadEnv(apiEnvSchema, {
      ...validApiEnv,
      API_PORT: '5000',
      LOG_PRETTY: 'true',
      DATABASE_POOL_MAX: '25',
    });
    expect(env.API_PORT).toBe(5000);
    expect(env.LOG_PRETTY).toBe(true);
    expect(env.DATABASE_POOL_MAX).toBe(25);
  });

  it('reports every configuration problem at once', () => {
    expect.assertions(4);
    try {
      loadEnv(apiEnvSchema, { ...validApiEnv, DATABASE_URL: 'not-a-url', REDIS_URL: 'http://x' });
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigurationError);
      const configError = error as ConfigurationError;
      expect(configError.issues.length).toBeGreaterThanOrEqual(2);
      expect(configError.issues.join()).toContain('DATABASE_URL');
      expect(configError.issues.join()).toContain('REDIS_URL');
    }
  });

  it('applies safe authentication defaults', () => {
    const env = loadEnv(apiEnvSchema, validApiEnv);

    expect(env.AUTH_SESSION_IDLE_MINUTES).toBe(60);
    expect(env.AUTH_SESSION_ABSOLUTE_MINUTES).toBe(720);
    expect(env.AUTH_PRIVILEGED_SESSION_IDLE_MINUTES).toBe(15);
    expect(env.AUTH_MFA_PENDING_MINUTES).toBe(5);
    expect(env.AUTH_PASSWORD_MIN_LENGTH).toBe(12);
    expect(env.AUTH_ARGON2_MEMORY_KIB).toBe(19456);
    expect(env.AUTH_BREACHED_PASSWORD_CHECK_ENABLED).toBe(false);
  });

  it('gives privileged sessions a stricter policy than standard sessions', () => {
    const env = loadEnv(apiEnvSchema, validApiEnv);

    expect(env.AUTH_PRIVILEGED_SESSION_IDLE_MINUTES).toBeLessThan(env.AUTH_SESSION_IDLE_MINUTES);
    expect(env.AUTH_PRIVILEGED_SESSION_ABSOLUTE_MINUTES).toBeLessThan(
      env.AUTH_SESSION_ABSOLUTE_MINUTES,
    );
  });

  it('rejects an MFA encryption key that is not 32 bytes', () => {
    expect(() =>
      loadEnv(apiEnvSchema, {
        ...validApiEnv,
        AUTH_MFA_SECRET_KEY: Buffer.alloc(16).toString('base64'),
      }),
    ).toThrow(/exactly 32 bytes/);
  });

  it('rejects an idle timeout longer than the absolute lifetime', () => {
    expect(() =>
      loadEnv(apiEnvSchema, {
        ...validApiEnv,
        NODE_ENV: 'production',
        LOG_PRETTY: 'false',
        API_DOCS_ENABLED: 'false',
        API_CORS_ORIGINS: 'https://palcert.com',
        APP_PUBLIC_WEB_URL: 'https://palcert.com',
        AUTH_SESSION_IDLE_MINUTES: '5000',
        AUTH_SESSION_ABSOLUTE_MINUTES: '60',
      }),
    ).toThrow(/idle timeout cannot exceed/);
  });

  /**
   * Phase 20 Checkpoint 2: `AI_ENABLED=false` used to mean true.
   *
   * The field was `z.coerce.boolean()`, and coercion runs the string through
   * JavaScript's `Boolean`, where every non-empty string is truthy. No
   * deployment noticed because the cross-field guard then demanded an
   * Anthropic key and every environment had one — the flag was wrong and the
   * symptom was hidden by a second rule.
   */
  it('reads AI_ENABLED=false as false', () => {
    expect(loadEnv(apiEnvSchema, { ...validApiEnv, AI_ENABLED: 'false' }).AI_ENABLED).toBe(false);
    expect(loadEnv(apiEnvSchema, { ...validApiEnv, AI_ENABLED: '0' }).AI_ENABLED).toBe(false);
    expect(
      loadEnv(apiEnvSchema, { ...validApiEnv, AI_ENABLED: 'true', AI_PRIMARY_PROVIDER: 'fake' })
        .AI_ENABLED,
    ).toBe(true);
    // Anything that is not one of the four accepted spellings is a mistake,
    // and guessing at it is how `false` became `true` in the first place.
    expect(() => loadEnv(apiEnvSchema, { ...validApiEnv, AI_ENABLED: 'no' })).toThrow();
  });

  /**
   * A container that declares `ARG APP_COMMIT=""` and is built without the
   * argument sets the variable to an empty string, which is present rather
   * than unset. Refusing to boot over a missing build label would turn a
   * cosmetic gap into an outage.
   */
  it('treats empty release identity as absent rather than invalid', () => {
    const parsed = loadEnv(apiEnvSchema, { ...validApiEnv, APP_COMMIT: '', APP_BUILT_AT: '' });
    expect(parsed.APP_COMMIT).toBeUndefined();
    expect(parsed.APP_BUILT_AT).toBeUndefined();

    // A non-empty value is still validated: a short SHA is a mistake worth
    // catching, because it makes "which commit is running?" unanswerable.
    expect(() => loadEnv(apiEnvSchema, { ...validApiEnv, APP_COMMIT: 'abc123' })).toThrow();
  });

  /**
   * Phase 20 Checkpoint 7: the error message used to contain the value.
   *
   * `loadEnv` documented that raw values never appear in what it throws, and
   * they did — Zod reports a rejected enum as `received '<value>'`, and that
   * message went straight into `ConfigurationError`. This is thrown at boot,
   * printed to stderr and collected by whatever ships container logs, so the
   * realistic consequence is not an attack: it is an operator pasting a key
   * into the wrong variable and finding it in the startup log of every
   * replica, in plaintext, for as long as logs are kept.
   */
  describe('configuration errors do not echo values', () => {
    // Clearly invalid test data; never a usable provider credential.
    const PLANTED = 'sk_live_not_a_real_key';

    it('hides a value rejected by an enum field, whatever the field is called', () => {
      // `API_DOCS_ENABLED` is not a sensitive-looking name. That is the point:
      // the value needing protection is usually in a field nobody would think
      // to treat as a secret.
      try {
        loadEnv(apiEnvSchema, { ...validApiEnv, API_DOCS_ENABLED: PLANTED });
        throw new Error('expected a configuration error');
      } catch (error) {
        expect(error).toBeInstanceOf(ConfigurationError);
        const message = (error as ConfigurationError).message;
        expect(message).toContain('API_DOCS_ENABLED');
        expect(message).not.toContain(PLANTED);
        expect(message).not.toContain('sk_live');
      }
    });

    it('hides a value supplied under a sensitive name', () => {
      try {
        loadEnv(apiEnvSchema, { ...validApiEnv, STRIPE_SECRET_KEY: 'short' });
        throw new Error('expected a configuration error');
      } catch (error) {
        expect((error as ConfigurationError).message).not.toContain('short');
      }
    });

    it('still says what was wrong, in the operator’s terms', () => {
      // The first attempt at the scrubber removed every supplied value of four
      // characters or more. `NODE_ENV` supplies `production`, so ten messages
      // that legitimately end "in production" came back reading "in
      // [REDACTED]" — a redaction that destroys the sentence an operator needs
      // has traded one problem for another.
      expect(() =>
        loadEnv(apiEnvSchema, {
          ...validApiEnv,
          NODE_ENV: 'production',
          API_DOCS_ENABLED: 'true',
          API_CORS_ORIGINS: 'https://palcert.com',
          APP_PUBLIC_WEB_URL: 'https://palcert.com',
        }),
      ).toThrow(/API docs must be disabled in production/);
    });
  });

  it('rejects a short secret', () => {
    expect(() => loadEnv(apiEnvSchema, { ...validApiEnv, STRIPE_SECRET_KEY: 'short' })).toThrow(
      ConfigurationError,
    );
  });

  /**
   * Phase 20 Checkpoint 2: `AUTH_SESSION_SECRET` is gone.
   *
   * It was declared "reserved for Phase 1 (authentication)". Phase 1 shipped
   * opaque random session tokens stored as SHA-256 hashes, so nothing ever
   * signed anything and no runtime code read the value. A required secret that
   * protects nothing is worse than no secret: an operator provisions it,
   * rotates it on a schedule, and believes sessions are cryptographically
   * bound to it.
   *
   * The deployment that still sets it must keep booting — removing a variable
   * is not a reason to break a running environment — so the schema ignores it
   * rather than rejecting it.
   */
  it('no longer requires AUTH_SESSION_SECRET, and ignores it when present', () => {
    expect(() => loadEnv(apiEnvSchema, validApiEnv)).not.toThrow();

    const parsed = loadEnv(apiEnvSchema, {
      ...validApiEnv,
      AUTH_SESSION_SECRET: 'a-value-an-existing-deployment-still-sets',
    });
    expect('AUTH_SESSION_SECRET' in parsed).toBe(false);
  });

  it('rejects a missing required variable', () => {
    const { DATABASE_URL: _omitted, ...withoutDb } = validApiEnv;
    expect(() => loadEnv(apiEnvSchema, withoutDb)).toThrow(/DATABASE_URL/);
  });

  it('never echoes raw values in the error message', () => {
    try {
      loadEnv(apiEnvSchema, { ...validApiEnv, STRIPE_SECRET_KEY: 'leak-me-please' });
    } catch (error) {
      expect((error as Error).message).not.toContain('leak-me-please');
    }
  });

  describe('production hardening', () => {
    const prodEnv = {
      ...validApiEnv,
      NODE_ENV: 'production',
      LOG_PRETTY: 'false',
      APP_PUBLIC_WEB_URL: 'https://palcert.com',
      // Phase 5: documents are encrypted at rest and reached over TLS.
      STORAGE_ENDPOINT: 'https://s3.example.com',
      STORAGE_SERVER_SIDE_ENCRYPTION: 'AES256',
      // Phase 20 Checkpoint 9: browsers upload to the web origin, the only
      // one the web app's CSP lets them connect to.
      STORAGE_PUBLIC_ENDPOINT: 'https://palcert.com',
      // Phase 20 Checkpoint 7: production sits behind a proxy by definition —
      // it is required to serve https and PalCert does not terminate TLS — so
      // it has to say which upstreams may assert a client's address.
      API_TRUSTED_PROXIES: 'uniquelocal',
    };

    it.each([
      ['STORAGE_SERVER_SIDE_ENCRYPTION', 'none', /encrypted at rest in production/],
      ['STORAGE_ENDPOINT', 'http://s3.example.com', /over TLS in production/],
      ['MALWARE_SCANNER', 'fake', /production/],
    ])('rejects a weakened %s for documents in production', (key, value, message) => {
      expect(() =>
        loadEnv(apiEnvSchema, {
          ...prodEnv,
          API_DOCS_ENABLED: 'false',
          API_CORS_ORIGINS: 'https://palcert.com',
          [key]: value,
        }),
      ).toThrow(message);
    });

    it('refuses a Resend base URL override in production, so the credential cannot be redirected', () => {
      expect(() =>
        loadEnv(apiEnvSchema, {
          ...prodEnv,
          API_DOCS_ENABLED: 'false',
          API_CORS_ORIGINS: 'https://palcert.com',
          RESEND_API_BASE_URL: 'https://attacker.example',
        }),
      ).toThrow(/RESEND_API_BASE_URL/);
    });

    it('rejects API docs enabled in production', () => {
      expect(() => loadEnv(apiEnvSchema, { ...prodEnv, API_DOCS_ENABLED: 'true' })).toThrow(
        /API docs must be disabled in production/,
      );
    });

    it('rejects pretty logging in production', () => {
      expect(() => loadEnv(apiEnvSchema, { ...prodEnv, LOG_PRETTY: 'true' })).toThrow(
        /Pretty logging must be disabled in production/,
      );
    });

    it('rejects a wildcard CORS origin in production', () => {
      expect(() =>
        loadEnv(apiEnvSchema, { ...prodEnv, API_DOCS_ENABLED: 'false', API_CORS_ORIGINS: '*' }),
      ).toThrow(/Wildcard CORS origin/);
    });

    it.each([
      ['AUTH_ARGON2_MEMORY_KIB', '4096', /at least 19456 KiB in production/],
      ['AUTH_ARGON2_TIME_COST', '1', /at least 2 in production/],
      ['AUTH_PASSWORD_MIN_LENGTH', '8', /at least 12 characters in production/],
      ['AUTH_COOKIE_SAMESITE', 'none', /SameSite=None is not allowed in production/],
      ['APP_PUBLIC_WEB_URL', 'http://palcert.com', /must be an https URL in production/],
    ])('rejects a weakened %s in production', (key, value, message) => {
      expect(() =>
        loadEnv(apiEnvSchema, {
          ...prodEnv,
          API_DOCS_ENABLED: 'false',
          API_CORS_ORIGINS: 'https://palcert.com',
          [key]: value,
        }),
      ).toThrow(message);
    });

    it('accepts a correctly hardened production environment', () => {
      const env = loadEnv(apiEnvSchema, {
        ...prodEnv,
        API_DOCS_ENABLED: 'false',
        API_CORS_ORIGINS: 'https://palcert.com',
      });
      expect(env.NODE_ENV).toBe('production');
      expect(env.API_DOCS_ENABLED).toBe(false);
      expect(env.AUTH_ARGON2_MEMORY_KIB).toBe(19456);
      expect(env.AUTH_COOKIE_SAMESITE).toBe('lax');
    });

    it('refuses a production deployment that does not say who its proxies are', () => {
      // Not pedantry: the per-IP login throttle, the public-verification guard
      // and every audit record read the client address, and behind a proxy
      // with nothing configured they would all see the proxy. The whole world
      // would share one budget and every audit row would name one address.
      const { API_TRUSTED_PROXIES: _omitted, ...withoutProxies } = prodEnv;
      expect(() =>
        loadEnv(apiEnvSchema, {
          ...withoutProxies,
          API_DOCS_ENABLED: 'false',
          API_CORS_ORIGINS: 'https://palcert.com',
        }),
      ).toThrow(/API_TRUSTED_PROXIES/);
    });

    it('is content without one outside production, where there is no proxy', () => {
      expect(loadEnv(apiEnvSchema, validApiEnv).API_TRUSTED_PROXIES).toBeUndefined();
    });

    /**
     * Phase 20 Checkpoint 9: the release topology signed every upload URL for
     * an origin the browser was not allowed to reach, and no document could
     * be uploaded through the UI. The web app's CSP is `connect-src 'self'`,
     * so the only origin a browser can upload to is the web app's own.
     */
    describe('the origin browsers upload to', () => {
      const hardened = {
        ...prodEnv,
        API_DOCS_ENABLED: 'false',
        API_CORS_ORIGINS: 'https://palcert.com',
      };

      it('is required in production', () => {
        const { STORAGE_PUBLIC_ENDPOINT: _omitted, ...withoutPublicEndpoint } = hardened;
        expect(() => loadEnv(apiEnvSchema, withoutPublicEndpoint)).toThrow(
          /STORAGE_PUBLIC_ENDPOINT/,
        );
      });

      it.each([
        ['the internal storage endpoint', 'https://s3.example.com'],
        ['another port on the web host', 'https://palcert.com:9000'],
        ['plain http on the web host', 'http://palcert.com'],
        ['a path under the web origin', 'https://palcert.com/storage'],
      ])('refuses %s, which the browser could not reach', (_label, value) => {
        expect(() =>
          loadEnv(apiEnvSchema, { ...hardened, STORAGE_PUBLIC_ENDPOINT: value }),
        ).toThrow(/must be the origin of APP_PUBLIC_WEB_URL/);
      });

      it('accepts the web origin, with or without a trailing slash', () => {
        for (const value of ['https://palcert.com', 'https://palcert.com/']) {
          expect(
            loadEnv(apiEnvSchema, { ...hardened, STORAGE_PUBLIC_ENDPOINT: value })
              .STORAGE_PUBLIC_ENDPOINT,
          ).toBe(value);
        }
      });

      it('is not constrained outside production', () => {
        expect(
          loadEnv(apiEnvSchema, {
            ...validApiEnv,
            STORAGE_PUBLIC_ENDPOINT: 'http://localhost:9000',
          }).STORAGE_PUBLIC_ENDPOINT,
        ).toBe('http://localhost:9000');
      });
    });
  });
});

describe('the webhook keyring', () => {
  const key = (fill: number) => Buffer.alloc(32, fill).toString('base64');

  it('runs without one, because a deployment may send no webhooks', () => {
    const env = loadEnv(apiEnvSchema, validApiEnv);
    expect(env.WEBHOOK_ENCRYPTION_ACTIVE_KID).toBeUndefined();
    expect(env.WEBHOOK_ALLOWED_PORTS).toBe('443');
  });

  it('accepts a ring where the active key is one of several', () => {
    const env = loadEnv(apiEnvSchema, {
      ...validApiEnv,
      WEBHOOK_ENCRYPTION_ACTIVE_KID: 'k2',
      WEBHOOK_ENCRYPTION_KEYS: `k1:${key(1)},k2:${key(2)}`,
    });
    expect(env.WEBHOOK_ENCRYPTION_ACTIVE_KID).toBe('k2');
  });

  it('refuses half a keyring', () => {
    // A process with keys but no active kid cannot seal, and one with an
    // active kid naming a key it does not hold cannot decrypt. Both would be
    // discovered on a real delivery and reported as somebody else's endpoint
    // being broken.
    expect(() =>
      loadEnv(apiEnvSchema, { ...validApiEnv, WEBHOOK_ENCRYPTION_ACTIVE_KID: 'k1' }),
    ).toThrow(ConfigurationError);
    expect(() =>
      loadEnv(apiEnvSchema, { ...validApiEnv, WEBHOOK_ENCRYPTION_KEYS: `k1:${key(1)}` }),
    ).toThrow(ConfigurationError);
  });

  it('refuses an active key id the ring does not contain', () => {
    expect(() =>
      loadEnv(apiEnvSchema, {
        ...validApiEnv,
        WEBHOOK_ENCRYPTION_ACTIVE_KID: 'k9',
        WEBHOOK_ENCRYPTION_KEYS: `k1:${key(1)}`,
      }),
    ).toThrow(/does not contain/);
  });

  it('refuses a key of the wrong length, naming the id and not the material', () => {
    expect.assertions(2);
    try {
      loadEnv(apiEnvSchema, {
        ...validApiEnv,
        WEBHOOK_ENCRYPTION_ACTIVE_KID: 'k1',
        WEBHOOK_ENCRYPTION_KEYS: `k1:${Buffer.alloc(16, 1).toString('base64')}`,
      });
    } catch (error) {
      const issues = (error as ConfigurationError).issues.join();
      expect(issues).toContain('k1');
      expect(issues).toContain('32 bytes');
    }
  });

  it('refuses a duplicate key id and a malformed entry', () => {
    expect(() =>
      loadEnv(apiEnvSchema, {
        ...validApiEnv,
        WEBHOOK_ENCRYPTION_ACTIVE_KID: 'k1',
        WEBHOOK_ENCRYPTION_KEYS: `k1:${key(1)},k1:${key(2)}`,
      }),
    ).toThrow(/twice/);
    expect(() =>
      loadEnv(apiEnvSchema, {
        ...validApiEnv,
        WEBHOOK_ENCRYPTION_ACTIVE_KID: 'k1',
        WEBHOOK_ENCRYPTION_KEYS: 'not-a-pair',
      }),
    ).toThrow(ConfigurationError);
  });

  it('refuses a port list that is not ports', () => {
    expect(() =>
      loadEnv(apiEnvSchema, { ...validApiEnv, WEBHOOK_ALLOWED_PORTS: '443,http' }),
    ).toThrow(/port numbers/);
  });
});

describe('loadEnv (web)', () => {
  it('defaults the public web configuration', () => {
    const env = loadEnv(webEnvSchema, {});
    expect(env.NEXT_PUBLIC_DEFAULT_LOCALE).toBe('en');
    expect(env.NEXT_PUBLIC_API_URL).toBe('http://localhost:4000');
  });

  it('rejects an unsupported locale', () => {
    expect(() => loadEnv(webEnvSchema, { NEXT_PUBLIC_DEFAULT_LOCALE: 'fr' })).toThrow();
  });
});

describe('config redaction', () => {
  it('flags sensitive keys', () => {
    expect(isSensitiveConfigKey('DATABASE_URL')).toBe(true);
    expect(isSensitiveConfigKey('STORAGE_SECRET_ACCESS_KEY')).toBe(true);
    // Phase 10 §82: a payment provider credential is a secret like any other,
    // and the pattern must already cover it rather than needing a new rule.
    expect(isSensitiveConfigKey('STRIPE_SECRET_KEY')).toBe(true);
    expect(isSensitiveConfigKey('STRIPE_WEBHOOK_SECRET')).toBe(true);
    expect(isSensitiveConfigKey('API_PORT')).toBe(false);
  });

  it('redacts sensitive values but keeps safe ones', () => {
    const redacted = redactConfig(loadEnv(apiEnvSchema, validApiEnv));
    expect(redacted.AUTH_MFA_SECRET_KEY).toBe('[REDACTED]');
    expect(redacted.DATABASE_URL).toBe('[REDACTED]');
    expect(redacted.STORAGE_SECRET_ACCESS_KEY).toBe('[REDACTED]');
    expect(redacted.API_PORT).toBe(4000);
    expect(
      redactConfig(
        loadEnv(apiEnvSchema, {
          ...validApiEnv,
          PAYMENTS_ENABLED: 'true',
          PAYMENT_PROVIDER: 'stripe',
          STRIPE_SECRET_KEY: `sk_test_${'d'.repeat(40)}`,
          STRIPE_WEBHOOK_SECRET: `whsec_${'d'.repeat(40)}`,
        }),
      ),
    ).toMatchObject({ STRIPE_SECRET_KEY: '[REDACTED]', STRIPE_WEBHOOK_SECRET: '[REDACTED]' });
    expect(JSON.stringify(redacted)).not.toContain('palcert:palcert');
  });
});

describe('the email settings root key (ADR-0146)', () => {
  const key = (fill: number) => Buffer.alloc(32, fill).toString('base64');

  it('is optional: without it PalCert boots as before', () => {
    const env = loadEnv(apiEnvSchema, validApiEnv);
    expect(env.EMAIL_SETTINGS_ENCRYPTION_KEYS).toBeUndefined();
    expect(env.EMAIL_SETTINGS_ENCRYPTION_ACTIVE_KID).toBeUndefined();
    expect(env.RESEND_API_BASE_URL).toBeUndefined();
  });

  it('treats blank values as absent', () => {
    const env = loadEnv(apiEnvSchema, {
      ...validApiEnv,
      EMAIL_SETTINGS_ENCRYPTION_ACTIVE_KID: '',
      EMAIL_SETTINGS_ENCRYPTION_KEYS: '',
    });
    expect(env.EMAIL_SETTINGS_ENCRYPTION_KEYS).toBeUndefined();
  });

  it('accepts a ring and refuses half a ring or a missing active key', () => {
    expect(
      loadEnv(apiEnvSchema, {
        ...validApiEnv,
        EMAIL_SETTINGS_ENCRYPTION_ACTIVE_KID: 'e2',
        EMAIL_SETTINGS_ENCRYPTION_KEYS: `e1:${key(1)},e2:${key(2)}`,
      }).EMAIL_SETTINGS_ENCRYPTION_ACTIVE_KID,
    ).toBe('e2');
    expect(() =>
      loadEnv(apiEnvSchema, { ...validApiEnv, EMAIL_SETTINGS_ENCRYPTION_KEYS: `e1:${key(1)}` }),
    ).toThrow(ConfigurationError);
    expect(() =>
      loadEnv(apiEnvSchema, {
        ...validApiEnv,
        EMAIL_SETTINGS_ENCRYPTION_ACTIVE_KID: 'e9',
        EMAIL_SETTINGS_ENCRYPTION_KEYS: `e1:${key(1)}`,
      }),
    ).toThrow(/does not contain/);
  });

  it('names the key id, never the material, when a key is malformed', () => {
    const material = Buffer.alloc(16, 7).toString('base64');
    try {
      loadEnv(apiEnvSchema, {
        ...validApiEnv,
        EMAIL_SETTINGS_ENCRYPTION_ACTIVE_KID: 'e1',
        EMAIL_SETTINGS_ENCRYPTION_KEYS: `e1:${material}`,
      });
      throw new Error('expected a configuration error');
    } catch (error) {
      const issues = (error as ConfigurationError).issues.join();
      expect(issues).toContain('e1');
      expect(issues).not.toContain(material);
    }
  });
});

describe('the payout destination key ring (ADR-0150)', () => {
  const key = (fill: number) => Buffer.alloc(32, fill).toString('base64');

  it('is optional and separate from the email key ring', () => {
    const env = loadEnv(apiEnvSchema, {
      ...validApiEnv,
      EMAIL_SETTINGS_ENCRYPTION_ACTIVE_KID: 'e1',
      EMAIL_SETTINGS_ENCRYPTION_KEYS: `e1:${key(1)}`,
    });
    expect(env.PAYOUT_DESTINATION_ENCRYPTION_KEYS).toBeUndefined();
    expect(env.PAYOUT_DESTINATION_ENCRYPTION_ACTIVE_KID).toBeUndefined();
  });

  it('accepts a ring and refuses half a ring, a missing active key or bad material', () => {
    expect(
      loadEnv(apiEnvSchema, {
        ...validApiEnv,
        PAYOUT_DESTINATION_ENCRYPTION_ACTIVE_KID: 'p2',
        PAYOUT_DESTINATION_ENCRYPTION_KEYS: `p1:${key(3)},p2:${key(4)}`,
      }).PAYOUT_DESTINATION_ENCRYPTION_ACTIVE_KID,
    ).toBe('p2');
    expect(() =>
      loadEnv(apiEnvSchema, {
        ...validApiEnv,
        PAYOUT_DESTINATION_ENCRYPTION_KEYS: `p1:${key(3)}`,
      }),
    ).toThrow(ConfigurationError);
    expect(() =>
      loadEnv(apiEnvSchema, {
        ...validApiEnv,
        PAYOUT_DESTINATION_ENCRYPTION_ACTIVE_KID: 'p9',
        PAYOUT_DESTINATION_ENCRYPTION_KEYS: `p1:${key(3)}`,
      }),
    ).toThrow(ConfigurationError);
    const material = Buffer.alloc(16, 9).toString('base64');
    try {
      loadEnv(apiEnvSchema, {
        ...validApiEnv,
        PAYOUT_DESTINATION_ENCRYPTION_ACTIVE_KID: 'p1',
        PAYOUT_DESTINATION_ENCRYPTION_KEYS: `p1:${material}`,
      });
      throw new Error('expected a configuration error');
    } catch (error) {
      expect((error as ConfigurationError).issues.join()).not.toContain(material);
    }
  });
});
