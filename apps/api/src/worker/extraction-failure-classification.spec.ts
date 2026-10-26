import { AIFailureKind, AIProviderError, isRetryableAIFailure } from '@palcert/contracts';
import {
  chunked,
  databaseFailureKind,
  isRetryableDatabaseFailure,
} from './rule-extraction-job.handler';

function prismaError(code: string, name = 'PrismaClientKnownRequestError'): Error {
  return Object.assign(new Error(`prisma ${code}`), { code, name, clientVersion: 'x' });
}

describe('classifying an extraction failure', () => {
  it('P2028 (transaction expired) is a database failure, never the AI provider', () => {
    const kind = databaseFailureKind(prismaError('P2028'));
    expect(kind).toBe('DATABASE_TRANSACTION_FAILED');
    expect(kind).not.toBe(AIFailureKind.UNKNOWN_PROVIDER_ERROR);
    expect(isRetryableDatabaseFailure(kind!)).toBe(true);
    // It is not mistaken for a retryable *provider* failure either.
    expect(isRetryableAIFailure(kind as AIFailureKind)).toBe(false);
  });

  it('P2034 (write conflict or deadlock) is a retryable transaction failure', () => {
    expect(databaseFailureKind(prismaError('P2034'))).toBe('DATABASE_TRANSACTION_FAILED');
  });

  it.each(['P1001', 'P1002', 'P1008', 'P1017'])('%s is the database being unavailable', (code) => {
    expect(databaseFailureKind(prismaError(code))).toBe('DATABASE_UNAVAILABLE');
  });

  it('an initialization error is the database being unavailable', () => {
    const error = Object.assign(new Error('cannot reach'), {
      name: 'PrismaClientInitializationError',
    });
    expect(databaseFailureKind(error)).toBe('DATABASE_UNAVAILABLE');
  });

  it('a constraint violation is not retried as if it were transient', () => {
    expect(databaseFailureKind(prismaError('P2002'))).toBeNull();
  });

  it('provider errors and plain errors are not database failures', () => {
    expect(
      databaseFailureKind(new AIProviderError(AIFailureKind.OVERLOADED, 'overloaded')),
    ).toBeNull();
    expect(databaseFailureKind(new Error('boom'))).toBeNull();
    expect(databaseFailureKind('P2028')).toBeNull();
    expect(databaseFailureKind(null)).toBeNull();
  });
});

describe('chunking bulk writes', () => {
  it('keeps every item once, in order, with its position in the whole', () => {
    const chunks = chunked(['a', 'b', 'c', 'd', 'e'], 2);
    expect(chunks.map((chunk) => chunk.map((entry) => entry.item))).toEqual([
      ['a', 'b'],
      ['c', 'd'],
      ['e'],
    ]);
    expect(chunks.flat().map((entry) => entry.index)).toEqual([0, 1, 2, 3, 4]);
  });

  it('produces nothing for nothing', () => {
    expect(chunked([], 250)).toEqual([]);
  });
});
