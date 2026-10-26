import { AppError, PalCertErrorCode } from '@palcert/contracts';
import type { Request } from 'express';
import { requestIdOf } from '../../auth/authenticated-request';
import type { RequestContext } from '../manual-topup-support';

const IDEMPOTENCY_KEY_MAX_LENGTH = 128;

export function contextOf(request: Request): RequestContext {
  return { requestId: requestIdOf(request), ipAddress: request.ip ?? null };
}

/** The `Idempotency-Key` header, validated the way every other PalCert route does. */
export function idempotencyKeyOf(request: Request): string | undefined {
  const header = request.headers['idempotency-key'];
  if (typeof header !== 'string') return undefined;
  const trimmed = header.trim();
  if (trimmed.length === 0) return undefined;
  if (trimmed.length > IDEMPOTENCY_KEY_MAX_LENGTH || !/^[\x20-\x7e]+$/.test(trimmed)) {
    throw new AppError(PalCertErrorCode.VALIDATION_FAILED, {
      message: 'Idempotency-Key must be 1 to 128 printable ASCII characters.',
      details: { field: 'Idempotency-Key' },
    });
  }
  return trimmed;
}
