-- Phase 1 — Identity, authentication, sessions and RBAC.
--
-- Adds the user, role, permission, session, credential-token, MFA and audit
-- tables. The Phase 0 baseline migration is left untouched (Master Prompt 45).
--
-- Beyond the generated DDL this migration adds three guarantees that the schema
-- language cannot express, at the end of the file:
--   1. NULLS NOT DISTINCT on the user/role/organization uniqueness, so a global
--      role (organization_id IS NULL) cannot be granted to the same user twice.
--   2. A composite foreign key plus check constraint making it impossible to
--      grant an organization-scoped role without an organization, or a global
--      role with one.
--   3. Seeding of the role and permission catalogue.

-- CreateEnum
CREATE TYPE "UserStatus" AS ENUM ('PENDING_VERIFICATION', 'ACTIVE', 'SUSPENDED', 'DISABLED');

-- CreateEnum
CREATE TYPE "RoleScope" AS ENUM ('GLOBAL', 'ORGANIZATION');

-- CreateEnum
CREATE TYPE "SessionState" AS ENUM ('PENDING_MFA', 'ACTIVE', 'REVOKED');

-- CreateEnum
CREATE TYPE "AssuranceLevel" AS ENUM ('AAL1', 'AAL2');

-- CreateEnum
CREATE TYPE "SessionRevocationReason" AS ENUM ('EXPIRED', 'USER_LOGOUT', 'USER_LOGOUT_ALL', 'USER_REVOKED', 'PASSWORD_CHANGED', 'PASSWORD_RESET', 'ACCOUNT_SUSPENDED', 'ACCOUNT_DISABLED', 'ADMIN_REVOKED', 'SESSION_ROTATED', 'MFA_CHANGED');

-- CreateEnum
CREATE TYPE "MfaAuthenticatorType" AS ENUM ('TOTP');

