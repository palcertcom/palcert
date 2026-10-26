-- =============================================================================
-- Phase 17 — system maintenance reads
--
-- The authority migrations took every direct privilege on the SYSTEM tables
-- away from `palcert_app`, which is what they were for. The background work
-- then had nowhere to look: the delivery sweeper needs to know which
-- deliveries are due, the reveal sweeper which reveals have expired, and the
-- keyring which key ids stored rows still depend on — and all three were
-- reading the tables directly.
--
-- That is the boundary working. The fix is not to give the privilege back but
-- to add the doorways the boundary implies, each requiring system context and
-- each returning only what its caller needs: ids and key ids, never a
-- ciphertext and never a URL.
-- =============================================================================

/*
 * Which keys stored rows still depend on.
 *
 * Read at startup to decide whether this process may run at all. Returns key
 * ids only — the answer an operator needs is which key to restore, and the
 * material is never part of that.
 */
CREATE OR REPLACE FUNCTION app_webhook_referenced_key_ids()
RETURNS TABLE (kid text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
    IF NOT app_is_webhook_system_context() THEN
        RAISE EXCEPTION 'webhook key references are system data';
    END IF;

    RETURN QUERY
    SELECT DISTINCT c."url_encryption_key_id" FROM "webhook_endpoint_config_versions" c
    UNION
    SELECT DISTINCT c2."secret_encryption_key_id" FROM "webhook_endpoint_config_versions" c2
    UNION
    SELECT DISTINCT o."reveal_encryption_key_id" FROM "webhook_management_operations" o
     WHERE o."reveal_encryption_key_id" IS NOT NULL;
END;
$$;

/* Deliveries whose business retry time has arrived. Ids only. */
CREATE OR REPLACE FUNCTION app_webhook_deliveries_due(p_now timestamptz, p_limit integer)
RETURNS TABLE (id uuid)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
    IF NOT app_is_webhook_system_context() THEN
        RAISE EXCEPTION 'webhook delivery scheduling is system data';
    END IF;

    RETURN QUERY
    SELECT d."id" FROM "webhook_deliveries" d
     WHERE d."status" = 'FAILED_RETRYABLE'
       AND d."next_attempt_at" IS NOT NULL
       AND d."next_attempt_at" <= p_now
     ORDER BY d."next_attempt_at"
     LIMIT p_limit;
END;
$$;

/* Operations whose reveal window has closed and still hold ciphertext. */
CREATE OR REPLACE FUNCTION app_webhook_expired_reveals(p_now timestamptz, p_limit integer)
RETURNS TABLE (id uuid)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
    IF NOT app_is_webhook_system_context() THEN
        RAISE EXCEPTION 'webhook reveal expiry is system data';
    END IF;

    RETURN QUERY
    SELECT o."id" FROM "webhook_management_operations" o
     WHERE o."reveal_ciphertext" IS NOT NULL
       AND o."reveal_expires_at" IS NOT NULL
       AND o."reveal_expires_at" <= p_now
     ORDER BY o."reveal_expires_at"
     LIMIT p_limit;
END;
$$;

/*
 * Configurations not yet on the active key.
 *
 * Returns the sealed material, because rewrapping is the one operation that
 * legitimately needs it — and it is already system-only and refused whenever a
 * tenant is resolved.
 */
CREATE OR REPLACE FUNCTION app_webhook_configs_needing_rewrap(p_active_kid text, p_limit integer)
RETURNS TABLE (
    id uuid, endpoint_id uuid,
    url_ciphertext text, url_iv text, url_auth_tag text, url_encryption_key_id text,
    secret_ciphertext text, secret_iv text, secret_auth_tag text, secret_encryption_key_id text
)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
    IF NOT app_is_webhook_system_context() THEN
        RAISE EXCEPTION 'a webhook rewrap is maintenance work, not a request';
    END IF;

    RETURN QUERY
    SELECT c."id", c."endpoint_id",
           c."url_ciphertext", c."url_iv", c."url_auth_tag", c."url_encryption_key_id",
           c."secret_ciphertext", c."secret_iv", c."secret_auth_tag",
           c."secret_encryption_key_id"
      FROM "webhook_endpoint_config_versions" c
     WHERE c."url_encryption_key_id" <> p_active_kid
        OR c."secret_encryption_key_id" <> p_active_kid
     ORDER BY c."created_at"
     LIMIT p_limit;
END;
$$;

/* Unswept reveals not yet on the active key, with the binding they need. */
CREATE OR REPLACE FUNCTION app_webhook_reveals_needing_rewrap(p_active_kid text, p_limit integer)
RETURNS TABLE (
    id uuid, organization_id uuid, actor_user_id uuid,
    endpoint_id uuid, config_version_id uuid,
    reveal_ciphertext text, reveal_iv text, reveal_auth_tag text,
    reveal_encryption_key_id text, reveal_expires_at timestamptz
)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
    IF NOT app_is_webhook_system_context() THEN
        RAISE EXCEPTION 'a webhook rewrap is maintenance work, not a request';
    END IF;

    RETURN QUERY
    SELECT o."id", o."organization_id", o."actor_user_id",
           o."endpoint_id", o."config_version_id",
           o."reveal_ciphertext", o."reveal_iv", o."reveal_auth_tag",
           o."reveal_encryption_key_id", o."reveal_expires_at"
      FROM "webhook_management_operations" o
     WHERE o."reveal_ciphertext" IS NOT NULL
       AND o."reveal_encryption_key_id" <> p_active_kid
     ORDER BY o."created_at"
     LIMIT p_limit;
END;
$$;

GRANT EXECUTE ON FUNCTION app_webhook_referenced_key_ids() TO "palcert_app";
GRANT EXECUTE ON FUNCTION app_webhook_deliveries_due(timestamptz, integer) TO "palcert_app";
GRANT EXECUTE ON FUNCTION app_webhook_expired_reveals(timestamptz, integer) TO "palcert_app";
GRANT EXECUTE ON FUNCTION app_webhook_configs_needing_rewrap(text, integer) TO "palcert_app";
GRANT EXECUTE ON FUNCTION app_webhook_reveals_needing_rewrap(text, integer) TO "palcert_app";
