// Shared configuration for the PalCert load scenarios (Phase 20 Checkpoint 6).
//
// Everything a scenario needs to reach an environment comes from here, so a
// run against staging and a run against a laptop differ by environment
// variables rather than by edited scenario files.

/** The ingress base URL. Scenarios always go through the proxy, as a client does. */
export const BASE_URL = __ENV.PALCERT_BASE_URL || 'https://127.0.0.1:8443';

/**
 * The product API's prefix and version.
 *
 * Both are needed: routes are served at `/api/v1/…` while Nest's startup log
 * prints them without the version segment. Checkpoint 20.5 lost an afternoon
 * to a smoke check that probed the unversioned path, got a 404, and reported
 * it as the endpoint correctly rejecting an unknown certificate.
 */
export const API = `${BASE_URL}/api/${__ENV.PALCERT_API_VERSION || 'v1'}`;

/**
 * A verification code that resolves in the target environment.
 *
 * Supplied by `perf/seed-load-fixture.mjs`, which reads it from the drill
 * capability file rather than inventing it — a certificate's code cannot be
 * derived from the database, and repointing one is refused by a schema guard.
 */
export const VALID_CODE = __ENV.PALCERT_VALID_CODE || '';

/**
 * Codes that resolve to nothing.
 *
 * Well-formed but absent, so they exercise the same canonicalization and the
 * same indexed lookup as a real code and differ only in the outcome. A
 * malformed string would be rejected before the query and would measure
 * validation instead.
 */
export function missCode(index) {
  const alphabet = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
  let body = '';
  let value = index;
  for (let position = 0; position < 32; position += 1) {
    body += alphabet[(value + position * 7) % alphabet.length];
    value = (value * 31 + 17) % 1048576;
  }
  return `PC${body}`;
}

/**
 * TLS verification is off because the rehearsal stack presents the internal
 * certificate the `certs` job issues, which no public root signs. It says
 * nothing about production, where the proxy presents a real certificate.
 */
export const INSECURE = { insecureSkipTLSVerify: true };
