-- =============================================================================
-- Phase 17 — authority hardening
--
-- The Phase 17 tables were created with the right classification and the wrong
-- privileges. `palcert_app` held INSERT and UPDATE on every SYSTEM table, which
-- meant the boundary existed in the comments and in the services, and nowhere
-- that could enforce it. A route bug could have inserted a fabricated
-- WebhookEvent, rewritten an encrypted configuration, moved a delivery to
-- DELIVERED without sending anything, or forged attempt history.
--
-- This migration moves that boundary into the database. `palcert_app` loses
-- direct DML on every SYSTEM table; each legitimate write becomes a narrow
-- SECURITY DEFINER function that derives what it writes from an authoritative
-- row and refuses everything else. Reading follows the same rule: the tables
-- that hold ciphertext become unreadable to the application role, and an
-- organization sees its own configuration through projections that carry the
-- host and the port and never the key material.
--
-- Additive: Phase 0–16 migrations are untouched, and so are the five Phase 17
-- migrations before this one.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. Write modes
--
-- One GUC, read only through a function that also requires the role switch. A
-- transaction-local setting is forgeable by `palcert_app` — it can call
-- `set_config` as easily as anything else — so on its own it proves nothing.
-- What it cannot forge is `current_user`, which only becomes the function owner
-- inside a SECURITY DEFINER body. The flag says *which* narrow operation is in
-- progress; the role switch says the caller got there through one of these
-- functions at all.
--
-- The modes are deliberately not a hierarchy. A lifecycle transition must not
-- be able to rewrite crypto material, and a rewrap must not be able to activate
-- a configuration; if one mode implied the other, every function would carry
-- the authority of the widest one.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION app_webhook_write_mode() RETURNS text
LANGUAGE sql STABLE AS $$
    SELECT CASE
        WHEN current_user IS DISTINCT FROM session_user
        THEN COALESCE(current_setting('palcert.webhook_write_mode', true), 'off')
        ELSE 'off'
    END;
$$;

-- Kept for the two tenant-scoped tables' policies, now defined in terms of the
-- mode so there is one answer to "is this a system write" rather than two.
CREATE OR REPLACE FUNCTION app_is_webhook_system_writer() RETURNS boolean
LANGUAGE sql STABLE AS $$
    SELECT app_webhook_write_mode() IN ('system', 'lifecycle');
$$;

-- -----------------------------------------------------------------------------
-- 2. The endpoint guard
--
-- An endpoint becomes ACTIVE because a configuration proved reachable. Nothing
-- else may make it so — and until now nothing stopped a tenant-context
-- statement from setting `status='ACTIVE'` and pointing `current_config_version_id`
-- at an unverified row, which would have made verification decorative.
--
-- Ordinary editing is exactly one field. Everything that decides where events
-- go, or whether they go at all, requires a lifecycle function.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION webhook_endpoints_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    -- Never editable by anyone, through any path. These are the row's identity.
    IF NEW."id" IS DISTINCT FROM OLD."id"
       OR NEW."organization_id" IS DISTINCT FROM OLD."organization_id"
       OR NEW."created_by_user_id" IS DISTINCT FROM OLD."created_by_user_id"
       OR NEW."created_at" IS DISTINCT FROM OLD."created_at"
    THEN
        RAISE EXCEPTION 'webhook endpoint % identity is immutable', OLD."id";
    END IF;

    IF app_webhook_write_mode() IN ('system', 'lifecycle') THEN
        -- A disabled endpoint is a tombstone. Nothing revives it, because its
        -- slot has already been released and may belong to a replacement.
        IF OLD."status" = 'DISABLED' AND NEW."status" IS DISTINCT FROM OLD."status" THEN
            RAISE EXCEPTION 'webhook endpoint % is already DISABLED', OLD."id";
        END IF;
        RETURN NEW;
    END IF;

    -- Tenant context: the description, and nothing else.
    IF NEW."status" IS DISTINCT FROM OLD."status"
       OR NEW."slot" IS DISTINCT FROM OLD."slot"
       OR NEW."current_config_version_id" IS DISTINCT FROM OLD."current_config_version_id"
       OR NEW."pending_config_version_id" IS DISTINCT FROM OLD."pending_config_version_id"
       OR NEW."disabled_at" IS DISTINCT FROM OLD."disabled_at"
    THEN
        RAISE EXCEPTION
            'webhook endpoint % lifecycle changes only through a lifecycle function',
            OLD."id";
    END IF;

    RETURN NEW;
END;
$$;

CREATE TRIGGER "webhook_endpoints_guard_trigger"
    BEFORE UPDATE ON "webhook_endpoints"
    FOR EACH ROW EXECUTE FUNCTION webhook_endpoints_guard();

-- -----------------------------------------------------------------------------
-- 3. The configuration guard, in three modes
--
-- Default: refused. There is no such thing as an ordinary update to a
-- configuration version — it is immutable except for its lifecycle and its
-- cryptographic envelope, and those are different operations with different
-- authority.
--
-- The separation is the point. A lifecycle operation that could also rewrite
-- ciphertext would let an activation quietly re-point a URL; a rewrap that
-- could also set `status` would let a maintenance job activate a configuration
-- nobody verified.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION webhook_config_versions_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
    v_mode text := app_webhook_write_mode();
    v_envelope_changed boolean;
    v_lifecycle_changed boolean;
BEGIN
    -- Semantic identity. Immutable in every mode, which is what makes a rewrap
    -- safe to run over every row in the table: it cannot re-point a URL,
    -- because the metadata the worker compares against before every attempt is
    -- not writable here.
    IF NEW."id" IS DISTINCT FROM OLD."id"
       OR NEW."endpoint_id" IS DISTINCT FROM OLD."endpoint_id"
       OR NEW."version_number" IS DISTINCT FROM OLD."version_number"
       OR NEW."url_sha256" IS DISTINCT FROM OLD."url_sha256"
       OR NEW."host" IS DISTINCT FROM OLD."host"
       OR NEW."port" IS DISTINCT FROM OLD."port"
       OR NEW."secret_fingerprint" IS DISTINCT FROM OLD."secret_fingerprint"
       OR NEW."created_at" IS DISTINCT FROM OLD."created_at"
    THEN
        RAISE EXCEPTION 'webhook config version % identity is immutable', OLD."id";
    END IF;

    v_envelope_changed :=
        NEW."url_ciphertext" IS DISTINCT FROM OLD."url_ciphertext"
        OR NEW."url_iv" IS DISTINCT FROM OLD."url_iv"
        OR NEW."url_auth_tag" IS DISTINCT FROM OLD."url_auth_tag"
        OR NEW."url_encryption_key_id" IS DISTINCT FROM OLD."url_encryption_key_id"
        OR NEW."secret_ciphertext" IS DISTINCT FROM OLD."secret_ciphertext"
        OR NEW."secret_iv" IS DISTINCT FROM OLD."secret_iv"
        OR NEW."secret_auth_tag" IS DISTINCT FROM OLD."secret_auth_tag"
        OR NEW."secret_encryption_key_id" IS DISTINCT FROM OLD."secret_encryption_key_id";

    v_lifecycle_changed :=
        NEW."status" IS DISTINCT FROM OLD."status"
        OR NEW."verified_at" IS DISTINCT FROM OLD."verified_at"
        OR NEW."retired_at" IS DISTINCT FROM OLD."retired_at"
        OR NEW."last_verification_error" IS DISTINCT FROM OLD."last_verification_error"
        OR NEW."last_verification_at" IS DISTINCT FROM OLD."last_verification_at";

    IF v_mode = 'rewrap' THEN
        IF v_lifecycle_changed THEN
            RAISE EXCEPTION 'a webhook rewrap may not change lifecycle state';
        END IF;
        RETURN NEW;
    END IF;

    IF v_mode IN ('system', 'lifecycle') THEN
        IF v_envelope_changed THEN
            RAISE EXCEPTION 'a webhook lifecycle change may not rewrite crypto material';
        END IF;

        -- Terminal means terminal: a stale verification must not revive a
        -- configuration that was superseded while it was in flight.
        IF OLD."status" IN ('RETIRED', 'SUPERSEDED')
           AND NEW."status" IS DISTINCT FROM OLD."status"
        THEN
            RAISE EXCEPTION 'webhook config version % is already %', OLD."id", OLD."status";
        END IF;

        RETURN NEW;
    END IF;

    RAISE EXCEPTION
        'webhook config version % may only be changed by a lifecycle or rewrap function',
        OLD."id";
