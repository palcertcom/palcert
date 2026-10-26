-- =============================================================================
-- Phase 17 — system authority closure
--
-- The previous migration took direct DML away from `palcert_app` and routed
-- every write through narrow functions. It left one family open: those
-- functions were callable from anywhere. A request with an organization in
-- scope could call `app_webhook_config_activate` and make an endpoint live —
-- which means verification, the entire point of the activation path, was
-- skippable by whoever could reach the route.
--
-- Three things close it.
--
-- First, an explicit predicate for what "system" means, and it is not "no
-- organization": a self-service authenticated request has a user and no
-- organization, and would have passed that test. System means no user scope
-- *and* no organization scope.
--
-- Second, activation stops taking anybody's word for it. It takes a
-- verification attempt id and derives the operation, the configuration and the
-- endpoint from it. The successful attempt row is the database's own proof
-- that a challenge was answered; a caller can no longer assert the outcome it
-- wants.
--
-- Third, the state machines move into the database. A write doorway that
-- accepts any target status is not a doorway, it is a column with extra steps.
--
-- Additive. Phase 0–16 untouched; the five earlier Phase 17 migrations and the
-- hardening migration are untouched.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. What "system" means
--
-- Fail-closed on both sides. `current_setting(..., true)` returns NULL for an
-- unset GUC and the empty string for a cleared one, and `app_current_user_id()`
-- already normalizes both to NULL, so this is a plain two-sided NULL test that
-- cannot itself return NULL.
--
-- The instruction that matters: a self-service request — a person acting
-- outside any organization — has a user id and no organization. Testing only
-- the organization would have called that request "system", which is exactly
-- the hole a webhook worker boundary cannot afford.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION app_is_webhook_system_context() RETURNS boolean
LANGUAGE sql STABLE AS $$
    SELECT COALESCE(app_current_user_id() IS NULL AND app_current_organization() IS NULL, false);
$$;

/*
 * The predicate the RLS policies use, which is deliberately stricter.
 *
 * `app_is_webhook_system_context()` is true for any connection that simply has
 * no scope set — including an unauthenticated public route. That is the right
 * gate for a function call, because reaching the function is itself the
 * deliberate act. It is the wrong gate for a table read, because a stray
 * `SELECT` from such a route would then see every organization's endpoints.
 *
 * So table reads additionally require the role switch, which only holds inside
 * a SECURITY DEFINER body. The effect: the worker's functions can read what
 * they need, and no ordinary statement gains anything.
 */
CREATE OR REPLACE FUNCTION app_is_webhook_system_reader() RETURNS boolean
LANGUAGE sql STABLE AS $$
    SELECT current_user IS DISTINCT FROM session_user AND app_is_webhook_system_context();
$$;

-- The two tenant-scoped tables must be readable by the fan-out and delivery
-- functions, which run with no organization in scope. Without this the system
-- functions would silently find no endpoint and no subscription — failing
-- closed, but by looking like "nobody is subscribed" rather than like an error.
DROP POLICY "webhook_endpoints_read" ON "webhook_endpoints";
CREATE POLICY "webhook_endpoints_read" ON "webhook_endpoints" FOR SELECT
    USING (
        app_is_platform_admin()
        OR "organization_id" = app_current_organization()
        OR app_is_webhook_system_reader()
    );

DROP POLICY "webhook_subscriptions_read" ON "webhook_subscriptions";
CREATE POLICY "webhook_subscriptions_read" ON "webhook_subscriptions" FOR SELECT
    USING (
        app_is_platform_admin()
        OR "organization_id" = app_current_organization()
        OR app_is_webhook_system_reader()
    );

-- -----------------------------------------------------------------------------
-- 2. The external payload is derived, never supplied
--
-- `app_webhook_event_create` used to take the body's `data` as JSON from the
-- caller. Phase 17's rule is that a WebhookEvent's data comes from the
-- authoritative DomainEvent and nowhere else, and a JSONB parameter is a
-- standing invitation to put something else there — a reviewer's name, a
-- document title — in a durable row that leaves PalCert's control.
--
-- The projection below is the same allowlist the contracts package enforces,
-- expressed where it cannot be bypassed.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION app_webhook_event_data_of(
    p_type "NotificationType",
    p_payload jsonb
) RETURNS jsonb
LANGUAGE sql IMMUTABLE AS $$
    SELECT COALESCE(
        jsonb_object_agg(k, p_payload -> k) FILTER (WHERE p_payload ? k),
        '{}'::jsonb
    )
    FROM unnest(
        CASE p_type
            WHEN 'SUBMISSION_READY' THEN
                ARRAY['submissionId', 'submissionRevisionId', 'revisionNumber']
            WHEN 'SUBMISSION_REVISION_READY' THEN
                ARRAY['submissionId', 'submissionRevisionId', 'revisionNumber']
            WHEN 'SUBMISSION_UNDER_REVIEW' THEN
                ARRAY['submissionId', 'submissionRevisionId', 'institutionDecisionStatus']
            WHEN 'SUBMISSION_APPROVED' THEN
                ARRAY['submissionId', 'submissionRevisionId', 'institutionDecisionStatus']
            WHEN 'SUBMISSION_REJECTED' THEN
                ARRAY['submissionId', 'submissionRevisionId', 'institutionDecisionStatus']
            WHEN 'SUBMISSION_REVISION_REQUESTED' THEN
                ARRAY['submissionId', 'submissionRevisionId', 'institutionDecisionStatus']
            WHEN 'SUBMISSION_COMMENT_ADDED' THEN
                ARRAY['submissionId', 'submissionRevisionId']
            WHEN 'CERTIFICATE_ISSUED' THEN ARRAY['certificateId', 'submissionId']
            WHEN 'CERTIFICATE_REVOKED' THEN ARRAY['certificateId', 'submissionId']
        END
    ) AS k;
