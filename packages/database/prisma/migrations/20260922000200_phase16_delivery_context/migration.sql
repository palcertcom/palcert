-- =============================================================================
-- Phase 16 — reading a delivery's routing before knowing whose scope to enter
--
-- The send worker has a delivery id and nothing else. To enter the recipient's
-- scope it must first learn who the recipient is, and `user_notifications` is
-- row-level-secured on exactly that column — so an unscoped read finds nothing
-- and the worker would silently send no mail at all. (It did, until this
-- existed: the delivery stayed PENDING, the job reported success, and nothing
-- anywhere said why.)
--
-- The narrow doorway rather than a widened policy. It answers for one delivery
-- id with routing metadata only: who, which tenant, which type, which language,
-- which link. Never the title, never the body, never an address. Everything
-- the sender does after this — the preference, the reviewer re-check, the
-- rendered copy — happens inside the recipient's own scope, where row-level
-- security is doing its ordinary job.
-- =============================================================================
CREATE OR REPLACE FUNCTION app_notification_delivery_context(p_delivery_id uuid)
RETURNS TABLE (
    "notification_id" uuid,
    "recipient_user_id" uuid,
    "organization_id" uuid,
    "notification_type" "NotificationType",
    "locale" text,
    "deep_link" text
)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
    SELECT n."id", n."recipient_user_id", n."organization_id",
           n."notification_type", n."locale", n."deep_link"
      FROM "notification_deliveries" d
      JOIN "user_notifications" n ON n."id" = d."notification_id"
     WHERE d."id" = p_delivery_id;
$$;

GRANT EXECUTE ON FUNCTION app_notification_delivery_context(uuid) TO "palcert_app";

COMMENT ON FUNCTION app_notification_delivery_context(uuid) IS
    'Routing metadata for one delivery, so the send worker can enter the recipient''s scope. Returns no message content and no address.';