END;
$$;

-- -----------------------------------------------------------------------------
-- 4. The attempt guard
--
-- An attempt is written when it starts and closed once when it ends. Its parent
-- is part of its identity: an attempt that could be moved to another delivery
-- would let a failure be re-filed against a different integration, and a
-- verification attempt that could be moved to another configuration would let
-- one endpoint's successful handshake activate another's.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION webhook_attempt_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    IF NEW."id" IS DISTINCT FROM OLD."id"
       OR NEW."attempt_number" IS DISTINCT FROM OLD."attempt_number"
       OR NEW."started_at" IS DISTINCT FROM OLD."started_at"
       OR NEW."created_at" IS DISTINCT FROM OLD."created_at"
    THEN
        RAISE EXCEPTION '% % identity is immutable', TG_TABLE_NAME, OLD."id";
    END IF;

    IF TG_TABLE_NAME = 'webhook_delivery_attempts' THEN
        IF NEW."delivery_id" IS DISTINCT FROM OLD."delivery_id" THEN
            RAISE EXCEPTION 'webhook delivery attempt % cannot change delivery', OLD."id";
        END IF;
    ELSE
        IF NEW."operation_id" IS DISTINCT FROM OLD."operation_id"
           OR NEW."config_version_id" IS DISTINCT FROM OLD."config_version_id"
           OR NEW."endpoint_id" IS DISTINCT FROM OLD."endpoint_id"
        THEN
            RAISE EXCEPTION 'webhook verification attempt % cannot change parent', OLD."id";
        END IF;
    END IF;

    IF OLD."outcome" IS NOT NULL THEN
        RAISE EXCEPTION '% % is already %', TG_TABLE_NAME, OLD."id", OLD."outcome";
    END IF;

    RETURN NEW;
END;
$$;

-- -----------------------------------------------------------------------------
-- 5. The management operation guard
--
-- The whole point of this row is that the same idempotency key returns the same
-- answer. That promise is only worth something if the answer cannot be swapped
-- afterwards, so the result resource ids are identity, not payload.
--
-- Reveal material may only ever move in two directions: rewrapped under a new
-- key with the identical plaintext, or cleared. It may never become a different
-- secret, because a caller recovering a lost response has no way to tell the
-- difference between the secret they were issued and one substituted later.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION webhook_management_operations_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
    v_mode text := app_webhook_write_mode();
    v_reveal_changed boolean;
    v_reveal_cleared boolean;
BEGIN
    IF NEW."id" IS DISTINCT FROM OLD."id"
       OR NEW."organization_id" IS DISTINCT FROM OLD."organization_id"
       OR NEW."operation" IS DISTINCT FROM OLD."operation"
       OR NEW."idempotency_key_hash" IS DISTINCT FROM OLD."idempotency_key_hash"
       OR NEW."request_fingerprint" IS DISTINCT FROM OLD."request_fingerprint"
       OR NEW."actor_user_id" IS DISTINCT FROM OLD."actor_user_id"
       OR NEW."created_at" IS DISTINCT FROM OLD."created_at"
       OR NEW."reveal_expires_at" IS DISTINCT FROM OLD."reveal_expires_at"
    THEN
        RAISE EXCEPTION 'webhook management operation % identity is immutable', OLD."id";
    END IF;

    -- The result of an operation is what the key returns. Reassigning it would
    -- make the same key answer with a different resource.
    IF NEW."endpoint_id" IS DISTINCT FROM OLD."endpoint_id"
       OR NEW."config_version_id" IS DISTINCT FROM OLD."config_version_id"
       OR NEW."delivery_id" IS DISTINCT FROM OLD."delivery_id"
    THEN
        RAISE EXCEPTION
            'webhook management operation % result resources are immutable', OLD."id";
    END IF;

    v_reveal_changed :=
        NEW."reveal_ciphertext" IS DISTINCT FROM OLD."reveal_ciphertext"
        OR NEW."reveal_iv" IS DISTINCT FROM OLD."reveal_iv"
        OR NEW."reveal_auth_tag" IS DISTINCT FROM OLD."reveal_auth_tag"
        OR NEW."reveal_encryption_key_id" IS DISTINCT FROM OLD."reveal_encryption_key_id";

    v_reveal_cleared :=
        NEW."reveal_ciphertext" IS NULL AND NEW."reveal_iv" IS NULL
        AND NEW."reveal_auth_tag" IS NULL AND NEW."reveal_encryption_key_id" IS NULL;

    IF v_reveal_changed THEN
        IF v_mode = 'reveal_clear' THEN
            IF NOT v_reveal_cleared THEN
                RAISE EXCEPTION 'expiry cleanup may only clear reveal material';
            END IF;
        ELSIF v_mode = 'rewrap' THEN
            IF v_reveal_cleared THEN
                RAISE EXCEPTION 'a rewrap may not erase reveal material';
            END IF;
        ELSE
            RAISE EXCEPTION
                'webhook management operation % reveal material may only be rewrapped or cleared',
                OLD."id";
        END IF;
    END IF;

    -- Settlement is one-way. An operation that could be un-settled would let a
    -- key that already produced a terminal answer produce a second one.
    IF OLD."settled_at" IS NOT NULL
       AND (NEW."settled_at" IS DISTINCT FROM OLD."settled_at"
            OR NEW."settled_error_code" IS DISTINCT FROM OLD."settled_error_code")
    THEN
        RAISE EXCEPTION 'webhook management operation % is already settled', OLD."id";
    END IF;

    RETURN NEW;
END;
$$;

-- =============================================================================
-- 6. The only ways to write a SYSTEM row
--
-- Each function below derives what it writes from an authoritative row rather
-- than accepting it. That is the difference between a boundary and a
-- convention: a caller cannot pass an organization id, an event type or a
-- configuration pointer, so a caller that is wrong about any of them produces
-- an error instead of a plausible row.
--
-- A note on what these functions do NOT claim. Every PalCert process connects
-- as the same `palcert_app` role, so the database cannot tell a worker from an
-- API request by identity alone. What it can tell is whether a tenant context
-- is resolved, and every webhook HTTP route resolves one. The functions that
-- must never run inside a request therefore refuse when an organization is in
-- scope, and that is stated as what it is — a real and checkable restriction,
-- not a proof of which process is calling.
-- =============================================================================