$$;

DROP FUNCTION IF EXISTS app_webhook_event_create(uuid, jsonb, text);

/*
 * Project a DomainEvent outward.
 *
 * The caller supplies the new row's id and the hash of the body it built. Both
 * are transport identity: the id has to exist before the body can be
 * canonicalized, because the id is inside the body, and the hash is what every
 * later attempt checks its bytes against. Neither is a claim about the
 * business fact.
 *
 * Everything that *is* a claim — the organization, the event type, the time it
 * happened, the data — comes from the DomainEvent.
 *
 * Idempotent: a redelivered fan-out job returns the existing row. When it does,
 * the caller's id is ignored, which is correct — the first projection won, and
 * its body hash is the one the deliveries were built against.
 */
CREATE OR REPLACE FUNCTION app_webhook_event_create(
    p_domain_event_id uuid,
    p_webhook_event_id uuid,
    p_body_sha256 text
) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
    v_event "domain_events"%ROWTYPE;
    v_id uuid;
BEGIN
    IF NOT app_is_webhook_system_context() THEN
        RAISE EXCEPTION 'webhook event projection is system work';
    END IF;

    SELECT * INTO v_event FROM "domain_events" WHERE "id" = p_domain_event_id;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'domain_event % does not exist', p_domain_event_id;
    END IF;

    IF NOT v_event."webhook_eligible" THEN
        RAISE EXCEPTION 'domain_event % is not eligible for webhook projection',
            p_domain_event_id;
    END IF;

    -- A payload written under a schema this function does not understand may
    -- not be projected on a guess. Refusing is the only safe answer, because
    -- the alternative is announcing a shape an integrator never agreed to.
    IF v_event."event_schema_version" <> 1 THEN
        RAISE EXCEPTION 'domain_event % has unsupported schema version %',
            p_domain_event_id, v_event."event_schema_version";
    END IF;

    PERFORM set_config('palcert.webhook_write_mode', 'system', true);

    INSERT INTO "webhook_events" (
        "id", "domain_event_id", "organization_id", "event_type",
        "schema_version", "occurred_at", "data", "body_sha256"
    ) VALUES (
        p_webhook_event_id, v_event."id", v_event."organization_id",
        app_webhook_event_type_of(v_event."event_type"),
        1, v_event."occurred_at",
        app_webhook_event_data_of(v_event."event_type", v_event."payload"),
        p_body_sha256
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

-- =============================================================================
-- 3. Activation is a consequence, not a request
--
-- The old signature took a configuration id and checked that the configuration
-- looked ready. Every one of those checks was about state, and none of them was
-- about whether anybody had actually answered a challenge — so a caller who
-- could reach the function could make an endpoint live without a single packet
-- having left the building.
--
-- The new signature takes a verification attempt. A row in
-- `webhook_verification_attempts` with `outcome = SUCCEEDED` exists only
-- because the worker opened an attempt, sent a signed challenge, and got the
-- exact nonce back. That row is the proof, it is append-only, and it cannot be
-- closed twice. Everything else is derived from it.
-- =============================================================================
DROP FUNCTION IF EXISTS app_webhook_config_activate(uuid);

CREATE OR REPLACE FUNCTION app_webhook_config_activate(p_verification_attempt_id uuid)
RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
    v_attempt "webhook_verification_attempts"%ROWTYPE;
    v_operation "webhook_management_operations"%ROWTYPE;
    v_config "webhook_endpoint_config_versions"%ROWTYPE;
    v_endpoint "webhook_endpoints"%ROWTYPE;
BEGIN
    IF NOT app_is_webhook_system_context() THEN
        RAISE EXCEPTION 'webhook configuration activation is system work';
    END IF;

    SELECT * INTO v_attempt FROM "webhook_verification_attempts"
     WHERE "id" = p_verification_attempt_id;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'webhook verification attempt % does not exist',
            p_verification_attempt_id;
    END IF;

    -- The proof itself.
    IF v_attempt."outcome" IS DISTINCT FROM 'SUCCEEDED' THEN
        RAISE EXCEPTION 'webhook verification attempt % did not succeed',
            p_verification_attempt_id;
    END IF;

    SELECT * INTO v_operation FROM "webhook_management_operations"
     WHERE "id" = v_attempt."operation_id" FOR UPDATE;
    IF v_operation."operation" <> 'VERIFY_CONFIG' THEN
        RAISE EXCEPTION 'webhook operation % is not a verification', v_operation."id";
    END IF;

    -- The attempt, the operation and the configuration must all describe the
    -- same intent. Without this a successful handshake for one endpoint could
    -- be presented as the proof for another.
    IF v_operation."config_version_id" IS DISTINCT FROM v_attempt."config_version_id"
       OR v_operation."endpoint_id" IS DISTINCT FROM v_attempt."endpoint_id"
    THEN
        RAISE EXCEPTION 'webhook verification attempt % does not match its operation',
            p_verification_attempt_id;
    END IF;

    SELECT * INTO v_config FROM "webhook_endpoint_config_versions"
     WHERE "id" = v_attempt."config_version_id";
    SELECT * INTO v_endpoint FROM "webhook_endpoints"
     WHERE "id" = v_attempt."endpoint_id" FOR UPDATE;

    -- Already done. A crash between closing the attempt and activating leaves
    -- exactly this state, and the retry must find it finished rather than
    -- either failing or manufacturing a second verification.
    IF v_endpoint."current_config_version_id" = v_config."id"
       AND v_config."status" = 'VERIFIED'
    THEN
        RETURN v_config."id";
    END IF;

    IF v_endpoint."pending_config_version_id" IS DISTINCT FROM v_config."id" THEN
        RAISE EXCEPTION 'webhook config version % is not the pending configuration',
            v_config."id";
    END IF;
    IF v_config."status" <> 'PENDING' THEN
        RAISE EXCEPTION 'webhook config version % is %', v_config."id", v_config."status";
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
       SET "status" = 'VERIFIED', "verified_at" = now(),
           "last_verification_error" = NULL, "last_verification_at" = now()
     WHERE "id" = v_config."id";

    -- A paused endpoint stays paused: an administrator who paused an
    -- integration and then fixed its receiver has not asked for events to
    -- resume.
    UPDATE "webhook_endpoints"
       SET "current_config_version_id" = v_config."id",
           "pending_config_version_id" = NULL,
           "status" = (CASE WHEN "status" = 'PAUSED' THEN 'PAUSED' ELSE 'ACTIVE' END)
                      ::"WebhookEndpointStatus",
           "updated_at" = now()
     WHERE "id" = v_endpoint."id";

    PERFORM set_config('palcert.webhook_write_mode', 'off', true);
    RETURN v_config."id";
END;
$$;

/*
 * Record a failed verification, bound to the attempt that failed.
 *
 * Same derivation, same reason: an arbitrary system caller must not be able to
 * write a failure code onto an unrelated configuration, which would show an
 * organization an error about an endpoint that is working.
 *
 * The normalized code comes from the attempt, not from a parameter, so the
 * error an organization reads is the error the worker actually recorded.
 */
DROP FUNCTION IF EXISTS app_webhook_config_verification_failed(uuid, text);

CREATE OR REPLACE FUNCTION app_webhook_config_verification_failed(
    p_verification_attempt_id uuid
) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
    v_attempt "webhook_verification_attempts"%ROWTYPE;
    v_operation "webhook_management_operations"%ROWTYPE;
BEGIN
    IF NOT app_is_webhook_system_context() THEN
        RAISE EXCEPTION 'recording a webhook verification failure is system work';
    END IF;

    SELECT * INTO v_attempt FROM "webhook_verification_attempts"
     WHERE "id" = p_verification_attempt_id;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'webhook verification attempt % does not exist',
            p_verification_attempt_id;
    END IF;
    IF v_attempt."outcome" IS NULL OR v_attempt."outcome" = 'SUCCEEDED' THEN
        RAISE EXCEPTION 'webhook verification attempt % did not fail',
            p_verification_attempt_id;
    END IF;

    SELECT * INTO v_operation FROM "webhook_management_operations"
     WHERE "id" = v_attempt."operation_id";
    IF v_operation."operation" <> 'VERIFY_CONFIG'
       OR v_operation."config_version_id" IS DISTINCT FROM v_attempt."config_version_id"
       OR v_operation."endpoint_id" IS DISTINCT FROM v_attempt."endpoint_id"
    THEN
        RAISE EXCEPTION 'webhook verification attempt % does not match its operation',
            p_verification_attempt_id;
    END IF;

    PERFORM set_config('palcert.webhook_write_mode', 'lifecycle', true);

    -- `status = 'PENDING'` in the predicate is what stops a stale failure
    -- reviving the lifecycle of a configuration that was superseded while the
    -- request was in flight: it simply matches no row.
    UPDATE "webhook_endpoint_config_versions"
       SET "last_verification_error" = v_attempt."error_code",
           "last_verification_at" = COALESCE(v_attempt."finished_at", now())
     WHERE "id" = v_attempt."config_version_id" AND "status" = 'PENDING';

    PERFORM set_config('palcert.webhook_write_mode', 'off', true);
END;
$$;

-- =============================================================================
-- 4. Closed transition graphs
--
-- Both doorways accepted any target state, which made them columns with extra
-- steps. The graphs below are the whole of the lifecycle, and they live here
-- rather than in a service because a service is one of several callers and the
-- database is the only place all of them meet.
-- =============================================================================

/*
 * Endpoint lifecycle.
 *
 *   PENDING_VERIFICATION → DISABLED
 *                        → ACTIVE only through successful verification
 *   ACTIVE               → PAUSED, DISABLED
 *   PAUSED               → ACTIVE, DISABLED
 *   DISABLED             → nothing
 *
 * Deliberately absent: any route back to PENDING_VERIFICATION. An endpoint
 * that has been verified does not become unverified because somebody set a
 * column; a new URL creates a new pending configuration and leaves the current
 * one serving until that one is proved.
 *
 * A same-state request is a safe no-op rather than a conflict, chosen because
 * the caller is usually a retry of an idempotent management operation and the
 * state it asked for is the state that holds.
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

    IF v_endpoint."status" = p_status THEN
        RETURN;
    END IF;

    IF v_endpoint."status" = 'DISABLED' THEN
        RAISE EXCEPTION 'webhook endpoint % is disabled and has no further transitions',
            p_endpoint_id;
    END IF;

    IF p_status = 'PENDING_VERIFICATION' THEN
        RAISE EXCEPTION 'a webhook endpoint never returns to PENDING_VERIFICATION';
    END IF;

    IF p_status = 'ACTIVE' AND v_endpoint."status" <> 'PAUSED' THEN
        RAISE EXCEPTION
            'webhook endpoint % becomes active through verification, not a status change',
            p_endpoint_id;
    END IF;

    IF p_status = 'PAUSED' AND v_endpoint."status" <> 'ACTIVE' THEN
        RAISE EXCEPTION 'only an active webhook endpoint can be paused';
    END IF;

    IF p_status = 'ACTIVE' AND v_endpoint."current_config_version_id" IS NULL THEN
        RAISE EXCEPTION 'webhook endpoint % has no verified configuration', p_endpoint_id;
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

/*
 * Delivery lifecycle.
 *
 *   PENDING          → SENDING, SKIPPED, FAILED_PERMANENT
 *   SENDING          → DELIVERED, FAILED_RETRYABLE, FAILED_PERMANENT
 *   FAILED_RETRYABLE → SENDING, SKIPPED, FAILED_PERMANENT
 *   DELIVERED / FAILED_PERMANENT / SKIPPED → terminal
 *
 * PENDING → FAILED_PERMANENT is legitimate and load-bearing: a destination
 * refused by policy, a configuration whose integrity check failed, or a key the
 * process does not hold are all decided before any socket is opened, and the
 * delivery must be able to settle without ever having been SENDING.
 *
 * PENDING → SKIPPED covers the endpoint being paused or the subscription being
 * removed between fan-out and the attempt.
 */
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
DECLARE
    v_from "WebhookDeliveryStatus";
    v_allowed boolean;
BEGIN
    IF NOT app_is_webhook_system_context() THEN
        RAISE EXCEPTION 'moving a webhook delivery is system work';
    END IF;

    SELECT "status" INTO v_from FROM "webhook_deliveries"
     WHERE "id" = p_delivery_id FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'webhook delivery % does not exist', p_delivery_id;
    END IF;

    v_allowed := CASE v_from
        WHEN 'PENDING' THEN
            p_status IN ('SENDING', 'SKIPPED', 'FAILED_PERMANENT')
        WHEN 'SENDING' THEN
            p_status IN ('DELIVERED', 'FAILED_RETRYABLE', 'FAILED_PERMANENT')
        WHEN 'FAILED_RETRYABLE' THEN
            p_status IN ('SENDING', 'SKIPPED', 'FAILED_PERMANENT')
        ELSE false
    END;

    IF NOT v_allowed THEN
        RAISE EXCEPTION 'webhook delivery % cannot move from % to %',
            p_delivery_id, v_from, p_status;
    END IF;

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

    PERFORM set_config('palcert.webhook_write_mode', 'off', true);
END;
$$;

/*
 * Opening an attempt requires a delivery that can still be attempted.
 *
 * A terminal delivery acquiring a new attempt is how a delivery log stops
 * being evidence: the row says DELIVERED and the history says PalCert kept
 * trying afterwards, and neither can be trusted once they disagree.
 */
CREATE OR REPLACE FUNCTION app_webhook_attempt_open(
    p_delivery_id uuid,
    p_started_at timestamptz
) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
    v_status "WebhookDeliveryStatus";
    v_number integer;
    v_id uuid;
BEGIN
    IF NOT app_is_webhook_system_context() THEN
        RAISE EXCEPTION 'opening a webhook attempt is system work';
    END IF;

    SELECT "status" INTO v_status FROM "webhook_deliveries"
     WHERE "id" = p_delivery_id FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'webhook delivery % does not exist', p_delivery_id;
    END IF;

    IF v_status NOT IN ('PENDING', 'SENDING', 'FAILED_RETRYABLE') THEN
        RAISE EXCEPTION 'webhook delivery % is % and cannot be attempted again',
            p_delivery_id, v_status;
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

-- =============================================================================
-- 5. The remaining system doorways
--
-- Same gate, restated at each one rather than inherited, because a caller
-- reads the function it is calling and not the section header above it.
-- =============================================================================

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
    IF NOT app_is_webhook_system_context() THEN
        RAISE EXCEPTION 'webhook fan-out is system work';
    END IF;

    SELECT * INTO v_event FROM "webhook_events" WHERE "id" = p_webhook_event_id;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'webhook_event % does not exist', p_webhook_event_id;
    END IF;

    SELECT * INTO v_endpoint FROM "webhook_endpoints" WHERE "id" = p_endpoint_id;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'webhook endpoint % does not exist', p_endpoint_id;
    END IF;

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
           AND "endpoint_id" = p_endpoint_id AND "kind" = 'ORIGINAL';
    END IF;

    PERFORM set_config('palcert.webhook_write_mode', 'off', true);
    RETURN v_id;
END;
$$;

CREATE OR REPLACE FUNCTION app_webhook_attempt_close(
    p_attempt_id uuid,
    p_outcome "WebhookAttemptOutcome",
    p_error_code text,
    p_http_status integer,
    p_duration_ms integer
) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
    IF NOT app_is_webhook_system_context() THEN
        RAISE EXCEPTION 'closing a webhook attempt is system work';
    END IF;

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
    IF NOT app_is_webhook_system_context() THEN
        RAISE EXCEPTION 'opening a webhook verification attempt is system work';
    END IF;

    SELECT "endpoint_id" INTO v_endpoint_id
      FROM "webhook_endpoint_config_versions" WHERE "id" = p_config_version_id;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'webhook config version % does not exist', p_config_version_id;
    END IF;

    PERFORM 1 FROM "webhook_management_operations"
     WHERE "id" = p_operation_id AND "endpoint_id" = v_endpoint_id
       AND "operation" = 'VERIFY_CONFIG' AND "config_version_id" = p_config_version_id
     FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'webhook operation % is not a verification of config %',
            p_operation_id, p_config_version_id;
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
    IF NOT app_is_webhook_system_context() THEN
        RAISE EXCEPTION 'closing a webhook verification attempt is system work';
    END IF;

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

CREATE OR REPLACE FUNCTION app_webhook_operation_settle(
    p_operation_id uuid,
    p_error_code text
) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
    IF NOT app_is_webhook_system_context() THEN
        RAISE EXCEPTION 'settling a webhook operation is system work';
    END IF;

    PERFORM set_config('palcert.webhook_write_mode', 'system', true);

    UPDATE "webhook_management_operations"
       SET "settled_at" = now(),
           "settled_error_code" = p_error_code::"webhook_error_code",
           "updated_at" = now()
     WHERE "id" = p_operation_id;

    PERFORM set_config('palcert.webhook_write_mode', 'off', true);
END;
$$;

CREATE OR REPLACE FUNCTION app_webhook_reveal_clear(p_operation_id uuid)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
    IF NOT app_is_webhook_system_context() THEN
        RAISE EXCEPTION 'wiping expired reveal material is system work';
    END IF;

    PERFORM set_config('palcert.webhook_write_mode', 'reveal_clear', true);

    UPDATE "webhook_management_operations"
       SET "reveal_ciphertext" = NULL, "reveal_iv" = NULL,
           "reveal_auth_tag" = NULL, "reveal_encryption_key_id" = NULL,
           "updated_at" = now()
     WHERE "id" = p_operation_id AND "reveal_ciphertext" IS NOT NULL;

    PERFORM set_config('palcert.webhook_write_mode', 'off', true);
END;
$$;

CREATE OR REPLACE FUNCTION app_webhook_config_rewrap(
    p_config_version_id uuid,
    p_url_ciphertext text, p_url_iv text, p_url_auth_tag text, p_url_kid text,
    p_secret_ciphertext text, p_secret_iv text, p_secret_auth_tag text, p_secret_kid text
) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
    IF NOT app_is_webhook_system_context() THEN
        RAISE EXCEPTION 'a webhook rewrap is maintenance work, not a request';
    END IF;

    PERFORM set_config('palcert.webhook_write_mode', 'rewrap', true);

    UPDATE "webhook_endpoint_config_versions"
       SET "url_ciphertext" = p_url_ciphertext, "url_iv" = p_url_iv,
           "url_auth_tag" = p_url_auth_tag, "url_encryption_key_id" = p_url_kid,
           "secret_ciphertext" = p_secret_ciphertext, "secret_iv" = p_secret_iv,
           "secret_auth_tag" = p_secret_auth_tag, "secret_encryption_key_id" = p_secret_kid
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
    IF NOT app_is_webhook_system_context() THEN
        RAISE EXCEPTION 'a webhook rewrap is maintenance work, not a request';
    END IF;
    IF p_reveal_ciphertext IS NULL THEN
        RAISE EXCEPTION 'a rewrap must produce reveal material';
    END IF;

    PERFORM set_config('palcert.webhook_write_mode', 'rewrap', true);

    UPDATE "webhook_management_operations"
       SET "reveal_ciphertext" = p_reveal_ciphertext, "reveal_iv" = p_reveal_iv,
           "reveal_auth_tag" = p_reveal_auth_tag, "reveal_encryption_key_id" = p_reveal_kid,
           "updated_at" = now()
     WHERE "id" = p_operation_id AND "reveal_ciphertext" IS NOT NULL;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'webhook operation % holds no reveal material', p_operation_id;
    END IF;

    PERFORM set_config('palcert.webhook_write_mode', 'off', true);
END;
$$;

-- =============================================================================
-- 6. Two read surfaces, deliberately different
--
-- Direct SELECT on a SYSTEM table meant that any route bug could read another
-- organization's rows by id, or list every organization's deliveries at once —
-- because the tenancy of these tables lives in a column and nothing was
-- checking it. Classifying a table SYSTEM and then leaving it globally
-- readable by the request role says the classification out loud and does not
-- mean it.
--
-- So: no direct SELECT at all, and two doorways instead.
--
--   A) System reads — for the worker. Require system context, return what a
--      send or a sweep needs, and nothing more.
--
--   B) Tenant reads — for support screens. Verify the caller's organization and
--      return only supportability fields: what happened and when, never a URL,
--      a signature, a secret, a resolved address or anybody's response.
-- =============================================================================

