-- =============================================================================
-- Phase 17 — management operation shape and config ownership
--
-- Two gaps, both in what a durable management operation is allowed to say.
--
-- First, ownership. The previous migration checked that a named endpoint and a
-- named delivery belong to the caller, and left the configuration to the
-- composite foreign key:
--
--     (config_version_id, endpoint_id) → config_versions(id, endpoint_id)
--
-- PostgreSQL uses MATCH SIMPLE, which means a composite reference with any NULL
-- column is not checked at all. So an operation naming another organization's
-- configuration with `endpoint_id` left NULL referenced nothing, satisfied
-- everything, and was written. A worker would have refused it later, but the
-- row recording one tenant's intent against another tenant's resource would
-- already exist — and that row is the thing an idempotency key returns.
--
-- Second, shape. Every operation type has a resource footprint it cannot be
-- meaningful without, and nothing enforced it. A VERIFY_CONFIG with no
-- configuration is an intent to verify nothing; a ROTATE_SECRET with no reveal
-- is a rotation whose secret was never recoverable. Both were writable.
--
-- Additive. No earlier migration is edited.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. The resource footprint of each operation
--
--   CREATE_ENDPOINT   endpoint + config,   no delivery,  carries a secret
--   UPDATE_URL        endpoint + config,   no delivery,  no secret
--   VERIFY_CONFIG     endpoint + config,   no delivery,  no secret
--   TEST_ENDPOINT     endpoint + delivery, no config,    no secret
--   ROTATE_SECRET     endpoint + config,   no delivery,  carries a secret
--   REPLAY_DELIVERY   endpoint + delivery, no config,    no secret
--
-- Two of those deserve their reasons written down.
--
-- TEST_ENDPOINT and REPLAY_DELIVERY record no configuration. The delivery they
-- produced already carries `endpoint_config_version_id`, and that pointer is
-- the one the worker actually sends under; a second copy on the operation row
-- would be a fact that can drift from the fact, and there is no rule that could
-- say which of the two is right afterwards.
--
-- The secret dimension keys on `reveal_expires_at` rather than on the
-- ciphertext. The ciphertext is deliberately removable — that is what expiry
-- cleanup does — so a constraint written against it would forbid the sweeper
-- from doing its job. `reveal_expires_at` is immutable by the existing guard
-- and is set only when reveal material was written, so it is the durable record
-- of "this operation carried a secret", which is what the shape rule is about.
-- -----------------------------------------------------------------------------
ALTER TABLE "webhook_management_operations"
    ADD CONSTRAINT "webhook_management_operations_resource_shape" CHECK (
        CASE "operation"
            WHEN 'CREATE_ENDPOINT' THEN
                "endpoint_id" IS NOT NULL AND "config_version_id" IS NOT NULL
                AND "delivery_id" IS NULL AND "reveal_expires_at" IS NOT NULL
            WHEN 'UPDATE_URL' THEN
                "endpoint_id" IS NOT NULL AND "config_version_id" IS NOT NULL
                AND "delivery_id" IS NULL AND "reveal_expires_at" IS NULL
            WHEN 'VERIFY_CONFIG' THEN
                "endpoint_id" IS NOT NULL AND "config_version_id" IS NOT NULL
                AND "delivery_id" IS NULL AND "reveal_expires_at" IS NULL
            WHEN 'TEST_ENDPOINT' THEN
                "endpoint_id" IS NOT NULL AND "delivery_id" IS NOT NULL
                AND "config_version_id" IS NULL AND "reveal_expires_at" IS NULL
            WHEN 'ROTATE_SECRET' THEN
                "endpoint_id" IS NOT NULL AND "config_version_id" IS NOT NULL
                AND "delivery_id" IS NULL AND "reveal_expires_at" IS NOT NULL
            WHEN 'REPLAY_DELIVERY' THEN
                "endpoint_id" IS NOT NULL AND "delivery_id" IS NOT NULL
                AND "config_version_id" IS NULL AND "reveal_expires_at" IS NULL
        END
    );

COMMENT ON CONSTRAINT "webhook_management_operations_resource_shape"
    ON "webhook_management_operations" IS
    'A durable intent cannot be semantically incomplete. The secret dimension keys on reveal_expires_at, not the ciphertext, because expiry cleanup removes the ciphertext and must stay able to.';

-- -----------------------------------------------------------------------------
-- 2. Ownership that a nullable composite key cannot express
--
-- The join is the point: a configuration has no organization of its own, it
-- borrows one from its endpoint. Checking it therefore needs two tables, which
-- is exactly what a CHECK constraint cannot do and why this lives in the
-- function.
-- -----------------------------------------------------------------------------
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
