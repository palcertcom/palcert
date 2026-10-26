-- Phase 2 — Organizations, membership, invitations, verification and tenant isolation.
--
-- Beyond the generated DDL this migration hand-writes everything Prisma cannot
-- express. Each block is numbered and explained; nothing here is incidental.
--
--   1. Phase 1 debt: a real foreign key on user_roles.organization_id, plus a
--      composite key making an organization role impossible without a membership.
--   2. Tenant-context accessor functions.
--   3. Table isolation classification (drives the RLS coverage test).
--   4. Row-level security policies on every tenant-scoped table.
--   5. The least-privileged application database role.
--   6. Organization-role permission grants.
--
-- The Phase 0 baseline and Phase 1 migrations are untouched (Master Prompt 45).

-- CreateEnum
CREATE TYPE "OrganizationType" AS ENUM ('UNIVERSITY', 'SCIENTIFIC_JOURNAL', 'PUBLISHER', 'RESEARCH_INSTITUTION', 'GOVERNMENT', 'COMPANY', 'OTHER');

-- CreateEnum
CREATE TYPE "OrganizationStatus" AS ENUM ('ACTIVE', 'SUSPENDED', 'CLOSED');

-- CreateEnum
CREATE TYPE "OrganizationVerificationStatus" AS ENUM ('UNVERIFIED', 'PENDING', 'VERIFIED', 'REJECTED');

-- CreateEnum
CREATE TYPE "MembershipStatus" AS ENUM ('ACTIVE', 'SUSPENDED', 'REMOVED');

-- CreateEnum
CREATE TYPE "InvitationStatus" AS ENUM ('PENDING', 'ACCEPTED', 'REVOKED', 'EXPIRED');

-- CreateEnum
CREATE TYPE "VerificationRequestStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED');

-- NOTE: `prisma migrate diff` wanted to drop "user_roles_role_scope_fkey" here,
-- because Prisma cannot model a composite foreign key to (id, scope). Dropping
-- it would silently remove the Phase 1 guarantee that an assignment's scope
-- always matches its role's real scope, so the drop is deliberately omitted.

