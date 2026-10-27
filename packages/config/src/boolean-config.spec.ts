import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { apiEnvSchema } from './env.schema.js';
import { ConfigurationError, loadEnv } from './load-env.js';

/**
 * Every boolean in the production configuration layer, against every spelling
 * (Phase 20 Checkpoint 7).
 *
 * Checkpoint 20.2 found `AI_ENABLED` declared as `z.coerce.boolean()`. Zod's
 * coercion runs the string through JavaScript's `Boolean`, where every
 * non-empty string is truthy — so `AI_ENABLED=false` meant *enabled*. Nobody
 * noticed, because a second rule then demanded an Anthropic key and every
 * environment had one: the flag was wrong and a different guard hid the
 * symptom.
 *
 * The class of defect is what matters. A security-sensitive switch that turns
 * **on** because someone wrote `no`, `off`, `disabled` or `FALSE` is a switch
 * that silently does the opposite of what the deployment asked for, and the
 * operator has no way to find out — there is no error, just the wrong
 * behaviour.
 *
 * So this does not test one field. It reads the schema source, finds every
 * field declared with `booleanFromEnv`, and puts each through the same seven
 * cases. A boolean added later is covered the day it is added; a boolean
 * declared some other way fails the guard below, which is the point.
 */

const SCHEMA_SOURCE = readFileSync(
  path.join(path.dirname(fileURLToPath(import.meta.url)), 'env.schema.ts'),
  'utf8',
);

/** Fields declared with the strict parser, and the default each one carries. */
const booleanFields: ReadonlyArray<{ name: string; fallback: boolean }> = [
  ...SCHEMA_SOURCE.matchAll(
    /^\s*([A-Z][A-Z0-9_]+):\s*booleanFromEnv\.prefault\('(true|false)'\)/gm,
  ),
].map((match) => ({ name: match[1], fallback: match[2] === 'true' }));

/** Anything boolean-shaped that is *not* declared with the strict parser. */
const suspectDeclarations = [
  ...SCHEMA_SOURCE.matchAll(/^\s*([A-Z][A-Z0-9_]+):\s*(z\.coerce\.boolean|z\.boolean)/gm),
].map((match) => match[1]);

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

/**
 * Some booleans have cross-field rules — `AI_ENABLED=true` demands a provider
 * credential, `PAYMENTS_ENABLED=true` demands one too. Those rules are
 * correct and tested elsewhere; here they would just get in the way of
 * measuring the parse, so the companions travel with the flag.
 */
const COMPANIONS: Readonly<Record<string, Record<string, string>>> = {
  AI_ENABLED: { AI_PRIMARY_PROVIDER: 'fake' },
  PAYMENTS_ENABLED: { PAYMENT_PROVIDER: 'fake' },
};

function parse(name: string, value: string | undefined): Record<string, unknown> {
  const source: Record<string, string> = { ...validApiEnv, ...(COMPANIONS[name] ?? {}) };
  if (value !== undefined) source[name] = value;
  return loadEnv(apiEnvSchema, source) as Record<string, unknown>;
}

describe('boolean configuration parsing', () => {
  it('finds the booleans to test, so an empty sweep cannot pass', () => {
    // Without this the whole file would pass vacuously the day the regex stops
    // matching — which is exactly how a check quietly stops checking.
    expect(booleanFields.length).toBeGreaterThanOrEqual(9);
  });

  it('declares no boolean with a coercing parser', () => {
    // The original defect, as a standing rule rather than a one-off fix.
    expect(suspectDeclarations).toEqual([]);
  });

  describe.each(booleanFields)('$name', ({ name, fallback }) => {
    it('reads "true" and "1" as true', () => {
      expect(parse(name, 'true')[name]).toBe(true);
      expect(parse(name, '1')[name]).toBe(true);
    });

    it('reads "false" and "0" as false', () => {
      expect(parse(name, 'false')[name]).toBe(false);
      expect(parse(name, '0')[name]).toBe(false);
    });

    it('falls back to its declared default when absent', () => {
      expect(parse(name, undefined)[name]).toBe(fallback);
    });

    it('refuses an empty value rather than guessing', () => {
      // A container that sets `ENV X=${X}` with no build argument produces an
      // empty string, which is *present*. Guessing at it is how this class of
      // bug starts.
      expect(() => parse(name, '')).toThrow(ConfigurationError);
    });

    it.each(['no', 'off', 'yes', 'on', 'disabled', 'enabled', 'TRUE', 'False', '2', ' true'])(
      'refuses the malformed value %j instead of turning on',
      (value) => {
        let parsed: Record<string, unknown> | undefined;
        try {
          parsed = parse(name, value);
        } catch (error) {
          expect(error).toBeInstanceOf(ConfigurationError);
          return;
        }
        // If a future schema ever chose to accept one of these, the one
        // outcome that must never happen is silently becoming `true` — the
        // exact shape of the 20.2 defect. Asserting it here means a
        // permissive parser cannot slip in unnoticed.
        expect(parsed[name]).toBe(false);
      },
    );
  });

  it('names an unparseable boolean in the error, without echoing the value', () => {
    // The value may be the wrong thing pasted from a password manager. An
    // operator needs the field name; nobody needs the contents in a log.
    try {
      parse('API_DOCS_ENABLED', 'sk_live_not_actually_a_boolean');
      throw new Error('expected a configuration error');
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigurationError);
      const message = (error as ConfigurationError).message;
      expect(message).toContain('API_DOCS_ENABLED');
      expect(message).not.toContain('sk_live_not_actually_a_boolean');
    }
  });
});
