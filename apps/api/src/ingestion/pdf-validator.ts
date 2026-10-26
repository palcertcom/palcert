import { ContentRejectedError } from './errors';

/**
 * Enough PDF structure to admit a file for ingestion (§15) — not analysis.
 *
 * A PDF opens with a version header and closes with a cross-reference
 * pointer and an end-of-file marker. A file with the right first bytes and
 * nothing else is not a document PalCert can later read, so it is refused
 * now, with a code the author can act on. Page-level inspection is Phase 13.
 */
export function validatePdfStructure(head: Buffer, tail: Buffer): { readonly version: string } {
  const header = /^%PDF-(\d\.\d)/.exec(head.subarray(0, 16).toString('latin1'));
  if (header === null) {
    throw new ContentRejectedError('FILE_CONTAINER_INVALID', 'missing pdf version header');
  }
  const version = header[1]!;
  if (!/^(1\.[0-7]|2\.0)$/.test(version)) {
    throw new ContentRejectedError('FILE_CONTAINER_INVALID', `unsupported pdf version ${version}`);
  }

  const trailer = tail.toString('latin1');
  if (!trailer.includes('%%EOF')) {
    throw new ContentRejectedError('FILE_CONTAINER_INVALID', 'missing %%EOF marker');
  }
  if (!trailer.includes('startxref')) {
    throw new ContentRejectedError('FILE_CONTAINER_INVALID', 'missing startxref');
  }
  return { version };
}