-- CreateTable
CREATE TABLE "organizations" (
    "id" UUID NOT NULL,
    "type" "OrganizationType" NOT NULL,
    "legal_name" TEXT NOT NULL,
    "display_name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "website" TEXT,
    "country_code" CHAR(2) NOT NULL,
    "timezone" TEXT NOT NULL,
    "default_locale" TEXT NOT NULL DEFAULT 'en',
    "status" "OrganizationStatus" NOT NULL DEFAULT 'ACTIVE',
    "verification_status" "OrganizationVerificationStatus" NOT NULL DEFAULT 'UNVERIFIED',
    "suspended_at" TIMESTAMP(3),
    "suspension_reason" TEXT,
    "closed_at" TIMESTAMP(3),
    "created_by_user_id" UUID NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "organizations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "organization_memberships" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "status" "MembershipStatus" NOT NULL DEFAULT 'ACTIVE',
    "joined_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "suspended_at" TIMESTAMP(3),
    "removed_at" TIMESTAMP(3),
    "invited_by_user_id" UUID,
    "invitation_id" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "organization_memberships_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "organization_invitations" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "email" TEXT NOT NULL,
    "normalized_email" TEXT NOT NULL,
    "role_id" UUID NOT NULL,
    "scope" "RoleScope" NOT NULL DEFAULT 'ORGANIZATION',
    "token_hash" TEXT NOT NULL,
    "status" "InvitationStatus" NOT NULL DEFAULT 'PENDING',
    "expires_at" TIMESTAMP(3) NOT NULL,
    "invited_by_user_id" UUID NOT NULL,
    "accepted_by_user_id" UUID,
    "accepted_at" TIMESTAMP(3),
    "revoked_by_user_id" UUID,
    "revoked_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "organization_invitations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "organization_verification_requests" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "status" "VerificationRequestStatus" NOT NULL DEFAULT 'PENDING',
    "requested_by_user_id" UUID NOT NULL,
    "requested_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "submission_note" TEXT,
    "reviewed_by_user_id" UUID,
    "reviewed_at" TIMESTAMP(3),
    "decision_reason" TEXT,
    "internal_notes" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "organization_verification_requests_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "organizations_slug_key" ON "organizations"("slug");

-- CreateIndex
CREATE INDEX "organizations_status_idx" ON "organizations"("status");

-- CreateIndex
CREATE INDEX "organizations_verification_status_idx" ON "organizations"("verification_status");

-- CreateIndex
CREATE INDEX "organizations_created_at_id_idx" ON "organizations"("created_at", "id");

-- CreateIndex
CREATE INDEX "organization_memberships_organization_id_status_idx" ON "organization_memberships"("organization_id", "status");

-- CreateIndex
CREATE INDEX "organization_memberships_user_id_status_idx" ON "organization_memberships"("user_id", "status");

-- CreateIndex
CREATE INDEX "organization_memberships_organization_id_joined_at_id_idx" ON "organization_memberships"("organization_id", "joined_at", "id");

-- CreateIndex
CREATE UNIQUE INDEX "organization_memberships_organization_id_user_id_key" ON "organization_memberships"("organization_id", "user_id");

-- CreateIndex
CREATE UNIQUE INDEX "organization_memberships_user_org_key" ON "organization_memberships"("user_id", "organization_id");

-- CreateIndex
CREATE UNIQUE INDEX "organization_invitations_token_hash_key" ON "organization_invitations"("token_hash");

-- CreateIndex
CREATE INDEX "organization_invitations_organization_id_status_idx" ON "organization_invitations"("organization_id", "status");

-- CreateIndex
CREATE INDEX "organization_invitations_normalized_email_idx" ON "organization_invitations"("normalized_email");

-- CreateIndex
CREATE INDEX "organization_invitations_status_expires_at_idx" ON "organization_invitations"("status", "expires_at");

-- CreateIndex
CREATE INDEX "organization_invitations_organization_id_created_at_id_idx" ON "organization_invitations"("organization_id", "created_at", "id");

-- CreateIndex
CREATE INDEX "organization_verification_requests_organization_id_requeste_idx" ON "organization_verification_requests"("organization_id", "requested_at");

-- CreateIndex
CREATE INDEX "organization_verification_requests_status_requested_at_id_idx" ON "organization_verification_requests"("status", "requested_at", "id");

-- AddForeignKey
ALTER TABLE "user_roles" ADD CONSTRAINT "user_roles_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "organizations" ADD CONSTRAINT "organizations_created_by_user_id_fkey" FOREIGN KEY ("created_by_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "organization_memberships" ADD CONSTRAINT "organization_memberships_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "organization_memberships" ADD CONSTRAINT "organization_memberships_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "organization_memberships" ADD CONSTRAINT "organization_memberships_invited_by_user_id_fkey" FOREIGN KEY ("invited_by_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "organization_invitations" ADD CONSTRAINT "organization_invitations_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "organization_invitations" ADD CONSTRAINT "organization_invitations_role_id_fkey" FOREIGN KEY ("role_id") REFERENCES "roles"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "organization_invitations" ADD CONSTRAINT "organization_invitations_invited_by_user_id_fkey" FOREIGN KEY ("invited_by_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "organization_invitations" ADD CONSTRAINT "organization_invitations_accepted_by_user_id_fkey" FOREIGN KEY ("accepted_by_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "organization_verification_requests" ADD CONSTRAINT "organization_verification_requests_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "organization_verification_requests" ADD CONSTRAINT "organization_verification_requests_requested_by_user_id_fkey" FOREIGN KEY ("requested_by_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "organization_verification_requests" ADD CONSTRAINT "organization_verification_requests_reviewed_by_user_id_fkey" FOREIGN KEY ("reviewed_by_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;


-- ===========================================================================
-- 1. Phase 1 deferred constraint, now resolved
--
--    The generated DDL above added user_roles.organization_id → organizations.
--    This second, composite foreign key is the one that matters: it makes an
--    organization-scoped role impossible to hold without a membership row for
--    the same (user, organization) pair. Combined with the Phase 1 check
--    constraint and the (role_id, scope) foreign key, the database — not just
--    application code — now guarantees:
--
--      GLOBAL role        ⟹ organization_id IS NULL
--      ORGANIZATION role  ⟹ organization_id IS NOT NULL
--                         ∧ a membership exists for (user, organization)
-- ===========================================================================
ALTER TABLE "user_roles"
    ADD CONSTRAINT "user_roles_membership_fkey"
    FOREIGN KEY ("user_id", "organization_id")
    REFERENCES "organization_memberships" ("user_id", "organization_id")
    ON DELETE CASCADE ON UPDATE CASCADE;

-- Slugs are compared case-insensitively so `IUG` and `iug` cannot both exist.
CREATE UNIQUE INDEX "organizations_slug_lower_key" ON "organizations" (LOWER("slug"));

-- At most one PENDING invitation per address per organization. A partial index
-- expresses "only while pending", which a plain unique constraint cannot: once
-- an invitation is accepted or revoked, the address may be invited again.
CREATE UNIQUE INDEX "organization_invitations_pending_key"
    ON "organization_invitations" ("organization_id", "normalized_email")
    WHERE "status" = 'PENDING';

-- At most one PENDING verification request per organization.
CREATE UNIQUE INDEX "organization_verification_pending_key"
    ON "organization_verification_requests" ("organization_id")
    WHERE "status" = 'PENDING';

-- Country codes are ISO 3166-1 alpha-2, uppercase (§50).
ALTER TABLE "organizations"
    ADD CONSTRAINT "organizations_country_code_check"
    CHECK ("country_code" ~ '^[A-Z]{2}$');

-- Slug shape: lowercase alphanumeric with single internal hyphens.
ALTER TABLE "organizations"
    ADD CONSTRAINT "organizations_slug_format_check"
    CHECK ("slug" ~ '^[a-z0-9]+(-[a-z0-9]+)*$' AND length("slug") BETWEEN 3 AND 63);

-- Status/timestamp coherence, so a suspended organization always records when.
ALTER TABLE "organizations"
    ADD CONSTRAINT "organizations_status_timestamp_check"
    CHECK (
        ("status" <> 'SUSPENDED' OR "suspended_at" IS NOT NULL)
        AND ("status" <> 'CLOSED' OR "closed_at" IS NOT NULL)
    );

ALTER TABLE "organization_memberships"
    ADD CONSTRAINT "organization_memberships_status_timestamp_check"
    CHECK (
        ("status" <> 'SUSPENDED' OR "suspended_at" IS NOT NULL)
        AND ("status" <> 'REMOVED' OR "removed_at" IS NOT NULL)
    );

-- An invitation always names an ORGANIZATION-scoped role. The composite key to
-- roles(id, scope) is what stops a crafted payload naming PALCERT_ADMIN.
ALTER TABLE "organization_invitations"
    ADD CONSTRAINT "organization_invitations_scope_check"
    CHECK ("scope" = 'ORGANIZATION');

ALTER TABLE "organization_invitations"
    ADD CONSTRAINT "organization_invitations_role_scope_fkey"
    FOREIGN KEY ("role_id", "scope") REFERENCES "roles" ("id", "scope")
    ON DELETE RESTRICT ON UPDATE CASCADE;

-- ===========================================================================
-- 2. Tenant-context accessors
--
--    Context is supplied per transaction with `set_config(..., is_local => true)`,
--    which PostgreSQL resets automatically at COMMIT *and* at ROLLBACK. That is
--    the property that makes pooled connections safe: there is no way for one
--    request's tenant to survive into the next, even when the first aborted
--    (ADR-0019).
--
--    Every accessor is STABLE (not IMMUTABLE — the value varies per transaction)
--    and returns NULL rather than raising when unset, so a query issued with no
--    tenant context simply sees nothing instead of erroring in a way that might
--    be caught and ignored.
-- ===========================================================================

CREATE OR REPLACE FUNCTION app_current_organization() RETURNS uuid
LANGUAGE sql STABLE AS $$
    SELECT NULLIF(current_setting('palcert.current_organization_id', true), '')::uuid;
$$;

CREATE OR REPLACE FUNCTION app_current_user_id() RETURNS uuid
LANGUAGE sql STABLE AS $$
    SELECT NULLIF(current_setting('palcert.current_user_id', true), '')::uuid;
$$;

-- Platform-administrator elevation.
--
-- This is an explicit, separate path (§22): ordinary tenant requests never set
-- it, the flag is transaction-local like everything else, and every use is
-- audited by the application. It exists so PalCert staff tooling does not force
-- us to weaken tenant policies for everyone.
CREATE OR REPLACE FUNCTION app_is_platform_admin() RETURNS boolean
LANGUAGE sql STABLE AS $$
    SELECT COALESCE(current_setting('palcert.platform_admin', true) = 'on', false);
$$;

-- Resolve the organization an invitation belongs to, from its token digest.
--
-- Accepting an invitation is the one legitimate operation where the caller is
-- not yet a member, so tenant context cannot be established beforehand — a
-- chicken-and-egg problem. This resolves it: the application obtains the
-- organization id, sets normal tenant context, and every subsequent read and
-- write goes through the ordinary policies.
--
-- SECURITY DEFINER keeps the hole exactly one value wide. It returns only an
-- organization id, and only to a caller who already presents a 256-bit token
-- digest — which is itself proof of possession. Status and expiry are
-- deliberately NOT filtered here: doing so would collapse "revoked", "already
-- used" and "expired" into an indistinguishable "not found", and the recipient
-- of a withdrawn invitation deserves to be told which it was.
CREATE OR REPLACE FUNCTION app_organization_for_invitation(p_token_hash text)
RETURNS uuid
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
    SELECT organization_id
    FROM organization_invitations
    WHERE token_hash = p_token_hash
    LIMIT 1;
$$;

-- Slug availability.
--
-- Whether a handle is free is inherently a global-namespace question: a caller
-- must not be able to claim a slug that row-level security hides from them, and
-- they would otherwise hit an opaque unique-violation instead of a clear error.
-- SECURITY DEFINER keeps the disclosure to a single boolean — no row, no id, no
-- name — which is strictly less than the eventual 409 already reveals.
CREATE OR REPLACE FUNCTION app_slug_available(p_slug text)
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
    SELECT NOT EXISTS (SELECT 1 FROM organizations WHERE LOWER(slug) = LOWER(p_slug));
$$;

-- ===========================================================================
-- 3. Table isolation classification
--
--    Every table records how it is isolated. The RLS coverage test reads this
--    catalogue and fails CI when a table is unclassified, or when a table
--    classified TENANT_SCOPED lacks RLS, FORCE RLS, or policies. That is what
--    makes a *future* tenant table impossible to add without isolating it —
--    a hand-maintained list would simply be forgotten.
--
--      GLOBAL        reference data, identical for everyone (roles, permissions)
--      TENANT_SCOPED owned by exactly one organization; RLS mandatory
--      USER_SCOPED   owned by one user; guarded by application authorization
--      SYSTEM        infrastructure and append-only platform records
-- ===========================================================================
CREATE TABLE "table_isolation_classification" (
    "table_name" TEXT PRIMARY KEY,
    "classification" TEXT NOT NULL
        CHECK ("classification" IN ('GLOBAL', 'TENANT_SCOPED', 'USER_SCOPED', 'SYSTEM')),
    "tenant_column" TEXT,
    "notes" TEXT NOT NULL,
    CONSTRAINT "tenant_scoped_requires_column"
        CHECK ("classification" <> 'TENANT_SCOPED' OR "tenant_column" IS NOT NULL)
);

INSERT INTO "table_isolation_classification" ("table_name", "classification", "tenant_column", "notes") VALUES
    ('organizations',                     'TENANT_SCOPED', 'id',              'The tenant itself.'),
    ('organization_memberships',          'TENANT_SCOPED', 'organization_id', 'Also visible to the member themselves, for the organization switcher.'),
    ('organization_invitations',          'TENANT_SCOPED', 'organization_id', 'Acceptance resolves context via app_organization_for_invitation.'),
    ('organization_verification_requests','TENANT_SCOPED', 'organization_id', 'Internal reviewer notes are additionally filtered in the application layer.'),
    ('user_roles',                        'TENANT_SCOPED', 'organization_id', 'Global rows (organization_id IS NULL) stay visible without tenant context so authentication works.'),
    ('users',                             'USER_SCOPED',   NULL,              'Identity. Guarded by application authorization; not organization-owned.'),
    ('sessions',                          'USER_SCOPED',   NULL,              'Looked up by token digest before any tenant exists.'),
    ('email_verification_tokens',         'USER_SCOPED',   NULL,              'Pre-authentication credential tokens.'),
    ('password_reset_tokens',             'USER_SCOPED',   NULL,              'Pre-authentication credential tokens.'),
    ('mfa_authenticators',                'USER_SCOPED',   NULL,              'Second factors belong to a person, not a tenant.'),
    ('mfa_recovery_codes',                'USER_SCOPED',   NULL,              'Second factors belong to a person, not a tenant.'),
    ('roles',                             'GLOBAL',        NULL,              'Reference catalogue, seeded by migration.'),
    ('permissions',                       'GLOBAL',        NULL,              'Reference catalogue, seeded by migration.'),
    ('role_permissions',                  'GLOBAL',        NULL,              'Reference catalogue, seeded by migration.'),
    ('security_events',                   'SYSTEM',        NULL,              'Append-only platform telemetry, including pre-authentication attempts.'),
    ('audit_events',                      'SYSTEM',        NULL,              'Append-only audit log; must remain writable in every context.'),
    ('app_metadata',                      'SYSTEM',        NULL,              'Schema provenance.'),
    ('table_isolation_classification',    'SYSTEM',        NULL,              'This catalogue.'),
    ('_prisma_migrations',                'SYSTEM',        NULL,              'Migration history.');

-- ===========================================================================
-- 4. Row-level security
--
--    Defence in depth, never the only control (§15). Application authorization
--    still decides every request; these policies are what stops a *bug* in that
--    layer from becoming a cross-tenant data leak.
--
--    FORCE ROW LEVEL SECURITY is set on every tenant table because the tables
--    are owned by the migration role, and PostgreSQL exempts a table's owner
--    from its own policies unless forced (§17). Without FORCE, a mistake in
--    deployment wiring — the application connecting as the owner — would
--    silently disable every policy here.
-- ===========================================================================

-- --- organizations ---------------------------------------------------------
ALTER TABLE "organizations" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "organizations" FORCE ROW LEVEL SECURITY;

-- Readable when it is the resolved tenant, when the caller is an active member
-- (needed by the organization switcher, which has no single tenant), or under
-- explicit platform-admin elevation.
CREATE POLICY "organizations_select" ON "organizations" FOR SELECT USING (
    app_is_platform_admin()
    OR "id" = app_current_organization()
    OR EXISTS (
        -- SUSPENDED is included deliberately. A suspended member is still a
        -- member: hiding the organization from them would force the API to
        -- answer "not found", which is both untrue and unhelpful. Whether they
        -- may *do* anything is an application decision, and the application
        -- refuses them with MEMBERSHIP_SUSPENDED. REMOVED members are excluded —
        -- for them the organization genuinely is gone.
        SELECT 1 FROM "organization_memberships" m
        WHERE m."organization_id" = "organizations"."id"
          AND m."user_id" = app_current_user_id()
          AND m."status" IN ('ACTIVE', 'SUSPENDED')
    )
);

-- You may only create an organization you are recorded as creating.
CREATE POLICY "organizations_insert" ON "organizations" FOR INSERT WITH CHECK (
    app_is_platform_admin()
    OR "created_by_user_id" = app_current_user_id()
);

-- Updates require the row to be the resolved tenant, both before and after, so
-- an update cannot move a row into another tenant.
CREATE POLICY "organizations_update" ON "organizations" FOR UPDATE
    USING (app_is_platform_admin() OR "id" = app_current_organization())
    WITH CHECK (app_is_platform_admin() OR "id" = app_current_organization());

-- Deletion is reserved for platform administration; organizations are closed,
-- not deleted (§40).
CREATE POLICY "organizations_delete" ON "organizations" FOR DELETE USING (
    app_is_platform_admin()
);

-- --- organization_memberships ---------------------------------------------
ALTER TABLE "organization_memberships" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "organization_memberships" FORCE ROW LEVEL SECURITY;

CREATE POLICY "organization_memberships_select" ON "organization_memberships" FOR SELECT USING (
    app_is_platform_admin()
    OR "organization_id" = app_current_organization()
    -- Your own memberships, so you can list the organizations you belong to.
    OR "user_id" = app_current_user_id()
);

-- Writes are always confined to the resolved tenant: unlike SELECT, there is no
-- "your own row" escape hatch, so a member cannot edit their own standing.
CREATE POLICY "organization_memberships_insert" ON "organization_memberships" FOR INSERT WITH CHECK (
    app_is_platform_admin() OR "organization_id" = app_current_organization()
);

CREATE POLICY "organization_memberships_update" ON "organization_memberships" FOR UPDATE
    USING (app_is_platform_admin() OR "organization_id" = app_current_organization())
    WITH CHECK (app_is_platform_admin() OR "organization_id" = app_current_organization());

CREATE POLICY "organization_memberships_delete" ON "organization_memberships" FOR DELETE USING (
    app_is_platform_admin() OR "organization_id" = app_current_organization()
);

-- --- organization_invitations ---------------------------------------------
ALTER TABLE "organization_invitations" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "organization_invitations" FORCE ROW LEVEL SECURITY;

CREATE POLICY "organization_invitations_all" ON "organization_invitations" FOR ALL
    USING (app_is_platform_admin() OR "organization_id" = app_current_organization())
    WITH CHECK (app_is_platform_admin() OR "organization_id" = app_current_organization());

-- --- organization_verification_requests -----------------------------------
ALTER TABLE "organization_verification_requests" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "organization_verification_requests" FORCE ROW LEVEL SECURITY;

CREATE POLICY "organization_verification_requests_all" ON "organization_verification_requests" FOR ALL
    USING (app_is_platform_admin() OR "organization_id" = app_current_organization())
    WITH CHECK (app_is_platform_admin() OR "organization_id" = app_current_organization());

-- --- user_roles ------------------------------------------------------------
-- Global assignments (organization_id IS NULL) must stay visible with no tenant
-- context, because authentication resolves a user's platform roles before any
-- organization is known. Organization-scoped rows follow the tenant, so signing
-- in never discloses which organizations a user belongs to through their roles.
ALTER TABLE "user_roles" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "user_roles" FORCE ROW LEVEL SECURITY;

CREATE POLICY "user_roles_select" ON "user_roles" FOR SELECT USING (
    "organization_id" IS NULL
    OR app_is_platform_admin()
    OR "organization_id" = app_current_organization()
    -- Your own assignments, so the organization switcher can show which role
    -- you hold in each organization you belong to. This discloses nothing about
    -- other people or other tenants: the row is about the caller.
    OR "user_id" = app_current_user_id()
);

-- Writes.
--
-- Row-level security here is the *tenant* boundary, and a global role
-- assignment is not tenant data: self-registration grants SERVICE_USER with no
-- administrator and no organization in sight, and requiring elevation for that
-- would mean running ordinary sign-ups with cross-tenant powers — strictly
-- worse. Global rows are therefore governed by application authorization (the
-- admin:role:assign permission, the administrative endpoint, and an audit
-- record), which is where that decision belongs.
--
-- What these policies guarantee is the part RLS is actually for: an
-- organization-scoped assignment can only ever be written inside its own
-- tenant, so no bug in the application layer can grant someone a role in an
-- organization the request is not scoped to.
CREATE POLICY "user_roles_insert" ON "user_roles" FOR INSERT WITH CHECK (
    "organization_id" IS NULL
    OR app_is_platform_admin()
    OR "organization_id" = app_current_organization()
);

CREATE POLICY "user_roles_update" ON "user_roles" FOR UPDATE
    USING (
        "organization_id" IS NULL
        OR app_is_platform_admin()
        OR "organization_id" = app_current_organization()
    )
    WITH CHECK (
        "organization_id" IS NULL
        OR app_is_platform_admin()
        OR "organization_id" = app_current_organization()
    );

CREATE POLICY "user_roles_delete" ON "user_roles" FOR DELETE USING (
    "organization_id" IS NULL
    OR app_is_platform_admin()
    OR "organization_id" = app_current_organization()
);

-- ===========================================================================
-- 5. The least-privileged application database role
--
--    The request path must not run as a superuser and must not hold BYPASSRLS,
--    or every policy above is decoration (§16). This creates the role with the
--    right privileges and, deliberately, NO PASSWORD and NOLOGIN:
--
--      * a password in a committed migration would be a committed secret;
--      * NOLOGIN means a half-provisioned deployment fails closed.
--
--    An operator (or `pnpm db:provision-app-role`) then runs:
--
--      ALTER ROLE palcert_app LOGIN PASSWORD '<from the secret manager>';
--
--    Idempotent: re-running the migration on a cluster that already has the
--    role leaves it alone rather than failing.
-- ===========================================================================
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'palcert_app') THEN
        CREATE ROLE palcert_app NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS;
    ELSE
        -- Never let a previously mis-provisioned role keep dangerous attributes.
        ALTER ROLE palcert_app NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;
    END IF;
END
$$;

GRANT USAGE ON SCHEMA public TO palcert_app;

-- Data access, but no DDL: the application can never alter a table, drop a
-- policy, or disable row-level security on itself.
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO palcert_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO palcert_app;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO palcert_app;

-- Tables added by later phases inherit the same grants automatically, so a new
-- table is never accidentally unreachable — while still being caught by the
-- coverage test if it is tenant-scoped and unclassified.
ALTER DEFAULT PRIVILEGES IN SCHEMA public
    GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO palcert_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
    GRANT USAGE, SELECT ON SEQUENCES TO palcert_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
    GRANT EXECUTE ON FUNCTIONS TO palcert_app;

-- The migration catalogue is owner-only: the application has no business
-- reading or rewriting migration history. Guarded because the table is created
-- by the Prisma CLI, and this migration must also apply when replayed directly.
DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM pg_tables
        WHERE schemaname = 'public' AND tablename = '_prisma_migrations'
    ) THEN
        REVOKE ALL ON TABLE "_prisma_migrations" FROM palcert_app;
    END IF;
END
$$;
-- The isolation catalogue is read-only to the application (the coverage test
-- reads it); only a migration may change a classification.
REVOKE INSERT, UPDATE, DELETE ON TABLE "table_isolation_classification" FROM palcert_app;

-- ===========================================================================
-- 6. Organization role permissions
--
--    Phase 1 seeded the organization roles with no permissions, because the
--    entities they would have governed did not exist. They do now.
-- ===========================================================================
INSERT INTO "permissions" ("id", "code", "description") VALUES
    (gen_random_uuid(), 'organization:profile:read',         'Read the organization profile'),
    (gen_random_uuid(), 'organization:profile:update',       'Update the organization profile'),
    (gen_random_uuid(), 'organization:member:read',          'List organization members'),
    (gen_random_uuid(), 'organization:member:invite',        'Invite a person to the organization'),
    (gen_random_uuid(), 'organization:member:update',        'Suspend or reactivate a member'),
    (gen_random_uuid(), 'organization:member:remove',        'Remove a member from the organization'),
    (gen_random_uuid(), 'organization:role:assign',          'Grant an organization role'),
    (gen_random_uuid(), 'organization:role:remove',          'Remove an organization role'),
    (gen_random_uuid(), 'organization:verification:request', 'Request organization verification'),
    (gen_random_uuid(), 'organization:verification:read',    'Read organization verification status'),
    (gen_random_uuid(), 'organization:ownership:transfer',   'Transfer organization ownership'),
    (gen_random_uuid(), 'admin:organization:read',           'Read any organization'),
    (gen_random_uuid(), 'admin:organization:verify',         'Approve or reject organization verification'),
    (gen_random_uuid(), 'admin:organization:suspend',        'Suspend or reactivate an organization');

INSERT INTO "role_permissions" ("role_id", "permission_id")
SELECT r."id", p."id"
FROM "roles" r
JOIN "permissions" p ON TRUE
WHERE
    -- Every organization member can see the organization and who is in it.
    (r."code" IN ('ORGANIZATION_OWNER', 'ORGANIZATION_ADMIN', 'ORGANIZATION_REVIEWER', 'TEMPLATE_MANAGER')
        AND p."code" IN ('organization:profile:read', 'organization:member:read',
                         'organization:verification:read'))
    -- Owners and admins run the organization day to day.
 OR (r."code" IN ('ORGANIZATION_OWNER', 'ORGANIZATION_ADMIN')
        AND p."code" IN ('organization:profile:update', 'organization:member:invite',
                         'organization:member:update', 'organization:member:remove',
                         'organization:role:assign', 'organization:role:remove',
                         'organization:verification:request'))
    -- Only the owner may hand the organization to someone else.
 OR (r."code" = 'ORGANIZATION_OWNER' AND p."code" = 'organization:ownership:transfer')
    -- Platform staff: read for support/finance/audit, act for admin only.
 OR (r."code" IN ('PALCERT_ADMIN', 'PALCERT_SUPPORT', 'PALCERT_FINANCE', 'PALCERT_AUDITOR')
        AND p."code" = 'admin:organization:read')
 OR (r."code" = 'PALCERT_ADMIN'
        AND p."code" IN ('admin:organization:verify', 'admin:organization:suspend'));
