import { describe, expect, it } from 'vitest';
import { buildPrismaClientOptions } from './prisma-client.js';

const DATABASE_URL = 'postgresql://palcert:palcert@localhost:5432/palcert';

describe('buildPrismaClientOptions', () => {
  it('targets the configured database', () => {
    const options = buildPrismaClientOptions({ databaseUrl: DATABASE_URL });
    expect(options.datasources?.db?.url).toBe(DATABASE_URL);
  });

  it('does not log queries by default — query text can contain customer data', () => {
    const options = buildPrismaClientOptions({ databaseUrl: DATABASE_URL });
    expect(options.log).toEqual(['warn', 'error']);
    expect(options.log).not.toContain('query');
  });

  it('logs queries only when explicitly opted in', () => {
    const options = buildPrismaClientOptions({ databaseUrl: DATABASE_URL, logQueries: true });
    expect(options.log).toContain('query');
  });
});
