import { afterEach, describe, expect, it } from 'vitest';
import { metricsEnabled, metricsToken } from './registry';

/**
 * The web tier's two direct environment reads (Phase 20 Checkpoint 7).
 *
 * The Next.js server has no startup hook where the shared configuration schema
 * could run, so these two variables are read from `process.env` at the point
 * of use. That is a documented exception, not an oversight — but it means the
 * parsing has to be as strict here as the schema is everywhere else, and it
 * was not: `metricsEnabled` was `X !== 'false' && X !== '0'`, which accepts
 * every other string. A deployment that wrote `METRICS_ENABLED=no` meaning
 * *off* got telemetry left on and no error to say so.
 */
describe('web metrics configuration', () => {
  const original = { ...process.env };

  afterEach(() => {
    process.env = { ...original };
  });

  it('is on when nothing is set', () => {
    delete process.env.METRICS_ENABLED;
    expect(metricsEnabled()).toBe(true);
  });

  it.each(['true', '1'])('is on for %j', (value) => {
    process.env.METRICS_ENABLED = value;
    expect(metricsEnabled()).toBe(true);
  });

  it.each(['false', '0'])('is off for %j', (value) => {
    process.env.METRICS_ENABLED = value;
    expect(metricsEnabled()).toBe(false);
  });

  it.each(['no', 'off', 'disabled', 'FALSE', 'yes', 'on', '', ' '])(
    'is off for the unrecognized value %j rather than staying on',
    (value) => {
      // The direction matters. Someone who put a value in this variable was
      // trying to control an exposure surface; when the instruction cannot be
      // read, "do not expose" is the only safe way to read it.
      process.env.METRICS_ENABLED = value;
      expect(metricsEnabled()).toBe(false);
    },
  );

  describe('the scrape token', () => {
    it('is absent when unset or empty', () => {
      delete process.env.METRICS_TOKEN;
      expect(metricsToken()).toBeUndefined();
      process.env.METRICS_TOKEN = '';
      expect(metricsToken()).toBeUndefined();
    });

    it('is used verbatim when set', () => {
      process.env.METRICS_TOKEN = 'a-token-of-at-least-thirty-two-characters';
      expect(metricsToken()).toBe('a-token-of-at-least-thirty-two-characters');
    });
  });
});
