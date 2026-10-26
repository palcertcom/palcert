import { ROLE_DEFINITIONS } from '@palcert/contracts/auth/roles';
import { describe, expect, it } from 'vitest';
import { permissionsForRoles } from '../organization-shell';

/**
 * The interface must offer what the server grants (Phase 20 Checkpoint 8).
 *
 * The web app decides which controls to render from the caller's roles. That
 * decision used to be made against a hand-copied duplicate of the server's
 * role catalogue, and by Checkpoint 20.8 the copy had stopped at Phase 14:
 * organization owners and admins were each missing twenty-two permissions, so
 * through the UI nobody could create, rotate or revoke an API client, manage a
 * webhook, decide on a submission, or revoke a certificate. The server granted
 * every one of them.
 *
 * The comment on the old map argued the drift was harmless — "the consequence
 * is a button that returns 403, not a security hole". Authorization does live
 * on the server, so that half was right. But a duplicate that is *missing*
 * entries does not produce a 403; it produces no button, and a screen with
 * nothing on it looks finished.
 *
 * Nothing caught it: the component tests pass `canManage` in directly, so they
 * test the component and never the map, and the API suites test the server,
 * where the permissions were always correct. This is the test that sits
 * across the seam.
 */
describe('permissionsForRoles', () => {
  const organizationRoles = ROLE_DEFINITIONS.filter(
    (definition) => definition.scope === 'ORGANIZATION',
  );

  it('knows about some organization roles, so an empty sweep cannot pass', () => {
    expect(organizationRoles.length).toBeGreaterThanOrEqual(3);
  });

  it.each(organizationRoles.map((definition) => definition.code))(
    '%s is offered every permission the server grants it',
    (code) => {
      const definition = ROLE_DEFINITIONS.find((entry) => entry.code === code);
      expect(definition).toBeDefined();
      const offered = permissionsForRoles([code]);
      const missing = (definition?.permissions ?? []).filter(
        (permission) => !offered.has(permission),
      );
      expect(missing).toEqual([]);
    },
  );

  it('offers nothing the server does not grant', () => {
    // The other direction matters too, though less: a control rendered for a
    // permission the caller lacks is a button that 403s, which is the failure
    // the old comment imagined and the only one it was right about.
    for (const definition of ROLE_DEFINITIONS) {
      const offered = [...permissionsForRoles([definition.code])];
      const granted: readonly string[] = definition.permissions;
      const extra = offered.filter((permission) => !granted.includes(permission));
      expect(extra).toEqual([]);
    }
  });

  it('unions the permissions of several roles', () => {
    const owner = ROLE_DEFINITIONS.find((entry) => entry.code === 'ORGANIZATION_OWNER');
    const reviewer = ROLE_DEFINITIONS.find((entry) => entry.code === 'ORGANIZATION_REVIEWER');
    expect(owner).toBeDefined();
    expect(reviewer).toBeDefined();
    const combined = permissionsForRoles(['ORGANIZATION_OWNER', 'ORGANIZATION_REVIEWER']);
    for (const permission of [...(owner?.permissions ?? []), ...(reviewer?.permissions ?? [])]) {
      expect(combined.has(permission)).toBe(true);
    }
  });

  it('is empty for a role nobody holds', () => {
    expect([...permissionsForRoles(['NOT_A_ROLE'])]).toEqual([]);
  });

  /**
   * The four journeys the stale map made impossible, named individually so a
   * regression says which one broke rather than "a permission is missing".
   */
  it.each([
    ['manage API clients', 'ORGANIZATION_OWNER', 'integration:api-client:manage'],
    ['issue an API client secret', 'ORGANIZATION_OWNER', 'integration:api-client:secret:issue'],
    ['manage webhooks', 'ORGANIZATION_OWNER', 'integration:webhook:manage'],
    ['rotate a webhook secret', 'ORGANIZATION_OWNER', 'integration:webhook:secret:rotate'],
    ['decide on a submission', 'ORGANIZATION_REVIEWER', 'submission:decision:write'],
    ['comment on a submission', 'ORGANIZATION_REVIEWER', 'submission:comment:write'],
    ['read a certificate record', 'ORGANIZATION_OWNER', 'certificate:record:read'],
    ['revoke a certificate', 'ORGANIZATION_OWNER', 'certificate:revocation:write'],
  ])('a %s control is offered to %s', (_journey, role, permission) => {
    expect(permissionsForRoles([role]).has(permission)).toBe(true);
  });
});
