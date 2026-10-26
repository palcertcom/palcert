# Tenancy and tenant isolation

_Phase 2. See ADR-0017 (model), ADR-0018 (RLS and DB roles), ADR-0019 (tenant context)._

## 1. The model

```
User ──< OrganizationMembership >── Organization ──< OrganizationInvitation
  │            status                    │       ──< OrganizationVerificationRequest
  │                                      │
  └──< UserRole >── Role                 │
         organization_id ────────────────┘
         composite FK → organization_memberships(user_id, organization_id)
```

| Entity | Answers |
| --- | --- |
| `Organization` | The tenant. Operational `status` and identity `verificationStatus` are separate fields. |
| `OrganizationMembership` | *May this person act here at all?* |
| `UserRole` (organization-scoped) | *What may they do here?* |
| `OrganizationInvitation` | Who was asked to join, in what role, with what token. |
| `OrganizationVerificationRequest` | One identity-check attempt, with its decision. |

## 2. Four layers of isolation

A cross-tenant leak has to get past all four.

| Layer | Mechanism | Catches |
| --- | --- | --- |
| 1. Tenant resolution | `OrganizationContextGuard` → `TenantResolverService` | An unauthenticated or non-member caller |
| 2. Tenant authorization | `OrganizationPermissionsGuard` | A member without the permission |
| 3. Query scoping | Explicit `organizationId` in every `where` | An id belonging to another tenant |
| 4. Row-level security | PostgreSQL policies, `FORCE`d | *A bug in layers 1-3* |

Layer 4 is the one that matters most, because it is the only one that works when
the code above it is wrong.

## 3. Tenant context

```ts
await tenant.withTenant({ organizationId, userId }, async (tx) => { … });
```

One transaction, opening with `set_config(..., is_local => true)` for the
organization, the user and the elevation flag. PostgreSQL discards all three at
`COMMIT` and at `ROLLBACK`, so a pooled connection cannot carry one request's
tenant into the next — not even when the first request threw.

Three entry points, and no fourth:

| Method | Sets | For |
| --- | --- | --- |
| `withTenant` | organization + user | Every tenant-scoped request |
| `withUser` | user only | Organization switcher, tenant resolution, invitation acceptance |
| `withPlatformAdmin` | user + elevation, with a stated reason | PalCert staff routes only |

Code that forgets the wrapper reads **nothing**, because policies deny with no
context. Failing closed and loudly is deliberate.

## 4. Database identities

| | `palcert` (owner) | `palcert_app` (request path) |
| --- | --- | --- |
| Used by | Prisma CLI, migrations | Every API request |
| Superuser | yes, locally | **no** |
| `BYPASSRLS` | yes, locally | **no** |
| Owns the schema | yes | **no** |
| DDL | yes | **no** |

The API queries `pg_roles` at boot and **refuses to start** if the request role
can bypass RLS. Without that check, a wrong connection string would remove the
tenant boundary while every application test kept passing.

The migration creates `palcert_app` with `NOLOGIN` and no password; the password
comes from `pnpm db:provision-app-role`, reading the environment. A committed
migration never contains a secret, and a half-provisioned deployment fails
closed.

## 5. Row-level security

Enabled **and forced** on `organizations`, `organization_memberships`,
`organization_invitations`, `organization_verification_requests` and
`user_roles`. `FORCE` is required because the tables are owned by the migration
role, and PostgreSQL exempts an owner from its own policies otherwise.

Notable policy choices:

- **`organizations` SELECT** allows the resolved tenant, *or* an organization
  the caller is an `ACTIVE` or `SUSPENDED` member of. Suspended is included so
  the API can answer `MEMBERSHIP_SUSPENDED` instead of a misleading "not found";
  `REMOVED` is excluded, because for them the organization really is gone.
- **`organization_memberships` SELECT** also allows your own rows, which is what
  makes the cross-organization switcher possible without elevation. Its write
  policies do not — a member cannot edit their own standing.
- **`user_roles` SELECT** allows global rows (authentication resolves platform
  roles before any organization is known), the resolved tenant's rows, and your
  own rows.

