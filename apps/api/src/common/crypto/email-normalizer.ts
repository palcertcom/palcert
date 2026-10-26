/**
 * Email normalization policy.
 *
 * Uniqueness is enforced on the normalized form, so this function defines who
 * counts as "the same account". The policy is deliberately conservative:
 *
 *  - Trim surrounding whitespace (paste artifacts).
 *  - Lowercase the domain: DNS is case-insensitive, always safe.
 *  - Lowercase the local part: RFC 5321 permits case-sensitive local parts, but
 *    no mainstream provider implements them, and treating `Ali@x.com` and
 *    `ali@x.com` as two accounts causes far more support pain and account
 *    confusion than the theoretical correctness is worth.
 *  - Apply Unicode NFKC so visually identical addresses collapse to one form
 *    and cannot be used to register a near-duplicate of an existing account.
 *
 * Deliberately NOT done: stripping Gmail dots or `+tag` suffixes. Those are
 * provider-specific, change over time, and would silently merge addresses the
 * user considers distinct.
 */
export function normalizeEmail(email: string): string {
  const trimmed = email.trim().normalize('NFKC');
  const separator = trimmed.lastIndexOf('@');
  if (separator <= 0) {
    // Not a valid address; validation rejects it. Return a stable form so the
    // caller still performs identical work (constant-behaviour login).
    return trimmed.toLowerCase();
  }
  const local = trimmed.slice(0, separator);
  const domain = trimmed.slice(separator + 1);
  return `${local.toLowerCase()}@${domain.toLowerCase()}`;
}