CREATE OR REPLACE FUNCTION app_webhook_event_type_of(p_type "NotificationType")
RETURNS "WebhookEventType"
LANGUAGE sql IMMUTABLE AS $$
    SELECT (CASE p_type
        WHEN 'SUBMISSION_READY' THEN 'submission.ready'
        WHEN 'SUBMISSION_REVISION_READY' THEN 'submission.revision_ready'
        WHEN 'SUBMISSION_UNDER_REVIEW' THEN 'submission.under_review'
        WHEN 'SUBMISSION_APPROVED' THEN 'submission.approved'
        WHEN 'SUBMISSION_REJECTED' THEN 'submission.rejected'
        WHEN 'SUBMISSION_REVISION_REQUESTED' THEN 'submission.revision_requested'
        WHEN 'SUBMISSION_COMMENT_ADDED' THEN 'submission.comment_added'
        WHEN 'CERTIFICATE_ISSUED' THEN 'certificate.issued'
        WHEN 'CERTIFICATE_REVOKED' THEN 'certificate.revoked'
    END)::"WebhookEventType";
$$;

/*
 * Project a DomainEvent outward.
 *
 * The event type, the organization and the occurrence time are read from the
 * DomainEvent, never supplied. A caller that could pass them could announce
 * an approval that never happened — which is exactly the thing the phase's
 * governing rule forbids, and it has to be unreachable rather than merely
 * un-called.
 *
 * Idempotent: the unique index on `domain_event_id` is the authority, and a
 * duplicate call returns the existing row rather than failing, so a redelivered
 * fan-out job is harmless.
 */
CREATE OR REPLACE FUNCTION app_webhook_event_create(
    p_domain_event_id uuid,
    p_data jsonb,
    p_body_sha256 text
) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
    v_event "domain_events"%ROWTYPE;
    v_id uuid;
BEGIN
    SELECT * INTO v_event FROM "domain_events" WHERE "id" = p_domain_event_id;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'domain_event % does not exist', p_domain_event_id;
    END IF;

    -- The structural cutover, re-checked here rather than trusted from the
    -- caller. A historical event must not become a webhook because a worker
    -- was asked nicely.
    IF NOT v_event."webhook_eligible" THEN
        RAISE EXCEPTION 'domain_event % is not eligible for webhook projection',
            p_domain_event_id;
    END IF;

    PERFORM set_config('palcert.webhook_write_mode', 'system', true);

    INSERT INTO "webhook_events" (
        "id", "domain_event_id", "organization_id", "event_type",
        "schema_version", "occurred_at", "data", "body_sha256"
    ) VALUES (
        gen_random_uuid(), v_event."id", v_event."organization_id",
        app_webhook_event_type_of(v_event."event_type"),
        1, v_event."occurred_at", p_data, p_body_sha256
    )
    ON CONFLICT ("domain_event_id") DO NOTHING
    RETURNING "id" INTO v_id;

    IF v_id IS NULL THEN
        SELECT "id" INTO v_id FROM "webhook_events"
         WHERE "domain_event_id" = p_domain_event_id;
    END IF;

    PERFORM set_config('palcert.webhook_write_mode', 'off', true);
    RETURN v_id;
END;
$$;

/*
 * Create the one original delivery of an event to an endpoint.
 *
 * The configuration is taken from the endpoint's current pointer, not from the
 * caller, so a delivery can never be bound to an unverified or superseded
 * configuration. The endpoint must be ACTIVE and subscribed; a caller who has
 * not checked gets NULL rather than a delivery, because "nothing to do" is an
 * ordinary outcome of fan-out and not an error.
 */
CREATE OR REPLACE FUNCTION app_webhook_delivery_create_original(
    p_webhook_event_id uuid,
    p_endpoint_id uuid
) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
    v_event "webhook_events"%ROWTYPE;
    v_endpoint "webhook_endpoints"%ROWTYPE;
    v_id uuid;
BEGIN
    SELECT * INTO v_event FROM "webhook_events" WHERE "id" = p_webhook_event_id;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'webhook_event % does not exist', p_webhook_event_id;
    END IF;

    SELECT * INTO v_endpoint FROM "webhook_endpoints" WHERE "id" = p_endpoint_id;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'webhook endpoint % does not exist', p_endpoint_id;
    END IF;

    -- One organization's event may never be delivered to another's endpoint.
    IF v_endpoint."organization_id" <> v_event."organization_id" THEN
        RAISE EXCEPTION 'webhook endpoint % belongs to another organization', p_endpoint_id;
    END IF;

    IF v_endpoint."status" <> 'ACTIVE' OR v_endpoint."current_config_version_id" IS NULL THEN
        RETURN NULL;
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM "webhook_subscriptions"
         WHERE "endpoint_id" = p_endpoint_id AND "event_type" = v_event."event_type"
    ) THEN
        RETURN NULL;
    END IF;

    PERFORM set_config('palcert.webhook_write_mode', 'system', true);

    INSERT INTO "webhook_deliveries" (
        "id", "webhook_event_id", "endpoint_id", "endpoint_config_version_id",
        "organization_id", "kind", "status", "updated_at"
    ) VALUES (
        gen_random_uuid(), v_event."id", p_endpoint_id,
        v_endpoint."current_config_version_id", v_event."organization_id",
        'ORIGINAL', 'PENDING', now()
    )
    ON CONFLICT DO NOTHING
    RETURNING "id" INTO v_id;

    IF v_id IS NULL THEN
        SELECT "id" INTO v_id FROM "webhook_deliveries"
         WHERE "webhook_event_id" = p_webhook_event_id
           AND "endpoint_id" = p_endpoint_id
           AND "kind" = 'ORIGINAL';
    END IF;

    PERFORM set_config('palcert.webhook_write_mode', 'off', true);
    RETURN v_id;
END;
$$;

/*
 * Create a durable TEST delivery.
 *
 * Organization-management work, so the endpoint must belong to the caller's
 * resolved tenant. The body hash and its immutable timestamp are supplied
 * because a test projects nothing there is to derive them from, and they are
 * what every later retry reproduces its bytes against.
 */
CREATE OR REPLACE FUNCTION app_webhook_delivery_create_test(
    p_endpoint_id uuid,
    p_control_occurred_at timestamptz,
    p_body_sha256 text
) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
    v_endpoint "webhook_endpoints"%ROWTYPE;
    v_id uuid;
BEGIN
    SELECT * INTO v_endpoint FROM "webhook_endpoints" WHERE "id" = p_endpoint_id;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'webhook endpoint % does not exist', p_endpoint_id;
    END IF;

    IF app_current_organization() IS NULL
       OR v_endpoint."organization_id" <> app_current_organization()
    THEN
        RAISE EXCEPTION 'webhook endpoint % is not the caller''s', p_endpoint_id;
    END IF;

    IF v_endpoint."status" <> 'ACTIVE' OR v_endpoint."current_config_version_id" IS NULL THEN
        RAISE EXCEPTION 'webhook endpoint % is not active', p_endpoint_id;
    END IF;

    PERFORM set_config('palcert.webhook_write_mode', 'system', true);

    INSERT INTO "webhook_deliveries" (
        "id", "endpoint_id", "endpoint_config_version_id", "organization_id",
        "kind", "status", "control_occurred_at", "body_sha256", "updated_at"
    ) VALUES (
        gen_random_uuid(), p_endpoint_id, v_endpoint."current_config_version_id",
        v_endpoint."organization_id", 'TEST', 'PENDING',
        p_control_occurred_at, p_body_sha256, now()
    ) RETURNING "id" INTO v_id;

    PERFORM set_config('palcert.webhook_write_mode', 'off', true);
    RETURN v_id;