### Coverage is enforced

`table_isolation_classification` records how every table is isolated. A test
reads the PostgreSQL catalogue and fails CI when a table is unclassified, or
when a `TENANT_SCOPED` table lacks RLS, `FORCE`, a tenant column or policy
coverage — so a tenant table added in Phase 5 cannot ship unisolated.

| Classification | Meaning |
| --- | --- |
| `TENANT_SCOPED` | Owned by one organization. RLS mandatory. |
| `USER_SCOPED` | Owned by one person. Application authorization. |
| `GLOBAL` | Reference data, identical for everyone. |
| `SYSTEM` | Infrastructure and append-only platform records. |

### Two SECURITY DEFINER functions

Both narrow, both documented in the migration:

- `app_organization_for_invitation(digest)` → organization id. Accepting an
  invitation is the one operation where the caller is legitimately not yet a
  member. It returns one value to a caller who already holds a 256-bit token,
  and the application then enters normal tenant context — an entry point to the
  isolation model, not an exception to it.
- `app_slug_available(slug)` → boolean. Handle uniqueness is a global-namespace
  question; the boolean discloses strictly less than the resulting 409.

## 6. Platform administration

PalCert staff need cross-tenant reach, and Phase 2 does not weaken tenant
policies to give it to them. Instead:

- a distinct permission (`admin:organization:*`),
- routes under `/admin/organizations` that opt in explicitly,
- `withPlatformAdmin`, which requires a stated reason and logs the elevation,
- an audit record for every action,
- a `PLATFORM_ADMIN_TENANT_ACCESS` security event.

An ordinary tenant route does **not** gain cross-tenant reach for staff: a
PalCert administrator calling `GET /organizations/:id` for an organization they
do not belong to receives 404, same as anyone else. Asserted by test.

## 7. Non-disclosure

`ORGANIZATION_NOT_FOUND` is returned identically for an organization that does
not exist and one the caller has no standing in — same status, same code, same
message. Membership ids and invitation ids from another tenant read as
`MEMBERSHIP_NOT_FOUND` / `INVITATION_NOT_FOUND`, never 403, because 403 would
confirm the identifier is real.

## 8. Rules for later phases

- **Jobs (Phase 5+).** A queue message carries the organization id, the resource
  id and the actor — but the worker re-establishes tenant context and
  re-authorizes. An organization id in a message is data, never proof.
- **Files (Phase 5+).** Object keys are namespaced `organizations/{id}/…` and a
  signed URL is minted only after authorizing the exact object and operation. A
  storage path is not access control.
- **Cache.** Any value whose content or authorization varies by tenant is keyed
  `tenant:{organizationId}:…`. Key separation is not a substitute for
  authorization: authorize first, then serve from cache.

## Phase 3: composite foreign keys as the anti-injection control

The standards tables introduced a child-of-a-child hierarchy
(`document_types` → `standards` → `standard_versions` → `standard_rules`), which
brings a failure mode the Phase 2 tables did not have: **cross-tenant parent
injection**. A caller POSTs a rule naming another tenant's `standardVersionId`,
or a standard naming another tenant's `documentTypeId`.

Two structural decisions handle it:

1. **`organization_id` is denormalized onto every table**, including the
   children. Each RLS policy is then a single-column comparison with no subquery
   or join — cheaper, and impossible to get subtly wrong in a way that only
   appears under an unusual query plan.

2. **Every parent reference is a composite foreign key including
   `organization_id`.** The pair `(parent_id, organization_id)` must exist on the
   parent, so a child can never sit in one tenant while pointing at a parent in
   another. This is what keeps the denormalized column honest.

The application checks the parent too, so the caller gets a clear 404 rather
than an opaque constraint violation. The foreign key is the layer that does not
forget.

Both are asserted by test: `standards-isolation.e2e-spec.ts` attempts each
injection over HTTP, and then attempts the same insert **as the schema owner**,
with every application layer bypassed, to prove the constraint rather than the
service.

