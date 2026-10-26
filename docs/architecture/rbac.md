# RBAC and permissions

_Phase 1. See ADR-0016._

## 1. Model

```
User ──< UserRole >── Role ──< RolePermission >── Permission
             │
             └── organization_id (null for global; Phase 2 fills it)
```

Authorization **always evaluates permissions, never role names**. No guard
contains `if (role === 'PALCERT_ADMIN')`. Adding a role is a data change; adding
a capability is a permission plus a mapping.

## 2. Permission naming

```
<domain>:<resource>[:<sub-resource>]:<action>[:self]
```

`self` marks a permission that only covers the acting user's own records. The
convention is enforced by test.

A resource carries a sub-resource only where one capability inside it has to
be grantable on its own. There is exactly one today —
`integration:webhook:secret:rotate` — because minting a signing secret is a
different authority from editing an endpoint's URL, and the test enumerates
it rather than merely allowing the shape, so a fourth segment cannot appear
by habit and become a second naming convention.

| Permission | Purpose |
| --- | --- |
| `profile:read:self` / `profile:update:self` | Own profile |
| `session:read:self` / `session:revoke:self` | Own sessions |
| `password:change:self` | Change own password |
| `mfa:manage:self` | Manage own authenticators |
| `admin:user:read` | Read any account |
| `admin:user:suspend` / `admin:user:reactivate` | Account status |
| `admin:role:assign` / `admin:role:remove` | Global role grants |
| `admin:session:revoke` | Revoke another user's sessions |
| `audit:event:read` | Read audit records |

## 3. Roles

| Role | Scope | MFA | Notable permissions |
| --- | --- | --- | --- |
| `STUDENT` | GLOBAL | — | self-service |
| `SERVICE_USER` | GLOBAL | — | self-service (default on registration) |
| `ORGANIZATION_OWNER` | ORGANIZATION | — | all organization permissions, including ownership transfer |
| `ORGANIZATION_ADMIN` | ORGANIZATION | — | profile, members, invitations, organization roles — **not** ownership transfer |
| `ORGANIZATION_REVIEWER` | ORGANIZATION | — | read-only within the organization |
| `TEMPLATE_MANAGER` | ORGANIZATION | — | read-only for now; standard authoring in Phase 3 |
| `PALCERT_ADMIN` | GLOBAL | **required** | all administrative permissions |
| `PALCERT_FINANCE` | GLOBAL | **required** | `admin:user:read` |
| `PALCERT_SUPPORT` | GLOBAL | — | `admin:user:read` only |
| `PALCERT_AUDITOR` | GLOBAL | **required** | `audit:event:read`, `admin:user:read` |
| `API_CLIENT` | GLOBAL | — | none yet |

**Support deliberately cannot assign roles or suspend accounts.** Support is the
most socially engineered role in any platform; it must not be a path to
administrator. Asserted by test.

Only `PALCERT_ADMIN` holds `admin:role:assign` — also asserted by test, so a
future edit that quietly widens it fails CI.

## 3a. Organization permissions (Phase 2)

Evaluated against the caller's roles **inside one organization**, never
platform-wide.

| Permission | Purpose |
| --- | --- |
| `organization:profile:read` / `:update` | The organization profile |
| `organization:member:read` / `:invite` / `:update` / `:remove` | Team management |
| `organization:role:assign` / `:remove` | Organization roles only |
| `organization:verification:request` / `:read` | Identity verification |
| `organization:ownership:transfer` | Hand the organization to someone else |
| `admin:organization:read` / `:verify` / `:suspend` | PalCert staff, across tenants |

Two contract tests hold the line: no organization role may carry a
non-organization permission, and no global role may carry an organization one.

## 4. Guard order

```
CsrfGuard → SessionGuard → PermissionsGuard → OrganizationContextGuard → OrganizationPermissionsGuard
```

The two permission guards are separate deliberately: they evaluate different
sets, and merging them would let a platform permission satisfy an organization
requirement, or the reverse.

