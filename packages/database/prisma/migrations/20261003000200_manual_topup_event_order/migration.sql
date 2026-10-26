-- =============================================================================
-- Manual top-ups — history timestamps that order
--
-- `CURRENT_TIMESTAMP` is the start of the transaction, so two history rows
-- written in quick succession could share a timestamp and the timeline could
-- read out of order. `clock_timestamp()` is the moment the row is written.
--
-- Deliberately not an identity column: a sequence would need its own grant,
-- and the read-only backup role is provisioned with SELECT on tables only.
-- Changing a column default rewrites no row and needs no new privilege.
-- =============================================================================
ALTER TABLE "manual_topup_request_events"
    ALTER COLUMN "created_at" SET DEFAULT clock_timestamp();
