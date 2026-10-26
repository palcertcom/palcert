import { describe, expect, it } from 'vitest';
import { AppError } from './app-error.js';
import { ALL_ERROR_CODES, PalCertErrorCode } from './error-codes.js';
import { defaultHttpStatusFor } from './app-error.js';

describe('AppError', () => {
  it('defaults its message to the error code', () => {
    const error = new AppError(PalCertErrorCode.INSUFFICIENT_BALANCE);
    expect(error.message).toBe('INSUFFICIENT_BALANCE');
    expect(error.httpStatus).toBe(402);
  });

  it('never leaks internal context or stack in the public body', () => {
    const error = new AppError(PalCertErrorCode.CHECK_FAILED, {
      message: 'Check could not be completed',
      details: { checkId: 'chk_1' },
      internalContext: { dbPassword: 'super-secret', query: 'SELECT 1' },
      cause: new Error('connection reset'),
    });

    const body = error.toPublicJSON('req_123');
    const serialized = JSON.stringify(body);

    expect(body.error.code).toBe('CHECK_FAILED');
    expect(body.error.details).toEqual({ checkId: 'chk_1' });
    expect(body.error.requestId).toBe('req_123');
    expect(serialized).not.toContain('super-secret');
    expect(serialized).not.toContain('connection reset');
    expect(serialized).not.toContain('stack');
  });

  it('preserves the cause for internal logging', () => {
    const cause = new Error('root cause');
    const error = new AppError(PalCertErrorCode.INTERNAL_ERROR, { cause });
    expect(error.cause).toBe(cause);
  });

  it('identifies AppError instances', () => {
    expect(AppError.isAppError(new AppError(PalCertErrorCode.NOT_FOUND))).toBe(true);
    expect(AppError.isAppError(new Error('nope'))).toBe(false);
  });

  it('maps every declared error code to a valid HTTP status', () => {
    expect(ALL_ERROR_CODES.length).toBeGreaterThan(0);
    for (const code of ALL_ERROR_CODES) {
      const status = defaultHttpStatusFor(code);
      expect(status, `missing status for ${code}`).toBeGreaterThanOrEqual(400);
      expect(status).toBeLessThan(600);
    }
  });

  it('keeps error codes unique and uppercase snake case', () => {
    const unique = new Set(ALL_ERROR_CODES);
    expect(unique.size).toBe(ALL_ERROR_CODES.length);
    for (const code of ALL_ERROR_CODES) {
      expect(code).toMatch(/^[A-Z][A-Z0-9_]*$/);
    }
  });
});
