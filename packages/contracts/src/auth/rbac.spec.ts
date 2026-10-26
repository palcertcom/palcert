import { describe, expect, it } from 'vitest';
import {
  ALL_PERMISSIONS,
  Permission,
  SELF_SERVICE_PERMISSIONS,
  isOrganizationScopedPermission,
} from './permissions.js';
import {
  DEFAULT_REGISTRATION_ROLE,
  PRIVILEGED_ROLES,
  ROLE_DEFINITIONS,
  RoleCode,
  RoleScope,
  getRoleDefinition,
  isGlobalRole,
  roleRequiresMfa,
} from './roles.js';
import { UserStatus, canTransitionStatus, statusPermitsSession } from './user.js';

describe('permission catalogue', () => {
  it('has unique codes following the documented convention', () => {
    expect(new Set(ALL_PERMISSIONS).size).toBe(ALL_PERMISSIONS.length);
    for (const permission of ALL_PERMISSIONS) {
      // Each segment is lowercase, optionally kebab-cased (`document-type`),
      // and a resource may carry one sub-resource (`webhook:secret`).
      expect(permission, permission).toMatch(
        /^[a-z]+(?:-[a-z]+)*:[a-z]+(?:-[a-z]+)*(?::[a-z]+(?:-[a-z]+)*)?:[a-z]+(?:-[a-z]+)*(:self)?$/,
      );
    }
  });

  it('uses a sub-resource only where the catalogue documents one', () => {
    // The sub-resource form exists so `integration:webhook:secret:rotate` can
    // be granted without granting `integration:webhook:manage` — minting a
    // credential is not the same authority as editing a URL. Enumerated here
    // rather than merely permitted by the pattern, so a fourth segment cannot
    // appear by habit and quietly become a second naming convention.
    const withSubResource = ALL_PERMISSIONS.filter(
      (permission) => permission.split(':').length === 4 && !permission.endsWith(':self'),
    );
    expect(withSubResource).toEqual([
      Permission.INTEGRATION_WEBHOOK_SECRET_ROTATE,
      // Phase 19: minting a key to the organization's data is not the same
      // authority as editing which routes a client may reach, so issuing a
      // secret is separable from managing the client — the same split, for the
      // same reason, as the webhook row above.
      Permission.INTEGRATION_API_CLIENT_SECRET_ISSUE,
    ]);
  });
});

