-- Phase 17 — the caller names the management operation.
--
-- Same reason the configuration id moved to the caller two migrations ago: a
-- secret reveal is sealed with the operation id inside its additional
-- authenticated data, so the id has to exist before the envelope does. With the
-- database choosing it, the only orders available were "seal against an id that
-- does not exist yet" and "insert the row, then update it with ciphertext" —
-- the first is impossible and the second puts a lifecycle write on a table
-- whose whole point is that it is written once.
--
-- The old signature is dropped rather than left beside this one. Two ways to
-- create the same durable intent is how one of them quietly stops being
-- maintained.

DROP FUNCTION IF EXISTS app_webhook_management_operation_create(
    "WebhookManagementOperationType", text, text, uuid, uuid, uuid,
    text, text, text, text, timestamptz);

CREATE OR REPLACE FUNCTION app_webhook_management_operation_create(
    p_operation_id uuid,
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
    v_config_endpoint uuid;
    v_id uuid;
BEGIN
    IF NOT app_is_webhook_tenant_actor_context() THEN
        RAISE EXCEPTION 'a webhook management operation requires an organization actor';
    END IF;

    v_org := app_current_organization();
    v_actor := app_current_user_id();

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

    IF p_config_version_id IS NOT NULL THEN
        -- A configuration's tenancy is its endpoint's. Resolving it here is
        -- what the nullable composite foreign key silently declined to do.
        SELECT c."endpoint_id" INTO v_config_endpoint
          FROM "webhook_endpoint_config_versions" c
          JOIN "webhook_endpoints" e ON e."id" = c."endpoint_id"
         WHERE c."id" = p_config_version_id AND e."organization_id" = v_org;

        IF NOT FOUND THEN
            RAISE EXCEPTION 'webhook config version % is not the caller''s',
                p_config_version_id;
        END IF;

        -- And when both are named they must describe one endpoint, or the
        -- operation records an intent about two different integrations.
        IF p_endpoint_id IS NOT NULL AND v_config_endpoint <> p_endpoint_id THEN
            RAISE EXCEPTION 'webhook config version % does not belong to endpoint %',
                p_config_version_id, p_endpoint_id;
        END IF;
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
        p_operation_id, v_org, p_operation,
        p_idempotency_key_hash, p_request_fingerprint, v_actor,
        p_endpoint_id, p_config_version_id, p_delivery_id,
        p_reveal_ciphertext, p_reveal_iv, p_reveal_auth_tag, p_reveal_kid,
        p_reveal_expires_at, now()
    ) RETURNING "id" INTO v_id;

    PERFORM set_config('palcert.webhook_write_mode', 'off', true);
    RETURN v_id;
END;
$$;

REVOKE ALL ON FUNCTION app_webhook_management_operation_create(
    uuid, "WebhookManagementOperationType", text, text, uuid, uuid, uuid,
    text, text, text, text, timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_webhook_management_operation_create(
    uuid, "WebhookManagementOperationType", text, text, uuid, uuid, uuid,
    text, text, text, text, timestamptz) TO "palcert_app";

-- -----------------------------------------------------------------------------
-- How much traffic is still bound to a configuration that is no longer current.
--
-- The number a receiver watches during a secret rotation. A tenant read, not a
-- system one: it is about the organization's own endpoint, and it is a count
-- rather than a list so it cannot become a way to enumerate deliveries.
-- -----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION app_webhook_unsettled_old_config_count(p_endpoint_id uuid)
RETURNS bigint
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
    v_org uuid;
    v_current uuid;
    v_count bigint;
BEGIN
    IF NOT app_is_webhook_tenant_actor_context() THEN
        RAISE EXCEPTION 'reading a webhook endpoint requires an organization actor';
    END IF;
    v_org := app_current_organization();

    SELECT "current_config_version_id" INTO v_current FROM "webhook_endpoints"
     WHERE "id" = p_endpoint_id AND "organization_id" = v_org;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'webhook endpoint % is not the caller''s', p_endpoint_id;
    END IF;

    SELECT count(*) INTO v_count FROM "webhook_deliveries" d
     WHERE d."endpoint_id" = p_endpoint_id
       AND d."status" IN ('PENDING', 'SENDING', 'FAILED_RETRYABLE')
       AND d."endpoint_config_version_id" IS DISTINCT FROM v_current;

    RETURN v_count;
END;
$$;

REVOKE ALL ON FUNCTION app_webhook_unsettled_old_config_count(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_webhook_unsettled_old_config_count(uuid) TO "palcert_app";
