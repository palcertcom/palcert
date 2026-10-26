-- Phase 17 — rotating a secret must not move the destination.
--
-- Rotation was rebuilding the URL from the tenant-safe projection, which is
-- scheme, host and port and deliberately not the path. So rotating the secret
-- for `https://receiver.example/hooks/palcert` produced a replacement
-- configuration pointing at `https://receiver.example/` — a silent change of
-- destination, in the one operation whose entire meaning is "change nothing
-- except the secret".
--
-- The fix cannot be to put the full URL in the read model: no tenant read
-- surface shows the path, and that decision stands. So this is a narrow
-- server-side doorway that hands back the *sealed* URL and the binding needed
-- to open it, and nothing else — no signing secret, no plaintext, no reveal.
-- The server opens the URL under the source configuration's binding, validates
-- it against today's policy, and re-seals the exact same normalized URL against
-- the new configuration id.
--
-- The old signing secret is never decrypted to rotate it. Rotation mints a new
-- secret; there is no reason to open the old one, and opening it would put a
-- live credential in memory for an operation that does not need it.

CREATE OR REPLACE FUNCTION app_webhook_config_url_material(p_config_version_id uuid)
RETURNS TABLE (
    endpoint_id uuid,
    url_ciphertext text,
    url_iv text,
    url_auth_tag text,
    url_encryption_key_id text,
    url_sha256 text,
    host text,
    port integer
)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
    v_org uuid;
BEGIN
    -- A tenant actor, and the configuration has to be theirs. Resolving the
    -- tenancy through the endpoint is what the nullable composite foreign key
    -- silently declines to do.
    IF NOT app_is_webhook_tenant_actor_context() THEN
        RAISE EXCEPTION 'reading webhook configuration material requires an organization actor';
    END IF;
    v_org := app_current_organization();

    RETURN QUERY
    SELECT c."endpoint_id", c."url_ciphertext", c."url_iv", c."url_auth_tag",
           c."url_encryption_key_id", c."url_sha256"::text, c."host", c."port"
      FROM "webhook_endpoint_config_versions" c
      JOIN "webhook_endpoints" e ON e."id" = c."endpoint_id"
     WHERE c."id" = p_config_version_id AND e."organization_id" = v_org;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'webhook config version % is not the caller''s', p_config_version_id;
    END IF;
END;
$$;

REVOKE ALL ON FUNCTION app_webhook_config_url_material(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_webhook_config_url_material(uuid) TO "palcert_app";
