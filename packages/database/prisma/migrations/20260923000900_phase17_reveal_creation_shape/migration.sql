-- =============================================================================
-- Phase 17 — reveal creation shape
--
-- The resource-shape constraint reads `reveal_expires_at IS NOT NULL` as the
-- permanent marker that a CREATE_ENDPOINT or ROTATE_SECRET carried a secret.
-- That is right after expiry cleanup, which removes the four crypto columns
-- and leaves the window behind as history. It is wrong at INSERT, where the
-- two existing constraints between them accept a row that sets the window and
-- stores nothing:
--
--   resource_shape sees a non-null expiry and calls it secret-bearing;
--   reveal_shape sees four NULLs and takes its "no material" branch.
--
-- So an operation could be recorded as having issued a recoverable signing
-- secret when no secret was ever stored. That is the worst possible shape for
-- this row: the caller is told to come back within the window, and when they
-- do the recovery path finds nothing — and the record says PalCert issued one,
-- so the absence looks like the caller's fault.
--
-- Creation and cleanup genuinely want different rules, which is why a plain
-- CHECK cannot say this: a CHECK sees only the row, not whether it is being
-- born or swept. A BEFORE INSERT trigger can, and holds even for a privileged
-- direct INSERT of the kind the database-invariant tests use.
--
-- Additive. No earlier migration is edited, and nothing about expiry cleanup,
-- rewrap or the tombstone changes.
-- =============================================================================

CREATE OR REPLACE FUNCTION webhook_management_operations_insert_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
    v_secret_bearing boolean := NEW."operation" IN ('CREATE_ENDPOINT', 'ROTATE_SECRET');
    v_present integer;
BEGIN
    -- Count the envelope, rather than testing the ciphertext and assuming the
    -- rest followed it. A partial envelope is material that cannot be opened,
    -- and it would only be discovered by the person trying to recover it.
    v_present :=
        (CASE WHEN NEW."reveal_ciphertext" IS NOT NULL THEN 1 ELSE 0 END)
      + (CASE WHEN NEW."reveal_iv" IS NOT NULL THEN 1 ELSE 0 END)
      + (CASE WHEN NEW."reveal_auth_tag" IS NOT NULL THEN 1 ELSE 0 END)
      + (CASE WHEN NEW."reveal_encryption_key_id" IS NOT NULL THEN 1 ELSE 0 END)
      + (CASE WHEN NEW."reveal_expires_at" IS NOT NULL THEN 1 ELSE 0 END);

    IF v_secret_bearing THEN
        IF v_present <> 5 THEN
            RAISE EXCEPTION
                'operation % must be created with a complete reveal envelope', NEW."operation";
        END IF;
    ELSIF v_present <> 0 THEN
        RAISE EXCEPTION
            'operation % must be created with no reveal material at all', NEW."operation";
    END IF;

    RETURN NEW;
END;
$$;

CREATE TRIGGER "webhook_management_operations_insert_guard_trigger"
    BEFORE INSERT ON "webhook_management_operations"
    FOR EACH ROW EXECUTE FUNCTION webhook_management_operations_insert_guard();

GRANT EXECUTE ON FUNCTION webhook_management_operations_insert_guard() TO "palcert_app";

-- -----------------------------------------------------------------------------
-- The same rule in the function, so the caller gets a sentence about what it
-- did wrong rather than a constraint name, and so the check is stated where
-- somebody adding a parameter will read it.
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
    v_secret_bearing boolean := p_operation IN ('CREATE_ENDPOINT', 'ROTATE_SECRET');
    v_present integer;
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
        SELECT c."endpoint_id" INTO v_config_endpoint
          FROM "webhook_endpoint_config_versions" c
          JOIN "webhook_endpoints" e ON e."id" = c."endpoint_id"
         WHERE c."id" = p_config_version_id AND e."organization_id" = v_org;

        IF NOT FOUND THEN
            RAISE EXCEPTION 'webhook config version % is not the caller''s',
                p_config_version_id;
        END IF;

        IF p_endpoint_id IS NOT NULL AND v_config_endpoint <> p_endpoint_id THEN
            RAISE EXCEPTION 'webhook config version % does not belong to endpoint %',
                p_config_version_id, p_endpoint_id;
        END IF;
    END IF;

    v_present :=
        (CASE WHEN p_reveal_ciphertext IS NOT NULL THEN 1 ELSE 0 END)
      + (CASE WHEN p_reveal_iv IS NOT NULL THEN 1 ELSE 0 END)
      + (CASE WHEN p_reveal_auth_tag IS NOT NULL THEN 1 ELSE 0 END)
      + (CASE WHEN p_reveal_kid IS NOT NULL THEN 1 ELSE 0 END)
      + (CASE WHEN p_reveal_expires_at IS NOT NULL THEN 1 ELSE 0 END);

    IF v_secret_bearing THEN
        -- All five or none of the five. The expiry alone would promise a
        -- recovery that has nothing to return.
        IF v_present <> 5 THEN
            RAISE EXCEPTION
                'operation % must be created with a complete reveal envelope', p_operation;
        END IF;
    ELSIF v_present <> 0 THEN
        RAISE EXCEPTION
            'operation % must be created with no reveal material at all', p_operation;
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
