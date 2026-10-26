import type { DocumentFailureCode, DocumentRejectionCode } from '@palcert/contracts';

/**
 * The content is unacceptable. Final; never retried (§11).
 *
 * `detail` is operator-facing and safe: a code path name, a limit that was
 * exceeded, an entry name that was malformed — never document content.
 */
export class ContentRejectedError extends Error {
  constructor(
    readonly code: DocumentRejectionCode,
    readonly detail: string,
    readonly extra: { readonly scanSignature?: string; readonly scanEngine?: string } = {},
  ) {
    super(`${code}: ${detail}`);
    this.name = 'ContentRejectedError';
  }
}

/** PalCert could not finish. Retried by policy; never the document's fault. */
export class TransientIngestError extends Error {
  constructor(
    readonly code: DocumentFailureCode,
    readonly detail: string,
    cause?: unknown,
  ) {
    super(`${code}: ${detail}`);
    this.name = 'TransientIngestError';
    this.cause = cause;
  }
}
