import { ROLE_DEFINITIONS } from '@palcert/contracts/auth/roles';

/**
 * Role → permission mapping for presentation only, taken from the server's own
 * catalogue rather than copied beside it (Phase 20 Checkpoint 8).
 *
 * This used to be a hand-maintained duplicate of `ROLE_DEFINITIONS`, with a
 * comment reasoning that drift was harmless: "the consequence is a button that
 * returns 403 — not a security hole, because authorization lives on the
 * server". Authorization does live on the server, and that part was right. The
 * direction of the drift was not. A duplicate that is *missing* entries does
 * not produce a button that 403s; it produces **no button at all**, and a
 * screen with nothing on it looks finished.
 *
 * By Checkpoint 20.8 the copy had stopped at Phase 14. Organization owners and
 * admins were missing twenty-two permissions each — every one added by Phases
 * 15 through 19 — so through the UI nobody could create, rotate or revoke an
 * API client, manage or replay a webhook, decide or comment on a submission,
 * read a certificate record or revoke a certificate. The server granted all of
 * it; the interface never offered it.
 *
 * Nothing catches that by accident: the component tests pass `canManage` in
 * directly, so they exercise the component and never the map, and the API
 * suites exercise the server, where the permissions were always correct. The
 * only thing that could catch it is not having two copies.
 */
const ROLE_PERMISSIONS: Record<string, readonly string[]> = Object.fromEntries(
  ROLE_DEFINITIONS.map((definition) => [definition.code, definition.permissions]),
);

export function permissionsForRoles(roles: readonly string[]): ReadonlySet<string> {
  const permissions = new Set<string>();
  for (const role of roles) {
    for (const permission of ROLE_PERMISSIONS[role] ?? []) permissions.add(permission);
  }
  return permissions;
}