1. **CsrfGuard** rejects forged cross-site writes before any lookup happens.
2. **SessionGuard** establishes identity, enforces account status and assurance
   level, and refuses `PENDING_MFA` sessions outside the challenge endpoints.
3. **PermissionsGuard** checks the permissions the route declares.

All three are **global**. A new controller is protected by default and must opt
out with `@Public()` — so a forgotten decorator produces a locked endpoint, never
an open one.

## 5. Escalation controls

| Attack | Control |
| --- | --- |
| Self-assign a role via profile update | `UpdateProfileDto` allows two fields; `forbidNonWhitelisted` rejects anything else |
| Self-assign via the admin endpoint | Requires `admin:role:assign`, which only `PALCERT_ADMIN` holds |
| Support escalating to admin | Support lacks the permission entirely |
| Organization role granted globally | Rejected by the service *and* by a database check constraint |
| Role relabelled to a different scope | Rejected by a composite foreign key |
| Duplicate global grant | Rejected by a `NULLS NOT DISTINCT` unique index |
| Stale privileged session | Privileged session without AAL2 is refused every request |
| Granting a privileged role from an old session | Requires recent authentication |

Every grant and removal writes both a security event and an audit record with
actor, target and before/after state.

## 6. Phase 2 (delivered)

Phase 2 added the `organizations` table, the foreign key on
`user_roles.organization_id` (plus a composite key to memberships), permissions
for the four organization roles, and a dedicated guard pair for tenant scoping.
The Phase 1 guards were not modified.

An organization role can never confer platform authority. That is enforced three
times over: the permission catalogue is partitioned and asserted by test, the
service rejects a global role code, and the database refuses a mis-scoped
assignment via a composite foreign key to `roles(id, scope)`.

## Segment spelling

Each segment is lowercase and may be kebab-cased where the name genuinely has
two words — `standard:document-type:read`. Asserted by the catalogue test, so a
typo or a two-segment name fails CI rather than shipping.

## Standards permissions (Phase 3)

`standard:version:publish` is deliberately **separate from**
`standard:version:update`. Authoring a standard and putting it into force are
different acts with different consequences, and an organization must be able to
grant one without the other.

No role currently holds publish without also holding edit — that combination
would be incoherent — but the reverse is expressible, which is the direction
that matters. Both properties are asserted by test.

`ORGANIZATION_REVIEWER` gains the two read permissions and nothing else: a
reviewer must be able to see what a submission is judged against, and must never
be able to change it. The full matrix is in
[standards.md](standards.md#permissions).

## Attestation permissions

See [attestations.md § Permissions](attestations.md#permissions) for the full
matrix. Self: `attestation:submit:self`, `attestation:read:self` (every
account). Organization: `attestation:request:read`, `attestation:request:review`,
`attestation:request:approve` (owner, admin, reviewer); `attestation:record:revoke`,
`attestation:type:manage`, `attestation:fee:manage`, `attestation:finance:read`
(owner, admin). Platform: `admin:attestation:read` (PALCERT_ADMIN),
`admin:attestation-commission:manage` (PALCERT_ADMIN, PALCERT_FINANCE),
`admin:attestation-finance:read` (PALCERT_ADMIN, PALCERT_FINANCE, PALCERT_AUDITOR).

## Manual top-up permissions

Platform only (ADR-0147). `admin:payment-method:read` (PALCERT_ADMIN,
PALCERT_FINANCE, PALCERT_AUDITOR), `admin:payment-method:manage`
(PALCERT_ADMIN), `finance:manual-topup:read` (PALCERT_ADMIN, PALCERT_FINANCE,
PALCERT_AUDITOR), `finance:manual-topup:review|approve|reject`
(PALCERT_FINANCE only). The administrator can publish where money goes and
cannot credit anybody; a deployment wanting both in one person assigns both
roles. Customers use `balance:read:self` and `balance:topup:self`.

