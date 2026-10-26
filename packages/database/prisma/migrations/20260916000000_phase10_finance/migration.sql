-- =============================================================================
-- Phase 10 — Customer credit balance, payments, pricing and refunds
--
-- The financial subsystem. Its correctness rests on properties this file
-- enforces in the database rather than in application code, because
-- application-only immutability is a convention and a convention is what a
-- future refactor quietly breaks (§102).
--
--   1. Generated schema (tables, enums, indexes, foreign keys)
--   2. Composite ownership keys — one user's money cannot reference another's
--   3. Value invariants — signs, non-zero amounts, currency agreement
--   4. Ledger immutability — UPDATE and DELETE refused outright
--   5. Hold lifecycle — terminal states never revert
--   6. Price immutability — an ACTIVE price's amount cannot change
--   7. One active price per product, currency and market
--   8. Payment record immutability — a settled payment's identity is frozen
--   9. Isolation classification
--  10. Row-level security
--  11. Permissions and role grants
--  12. Grants and seed data
-- =============================================================================

-- =============================================================================
-- 1. Generated schema
-- =============================================================================
-- CreateEnum
CREATE TYPE "CreditClass" AS ENUM ('CASH', 'PROMOTIONAL');

-- CreateEnum
CREATE TYPE "LedgerEntryType" AS ENUM ('TOP_UP_CREDIT', 'SERVICE_CHARGE', 'SERVICE_REFUND', 'PAYMENT_REFUND_DEBIT', 'PROMOTIONAL_CREDIT', 'ADMIN_CREDIT', 'ADMIN_DEBIT', 'CHARGEBACK_DEBIT', 'CHARGEBACK_REVERSAL');

-- CreateEnum
CREATE TYPE "LedgerReferenceType" AS ENUM ('BALANCE_TOP_UP', 'CREDIT_HOLD', 'PAYMENT_REFUND', 'LEDGER_ENTRY', 'ADMIN_ADJUSTMENT', 'PAYMENT_DISPUTE');

-- CreateEnum
CREATE TYPE "LedgerReasonCode" AS ENUM ('TOP_UP_VERIFIED', 'SERVICE_CAPTURED', 'SERVICE_FAILED', 'SERVICE_CANCELLED', 'CUSTOMER_REQUEST', 'GOODWILL', 'PROMOTION', 'BILLING_CORRECTION', 'PROVIDER_DISPUTE', 'PROVIDER_DISPUTE_WON', 'EXTERNAL_REFUND');

-- CreateEnum
CREATE TYPE "CreditHoldStatus" AS ENUM ('ACTIVE', 'CAPTURED', 'RELEASED', 'EXPIRED');

-- CreateEnum
CREATE TYPE "CreditHoldPurpose" AS ENUM ('SERVICE', 'EXTERNAL_REFUND');

-- CreateEnum
CREATE TYPE "ServiceProductCode" AS ENUM ('DOCUMENT_CHECK', 'SMARTFIX', 'EXPERTFIX');

-- CreateEnum
CREATE TYPE "PriceVersionStatus" AS ENUM ('DRAFT', 'ACTIVE', 'RETIRED');

-- CreateEnum
CREATE TYPE "TopUpStatus" AS ENUM ('CREATED', 'PENDING', 'SUCCEEDED', 'FAILED', 'CANCELLED', 'EXPIRED', 'RECONCILIATION_REQUIRED');

-- CreateEnum
CREATE TYPE "PaymentRefundStatus" AS ENUM ('REQUESTED', 'PENDING', 'SUCCEEDED', 'FAILED', 'RECONCILIATION_REQUIRED');

-- CreateEnum
CREATE TYPE "PaymentRefundReason" AS ENUM ('REQUESTED_BY_CUSTOMER', 'DUPLICATE', 'FRAUDULENT', 'SERVICE_NOT_DELIVERED', 'GOODWILL');

-- CreateEnum
CREATE TYPE "PaymentEventKind" AS ENUM ('PAYMENT_SUCCEEDED', 'PAYMENT_FAILED', 'PAYMENT_CANCELLED', 'PAYMENT_EXPIRED', 'REFUND_SUCCEEDED', 'REFUND_FAILED', 'PAYMENT_DISPUTED', 'DISPUTE_REVERSED', 'UNSUPPORTED');

-- CreateEnum
CREATE TYPE "ProviderEventStatus" AS ENUM ('RECEIVED', 'PROCESSED', 'IGNORED', 'FAILED');

-- CreateEnum
CREATE TYPE "PaymentObjectKind" AS ENUM ('TOP_UP', 'REFUND', 'DISPUTE', 'UNKNOWN');

-- CreateEnum
CREATE TYPE "PaymentDisputeStatus" AS ENUM ('OPEN', 'LOST', 'WON');

-- CreateTable
CREATE TABLE "customer_credit_accounts" (
    "id" UUID NOT NULL,
    "owner_user_id" UUID NOT NULL,
    "currency" VARCHAR(3) NOT NULL,
    "credit_class" "CreditClass" NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "customer_credit_accounts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "credit_ledger_entries" (
    "id" UUID NOT NULL,
    "owner_user_id" UUID NOT NULL,
    "account_id" UUID NOT NULL,
    "currency" VARCHAR(3) NOT NULL,
    "credit_class" "CreditClass" NOT NULL,
    "entry_type" "LedgerEntryType" NOT NULL,
    "amount_minor_signed" BIGINT NOT NULL,
    "reference_type" "LedgerReferenceType",
    "reference_id" UUID,
    "idempotency_key" VARCHAR(200),
    "reversal_of_entry_id" UUID,
    "reason_code" "LedgerReasonCode",
    "created_by_user_id" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "credit_ledger_entries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "credit_holds" (
    "id" UUID NOT NULL,
    "owner_user_id" UUID NOT NULL,
    "account_id" UUID NOT NULL,
    "currency" VARCHAR(3) NOT NULL,
    "credit_class" "CreditClass" NOT NULL,
    "purpose" "CreditHoldPurpose" NOT NULL,
    "status" "CreditHoldStatus" NOT NULL DEFAULT 'ACTIVE',
    "amount_minor" BIGINT NOT NULL,
    "reference_type" "LedgerReferenceType",
    "reference_id" UUID,
    "idempotency_key" VARCHAR(200),
    "captured_entry_id" UUID,
    "expires_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "captured_at" TIMESTAMPTZ(6),
    "released_at" TIMESTAMPTZ(6),
    "expired_at" TIMESTAMPTZ(6),

    CONSTRAINT "credit_holds_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "service_products" (
    "product_code" "ServiceProductCode" NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT false,
    "name_en" VARCHAR(120) NOT NULL,
    "name_ar" VARCHAR(120) NOT NULL,
    "description_en" VARCHAR(500),
    "description_ar" VARCHAR(500),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "service_products_pkey" PRIMARY KEY ("product_code")
);

