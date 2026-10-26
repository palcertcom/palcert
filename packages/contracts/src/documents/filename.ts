/**
 * Original filenames are user-facing metadata and nothing more.
 *
 * A filename never becomes a path, a key, a bucket, a temp file or a command
 * argument (§19). What it can still do is reach a browser through a response
 * header or an HTML page, so it is normalized once here, on the way in, and
 * encoded once, on the way out.
 */

/** Longest filename PalCert keeps, in code points. */
export const MAX_FILENAME_LENGTH = 255;

/* eslint-disable-next-line no-control-regex -- removing control characters is the point */
const CONTROL_OR_NUL = /[\u0000-\u001f\u007f-\u009f]/g;
const PATH_SEPARATORS = /[\\/]/g;
const WHITESPACE_RUN = /\s+/g;
/** Bidi and zero-width controls that can disguise an extension ("exe.pdf" shown as "fdp.exe"). */
const FORMAT_CONTROLS = /[\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]/g;
/** Characters a Windows client cannot store; stripped so a download saves cleanly. */
const RESERVED_PUNCTUATION = /[<>:"|?*]/g;

/**
 * Normalize a filename for storage and display.
 *
 * - Unicode NFC, so an Arabic title compares and renders consistently.
 * - Control characters, NUL, bidi overrides and zero-width characters removed.
 * - Path separators replaced, so `../../etc/passwd.pdf` is a name, not a path.
 * - Leading dots and trailing dots/spaces removed (hidden files, Windows quirks).
 * - Whitespace collapsed, length bounded, and never empty.
 *
 * Unicode letters are preserved: a thesis titled in Arabic keeps its name.
 */
export function sanitizeOriginalFilename(input: string): string {
  let name = input
    .normalize('NFC')
    .replace(CONTROL_OR_NUL, '')
    .replace(FORMAT_CONTROLS, '')
    .replace(PATH_SEPARATORS, '_')
    .replace(RESERVED_PUNCTUATION, '_')
    .replace(WHITESPACE_RUN, ' ')
    .trim()
    .replace(/^[. ]+/, '')
    .replace(/[. ]+$/, '')
    // "report .pdf" → "report.pdf": whitespace beside the extension dot is a
    // classic way to make a name look like something else in a listing.
    .replace(/ +(\.[^. ]+)$/, '$1');

  if (name.length === 0) return 'document';

  const codePoints = Array.from(name);
  if (codePoints.length > MAX_FILENAME_LENGTH) {
    // Keep the extension, which is what tells a download what it is.
    const extension = extensionOf(name);
    const keep = MAX_FILENAME_LENGTH - Array.from(extension).length;
    name =
      codePoints
        .slice(0, keep)
        .join('')
        .replace(/[. ]+$/, '') + extension;
  }
  return name;
}

/** The lower-cased extension including the dot, or '' when there is none. */
export function extensionOf(filename: string): string {
  const index = filename.lastIndexOf('.');
  if (index <= 0 || index === filename.length - 1) return '';
  return filename.slice(index).toLowerCase();
}

/**
 * The `Content-Disposition` value for a download.
 *
 * RFC 6266 / RFC 8187: an ASCII `filename` fallback for old clients, and a
 * UTF-8 `filename*` that modern browsers prefer, so an Arabic filename
 * survives. Quotes, backslashes and line breaks cannot reach the header —
 * header injection through a filename is exactly the attack this guards.
 */
export function contentDispositionAttachment(filename: string): string {
  const safe = sanitizeOriginalFilename(filename);
  const ascii = safe
    .replace(/[^\x20-\x7e]/g, '_')
    .replace(/["\\]/g, '_')
    .replace(/[\r\n]/g, '');
  const encoded = encodeRFC8187(safe);
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encoded}`;
}

/** Percent-encode everything outside RFC 8187 `attr-char`. */
export function encodeRFC8187(value: string): string {
  return Array.from(Buffer.from(value, 'utf8'))
    .map((byte) => {
      const char = String.fromCharCode(byte);
      return /[A-Za-z0-9!#$&+\-.^_`|~]/.test(char)
        ? char
        : `%${byte.toString(16).toUpperCase().padStart(2, '0')}`;
    })
    .join('');
}