END;
$$;

/*
 * Replay a past delivery under the current configuration.
 *
 * Everything but the new row's identity comes from the source delivery, so a
 * replay is structurally the same business fact: the same event, the same
 * endpoint, the same organization. The source must be a business delivery —
 * a test projects nothing, and replaying one would invite a receiver to act on
 * a body that never announced anything.
 */
CREATE OR REPLACE FUNCTION app_webhook_delivery_create_replay(
    p_source_delivery_id uuid
) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
    v_source "webhook_deliveries"%ROWTYPE;
    v_endpoint "webhook_endpoints"%ROWTYPE;
    v_id uuid;
BEGIN
    SELECT * INTO v_source FROM "webhook_deliveries" WHERE "id" = p_source_delivery_id;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'webhook delivery % does not exist', p_source_delivery_id;
    END IF;

    IF app_current_organization() IS NULL
       OR v_source."organization_id" <> app_current_organization()
    THEN
        RAISE EXCEPTION 'webhook delivery % is not the caller''s', p_source_delivery_id;
    END IF;

    IF v_source."kind" = 'TEST' THEN
        RAISE EXCEPTION 'a test delivery cannot be replayed';
    END IF;

    SELECT * INTO v_endpoint FROM "webhook_endpoints" WHERE "id" = v_source."endpoint_id";
    IF v_endpoint."status" <> 'ACTIVE' OR v_endpoint."current_config_version_id" IS NULL THEN
        RAISE EXCEPTION 'webhook endpoint % is not active', v_source."endpoint_id";
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM "webhook_subscriptions" s
         JOIN "webhook_events" e ON e."id" = v_source."webhook_event_id"
        WHERE s."endpoint_id" = v_endpoint."id" AND s."event_type" = e."event_type"
    ) THEN
        RAISE EXCEPTION 'webhook endpoint % is not subscribed to that event type',
            v_endpoint."id";
    END IF;

    PERFORM set_config('palcert.webhook_write_mode', 'system', true);

    INSERT INTO "webhook_deliveries" (
        "id", "webhook_event_id", "endpoint_id", "endpoint_config_version_id",
        "organization_id", "kind", "status", "replay_of_delivery_id", "updated_at"
    ) VALUES (
        gen_random_uuid(), v_source."webhook_event_id", v_source."endpoint_id",
        v_endpoint."current_config_version_id", v_source."organization_id",
        'REPLAY', 'PENDING', p_source_delivery_id, now()
    ) RETURNING "id" INTO v_id;

    PERFORM set_config('palcert.webhook_write_mode', 'off', true);
    RETURN v_id;
END;
$$;

/* Move a delivery's state. The guard still refuses a terminal row. */
CREATE OR REPLACE FUNCTION app_webhook_delivery_transition(
    p_delivery_id uuid,
    p_status "WebhookDeliveryStatus",
    p_skip_reason "WebhookSkipReason",
    p_error_code text,
    p_http_status integer,
    p_next_attempt_at timestamptz,
    p_increment_attempt boolean
) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
    PERFORM set_config('palcert.webhook_write_mode', 'system', true);

    UPDATE "webhook_deliveries"
       SET "status" = p_status,
           "skip_reason" = p_skip_reason,
           "last_error_code" = COALESCE(p_error_code::"webhook_error_code", "last_error_code"),
           "last_http_status" = COALESCE(p_http_status, "last_http_status"),
           "next_attempt_at" = p_next_attempt_at,
           "attempt_count" = "attempt_count" + CASE WHEN p_increment_attempt THEN 1 ELSE 0 END,
           "delivered_at" = CASE WHEN p_status = 'DELIVERED' THEN now() ELSE "delivered_at" END,
           "updated_at" = now()
     WHERE "id" = p_delivery_id;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'webhook delivery % does not exist', p_delivery_id;
    END IF;

    PERFORM set_config('palcert.webhook_write_mode', 'off', true);
END;
$$;

/*
 * Open an attempt.
 *
 * The attempt number is derived under the row lock rather than supplied, so two
 * workers racing on the same delivery cannot both claim attempt three.
 */
CREATE OR REPLACE FUNCTION app_webhook_attempt_open(
    p_delivery_id uuid,
    p_started_at timestamptz
) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
    v_number integer;
    v_id uuid;
BEGIN
    PERFORM 1 FROM "webhook_deliveries" WHERE "id" = p_delivery_id FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'webhook delivery % does not exist', p_delivery_id;
    END IF;

    SELECT COALESCE(MAX("attempt_number"), 0) + 1 INTO v_number
      FROM "webhook_delivery_attempts" WHERE "delivery_id" = p_delivery_id;

    PERFORM set_config('palcert.webhook_write_mode', 'system', true);

    INSERT INTO "webhook_delivery_attempts"
        ("id", "delivery_id", "attempt_number", "started_at")
    VALUES (gen_random_uuid(), p_delivery_id, v_number, p_started_at)
    RETURNING "id" INTO v_id;

    PERFORM set_config('palcert.webhook_write_mode', 'off', true);
    RETURN v_id;
END;
$$;

/* Close an attempt, exactly once. The guard refuses a second close. */
CREATE OR REPLACE FUNCTION app_webhook_attempt_close(
    p_attempt_id uuid,
    p_outcome "WebhookAttemptOutcome",
    p_error_code text,
    p_http_status integer,
    p_duration_ms integer
) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
    PERFORM set_config('palcert.webhook_write_mode', 'system', true);

    UPDATE "webhook_delivery_attempts"
       SET "outcome" = p_outcome,
           "error_code" = p_error_code::"webhook_error_code",
           "http_status" = p_http_status,
           "duration_ms" = p_duration_ms,
           "finished_at" = now()
     WHERE "id" = p_attempt_id;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'webhook delivery attempt % does not exist', p_attempt_id;
    END IF;

    PERFORM set_config('palcert.webhook_write_mode', 'off', true);
END;
$$;

CREATE OR REPLACE FUNCTION app_webhook_verification_attempt_open(
    p_operation_id uuid,
    p_config_version_id uuid,
    p_started_at timestamptz
) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
    v_endpoint_id uuid;
    v_number integer;
    v_id uuid;
BEGIN
    SELECT "endpoint_id" INTO v_endpoint_id
      FROM "webhook_endpoint_config_versions" WHERE "id" = p_config_version_id;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'webhook config version % does not exist', p_config_version_id;
    END IF;

    -- The operation and the configuration must belong to the same endpoint, or
    -- one endpoint's handshake could be recorded against another's intent.
    PERFORM 1 FROM "webhook_management_operations"
     WHERE "id" = p_operation_id AND "endpoint_id" = v_endpoint_id
     FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'webhook operation % is not for endpoint %',
            p_operation_id, v_endpoint_id;
    END IF;

    SELECT COALESCE(MAX("attempt_number"), 0) + 1 INTO v_number
      FROM "webhook_verification_attempts" WHERE "operation_id" = p_operation_id;

    PERFORM set_config('palcert.webhook_write_mode', 'system', true);

    INSERT INTO "webhook_verification_attempts"
        ("id", "operation_id", "config_version_id", "endpoint_id",
         "attempt_number", "started_at")
    VALUES (gen_random_uuid(), p_operation_id, p_config_version_id, v_endpoint_id,
            v_number, p_started_at)
    RETURNING "id" INTO v_id;

    PERFORM set_config('palcert.webhook_write_mode', 'off', true);
    RETURN v_id;