-- --- A) System reads ---------------------------------------------------------

CREATE OR REPLACE FUNCTION app_webhook_event_system_get(p_event_id uuid)
RETURNS TABLE (
    id uuid, domain_event_id uuid, organization_id uuid,
    event_type "WebhookEventType", schema_version integer,
    occurred_at timestamptz, data jsonb, body_sha256 text
)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
    IF NOT app_is_webhook_system_context() THEN
        RAISE EXCEPTION 'webhook event rows are system data';
    END IF;
    RETURN QUERY
    SELECT e."id", e."domain_event_id", e."organization_id", e."event_type",
           e."schema_version", e."occurred_at", e."data", e."body_sha256"::text
      FROM "webhook_events" e WHERE e."id" = p_event_id;
END;
$$;

CREATE OR REPLACE FUNCTION app_webhook_delivery_system_get(p_delivery_id uuid)
RETURNS TABLE (
    id uuid, webhook_event_id uuid, endpoint_id uuid,
    endpoint_config_version_id uuid, organization_id uuid,
    kind "WebhookDeliveryKind", status "WebhookDeliveryStatus",
    attempt_count integer, next_attempt_at timestamptz,
    replay_of_delivery_id uuid, control_occurred_at timestamptz,
    body_sha256 text, event_body_sha256 text, event_type "WebhookEventType",
    endpoint_status "WebhookEndpointStatus", subscribed boolean
)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
    IF NOT app_is_webhook_system_context() THEN
        RAISE EXCEPTION 'webhook delivery rows are system data';
    END IF;

    -- The endpoint's current state and the subscription are returned with the
    -- delivery because both have to be re-checked before every network
    -- attempt, and fetching them separately invites a worker to skip one.
    RETURN QUERY
    SELECT d."id", d."webhook_event_id", d."endpoint_id",
           d."endpoint_config_version_id", d."organization_id",
           d."kind", d."status", d."attempt_count", d."next_attempt_at",
           d."replay_of_delivery_id", d."control_occurred_at",
           d."body_sha256"::text, e."body_sha256"::text, e."event_type",
           p."status",
           (e."event_type" IS NULL
            OR EXISTS (SELECT 1 FROM "webhook_subscriptions" s
                        WHERE s."endpoint_id" = d."endpoint_id"
                          AND s."event_type" = e."event_type"))
      FROM "webhook_deliveries" d
      JOIN "webhook_endpoints" p ON p."id" = d."endpoint_id"
      LEFT JOIN "webhook_events" e ON e."id" = d."webhook_event_id"
     WHERE d."id" = p_delivery_id;
