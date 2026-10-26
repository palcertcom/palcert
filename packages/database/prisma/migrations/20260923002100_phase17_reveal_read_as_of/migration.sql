-- Phase 17 — the reveal window is measured by the caller's clock.
--
-- The window is opened with the application's injected clock and was being
-- closed with the database's. In production the two agree to within a few
-- milliseconds and nobody notices; under a test clock they are months apart,
-- and a recovery that the service had already decided was open was refused by
-- the doorway underneath it.
--
-- Two clocks deciding one deadline is a bug even when they happen to agree.
-- The caller passes the instant it is asking about, exactly as the attempt
-- doorway does for the retry ladder, and the database still refuses — this is
-- defence in depth behind the service's own check, not a replacement for it.

CREATE OR REPLACE FUNCTION app_webhook_reveal_read(
    p_operation_id uuid,
    p_idempotency_key_hash text,
    p_request_fingerprint text,
    p_as_of timestamptz
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

    -- Organization, actor, key and request all have to match. The envelope's
    -- own additional authenticated data repeats most of this, so a row edited
    -- past these checks still will not open.
    IF app_current_organization() IS NULL
       OR v_row."organization_id" <> app_current_organization()
       OR v_row."actor_user_id" IS DISTINCT FROM app_current_user_id()
       OR v_row."idempotency_key_hash" <> p_idempotency_key_hash
       OR v_row."request_fingerprint" <> p_request_fingerprint
    THEN
        RAISE EXCEPTION 'webhook operation % is not the caller''s to recover', p_operation_id;
    END IF;

    -- Before anything is returned, let alone decrypted.
    IF v_row."reveal_expires_at" IS NULL OR p_as_of >= v_row."reveal_expires_at" THEN
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

REVOKE ALL ON FUNCTION app_webhook_reveal_read(uuid, text, text, timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_webhook_reveal_read(uuid, text, text, timestamptz) TO "palcert_app";

-- One doorway, so the clock cannot be skipped by calling the other one.
DROP FUNCTION IF EXISTS app_webhook_reveal_read(uuid, text, text);
