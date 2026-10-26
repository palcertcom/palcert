-- =============================================================================
-- Phase 19 — Organization-owned API clients and machine authentication
--
-- Three tables, and the reason there are three rather than one is the whole
-- design:
--
--   api_clients            the credential *holder*: who it belongs to, what it
--                          may reach, whether it is alive.
--   api_client_secrets     the credential *material*: a one-way verifier and
--                          nothing else, one row per secret ever issued, so a
--                          rotation is two rows rather than an overwrite.
--   api_client_operations  the durable identity of a management mutation, so a
--                          retried create or rotate returns the first answer
--                          instead of minting a second credential.
--
-- Splitting the secret out is what makes rotation expressible. An overlap is
-- two live rows with different statuses and an end time on the older one; with
-- a secret column on the client there would be nowhere to put the second one,
-- and "rotation" would mean "overwrite and hope the deploy was quick".
-- =============================================================================

CREATE TYPE "ApiClientStatus" AS ENUM ('ACTIVE', 'DISABLED', 'REVOKED');
CREATE TYPE "ApiClientSecretStatus" AS ENUM ('ACTIVE', 'ROTATING_OUT', 'RETIRED');

-- =============================================================================
-- 1. The credential holder
-- =============================================================================
-- Sorted, distinct, and nothing blank. IMMUTABLE so a CHECK may call it: the
-- answer depends only on the argument, which is what lets PostgreSQL index and
-- constrain on it.
CREATE OR REPLACE FUNCTION api_client_scopes_canonical(scopes TEXT[]) RETURNS boolean
LANGUAGE sql IMMUTABLE STRICT AS $$
    SELECT scopes = (SELECT array_agg(DISTINCT s ORDER BY s) FROM unnest(scopes) AS s)
       AND NOT EXISTS (SELECT 1 FROM unnest(scopes) AS s WHERE s IS NULL OR length(s) = 0);
$$;

CREATE TABLE "api_clients" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,

    -- The public identifier the caller presents. Unique platform-wide rather
    -- than per organization: it arrives before any tenant is known, so lookup
    -- has exactly one row to find and cannot depend on context it does not yet
    -- have.
    "client_id" TEXT NOT NULL,

    "display_name" TEXT NOT NULL,
    "description" TEXT,

    "status" "ApiClientStatus" NOT NULL DEFAULT 'ACTIVE',

    -- The scopes this client holds. A text[] over a closed vocabulary the
    -- application validates, kept sorted and distinct by a constraint so two
    -- clients with the same authority have the same stored value and a
    -- reviewer comparing them is comparing like with like.
    "scopes" TEXT[] NOT NULL,

    "created_by_user_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    "expires_at" TIMESTAMPTZ(6),
    "disabled_at" TIMESTAMPTZ(6),
    "revoked_at" TIMESTAMPTZ(6),
    "revoked_by_user_id" UUID,

    -- Truncated to the minute by the application before it is written. A
    -- second-level last-used across a set of clients starts to describe a
    -- customer's internal schedule, which is not PalCert's to publish back.
    "last_used_at" TIMESTAMPTZ(6),

    CONSTRAINT "api_clients_pkey" PRIMARY KEY ("id"),

    CONSTRAINT "api_clients_client_id_shape" CHECK (
        "client_id" ~ '^pcid_[0-9a-f]{32}$'
    ),
    CONSTRAINT "api_clients_display_name_bounded" CHECK (
        length("display_name") BETWEEN 1 AND 120
    ),
    CONSTRAINT "api_clients_description_bounded" CHECK (
        "description" IS NULL OR length("description") BETWEEN 1 AND 500
    ),

    -- At least one scope. A client holding none could call nothing, so it is
    -- not a restricted client — it is a credential that exists for no reason,
    -- and one somebody may later widen by editing rather than by deciding.
    CONSTRAINT "api_clients_scopes_present" CHECK (cardinality("scopes") >= 1),
    CONSTRAINT "api_clients_scopes_bounded" CHECK (cardinality("scopes") <= 32),
    -- Sorted and distinct, enforced rather than trusted. Through an IMMUTABLE
    -- helper because PostgreSQL forbids a subquery in a CHECK, and the
    -- alternative — trusting the service to sort — is exactly the kind of
    -- invariant that holds until the second writer is added.
    CONSTRAINT "api_clients_scopes_canonical" CHECK (api_client_scopes_canonical("scopes")),

    -- The status fields and the timestamps must agree. Without this a row could
    -- say ACTIVE and carry a revocation date, and two readers would disagree
    -- about whether the credential works.
    CONSTRAINT "api_clients_revocation_shape" CHECK (
        ("status" = 'REVOKED' AND "revoked_at" IS NOT NULL AND "revoked_by_user_id" IS NOT NULL)
        OR ("status" <> 'REVOKED' AND "revoked_at" IS NULL AND "revoked_by_user_id" IS NULL)
    ),
    CONSTRAINT "api_clients_disabled_shape" CHECK (
        ("status" = 'DISABLED' AND "disabled_at" IS NOT NULL)
        OR ("status" <> 'DISABLED' AND "disabled_at" IS NULL)
    ),

    CONSTRAINT "api_clients_organization_fk"
        FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT,
    CONSTRAINT "api_clients_created_by_fk"
        FOREIGN KEY ("created_by_user_id") REFERENCES "users"("id") ON DELETE RESTRICT,
    CONSTRAINT "api_clients_revoked_by_fk"
        FOREIGN KEY ("revoked_by_user_id") REFERENCES "users"("id") ON DELETE RESTRICT
);