END;
$$;

CREATE OR REPLACE FUNCTION app_webhook_delivery_attempts_system_get(p_delivery_id uuid)
RETURNS TABLE (
    id uuid, attempt_number integer, started_at timestamptz,
    finished_at timestamptz, outcome "WebhookAttemptOutcome",
    error_code text, http_status integer, duration_ms integer
)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
    IF NOT app_is_webhook_system_context() THEN
        RAISE EXCEPTION 'webhook attempt rows are system data';
    END IF;
    RETURN QUERY
    SELECT a."id", a."attempt_number", a."started_at", a."finished_at",
           a."outcome", a."error_code"::text, a."http_status", a."duration_ms"
      FROM "webhook_delivery_attempts" a
     WHERE a."delivery_id" = p_delivery_id
     ORDER BY a."attempt_number";
END;
$$;

/*
 * What a verification worker needs to resume.
 *
 * `succeeded_attempt_id` is the crash-recovery answer: if the process died
 * between closing a successful attempt and activating the configuration, the
 * reclaimed job finds the proof already on disk and activates from it rather
 * than sending a second challenge — which would be a new outbound request to
 * establish a fact that is already established.
 */
CREATE OR REPLACE FUNCTION app_webhook_verification_operation_system_get(p_operation_id uuid)
RETURNS TABLE (
    id uuid, organization_id uuid, endpoint_id uuid, config_version_id uuid,
    settled_at timestamptz, config_status "WebhookConfigStatus",
    endpoint_status "WebhookEndpointStatus", pending_config_version_id uuid,
    succeeded_attempt_id uuid, attempt_count bigint
)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
    IF NOT app_is_webhook_system_context() THEN
        RAISE EXCEPTION 'webhook operation rows are system data';
    END IF;
    RETURN QUERY
    SELECT o."id", o."organization_id", o."endpoint_id", o."config_version_id",
           o."settled_at", c."status", p."status", p."pending_config_version_id",
           (SELECT a."id" FROM "webhook_verification_attempts" a
             WHERE a."operation_id" = o."id" AND a."outcome" = 'SUCCEEDED'
             ORDER BY a."attempt_number" DESC LIMIT 1),
           (SELECT count(*) FROM "webhook_verification_attempts" a
             WHERE a."operation_id" = o."id")
      FROM "webhook_management_operations" o
      LEFT JOIN "webhook_endpoint_config_versions" c ON c."id" = o."config_version_id"
      LEFT JOIN "webhook_endpoints" p ON p."id" = o."endpoint_id"
     WHERE o."id" = p_operation_id AND o."operation" = 'VERIFY_CONFIG';
