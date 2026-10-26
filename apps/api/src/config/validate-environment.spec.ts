import { ConfigurationError } from '@palcert/config';
import { validateEnvironment } from './validate-environment';

const validEnv = {
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
} as NodeJS.ProcessEnv;

describe('validateEnvironment', () => {
  it('returns the validated environment', () => {
    expect(validateEnvironment(validEnv).API_PORT).toBe(4000);
  });

  it('throws ConfigurationError listing every problem', () => {
    expect.assertions(2);
    try {
      // Two independent problems, so the error has to carry both rather than
      // stopping at the first: an operator fixing configuration one round-trip
      // at a time is an operator who restarts four times.
      validateEnvironment({ ...validEnv, DATABASE_URL: 'nope', STORAGE_ENDPOINT: 'nope' });
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigurationError);
      expect((error as ConfigurationError).issues.length).toBeGreaterThanOrEqual(2);
    }
  });
});
