import type { DocumentFailureCode, DocumentRejectionCode } from '@palcert/contracts';
import { ObjectStorageUnavailableError } from '../infrastructure/storage/object-storage.port';
import { ContentRejectedError, TransientIngestError } from './errors';

export type FailureClassification =
  | {
      readonly kind: 'rejected';
      readonly code: DocumentRejectionCode;
      readonly detail: string;
      readonly scanSignature?: string;
      readonly scanEngine?: string;
    }
  | { readonly kind: 'transient'; readonly code: DocumentFailureCode; readonly detail: string };

/**
 * Decide what an error means for the version and for the job (§59).
 *
 * A rejection is final and is stored on the version; the job has *succeeded*
 * at its task, which was to decide. Everything else is transient and spends
 * an attempt — including errors nobody anticipated, because "unknown" is not
 * a reason to tell an author their document is bad.
 */
export function classifyFailure(error: unknown): FailureClassification {
  if (error instanceof ContentRejectedError) {
    return {
      kind: 'rejected',
      code: error.code,
      detail: error.detail,
      ...(error.extra.scanSignature !== undefined
        ? { scanSignature: error.extra.scanSignature }
        : {}),
      ...(error.extra.scanEngine !== undefined ? { scanEngine: error.extra.scanEngine } : {}),
    };
  }
  if (error instanceof TransientIngestError) {
    return { kind: 'transient', code: error.code, detail: error.detail };
  }
  if (error instanceof ObjectStorageUnavailableError) {
    return { kind: 'transient', code: 'STORAGE_UNAVAILABLE', detail: error.message };
  }
  const message = error instanceof Error ? error.message : String(error);
  if (/timeout|timed out/i.test(message)) {
    return { kind: 'transient', code: 'PROCESSING_TIMEOUT', detail: message.slice(0, 200) };
  }
  return { kind: 'transient', code: 'WORKER_ERROR', detail: message.slice(0, 200) };
}
