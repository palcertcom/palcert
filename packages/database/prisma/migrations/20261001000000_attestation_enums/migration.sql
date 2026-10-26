-- =============================================================================
-- Certificate attestation — new values on existing enums
--
-- In their own migration for the reason Phase 6, 13 and 14 already met:
-- PostgreSQL adds an enum value inside a transaction but will not let the same
-- transaction use it, and Prisma runs each migration file in one transaction.
-- The next migration's tables, functions and constraints reference every one
-- of these, so they are committed first.
--
-- Purely additive. `ADD VALUE IF NOT EXISTS` changes no existing row and no
-- existing value's meaning, and is safe to re-run.
-- =============================================================================

-- Durable work: ingesting an uploaded certificate, and moving the money an
-- institution's decision implies.
ALTER TYPE "ProcessingJobType" ADD VALUE IF NOT EXISTS 'ATTESTATION_ARTIFACT_INGEST';
ALTER TYPE "ProcessingJobType" ADD VALUE IF NOT EXISTS 'ATTESTATION_PAYMENT';

-- Notifications, reusing the Phase 16 pipeline rather than a parallel one.
ALTER TYPE "NotificationType" ADD VALUE IF NOT EXISTS 'ATTESTATION_SUBMITTED';
ALTER TYPE "NotificationType" ADD VALUE IF NOT EXISTS 'ATTESTATION_READY_FOR_REVIEW';
ALTER TYPE "NotificationType" ADD VALUE IF NOT EXISTS 'ATTESTATION_INFORMATION_REQUESTED';
ALTER TYPE "NotificationType" ADD VALUE IF NOT EXISTS 'ATTESTATION_INFORMATION_PROVIDED';
ALTER TYPE "NotificationType" ADD VALUE IF NOT EXISTS 'ATTESTATION_APPROVED';
ALTER TYPE "NotificationType" ADD VALUE IF NOT EXISTS 'ATTESTATION_REJECTED';
ALTER TYPE "NotificationType" ADD VALUE IF NOT EXISTS 'ATTESTATION_REVOKED';
ALTER TYPE "NotificationType" ADD VALUE IF NOT EXISTS 'ATTESTATION_EXPIRING';
ALTER TYPE "NotificationType" ADD VALUE IF NOT EXISTS 'ATTESTATION_EXPIRED';

ALTER TYPE "DomainEventSourceType" ADD VALUE IF NOT EXISTS 'ATTESTATION_REQUEST_EVENT';
ALTER TYPE "DomainEventSourceType" ADD VALUE IF NOT EXISTS 'ATTESTATION_REMINDER';

ALTER TYPE "DomainAggregateType" ADD VALUE IF NOT EXISTS 'ATTESTATION_REQUEST';

-- The existing credit ledger, not a second wallet: an attestation fee is
-- reserved, captured and released through the same holds as a paid check.
ALTER TYPE "LedgerReferenceType" ADD VALUE IF NOT EXISTS 'ATTESTATION_REQUEST';
ALTER TYPE "LedgerReasonCode" ADD VALUE IF NOT EXISTS 'ATTESTATION_FEE';