CREATE UNIQUE INDEX "api_clients_client_id_key" ON "api_clients"("client_id");
CREATE INDEX "api_clients_organization_idx" ON "api_clients"("organization_id", "created_at" DESC);
-- Counting an organization's live clients against its limit.
CREATE INDEX "api_clients_organization_live_idx"
    ON "api_clients"("organization_id")
    WHERE "status" <> 'REVOKED';

-- =============================================================================
-- 2. The credential material
--
-- One row per secret ever issued, and **no column can hold a secret**. What is
-- stored is an Argon2id verifier: a one-way function of the secret that can
-- answer "is this the same string?" and cannot produce the string. There is no
-- decrypt path because there is no ciphertext, which is the difference between
-- this and the Phase 17 keyring — a signing secret must be *used* again to sign,
-- so it is sealed; an inbound credential only ever has to be *compared*, so it
-- is hashed and PalCert genuinely cannot show it again.
-- =============================================================================
CREATE TABLE "api_client_secrets" (
    "id" UUID NOT NULL,
    "api_client_id" UUID NOT NULL,

    -- PHC-format Argon2id string: algorithm, parameters, salt and tag.
    -- Self-describing, so a parameter change does not invalidate old rows.
    "secret_verifier" TEXT NOT NULL,

    -- The first eight hex characters of the secret's own random part, stored so
    -- an administrator can tell two secrets apart in the UI and so a support
    -- conversation can name one without anybody pasting a credential. Eight
    -- characters of a 256-bit secret discloses nothing usable.
    "secret_hint" TEXT NOT NULL,

    "status" "ApiClientSecretStatus" NOT NULL DEFAULT 'ACTIVE',

    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by_user_id" UUID NOT NULL,

    -- When a ROTATING_OUT secret stops verifying. The application refuses it
    -- past this instant; the sweeper that flips the row to RETIRED is hygiene,
    -- not the authority for expiry — exactly as Phase 17 does with its reveal
    -- window, and for the same reason: a row nobody swept must not still work.
    "overlap_ends_at" TIMESTAMPTZ(6),
    "retired_at" TIMESTAMPTZ(6),

    "last_used_at" TIMESTAMPTZ(6),

    CONSTRAINT "api_client_secrets_pkey" PRIMARY KEY ("id"),

    CONSTRAINT "api_client_secrets_verifier_shape" CHECK (
        "secret_verifier" LIKE '$argon2id$%' AND length("secret_verifier") BETWEEN 40 AND 512
    ),
    CONSTRAINT "api_client_secrets_hint_shape" CHECK ("secret_hint" ~ '^[0-9a-f]{8}$'),

    CONSTRAINT "api_client_secrets_status_shape" CHECK (
        ("status" = 'ACTIVE' AND "overlap_ends_at" IS NULL AND "retired_at" IS NULL)
        OR ("status" = 'ROTATING_OUT' AND "overlap_ends_at" IS NOT NULL AND "retired_at" IS NULL)
        OR ("status" = 'RETIRED' AND "retired_at" IS NOT NULL)
    ),

    CONSTRAINT "api_client_secrets_client_fk"
        FOREIGN KEY ("api_client_id") REFERENCES "api_clients"("id") ON DELETE RESTRICT,
    CONSTRAINT "api_client_secrets_created_by_fk"
        FOREIGN KEY ("created_by_user_id") REFERENCES "users"("id") ON DELETE RESTRICT
);