-- CreateTable
CREATE TABLE "price_versions" (
    "id" UUID NOT NULL,
    "product_code" "ServiceProductCode" NOT NULL,
    "market_code" VARCHAR(16) NOT NULL DEFAULT 'GLOBAL',
    "currency" VARCHAR(3) NOT NULL,
    "amount_minor" BIGINT NOT NULL,
    "status" "PriceVersionStatus" NOT NULL DEFAULT 'DRAFT',
    "effective_from" TIMESTAMPTZ(6),
    "effective_until" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by_user_id" UUID,
    "activated_at" TIMESTAMPTZ(6),
    "retired_at" TIMESTAMPTZ(6),

    CONSTRAINT "price_versions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "price_quotes" (
    "id" UUID NOT NULL,
    "owner_user_id" UUID NOT NULL,
    "product_code" "ServiceProductCode" NOT NULL,
    "price_version_id" UUID NOT NULL,
    "currency" VARCHAR(3) NOT NULL,
    "amount_minor" BIGINT NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "price_quotes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "balance_topups" (
    "id" UUID NOT NULL,
    "owner_user_id" UUID NOT NULL,
    "currency" VARCHAR(3) NOT NULL,
    "amount_minor" BIGINT NOT NULL,
    "provider" VARCHAR(40) NOT NULL,
    "provider_api_version" VARCHAR(40),
    "provider_session_id" VARCHAR(255),
    "provider_payment_id" VARCHAR(255),
    "status" "TopUpStatus" NOT NULL DEFAULT 'CREATED',
    "failure_code" VARCHAR(64),
    "idempotency_key" VARCHAR(200),
    "credit_entry_id" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMPTZ(6),
    "succeeded_at" TIMESTAMPTZ(6),
    "failed_at" TIMESTAMPTZ(6),
    "cancelled_at" TIMESTAMPTZ(6),

    CONSTRAINT "balance_topups_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payment_refunds" (
    "id" UUID NOT NULL,
    "owner_user_id" UUID NOT NULL,
    "top_up_id" UUID NOT NULL,
    "currency" VARCHAR(3) NOT NULL,
    "amount_minor" BIGINT NOT NULL,
    "provider" VARCHAR(40) NOT NULL,
    "provider_refund_id" VARCHAR(255),
    "status" "PaymentRefundStatus" NOT NULL DEFAULT 'REQUESTED',
    "reason" "PaymentRefundReason",
    "failure_code" VARCHAR(64),
    "hold_id" UUID,
    "debit_entry_id" UUID,
    "idempotency_key" VARCHAR(200),
    "requested_by_user_id" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "succeeded_at" TIMESTAMPTZ(6),
    "failed_at" TIMESTAMPTZ(6),

    CONSTRAINT "payment_refunds_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payment_disputes" (
    "id" UUID NOT NULL,
    "owner_user_id" UUID NOT NULL,
    "top_up_id" UUID NOT NULL,
    "currency" VARCHAR(3) NOT NULL,
    "amount_minor" BIGINT NOT NULL,
    "provider" VARCHAR(40) NOT NULL,
    "provider_dispute_id" VARCHAR(255) NOT NULL,
    "status" "PaymentDisputeStatus" NOT NULL DEFAULT 'OPEN',
    "debit_entry_id" UUID,
    "reversal_entry_id" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolved_at" TIMESTAMPTZ(6),

    CONSTRAINT "payment_disputes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payment_provider_events" (
    "id" UUID NOT NULL,
    "provider" VARCHAR(40) NOT NULL,
    "provider_event_id" VARCHAR(255) NOT NULL,
    "provider_event_type" VARCHAR(120) NOT NULL,
    "event_kind" "PaymentEventKind" NOT NULL,
    "object_kind" "PaymentObjectKind" NOT NULL,
    "provider_object_id" VARCHAR(255),
    "payload_sha256" CHAR(64) NOT NULL,
    "processing_status" "ProviderEventStatus" NOT NULL DEFAULT 'RECEIVED',
    "failure_code" VARCHAR(64),
    "attempt_count" INTEGER NOT NULL DEFAULT 0,
    "occurred_at" TIMESTAMPTZ(6) NOT NULL,
    "received_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "processed_at" TIMESTAMPTZ(6),

    CONSTRAINT "payment_provider_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "customer_credit_accounts_owner_user_id_idx" ON "customer_credit_accounts"("owner_user_id");

-- CreateIndex
CREATE UNIQUE INDEX "credit_accounts_identity" ON "customer_credit_accounts"("owner_user_id", "currency", "credit_class");

-- CreateIndex
CREATE INDEX "credit_ledger_entries_account_id_created_at_id_idx" ON "credit_ledger_entries"("account_id", "created_at", "id");

-- CreateIndex
CREATE INDEX "credit_ledger_entries_owner_user_id_created_at_id_idx" ON "credit_ledger_entries"("owner_user_id", "created_at", "id");

-- CreateIndex
CREATE INDEX "credit_ledger_entries_reference_type_reference_id_idx" ON "credit_ledger_entries"("reference_type", "reference_id");

-- CreateIndex
CREATE INDEX "credit_ledger_entries_reversal_of_entry_id_idx" ON "credit_ledger_entries"("reversal_of_entry_id");

-- CreateIndex
CREATE UNIQUE INDEX "ledger_entries_owner_idempotency" ON "credit_ledger_entries"("owner_user_id", "idempotency_key");

-- CreateIndex
CREATE UNIQUE INDEX "credit_holds_captured_entry_id_key" ON "credit_holds"("captured_entry_id");

-- CreateIndex
CREATE INDEX "credit_holds_account_id_status_idx" ON "credit_holds"("account_id", "status");

-- CreateIndex
CREATE INDEX "credit_holds_owner_user_id_created_at_id_idx" ON "credit_holds"("owner_user_id", "created_at", "id");

-- CreateIndex
CREATE INDEX "credit_holds_status_expires_at_idx" ON "credit_holds"("status", "expires_at");

-- CreateIndex
CREATE UNIQUE INDEX "credit_holds_owner_idempotency" ON "credit_holds"("owner_user_id", "idempotency_key");

-- CreateIndex
CREATE INDEX "price_versions_product_code_currency_market_code_status_idx" ON "price_versions"("product_code", "currency", "market_code", "status");

-- CreateIndex
CREATE INDEX "price_quotes_owner_user_id_created_at_id_idx" ON "price_quotes"("owner_user_id", "created_at", "id");

-- CreateIndex
CREATE INDEX "price_quotes_expires_at_idx" ON "price_quotes"("expires_at");

-- CreateIndex
CREATE UNIQUE INDEX "balance_topups_credit_entry_id_key" ON "balance_topups"("credit_entry_id");

-- CreateIndex
CREATE INDEX "balance_topups_owner_user_id_created_at_id_idx" ON "balance_topups"("owner_user_id", "created_at", "id");

-- CreateIndex
CREATE INDEX "balance_topups_status_created_at_idx" ON "balance_topups"("status", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "balance_topups_owner_idempotency" ON "balance_topups"("owner_user_id", "idempotency_key");

-- CreateIndex
CREATE UNIQUE INDEX "balance_topups_provider_session" ON "balance_topups"("provider", "provider_session_id");

-- CreateIndex
CREATE UNIQUE INDEX "balance_topups_provider_payment" ON "balance_topups"("provider", "provider_payment_id");

-- CreateIndex
CREATE UNIQUE INDEX "payment_refunds_hold_id_key" ON "payment_refunds"("hold_id");

-- CreateIndex
CREATE UNIQUE INDEX "payment_refunds_debit_entry_id_key" ON "payment_refunds"("debit_entry_id");

-- CreateIndex
CREATE INDEX "payment_refunds_owner_user_id_created_at_id_idx" ON "payment_refunds"("owner_user_id", "created_at", "id");

-- CreateIndex
CREATE INDEX "payment_refunds_top_up_id_idx" ON "payment_refunds"("top_up_id");

-- CreateIndex
CREATE INDEX "payment_refunds_status_created_at_idx" ON "payment_refunds"("status", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "payment_refunds_provider_refund" ON "payment_refunds"("provider", "provider_refund_id");

-- CreateIndex
CREATE UNIQUE INDEX "payment_disputes_debit_entry_id_key" ON "payment_disputes"("debit_entry_id");

-- CreateIndex
CREATE UNIQUE INDEX "payment_disputes_reversal_entry_id_key" ON "payment_disputes"("reversal_entry_id");

-- CreateIndex
CREATE INDEX "payment_disputes_owner_user_id_created_at_id_idx" ON "payment_disputes"("owner_user_id", "created_at", "id");

-- CreateIndex
CREATE INDEX "payment_disputes_top_up_id_idx" ON "payment_disputes"("top_up_id");

-- CreateIndex
CREATE UNIQUE INDEX "payment_disputes_provider_dispute" ON "payment_disputes"("provider", "provider_dispute_id");

-- CreateIndex
CREATE INDEX "payment_provider_events_processing_status_received_at_idx" ON "payment_provider_events"("processing_status", "received_at");

-- CreateIndex
CREATE INDEX "payment_provider_events_provider_provider_object_id_idx" ON "payment_provider_events"("provider", "provider_object_id");

-- CreateIndex
CREATE UNIQUE INDEX "payment_provider_events_identity" ON "payment_provider_events"("provider", "provider_event_id");

-- AddForeignKey
ALTER TABLE "customer_credit_accounts" ADD CONSTRAINT "customer_credit_accounts_owner_user_id_fkey" FOREIGN KEY ("owner_user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "credit_ledger_entries" ADD CONSTRAINT "credit_ledger_entries_owner_user_id_fkey" FOREIGN KEY ("owner_user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "credit_ledger_entries" ADD CONSTRAINT "credit_ledger_entries_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "customer_credit_accounts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "credit_ledger_entries" ADD CONSTRAINT "credit_ledger_entries_reversal_of_entry_id_fkey" FOREIGN KEY ("reversal_of_entry_id") REFERENCES "credit_ledger_entries"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "credit_ledger_entries" ADD CONSTRAINT "credit_ledger_entries_created_by_user_id_fkey" FOREIGN KEY ("created_by_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "credit_holds" ADD CONSTRAINT "credit_holds_owner_user_id_fkey" FOREIGN KEY ("owner_user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "credit_holds" ADD CONSTRAINT "credit_holds_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "customer_credit_accounts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "price_versions" ADD CONSTRAINT "price_versions_product_code_fkey" FOREIGN KEY ("product_code") REFERENCES "service_products"("product_code") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "price_versions" ADD CONSTRAINT "price_versions_created_by_user_id_fkey" FOREIGN KEY ("created_by_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "price_quotes" ADD CONSTRAINT "price_quotes_owner_user_id_fkey" FOREIGN KEY ("owner_user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "price_quotes" ADD CONSTRAINT "price_quotes_product_code_fkey" FOREIGN KEY ("product_code") REFERENCES "service_products"("product_code") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "price_quotes" ADD CONSTRAINT "price_quotes_price_version_id_fkey" FOREIGN KEY ("price_version_id") REFERENCES "price_versions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "balance_topups" ADD CONSTRAINT "balance_topups_owner_user_id_fkey" FOREIGN KEY ("owner_user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payment_refunds" ADD CONSTRAINT "payment_refunds_owner_user_id_fkey" FOREIGN KEY ("owner_user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payment_refunds" ADD CONSTRAINT "payment_refunds_top_up_id_fkey" FOREIGN KEY ("top_up_id") REFERENCES "balance_topups"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payment_refunds" ADD CONSTRAINT "payment_refunds_hold_id_fkey" FOREIGN KEY ("hold_id") REFERENCES "credit_holds"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payment_refunds" ADD CONSTRAINT "payment_refunds_requested_by_user_id_fkey" FOREIGN KEY ("requested_by_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payment_disputes" ADD CONSTRAINT "payment_disputes_owner_user_id_fkey" FOREIGN KEY ("owner_user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payment_disputes" ADD CONSTRAINT "payment_disputes_top_up_id_fkey" FOREIGN KEY ("top_up_id") REFERENCES "balance_topups"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- =============================================================================
-- 2. Composite ownership keys
--
--    Every financial child carries its owner explicitly *and* is bound to a
--    parent with the same one. "User A's refund against User B's top-up" is
--    then refused by the database rather than by a code path somebody could
--    forget to write (§149).
-- =============================================================================
ALTER TABLE "customer_credit_accounts"
    ADD CONSTRAINT "credit_accounts_id_owner_key" UNIQUE ("id", "owner_user_id");
ALTER TABLE "credit_ledger_entries"
    ADD CONSTRAINT "ledger_entries_id_owner_key" UNIQUE ("id", "owner_user_id");
ALTER TABLE "credit_holds"
    ADD CONSTRAINT "credit_holds_id_owner_key" UNIQUE ("id", "owner_user_id");
ALTER TABLE "balance_topups"
    ADD CONSTRAINT "balance_topups_id_owner_key" UNIQUE ("id", "owner_user_id");
ALTER TABLE "payment_refunds"
    ADD CONSTRAINT "payment_refunds_id_owner_key" UNIQUE ("id", "owner_user_id");

-- A ledger entry's account must belong to the same person as the entry.
ALTER TABLE "credit_ledger_entries"
    ADD CONSTRAINT "ledger_entries_account_owner_fkey"
    FOREIGN KEY ("account_id", "owner_user_id")
    REFERENCES "customer_credit_accounts" ("id", "owner_user_id") ON DELETE CASCADE;

-- A hold's account, likewise.
ALTER TABLE "credit_holds"
    ADD CONSTRAINT "credit_holds_account_owner_fkey"
    FOREIGN KEY ("account_id", "owner_user_id")
    REFERENCES "customer_credit_accounts" ("id", "owner_user_id") ON DELETE CASCADE;

-- A reversal corrects an entry belonging to the same person (§100).
ALTER TABLE "credit_ledger_entries"
    ADD CONSTRAINT "ledger_entries_reversal_owner_fkey"
    FOREIGN KEY ("reversal_of_entry_id", "owner_user_id")
    REFERENCES "credit_ledger_entries" ("id", "owner_user_id") ON DELETE RESTRICT;

-- A refund refunds the same person's top-up, reserves the same person's hold
-- and writes the same person's debit.
ALTER TABLE "payment_refunds"
    ADD CONSTRAINT "payment_refunds_topup_owner_fkey"
    FOREIGN KEY ("top_up_id", "owner_user_id")
    REFERENCES "balance_topups" ("id", "owner_user_id") ON DELETE RESTRICT;
ALTER TABLE "payment_refunds"
    ADD CONSTRAINT "payment_refunds_hold_owner_fkey"
    FOREIGN KEY ("hold_id", "owner_user_id")
    REFERENCES "credit_holds" ("id", "owner_user_id") ON DELETE SET NULL;
ALTER TABLE "payment_refunds"
    ADD CONSTRAINT "payment_refunds_debit_owner_fkey"
    FOREIGN KEY ("debit_entry_id", "owner_user_id")
    REFERENCES "credit_ledger_entries" ("id", "owner_user_id") ON DELETE RESTRICT;

-- A top-up's credit entry belongs to the same person.
ALTER TABLE "balance_topups"
    ADD CONSTRAINT "balance_topups_credit_owner_fkey"
    FOREIGN KEY ("credit_entry_id", "owner_user_id")
    REFERENCES "credit_ledger_entries" ("id", "owner_user_id") ON DELETE RESTRICT;

-- A hold's capture entry belongs to the same person.
ALTER TABLE "credit_holds"
    ADD CONSTRAINT "credit_holds_captured_owner_fkey"
    FOREIGN KEY ("captured_entry_id", "owner_user_id")
    REFERENCES "credit_ledger_entries" ("id", "owner_user_id") ON DELETE RESTRICT;

-- A dispute concerns the same person's top-up and writes their entries.
ALTER TABLE "payment_disputes"
    ADD CONSTRAINT "payment_disputes_topup_owner_fkey"
    FOREIGN KEY ("top_up_id", "owner_user_id")
    REFERENCES "balance_topups" ("id", "owner_user_id") ON DELETE RESTRICT;
ALTER TABLE "payment_disputes"
    ADD CONSTRAINT "payment_disputes_debit_owner_fkey"
    FOREIGN KEY ("debit_entry_id", "owner_user_id")
    REFERENCES "credit_ledger_entries" ("id", "owner_user_id") ON DELETE RESTRICT;
ALTER TABLE "payment_disputes"
    ADD CONSTRAINT "payment_disputes_reversal_owner_fkey"
    FOREIGN KEY ("reversal_entry_id", "owner_user_id")
    REFERENCES "credit_ledger_entries" ("id", "owner_user_id") ON DELETE RESTRICT;

-- A quote belongs to the person it was quoted to.
ALTER TABLE "price_quotes"
    ADD CONSTRAINT "price_quotes_id_owner_key" UNIQUE ("id", "owner_user_id");

-- =============================================================================
-- 3. Value invariants (§100, §101)
-- =============================================================================

-- Currency codes are uppercase ISO 4217 alphabetic. Not a full registry check
-- — the registry lives in code and gains entries — but enough that a lowercase
-- or malformed code can never be stored.
ALTER TABLE "customer_credit_accounts"
    ADD CONSTRAINT "credit_accounts_currency_shape" CHECK ("currency" ~ '^[A-Z]{3}$');
ALTER TABLE "credit_ledger_entries"
    ADD CONSTRAINT "ledger_entries_currency_shape" CHECK ("currency" ~ '^[A-Z]{3}$');
ALTER TABLE "credit_holds"
    ADD CONSTRAINT "credit_holds_currency_shape" CHECK ("currency" ~ '^[A-Z]{3}$');
ALTER TABLE "price_versions"
    ADD CONSTRAINT "price_versions_currency_shape" CHECK ("currency" ~ '^[A-Z]{3}$');
ALTER TABLE "price_quotes"
    ADD CONSTRAINT "price_quotes_currency_shape" CHECK ("currency" ~ '^[A-Z]{3}$');
ALTER TABLE "balance_topups"
    ADD CONSTRAINT "balance_topups_currency_shape" CHECK ("currency" ~ '^[A-Z]{3}$');
ALTER TABLE "payment_refunds"
    ADD CONSTRAINT "payment_refunds_currency_shape" CHECK ("currency" ~ '^[A-Z]{3}$');
ALTER TABLE "payment_disputes"
    ADD CONSTRAINT "payment_disputes_currency_shape" CHECK ("currency" ~ '^[A-Z]{3}$');

-- A zero-amount ledger entry records nothing and would sum to nothing. It is
-- almost always a bug in the caller, so it is refused rather than stored.
ALTER TABLE "credit_ledger_entries"
    ADD CONSTRAINT "ledger_entries_amount_nonzero" CHECK ("amount_minor_signed" <> 0);

-- Every entry type has a fixed sign. A positive SERVICE_CHARGE would hand the
-- customer money; a negative TOP_UP_CREDIT would take it. Neither is
-- expressible (§11).
ALTER TABLE "credit_ledger_entries"
    ADD CONSTRAINT "ledger_entries_sign_matches_type" CHECK (
        ("entry_type" IN ('TOP_UP_CREDIT', 'SERVICE_REFUND', 'PROMOTIONAL_CREDIT',
                          'ADMIN_CREDIT', 'CHARGEBACK_REVERSAL')
            AND "amount_minor_signed" > 0)
        OR ("entry_type" IN ('SERVICE_CHARGE', 'PAYMENT_REFUND_DEBIT', 'ADMIN_DEBIT',
                             'CHARGEBACK_DEBIT')
            AND "amount_minor_signed" < 0)
    );

-- Promotional credit is created only by a promotional entry, and a promotional
-- entry creates only promotional credit. This is what makes "promotional
-- credit cannot be withdrawn" a structural fact rather than a policy someone
-- has to remember to check (§9, §70).
ALTER TABLE "credit_ledger_entries"
    ADD CONSTRAINT "ledger_entries_promotional_class" CHECK (
        "entry_type" <> 'PROMOTIONAL_CREDIT' OR "credit_class" = 'PROMOTIONAL'
    );

-- Cash never leaves through the provider from a promotional account.
ALTER TABLE "credit_ledger_entries"
    ADD CONSTRAINT "ledger_entries_refund_debits_cash" CHECK (
        "entry_type" <> 'PAYMENT_REFUND_DEBIT' OR "credit_class" = 'CASH'
    );

-- A reversal points at a different entry, never at itself.
ALTER TABLE "credit_ledger_entries"
    ADD CONSTRAINT "ledger_entries_reversal_not_self" CHECK (
        "reversal_of_entry_id" IS NULL OR "reversal_of_entry_id" <> "id"
    );

-- A reference type and a reference id travel together or not at all.
ALTER TABLE "credit_ledger_entries"
    ADD CONSTRAINT "ledger_entries_reference_complete" CHECK (
        ("reference_type" IS NULL) = ("reference_id" IS NULL)
    );

-- Amounts stay inside the range the application promises to represent, well
-- within BIGINT so no sum of entries can overflow.
ALTER TABLE "credit_ledger_entries"
    ADD CONSTRAINT "ledger_entries_amount_bounded" CHECK (
        "amount_minor_signed" BETWEEN -1000000000000000 AND 1000000000000000
    );

-- A hold reserves a positive amount. Reserving zero or a negative amount is
-- meaningless, and a negative one would *increase* available balance (§101).
ALTER TABLE "credit_holds"
    ADD CONSTRAINT "credit_holds_amount_positive" CHECK (
        "amount_minor" > 0 AND "amount_minor" <= 1000000000000000
    );

-- Each terminal state carries its own timestamp, and only its own. A CAPTURED
-- hold with no capturedAt, or with a releasedAt, is not a state that happened.
ALTER TABLE "credit_holds"
    ADD CONSTRAINT "credit_holds_status_timestamps" CHECK (
        ("status" = 'ACTIVE'
            AND "captured_at" IS NULL AND "released_at" IS NULL AND "expired_at" IS NULL
            AND "captured_entry_id" IS NULL)
        OR ("status" = 'CAPTURED'
            AND "captured_at" IS NOT NULL AND "released_at" IS NULL AND "expired_at" IS NULL
            AND "captured_entry_id" IS NOT NULL)
        OR ("status" = 'RELEASED'
            AND "released_at" IS NOT NULL AND "captured_at" IS NULL AND "expired_at" IS NULL
            AND "captured_entry_id" IS NULL)
        OR ("status" = 'EXPIRED'
            AND "expired_at" IS NOT NULL AND "captured_at" IS NULL AND "released_at" IS NULL
            AND "captured_entry_id" IS NULL)
    );

-- A price is a positive amount. A free service is a product decision, not a
-- zero row that would quietly bypass the balance entirely.
ALTER TABLE "price_versions"
    ADD CONSTRAINT "price_versions_amount_positive" CHECK (
        "amount_minor" > 0 AND "amount_minor" <= 1000000000000000
    );
ALTER TABLE "price_versions"
    ADD CONSTRAINT "price_versions_market_shape" CHECK ("market_code" ~ '^[A-Z][A-Z0-9_]{1,15}$');
ALTER TABLE "price_versions"
    ADD CONSTRAINT "price_versions_status_timestamps" CHECK (
        ("status" = 'DRAFT' AND "activated_at" IS NULL AND "retired_at" IS NULL)
        OR ("status" = 'ACTIVE' AND "activated_at" IS NOT NULL AND "retired_at" IS NULL)
        OR ("status" = 'RETIRED' AND "activated_at" IS NOT NULL AND "retired_at" IS NOT NULL)
    );

ALTER TABLE "price_quotes"
    ADD CONSTRAINT "price_quotes_amount_positive" CHECK ("amount_minor" > 0);
ALTER TABLE "price_quotes"
    ADD CONSTRAINT "price_quotes_expires_after_creation" CHECK ("expires_at" > "created_at");

ALTER TABLE "balance_topups"
    ADD CONSTRAINT "balance_topups_amount_positive" CHECK (
        "amount_minor" > 0 AND "amount_minor" <= 1000000000000000
    );

-- A succeeded top-up has credited exactly once, and nothing else has.
ALTER TABLE "balance_topups"
    ADD CONSTRAINT "balance_topups_credit_matches_status" CHECK (
        ("status" = 'SUCCEEDED' AND "credit_entry_id" IS NOT NULL AND "succeeded_at" IS NOT NULL)
        OR ("status" <> 'SUCCEEDED' AND "credit_entry_id" IS NULL)
    );

ALTER TABLE "payment_refunds"
    ADD CONSTRAINT "payment_refunds_amount_positive" CHECK (
        "amount_minor" > 0 AND "amount_minor" <= 1000000000000000
    );

-- A succeeded refund has debited exactly once; a failed one never debited.
ALTER TABLE "payment_refunds"
    ADD CONSTRAINT "payment_refunds_debit_matches_status" CHECK (
        ("status" = 'SUCCEEDED' AND "debit_entry_id" IS NOT NULL AND "succeeded_at" IS NOT NULL)
        OR ("status" <> 'SUCCEEDED' AND "debit_entry_id" IS NULL)
    );

ALTER TABLE "payment_disputes"
    ADD CONSTRAINT "payment_disputes_amount_positive" CHECK ("amount_minor" > 0);
ALTER TABLE "payment_disputes"
    ADD CONSTRAINT "payment_disputes_resolution" CHECK (
        ("status" = 'OPEN' AND "resolved_at" IS NULL AND "reversal_entry_id" IS NULL)
        OR ("status" = 'LOST' AND "resolved_at" IS NOT NULL AND "reversal_entry_id" IS NULL)
        OR ("status" = 'WON' AND "resolved_at" IS NOT NULL AND "reversal_entry_id" IS NOT NULL)
    );

ALTER TABLE "payment_provider_events"
    ADD CONSTRAINT "provider_events_payload_digest" CHECK ("payload_sha256" ~ '^[0-9a-f]{64}$');

-- =============================================================================
-- 4. Ledger immutability (§12, §102, §129)
--
--    The single most important guarantee in the phase. A ledger row is written
--    once and then belongs to history: no UPDATE, no DELETE, not through the
--    application role and not through a privileged path.
--
--    This is enforced by a trigger rather than by a GRANT because a GRANT can
--    be widened by a later migration without anyone noticing, whereas removing
--    this trigger is a visible, deliberate act.
-- =============================================================================
CREATE OR REPLACE FUNCTION credit_ledger_entries_immutable()
RETURNS trigger LANGUAGE plpgsql SET search_path = public AS $$
BEGIN
    RAISE EXCEPTION
        'credit_ledger_entries rows are append-only; correct with a reversing entry'
        USING ERRCODE = 'integrity_constraint_violation';
END;
$$;

CREATE TRIGGER "credit_ledger_entries_no_update"
    BEFORE UPDATE ON "credit_ledger_entries"
    FOR EACH ROW EXECUTE FUNCTION credit_ledger_entries_immutable();

CREATE TRIGGER "credit_ledger_entries_no_delete"
    BEFORE DELETE ON "credit_ledger_entries"
    FOR EACH ROW EXECUTE FUNCTION credit_ledger_entries_immutable();

-- A reversal must correct an entry of the same currency and class, in the
-- opposite direction. Reversing a $3 USD cash charge with a $3 EUR promotional
-- credit would balance nothing.
CREATE OR REPLACE FUNCTION credit_ledger_entries_reversal_check()
RETURNS trigger LANGUAGE plpgsql SET search_path = public AS $$
DECLARE
    original RECORD;
BEGIN
    IF NEW."reversal_of_entry_id" IS NULL THEN
        RETURN NEW;
    END IF;

    SELECT * INTO original FROM "credit_ledger_entries" WHERE "id" = NEW."reversal_of_entry_id";
    IF NOT FOUND THEN
        RAISE EXCEPTION 'reversal target % does not exist', NEW."reversal_of_entry_id"
            USING ERRCODE = 'integrity_constraint_violation';
    END IF;

    IF original."owner_user_id" <> NEW."owner_user_id"
        OR original."currency" <> NEW."currency"
        OR original."credit_class" <> NEW."credit_class"
        OR original."account_id" <> NEW."account_id"
    THEN
        RAISE EXCEPTION 'a reversal must match its original owner, account, currency and class'
            USING ERRCODE = 'integrity_constraint_violation';
    END IF;

    IF sign(original."amount_minor_signed") = sign(NEW."amount_minor_signed") THEN
        RAISE EXCEPTION 'a reversal must move in the opposite direction to the entry it corrects'
            USING ERRCODE = 'integrity_constraint_violation';
    END IF;

    RETURN NEW;
END;
$$;

CREATE TRIGGER "credit_ledger_entries_reversal_check"
    BEFORE INSERT ON "credit_ledger_entries"
    FOR EACH ROW EXECUTE FUNCTION credit_ledger_entries_reversal_check();

-- An entry's account must agree with the entry about currency and class.
-- Without this, a USD cash entry could be filed against a EUR promotional
-- account and every balance derived from either would be wrong.
CREATE OR REPLACE FUNCTION credit_ledger_entries_account_match()
RETURNS trigger LANGUAGE plpgsql SET search_path = public AS $$
DECLARE
    acct RECORD;
BEGIN
    SELECT * INTO acct FROM "customer_credit_accounts" WHERE "id" = NEW."account_id";
    IF NOT FOUND THEN
        RAISE EXCEPTION 'ledger account % does not exist', NEW."account_id"
            USING ERRCODE = 'integrity_constraint_violation';
    END IF;
    IF acct."currency" <> NEW."currency" OR acct."credit_class" <> NEW."credit_class" THEN
        RAISE EXCEPTION 'ledger entry (% %) does not match account (% %)',
            NEW."currency", NEW."credit_class", acct."currency", acct."credit_class"
            USING ERRCODE = 'integrity_constraint_violation';
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER "credit_ledger_entries_account_match"
    BEFORE INSERT ON "credit_ledger_entries"
    FOR EACH ROW EXECUTE FUNCTION credit_ledger_entries_account_match();

-- =============================================================================
-- 5. Hold lifecycle (§21, §101, §164)
--
--    ACTIVE is the only state a hold can leave. A captured hold cannot be
--    released — the money moved and the service was delivered — and a released
--    or expired one cannot be captured, which would charge for something
--    PalCert already gave back.
-- =============================================================================
CREATE OR REPLACE FUNCTION credit_holds_guard()
RETURNS trigger LANGUAGE plpgsql SET search_path = public AS $$
BEGIN
    -- Identity is fixed at creation: a hold cannot be moved to another
    -- account, another owner, another currency or another amount.
    IF NEW."owner_user_id" <> OLD."owner_user_id"
        OR NEW."account_id" <> OLD."account_id"
        OR NEW."currency" <> OLD."currency"
        OR NEW."credit_class" <> OLD."credit_class"
        OR NEW."amount_minor" <> OLD."amount_minor"
        OR NEW."purpose" <> OLD."purpose"
    THEN
        RAISE EXCEPTION 'credit_hold % identity is immutable', OLD."id"
            USING ERRCODE = 'integrity_constraint_violation';
    END IF;

    IF OLD."status" <> 'ACTIVE' AND NEW."status" IS DISTINCT FROM OLD."status" THEN
        RAISE EXCEPTION 'credit_hold % is already % and cannot become %',
            OLD."id", OLD."status", NEW."status"
            USING ERRCODE = 'integrity_constraint_violation';
    END IF;

    RETURN NEW;
END;
$$;

CREATE TRIGGER "credit_holds_guard"
    BEFORE UPDATE ON "credit_holds"
    FOR EACH ROW EXECUTE FUNCTION credit_holds_guard();

-- A hold may only reserve against an account of the same currency and class.
CREATE OR REPLACE FUNCTION credit_holds_account_match()
RETURNS trigger LANGUAGE plpgsql SET search_path = public AS $$
DECLARE
    acct RECORD;
BEGIN
    SELECT * INTO acct FROM "customer_credit_accounts" WHERE "id" = NEW."account_id";
    IF NOT FOUND THEN
        RAISE EXCEPTION 'hold account % does not exist', NEW."account_id"
            USING ERRCODE = 'integrity_constraint_violation';
    END IF;
    IF acct."currency" <> NEW."currency" OR acct."credit_class" <> NEW."credit_class" THEN
        RAISE EXCEPTION 'credit hold (% %) does not match account (% %)',
            NEW."currency", NEW."credit_class", acct."currency", acct."credit_class"
            USING ERRCODE = 'integrity_constraint_violation';
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER "credit_holds_account_match"
    BEFORE INSERT ON "credit_holds"
    FOR EACH ROW EXECUTE FUNCTION credit_holds_account_match();

-- =============================================================================
-- 6. Price immutability (§28, §130, §164)
--
--    Once a price is ACTIVE, what it costs is history. Changing $3 to $4 is a
--    new PriceVersion, so a charge from March is still explained by the row it
--    actually used. Retiring is lifecycle metadata and leaves the amount alone.
-- =============================================================================
CREATE OR REPLACE FUNCTION price_versions_guard()
RETURNS trigger LANGUAGE plpgsql SET search_path = public AS $$
BEGIN
    IF OLD."status" IN ('ACTIVE', 'RETIRED') THEN
        IF NEW."product_code" <> OLD."product_code"
            OR NEW."currency" <> OLD."currency"
            OR NEW."market_code" <> OLD."market_code"
            OR NEW."amount_minor" <> OLD."amount_minor"
            OR NEW."effective_from" IS DISTINCT FROM OLD."effective_from"
        THEN
            RAISE EXCEPTION 'price_version % is % and its financial fields are immutable',
                OLD."id", OLD."status"
                USING ERRCODE = 'integrity_constraint_violation';
        END IF;
    END IF;

    IF OLD."status" = 'RETIRED' AND NEW."status" <> 'RETIRED' THEN
        RAISE EXCEPTION 'price_version % is retired and cannot be reactivated', OLD."id"
            USING ERRCODE = 'integrity_constraint_violation';
    END IF;

    IF OLD."status" = 'ACTIVE' AND NEW."status" = 'DRAFT' THEN
        RAISE EXCEPTION 'price_version % cannot return to DRAFT', OLD."id"
            USING ERRCODE = 'integrity_constraint_violation';
    END IF;

    RETURN NEW;
END;
$$;

CREATE TRIGGER "price_versions_guard"
    BEFORE UPDATE ON "price_versions"
    FOR EACH ROW EXECUTE FUNCTION price_versions_guard();

-- A quote captures a price; the capture never moves afterwards (§32).
CREATE OR REPLACE FUNCTION price_quotes_immutable()
RETURNS trigger LANGUAGE plpgsql SET search_path = public AS $$
BEGIN
    RAISE EXCEPTION 'price_quotes rows are immutable; request a new quote'
        USING ERRCODE = 'integrity_constraint_violation';
END;
$$;

CREATE TRIGGER "price_quotes_no_update"
    BEFORE UPDATE ON "price_quotes"
    FOR EACH ROW EXECUTE FUNCTION price_quotes_immutable();

-- =============================================================================
-- 7. Exactly one active price per product, currency and market (§29)
--
--    A partial unique index rather than application logic: two concurrent
--    activations would both pass a SELECT-then-INSERT check, and the losing
--    one must fail loudly rather than leave PalCert with two prices and no way
--    to say which applies.
-- =============================================================================
CREATE UNIQUE INDEX "price_versions_one_active"
    ON "price_versions" ("product_code", "currency", "market_code")
    WHERE "status" = 'ACTIVE';

-- =============================================================================
-- 8. Payment record immutability (§102, §164)
--
--    A settled payment's financial identity — who, how much, in what currency,
--    through which provider object — is frozen. Its status may still move
--    forward through the states §42 allows.
-- =============================================================================
CREATE OR REPLACE FUNCTION balance_topups_guard()
RETURNS trigger LANGUAGE plpgsql SET search_path = public AS $$
BEGIN
    IF NEW."owner_user_id" <> OLD."owner_user_id"
        OR NEW."currency" <> OLD."currency"
        OR NEW."amount_minor" <> OLD."amount_minor"
        OR NEW."provider" <> OLD."provider"
    THEN
        RAISE EXCEPTION 'balance_topup % financial identity is immutable', OLD."id"
            USING ERRCODE = 'integrity_constraint_violation';
    END IF;

    -- Provider object ids are write-once: a top-up that has been bound to a
    -- provider payment cannot be re-pointed at a different one, which is how a
    -- single payment could otherwise be credited to two top-ups (§103).
    IF OLD."provider_session_id" IS NOT NULL
        AND NEW."provider_session_id" IS DISTINCT FROM OLD."provider_session_id"
    THEN
        RAISE EXCEPTION 'balance_topup % is already bound to a provider session', OLD."id"
            USING ERRCODE = 'integrity_constraint_violation';
    END IF;
    IF OLD."provider_payment_id" IS NOT NULL
        AND NEW."provider_payment_id" IS DISTINCT FROM OLD."provider_payment_id"
    THEN
        RAISE EXCEPTION 'balance_topup % is already bound to a provider payment', OLD."id"
            USING ERRCODE = 'integrity_constraint_violation';
    END IF;

    -- Credit happens once. Once an entry is bound, nothing may rebind it —
    -- this is the last line of defence behind the webhook/reconciliation race.
    IF OLD."credit_entry_id" IS NOT NULL
        AND NEW."credit_entry_id" IS DISTINCT FROM OLD."credit_entry_id"
    THEN
        RAISE EXCEPTION 'balance_topup % has already been credited', OLD."id"
            USING ERRCODE = 'integrity_constraint_violation';
    END IF;

    -- A succeeded top-up is terminal: a late "failed" event must never take
    -- credit away (§125).
    IF OLD."status" = 'SUCCEEDED' AND NEW."status" <> 'SUCCEEDED' THEN
        RAISE EXCEPTION 'balance_topup % has succeeded and cannot become %',
            OLD."id", NEW."status"
            USING ERRCODE = 'integrity_constraint_violation';
    END IF;

    RETURN NEW;
END;
$$;

CREATE TRIGGER "balance_topups_guard"
    BEFORE UPDATE ON "balance_topups"
    FOR EACH ROW EXECUTE FUNCTION balance_topups_guard();

CREATE OR REPLACE FUNCTION payment_refunds_guard()
RETURNS trigger LANGUAGE plpgsql SET search_path = public AS $$
BEGIN
    IF NEW."owner_user_id" <> OLD."owner_user_id"
        OR NEW."top_up_id" <> OLD."top_up_id"
        OR NEW."currency" <> OLD."currency"
        OR NEW."amount_minor" <> OLD."amount_minor"
        OR NEW."provider" <> OLD."provider"
    THEN
        RAISE EXCEPTION 'payment_refund % financial identity is immutable', OLD."id"
            USING ERRCODE = 'integrity_constraint_violation';
    END IF;

    IF OLD."provider_refund_id" IS NOT NULL
        AND NEW."provider_refund_id" IS DISTINCT FROM OLD."provider_refund_id"
    THEN
        RAISE EXCEPTION 'payment_refund % is already bound to a provider refund', OLD."id"
            USING ERRCODE = 'integrity_constraint_violation';
    END IF;

    IF OLD."debit_entry_id" IS NOT NULL
        AND NEW."debit_entry_id" IS DISTINCT FROM OLD."debit_entry_id"
    THEN
        RAISE EXCEPTION 'payment_refund % has already been debited', OLD."id"
            USING ERRCODE = 'integrity_constraint_violation';
    END IF;

    IF OLD."status" = 'SUCCEEDED' AND NEW."status" <> 'SUCCEEDED' THEN
        RAISE EXCEPTION 'payment_refund % has succeeded and cannot become %',
            OLD."id", NEW."status"
            USING ERRCODE = 'integrity_constraint_violation';
    END IF;

    RETURN NEW;
END;
$$;

CREATE TRIGGER "payment_refunds_guard"
    BEFORE UPDATE ON "payment_refunds"
    FOR EACH ROW EXECUTE FUNCTION payment_refunds_guard();

-- A provider event receipt records what arrived. Only its processing outcome
-- may change; what the provider said is fixed (§50, §51).
CREATE OR REPLACE FUNCTION payment_provider_events_guard()
RETURNS trigger LANGUAGE plpgsql SET search_path = public AS $$
BEGIN
    IF NEW."provider" <> OLD."provider"
        OR NEW."provider_event_id" <> OLD."provider_event_id"
        OR NEW."provider_event_type" <> OLD."provider_event_type"
        OR NEW."payload_sha256" <> OLD."payload_sha256"
        OR NEW."event_kind" <> OLD."event_kind"
        OR NEW."occurred_at" <> OLD."occurred_at"
    THEN
        RAISE EXCEPTION 'payment_provider_event % is a receipt and cannot be rewritten', OLD."id"
            USING ERRCODE = 'integrity_constraint_violation';
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER "payment_provider_events_guard"
    BEFORE UPDATE ON "payment_provider_events"
    FOR EACH ROW EXECUTE FUNCTION payment_provider_events_guard();

-- =============================================================================
-- 9. Isolation classification (§97, §98, §147, §148)
--
--    Customer money is USER_SCOPED, exactly like a document or a check: it
--    belongs to the person, and no organization role reaches it (§79).
--
--    Pricing and provider events are SYSTEM. A price is PalCert's own global
--    statement and an organization cannot set one (§107); a provider event is
--    an external system's message, authenticated by signature rather than by a
--    user session (§150).
-- =============================================================================
INSERT INTO "table_isolation_classification" ("table_name", "classification", "tenant_column", "notes")
VALUES
    ('customer_credit_accounts', 'USER_SCOPED', 'owner_user_id', 'A person''s credit in one currency and class. An organization never sees a member''s balance.'),
    ('credit_ledger_entries',    'USER_SCOPED', 'owner_user_id', 'The append-only truth behind a balance. Never updated or deleted, by anyone.'),
    ('credit_holds',             'USER_SCOPED', 'owner_user_id', 'Credit reserved but not yet spent. Terminal states are irreversible.'),
    ('price_quotes',             'USER_SCOPED', 'owner_user_id', 'A price captured for one person at one moment. Immutable once issued.'),
    ('balance_topups',           'USER_SCOPED', 'owner_user_id', 'One attempt to add credit through the payment provider.'),
    ('payment_refunds',          'USER_SCOPED', 'owner_user_id', 'Cash returned to a person through the provider. Initiated by finance, visible to the owner.'),
    ('payment_disputes',         'USER_SCOPED', 'owner_user_id', 'A provider dispute against a person''s settled payment.'),
    ('service_products',         'SYSTEM',      NULL,            'PalCert''s global service catalogue. An organization cannot add or price one.'),
    ('price_versions',           'SYSTEM',      NULL,            'PalCert''s global prices. Immutable once active; an organization can never change one.'),
    ('payment_provider_events',  'SYSTEM',      NULL,            'Receipts for provider webhooks. Authenticated by provider signature, not by a user session.');

-- =============================================================================
-- 10. Row-level security (§97, §99, §148)
--
--     Every user-scoped finance table gets the same FOR ALL policy the rest of
--     the product uses, so the catalogue-driven coverage tests pick them up
--     automatically rather than needing a finance exemption.
-- =============================================================================
ALTER TABLE "customer_credit_accounts" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "customer_credit_accounts" FORCE ROW LEVEL SECURITY;
CREATE POLICY "customer_credit_accounts_owner" ON "customer_credit_accounts" FOR ALL
    USING (app_is_platform_admin() OR "owner_user_id" = app_current_user_id())
    WITH CHECK (app_is_platform_admin() OR "owner_user_id" = app_current_user_id());

ALTER TABLE "credit_ledger_entries" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "credit_ledger_entries" FORCE ROW LEVEL SECURITY;
CREATE POLICY "credit_ledger_entries_owner" ON "credit_ledger_entries" FOR ALL
    USING (app_is_platform_admin() OR "owner_user_id" = app_current_user_id())
    WITH CHECK (app_is_platform_admin() OR "owner_user_id" = app_current_user_id());

ALTER TABLE "credit_holds" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "credit_holds" FORCE ROW LEVEL SECURITY;
CREATE POLICY "credit_holds_owner" ON "credit_holds" FOR ALL
    USING (app_is_platform_admin() OR "owner_user_id" = app_current_user_id())
    WITH CHECK (app_is_platform_admin() OR "owner_user_id" = app_current_user_id());

ALTER TABLE "price_quotes" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "price_quotes" FORCE ROW LEVEL SECURITY;
CREATE POLICY "price_quotes_owner" ON "price_quotes" FOR ALL
    USING (app_is_platform_admin() OR "owner_user_id" = app_current_user_id())
    WITH CHECK (app_is_platform_admin() OR "owner_user_id" = app_current_user_id());

ALTER TABLE "balance_topups" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "balance_topups" FORCE ROW LEVEL SECURITY;
CREATE POLICY "balance_topups_owner" ON "balance_topups" FOR ALL
    USING (app_is_platform_admin() OR "owner_user_id" = app_current_user_id())
    WITH CHECK (app_is_platform_admin() OR "owner_user_id" = app_current_user_id());

ALTER TABLE "payment_refunds" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "payment_refunds" FORCE ROW LEVEL SECURITY;
CREATE POLICY "payment_refunds_owner" ON "payment_refunds" FOR ALL
    USING (app_is_platform_admin() OR "owner_user_id" = app_current_user_id())
    WITH CHECK (app_is_platform_admin() OR "owner_user_id" = app_current_user_id());

ALTER TABLE "payment_disputes" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "payment_disputes" FORCE ROW LEVEL SECURITY;
CREATE POLICY "payment_disputes_owner" ON "payment_disputes" FOR ALL
    USING (app_is_platform_admin() OR "owner_user_id" = app_current_user_id())
    WITH CHECK (app_is_platform_admin() OR "owner_user_id" = app_current_user_id());

-- SYSTEM tables: readable by the application, written only through the
-- schema-owning role or an explicit platform-admin path. Prices are world-
-- readable because a customer must be able to see what a service costs;
-- provider events are not.
ALTER TABLE "service_products" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "service_products" FORCE ROW LEVEL SECURITY;
CREATE POLICY "service_products_read" ON "service_products" FOR SELECT USING (true);
CREATE POLICY "service_products_admin_write" ON "service_products" FOR ALL
    USING (app_is_platform_admin()) WITH CHECK (app_is_platform_admin());

ALTER TABLE "price_versions" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "price_versions" FORCE ROW LEVEL SECURITY;
CREATE POLICY "price_versions_read" ON "price_versions" FOR SELECT USING (true);
CREATE POLICY "price_versions_admin_write" ON "price_versions" FOR ALL
    USING (app_is_platform_admin()) WITH CHECK (app_is_platform_admin());

-- A provider event names no user and is never shown to one.
ALTER TABLE "payment_provider_events" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "payment_provider_events" FORCE ROW LEVEL SECURITY;
CREATE POLICY "payment_provider_events_admin" ON "payment_provider_events" FOR ALL
    USING (app_is_platform_admin()) WITH CHECK (app_is_platform_admin());

-- =============================================================================
-- 11. Permissions and role grants (§95)
-- =============================================================================
INSERT INTO "permissions" ("id", "code", "description") VALUES
    (gen_random_uuid(), 'balance:read:self',         'Read your own PalCert Balance and transaction history'),
    (gen_random_uuid(), 'balance:topup:self',        'Add credit to your own PalCert Balance'),
    (gen_random_uuid(), 'pricing:price:read',        'Read PalCert''s service prices'),
    (gen_random_uuid(), 'pricing:price:create',      'Draft a new PalCert service price'),
    (gen_random_uuid(), 'pricing:price:activate',    'Put a PalCert service price into force'),
    (gen_random_uuid(), 'finance:payment:read',      'Read customer payments and top-ups'),
    (gen_random_uuid(), 'finance:ledger:read',       'Read the credit ledger behind a balance'),
    (gen_random_uuid(), 'finance:refund:create',     'Return money to a customer through the payment provider'),
    (gen_random_uuid(), 'finance:adjustment:create', 'Credit or debit a customer balance, with a reason')
ON CONFLICT ("code") DO NOTHING;

-- Self-service: every role that can read its own profile can see its own money.
INSERT INTO "role_permissions" ("role_id", "permission_id")
SELECT rp."role_id", p."id"
FROM "role_permissions" rp
JOIN "permissions" baseline ON baseline."id" = rp."permission_id" AND baseline."code" = 'profile:read:self'
CROSS JOIN "permissions" p
WHERE p."code" IN ('balance:read:self', 'balance:topup:self')
ON CONFLICT ("role_id", "permission_id") DO NOTHING;

-- PALCERT_FINANCE: the only role that may move money.
INSERT INTO "role_permissions" ("role_id", "permission_id")
SELECT r."id", p."id"
FROM "roles" r
CROSS JOIN "permissions" p
WHERE r."code" = 'PALCERT_FINANCE'
  AND p."code" IN ('pricing:price:read', 'pricing:price:create', 'pricing:price:activate',
                   'finance:payment:read', 'finance:ledger:read',
                   'finance:refund:create', 'finance:adjustment:create')
ON CONFLICT ("role_id", "permission_id") DO NOTHING;

-- PALCERT_ADMIN and PALCERT_AUDITOR: read what finance does, move nothing.
INSERT INTO "role_permissions" ("role_id", "permission_id")
SELECT r."id", p."id"
FROM "roles" r
CROSS JOIN "permissions" p
WHERE r."code" IN ('PALCERT_ADMIN', 'PALCERT_AUDITOR')
  AND p."code" IN ('pricing:price:read', 'finance:payment:read', 'finance:ledger:read')
ON CONFLICT ("role_id", "permission_id") DO NOTHING;

-- PALCERT_SUPPORT: payment status only, so "where is my top-up?" is
-- answerable. Deliberately no ledger read and no mutation at all (§78).
INSERT INTO "role_permissions" ("role_id", "permission_id")
SELECT r."id", p."id"
FROM "roles" r
CROSS JOIN "permissions" p
WHERE r."code" = 'PALCERT_SUPPORT'
  AND p."code" = 'finance:payment:read'
ON CONFLICT ("role_id", "permission_id") DO NOTHING;

-- =============================================================================
-- 12. Grants and seed data
-- =============================================================================
GRANT SELECT, INSERT, UPDATE, DELETE ON
    "customer_credit_accounts", "credit_holds", "price_quotes",
    "balance_topups", "payment_refunds", "payment_disputes",
    "service_products", "price_versions", "payment_provider_events"
TO "palcert_app";

-- The ledger is deliberately narrower: the application may read and append,
-- and has no UPDATE or DELETE privilege at all. The triggers in section 4 are
-- the belt; this is the braces (§129, §151).
--
-- The REVOKE is not decoration. Phase 2 set ALTER DEFAULT PRIVILEGES granting
-- the application role full DML on every table created afterwards, so without
-- this the ledger would quietly inherit UPDATE and DELETE — and the only thing
-- standing between a bad query and rewritten financial history would be the
-- triggers. Two independent locks is the point.
GRANT SELECT, INSERT ON "credit_ledger_entries" TO "palcert_app";
REVOKE UPDATE, DELETE ON "credit_ledger_entries" FROM "palcert_app";

-- Same reasoning for price quotes: a quote is a capture, and the application
-- has no business editing one after it is issued (§32).
REVOKE UPDATE, DELETE ON "price_quotes" FROM "palcert_app";

-- The service catalogue. DOCUMENT_CHECK is the only active product: SmartFix
-- and ExpertFix are catalogued so pricing is ready, and quoting one would
-- imply a workflow that does not exist yet (§25).
-- `updated_at` is maintained by Prisma at the application layer, so it has no
-- database default and a raw seed must set it explicitly.
INSERT INTO "service_products" ("product_code", "active", "name_en", "name_ar", "description_en", "description_ar", "updated_at")
VALUES
    ('DOCUMENT_CHECK', true,  'Document check', 'فحص المستند',
     'One compliance check of a document against a published standard.',
     'فحص واحد لمطابقة مستند لمعيار منشور.', now()),
    ('SMARTFIX',       false, 'SmartFix', 'التصحيح الذكي',
     'Automated correction of formatting issues. Not yet available.',
     'تصحيح آلي لمشكلات التنسيق. غير متاح بعد.', now()),
    ('EXPERTFIX',      false, 'ExpertFix', 'التصحيح بخبير',
     'Human-assisted correction. Not yet available.',
     'تصحيح بمساعدة خبير. غير متاح بعد.', now())
ON CONFLICT ("product_code") DO NOTHING;

-- =============================================================================
-- 13. Platform-owned processing jobs
--
--     Settling a payment and reconciling against the provider belong to
--     PalCert, not to a customer and not to an organization. Until now every
--     job had an owner, because every job was work done on somebody's
--     document. These two are not.
--
--     Rather than invent a fictional system user — which would make the
--     ledger's `owner_user_id` lie, and would need a real row in `users` that
--     could then be granted roles — the column becomes nullable and a CHECK
--     states exactly which job types may omit it.
-- =============================================================================
ALTER TABLE "processing_jobs" ALTER COLUMN "owner_user_id" DROP NOT NULL;

ALTER TABLE "processing_jobs" DROP CONSTRAINT "processing_jobs_resource_type_known";
ALTER TABLE "processing_jobs"
    ADD CONSTRAINT "processing_jobs_resource_type_known"
    CHECK ("resource_type" IN (
        'DOCUMENT_VERSION', 'DOCUMENT', 'DOCUMENT_ANALYSIS', 'CHECK_RUN', 'AI_REVIEW',
        'STANDARD_SOURCE_ASSET', 'RULE_EXTRACTION_RUN',
        'PAYMENT_PROVIDER_EVENT', 'PAYMENT_RECONCILIATION'));

-- One rule covering all three tenancy shapes, so a job can never be filed
-- under the wrong one: organization work names an organization, platform work
-- names neither, and everything else names an owner.
ALTER TABLE "processing_jobs" DROP CONSTRAINT "processing_jobs_tenancy_matches_type";
ALTER TABLE "processing_jobs"
    ADD CONSTRAINT "processing_jobs_tenancy_matches_type" CHECK (
        ("resource_type" IN ('STANDARD_SOURCE_ASSET', 'RULE_EXTRACTION_RUN')
            AND "organization_id" IS NOT NULL AND "owner_user_id" IS NOT NULL)
        OR ("resource_type" IN ('PAYMENT_PROVIDER_EVENT', 'PAYMENT_RECONCILIATION')
            AND "organization_id" IS NULL AND "owner_user_id" IS NULL)
        OR ("resource_type" NOT IN ('STANDARD_SOURCE_ASSET', 'RULE_EXTRACTION_RUN',
                                    'PAYMENT_PROVIDER_EVENT', 'PAYMENT_RECONCILIATION')
            AND "organization_id" IS NULL AND "owner_user_id" IS NOT NULL)
    );

-- A dispute event names the dispute, not the payment it claws back. The
-- adapter resolves that link once, and the receipt carries it, so processing
-- never has to guess which payment a chargeback belongs to (§84).
ALTER TABLE "payment_provider_events" ADD COLUMN "related_payment_id" VARCHAR(255);

-- The amount a dispute is for, which PalCert must know to write the
-- chargeback, and which is useful evidence whenever provider state and
-- PalCert state disagree. Not sensitive: it is PalCert's own money movement.
ALTER TABLE "payment_provider_events" ADD COLUMN "currency" VARCHAR(3);
ALTER TABLE "payment_provider_events" ADD COLUMN "amount_minor" BIGINT;
