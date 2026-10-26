-- =============================================================================
-- Phase 19 — an audit record says what kind of actor it was
--
-- `audit_events` has carried `actor_user_id`, nullable, since Phase 1. Null has
-- meant "PalCert itself did this", which was true while the only two kinds of
-- actor were a person and the system.
--
-- A machine is a third kind, and it would arrive as a third meaning for the
-- same null. An auditor reading the log after an incident would then have no
-- way to tell "PalCert's own housekeeping" from "an integration credential did
-- this" — and the second is exactly what they would be looking for.
--
-- So the actor's *kind* becomes explicit and the machine gets its own column.
-- Existing rows keep their meaning exactly: a row with a user id is a USER, a
-- row without one is SYSTEM, which is what they already meant.
-- =============================================================================

ALTER TABLE "audit_events"
    ADD COLUMN "actor_type" TEXT NOT NULL DEFAULT 'SYSTEM',
    ADD COLUMN "actor_api_client_id" UUID;

-- Backfill before the constraint, so the existing rows satisfy it.
UPDATE "audit_events" SET "actor_type" = 'USER' WHERE "actor_user_id" IS NOT NULL;

ALTER TABLE "audit_events"
    ADD CONSTRAINT "audit_events_actor_type_known"
        CHECK ("actor_type" IN ('USER', 'API_CLIENT', 'SYSTEM')),
    -- The kind and the columns must agree. Without this a row could claim to be
    -- an API_CLIENT action and name a person, and two readers of the same row
    -- would disagree about who acted.
    ADD CONSTRAINT "audit_events_actor_shape" CHECK (
        ("actor_type" = 'USER'
            AND "actor_user_id" IS NOT NULL AND "actor_api_client_id" IS NULL)
        OR ("actor_type" = 'API_CLIENT'
            AND "actor_api_client_id" IS NOT NULL AND "actor_user_id" IS NULL)
        OR ("actor_type" = 'SYSTEM'
            AND "actor_user_id" IS NULL AND "actor_api_client_id" IS NULL)
    ),
    ADD CONSTRAINT "audit_events_actor_api_client_fk"
        FOREIGN KEY ("actor_api_client_id") REFERENCES "api_clients"("id") ON DELETE RESTRICT;

-- "What did this credential do?" is the question asked after a credential is
-- suspected, and it must not be a sequential scan of every audit row.
CREATE INDEX "audit_events_actor_api_client_idx"
    ON "audit_events"("actor_api_client_id", "created_at" DESC)
    WHERE "actor_api_client_id" IS NOT NULL;

CREATE INDEX "audit_events_actor_type_idx" ON "audit_events"("actor_type", "created_at" DESC);

COMMENT ON COLUMN "audit_events"."actor_type" IS
    'USER, API_CLIENT or SYSTEM. Explicit so a null actor_user_id can never mean two different things at once.';
COMMENT ON COLUMN "audit_events"."actor_api_client_id" IS
    'The machine credential that acted. Never a borrowed human identity: an API client does not act as the person who created it.';