-- **At most one ACTIVE secret per client**, held by the schema rather than by
-- the service. This is the constraint that makes "rotation cannot create an
-- accidental permanent second credential" a property of the database: a second
-- mint has to move the first one out of ACTIVE, and there is no code path that
-- can forget.
CREATE UNIQUE INDEX "api_client_secrets_one_active"
    ON "api_client_secrets"("api_client_id")
    WHERE "status" = 'ACTIVE';

-- And at most one on the way out, so an overlap is bounded to two live secrets
-- rather than however many rotations somebody fired concurrently.
CREATE UNIQUE INDEX "api_client_secrets_one_rotating_out"
    ON "api_client_secrets"("api_client_id")
    WHERE "status" = 'ROTATING_OUT';

CREATE INDEX "api_client_secrets_client_idx"
    ON "api_client_secrets"("api_client_id", "created_at" DESC);
-- The sweeper's query: overlaps that have elapsed.
CREATE INDEX "api_client_secrets_overlap_due_idx"
    ON "api_client_secrets"("overlap_ends_at")
    WHERE "status" = 'ROTATING_OUT';

-- =============================================================================
-- 3. Management operation identity (idempotency)
--
-- Modelled on the Phase 17 management-operation table, for the same reason and
-- with the same refusal: the key itself is never stored, only its hash, because
-- an idempotency key is a client-chosen token that may be reused elsewhere.
--
-- The secret-bearing operations carry a bounded reveal so an identical retry
-- returns the identical secret. Writing an HTTP response is not the same as a
-- client receiving one, and without this a lost 201 means a credential that
-- exists and that nobody holds.
-- =============================================================================
CREATE TABLE "api_client_operations" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,

    "operation" TEXT NOT NULL,
    -- Hex SHA-256, in the CHAR(64) shape Phase 17 already uses for the same
    -- job. Matching it is not cosmetic: the two idempotency stores are read by
    -- people debugging the same class of problem, and a value that looks
    -- different in one table than the other costs them a minute every time.
    "idempotency_key_hash" CHAR(64) NOT NULL,
    -- Binds the key to the request it was used for, so the same key with a
    -- different body is a conflict rather than a wrong replay.
    "request_fingerprint" CHAR(64) NOT NULL,

    "actor_user_id" UUID NOT NULL,
    "api_client_id" UUID,

    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    -- The show-once secret, held only until the recovery window closes, and
    -- sealed rather than stored: this is the one place an API-client secret
    -- exists at rest in a recoverable form, it is short-lived, and the read
    -- path refuses on time before it decrypts anything.
    --
    -- Four columns in the shape Phase 17 already uses for the same job, under
    -- the same AES-256-GCM helper. Reusing it rather than inventing a second
    -- envelope means one implementation to review and one place a mistake can
    -- be made.
    "reveal_ciphertext" TEXT,
    "reveal_iv" TEXT,
    "reveal_auth_tag" TEXT,
    "reveal_expires_at" TIMESTAMPTZ(6),

    CONSTRAINT "api_client_operations_pkey" PRIMARY KEY ("id"),

    CONSTRAINT "api_client_operations_operation_known" CHECK (
        "operation" IN ('CREATE_CLIENT', 'ROTATE_SECRET')
    ),
    CONSTRAINT "api_client_operations_key_hash_shape" CHECK (
        "idempotency_key_hash" ~ '^[0-9a-f]{64}$'
    ),
    CONSTRAINT "api_client_operations_fingerprint_shape" CHECK (
        "request_fingerprint" ~ '^[0-9a-f]{64}$'
    ),
    -- The four reveal columns are all present or all absent. A row with a
    -- ciphertext and no expiry would be an unbounded secret at rest, and one
    -- with a ciphertext and no auth tag could not be authenticated on the way
    -- back out.
    CONSTRAINT "api_client_operations_reveal_shape" CHECK (
        ("reveal_ciphertext" IS NULL
         AND "reveal_iv" IS NULL
         AND "reveal_auth_tag" IS NULL
         AND "reveal_expires_at" IS NULL)
        OR ("reveal_ciphertext" IS NOT NULL
            AND "reveal_iv" IS NOT NULL
            AND "reveal_auth_tag" IS NOT NULL
            AND "reveal_expires_at" IS NOT NULL)
    ),

    CONSTRAINT "api_client_operations_organization_fk"
        FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT,
    CONSTRAINT "api_client_operations_actor_fk"
        FOREIGN KEY ("actor_user_id") REFERENCES "users"("id") ON DELETE RESTRICT,
    CONSTRAINT "api_client_operations_client_fk"
        FOREIGN KEY ("api_client_id") REFERENCES "api_clients"("id") ON DELETE RESTRICT
);

