-- =============================================================================
-- Phase 17 — finding an operation by its idempotency key
--
-- The tenant-readable projection deliberately carries no key hash: it is the
-- view an organization can select from, and a stored idempotency key is a
-- client-supplied string that should not be browsable beside the resources it
-- re-addresses.
--
-- But the whole point of the key is that a repeat of a request finds its own
-- earlier answer. That lookup therefore needs a doorway of its own: give it the
-- hash, get back the operation — and only ever the caller's own, in the
-- caller's own organization.
-- =============================================================================
CREATE OR REPLACE FUNCTION app_webhook_operation_find(
    p_operation "WebhookManagementOperationType",
    p_idempotency_key_hash text
) RETURNS TABLE (
    id uuid,
    actor_user_id uuid,
    request_fingerprint text,
    endpoint_id uuid,
    config_version_id uuid,
    delivery_id uuid,
    reveal_expires_at timestamptz,
    reveal_available boolean,
    settled_at timestamptz
)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
    IF NOT app_is_webhook_tenant_actor_context() THEN
        RAISE EXCEPTION 'looking up a webhook operation requires an organization actor';
    END IF;

    RETURN QUERY
    SELECT o."id", o."actor_user_id", o."request_fingerprint"::text, o."endpoint_id",
           o."config_version_id", o."delivery_id", o."reveal_expires_at",
           (o."reveal_ciphertext" IS NOT NULL), o."settled_at"
      FROM "webhook_management_operations" o
     WHERE o."operation" = p_operation
       AND o."idempotency_key_hash" = p_idempotency_key_hash
       AND o."organization_id" = app_current_organization();
END;
$$;

GRANT EXECUTE ON FUNCTION app_webhook_operation_find(
    "WebhookManagementOperationType", text
) TO "palcert_app";