END;
$$;

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
    IF NOT app_is_webhook_system_context() THEN
        RAISE EXCEPTION 'sealed webhook configuration is not readable from a request';
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

-- --- B) Tenant support reads -------------------------------------------------
--
-- Views rather than functions, because these are list screens that want
-- ordinary filtering and paging. They run with the definer's privileges and
-- carry their own tenancy predicate, which is what lets the base tables stay
-- unreadable to `palcert_app`.

CREATE VIEW "webhook_delivery_safe" AS
SELECT d."id",
       d."organization_id",
       d."endpoint_id",
       d."webhook_event_id",
       e."event_type",
       d."kind",
       d."status",
       d."skip_reason",
       d."attempt_count",
       d."next_attempt_at",
       d."last_error_code",
       d."last_http_status",
       d."replay_of_delivery_id",
       c."version_number" AS "config_version_number",
       d."created_at",
       d."delivered_at",
       d."updated_at"
  FROM "webhook_deliveries" d
  JOIN "webhook_endpoint_config_versions" c ON c."id" = d."endpoint_config_version_id"
  LEFT JOIN "webhook_events" e ON e."id" = d."webhook_event_id"
 WHERE app_is_platform_admin() OR d."organization_id" = app_current_organization();

COMMENT ON VIEW "webhook_delivery_safe" IS
    'Delivery history an organization may read: what happened and when. No URL, no signature, no secret, no resolved address, no request or response body.';