-- One row per (organization, operation, key). Scoped to the organization so
-- one tenant's choice of key can never collide with another's — and can never
-- be used to probe whether another tenant used a given key.
CREATE UNIQUE INDEX "api_client_operations_key"
    ON "api_client_operations"("organization_id", "operation", "idempotency_key_hash");
CREATE INDEX "api_client_operations_reveal_due_idx"
    ON "api_client_operations"("reveal_expires_at")
    WHERE "reveal_ciphertext" IS NOT NULL;

-- =============================================================================
-- 4. Append-only history
--
-- A credential's history is evidence. An organization asking "when was this
-- revoked and by whom?" after an incident must get an answer that was not
-- editable afterwards, so the rows that record the past cannot be rewritten.
-- =============================================================================
CREATE OR REPLACE FUNCTION api_client_secrets_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    -- A secret's identity and its material never change. Only its lifecycle
    -- does, and only forwards: ACTIVE -> ROTATING_OUT -> RETIRED.
    IF NEW."id" <> OLD."id"
       OR NEW."api_client_id" <> OLD."api_client_id"
       OR NEW."secret_verifier" <> OLD."secret_verifier"
       OR NEW."secret_hint" <> OLD."secret_hint"
       OR NEW."created_at" <> OLD."created_at"
       OR NEW."created_by_user_id" <> OLD."created_by_user_id" THEN
        RAISE EXCEPTION 'api_client_secrets: identity and material are immutable';
    END IF;

    IF OLD."status" = 'RETIRED' AND NEW."status" <> 'RETIRED' THEN
        RAISE EXCEPTION 'api_client_secrets: RETIRED is final';
    END IF;
    IF OLD."status" = 'ROTATING_OUT' AND NEW."status" = 'ACTIVE' THEN
        RAISE EXCEPTION 'api_client_secrets: a rotated-out secret never becomes active again';
    END IF;

    RETURN NEW;
END;
$$;

CREATE TRIGGER "api_client_secrets_guard"
    BEFORE UPDATE ON "api_client_secrets"
    FOR EACH ROW EXECUTE FUNCTION api_client_secrets_guard();

CREATE OR REPLACE FUNCTION api_clients_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    IF NEW."id" <> OLD."id"
       OR NEW."organization_id" <> OLD."organization_id"
       OR NEW."client_id" <> OLD."client_id"
       OR NEW."created_at" <> OLD."created_at"
       OR NEW."created_by_user_id" <> OLD."created_by_user_id" THEN
        RAISE EXCEPTION 'api_clients: identity and ownership are immutable';
    END IF;

    -- REVOKED is final. Not a policy the service applies: a credential an
    -- organization was told is dead must not come back because a later code
    -- path set a status without checking.
    IF OLD."status" = 'REVOKED' AND NEW."status" <> 'REVOKED' THEN
        RAISE EXCEPTION 'api_clients: REVOKED is final';
    END IF;

    -- An update made in the system context *without* tenant context is the
    -- authentication path recording that the credential was used, and may touch
    -- exactly that. Without this, the UPDATE branch that lets authentication
    -- note a use would equally let it re-enable a disabled client or widen a
    -- scope set — an authority no code that runs *before* the caller is
    -- identified should hold.
    --
    -- Both terms are needed. The management service also sets the flag, but it
    -- does so inside a tenant transaction, so the organization is present and
    -- it is unaffected; and a statement with neither flag nor tenant never
    -- reaches this trigger, because the policy refuses it first.
    IF app_in_api_client_system_context() AND app_current_organization() IS NULL THEN
        IF NEW."status" IS DISTINCT FROM OLD."status"
           OR NEW."scopes" IS DISTINCT FROM OLD."scopes"
           OR NEW."display_name" IS DISTINCT FROM OLD."display_name"
           OR NEW."description" IS DISTINCT FROM OLD."description"
           OR NEW."expires_at" IS DISTINCT FROM OLD."expires_at"
           OR NEW."disabled_at" IS DISTINCT FROM OLD."disabled_at"
           OR NEW."revoked_at" IS DISTINCT FROM OLD."revoked_at"
           OR NEW."revoked_by_user_id" IS DISTINCT FROM OLD."revoked_by_user_id"
        THEN
            RAISE EXCEPTION 'api_clients: the authentication path may only record use';
        END IF;
    END IF;

    RETURN NEW;
