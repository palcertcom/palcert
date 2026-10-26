-- =============================================================================
-- Phase 17 — fan-out target discovery
--
-- The system-reader predicate on `webhook_endpoints` and `webhook_subscriptions`
-- requires the role switch, which only holds inside a SECURITY DEFINER body.
-- That is deliberate: an unauthenticated route with no scope resolved would
-- otherwise have gained a view of every organization's endpoints.
--
-- The consequence is that fan-out cannot discover its targets with an ordinary
-- SELECT, even though it runs in system context — and it was trying to, which
-- silently returned nothing. A fan-out that finds no endpoints looks exactly
-- like an organization that subscribed to nothing, which is the worst kind of
-- bug: correct-looking, silent, and wrong.
--
-- So target discovery gets a doorway, like every other system read.
-- =============================================================================
CREATE OR REPLACE FUNCTION app_webhook_fanout_targets(p_webhook_event_id uuid)
RETURNS TABLE (endpoint_id uuid)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
    v_event "webhook_events"%ROWTYPE;
BEGIN
    IF NOT app_is_webhook_system_context() THEN
        RAISE EXCEPTION 'webhook fan-out is system work';
    END IF;

    SELECT * INTO v_event FROM "webhook_events" WHERE "id" = p_webhook_event_id;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'webhook_event % does not exist', p_webhook_event_id;
    END IF;

    -- Scoped to the event's own organization. Seeing every endpoint from system
    -- context is not licence to fan out across them.
    RETURN QUERY
    SELECT e."id"
      FROM "webhook_endpoints" e
      JOIN "webhook_subscriptions" s ON s."endpoint_id" = e."id"
     WHERE e."organization_id" = v_event."organization_id"
       AND e."status" = 'ACTIVE'
       AND s."event_type" = v_event."event_type"
     ORDER BY e."slot";
END;
$$;

GRANT EXECUTE ON FUNCTION app_webhook_fanout_targets(uuid) TO "palcert_app";
