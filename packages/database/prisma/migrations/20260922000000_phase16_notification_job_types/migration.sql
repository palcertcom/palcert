-- =============================================================================
-- Phase 16 — the two notification job types, alone in their own migration
--
-- PostgreSQL will add an enum value inside a transaction but will not let the
-- same transaction use it, and Prisma runs each migration file in one
-- transaction. The next Phase 16 migration enqueues nothing, but it does name
-- these types in the `processing_jobs` CHECK constraints, so they are
-- committed first — exactly as Phase 6, Phase 13 and Phase 14 did.
-- =============================================================================

-- One event, many recipients. The fan-out job turns a committed DomainEvent
-- into per-recipient notifications; it is durable because an event that
-- nobody was told about is the failure mode this phase exists to prevent.
ALTER TYPE "ProcessingJobType" ADD VALUE IF NOT EXISTS 'NOTIFICATION_FANOUT';

-- One logical email. Separate from fan-out because sending is the part that
-- talks to something outside PalCert, and so is the part that retries.
ALTER TYPE "ProcessingJobType" ADD VALUE IF NOT EXISTS 'NOTIFICATION_EMAIL_SEND';