END;
$$;

CREATE TRIGGER "api_clients_guard"
    BEFORE UPDATE ON "api_clients"
    FOR EACH ROW EXECUTE FUNCTION api_clients_guard();

CREATE OR REPLACE FUNCTION api_client_operations_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    -- Everything except the reveal columns is the operation's identity.
    IF NEW."id" <> OLD."id"
       OR NEW."organization_id" <> OLD."organization_id"
       OR NEW."operation" <> OLD."operation"
       OR NEW."idempotency_key_hash" <> OLD."idempotency_key_hash"
       OR NEW."request_fingerprint" <> OLD."request_fingerprint"
       OR NEW."actor_user_id" <> OLD."actor_user_id"
       OR NEW."created_at" <> OLD."created_at" THEN
        RAISE EXCEPTION 'api_client_operations: an operation''s identity is immutable';
    END IF;

    -- The reveal may only be cleared, never replaced. Re-sealing a different
    -- secret into a settled operation would make a retry return something the
    -- first caller never received.
    IF OLD."reveal_ciphertext" IS NOT NULL
       AND NEW."reveal_ciphertext" IS NOT NULL
       AND NEW."reveal_ciphertext" <> OLD."reveal_ciphertext" THEN
        RAISE EXCEPTION 'api_client_operations: a reveal may be cleared, never replaced';
    END IF;

    RETURN NEW;
END;
$$;

CREATE TRIGGER "api_client_operations_guard"
    BEFORE UPDATE ON "api_client_operations"
    FOR EACH ROW EXECUTE FUNCTION api_client_operations_guard();

-- =============================================================================
-- 5. Row-level security
--
-- `api_clients` is TENANT_SCOPED: an organization's administrators see their
-- own clients and nobody else's.
--
-- `api_client_secrets` and `api_client_operations` are SYSTEM. Neither is ever
-- read through a tenant context, because neither has anything a tenant should
-- see: one holds verifiers, the other holds a short-lived sealed secret. The
-- application reaches them through the authentication path, which runs without
-- any tenant context at all — the caller has not proved which tenant it is yet,
-- which is the question being answered.
-- =============================================================================
-- -----------------------------------------------------------------------------
-- The system context
--
-- Three of the accesses below cannot be expressed as tenant context, for one
-- reason: **authentication runs before any tenant is known.** Deciding which
-- organization the caller belongs to is the question being answered, so it
-- cannot also be the premise. The credential lookup reads `api_clients`
-- (TENANT_SCOPED), the verifier comparison reads `api_client_secrets`, and the
-- bookkeeping write touches `api_clients."last_used_at"` — all three with no
-- organization in hand.
--
-- The alternative, "allow when there is no tenant context", would grant every
-- request that merely forgot `withTenant`, which is the opposite of failing
-- closed. So the service states its intent instead: it sets
-- `palcert.api_client_system_context` for exactly the statements that need it,
-- and the flag is local to the transaction, so PostgreSQL discards it at COMMIT
-- and at ROLLBACK and a pooled connection cannot carry it into the next
-- request.
--
-- The Phase 17 webhook writer carries a second term, `current_user IS DISTINCT
-- FROM session_user`. It is **deliberately not copied here**, because it would
-- be unsatisfiable rather than protective. That term is true only inside a
-- SECURITY DEFINER body, and Phase 17 earns it by performing its system writes
-- *in* such functions: the endpoint lifecycle and key-rewrap transitions are
-- PL/pgSQL, and the application calls them. Phase 19's writes are ordinary
-- application statements — the service layer is the authority over a
-- credential's lifecycle — so the connection is `palcert_app` throughout,
-- `current_user` equals `session_user`, and the term would evaluate false for
-- every write PalCert actually makes. Carrying it would not harden the table;
-- it would close it.
--
-- What the flag does and does not claim, stated plainly: it separates the
-- API-client tables from every tenant-scoped code path, so no query written
-- against an organization's data can reach a verifier by accident, and every
-- statement that does reach one names itself. It is not a defence against the
-- application itself — `palcert_app` can call `set_config` — and it is not
-- meant to be. The verifiers are one-way; the secret that matters was never
-- stored. Making these writes forgery-proof against the API would mean moving
-- credential lifecycle into the database, which is the Phase 17 shape and is
-- recorded in the deferred roadmap rather than half-built here.
--
-- What the flag emphatically does *not* do is widen `api_clients`. The system
-- branch added to that table's SELECT and UPDATE policies is bounded twice
-- over: it cannot INSERT at all, and `api_clients_guard()` refuses any update
-- made without tenant context that changes more than `last_used_at`. The
-- authentication path can therefore read a credential and note that it was
-- used, and can do nothing else to it — it cannot re-enable a disabled client,
-- widen a scope set or move an expiry.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION app_in_api_client_system_context() RETURNS boolean
LANGUAGE sql STABLE AS $$
    SELECT COALESCE(current_setting('palcert.api_client_system_context', true), 'off') = 'on';
