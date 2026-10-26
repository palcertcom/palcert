-- =============================================================================
-- Phase 17 — the configuration id is allocated before its material is sealed
--
-- A configuration's URL and signing secret are bound, through the AAD, to the
-- endpoint *and the configuration version*. That binding is what stops one
-- row's ciphertext opening as another's. It also means the id has to exist
-- before the material can be sealed — and the id was being allocated by the
-- database, inside the same call that stored the already-sealed material.
--
-- Sealing against a placeholder and rewrapping immediately afterwards would
-- work and would be two writes where one belongs, with a window in between
-- where the row cannot be opened at all. Binding to the endpoint alone would
-- work and would be weaker: two configurations of one endpoint would have
-- interchangeable ciphertext, so a retired URL could be presented as the
-- current one.
--
-- So the caller allocates the id, seals against it, and passes it in. The id is
-- transport identity, exactly as a webhook event's is; nothing about the row's
-- authority comes from the caller.
-- =============================================================================
DROP FUNCTION IF EXISTS app_webhook_config_create(
    uuid, text, text, text, text, text, text, integer, text, text, text, text, text
);

CREATE OR REPLACE FUNCTION app_webhook_config_create(
    p_config_version_id uuid,
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

    -- Supersede whatever was waiting: a surviving pending configuration would
    -- let a verification already in flight activate a URL since replaced.
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
        p_config_version_id, p_endpoint_id, v_number, 'PENDING',
        p_url_ciphertext, p_url_iv, p_url_auth_tag, p_url_kid,
        p_url_sha256, p_host, p_port,
        p_secret_ciphertext, p_secret_iv, p_secret_auth_tag, p_secret_kid,
        p_secret_fingerprint
    );

    UPDATE "webhook_endpoints"
       SET "pending_config_version_id" = p_config_version_id, "updated_at" = now()
     WHERE "id" = p_endpoint_id;

    PERFORM set_config('palcert.webhook_write_mode', 'off', true);
    RETURN p_config_version_id;
END;
$$;

GRANT EXECUTE ON FUNCTION app_webhook_config_create(
    uuid, uuid, text, text, text, text, text, text, integer, text, text, text, text, text
) TO "palcert_app";