END;
$$;

CREATE OR REPLACE FUNCTION app_webhook_verification_attempt_close(
    p_attempt_id uuid,
    p_outcome "WebhookAttemptOutcome",
    p_error_code text,
    p_http_status integer,
    p_duration_ms integer
) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
    PERFORM set_config('palcert.webhook_write_mode', 'system', true);

    UPDATE "webhook_verification_attempts"
       SET "outcome" = p_outcome,
           "error_code" = p_error_code::"webhook_error_code",
           "http_status" = p_http_status,
           "duration_ms" = p_duration_ms,
           "finished_at" = now()
     WHERE "id" = p_attempt_id;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'webhook verification attempt % does not exist', p_attempt_id;
    END IF;

    PERFORM set_config('palcert.webhook_write_mode', 'off', true);
END;
$$;

-- =============================================================================
-- 7. Configuration and endpoint lifecycle
-- =============================================================================

/*
 * Save a new configuration for an endpoint the caller owns.
 *
 * The version number is derived under the endpoint's row lock, and the previous
 * pending configuration is superseded in the same statement — atomically,
 * because "at most one pending" is a unique index and two callers racing here
 * must not both believe they saved the next version.
 *
 * The sealed material is supplied; the metadata beside it is what the worker
 * will recompute and compare before every attempt, so this function is the one
 * place where the two are asserted to describe each other.
 */
CREATE OR REPLACE FUNCTION app_webhook_config_create(
    p_endpoint_id uuid,
    p_url_ciphertext text, p_url_iv text, p_url_auth_tag text, p_url_kid text,
    p_url_sha256 text, p_host text, p_port integer,
    p_secret_ciphertext text, p_secret_iv text, p_secret_auth_tag text, p_secret_kid text,
    p_secret_fingerprint text
) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
    v_endpoint "webhook_endpoints"%ROWTYPE;
    v_number integer;
    v_id uuid;
BEGIN
    SELECT * INTO v_endpoint FROM "webhook_endpoints"
     WHERE "id" = p_endpoint_id FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'webhook endpoint % does not exist', p_endpoint_id;
    END IF;

    IF app_current_organization() IS NULL
       OR v_endpoint."organization_id" <> app_current_organization()
    THEN
        RAISE EXCEPTION 'webhook endpoint % is not the caller''s', p_endpoint_id;
    END IF;

    IF v_endpoint."status" = 'DISABLED' THEN
        RAISE EXCEPTION 'webhook endpoint % is disabled', p_endpoint_id;
    END IF;

    PERFORM set_config('palcert.webhook_write_mode', 'lifecycle', true);

    -- Supersede whatever was waiting. A previous pending configuration that
    -- survived would let a verification already in flight activate a URL the
    -- organization has since replaced.
    UPDATE "webhook_endpoint_config_versions"
       SET "status" = 'SUPERSEDED'
     WHERE "endpoint_id" = p_endpoint_id AND "status" = 'PENDING';

    SELECT COALESCE(MAX("version_number"), 0) + 1 INTO v_number
      FROM "webhook_endpoint_config_versions" WHERE "endpoint_id" = p_endpoint_id;

    INSERT INTO "webhook_endpoint_config_versions" (
        "id", "endpoint_id", "version_number", "status",
        "url_ciphertext", "url_iv", "url_auth_tag", "url_encryption_key_id",
        "url_sha256", "host", "port",
        "secret_ciphertext", "secret_iv", "secret_auth_tag", "secret_encryption_key_id",
        "secret_fingerprint"
    ) VALUES (
        gen_random_uuid(), p_endpoint_id, v_number, 'PENDING',
        p_url_ciphertext, p_url_iv, p_url_auth_tag, p_url_kid,
        p_url_sha256, p_host, p_port,
        p_secret_ciphertext, p_secret_iv, p_secret_auth_tag, p_secret_kid,
        p_secret_fingerprint
    ) RETURNING "id" INTO v_id;

    UPDATE "webhook_endpoints"
       SET "pending_config_version_id" = v_id, "updated_at" = now()
     WHERE "id" = p_endpoint_id;

    PERFORM set_config('palcert.webhook_write_mode', 'off', true);
    RETURN v_id;
END;
$$;

/*
 * Activate a configuration that has proved reachable.
 *
 * The three preconditions are checked here and nowhere else, because this is
 * the only path that can set them. A stale verification — one whose
 * configuration was superseded while the request was in flight — fails the
 * pointer check and activates nothing.
 *
 * A PAUSED endpoint stays PAUSED: an administrator who paused an integration
 * and then fixed its receiver has not asked for events to resume.
 */
CREATE OR REPLACE FUNCTION app_webhook_config_activate(p_config_version_id uuid)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
    v_config "webhook_endpoint_config_versions"%ROWTYPE;
    v_endpoint "webhook_endpoints"%ROWTYPE;
BEGIN
    SELECT * INTO v_config FROM "webhook_endpoint_config_versions"
     WHERE "id" = p_config_version_id;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'webhook config version % does not exist', p_config_version_id;
    END IF;

    SELECT * INTO v_endpoint FROM "webhook_endpoints"
     WHERE "id" = v_config."endpoint_id" FOR UPDATE;

    IF v_endpoint."pending_config_version_id" IS DISTINCT FROM p_config_version_id THEN
        RAISE EXCEPTION 'webhook config version % is not the pending configuration',
            p_config_version_id;
    END IF;
    IF v_config."status" <> 'PENDING' THEN
        RAISE EXCEPTION 'webhook config version % is %', p_config_version_id, v_config."status";
    END IF;
    IF v_endpoint."status" = 'DISABLED' THEN
        RAISE EXCEPTION 'webhook endpoint % is disabled', v_endpoint."id";
    END IF;

    PERFORM set_config('palcert.webhook_write_mode', 'lifecycle', true);

    IF v_endpoint."current_config_version_id" IS NOT NULL THEN
        UPDATE "webhook_endpoint_config_versions"
           SET "status" = 'RETIRED', "retired_at" = now()
         WHERE "id" = v_endpoint."current_config_version_id";
    END IF;

    UPDATE "webhook_endpoint_config_versions"
       SET "status" = 'VERIFIED', "verified_at" = now(), "last_verification_error" = NULL,
           "last_verification_at" = now()
     WHERE "id" = p_config_version_id;

    UPDATE "webhook_endpoints"
       SET "current_config_version_id" = p_config_version_id,
           "pending_config_version_id" = NULL,
           "status" = (CASE WHEN "status" = 'PAUSED' THEN 'PAUSED' ELSE 'ACTIVE' END)
                      ::"WebhookEndpointStatus",
           "updated_at" = now()
     WHERE "id" = v_endpoint."id";

    PERFORM set_config('palcert.webhook_write_mode', 'off', true);
