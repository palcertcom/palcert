-- =============================================================================
-- Phase 17 (D) — reference authority
--
-- Every cross-table reference in this phase carries its tenancy or its parent
-- alongside the id, so the database refuses a row that names something
-- belonging to somebody else. Its own migration because it depends on the
-- supporting unique indexes created in B1 and C, and because it is worth being
-- able to read as one statement of the rule.
--
-- Why composite rather than a plain foreign key plus an application check: a
-- plain key proves the parent exists, not that it is *this organization's*
-- parent. The tenancy has to be inside the reference for PostgreSQL to check
-- it, and once it is, no service bug and no hand-written query can file one
-- organization's delivery against another's endpoint.
-- =============================================================================

-- --- The endpoint's two configuration pointers -------------------------------
-- A configuration belonging to another endpoint must be impossible to point
-- at, current or pending (§12).
ALTER TABLE "webhook_endpoints"
    ADD CONSTRAINT "webhook_endpoints_current_config_fkey"
    FOREIGN KEY ("current_config_version_id", "id")
    REFERENCES "webhook_endpoint_config_versions"("id", "endpoint_id")
    ON DELETE RESTRICT
    DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE "webhook_endpoints"
    ADD CONSTRAINT "webhook_endpoints_pending_config_fkey"
    FOREIGN KEY ("pending_config_version_id", "id")
    REFERENCES "webhook_endpoint_config_versions"("id", "endpoint_id")
    ON DELETE RESTRICT
    DEFERRABLE INITIALLY DEFERRED;

-- --- Subscriptions belong to an endpoint of the same organization ------------
ALTER TABLE "webhook_subscriptions"
    ADD CONSTRAINT "webhook_subscriptions_endpoint_fkey"
    FOREIGN KEY ("endpoint_id", "organization_id")
    REFERENCES "webhook_endpoints"("id", "organization_id")
    ON DELETE RESTRICT;

-- --- A webhook event projects a DomainEvent of the same organization ---------
ALTER TABLE "webhook_events"
    ADD CONSTRAINT "webhook_events_domain_event_fkey"
    FOREIGN KEY ("domain_event_id", "organization_id")
    REFERENCES "domain_events"("id", "organization_id")
    ON DELETE RESTRICT;

ALTER TABLE "webhook_events"
    ADD CONSTRAINT "webhook_events_organization_fkey"
    FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT;

-- --- A delivery's event, endpoint and configuration all agree ----------------
ALTER TABLE "webhook_deliveries"
    ADD CONSTRAINT "webhook_deliveries_event_fkey"
    FOREIGN KEY ("webhook_event_id", "organization_id")
    REFERENCES "webhook_events"("id", "organization_id")
    ON DELETE RESTRICT;

ALTER TABLE "webhook_deliveries"
    ADD CONSTRAINT "webhook_deliveries_endpoint_fkey"
    FOREIGN KEY ("endpoint_id", "organization_id")
    REFERENCES "webhook_endpoints"("id", "organization_id")
    ON DELETE RESTRICT;

ALTER TABLE "webhook_deliveries"
    ADD CONSTRAINT "webhook_deliveries_config_fkey"
    FOREIGN KEY ("endpoint_config_version_id", "endpoint_id")
    REFERENCES "webhook_endpoint_config_versions"("id", "endpoint_id")
    ON DELETE RESTRICT;

-- --- A replay names a delivery of the same endpoint, organization and event --
--
-- Four columns, because a replay that could name any delivery would be a way
-- to attach one organization's history to another's endpoint. Binding the
-- event as well is what makes a replay structurally *the same business fact*
-- rather than a new body sent under an old delivery's name.
ALTER TABLE "webhook_deliveries"
    ADD CONSTRAINT "webhook_deliveries_replay_source_fkey"
    FOREIGN KEY ("replay_of_delivery_id", "endpoint_id", "organization_id", "webhook_event_id")
    REFERENCES "webhook_deliveries"("id", "endpoint_id", "organization_id", "webhook_event_id")
    ON DELETE RESTRICT;

/*
 * A TEST delivery may never be a replay source (§33).
 *
 * The composite key above already refuses it in practice — a TEST row has a
 * NULL event, and a NULL in the referencing tuple makes the constraint
 * unenforced rather than violated — so the rule is stated as a trigger that
 * checks it directly instead of being left to a MATCH SIMPLE subtlety nobody
 * reading the schema would notice.
 */
CREATE OR REPLACE FUNCTION webhook_replay_source_is_business() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
    source_kind "WebhookDeliveryKind";
BEGIN
    IF NEW."replay_of_delivery_id" IS NULL THEN
        RETURN NEW;
    END IF;

    SELECT "kind" INTO source_kind
    FROM "webhook_deliveries"
    WHERE "id" = NEW."replay_of_delivery_id";

    IF source_kind IS NULL THEN
        RAISE EXCEPTION 'webhook delivery % replays a delivery that does not exist',
            NEW."id";
    END IF;

    IF source_kind = 'TEST' THEN
        RAISE EXCEPTION 'a test delivery cannot be replayed';
    END IF;

    RETURN NEW;
END;
$$;

CREATE TRIGGER "webhook_deliveries_replay_source_trigger"
    BEFORE INSERT OR UPDATE ON "webhook_deliveries"
    FOR EACH ROW EXECUTE FUNCTION webhook_replay_source_is_business();

GRANT EXECUTE ON FUNCTION webhook_replay_source_is_business() TO "palcert_app";

-- --- The management operation's results belong to the same organization ------
ALTER TABLE "webhook_management_operations"
    ADD CONSTRAINT "webhook_management_operations_endpoint_fkey"
    FOREIGN KEY ("endpoint_id", "organization_id")
    REFERENCES "webhook_endpoints"("id", "organization_id")
    ON DELETE RESTRICT;

ALTER TABLE "webhook_management_operations"
    ADD CONSTRAINT "webhook_management_operations_delivery_fkey"
    FOREIGN KEY ("delivery_id", "organization_id")
    REFERENCES "webhook_deliveries"("id", "organization_id")
    ON DELETE RESTRICT;

ALTER TABLE "webhook_management_operations"
    ADD CONSTRAINT "webhook_management_operations_config_fkey"
    FOREIGN KEY ("config_version_id", "endpoint_id")
    REFERENCES "webhook_endpoint_config_versions"("id", "endpoint_id")
    ON DELETE RESTRICT;

-- --- Verification attempts belong to one operation, config and endpoint ------
ALTER TABLE "webhook_verification_attempts"
    ADD CONSTRAINT "webhook_verification_attempts_operation_fkey"
    FOREIGN KEY ("operation_id") REFERENCES "webhook_management_operations"("id")
    ON DELETE RESTRICT;

ALTER TABLE "webhook_verification_attempts"
    ADD CONSTRAINT "webhook_verification_attempts_config_fkey"
    FOREIGN KEY ("config_version_id", "endpoint_id")
    REFERENCES "webhook_endpoint_config_versions"("id", "endpoint_id")
    ON DELETE RESTRICT;