describe('role catalogue', () => {
  it('defines every role from the product specification', () => {
    const codes = ROLE_DEFINITIONS.map((role) => role.code).sort();
    expect(codes).toEqual(Object.values(RoleCode).sort());
  });

  it('has no duplicate role codes', () => {
    const codes = ROLE_DEFINITIONS.map((role) => role.code);
    expect(new Set(codes).size).toBe(codes.length);
  });

  it('grants only permissions that exist in the catalogue', () => {
    for (const role of ROLE_DEFINITIONS) {
      for (const permission of role.permissions) {
        expect(ALL_PERMISSIONS, `${role.code} grants unknown ${permission}`).toContain(permission);
      }
    }
  });

  it('classifies organization roles as organization-scoped, never global', () => {
    const organizationRoles = [
      RoleCode.ORGANIZATION_OWNER,
      RoleCode.ORGANIZATION_ADMIN,
      RoleCode.ORGANIZATION_REVIEWER,
      RoleCode.TEMPLATE_MANAGER,
    ];
    for (const code of organizationRoles) {
      expect(getRoleDefinition(code)?.scope, code).toBe(RoleScope.ORGANIZATION);
      expect(isGlobalRole(code), code).toBe(false);
    }
  });

  it('grants organization roles only organization-scoped permissions', () => {
    // The critical invariant: no organization role may carry a permission that
    // means something platform-wide. Holding a role in one tenant must never
    // confer authority outside it.
    for (const role of ROLE_DEFINITIONS.filter((r) => r.scope === RoleScope.ORGANIZATION)) {
      for (const permission of role.permissions) {
        expect(
          isOrganizationScopedPermission(permission),
          `${role.code} holds non-organization permission ${permission}`,
        ).toBe(true);
      }
    }
  });

  it('never gives a global role an organization-scoped permission', () => {
    // The converse: an organization permission is only ever evaluated inside a
    // resolved tenant, so a global role holding one would be meaningless at
    // best and a scoping bug at worst.
    for (const role of ROLE_DEFINITIONS.filter((r) => r.scope === RoleScope.GLOBAL)) {
      for (const permission of role.permissions) {
        expect(
          isOrganizationScopedPermission(permission),
          `${role.code} holds organization permission ${permission}`,
        ).toBe(false);
      }
    }
  });

  it('lets only the owner transfer ownership', () => {
    const transferrers = ROLE_DEFINITIONS.filter((role) =>
      role.permissions.includes(Permission.ORGANIZATION_OWNERSHIP_TRANSFER),
    ).map((role) => role.code);

    expect(transferrers).toEqual([RoleCode.ORGANIZATION_OWNER]);
  });

  it('does not let an organization admin transfer ownership', () => {
    const admin = getRoleDefinition(RoleCode.ORGANIZATION_ADMIN);
    expect(admin?.permissions).not.toContain(Permission.ORGANIZATION_OWNERSHIP_TRANSFER);
    // But it can still run the organization day to day.
    expect(admin?.permissions).toContain(Permission.ORGANIZATION_MEMBER_INVITE);
  });

  it('gives neither reviewer nor template manager authority over members', () => {
    for (const code of [RoleCode.ORGANIZATION_REVIEWER, RoleCode.TEMPLATE_MANAGER]) {
      const role = getRoleDefinition(code);
      expect(role?.permissions, code).not.toContain(Permission.ORGANIZATION_MEMBER_INVITE);
      expect(role?.permissions, code).not.toContain(Permission.ORGANIZATION_ROLE_ASSIGN);
      expect(role?.permissions, code).not.toContain(Permission.ORGANIZATION_PROFILE_UPDATE);
      expect(role?.permissions, code).toContain(Permission.ORGANIZATION_MEMBER_READ);
    }
  });

  it('lets a reviewer read standards but never write one', () => {
    // A reviewer must be able to see what a submission was judged against.
    // Every write is withheld, including the ones that only touch a draft.
    const reviewer = getRoleDefinition(RoleCode.ORGANIZATION_REVIEWER);
    expect(reviewer?.permissions).toContain(Permission.STANDARD_READ);
    expect(reviewer?.permissions).toContain(Permission.STANDARD_DOCUMENT_TYPE_READ);

    for (const permission of [
      Permission.STANDARD_CREATE,
      Permission.STANDARD_UPDATE,
      Permission.STANDARD_ARCHIVE,
      Permission.STANDARD_DOCUMENT_TYPE_MANAGE,
      Permission.STANDARD_VERSION_CREATE,
      Permission.STANDARD_VERSION_UPDATE,
      Permission.STANDARD_VERSION_PUBLISH,
      Permission.STANDARD_VERSION_ARCHIVE,
      Permission.STANDARD_RULE_WRITE,
    ]) {
      expect(reviewer?.permissions, permission).not.toContain(permission);
    }
  });

  it('makes publishing a permission of its own, distinct from editing', () => {
    // The point of the separation is that a role holding edit need not hold
    // publish. Asserting they are different catalogue entries is what stops a
    // future refactor from collapsing them into one.
    expect(Permission.STANDARD_VERSION_PUBLISH).not.toBe(Permission.STANDARD_VERSION_UPDATE);

    const publishers = ROLE_DEFINITIONS.filter((role) =>
      role.permissions.includes(Permission.STANDARD_VERSION_PUBLISH),
    ).map((role) => role.code);
    expect([...publishers].sort()).toEqual(
      [RoleCode.ORGANIZATION_ADMIN, RoleCode.ORGANIZATION_OWNER, RoleCode.TEMPLATE_MANAGER].sort(),
    );
  });

  it('never grants publish without also granting edit', () => {
    // The reverse (edit without publish) is deliberately expressible; this
    // direction would be incoherent.
    for (const role of ROLE_DEFINITIONS) {
      if (role.permissions.includes(Permission.STANDARD_VERSION_PUBLISH)) {
        expect(role.permissions, role.code).toContain(Permission.STANDARD_VERSION_UPDATE);
      }
    }
  });

  it('keeps standards authoring out of every global role', () => {
    // Standards belong to a tenant. A platform role that could edit them would
    // be a cross-tenant write path.
    const authoring = [
      Permission.STANDARD_CREATE,
      Permission.STANDARD_UPDATE,
      Permission.STANDARD_VERSION_PUBLISH,
      Permission.STANDARD_RULE_WRITE,
    ];
    for (const role of ROLE_DEFINITIONS.filter((entry) => entry.scope === 'GLOBAL')) {
      for (const permission of authoring) {
        expect(role.permissions, `${role.code}/${permission}`).not.toContain(permission);
      }
    }
  });

  it('reserves organization administration over tenants to PalCert admin', () => {
    const verifiers = ROLE_DEFINITIONS.filter((role) =>
      role.permissions.includes(Permission.ADMIN_ORGANIZATION_VERIFY),
    ).map((role) => role.code);
    const suspenders = ROLE_DEFINITIONS.filter((role) =>
      role.permissions.includes(Permission.ADMIN_ORGANIZATION_SUSPEND),
    ).map((role) => role.code);

    expect(verifiers).toEqual([RoleCode.PALCERT_ADMIN]);
    expect(suspenders).toEqual([RoleCode.PALCERT_ADMIN]);
  });

  it('requires MFA for administrator, finance and auditor roles', () => {
    expect(roleRequiresMfa(RoleCode.PALCERT_ADMIN)).toBe(true);
    expect(roleRequiresMfa(RoleCode.PALCERT_FINANCE)).toBe(true);
    expect(roleRequiresMfa(RoleCode.PALCERT_AUDITOR)).toBe(true);
    expect(roleRequiresMfa(RoleCode.SERVICE_USER)).toBe(false);
  });

  it('never lets support escalate to administrator capabilities', () => {
    const support = getRoleDefinition(RoleCode.PALCERT_SUPPORT);
    expect(support?.permissions).not.toContain(Permission.ADMIN_ROLE_ASSIGN);
    expect(support?.permissions).not.toContain(Permission.ADMIN_USER_SUSPEND);
  });

  it('grants role assignment to the administrator role only', () => {
    const assigners = ROLE_DEFINITIONS.filter((role) =>
      role.permissions.includes(Permission.ADMIN_ROLE_ASSIGN),
    ).map((role) => role.code);
    expect(assigners).toEqual([RoleCode.PALCERT_ADMIN]);
  });

  it('registers new users as a non-privileged global role', () => {
    expect(PRIVILEGED_ROLES).not.toContain(DEFAULT_REGISTRATION_ROLE);
    expect(isGlobalRole(DEFAULT_REGISTRATION_ROLE)).toBe(true);
  });

  it('gives every global human role the self-service permissions', () => {
    const humanRoles = ROLE_DEFINITIONS.filter(
      (role) => role.scope === RoleScope.GLOBAL && role.code !== RoleCode.API_CLIENT,
    );
    for (const role of humanRoles) {
      for (const permission of SELF_SERVICE_PERMISSIONS) {
        expect(role.permissions, `${role.code} missing ${permission}`).toContain(permission);
      }
    }
  });

  it('returns undefined for an unknown role', () => {
    expect(getRoleDefinition('NOT_A_ROLE')).toBeUndefined();
    expect(roleRequiresMfa('NOT_A_ROLE')).toBe(false);
  });
});