END;
$$;

/* Record a failed verification. It activates nothing, by construction. */
CREATE OR REPLACE FUNCTION app_webhook_config_verification_failed(
    p_config_version_id uuid,
    p_error_code text
) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
    PERFORM set_config('palcert.webhook_write_mode', 'lifecycle', true);

    UPDATE "webhook_endpoint_config_versions"
       SET "last_verification_error" = p_error_code::"webhook_error_code",
           "last_verification_at" = now()
     WHERE "id" = p_config_version_id AND "status" = 'PENDING';

    PERFORM set_config('palcert.webhook_write_mode', 'off', true);
END;
$$;

/*
 * Pause, resume or disable an endpoint.
 *
 * Disabling releases the slot, which is what lets a replacement integration be
 * created, and is why it is a lifecycle operation rather than an edit.
 * Resuming requires a current configuration, so an endpoint cannot be resumed
 * into a state where it has nowhere to send.
 */
CREATE OR REPLACE FUNCTION app_webhook_endpoint_lifecycle(
    p_endpoint_id uuid,
    p_status "WebhookEndpointStatus"
) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
    v_endpoint "webhook_endpoints"%ROWTYPE;
BEGIN
    SELECT * INTO v_endpoint FROM "webhook_endpoints"
     WHERE "id" = p_endpoint_id FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'webhook endpoint % does not exist', p_endpoint_id;
    END IF;

    IF app_current_organization() IS NOT NULL
       AND v_endpoint."organization_id" <> app_current_organization()
    THEN
        RAISE EXCEPTION 'webhook endpoint % is not the caller''s', p_endpoint_id;
    END IF;

    IF p_status = 'ACTIVE' AND v_endpoint."current_config_version_id" IS NULL THEN
        RAISE EXCEPTION 'webhook endpoint % has no verified configuration', p_endpoint_id;
    END IF;

    -- Activation is verification's business, not a lifecycle switch's. Resuming
    -- a paused endpoint is allowed; making an unverified one live is not.
    IF p_status = 'ACTIVE' AND v_endpoint."status" NOT IN ('PAUSED', 'ACTIVE') THEN
        RAISE EXCEPTION
            'webhook endpoint % becomes active through verification, not a status change',
            p_endpoint_id;
    END IF;

    PERFORM set_config('palcert.webhook_write_mode', 'lifecycle', true);

    UPDATE "webhook_endpoints"
       SET "status" = p_status,
           "slot" = CASE WHEN p_status = 'DISABLED' THEN NULL ELSE "slot" END,
           "disabled_at" = CASE WHEN p_status = 'DISABLED' THEN now() ELSE NULL END,
           "updated_at" = now()
     WHERE "id" = p_endpoint_id;

    PERFORM set_config('palcert.webhook_write_mode', 'off', true);
END;
$$;

-- =============================================================================
-- 8. Management operations
-- =============================================================================

/*
 * Record one HTTP mutation's durable identity, with its results already in it.
 *
 * The result ids are parameters rather than a later UPDATE because the guard
 * refuses to change them afterwards — which is the invariant the phase asks
 * for, and it is only achievable if the row is complete when it is written.
 * Callers create the resource and the operation in one transaction.
 *
 * The actor and the organization are taken from the resolved context, not from
 * the caller, so an operation cannot be attributed to somebody else.
 */
CREATE OR REPLACE FUNCTION app_webhook_management_operation_create(
    p_operation "WebhookManagementOperationType",
    p_idempotency_key_hash text,
    p_request_fingerprint text,
    p_endpoint_id uuid,
    p_config_version_id uuid,
    p_delivery_id uuid,
    p_reveal_ciphertext text, p_reveal_iv text, p_reveal_auth_tag text, p_reveal_kid text,
    p_reveal_expires_at timestamptz
) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
    v_org uuid := app_current_organization();
    v_actor uuid := app_current_user_id();
    v_id uuid;
BEGIN
    IF v_org IS NULL OR v_actor IS NULL THEN
        RAISE EXCEPTION 'a webhook management operation requires a resolved caller';
    END IF;

    IF p_reveal_ciphertext IS NOT NULL
       AND p_operation NOT IN ('CREATE_ENDPOINT', 'ROTATE_SECRET')
    THEN
        RAISE EXCEPTION 'operation % does not carry a secret', p_operation;
    END IF;

    PERFORM set_config('palcert.webhook_write_mode', 'system', true);

    INSERT INTO "webhook_management_operations" (
        "id", "organization_id", "operation",
        "idempotency_key_hash", "request_fingerprint", "actor_user_id",
        "endpoint_id", "config_version_id", "delivery_id",
        "reveal_ciphertext", "reveal_iv", "reveal_auth_tag", "reveal_encryption_key_id",
        "reveal_expires_at", "updated_at"
    ) VALUES (
        gen_random_uuid(), v_org, p_operation,
        p_idempotency_key_hash, p_request_fingerprint, v_actor,
        p_endpoint_id, p_config_version_id, p_delivery_id,
        p_reveal_ciphertext, p_reveal_iv, p_reveal_auth_tag, p_reveal_kid,
        p_reveal_expires_at, now()
    ) RETURNING "id" INTO v_id;

    PERFORM set_config('palcert.webhook_write_mode', 'off', true);
    RETURN v_id;
END;
$$;

/* Settle an operation, once. The guard refuses a second settlement. */
CREATE OR REPLACE FUNCTION app_webhook_operation_settle(
    p_operation_id uuid,
    p_error_code text
) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
    PERFORM set_config('palcert.webhook_write_mode', 'system', true);

    UPDATE "webhook_management_operations"
       SET "settled_at" = now(),
           "settled_error_code" = p_error_code::"webhook_error_code",
           "updated_at" = now()
     WHERE "id" = p_operation_id;

    PERFORM set_config('palcert.webhook_write_mode', 'off', true);
END;
$$;

/*
 * Wipe reveal material whose window has closed.
 *
 * Storage hygiene, not the authorization boundary. Expiry is decided by
 * comparing the clock to `reveal_expires_at` at read time, so a sweeper that
 * has not run yet never makes an expired secret recoverable — this only stops
 * the ciphertext outliving its purpose. The tombstone stays, so the key can
 * never silently produce a second side effect later.
 */
CREATE OR REPLACE FUNCTION app_webhook_reveal_clear(p_operation_id uuid)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
    PERFORM set_config('palcert.webhook_write_mode', 'reveal_clear', true);

    UPDATE "webhook_management_operations"
       SET "reveal_ciphertext" = NULL, "reveal_iv" = NULL,
           "reveal_auth_tag" = NULL, "reveal_encryption_key_id" = NULL,
           "updated_at" = now()
     WHERE "id" = p_operation_id AND "reveal_ciphertext" IS NOT NULL;

    PERFORM set_config('palcert.webhook_write_mode', 'off', true);
END;
$$;

-- =============================================================================
-- 9. Rewrap — the SYSTEM-only maintenance boundary
--
-- Refused whenever a tenant is resolved, which is what keeps it out of every
-- organization HTTP request: those all resolve one. The mode is `rewrap`, which
-- the guards accept for crypto columns and refuse for everything else, so a
-- rewrap cannot activate a configuration or settle an operation even by
-- accident.
--
-- The plaintext is not re-derived here. The caller decrypts under the old key
-- and re-encrypts under the active one, proves the two agree, and hands back an
-- envelope; the database's job is to ensure nothing else moves while it lands.
-- =============================================================================

