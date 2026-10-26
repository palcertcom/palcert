-- =============================================================================
-- Withdrawals and payouts (ADR-0150) — new values on existing enums
--
-- In their own migration for the reason every earlier phase met: PostgreSQL
-- adds an enum value inside a transaction but will not let the same
-- transaction use it, and Prisma runs each migration file in one transaction.
-- The next migration's constraints, functions and seed rows reference these.
--
-- Purely additive. `ADD VALUE IF NOT EXISTS` changes no existing row and no
-- existing value's meaning, and is safe to re-run.
-- =============================================================================

-- The one ledger. A user payout is a new debit type in the existing
-- append-only ledger, written only by capturing the withdrawal's own hold.
ALTER TYPE "LedgerEntryType" ADD VALUE IF NOT EXISTS 'WITHDRAWAL_DEBIT';
ALTER TYPE "LedgerReferenceType" ADD VALUE IF NOT EXISTS 'WITHDRAWAL_REQUEST';
ALTER TYPE "LedgerReasonCode" ADD VALUE IF NOT EXISTS 'WITHDRAWAL_PAID';

-- The existing hold architecture reserves a user's withdrawal.
ALTER TYPE "CreditHoldPurpose" ADD VALUE IF NOT EXISTS 'WITHDRAWAL';

-- Durable work: scanning an uploaded payout proof.
ALTER TYPE "ProcessingJobType" ADD VALUE IF NOT EXISTS 'WITHDRAWAL_PROOF_INGEST';

-- Notifications, through the existing Phase 16 pipeline rather than a second one.
ALTER TYPE "NotificationType" ADD VALUE IF NOT EXISTS 'WITHDRAWAL_PENDING_REVIEW';
ALTER TYPE "NotificationType" ADD VALUE IF NOT EXISTS 'WITHDRAWAL_SUBMITTED';
ALTER TYPE "NotificationType" ADD VALUE IF NOT EXISTS 'WITHDRAWAL_APPROVED';
ALTER TYPE "NotificationType" ADD VALUE IF NOT EXISTS 'WITHDRAWAL_REJECTED';
ALTER TYPE "NotificationType" ADD VALUE IF NOT EXISTS 'WITHDRAWAL_PAID';
ALTER TYPE "NotificationType" ADD VALUE IF NOT EXISTS 'WITHDRAWAL_FAILED';

ALTER TYPE "DomainEventSourceType" ADD VALUE IF NOT EXISTS 'WITHDRAWAL_REQUEST_EVENT';
ALTER TYPE "DomainAggregateType" ADD VALUE IF NOT EXISTS 'WITHDRAWAL_REQUEST';
