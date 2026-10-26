/**
 * Organization slug policy (§24).
 *
 * The slug is navigation and presentation only — never a security boundary.
 * Every authorization decision keys on the organization id, so a slug collision
 * or a future rename can never grant access.
 *
 * Normalization: NFKC, lowercased, non-alphanumerics collapsed to single
 * hyphens, trimmed to 3-63 characters. Uniqueness is enforced case-insensitively
 * by a database index on `LOWER(slug)`.
 *
 * Renames are deliberately NOT supported in Phase 2. Supporting them properly
 * means a redirect history table and a policy for reclaiming abandoned slugs;
 * shipping renames without that would leave dead links and allow one
 * organization to claim another's former identity. Deferred to a later phase.
 */
const RESERVED_SLUGS = new Set([
  // Route collisions.
  'api',
  'admin',
  'auth',
  'login',
  'logout',
  'register',
  'organizations',
  'users',
  'settings',
  'verify',
  'health',
  'docs',
  'static',
  'assets',
  'public',
  // Brand and future product surfaces.
  'palcert',
  'support',
  'help',
  'billing',
  'certificates',
  'standards',
  'documents',
  'checks',
  'reports',
  'smartfix',
  // Locale segments.
  'en',
  'ar',
]);

export const SLUG_MIN_LENGTH = 3;
export const SLUG_MAX_LENGTH = 63;

export function normalizeSlug(input: string): string {
  return input
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, SLUG_MAX_LENGTH)
    .replace(/-+$/g, '');
}

export function isReservedSlug(slug: string): boolean {
  return RESERVED_SLUGS.has(slug);
}

export function isValidSlug(slug: string): boolean {
  return (
    slug.length >= SLUG_MIN_LENGTH &&
    slug.length <= SLUG_MAX_LENGTH &&
    /^[a-z0-9]+(-[a-z0-9]+)*$/.test(slug) &&
    !isReservedSlug(slug)
  );
}

/**
 * Derive a candidate slug from a display name.
 *
 * Falls back to a generic stem when the name yields nothing usable — an Arabic
 * or Chinese organization name normalizes to an empty string under an
 * ASCII-only slug policy, and that must produce a working organization rather
 * than a validation dead end.
 */
export function slugCandidateFromName(displayName: string): string {
  const derived = normalizeSlug(displayName);
  if (derived.length >= SLUG_MIN_LENGTH && !isReservedSlug(derived)) return derived;
  return 'org';
}