CREATE OR REPLACE FUNCTION app_webhook_config_rewrap(
    p_config_version_id uuid,
    p_url_ciphertext text, p_url_iv text, p_url_auth_tag text, p_url_kid text,
    p_secret_ciphertext text, p_secret_iv text, p_secret_auth_tag text, p_secret_kid text
) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
    IF app_current_organization() IS NOT NULL THEN
        RAISE EXCEPTION 'a webhook rewrap is maintenance work, not a tenant request';
    END IF;

    PERFORM set_config('palcert.webhook_write_mode', 'rewrap', true);

    UPDATE "webhook_endpoint_config_versions"
       SET "url_ciphertext" = p_url_ciphertext,
           "url_iv" = p_url_iv,
           "url_auth_tag" = p_url_auth_tag,
           "url_encryption_key_id" = p_url_kid,
           "secret_ciphertext" = p_secret_ciphertext,
           "secret_iv" = p_secret_iv,
           "secret_auth_tag" = p_secret_auth_tag,
           "secret_encryption_key_id" = p_secret_kid
     WHERE "id" = p_config_version_id;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'webhook config version % does not exist', p_config_version_id;
    END IF;

    PERFORM set_config('palcert.webhook_write_mode', 'off', true);
END;
$$;

CREATE OR REPLACE FUNCTION app_webhook_reveal_rewrap(
    p_operation_id uuid,
    p_reveal_ciphertext text, p_reveal_iv text, p_reveal_auth_tag text, p_reveal_kid text
) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
    IF app_current_organization() IS NOT NULL THEN
        RAISE EXCEPTION 'a webhook rewrap is maintenance work, not a tenant request';
    END IF;
    IF p_reveal_ciphertext IS NULL THEN
        RAISE EXCEPTION 'a rewrap must produce reveal material';
    END IF;

    PERFORM set_config('palcert.webhook_write_mode', 'rewrap', true);

    UPDATE "webhook_management_operations"
       SET "reveal_ciphertext" = p_reveal_ciphertext,
           "reveal_iv" = p_reveal_iv,
           "reveal_auth_tag" = p_reveal_auth_tag,
           "reveal_encryption_key_id" = p_reveal_kid,
           "updated_at" = now()
     WHERE "id" = p_operation_id AND "reveal_ciphertext" IS NOT NULL;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'webhook operation % holds no reveal material', p_operation_id;
    END IF;

    PERFORM set_config('palcert.webhook_write_mode', 'off', true);
END;
$$;

-- =============================================================================
-- 10. Reading what is sealed
--
-- Two functions, with deliberately different rules.
--
-- The worker needs a URL and a signing secret in order to send, and needs them
-- outside any tenant context. The recovery path needs a secret back inside a
-- tenant context, but only for the exact caller, the exact key and the exact
-- request that produced it, and only while the window is open.
-- =============================================================================

/* Sealed configuration for a send. Never reachable from a tenant request. */
CREATE OR REPLACE FUNCTION app_webhook_config_material(p_config_version_id uuid)
RETURNS TABLE (
    endpoint_id uuid,
    status "WebhookConfigStatus",
    url_ciphertext text, url_iv text, url_auth_tag text, url_encryption_key_id text,
    url_sha256 text, host text, port integer,
    secret_ciphertext text, secret_iv text, secret_auth_tag text,
    secret_encryption_key_id text, secret_fingerprint text
)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
    IF app_current_organization() IS NOT NULL THEN
        RAISE EXCEPTION 'sealed webhook configuration is not readable from a tenant request';
    END IF;

    RETURN QUERY
    SELECT c."endpoint_id", c."status",
           c."url_ciphertext", c."url_iv", c."url_auth_tag", c."url_encryption_key_id",
           c."url_sha256"::text, c."host", c."port",
           c."secret_ciphertext", c."secret_iv", c."secret_auth_tag",
           c."secret_encryption_key_id", c."secret_fingerprint"::text
      FROM "webhook_endpoint_config_versions" c
     WHERE c."id" = p_config_version_id;
END;
$$;

/*
 * Hand back a signing secret to the caller who was issued it.
 *
 * Every condition is checked here rather than in a service, because this is the
 * one place a stored secret can leave the database and the check has to be in
 * the same place as the read. The window is the authorization boundary: an
 * expired reveal is refused *before* anything is decrypted, so a sweeper that
 * has not run yet never makes an expired secret recoverable.
 */
CREATE OR REPLACE FUNCTION app_webhook_reveal_read(
    p_operation_id uuid,
    p_idempotency_key_hash text,
    p_request_fingerprint text
) RETURNS TABLE (
    reveal_ciphertext text, reveal_iv text, reveal_auth_tag text,
    reveal_encryption_key_id text, endpoint_id uuid, config_version_id uuid
)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
    v_row "webhook_management_operations"%ROWTYPE;
BEGIN
    SELECT * INTO v_row FROM "webhook_management_operations" WHERE "id" = p_operation_id;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'webhook operation % does not exist', p_operation_id;
    END IF;

    IF app_current_organization() IS NULL
       OR v_row."organization_id" <> app_current_organization()
       OR v_row."actor_user_id" IS DISTINCT FROM app_current_user_id()
       OR v_row."idempotency_key_hash" <> p_idempotency_key_hash
       OR v_row."request_fingerprint" <> p_request_fingerprint
    THEN
        RAISE EXCEPTION 'webhook operation % is not the caller''s to recover', p_operation_id;
    END IF;

    IF v_row."reveal_expires_at" IS NULL OR now() >= v_row."reveal_expires_at" THEN
        RAISE EXCEPTION 'webhook operation % reveal window has closed', p_operation_id;
    END IF;

    IF v_row."reveal_ciphertext" IS NULL THEN
        RAISE EXCEPTION 'webhook operation % holds no reveal material', p_operation_id;
    END IF;

    RETURN QUERY SELECT v_row."reveal_ciphertext", v_row."reveal_iv",
                        v_row."reveal_auth_tag", v_row."reveal_encryption_key_id",
                        v_row."endpoint_id", v_row."config_version_id";
END;
$$;

-- =============================================================================
-- 11. Safe projections
--
-- What an organization may see of its own integration: where it points, what
-- state it is in, and how its deliveries have gone. Never the ciphertext, never
-- the key id, never a reveal.
--
-- Views rather than functions because these are list screens, and a view can be
-- filtered, sorted and paged by ordinary SQL. They run with the definer's
-- privileges and carry their own tenancy predicate, which is what lets the
-- underlying table stay unreadable to `palcert_app`.
-- =============================================================================
CREATE VIEW "webhook_config_version_safe" AS
SELECT c."id",
       c."endpoint_id",
       c."version_number",
       c."status",
       c."host",
       c."port",
       c."url_sha256",
       c."secret_fingerprint",
       c."created_at",
       c."verified_at",
       c."retired_at",
       c."last_verification_error",
       c."last_verification_at"
  FROM "webhook_endpoint_config_versions" c
  JOIN "webhook_endpoints" e ON e."id" = c."endpoint_id"
 WHERE app_is_platform_admin() OR e."organization_id" = app_current_organization();

