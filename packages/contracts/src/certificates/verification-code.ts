import { randomBytes } from 'node:crypto';
import { sha256Hex } from '../checks/report.js';

/**
 * The public verification code (§14, §15, §16).
 *
 * A certificate is verified by whoever holds it, because PalCert publishes no
 * directory and offers no search. The code is therefore the entire lookup key,
 * and it has to behave like a capability rather than an identifier: knowing
 * one certificate's code must say nothing about any other's.
 *
 * So it is 20 bytes from the system CSPRNG — 160 bits — and every one of those
 * bits survives into the printed form. That is worth stating plainly because
 * the obvious mistake is to pick a pretty length first and encode into it: 28
 * Base32 symbols carries 140 bits, silently discarding 20 bits of the entropy
 * that was generated. The representation is chosen to fit the bytes, never the
 * other way round.
 *
 * It is also a real Base32 encoding, not a character-picking loop. Selecting
 * symbols with `randomByte % alphabet.length` is the classic modulo-bias bug:
 * with a 32-symbol alphabet and 256 values it happens to divide evenly, but
 * the pattern is wrong the moment somebody changes the alphabet, and a
 * reviewer cannot tell a safe instance from an unsafe one at a glance.
 */

/**
 * Crockford's Base32 alphabet.
 *
 * Excludes I, L, O and U, so the symbols a person is most likely to mis-read
 * or mis-type are simply not in the set. Decoding maps the look-alikes back.
 */
const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

/** Bytes of entropy behind every certificate. */
export const VERIFICATION_CODE_BYTES = 20;

/** 20 bytes × 8 = 160 bits, and 160 / 5 = 32 symbols exactly. No remainder. */
export const VERIFICATION_CODE_SYMBOLS = 32;

/** What the certificate number is prefixed with, for recognition. */
export const CERTIFICATE_NUMBER_PREFIX = 'PC';

/** Symbols per group in the displayed form. Presentation only. */
const GROUP_SIZE = 8;

/** Encode exactly `bytes.length * 8` bits. Length must be a multiple of 5 bits. */
function base32Encode(bytes: Uint8Array): string {
  if ((bytes.length * 8) % 5 !== 0) {
    throw new Error('verification code bytes must encode to whole Base32 symbols');
  }

  let symbols = '';
  let buffer = 0;
  let bits = 0;

  for (const byte of bytes) {
    buffer = (buffer << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      symbols += ALPHABET[(buffer >>> bits) & 0b11111];
    }
  }

  return symbols;
}

/** The inverse, so a test can prove the printed form carries every byte. */
export function base32Decode(symbols: string): Uint8Array {
  if ((symbols.length * 5) % 8 !== 0) {
    throw new Error('verification code symbols must decode to whole bytes');
  }

  const bytes = new Uint8Array((symbols.length * 5) / 8);
  let buffer = 0;
  let bits = 0;
  let index = 0;

  for (const symbol of symbols) {
    const value = ALPHABET.indexOf(symbol);
    if (value < 0) throw new Error(`not a Crockford Base32 symbol: ${symbol}`);
    buffer = (buffer << 5) | value;
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      bytes[index++] = (buffer >>> bits) & 0xff;
    }
  }

  return bytes;
}

/**
 * A fresh verification code, in its canonical form.
 *
 * Canonical means: no prefix, no separators, upper case. That is what is
 * hashed and what round-trips; the displayed certificate number is a
 * presentation of it.
 */
export function generateVerificationCode(): string {
  return base32Encode(randomBytes(VERIFICATION_CODE_BYTES));
}

/**
 * Normalize whatever a person typed or a scanner produced.
 *
 * Accepts the prefix, hyphens, spaces and lower case, and maps Crockford's
 * documented look-alikes — I and L to 1, O to 0 — because somebody reading a
 * printed certificate should not be defeated by a font. Rejects anything else
 * rather than guessing, and returns null so a caller answers "not found"
 * instead of raising on hostile input.
 *
 * **The prefix is decided by length, never by the first two characters.**
 *
 * `P` and `C` are both ordinary symbols of the alphabet, so roughly one code
 * in 1024 begins with `PC` — and an earlier version of this function stripped
 * those two as though they were the display prefix, leaving 30 symbols and
 * rejecting a perfectly valid code. Every certificate whose code happened to
 * start `PC` would have been unverifiable for its whole life, and the bug
 * would have looked like a typo to whoever hit it.
 *
 * The two representations are unambiguous by length, so that is what decides:
 *
 *   32 compacted symbols  → a bare canonical code, prefix or no prefix in it
 *   34 starting with `PC` → the display form, and only then are two removed
 *
 * Anything else is invalid.
 */
export function canonicalizeVerificationCode(input: string): string | null {
  const compact = input.trim().toUpperCase().replace(/[-\s]/g, '');

  let body: string;
  if (compact.length === VERIFICATION_CODE_SYMBOLS) {
    // A bare code. It may legitimately begin with the letters of the prefix,
    // and those letters are part of it.
    body = compact;
  } else if (
    compact.length === CERTIFICATE_NUMBER_PREFIX.length + VERIFICATION_CODE_SYMBOLS &&
    compact.startsWith(CERTIFICATE_NUMBER_PREFIX)
  ) {
    body = compact.slice(CERTIFICATE_NUMBER_PREFIX.length);
  } else {
    return null;
  }

  // Look-alikes last, so the decision above is made on what was actually
  // typed rather than on a rewritten string.
  const normalized = body.replace(/[IL]/g, '1').replace(/O/g, '0');
  for (const symbol of normalized) {
    if (!ALPHABET.includes(symbol)) return null;
  }
  return normalized;
}

/** The human-facing certificate number: `PC-XXXXXXXX-…`, 32 symbols in four groups. */
export function formatCertificateNumber(canonicalCode: string): string {
  const groups: string[] = [];
  for (let at = 0; at < canonicalCode.length; at += GROUP_SIZE) {
    groups.push(canonicalCode.slice(at, at + GROUP_SIZE));
  }
  return `${CERTIFICATE_NUMBER_PREFIX}-${groups.join('-')}`;
}

/**
 * What the database stores and looks up by (§2 of the Phase 15 corrections).
 *
 * The plaintext code is never a column. It lives where the holder needs it —
 * the immutable claim artifact, the PDF, the QR — and the row carries only its
 * digest, so a database read that should not have happened still does not hand
 * somebody a working verification capability for every certificate at once.
 */
export function verificationCodeHash(canonicalCode: string): string {
  return sha256Hex(canonicalCode);
}