$$;

ALTER TABLE "api_clients" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "api_clients" FORCE ROW LEVEL SECURITY;

CREATE POLICY "api_clients_select" ON "api_clients" FOR SELECT USING (
    app_is_platform_admin()
    OR "organization_id" = app_current_organization()
    -- The credential lookup. See "The system context" above for why this cannot
    -- be a tenant read and what bounds it.
    OR app_in_api_client_system_context()
);

CREATE POLICY "api_clients_insert" ON "api_clients" FOR INSERT WITH CHECK (
    "organization_id" = app_current_organization()
);

-- No system branch on INSERT: a credential is only ever created by a named
-- administrator inside their own organization's context. The authentication
-- path cannot bring one into existence.
CREATE POLICY "api_clients_update" ON "api_clients" FOR UPDATE
    USING ("organization_id" = app_current_organization() OR app_in_api_client_system_context())
    WITH CHECK ("organization_id" = app_current_organization() OR app_in_api_client_system_context());

-- Nothing here is deletable: a credential's history is evidence, and revoking
-- ends it rather than erasing it. Written as a policy that refuses rather than
-- as an absent policy, which is the Phase 16 and Phase 17 convention — an
-- explicit `USING (false)` says "considered, and the answer is no", where a
-- missing policy is indistinguishable from an oversight. There is no DELETE
-- grant either, so the refusal holds at two layers.
CREATE POLICY "api_clients_delete" ON "api_clients" FOR DELETE USING (false);

ALTER TABLE "api_client_secrets" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "api_client_secrets" FORCE ROW LEVEL SECURITY;

-- Deliberately no tenant read path. A verifier is not something an
-- organization has any use for, and a policy that let a tenant read the table
-- would put every client's verifier one query-shape bug away from disclosure.
-- The two legitimate readers are the authentication path and the management
-- service, and both announce themselves.
CREATE POLICY "api_client_secrets_read" ON "api_client_secrets" FOR SELECT
    USING (app_is_platform_admin() OR app_in_api_client_system_context());

CREATE POLICY "api_client_secrets_insert" ON "api_client_secrets" FOR INSERT
    WITH CHECK (app_in_api_client_system_context());

CREATE POLICY "api_client_secrets_update" ON "api_client_secrets" FOR UPDATE
    USING (app_in_api_client_system_context())
    WITH CHECK (app_in_api_client_system_context());

ALTER TABLE "api_client_operations" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "api_client_operations" FORCE ROW LEVEL SECURITY;

-- The same, and for the same reason: the reveal column holds a short-lived
-- secret, so no tenant policy reaches this table either. The management service
-- is already inside a tenant context when it writes here, and still has to
-- announce itself — the organization check below is an additional condition,
-- never an alternative to the flag.
CREATE POLICY "api_client_operations_read" ON "api_client_operations" FOR SELECT
    USING (app_is_platform_admin() OR app_in_api_client_system_context());