CREATE VIEW "webhook_delivery_attempt_safe" AS
SELECT a."id",
       a."delivery_id",
       d."organization_id",
       a."attempt_number",
       a."outcome",
       a."error_code",
       a."http_status",
       a."duration_ms",
       a."started_at",
       a."finished_at"
  FROM "webhook_delivery_attempts" a
  JOIN "webhook_deliveries" d ON d."id" = a."delivery_id"
 WHERE app_is_platform_admin() OR d."organization_id" = app_current_organization();

COMMENT ON VIEW "webhook_delivery_attempt_safe" IS
    'Attempt history an organization may read: attempt number, outcome, normalized code, status, duration. Never remote text.';

CREATE VIEW "webhook_verification_attempt_safe" AS
SELECT v."id",
       v."operation_id",
       v."config_version_id",
       v."endpoint_id",
       o."organization_id",
       v."attempt_number",
       v."outcome",
       v."error_code",
       v."http_status",
       v."duration_ms",
       v."started_at",
       v."finished_at"
  FROM "webhook_verification_attempts" v
  JOIN "webhook_management_operations" o ON o."id" = v."operation_id"
 WHERE app_is_platform_admin() OR o."organization_id" = app_current_organization();

COMMENT ON VIEW "webhook_verification_attempt_safe" IS
    'Verification history an organization may read. Carries no challenge: the nonce exists only inside the attempt that generated it.';

