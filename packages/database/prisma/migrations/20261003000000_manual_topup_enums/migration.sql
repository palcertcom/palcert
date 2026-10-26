-- =============================================================================
-- Manual top-ups — new values on existing enums
--
-- In their own migration for the reason every earlier phase met: PostgreSQL
-- adds an enum value inside a transaction but will not let the same
-- transaction use it, and Prisma runs each migration file in one transaction.
-- The next migration's constraints, functions and seed rows reference these.
--
-- Purely additive. `ADD VALUE IF NOT EXISTS` changes no existing row and no
-- existing value's meaning, and is safe to re-run.
-- =============================================================================

-- The one ledger. A manual top-up is credited by a new entry type in the
-- existing append-only ledger, never by a second wallet or a balance column.
ALTER TYPE "LedgerEntryType" ADD VALUE IF NOT EXISTS 'MANUAL_TOPUP_CREDIT';
ALTER TYPE "LedgerReferenceType" ADD VALUE IF NOT EXISTS 'MANUAL_TOPUP_REQUEST';
ALTER TYPE "LedgerReasonCode" ADD VALUE IF NOT EXISTS 'MANUAL_TOPUP_APPROVED';

-- Durable work: scanning a receipt and a payment method's logo.
ALTER TYPE "ProcessingJobType" ADD VALUE IF NOT EXISTS 'MANUAL_TOPUP_RECEIPT_INGEST';
ALTER TYPE "ProcessingJobType" ADD VALUE IF NOT EXISTS 'MANUAL_PAYMENT_METHOD_LOGO_INGEST';

-- Notifications, through the existing Phase 16 pipeline rather than a second one.
ALTER TYPE "NotificationType" ADD VALUE IF NOT EXISTS 'MANUAL_TOPUP_SUBMITTED';
ALTER TYPE "NotificationType" ADD VALUE IF NOT EXISTS 'MANUAL_TOPUP_APPROVED';
ALTER TYPE "NotificationType" ADD VALUE IF NOT EXISTS 'MANUAL_TOPUP_REJECTED';

ALTER TYPE "DomainEventSourceType" ADD VALUE IF NOT EXISTS 'MANUAL_TOPUP_REQUEST_EVENT';
ALTER TYPE "DomainAggregateType" ADD VALUE IF NOT EXISTS 'MANUAL_TOPUP_REQUEST';