CREATE POLICY "api_client_operations_insert" ON "api_client_operations" FOR INSERT
    WITH CHECK (app_in_api_client_system_context());

CREATE POLICY "api_client_operations_update" ON "api_client_operations" FOR UPDATE
    USING (app_in_api_client_system_context())
    WITH CHECK (app_in_api_client_system_context());

-- =============================================================================
-- 6. Grants — least privilege
--
-- No DELETE anywhere. Nothing here is deletable: a revoked client, a retired
-- secret and a settled operation are all records of what happened.
-- =============================================================================
REVOKE ALL ON "api_clients" FROM "palcert_app";
GRANT SELECT, INSERT, UPDATE ON "api_clients" TO "palcert_app";

REVOKE ALL ON "api_client_secrets" FROM "palcert_app";
GRANT SELECT, INSERT, UPDATE ON "api_client_secrets" TO "palcert_app";

REVOKE ALL ON "api_client_operations" FROM "palcert_app";
GRANT SELECT, INSERT, UPDATE ON "api_client_operations" TO "palcert_app";

GRANT EXECUTE ON FUNCTION app_in_api_client_system_context() TO "palcert_app";
GRANT EXECUTE ON FUNCTION api_client_scopes_canonical(TEXT[]) TO "palcert_app";
GRANT EXECUTE ON FUNCTION api_clients_guard() TO "palcert_app";
GRANT EXECUTE ON FUNCTION api_client_secrets_guard() TO "palcert_app";
GRANT EXECUTE ON FUNCTION api_client_operations_guard() TO "palcert_app";

-- =============================================================================
-- 7. The isolation catalogue
-- =============================================================================
INSERT INTO "table_isolation_classification" ("table_name", "classification", "tenant_column", "notes")
VALUES
    ('api_clients', 'TENANT_SCOPED', 'organization_id',
     'An organization''s machine credentials. Holds the public client id, the scopes and the lifecycle; never any secret material.'),
    ('api_client_secrets', 'SYSTEM', NULL,
     'One-way Argon2id verifiers. No tenant read path at all: an organization has no use for a verifier, and a policy granting one would put every client''s material behind a single query-shape bug. Authentication reads it before any tenant is known.'),
    ('api_client_operations', 'SYSTEM', NULL,
     'The durable identity of a management mutation. Stores the idempotency key''s hash and never the key, plus a bounded sealed reveal so a retried create returns the secret the first caller may never have received.')
ON CONFLICT ("table_name") DO UPDATE
    SET "classification" = EXCLUDED."classification",
        "tenant_column" = EXCLUDED."tenant_column",
        "notes" = EXCLUDED."notes";

-- =============================================================================
-- 8. Permissions
-- =============================================================================
INSERT INTO "permissions" ("id", "code", "description")
VALUES
    (gen_random_uuid(), 'integration:api-client:read',
     'See which machine credentials exist for this organization, and their scopes and usage.'),
    (gen_random_uuid(), 'integration:api-client:manage',
     'Create, rename, enable, disable and revoke this organization''s machine credentials.'),
    (gen_random_uuid(), 'integration:api-client:secret:issue',
     'Mint a machine credential secret, on creation or on rotation. The one act that returns one.')
ON CONFLICT ("code") DO NOTHING;

-- Granted to whichever roles already administer the organization, identified by
-- an anchor permission rather than by role code.
--
-- The same technique Phase 17 used, and for the same reason: naming
-- ORGANIZATION_OWNER and ORGANIZATION_ADMIN literally would silently skip a
-- deployment that had renamed a role or added a third administrative one, and
-- the result would be an organization whose administrators cannot manage their
-- own credentials. Anchoring on `organization:profile:update` asks the question
-- that actually matters: who already administers this organization?
INSERT INTO "role_permissions" ("role_id", "permission_id")
SELECT DISTINCT rp."role_id", p."id"
FROM "role_permissions" rp
JOIN "permissions" anchor
  ON anchor."id" = rp."permission_id" AND anchor."code" = 'organization:profile:update'
CROSS JOIN "permissions" p
WHERE p."code" IN (
    'integration:api-client:read',
    'integration:api-client:manage',
    'integration:api-client:secret:issue')
ON CONFLICT ("role_id", "permission_id") DO NOTHING;