CREATE VIEW "webhook_event_safe" AS
SELECT e."id",
       e."organization_id",
       e."event_type",
       e."schema_version",
       e."occurred_at",
       e."created_at"
  FROM "webhook_events" e
 WHERE app_is_platform_admin() OR e."organization_id" = app_current_organization();

COMMENT ON VIEW "webhook_event_safe" IS
    'Which events were projected, and when. The body itself is not a tenant read: it is reconstructed by the worker and sent.';

-- =============================================================================
-- 7. Privileges
--
-- No direct access of any kind to the SYSTEM base tables. The projections and
-- the system functions are the whole surface.
--
-- Every projection is SELECT-only and is revoked first, because the database
-- grants `arwd` on each new relation by default and a single-table view is
-- auto-updatable — which would make a read projection a write path into the
-- table it was created to protect.
-- =============================================================================
REVOKE ALL ON "webhook_events" FROM "palcert_app";
REVOKE ALL ON "webhook_deliveries" FROM "palcert_app";
REVOKE ALL ON "webhook_delivery_attempts" FROM "palcert_app";
REVOKE ALL ON "webhook_verification_attempts" FROM "palcert_app";
REVOKE ALL ON "webhook_endpoint_config_versions" FROM "palcert_app";
REVOKE ALL ON "webhook_management_operations" FROM "palcert_app";

