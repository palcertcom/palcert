-- =============================================================================
-- Phase 17 (B1) — which events may ever become webhooks
--
-- The cutover is structural, not temporal. Every DomainEvent carries a flag
-- saying whether it is in scope for outbound webhooks, and Phase 16's existing
-- rows get `false` — permanently, by the column default applied to rows that
-- already exist.
--
-- A timestamp cutover was rejected for a reason worth recording here. Clocks
-- differ between the application and the database, deployments are not
-- instantaneous, and a Phase 16 event whose authoritative source is replayed
-- after the cutover would come back through `domain_events`' existing source
-- identity index as the *same historical row*. Under a timestamp rule that row
-- is suddenly eligible and a submission approved months ago gets announced to
-- an integration today. Under this rule it stays `false` for ever, because
-- what decides is the row, not the clock.
-- =============================================================================

ALTER TABLE "domain_events"
    ADD COLUMN "webhook_eligible" BOOLEAN NOT NULL DEFAULT false;

COMMENT ON COLUMN "domain_events"."webhook_eligible" IS
    'Whether this event may be projected outward as a webhook. Phase 16 rows are false for ever; a replayed historical source returns its existing row and stays false.';

-- Only eligible events are ever scanned, so the index carries only those. A
-- deployment with years of Phase 16 history pays nothing for them.
CREATE INDEX "domain_events_webhook_eligible_idx"
    ON "domain_events"("created_at", "id") WHERE "webhook_eligible";

-- Supports the composite foreign key Phase 17 (D) adds from `webhook_events`.
-- `id` is already unique on its own; this second index exists so a child row
-- cannot name an event belonging to another organization — the tenancy has to
-- be part of the reference for the database to check it.
CREATE UNIQUE INDEX "domain_events_id_organization_key"
    ON "domain_events"("id", "organization_id");
