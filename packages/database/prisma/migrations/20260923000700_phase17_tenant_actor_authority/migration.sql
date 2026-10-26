-- =============================================================================
-- Phase 17 — tenant actor authority
--
-- The system boundary was made explicit: no user, no organization. Its
-- complement was left implicit, and an implicit complement is not a boundary.
--
-- The ownership guard on the tenant-callable functions read, in effect:
--
--     IF an organization is resolved AND it is not this endpoint's
--     THEN refuse
--
-- which says nothing at all when no organization is resolved. A caller with a
-- user and no organization — a self-service request — passed it. So did a
-- caller with neither. Both could then name any endpoint by UUID and act on it,
-- because the only check that would have caught them was the one that never
-- ran.
--
-- The two contexts are now stated as an intentional split, and everything
-- outside the pair is refused:
--
--     SYSTEM        user NULL      organization NULL
--     TENANT ACTOR  user NOT NULL  organization NOT NULL
--
-- Additive. Nothing about the system side changes.
-- =============================================================================

/*
 * A real person, acting inside a real organization.
 *
 * Both halves matter and neither implies the other. An organization without a
 * user is a context nothing legitimate produces — there is no anonymous
 * organization actor in PalCert — and a user without an organization is a
 * person acting for themselves, who has no business touching an institution's
 * integration whatever their UUID arithmetic says.
 */
CREATE OR REPLACE FUNCTION app_is_webhook_tenant_actor_context() RETURNS boolean
LANGUAGE sql STABLE AS $$
    SELECT COALESCE(
        app_current_user_id() IS NOT NULL AND app_current_organization() IS NOT NULL,
        false
    );
$$;

GRANT EXECUTE ON FUNCTION app_is_webhook_tenant_actor_context() TO "palcert_app";

-- -----------------------------------------------------------------------------
-- Every tenant-callable mutation now gates on it *before* asking about
-- ownership, so the ownership question is only ever asked in a context where it
-- has an answer.
-- -----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION app_webhook_endpoint_lifecycle(
    p_endpoint_id uuid,
    p_status "WebhookEndpointStatus"
) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
    v_endpoint "webhook_endpoints"%ROWTYPE;
BEGIN
    IF NOT app_is_webhook_tenant_actor_context() THEN
        RAISE EXCEPTION 'changing a webhook endpoint requires an organization actor';
    END IF;

    SELECT * INTO v_endpoint FROM "webhook_endpoints"
     WHERE "id" = p_endpoint_id FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'webhook endpoint % does not exist', p_endpoint_id;
    END IF;

    IF v_endpoint."organization_id" <> app_current_organization() THEN
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
    IF NOT app_is_webhook_tenant_actor_context() THEN
        RAISE EXCEPTION 'saving a webhook configuration requires an organization actor';
    END IF;

    SELECT * INTO v_endpoint FROM "webhook_endpoints"
     WHERE "id" = p_endpoint_id FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'webhook endpoint % does not exist', p_endpoint_id;
    END IF;

    IF v_endpoint."organization_id" <> app_current_organization() THEN
        RAISE EXCEPTION 'webhook endpoint % is not the caller''s', p_endpoint_id;
    END IF;

    IF v_endpoint."status" = 'DISABLED' THEN
        RAISE EXCEPTION 'webhook endpoint % is disabled', p_endpoint_id;
    END IF;

    PERFORM set_config('palcert.webhook_write_mode', 'lifecycle', true);

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
    v_org uuid;
    v_actor uuid;
    v_id uuid;
BEGIN
    IF NOT app_is_webhook_tenant_actor_context() THEN
        RAISE EXCEPTION 'a webhook management operation requires an organization actor';
    END IF;

    v_org := app_current_organization();
    v_actor := app_current_user_id();

    -- A named resource must belong to the caller's organization. Previously the
    -- row was written with whatever ids were passed, and only the foreign keys
    -- objected — which they do not when the id is simply another organization's.
    IF p_endpoint_id IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM "webhook_endpoints"
         WHERE "id" = p_endpoint_id AND "organization_id" = v_org
    ) THEN
        RAISE EXCEPTION 'webhook endpoint % is not the caller''s', p_endpoint_id;
    END IF;

    IF p_delivery_id IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM "webhook_deliveries"
         WHERE "id" = p_delivery_id AND "organization_id" = v_org
    ) THEN
        RAISE EXCEPTION 'webhook delivery % is not the caller''s', p_delivery_id;
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
    IF NOT app_is_webhook_tenant_actor_context() THEN
        RAISE EXCEPTION 'sending a webhook test requires an organization actor';
    END IF;

    SELECT * INTO v_endpoint FROM "webhook_endpoints" WHERE "id" = p_endpoint_id;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'webhook endpoint % does not exist', p_endpoint_id;
    END IF;

    IF v_endpoint."organization_id" <> app_current_organization() THEN
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

CREATE OR REPLACE FUNCTION app_webhook_delivery_create_replay(
    p_source_delivery_id uuid
) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
    v_source "webhook_deliveries"%ROWTYPE;
    v_endpoint "webhook_endpoints"%ROWTYPE;
    v_id uuid;
BEGIN
    IF NOT app_is_webhook_tenant_actor_context() THEN
        RAISE EXCEPTION 'replaying a webhook delivery requires an organization actor';
    END IF;

    SELECT * INTO v_source FROM "webhook_deliveries" WHERE "id" = p_source_delivery_id;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'webhook delivery % does not exist', p_source_delivery_id;
    END IF;

    IF v_source."organization_id" <> app_current_organization() THEN
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
    IF NOT app_is_webhook_tenant_actor_context() THEN
        RAISE EXCEPTION 'recovering a webhook secret requires an organization actor';
    END IF;

    SELECT * INTO v_row FROM "webhook_management_operations" WHERE "id" = p_operation_id;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'webhook operation % does not exist', p_operation_id;
    END IF;

    IF v_row."organization_id" <> app_current_organization()
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