describe('user status machine', () => {
  it('permits only the documented transitions', () => {
    expect(canTransitionStatus(UserStatus.PENDING_VERIFICATION, UserStatus.ACTIVE)).toBe(true);
    expect(canTransitionStatus(UserStatus.ACTIVE, UserStatus.SUSPENDED)).toBe(true);
    expect(canTransitionStatus(UserStatus.SUSPENDED, UserStatus.ACTIVE)).toBe(true);
    expect(canTransitionStatus(UserStatus.ACTIVE, UserStatus.DISABLED)).toBe(true);
  });

  it('treats DISABLED as terminal', () => {
    for (const target of Object.values(UserStatus)) {
      expect(canTransitionStatus(UserStatus.DISABLED, target), target).toBe(false);
    }
  });

  it('does not allow skipping verification back to pending', () => {
    expect(canTransitionStatus(UserStatus.ACTIVE, UserStatus.PENDING_VERIFICATION)).toBe(false);
    expect(canTransitionStatus(UserStatus.SUSPENDED, UserStatus.PENDING_VERIFICATION)).toBe(false);
  });

  it('allows a session only while active', () => {
    expect(statusPermitsSession(UserStatus.ACTIVE)).toBe(true);
    expect(statusPermitsSession(UserStatus.PENDING_VERIFICATION)).toBe(false);
    expect(statusPermitsSession(UserStatus.SUSPENDED)).toBe(false);
    expect(statusPermitsSession(UserStatus.DISABLED)).toBe(false);
  });
});