-- CreateTable
CREATE TABLE "users" (
    "id" UUID NOT NULL,
    "email" TEXT NOT NULL,
    "normalized_email" TEXT NOT NULL,
    "password_hash" TEXT NOT NULL,
    "password_algorithm" TEXT NOT NULL,
    "password_changed_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "email_verified_at" TIMESTAMP(3),
    "status" "UserStatus" NOT NULL DEFAULT 'PENDING_VERIFICATION',
    "display_name" TEXT,
    "preferred_locale" TEXT NOT NULL DEFAULT 'en',
    "mfa_required_override" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "last_login_at" TIMESTAMP(3),

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "permissions" (
    "id" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "description" TEXT NOT NULL,

    CONSTRAINT "permissions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "roles" (
    "id" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "scope" "RoleScope" NOT NULL,
    "description" TEXT NOT NULL,
    "requires_mfa" BOOLEAN NOT NULL DEFAULT false,
    "is_system" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "roles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "role_permissions" (
    "role_id" UUID NOT NULL,
    "permission_id" UUID NOT NULL,

    CONSTRAINT "role_permissions_pkey" PRIMARY KEY ("role_id","permission_id")
);

-- CreateTable
CREATE TABLE "user_roles" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "role_id" UUID NOT NULL,
    "organization_id" UUID,
    "scope" "RoleScope" NOT NULL,
    "granted_by_user_id" UUID,
    "granted_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "user_roles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sessions" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "token_hash" TEXT NOT NULL,
    "csrf_token_hash" TEXT NOT NULL,
    "state" "SessionState" NOT NULL DEFAULT 'ACTIVE',
    "assurance_level" "AssuranceLevel" NOT NULL DEFAULT 'AAL1',
    "mfa_completed_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_activity_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "absolute_expires_at" TIMESTAMP(3) NOT NULL,
    "idle_expires_at" TIMESTAMP(3) NOT NULL,
    "ip_address" TEXT,
    "user_agent" TEXT,
    "revoked_at" TIMESTAMP(3),
    "revocation_reason" "SessionRevocationReason",

    CONSTRAINT "sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "email_verification_tokens" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "token_hash" TEXT NOT NULL,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "consumed_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "email_verification_tokens_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "password_reset_tokens" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "token_hash" TEXT NOT NULL,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "consumed_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "password_reset_tokens_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "mfa_authenticators" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "type" "MfaAuthenticatorType" NOT NULL DEFAULT 'TOTP',
    "secret_ciphertext" TEXT NOT NULL,
    "secret_iv" TEXT NOT NULL,
    "secret_auth_tag" TEXT NOT NULL,
    "confirmed_at" TIMESTAMP(3),
    "last_used_at" TIMESTAMP(3),
    "last_accepted_counter" BIGINT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "mfa_authenticators_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "mfa_recovery_codes" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "code_hash" TEXT NOT NULL,
    "consumed_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "mfa_recovery_codes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "security_events" (
    "id" UUID NOT NULL,
    "type" TEXT NOT NULL,
    "user_id" UUID,
    "actor_user_id" UUID,
    "request_id" TEXT,
    "ip_address" TEXT,
    "user_agent" TEXT,
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "security_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "audit_events" (
    "id" UUID NOT NULL,
    "action" TEXT NOT NULL,
    "actor_user_id" UUID,
    "target_type" TEXT NOT NULL,
    "target_id" TEXT,
    "request_id" TEXT,
    "ip_address" TEXT,
    "before_state" JSONB,
    "after_state" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "users_normalized_email_key" ON "users"("normalized_email");

-- CreateIndex
CREATE INDEX "users_status_idx" ON "users"("status");

-- CreateIndex
CREATE INDEX "users_created_at_idx" ON "users"("created_at");

-- CreateIndex
CREATE UNIQUE INDEX "permissions_code_key" ON "permissions"("code");

-- CreateIndex
CREATE UNIQUE INDEX "roles_code_key" ON "roles"("code");

-- CreateIndex
CREATE UNIQUE INDEX "roles_id_scope_key" ON "roles"("id", "scope");

-- CreateIndex
CREATE INDEX "role_permissions_permission_id_idx" ON "role_permissions"("permission_id");

-- CreateIndex
CREATE INDEX "user_roles_user_id_idx" ON "user_roles"("user_id");

-- CreateIndex
CREATE INDEX "user_roles_role_id_idx" ON "user_roles"("role_id");

-- CreateIndex
CREATE INDEX "user_roles_organization_id_idx" ON "user_roles"("organization_id");

-- CreateIndex
CREATE UNIQUE INDEX "user_roles_user_role_org_key" ON "user_roles"("user_id", "role_id", "organization_id");

-- CreateIndex
CREATE UNIQUE INDEX "sessions_token_hash_key" ON "sessions"("token_hash");

-- CreateIndex
CREATE INDEX "sessions_user_id_state_idx" ON "sessions"("user_id", "state");

-- CreateIndex
CREATE INDEX "sessions_absolute_expires_at_idx" ON "sessions"("absolute_expires_at");

-- CreateIndex
CREATE UNIQUE INDEX "email_verification_tokens_token_hash_key" ON "email_verification_tokens"("token_hash");

-- CreateIndex
CREATE INDEX "email_verification_tokens_user_id_idx" ON "email_verification_tokens"("user_id");

-- CreateIndex
CREATE INDEX "email_verification_tokens_expires_at_idx" ON "email_verification_tokens"("expires_at");

-- CreateIndex
CREATE UNIQUE INDEX "password_reset_tokens_token_hash_key" ON "password_reset_tokens"("token_hash");

-- CreateIndex
CREATE INDEX "password_reset_tokens_user_id_idx" ON "password_reset_tokens"("user_id");

-- CreateIndex
CREATE INDEX "password_reset_tokens_expires_at_idx" ON "password_reset_tokens"("expires_at");

-- CreateIndex
CREATE INDEX "mfa_authenticators_user_id_idx" ON "mfa_authenticators"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "mfa_recovery_codes_code_hash_key" ON "mfa_recovery_codes"("code_hash");

-- CreateIndex
CREATE INDEX "mfa_recovery_codes_user_id_idx" ON "mfa_recovery_codes"("user_id");

-- CreateIndex
CREATE INDEX "security_events_user_id_created_at_idx" ON "security_events"("user_id", "created_at");

-- CreateIndex
CREATE INDEX "security_events_type_created_at_idx" ON "security_events"("type", "created_at");

-- CreateIndex
CREATE INDEX "security_events_created_at_idx" ON "security_events"("created_at");

-- CreateIndex
CREATE INDEX "audit_events_actor_user_id_created_at_idx" ON "audit_events"("actor_user_id", "created_at");

-- CreateIndex
CREATE INDEX "audit_events_target_type_target_id_idx" ON "audit_events"("target_type", "target_id");

-- CreateIndex
CREATE INDEX "audit_events_action_created_at_idx" ON "audit_events"("action", "created_at");

-- AddForeignKey
ALTER TABLE "role_permissions" ADD CONSTRAINT "role_permissions_role_id_fkey" FOREIGN KEY ("role_id") REFERENCES "roles"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "role_permissions" ADD CONSTRAINT "role_permissions_permission_id_fkey" FOREIGN KEY ("permission_id") REFERENCES "permissions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_roles" ADD CONSTRAINT "user_roles_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_roles" ADD CONSTRAINT "user_roles_role_id_fkey" FOREIGN KEY ("role_id") REFERENCES "roles"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_roles" ADD CONSTRAINT "user_roles_granted_by_user_id_fkey" FOREIGN KEY ("granted_by_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "email_verification_tokens" ADD CONSTRAINT "email_verification_tokens_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "password_reset_tokens" ADD CONSTRAINT "password_reset_tokens_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "mfa_authenticators" ADD CONSTRAINT "mfa_authenticators_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "mfa_recovery_codes" ADD CONSTRAINT "mfa_recovery_codes_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "security_events" ADD CONSTRAINT "security_events_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;


-- ---------------------------------------------------------------------------
-- 1. Treat NULL organization_id as a value for uniqueness purposes.
--    Without this, PostgreSQL considers every NULL distinct and a user could
--    hold the same global role any number of times.
-- ---------------------------------------------------------------------------
DROP INDEX "user_roles_user_role_org_key";
CREATE UNIQUE INDEX "user_roles_user_role_org_key"
    ON "user_roles" ("user_id", "role_id", "organization_id") NULLS NOT DISTINCT;

-- ---------------------------------------------------------------------------
-- 2. Scope integrity.
--    The composite FK forces user_roles.scope to equal the referenced role's
--    scope; the check constraint then ties scope to organization_id. Together
--    they make privilege escalation by way of a mis-scoped grant impossible at
--    the storage layer, not merely in application code.
-- ---------------------------------------------------------------------------
ALTER TABLE "user_roles"
    ADD CONSTRAINT "user_roles_role_scope_fkey"
    FOREIGN KEY ("role_id", "scope") REFERENCES "roles" ("id", "scope")
    ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "user_roles"
    ADD CONSTRAINT "user_roles_scope_organization_check"
    CHECK (
        ("scope" = 'GLOBAL' AND "organization_id" IS NULL)
        OR ("scope" = 'ORGANIZATION' AND "organization_id" IS NOT NULL)
    );

-- ---------------------------------------------------------------------------
-- 3. Role and permission catalogue.
--    Seeded here (not by an application script) so every environment — including
--    a fresh test database — has an identical, reviewable authorization model.
--    The API reconciles this against the code catalogue at boot.
-- ---------------------------------------------------------------------------
INSERT INTO "permissions" ("id", "code", "description") VALUES
    (gen_random_uuid(), 'profile:read:self',       'Read your own profile'),
    (gen_random_uuid(), 'profile:update:self',     'Update your own profile'),
    (gen_random_uuid(), 'session:read:self',       'List your own active sessions'),
    (gen_random_uuid(), 'session:revoke:self',     'Revoke your own sessions'),
    (gen_random_uuid(), 'password:change:self',    'Change your own password'),
    (gen_random_uuid(), 'mfa:manage:self',         'Manage your own multi-factor authenticators'),
    (gen_random_uuid(), 'admin:user:read',         'Read any user account'),
    (gen_random_uuid(), 'admin:user:suspend',      'Suspend a user account'),
    (gen_random_uuid(), 'admin:user:reactivate',   'Reactivate a suspended user account'),
    (gen_random_uuid(), 'admin:role:assign',       'Grant a global role to a user'),
    (gen_random_uuid(), 'admin:role:remove',       'Remove a global role from a user'),
    (gen_random_uuid(), 'admin:session:revoke',    'Revoke another user''s sessions'),
    (gen_random_uuid(), 'audit:event:read',        'Read audit records');

INSERT INTO "roles" ("id", "code", "scope", "description", "requires_mfa", "is_system") VALUES
    (gen_random_uuid(), 'STUDENT',               'GLOBAL',       'A student submitting academic documents for compliance checking.', false, true),
    (gen_random_uuid(), 'SERVICE_USER',          'GLOBAL',       'A general PalCert customer. Default role on self-registration.',   false, true),
    (gen_random_uuid(), 'ORGANIZATION_OWNER',    'ORGANIZATION', 'Owns an organization tenant. Capabilities defined in Phase 2.',    false, true),
    (gen_random_uuid(), 'ORGANIZATION_ADMIN',    'ORGANIZATION', 'Administers an organization tenant. Capabilities defined in Phase 2.', false, true),
    (gen_random_uuid(), 'ORGANIZATION_REVIEWER', 'ORGANIZATION', 'Reviews official submissions. Capabilities defined in Phase 2.',   false, true),
    (gen_random_uuid(), 'TEMPLATE_MANAGER',      'ORGANIZATION', 'Manages standards and rules. Capabilities defined in Phase 3.',    false, true),
    (gen_random_uuid(), 'PALCERT_ADMIN',         'GLOBAL',       'PalCert platform administrator.',                                  true,  true),
    (gen_random_uuid(), 'PALCERT_FINANCE',       'GLOBAL',       'PalCert finance staff. Billing capabilities arrive in Phase 10.',  true,  true),
    (gen_random_uuid(), 'PALCERT_SUPPORT',       'GLOBAL',       'PalCert support staff. Deliberately cannot assign roles or suspend accounts — support must not be a path to administrator.', false, true),
    (gen_random_uuid(), 'PALCERT_AUDITOR',       'GLOBAL',       'Read-only access to audit records.',                               true,  true),
    (gen_random_uuid(), 'API_CLIENT',            'GLOBAL',       'Machine integration identity. Credential issuance is a later phase.', false, true);

-- Role → permission mapping.
INSERT INTO "role_permissions" ("role_id", "permission_id")
SELECT r."id", p."id"
FROM "roles" r
JOIN "permissions" p ON TRUE
WHERE
    (r."code" IN ('STUDENT', 'SERVICE_USER', 'PALCERT_SUPPORT')
        AND p."code" IN ('profile:read:self', 'profile:update:self', 'session:read:self',
                         'session:revoke:self', 'password:change:self', 'mfa:manage:self'))
 OR (r."code" = 'PALCERT_SUPPORT' AND p."code" = 'admin:user:read')
 OR (r."code" = 'PALCERT_FINANCE'
        AND p."code" IN ('profile:read:self', 'profile:update:self', 'session:read:self',
                         'session:revoke:self', 'password:change:self', 'mfa:manage:self',
                         'admin:user:read'))
 OR (r."code" = 'PALCERT_AUDITOR'
        AND p."code" IN ('profile:read:self', 'profile:update:self', 'session:read:self',
                         'session:revoke:self', 'password:change:self', 'mfa:manage:self',
                         'admin:user:read', 'audit:event:read'))
 OR (r."code" = 'PALCERT_ADMIN');
