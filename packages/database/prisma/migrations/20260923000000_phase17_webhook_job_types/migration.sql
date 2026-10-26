-- =============================================================================
-- Phase 17 — the three webhook job types, alone in their own migration
--
-- PostgreSQL adds an enum value inside a transaction but will not let the same
-- transaction use it, and Prisma runs each migration file in one transaction.
-- The Phase 17 tables name these types in CHECK constraints, so they are
-- committed first — exactly as Phase 6, Phase 13, Phase 14 and Phase 16 did.
-- =============================================================================

-- One DomainEvent, many endpoints. Fan-out turns a committed, webhook-eligible
-- event into at most one delivery per subscribed endpoint. Durable because an
-- event that an integration was never told about is the failure this phase
-- exists to prevent.
ALTER TYPE "ProcessingJobType" ADD VALUE IF NOT EXISTS 'WEBHOOK_FANOUT';

-- One request to one endpoint. Separate from fan-out because sending is the
-- part that talks to a machine PalCert does not control, and so is the part
-- that retries, times out and has to be bounded.
ALTER TYPE "ProcessingJobType" ADD VALUE IF NOT EXISTS 'WEBHOOK_DELIVER';

-- Proving a configuration reaches somebody who wants it. Keyed by the
-- organization's verification *intent* rather than by the configuration, so an
-- administrator who fixes their receiver can ask again — a job keyed by the
-- configuration would have succeeded once and refused to run a second time.
ALTER TYPE "ProcessingJobType" ADD VALUE IF NOT EXISTS 'WEBHOOK_ENDPOINT_VERIFY';
