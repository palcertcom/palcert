import {
  AppError,
  PalCertErrorCode,
  containsControlCharacters,
  containsMarkup,
} from '@palcert/contracts';

/**
 * Refuse author-supplied text that carries markup or invisible characters.
 *
 * Standard and document-type text is rendered in the web app, in generated
 * reports and later in PDFs. Rather than relying on every one of those sinks to
 * escape correctly — a discipline that fails exactly once and then keeps
 * failing — the value never becomes dangerous in the first place.
 *
 * Refusing rather than stripping is deliberate: silently removing part of what
 * someone wrote, in a document that other people must comply with, is worse
 * than telling them it is not allowed.
 *
 * The same two predicates back rule validation in `@palcert/contracts`, so the
 * rule builder and these endpoints agree about what "plain text" means.
 */
export function assertPlainText(field: string, value: string | null | undefined): void {
  if (value === null || value === undefined || value === '') return;

  if (containsMarkup(value)) {
    throw new AppError(PalCertErrorCode.VALIDATION_FAILED, {
      message: `${field} must be plain text. Remove any HTML or angle brackets.`,
      details: { field, reason: 'MARKUP_NOT_ALLOWED' },
    });
  }

  if (containsControlCharacters(value)) {
    throw new AppError(PalCertErrorCode.VALIDATION_FAILED, {
      message: `${field} contains characters that are not allowed.`,
      details: { field, reason: 'CONTROL_CHARACTERS' },
    });
  }
}