COMMENT ON VIEW "webhook_config_version_safe" IS
    'Configuration metadata an organization may read. Excludes every ciphertext, IV, auth tag and key id.';

CREATE VIEW "webhook_management_operation_safe" AS
SELECT o."id",
       o."organization_id",
       o."operation",
       o."actor_user_id",
       o."endpoint_id",
       o."config_version_id",
       o."delivery_id",
       o."reveal_expires_at",
       (o."reveal_ciphertext" IS NOT NULL) AS "reveal_available",
       o."settled_at",
       o."settled_error_code",
       o."created_at",
       o."updated_at"
  FROM "webhook_management_operations" o
 WHERE app_is_platform_admin() OR o."organization_id" = app_current_organization();

COMMENT ON VIEW "webhook_management_operation_safe" IS
    'Operation results and whether a reveal is still available. Never the reveal itself.';

-- =============================================================================
-- 12. Privileges — the part that makes all of the above load-bearing
--
-- Everything before this is a guard, and a guard on a table the application role
-- can freely INSERT into only constrains updates. What closes the boundary is
-- taking the privilege away: with no INSERT and no UPDATE, the functions above
-- are not the recommended path to a SYSTEM row, they are the only one. They can
-- still write because a SECURITY DEFINER body runs with its owner's privileges.
--
-- SELECT is treated separately. Machinery tables stay readable — a delivery's
-- status and an attempt's error code are what support staff answer questions
-- with, and they hold nothing secret. The two tables that hold ciphertext do
-- not, and are reached through the projections above instead.
-- =============================================================================

REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON "webhook_events" FROM "palcert_app";
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON "webhook_deliveries" FROM "palcert_app";
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON "webhook_delivery_attempts" FROM "palcert_app";
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON "webhook_verification_attempts" FROM "palcert_app";

REVOKE ALL ON "webhook_endpoint_config_versions" FROM "palcert_app";
REVOKE ALL ON "webhook_management_operations" FROM "palcert_app";

-- The database has DEFAULT PRIVILEGES granting `arwd` on every new relation to
-- `palcert_app`, and a view is a relation. `webhook_management_operation_safe`
-- is a single-table view and therefore auto-updatable, so without this revoke
-- the application role could have written *through* the projection into the
-- base table — using the view owner's privileges, which is exactly the
-- revocation this migration just performed being handed back. A read
-- projection must be readable and nothing else.
REVOKE ALL ON "webhook_config_version_safe" FROM "palcert_app";
REVOKE ALL ON "webhook_management_operation_safe" FROM "palcert_app";
GRANT SELECT ON "webhook_config_version_safe" TO "palcert_app";
GRANT SELECT ON "webhook_management_operation_safe" TO "palcert_app";

GRANT EXECUTE ON FUNCTION app_webhook_write_mode() TO "palcert_app";
GRANT EXECUTE ON FUNCTION app_webhook_event_type_of("NotificationType") TO "palcert_app";
GRANT EXECUTE ON FUNCTION webhook_endpoints_guard() TO "palcert_app";
GRANT EXECUTE ON FUNCTION app_webhook_event_create(uuid, jsonb, text) TO "palcert_app";
GRANT EXECUTE ON FUNCTION app_webhook_delivery_create_original(uuid, uuid) TO "palcert_app";
GRANT EXECUTE ON FUNCTION app_webhook_delivery_create_test(uuid, timestamptz, text)
    TO "palcert_app";
GRANT EXECUTE ON FUNCTION app_webhook_delivery_create_replay(uuid) TO "palcert_app";
GRANT EXECUTE ON FUNCTION app_webhook_delivery_transition(
    uuid, "WebhookDeliveryStatus", "WebhookSkipReason", text, integer, timestamptz, boolean
) TO "palcert_app";
GRANT EXECUTE ON FUNCTION app_webhook_attempt_open(uuid, timestamptz) TO "palcert_app";
GRANT EXECUTE ON FUNCTION app_webhook_attempt_close(
    uuid, "WebhookAttemptOutcome", text, integer, integer
) TO "palcert_app";
GRANT EXECUTE ON FUNCTION app_webhook_verification_attempt_open(uuid, uuid, timestamptz)
    TO "palcert_app";
GRANT EXECUTE ON FUNCTION app_webhook_verification_attempt_close(
    uuid, "WebhookAttemptOutcome", text, integer, integer
) TO "palcert_app";
GRANT EXECUTE ON FUNCTION app_webhook_config_create(
    uuid, text, text, text, text, text, text, integer, text, text, text, text, text
) TO "palcert_app";
GRANT EXECUTE ON FUNCTION app_webhook_config_activate(uuid) TO "palcert_app";
GRANT EXECUTE ON FUNCTION app_webhook_config_verification_failed(uuid, text) TO "palcert_app";
GRANT EXECUTE ON FUNCTION app_webhook_endpoint_lifecycle(uuid, "WebhookEndpointStatus")
    TO "palcert_app";
GRANT EXECUTE ON FUNCTION app_webhook_management_operation_create(
    "WebhookManagementOperationType", text, text, uuid, uuid, uuid,
    text, text, text, text, timestamptz
) TO "palcert_app";
GRANT EXECUTE ON FUNCTION app_webhook_operation_settle(uuid, text) TO "palcert_app";
GRANT EXECUTE ON FUNCTION app_webhook_reveal_clear(uuid) TO "palcert_app";
GRANT EXECUTE ON FUNCTION app_webhook_config_rewrap(
    uuid, text, text, text, text, text, text, text, text
) TO "palcert_app";
GRANT EXECUTE ON FUNCTION app_webhook_reveal_rewrap(uuid, text, text, text, text)
    TO "palcert_app";
GRANT EXECUTE ON FUNCTION app_webhook_config_material(uuid) TO "palcert_app";
GRANT EXECUTE ON FUNCTION app_webhook_reveal_read(uuid, text, text) TO "palcert_app";

-- =============================================================================
-- 13. The default role grant, stated exactly
--
-- The Phase 17 migration granted these to every role holding
-- `organization:profile:update`, which used one permission as a proxy for a set
-- of roles. That works today and is wrong in principle: it silently hands
-- webhook authority — including minting a signing secret — to any role, now or
-- later, that happens to hold an unrelated profile permission.
--
-- The default membership is named instead. Runtime authorization is unchanged
-- and remains permission-based; this is only about who starts with them.
-- =============================================================================
DELETE FROM "role_permissions" rp
 USING "permissions" p, "roles" r
 WHERE rp."permission_id" = p."id"
   AND rp."role_id" = r."id"
   AND p."code" IN (
       'integration:webhook:read', 'integration:webhook:manage',
       'integration:webhook:secret:rotate', 'integration:webhook:replay')
   AND r."code" NOT IN ('ORGANIZATION_OWNER', 'ORGANIZATION_ADMIN');

INSERT INTO "role_permissions" ("role_id", "permission_id")
SELECT r."id", p."id"
  FROM "roles" r
 CROSS JOIN "permissions" p
 WHERE r."code" IN ('ORGANIZATION_OWNER', 'ORGANIZATION_ADMIN')
   AND p."code" IN (
       'integration:webhook:read', 'integration:webhook:manage',
       'integration:webhook:secret:rotate', 'integration:webhook:replay')
ON CONFLICT ("role_id", "permission_id") DO NOTHING;
