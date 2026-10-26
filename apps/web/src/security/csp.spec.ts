import { describe, expect, it } from 'vitest';
import { contentSecurityPolicy } from './csp.mjs';

/**
 * The policy's shape, asserted rather than eyeballed (Phase 20 Checkpoint 7).
 *
 * That the application still *works* under it is a different question, and one
 * a unit test cannot answer — it is answered by loading the built application
 * through the release proxy in a real browser and requiring zero CSP
 * violations. These assertions exist so that a later edit cannot quietly
 * loosen the policy without someone noticing.
 */
describe('contentSecurityPolicy', () => {
  const policy = contentSecurityPolicy();
  const directive = (name: string): string =>
    policy
      .split('; ')
      .find((entry) => entry.startsWith(`${name} `))
      ?.slice(name.length + 1) ?? '';

  it('denies everything it does not explicitly allow', () => {
    expect(directive('default-src')).toBe("'none'");
  });

  it('does not pretend to carry a nonce it cannot enforce', () => {
    // A browser ignores a nonce when `'unsafe-inline'` is present, so putting
    // one in the header would make the policy *look* stronger than it is —
    // which is worse than the weaker policy, because the next person reads
    // the header and believes it.
    expect(policy).not.toContain('nonce-');
  });

  it('never allows eval in a production build', () => {
    // `NODE_ENV` is `test` here, which is not `development`, so this exercises
    // the production branch.
    expect(policy).not.toContain('unsafe-eval');
  });

  it('allows inline script, which is the documented v1 compromise', () => {
    // Not what the first version did. A nonce-based policy was built and then
    // measured in a browser: the two dynamic routes were perfect and every
    // prerendered route refused all seventeen of its own scripts, because a
    // per-request nonce cannot be written into HTML generated at build time.
    // Asserted explicitly so that this stays a recorded decision (P-015)
    // rather than something that quietly became permanent.
    expect(directive('script-src')).toBe("'self' 'unsafe-inline'");
  });

  it('refuses framing, plugins, base retargeting and foreign form posts', () => {
    expect(directive('frame-ancestors')).toBe("'none'");
    expect(directive('object-src')).toBe("'none'");
    expect(directive('base-uri')).toBe("'none'");
    expect(directive('form-action')).toBe("'self'");
  });

  it('allows local blob images for previews, and still no plugins or frames', () => {
    expect(directive('img-src')).toBe("'self' data: blob:");
    expect(directive('object-src')).toBe("'none'");
    expect(directive('frame-src')).toBe("'none'");
  });

  it('permits inline style', () => {
    expect(directive('style-src')).toBe("'self' 'unsafe-inline'");
  });

  it('keeps the browser talking to its own origin', () => {
    // With no separate API origin configured — the release topology — the
    // only place the page may call is itself.
    expect(directive('connect-src')).toBe("'self'");
  });

  it('upgrades insecure subresource requests in production', () => {
    expect(policy).toContain('upgrade-insecure-requests');
  });
});