REVOKE ALL ON "webhook_config_version_safe" FROM "palcert_app";
REVOKE ALL ON "webhook_management_operation_safe" FROM "palcert_app";
REVOKE ALL ON "webhook_delivery_safe" FROM "palcert_app";
REVOKE ALL ON "webhook_delivery_attempt_safe" FROM "palcert_app";
REVOKE ALL ON "webhook_verification_attempt_safe" FROM "palcert_app";
REVOKE ALL ON "webhook_event_safe" FROM "palcert_app";

GRANT SELECT ON "webhook_config_version_safe" TO "palcert_app";
GRANT SELECT ON "webhook_management_operation_safe" TO "palcert_app";
GRANT SELECT ON "webhook_delivery_safe" TO "palcert_app";
GRANT SELECT ON "webhook_delivery_attempt_safe" TO "palcert_app";
GRANT SELECT ON "webhook_verification_attempt_safe" TO "palcert_app";
GRANT SELECT ON "webhook_event_safe" TO "palcert_app";

GRANT EXECUTE ON FUNCTION app_is_webhook_system_context() TO "palcert_app";
GRANT EXECUTE ON FUNCTION app_is_webhook_system_reader() TO "palcert_app";
GRANT EXECUTE ON FUNCTION app_webhook_event_data_of("NotificationType", jsonb)
    TO "palcert_app";
GRANT EXECUTE ON FUNCTION app_webhook_event_create(uuid, uuid, text) TO "palcert_app";
GRANT EXECUTE ON FUNCTION app_webhook_config_activate(uuid) TO "palcert_app";
GRANT EXECUTE ON FUNCTION app_webhook_config_verification_failed(uuid) TO "palcert_app";
GRANT EXECUTE ON FUNCTION app_webhook_event_system_get(uuid) TO "palcert_app";
GRANT EXECUTE ON FUNCTION app_webhook_delivery_system_get(uuid) TO "palcert_app";
GRANT EXECUTE ON FUNCTION app_webhook_delivery_attempts_system_get(uuid) TO "palcert_app";
GRANT EXECUTE ON FUNCTION app_webhook_verification_operation_system_get(uuid)
    TO "palcert_app";
