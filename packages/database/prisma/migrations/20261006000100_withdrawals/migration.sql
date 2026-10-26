-- =============================================================================
-- Withdrawals and payouts (ADR-0150)
--
-- One controlled workflow pays money out of PalCert at three scopes — a
-- user's eligible real money, an organization's settled attestation earnings,
-- and PalCert's own realized revenue. A request is reserved at submission,
-- reviewed and approved by PalCert finance, paid outside PalCert by a person,
-- and settled — exactly once — when the external transfer reference is
-- recorded.
--
-- Additive in effect. No existing row is written, moved or deleted:
--   * new tables and enums for requests, destinations, reservations,
--     settlements, execution attempts, history, proofs, policy and reviewers;
--   * the ledger sign rule is replaced by the same rule plus one negative
--     type — strictly wider, re-checked against every existing entry;
--   * new CHECKs that only new kinds of row (a WITHDRAWAL hold, a
--     WITHDRAWAL_DEBIT entry) can trip;
--   * the notification constraints and audience functions gain withdrawal
--     branches; every existing branch is reproduced unchanged;
--   * one platform-wide policy row with the approved defaults.
--
-- Organizations and PalCert hold no customer credit account and no balance
-- column. Their payout availability is always derived from the authoritative
-- records (attestation settlements, captured purchases, chargebacks) minus
-- their own payout reservations and settlements. `withdrawal_accounts` is a
-- lock anchor, never a balance.
--
--    1. Vocabulary
--    2. Policy
--    3. Payout destinations
--    4. Lock anchors
--    5. Requests
--    6. Reservations (organization and platform)
--    7. Settlements
--    8. Execution attempts
--    9. History
--   10. Payout proofs
--   11. Reviewers
--   12. Integrity triggers
--   13. The ledger and holds: one new debit, one new hold purpose, confined
--   14. Row-level security, privileges, classification
--   15. Notifications
--   16. Durable jobs
--   17. Permissions
--   18. Function privileges
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. Vocabulary
-- -----------------------------------------------------------------------------
CREATE TYPE "WithdrawalScope" AS ENUM ('USER', 'ORGANIZATION', 'PLATFORM');

CREATE TYPE "WithdrawalStatus" AS ENUM (
    'DRAFT', 'PENDING_REVIEW', 'APPROVED', 'PROCESSING', 'PAID', 'REJECTED', 'CANCELLED', 'FAILED');

CREATE TYPE "PayoutDestinationType" AS ENUM ('BANK_ACCOUNT', 'MOBILE_WALLET', 'OTHER');

CREATE TYPE "WithdrawalRejectionReason" AS ENUM (
    'DESTINATION_INVALID', 'BENEFICIARY_MISMATCH', 'VERIFICATION_REQUIRED', 'POLICY_VIOLATION',
    'SUSPECTED_FRAUD', 'DUPLICATE_REQUEST', 'OTHER');

CREATE TYPE "WithdrawalEventType" AS ENUM (
    'CREATED', 'SUBMITTED', 'RESERVED', 'REVIEW_STARTED', 'APPROVED', 'REJECTED', 'CANCELLED',
    'EXECUTION_STARTED', 'PAID', 'FAILED', 'RETRY_STARTED', 'RESERVATION_RELEASED',
    'PROOF_ATTACHED');

CREATE TYPE "WithdrawalActorSide" AS ENUM ('REQUESTER', 'FINANCE');

CREATE TYPE "WithdrawalAttemptOutcome" AS ENUM ('IN_PROGRESS', 'SUCCEEDED', 'FAILED');

CREATE TYPE "WithdrawalReservationStatus" AS ENUM ('ACTIVE', 'CONSUMED', 'RELEASED');

-- -----------------------------------------------------------------------------
-- 2. Policy — configured by PalCert administrators
--
-- One row. Clearing periods default to the approved values (14 days for a
-- verified manual top-up, 30 days for settled organization earnings) and are
-- bounded. There is no fee column: v1 charges no withdrawal fee, and a fee, if
-- ever introduced, will be an explicit versioned policy.
-- -----------------------------------------------------------------------------
CREATE TABLE "withdrawal_policy" (
    "id" SMALLINT NOT NULL DEFAULT 1,
    "user_manual_topup_clearing_days" INTEGER NOT NULL DEFAULT 14,
    "organization_clearing_days" INTEGER NOT NULL DEFAULT 30,
    "version" INTEGER NOT NULL DEFAULT 1,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_by_user_id" UUID,

    CONSTRAINT "withdrawal_policy_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "withdrawal_policy_singleton" CHECK ("id" = 1),
    CONSTRAINT "withdrawal_policy_user_clearing_bounded" CHECK (
        "user_manual_topup_clearing_days" BETWEEN 0 AND 90),
    CONSTRAINT "withdrawal_policy_org_clearing_bounded" CHECK (
        "organization_clearing_days" BETWEEN 0 AND 180),
    CONSTRAINT "withdrawal_policy_version_positive" CHECK ("version" >= 1)
);

ALTER TABLE "withdrawal_policy"
    ADD CONSTRAINT "withdrawal_policy_updated_by_fkey"
    FOREIGN KEY ("updated_by_user_id") REFERENCES "users"("id") ON DELETE SET NULL;

INSERT INTO "withdrawal_policy" ("id") VALUES (1) ON CONFLICT ("id") DO NOTHING;

-- Optional per-currency bounds on one request. No row means no bound.
CREATE TABLE "withdrawal_currency_limits" (
    "currency" CHAR(3) NOT NULL,
    "min_amount_minor" BIGINT,
    "max_amount_minor" BIGINT,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_by_user_id" UUID,

    CONSTRAINT "withdrawal_currency_limits_pkey" PRIMARY KEY ("currency"),
    CONSTRAINT "withdrawal_currency_limits_currency_shape" CHECK ("currency" ~ '^[A-Z]{3}$'),
    CONSTRAINT "withdrawal_currency_limits_positive" CHECK (
        ("min_amount_minor" IS NULL OR "min_amount_minor" > 0)
        AND ("max_amount_minor" IS NULL OR "max_amount_minor" > 0)),
    CONSTRAINT "withdrawal_currency_limits_ordered" CHECK (
        "min_amount_minor" IS NULL OR "max_amount_minor" IS NULL
        OR "min_amount_minor" <= "max_amount_minor"),
    CONSTRAINT "withdrawal_currency_limits_bounded" CHECK (
        ("min_amount_minor" IS NULL OR "min_amount_minor" <= 1000000000000000)
        AND ("max_amount_minor" IS NULL OR "max_amount_minor" <= 1000000000000000))
);

ALTER TABLE "withdrawal_currency_limits"
    ADD CONSTRAINT "withdrawal_currency_limits_updated_by_fkey"
    FOREIGN KEY ("updated_by_user_id") REFERENCES "users"("id") ON DELETE SET NULL;

-- -----------------------------------------------------------------------------
-- 3. Payout destinations — where a beneficiary wants to be paid
--
-- Owned by exactly one beneficiary: a user, an organization, or PalCert's
-- treasury. The identifying details (IBAN, account number, wallet number,
-- instructions) are sealed with AES-256-GCM under the payout-destination key
-- ring and never stored in the clear. `summary` holds only what is safe to
-- display: type, label, beneficiary name, bank name and masked tails.
-- Never deleted; archiving is permanent.
-- -----------------------------------------------------------------------------
CREATE TABLE "payout_destinations" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "scope" "WithdrawalScope" NOT NULL,
    "owner_user_id" UUID,
    "organization_id" UUID,
    "type" "PayoutDestinationType" NOT NULL,
    "label" VARCHAR(80) NOT NULL,
    "beneficiary_name" VARCHAR(140) NOT NULL,
    "currency" CHAR(3),
    "summary" JSONB NOT NULL,
    "details_ciphertext" TEXT NOT NULL,
    "details_iv" TEXT NOT NULL,
    "details_auth_tag" TEXT NOT NULL,
    "details_kid" TEXT NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "archived_at" TIMESTAMPTZ(6),
    "created_by_user_id" UUID NOT NULL,
    "updated_by_user_id" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "payout_destinations_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "payout_destinations_scope_shape" CHECK (
        ("scope" = 'USER' AND "owner_user_id" IS NOT NULL AND "organization_id" IS NULL)
        OR ("scope" = 'ORGANIZATION' AND "organization_id" IS NOT NULL AND "owner_user_id" IS NULL)
        OR ("scope" = 'PLATFORM' AND "owner_user_id" IS NULL AND "organization_id" IS NULL)),
    CONSTRAINT "payout_destinations_currency_shape" CHECK (
        "currency" IS NULL OR "currency" ~ '^[A-Z]{3}$'),
    CONSTRAINT "payout_destinations_summary_is_object" CHECK (jsonb_typeof("summary") = 'object'),
    CONSTRAINT "payout_destinations_text_bounded" CHECK (
        length("label") BETWEEN 1 AND 80 AND length("beneficiary_name") BETWEEN 1 AND 140),
    CONSTRAINT "payout_destinations_version_positive" CHECK ("version" >= 1)
);

CREATE INDEX "payout_destinations_user_idx"
    ON "payout_destinations"("owner_user_id", "created_at" DESC) WHERE "scope" = 'USER';
CREATE INDEX "payout_destinations_org_idx"
    ON "payout_destinations"("organization_id", "created_at" DESC) WHERE "scope" = 'ORGANIZATION';

ALTER TABLE "payout_destinations"
    ADD CONSTRAINT "payout_destinations_owner_fkey"
    FOREIGN KEY ("owner_user_id") REFERENCES "users"("id") ON DELETE RESTRICT;
ALTER TABLE "payout_destinations"
    ADD CONSTRAINT "payout_destinations_organization_fkey"
    FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT;
ALTER TABLE "payout_destinations"
    ADD CONSTRAINT "payout_destinations_created_by_fkey"
    FOREIGN KEY ("created_by_user_id") REFERENCES "users"("id") ON DELETE RESTRICT;
ALTER TABLE "payout_destinations"
    ADD CONSTRAINT "payout_destinations_updated_by_fkey"
    FOREIGN KEY ("updated_by_user_id") REFERENCES "users"("id") ON DELETE SET NULL;

-- -----------------------------------------------------------------------------
-- 4. Lock anchors for organization and platform payouts
--
-- One row per (organization, currency) and per platform currency, created on
-- first use. A submission locks its row FOR UPDATE before computing what is
-- available, which is what stops two concurrent requests oversubscribing the
-- same earnings. It holds no amount: availability is always derived.
-- -----------------------------------------------------------------------------
CREATE TABLE "withdrawal_accounts" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "scope" "WithdrawalScope" NOT NULL,
    "organization_id" UUID,
    "currency" CHAR(3) NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "withdrawal_accounts_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "withdrawal_accounts_scope_shape" CHECK (
        ("scope" = 'ORGANIZATION' AND "organization_id" IS NOT NULL)
        OR ("scope" = 'PLATFORM' AND "organization_id" IS NULL)),
    CONSTRAINT "withdrawal_accounts_currency_shape" CHECK ("currency" ~ '^[A-Z]{3}$')
);

CREATE UNIQUE INDEX "withdrawal_accounts_org_identity"
    ON "withdrawal_accounts"("organization_id", "currency") WHERE "scope" = 'ORGANIZATION';
CREATE UNIQUE INDEX "withdrawal_accounts_platform_identity"
    ON "withdrawal_accounts"("currency") WHERE "scope" = 'PLATFORM';

ALTER TABLE "withdrawal_accounts"
    ADD CONSTRAINT "withdrawal_accounts_organization_fkey"
    FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT;

-- -----------------------------------------------------------------------------
-- 5. Requests
--
-- One request pays one amount, in one currency, to one snapshotted
-- destination. The snapshot — summary in the clear, full details sealed — is
-- frozen at creation, so changing a saved IBAN later never changes where
-- finance was told to send this money.
-- -----------------------------------------------------------------------------
CREATE TABLE "withdrawal_requests" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "scope" "WithdrawalScope" NOT NULL,
    "requester_user_id" UUID NOT NULL,
    "beneficiary_user_id" UUID,
    "organization_id" UUID,
    "currency" CHAR(3) NOT NULL,
    "amount_minor" BIGINT NOT NULL,
    "status" "WithdrawalStatus" NOT NULL DEFAULT 'DRAFT',

    "destination_id" UUID NOT NULL,
    "destination_snapshot" JSONB NOT NULL,
    "destination_sealed_ciphertext" TEXT NOT NULL,
    "destination_sealed_iv" TEXT NOT NULL,
    "destination_sealed_auth_tag" TEXT NOT NULL,
    "destination_sealed_kid" TEXT NOT NULL,
    "requester_note" VARCHAR(500),

    -- What was withdrawable, in this scope and currency, just before this
    -- request reserved. Recorded for the reviewer; never used to compute.
    "available_before_minor" BIGINT,
    -- The reservation: a credit hold for a user, a reservation row otherwise.
    "hold_id" UUID,
    "reservation_id" UUID,

    "submitted_at" TIMESTAMPTZ(6),
    "review_started_at" TIMESTAMPTZ(6),
    "reviewed_by_user_id" UUID,
    "approved_at" TIMESTAMPTZ(6),
    "approved_by_user_id" UUID,
    "rejected_at" TIMESTAMPTZ(6),
    "rejected_by_user_id" UUID,
    "rejection_reason" "WithdrawalRejectionReason",
    "rejection_note" VARCHAR(1000),
    "cancelled_at" TIMESTAMPTZ(6),
    "cancelled_by_user_id" UUID,
    "release_note" VARCHAR(1000),
    "executed_at" TIMESTAMPTZ(6),
    "executed_by_user_id" UUID,
    "external_transfer_reference" VARCHAR(120),
    "execution_note" VARCHAR(1000),

    "version" INTEGER NOT NULL DEFAULT 1,
    "idempotency_key" VARCHAR(200),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "withdrawal_requests_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "withdrawal_requests_hold_key" UNIQUE ("hold_id"),
    CONSTRAINT "withdrawal_requests_reservation_key" UNIQUE ("reservation_id"),
    CONSTRAINT "withdrawal_requests_currency_shape" CHECK ("currency" ~ '^[A-Z]{3}$'),
    CONSTRAINT "withdrawal_requests_amount_bounded" CHECK (
        "amount_minor" > 0 AND "amount_minor" <= 1000000000000000),
    CONSTRAINT "withdrawal_requests_snapshot_is_object" CHECK (
        jsonb_typeof("destination_snapshot") = 'object'),
    -- The beneficiary is a user only for a user's own money, and is then the
    -- requester. An organization is never written as a user, nor PalCert.
    CONSTRAINT "withdrawal_requests_scope_shape" CHECK (
        ("scope" = 'USER' AND "beneficiary_user_id" = "requester_user_id"
            AND "organization_id" IS NULL)
        OR ("scope" = 'ORGANIZATION' AND "organization_id" IS NOT NULL
            AND "beneficiary_user_id" IS NULL)
        OR ("scope" = 'PLATFORM' AND "organization_id" IS NULL
            AND "beneficiary_user_id" IS NULL)),
    CONSTRAINT "withdrawal_requests_submitted_complete" CHECK (
        "status" = 'DRAFT'
        OR ("status" = 'CANCELLED' AND "submitted_at" IS NULL)
        OR ("submitted_at" IS NOT NULL AND "available_before_minor" IS NOT NULL)),
    -- Every state that holds money, and PAID, has exactly the reservation its
    -- scope uses.
    CONSTRAINT "withdrawal_requests_reservation_shape" CHECK (
        "status" NOT IN ('PENDING_REVIEW', 'APPROVED', 'PROCESSING', 'FAILED', 'PAID')
        OR ("scope" = 'USER' AND "hold_id" IS NOT NULL AND "reservation_id" IS NULL)
        OR ("scope" <> 'USER' AND "reservation_id" IS NOT NULL AND "hold_id" IS NULL)),
    CONSTRAINT "withdrawal_requests_approved_shape" CHECK (
        "status" NOT IN ('APPROVED', 'PROCESSING', 'FAILED', 'PAID')
        OR ("approved_by_user_id" IS NOT NULL AND "approved_at" IS NOT NULL)),
    CONSTRAINT "withdrawal_requests_rejected_shape" CHECK (
        ("status" = 'REJECTED') = ("rejection_reason" IS NOT NULL)
        AND ("status" <> 'REJECTED' OR ("rejected_by_user_id" IS NOT NULL AND "rejected_at" IS NOT NULL))),
    CONSTRAINT "withdrawal_requests_cancelled_shape" CHECK (
        ("status" = 'CANCELLED') = ("cancelled_at" IS NOT NULL)),
    CONSTRAINT "withdrawal_requests_paid_shape" CHECK (
        ("status" = 'PAID') = ("executed_at" IS NOT NULL)
        AND ("status" <> 'PAID' OR ("executed_by_user_id" IS NOT NULL
            AND "external_transfer_reference" IS NOT NULL
            AND length(btrim("external_transfer_reference")) > 0))),
    CONSTRAINT "withdrawal_requests_review_pair" CHECK (
        ("review_started_at" IS NULL) = ("reviewed_by_user_id" IS NULL)),
    -- Separation of duties, enforced where no service can route around it.
    -- Nobody reviews, approves or rejects their own request; for PalCert's own
    -- money, the person who records the payout is neither the requester nor
    -- the approver.
    CONSTRAINT "withdrawal_requests_not_self_reviewed" CHECK (
        ("reviewed_by_user_id" IS NULL OR "reviewed_by_user_id" <> "requester_user_id")
        AND ("approved_by_user_id" IS NULL OR "approved_by_user_id" <> "requester_user_id")
        AND ("rejected_by_user_id" IS NULL OR "rejected_by_user_id" <> "requester_user_id")),
    CONSTRAINT "withdrawal_requests_platform_three_people" CHECK (
        "scope" <> 'PLATFORM' OR "executed_by_user_id" IS NULL
        OR ("executed_by_user_id" <> "requester_user_id"
            AND "executed_by_user_id" IS DISTINCT FROM "approved_by_user_id")),
    CONSTRAINT "withdrawal_requests_version_positive" CHECK ("version" >= 1)
);

CREATE UNIQUE INDEX "withdrawal_requests_requester_idempotency"
    ON "withdrawal_requests"("requester_user_id", "idempotency_key");
CREATE INDEX "withdrawal_requests_requester_idx"
    ON "withdrawal_requests"("requester_user_id", "created_at" DESC, "id");
CREATE INDEX "withdrawal_requests_org_idx"
    ON "withdrawal_requests"("organization_id", "created_at" DESC, "id")
    WHERE "scope" = 'ORGANIZATION';
CREATE INDEX "withdrawal_requests_queue_idx"
    ON "withdrawal_requests"("status", "submitted_at", "id");

ALTER TABLE "withdrawal_requests"
    ADD CONSTRAINT "withdrawal_requests_requester_fkey"
    FOREIGN KEY ("requester_user_id") REFERENCES "users"("id") ON DELETE RESTRICT;
ALTER TABLE "withdrawal_requests"
    ADD CONSTRAINT "withdrawal_requests_beneficiary_fkey"
    FOREIGN KEY ("beneficiary_user_id") REFERENCES "users"("id") ON DELETE RESTRICT;
ALTER TABLE "withdrawal_requests"
    ADD CONSTRAINT "withdrawal_requests_organization_fkey"
    FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT;
ALTER TABLE "withdrawal_requests"
    ADD CONSTRAINT "withdrawal_requests_destination_fkey"
    FOREIGN KEY ("destination_id") REFERENCES "payout_destinations"("id") ON DELETE RESTRICT;
ALTER TABLE "withdrawal_requests"
    ADD CONSTRAINT "withdrawal_requests_hold_fkey"
    FOREIGN KEY ("hold_id") REFERENCES "credit_holds"("id") ON DELETE RESTRICT;
ALTER TABLE "withdrawal_requests"
    ADD CONSTRAINT "withdrawal_requests_reviewed_by_fkey"
    FOREIGN KEY ("reviewed_by_user_id") REFERENCES "users"("id") ON DELETE RESTRICT;
ALTER TABLE "withdrawal_requests"
    ADD CONSTRAINT "withdrawal_requests_approved_by_fkey"
    FOREIGN KEY ("approved_by_user_id") REFERENCES "users"("id") ON DELETE RESTRICT;
ALTER TABLE "withdrawal_requests"
    ADD CONSTRAINT "withdrawal_requests_rejected_by_fkey"
    FOREIGN KEY ("rejected_by_user_id") REFERENCES "users"("id") ON DELETE RESTRICT;
ALTER TABLE "withdrawal_requests"
    ADD CONSTRAINT "withdrawal_requests_cancelled_by_fkey"
    FOREIGN KEY ("cancelled_by_user_id") REFERENCES "users"("id") ON DELETE RESTRICT;
ALTER TABLE "withdrawal_requests"
    ADD CONSTRAINT "withdrawal_requests_executed_by_fkey"
    FOREIGN KEY ("executed_by_user_id") REFERENCES "users"("id") ON DELETE RESTRICT;

-- -----------------------------------------------------------------------------
-- 6. Reservations for organization and platform payouts
-- -----------------------------------------------------------------------------
CREATE TABLE "withdrawal_reservations" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "account_id" UUID NOT NULL,
    "request_id" UUID NOT NULL,
    "scope" "WithdrawalScope" NOT NULL,
    "organization_id" UUID,
    "currency" CHAR(3) NOT NULL,
    "amount_minor" BIGINT NOT NULL,
    "status" "WithdrawalReservationStatus" NOT NULL DEFAULT 'ACTIVE',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "consumed_at" TIMESTAMPTZ(6),
    "released_at" TIMESTAMPTZ(6),

    CONSTRAINT "withdrawal_reservations_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "withdrawal_reservations_request_key" UNIQUE ("request_id"),
    CONSTRAINT "withdrawal_reservations_scope_shape" CHECK (
        ("scope" = 'ORGANIZATION' AND "organization_id" IS NOT NULL)
        OR ("scope" = 'PLATFORM' AND "organization_id" IS NULL)),
    CONSTRAINT "withdrawal_reservations_amount_bounded" CHECK (
        "amount_minor" > 0 AND "amount_minor" <= 1000000000000000),
    CONSTRAINT "withdrawal_reservations_status_timestamps" CHECK (
        ("status" = 'ACTIVE' AND "consumed_at" IS NULL AND "released_at" IS NULL)
        OR ("status" = 'CONSUMED' AND "consumed_at" IS NOT NULL AND "released_at" IS NULL)
        OR ("status" = 'RELEASED' AND "released_at" IS NOT NULL AND "consumed_at" IS NULL))
);

CREATE INDEX "withdrawal_reservations_account_idx"
    ON "withdrawal_reservations"("account_id", "status");

ALTER TABLE "withdrawal_reservations"
    ADD CONSTRAINT "withdrawal_reservations_account_fkey"
    FOREIGN KEY ("account_id") REFERENCES "withdrawal_accounts"("id") ON DELETE RESTRICT;
ALTER TABLE "withdrawal_reservations"
    ADD CONSTRAINT "withdrawal_reservations_request_fkey"
    FOREIGN KEY ("request_id") REFERENCES "withdrawal_requests"("id") ON DELETE RESTRICT;

ALTER TABLE "withdrawal_requests"
    ADD CONSTRAINT "withdrawal_requests_reservation_fkey"
    FOREIGN KEY ("reservation_id") REFERENCES "withdrawal_reservations"("id") ON DELETE RESTRICT;

-- -----------------------------------------------------------------------------
-- 7. Settlements — the irreversible financial movement, exactly once
--
-- Written in the same transaction that marks a request PAID. The request id
-- and the deterministic idempotency key are both unique, so a double click, a
-- network retry or two finance users at once can produce one row and no more.
-- For a user it names the WITHDRAWAL_DEBIT ledger entry; for an organization
-- or PalCert it names the reservation it consumed. Append-only.
-- -----------------------------------------------------------------------------
CREATE TABLE "withdrawal_settlements" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "request_id" UUID NOT NULL,
    "scope" "WithdrawalScope" NOT NULL,
    "beneficiary_user_id" UUID,
    "organization_id" UUID,
    "currency" CHAR(3) NOT NULL,
    "amount_minor" BIGINT NOT NULL,
    "ledger_entry_id" UUID,
    "reservation_id" UUID,
    "idempotency_key" VARCHAR(200) NOT NULL,
    "external_transfer_reference" VARCHAR(120) NOT NULL,
    "settled_by_user_id" UUID NOT NULL,
    "settled_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "withdrawal_settlements_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "withdrawal_settlements_request_key" UNIQUE ("request_id"),
    CONSTRAINT "withdrawal_settlements_idempotency_key" UNIQUE ("idempotency_key"),
    CONSTRAINT "withdrawal_settlements_ledger_entry_key" UNIQUE ("ledger_entry_id"),
    CONSTRAINT "withdrawal_settlements_reservation_key" UNIQUE ("reservation_id"),
    CONSTRAINT "withdrawal_settlements_amount_bounded" CHECK (
        "amount_minor" > 0 AND "amount_minor" <= 1000000000000000),
    CONSTRAINT "withdrawal_settlements_idempotency_shape" CHECK (
        "idempotency_key" = 'withdrawal:' || "request_id"::text || ':settle'),
    CONSTRAINT "withdrawal_settlements_reference_present" CHECK (
        length(btrim("external_transfer_reference")) > 0),
    CONSTRAINT "withdrawal_settlements_scope_shape" CHECK (
        ("scope" = 'USER' AND "beneficiary_user_id" IS NOT NULL AND "organization_id" IS NULL
            AND "ledger_entry_id" IS NOT NULL AND "reservation_id" IS NULL)
        OR ("scope" = 'ORGANIZATION' AND "organization_id" IS NOT NULL
            AND "beneficiary_user_id" IS NULL
            AND "reservation_id" IS NOT NULL AND "ledger_entry_id" IS NULL)
        OR ("scope" = 'PLATFORM' AND "organization_id" IS NULL AND "beneficiary_user_id" IS NULL
            AND "reservation_id" IS NOT NULL AND "ledger_entry_id" IS NULL))
);

CREATE INDEX "withdrawal_settlements_org_idx"
    ON "withdrawal_settlements"("organization_id", "currency") WHERE "scope" = 'ORGANIZATION';
CREATE INDEX "withdrawal_settlements_platform_idx"
    ON "withdrawal_settlements"("currency") WHERE "scope" = 'PLATFORM';

ALTER TABLE "withdrawal_settlements"
    ADD CONSTRAINT "withdrawal_settlements_request_fkey"
    FOREIGN KEY ("request_id") REFERENCES "withdrawal_requests"("id") ON DELETE RESTRICT;
ALTER TABLE "withdrawal_settlements"
    ADD CONSTRAINT "withdrawal_settlements_ledger_entry_fkey"
    FOREIGN KEY ("ledger_entry_id") REFERENCES "credit_ledger_entries"("id") ON DELETE RESTRICT;
ALTER TABLE "withdrawal_settlements"
    ADD CONSTRAINT "withdrawal_settlements_reservation_fkey"
    FOREIGN KEY ("reservation_id") REFERENCES "withdrawal_reservations"("id") ON DELETE RESTRICT;
ALTER TABLE "withdrawal_settlements"
    ADD CONSTRAINT "withdrawal_settlements_settled_by_fkey"
    FOREIGN KEY ("settled_by_user_id") REFERENCES "users"("id") ON DELETE RESTRICT;

-- -----------------------------------------------------------------------------
-- 8. Execution attempts — one row per external transfer attempt
--
-- Append-only in effect: an attempt is opened IN_PROGRESS and closed once, as
-- SUCCEEDED or FAILED. A retry is a new attempt. Only one attempt per request
-- may be open at a time.
-- -----------------------------------------------------------------------------
CREATE TABLE "withdrawal_execution_attempts" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "request_id" UUID NOT NULL,
    "attempt_number" INTEGER NOT NULL,
    "outcome" "WithdrawalAttemptOutcome" NOT NULL DEFAULT 'IN_PROGRESS',
    "started_by_user_id" UUID NOT NULL,
    "started_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finished_by_user_id" UUID,
    "finished_at" TIMESTAMPTZ(6),
    "external_reference" VARCHAR(120),
    "note" VARCHAR(1000),

    CONSTRAINT "withdrawal_execution_attempts_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "withdrawal_execution_attempts_number_key" UNIQUE ("request_id", "attempt_number"),
    CONSTRAINT "withdrawal_execution_attempts_number_positive" CHECK ("attempt_number" >= 1),
    CONSTRAINT "withdrawal_execution_attempts_finished_shape" CHECK (
        ("outcome" = 'IN_PROGRESS') = ("finished_at" IS NULL)
        AND ("finished_at" IS NULL) = ("finished_by_user_id" IS NULL)),
    CONSTRAINT "withdrawal_execution_attempts_success_reference" CHECK (
        "outcome" <> 'SUCCEEDED' OR ("external_reference" IS NOT NULL
            AND length(btrim("external_reference")) > 0))
);

CREATE UNIQUE INDEX "withdrawal_execution_attempts_one_open"
    ON "withdrawal_execution_attempts"("request_id") WHERE "outcome" = 'IN_PROGRESS';

ALTER TABLE "withdrawal_execution_attempts"
    ADD CONSTRAINT "withdrawal_execution_attempts_request_fkey"
    FOREIGN KEY ("request_id") REFERENCES "withdrawal_requests"("id") ON DELETE RESTRICT;
ALTER TABLE "withdrawal_execution_attempts"
    ADD CONSTRAINT "withdrawal_execution_attempts_started_by_fkey"
    FOREIGN KEY ("started_by_user_id") REFERENCES "users"("id") ON DELETE RESTRICT;
ALTER TABLE "withdrawal_execution_attempts"
    ADD CONSTRAINT "withdrawal_execution_attempts_finished_by_fkey"
    FOREIGN KEY ("finished_by_user_id") REFERENCES "users"("id") ON DELETE RESTRICT;

-- -----------------------------------------------------------------------------
-- 9. History — append-only, and the source of every withdrawal notification
-- -----------------------------------------------------------------------------
CREATE TABLE "withdrawal_request_events" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "request_id" UUID NOT NULL,
    "requester_user_id" UUID NOT NULL,
    "organization_id" UUID,
    "event_type" "WithdrawalEventType" NOT NULL,
    "actor_side" "WithdrawalActorSide" NOT NULL,
    "actor_user_id" UUID,
    "note" VARCHAR(1000),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT clock_timestamp(),

    CONSTRAINT "withdrawal_request_events_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "withdrawal_request_events_side_matches_type" CHECK (
        ("actor_side" = 'REQUESTER' AND "event_type" IN
            ('CREATED', 'SUBMITTED', 'RESERVED', 'CANCELLED', 'RESERVATION_RELEASED'))
        OR ("actor_side" = 'FINANCE' AND "event_type" IN
            ('REVIEW_STARTED', 'APPROVED', 'REJECTED', 'CANCELLED', 'EXECUTION_STARTED',
             'PAID', 'FAILED', 'RETRY_STARTED', 'RESERVATION_RELEASED', 'PROOF_ATTACHED')))
);

CREATE INDEX "withdrawal_request_events_request_idx"
    ON "withdrawal_request_events"("request_id", "created_at", "id");

ALTER TABLE "withdrawal_request_events"
    ADD CONSTRAINT "withdrawal_request_events_request_fkey"
    FOREIGN KEY ("request_id") REFERENCES "withdrawal_requests"("id") ON DELETE RESTRICT;
ALTER TABLE "withdrawal_request_events"
    ADD CONSTRAINT "withdrawal_request_events_actor_fkey"
    FOREIGN KEY ("actor_user_id") REFERENCES "users"("id") ON DELETE SET NULL;

-- -----------------------------------------------------------------------------
-- 10. Payout proofs — an optional transfer receipt, private
--
-- The same secure ingestion as every other upload: a server-generated
-- quarantine key, finalize against the exact object version, signature
-- detection, malware scan, immutable promotion. Never public, never emailed.
-- -----------------------------------------------------------------------------
CREATE TABLE "withdrawal_proofs" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "request_id" UUID NOT NULL,
    "requester_user_id" UUID NOT NULL,
    "organization_id" UUID,
    "uploaded_by_user_id" UUID NOT NULL,
    "status" "ManualTopUpFileStatus" NOT NULL DEFAULT 'AWAITING_UPLOAD',

    "original_filename" TEXT NOT NULL,
    "declared_mime_type" TEXT,
    "expected_format" "ManualTopUpFileFormat" NOT NULL,
    "detected_format" "ManualTopUpFileFormat",
    "detected_mime_type" TEXT,

    "declared_size_bytes" INTEGER NOT NULL,
    "max_file_bytes" INTEGER NOT NULL,
    "size_bytes" INTEGER,
    "client_sha256" CHAR(64),
    "sha256" CHAR(64),

    "quarantine_object_key" TEXT NOT NULL,
    "quarantine_object_version_id" TEXT,
    "quarantine_object_etag" TEXT,
    "quarantine_deleted_at" TIMESTAMPTZ(6),

    "clean_object_key" TEXT,
    "clean_object_version_id" TEXT,
    "clean_object_etag" TEXT,

    "scan_engine" TEXT,
    "scan_signature" TEXT,
    "rejection_code" TEXT,
    "failure_code" TEXT,
    "failure_detail" TEXT,

    "idempotency_key" VARCHAR(200),
    "upload_expires_at" TIMESTAMPTZ(6) NOT NULL,

    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "uploaded_at" TIMESTAMPTZ(6),
    "validated_at" TIMESTAMPTZ(6),
    "scanned_at" TIMESTAMPTZ(6),
    "ready_at" TIMESTAMPTZ(6),
    "rejected_at" TIMESTAMPTZ(6),
    "failed_at" TIMESTAMPTZ(6),

    CONSTRAINT "withdrawal_proofs_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "withdrawal_proofs_clean_key" UNIQUE ("clean_object_key"),
    CONSTRAINT "withdrawal_proofs_sizes" CHECK (
        "declared_size_bytes" BETWEEN 1 AND 5242880
        AND "max_file_bytes" BETWEEN 1024 AND 5242880
        AND ("size_bytes" IS NULL OR "size_bytes" BETWEEN 1 AND 5242880)),
    CONSTRAINT "withdrawal_proofs_digest_shape" CHECK (
        ("sha256" IS NULL OR "sha256" ~ '^[0-9a-f]{64}$')
        AND ("client_sha256" IS NULL OR "client_sha256" ~ '^[0-9a-f]{64}$')),
    CONSTRAINT "withdrawal_proofs_ready_shape" CHECK (
        "status" <> 'READY' OR ("sha256" IS NOT NULL AND "size_bytes" IS NOT NULL
            AND "detected_format" IS NOT NULL AND "detected_mime_type" IS NOT NULL
            AND "clean_object_key" IS NOT NULL AND "ready_at" IS NOT NULL)),
    CONSTRAINT "withdrawal_proofs_filename" CHECK (length("original_filename") BETWEEN 1 AND 255)
);

CREATE UNIQUE INDEX "withdrawal_proofs_uploader_idempotency"
    ON "withdrawal_proofs"("uploaded_by_user_id", "idempotency_key");
CREATE INDEX "withdrawal_proofs_request_idx"
    ON "withdrawal_proofs"("request_id", "created_at");
CREATE INDEX "withdrawal_proofs_status_idx"
    ON "withdrawal_proofs"("status", "upload_expires_at");

ALTER TABLE "withdrawal_proofs"
    ADD CONSTRAINT "withdrawal_proofs_request_fkey"
    FOREIGN KEY ("request_id") REFERENCES "withdrawal_requests"("id") ON DELETE RESTRICT;
ALTER TABLE "withdrawal_proofs"
    ADD CONSTRAINT "withdrawal_proofs_uploaded_by_fkey"
    FOREIGN KEY ("uploaded_by_user_id") REFERENCES "users"("id") ON DELETE RESTRICT;

-- -----------------------------------------------------------------------------
-- 11. Reviewers — PalCert finance staff a withdrawal alert goes to
--
-- User ids only; an arbitrary address cannot be stored. Only an ACTIVE
-- holder of finance:withdrawal:review through a GLOBAL role can be assigned,
-- and authority is re-checked at fan-out and at send. An empty list, or a
-- list whose members all lost the permission, falls back to every global
-- holder of the permission — recorded, never silent.
-- -----------------------------------------------------------------------------
CREATE TABLE "withdrawal_reviewers" (
    "user_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by_user_id" UUID,

    CONSTRAINT "withdrawal_reviewers_pkey" PRIMARY KEY ("user_id")
);

ALTER TABLE "withdrawal_reviewers"
    ADD CONSTRAINT "withdrawal_reviewers_user_fkey"
    FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT;
ALTER TABLE "withdrawal_reviewers"
    ADD CONSTRAINT "withdrawal_reviewers_created_by_fkey"
    FOREIGN KEY ("created_by_user_id") REFERENCES "users"("id") ON DELETE SET NULL;

-- =============================================================================
-- 12. Integrity triggers
-- =============================================================================

-- A destination's owner and identity are fixed; archiving is permanent; every
-- edit advances the version it was made against.
CREATE OR REPLACE FUNCTION payout_destinations_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    IF NEW."id" IS DISTINCT FROM OLD."id"
       OR NEW."scope" IS DISTINCT FROM OLD."scope"
       OR NEW."owner_user_id" IS DISTINCT FROM OLD."owner_user_id"
       OR NEW."organization_id" IS DISTINCT FROM OLD."organization_id"
       OR NEW."created_at" IS DISTINCT FROM OLD."created_at"
       OR NEW."created_by_user_id" IS DISTINCT FROM OLD."created_by_user_id"
    THEN
        RAISE EXCEPTION 'payout_destination % identity is immutable', OLD."id";
    END IF;
    IF OLD."archived_at" IS NOT NULL THEN
        RAISE EXCEPTION 'payout_destination % is archived', OLD."id";
    END IF;
    IF NEW."version" <> OLD."version" + 1 THEN
        RAISE EXCEPTION 'payout_destination % must advance its version by one', OLD."id";
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER "payout_destinations_guard"
    BEFORE UPDATE ON "payout_destinations"
    FOR EACH ROW EXECUTE FUNCTION payout_destinations_guard();

-- The request state machine and everything that must not move.
CREATE OR REPLACE FUNCTION withdrawal_requests_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
    v_finance boolean := app_is_platform_admin();
BEGIN
    IF NEW."id" IS DISTINCT FROM OLD."id"
       OR NEW."scope" IS DISTINCT FROM OLD."scope"
       OR NEW."requester_user_id" IS DISTINCT FROM OLD."requester_user_id"
       OR NEW."beneficiary_user_id" IS DISTINCT FROM OLD."beneficiary_user_id"
       OR NEW."organization_id" IS DISTINCT FROM OLD."organization_id"
       OR NEW."currency" IS DISTINCT FROM OLD."currency"
       OR NEW."amount_minor" IS DISTINCT FROM OLD."amount_minor"
       OR NEW."destination_id" IS DISTINCT FROM OLD."destination_id"
       OR NEW."destination_snapshot" IS DISTINCT FROM OLD."destination_snapshot"
       OR NEW."destination_sealed_ciphertext" IS DISTINCT FROM OLD."destination_sealed_ciphertext"
       OR NEW."destination_sealed_iv" IS DISTINCT FROM OLD."destination_sealed_iv"
       OR NEW."destination_sealed_auth_tag" IS DISTINCT FROM OLD."destination_sealed_auth_tag"
       OR NEW."destination_sealed_kid" IS DISTINCT FROM OLD."destination_sealed_kid"
       OR NEW."requester_note" IS DISTINCT FROM OLD."requester_note"
       OR NEW."idempotency_key" IS DISTINCT FROM OLD."idempotency_key"
       OR NEW."created_at" IS DISTINCT FROM OLD."created_at"
    THEN
        RAISE EXCEPTION 'withdrawal_request % identity, amount and destination are immutable', OLD."id";
    END IF;

    IF OLD."status" IN ('PAID', 'REJECTED', 'CANCELLED') THEN
        RAISE EXCEPTION 'withdrawal_request % is % and final', OLD."id", OLD."status";
    END IF;

    IF NEW."version" <> OLD."version" + 1 THEN
        RAISE EXCEPTION 'withdrawal_request % must advance its version by one', OLD."id";
    END IF;

    -- The reservation and the pre-request availability are written once, at
    -- submission, and never replaced.
    IF (OLD."hold_id" IS NOT NULL AND NEW."hold_id" IS DISTINCT FROM OLD."hold_id")
       OR (OLD."reservation_id" IS NOT NULL AND NEW."reservation_id" IS DISTINCT FROM OLD."reservation_id")
       OR (OLD."available_before_minor" IS NOT NULL
           AND NEW."available_before_minor" IS DISTINCT FROM OLD."available_before_minor")
       OR (OLD."submitted_at" IS NOT NULL AND NEW."submitted_at" IS DISTINCT FROM OLD."submitted_at")
    THEN
        RAISE EXCEPTION 'withdrawal_request % reservation is written once', OLD."id";
    END IF;

    -- Review, approval, rejection and execution are recorded once each.
    IF (OLD."review_started_at" IS NOT NULL
            AND (NEW."review_started_at" IS DISTINCT FROM OLD."review_started_at"
                 OR NEW."reviewed_by_user_id" IS DISTINCT FROM OLD."reviewed_by_user_id"))
       OR (OLD."approved_at" IS NOT NULL
            AND (NEW."approved_at" IS DISTINCT FROM OLD."approved_at"
                 OR NEW."approved_by_user_id" IS DISTINCT FROM OLD."approved_by_user_id"))
    THEN
        RAISE EXCEPTION 'withdrawal_request % decision fields are written once', OLD."id";
    END IF;

    IF NEW."review_started_at" IS DISTINCT FROM OLD."review_started_at" AND NOT v_finance THEN
        RAISE EXCEPTION 'only PalCert finance reviews withdrawal_request %', OLD."id"
            USING ERRCODE = 'insufficient_privilege';
    END IF;

    IF NEW."status" IS DISTINCT FROM OLD."status" THEN
        IF OLD."status" = 'DRAFT' AND NEW."status" IN ('PENDING_REVIEW', 'CANCELLED') THEN
            NULL;
        ELSIF OLD."status" IN ('PENDING_REVIEW', 'APPROVED') AND NEW."status" = 'CANCELLED' THEN
            -- The requester withdraws before any external attempt, or finance
            -- releases an approved request it will not pay.
            NULL;
        ELSIF (OLD."status" = 'PENDING_REVIEW' AND NEW."status" IN ('APPROVED', 'REJECTED'))
           OR (OLD."status" = 'APPROVED' AND NEW."status" = 'PROCESSING')
           OR (OLD."status" = 'PROCESSING' AND NEW."status" IN ('PAID', 'FAILED'))
           OR (OLD."status" = 'FAILED' AND NEW."status" IN ('PROCESSING', 'CANCELLED'))
        THEN
            IF NOT v_finance THEN
                RAISE EXCEPTION 'only PalCert finance moves withdrawal_request % from % to %',
                    OLD."id", OLD."status", NEW."status"
                    USING ERRCODE = 'insufficient_privilege';
            END IF;
        ELSE
            RAISE EXCEPTION 'withdrawal_request % cannot move from % to %',
                OLD."id", OLD."status", NEW."status";
        END IF;
    END IF;

    -- A finance release from FAILED states its reason.
    IF NEW."status" = 'CANCELLED' AND OLD."status" = 'FAILED'
       AND (NEW."release_note" IS NULL OR length(btrim(NEW."release_note")) = 0)
    THEN
        RAISE EXCEPTION 'releasing failed withdrawal_request % requires a reason', OLD."id";
    END IF;

    -- The hold, once named, is exactly this request's hold.
    IF NEW."hold_id" IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM "credit_holds" h
         WHERE h."id" = NEW."hold_id"
           AND h."purpose" = 'WITHDRAWAL'
           AND h."owner_user_id" = NEW."requester_user_id"
           AND h."credit_class" = 'CASH'
           AND h."currency" = NEW."currency"
           AND h."amount_minor" = NEW."amount_minor"
           AND h."reference_type" = 'WITHDRAWAL_REQUEST'
           AND h."reference_id" = NEW."id")
    THEN
        RAISE EXCEPTION 'withdrawal_request % hold does not match the request', OLD."id";
    END IF;

    IF NEW."reservation_id" IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM "withdrawal_reservations" r
         WHERE r."id" = NEW."reservation_id"
           AND r."request_id" = NEW."id"
           AND r."scope" = NEW."scope"
           AND r."organization_id" IS NOT DISTINCT FROM NEW."organization_id"
           AND r."currency" = NEW."currency"
           AND r."amount_minor" = NEW."amount_minor")
    THEN
        RAISE EXCEPTION 'withdrawal_request % reservation does not match the request', OLD."id";
    END IF;

    -- PAID only with exactly one settlement for exactly this request.
    IF NEW."status" = 'PAID' AND NOT EXISTS (
        SELECT 1 FROM "withdrawal_settlements" s
         WHERE s."request_id" = NEW."id"
           AND s."amount_minor" = NEW."amount_minor"
           AND s."currency" = NEW."currency"
           AND s."external_transfer_reference" = NEW."external_transfer_reference")
    THEN
        RAISE EXCEPTION 'withdrawal_request % cannot be PAID without its settlement', OLD."id";
    END IF;

    RETURN NEW;
END;
$$;

CREATE TRIGGER "withdrawal_requests_guard"
    BEFORE UPDATE ON "withdrawal_requests"
    FOR EACH ROW EXECUTE FUNCTION withdrawal_requests_guard();

-- A request is born an empty DRAFT, against a live destination of its own
-- beneficiary.
CREATE OR REPLACE FUNCTION withdrawal_requests_insert_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    IF NEW."status" <> 'DRAFT' OR NEW."version" <> 1
       OR NEW."hold_id" IS NOT NULL OR NEW."reservation_id" IS NOT NULL
       OR NEW."submitted_at" IS NOT NULL OR NEW."review_started_at" IS NOT NULL
       OR NEW."approved_at" IS NOT NULL OR NEW."rejected_at" IS NOT NULL
       OR NEW."cancelled_at" IS NOT NULL OR NEW."executed_at" IS NOT NULL
    THEN
        RAISE EXCEPTION 'a withdrawal_request is created as an empty DRAFT';
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM "payout_destinations" d
         WHERE d."id" = NEW."destination_id"
           AND d."archived_at" IS NULL
           AND d."scope" = NEW."scope"
           AND (
               (NEW."scope" = 'USER' AND d."owner_user_id" = NEW."requester_user_id")
               OR (NEW."scope" = 'ORGANIZATION' AND d."organization_id" = NEW."organization_id")
               OR NEW."scope" = 'PLATFORM'))
    THEN
        RAISE EXCEPTION 'withdrawal destination is not a live destination of this beneficiary'
            USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER "withdrawal_requests_insert_guard"
    BEFORE INSERT ON "withdrawal_requests"
    FOR EACH ROW EXECUTE FUNCTION withdrawal_requests_insert_guard();

-- A reservation consumes or releases once, never changes its amount, and is
-- written only for a request of its own account.
CREATE OR REPLACE FUNCTION withdrawal_reservations_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    IF TG_OP = 'INSERT' THEN
        IF NEW."status" <> 'ACTIVE' THEN
            RAISE EXCEPTION 'a withdrawal_reservation is created ACTIVE';
        END IF;
        IF NOT EXISTS (
            SELECT 1 FROM "withdrawal_accounts" a
             WHERE a."id" = NEW."account_id"
               AND a."scope" = NEW."scope"
               AND a."organization_id" IS NOT DISTINCT FROM NEW."organization_id"
               AND a."currency" = NEW."currency")
           OR NOT EXISTS (
            SELECT 1 FROM "withdrawal_requests" r
             WHERE r."id" = NEW."request_id"
               AND r."scope" = NEW."scope"
               AND r."organization_id" IS NOT DISTINCT FROM NEW."organization_id"
               AND r."currency" = NEW."currency"
               AND r."amount_minor" = NEW."amount_minor")
        THEN
            RAISE EXCEPTION 'withdrawal_reservation does not match its account and request';
        END IF;
        RETURN NEW;
    END IF;

    IF NEW."id" IS DISTINCT FROM OLD."id"
       OR NEW."account_id" IS DISTINCT FROM OLD."account_id"
       OR NEW."request_id" IS DISTINCT FROM OLD."request_id"
       OR NEW."scope" IS DISTINCT FROM OLD."scope"
       OR NEW."organization_id" IS DISTINCT FROM OLD."organization_id"
       OR NEW."currency" IS DISTINCT FROM OLD."currency"
       OR NEW."amount_minor" IS DISTINCT FROM OLD."amount_minor"
       OR NEW."created_at" IS DISTINCT FROM OLD."created_at"
    THEN
        RAISE EXCEPTION 'withdrawal_reservation % identity and amount are immutable', OLD."id";
    END IF;
    IF OLD."status" <> 'ACTIVE' THEN
        RAISE EXCEPTION 'withdrawal_reservation % is % and final', OLD."id", OLD."status";
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER "withdrawal_reservations_guard"
    BEFORE INSERT OR UPDATE ON "withdrawal_reservations"
    FOR EACH ROW EXECUTE FUNCTION withdrawal_reservations_guard();

CREATE OR REPLACE FUNCTION withdrawal_reservations_no_delete() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    RAISE EXCEPTION 'withdrawal_reservations rows are never deleted';
END;
$$;

CREATE TRIGGER "withdrawal_reservations_no_delete"
    BEFORE DELETE ON "withdrawal_reservations"
    FOR EACH ROW EXECUTE FUNCTION withdrawal_reservations_no_delete();

-- A settlement is append-only and must be exactly its request's movement:
-- for a user, the WITHDRAWAL_DEBIT that captured the request's own hold; for
-- an organization or PalCert, the request's own reservation, now consumed.
CREATE OR REPLACE FUNCTION withdrawal_settlements_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
    req "withdrawal_requests"%ROWTYPE;
BEGIN
    IF TG_OP <> 'INSERT' THEN
        RAISE EXCEPTION 'withdrawal_settlements rows are immutable once written';
    END IF;

    SELECT * INTO req FROM "withdrawal_requests" WHERE "id" = NEW."request_id";
    IF NOT FOUND
       OR req."scope" <> NEW."scope"
       OR req."currency" <> NEW."currency"
       OR req."amount_minor" <> NEW."amount_minor"
       OR req."organization_id" IS DISTINCT FROM NEW."organization_id"
       OR req."beneficiary_user_id" IS DISTINCT FROM NEW."beneficiary_user_id"
       OR req."status" <> 'PROCESSING'
    THEN
        RAISE EXCEPTION 'withdrawal_settlement does not match a request being paid';
    END IF;

    IF NEW."scope" = 'USER' AND NOT EXISTS (
        SELECT 1 FROM "credit_ledger_entries" e
          JOIN "credit_holds" h ON h."captured_entry_id" = e."id"
         WHERE e."id" = NEW."ledger_entry_id"
           AND e."entry_type" = 'WITHDRAWAL_DEBIT'
           AND e."credit_class" = 'CASH'
           AND e."owner_user_id" = NEW."beneficiary_user_id"
           AND e."currency" = NEW."currency"
           AND e."amount_minor_signed" = -NEW."amount_minor"
           AND h."id" = req."hold_id"
           AND h."status" = 'CAPTURED')
    THEN
        RAISE EXCEPTION 'withdrawal_settlement ledger entry is not the capture of this request''s hold';
    END IF;

    IF NEW."scope" <> 'USER' AND NOT EXISTS (
        SELECT 1 FROM "withdrawal_reservations" r
         WHERE r."id" = NEW."reservation_id"
           AND r."id" = req."reservation_id"
           AND r."status" = 'CONSUMED'
           AND r."amount_minor" = NEW."amount_minor")
    THEN
        RAISE EXCEPTION 'withdrawal_settlement reservation is not this request''s consumed reservation';
    END IF;

    RETURN NEW;
END;
$$;

CREATE TRIGGER "withdrawal_settlements_guard"
    BEFORE INSERT OR UPDATE OR DELETE ON "withdrawal_settlements"
    FOR EACH ROW EXECUTE FUNCTION withdrawal_settlements_guard();

-- An attempt closes once; for PalCert's own money it is started by somebody
-- who neither asked for nor approved the payout.
CREATE OR REPLACE FUNCTION withdrawal_execution_attempts_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
    req "withdrawal_requests"%ROWTYPE;
BEGIN
    IF TG_OP = 'DELETE' THEN
        RAISE EXCEPTION 'withdrawal_execution_attempts rows are never deleted';
    END IF;

    IF TG_OP = 'INSERT' THEN
        IF NEW."outcome" <> 'IN_PROGRESS' THEN
            RAISE EXCEPTION 'a withdrawal_execution_attempt is opened IN_PROGRESS';
        END IF;
        SELECT * INTO req FROM "withdrawal_requests" WHERE "id" = NEW."request_id";
        IF NOT FOUND OR req."status" NOT IN ('APPROVED', 'FAILED') THEN
            RAISE EXCEPTION 'an execution attempt needs an approved or failed withdrawal';
        END IF;
        IF req."scope" = 'PLATFORM'
           AND (NEW."started_by_user_id" = req."requester_user_id"
                OR NEW."started_by_user_id" IS NOT DISTINCT FROM req."approved_by_user_id")
        THEN
            RAISE EXCEPTION 'a platform payout is executed by somebody other than its requester and approver'
                USING ERRCODE = 'check_violation';
        END IF;
        RETURN NEW;
    END IF;

    IF NEW."id" IS DISTINCT FROM OLD."id"
       OR NEW."request_id" IS DISTINCT FROM OLD."request_id"
       OR NEW."attempt_number" IS DISTINCT FROM OLD."attempt_number"
       OR NEW."started_by_user_id" IS DISTINCT FROM OLD."started_by_user_id"
       OR NEW."started_at" IS DISTINCT FROM OLD."started_at"
    THEN
        RAISE EXCEPTION 'withdrawal_execution_attempt % identity is immutable', OLD."id";
    END IF;
    IF OLD."outcome" <> 'IN_PROGRESS' THEN
        RAISE EXCEPTION 'withdrawal_execution_attempt % is % and final', OLD."id", OLD."outcome";
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER "withdrawal_execution_attempts_guard"
    BEFORE INSERT OR UPDATE OR DELETE ON "withdrawal_execution_attempts"
    FOR EACH ROW EXECUTE FUNCTION withdrawal_execution_attempts_guard();

-- A lock anchor holds no value and never changes; it exists to be locked.
CREATE OR REPLACE FUNCTION withdrawal_accounts_immutable() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    RAISE EXCEPTION 'withdrawal_accounts rows are immutable lock anchors';
END;
$$;

CREATE TRIGGER "withdrawal_accounts_immutable"
    BEFORE UPDATE OR DELETE ON "withdrawal_accounts"
    FOR EACH ROW EXECUTE FUNCTION withdrawal_accounts_immutable();

-- History is append-only, and each side writes only as itself.
CREATE OR REPLACE FUNCTION withdrawal_request_events_append_only() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    RAISE EXCEPTION 'withdrawal_request_events rows are immutable once written';
END;
$$;

CREATE TRIGGER "withdrawal_request_events_append_only"
    BEFORE UPDATE OR DELETE ON "withdrawal_request_events"
    FOR EACH ROW EXECUTE FUNCTION withdrawal_request_events_append_only();

CREATE OR REPLACE FUNCTION withdrawal_request_events_insert_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    IF NEW."actor_user_id" IS DISTINCT FROM app_current_user_id() THEN
        RAISE EXCEPTION 'withdrawal history is written by the acting person';
    END IF;
    IF NEW."actor_side" = 'FINANCE' AND NOT app_is_platform_admin() THEN
        RAISE EXCEPTION 'only PalCert finance writes FINANCE withdrawal history'
            USING ERRCODE = 'insufficient_privilege';
    END IF;
    IF NEW."actor_side" = 'REQUESTER' AND NEW."requester_user_id" IS DISTINCT FROM app_current_user_id() THEN
        RAISE EXCEPTION 'a requester writes history only about their own request';
    END IF;
    IF NOT EXISTS (
        SELECT 1 FROM "withdrawal_requests" r
         WHERE r."id" = NEW."request_id"
           AND r."requester_user_id" = NEW."requester_user_id"
           AND r."organization_id" IS NOT DISTINCT FROM NEW."organization_id")
    THEN
        RAISE EXCEPTION 'withdrawal history must name its request''s requester and organization';
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER "withdrawal_request_events_insert_guard"
    BEFORE INSERT ON "withdrawal_request_events"
    FOR EACH ROW EXECUTE FUNCTION withdrawal_request_events_insert_guard();

-- Uploaded proofs: the shared file guard (identity fixed, content frozen once
-- READY, terminal states final).
CREATE TRIGGER "withdrawal_proofs_guard"
    BEFORE UPDATE ON "withdrawal_proofs"
    FOR EACH ROW EXECUTE FUNCTION manual_topup_files_guard();

-- Only a GLOBAL holder of finance:withdrawal:review can be assigned.
CREATE OR REPLACE FUNCTION withdrawal_reviewers_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    IF NOT app_notification_is_platform_reviewer(NEW."user_id", 'finance:withdrawal:review') THEN
        RAISE EXCEPTION 'user % does not hold finance:withdrawal:review through a platform role',
            NEW."user_id"
            USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER "withdrawal_reviewers_guard"
    BEFORE INSERT ON "withdrawal_reviewers"
    FOR EACH ROW EXECUTE FUNCTION withdrawal_reviewers_guard();

-- =============================================================================
-- 13. The ledger and holds: one new debit, one new hold purpose, confined
--
-- The sign rule is replaced by the same rule with WITHDRAWAL_DEBIT added to
-- the negative side — strictly wider, so every existing entry satisfies it;
-- PostgreSQL re-checks them all when the constraint is added, inside this
-- transaction, so there is no moment without a sign rule.
-- =============================================================================
ALTER TABLE "credit_ledger_entries" DROP CONSTRAINT "ledger_entries_sign_matches_type";
ALTER TABLE "credit_ledger_entries"
    ADD CONSTRAINT "ledger_entries_sign_matches_type" CHECK (
        ("entry_type" IN ('TOP_UP_CREDIT', 'SERVICE_REFUND', 'PROMOTIONAL_CREDIT',
                          'ADMIN_CREDIT', 'CHARGEBACK_REVERSAL', 'MANUAL_TOPUP_CREDIT')
            AND "amount_minor_signed" > 0)
        OR ("entry_type" IN ('SERVICE_CHARGE', 'PAYMENT_REFUND_DEBIT', 'ADMIN_DEBIT',
                             'CHARGEBACK_DEBIT', 'WITHDRAWAL_DEBIT')
            AND "amount_minor_signed" < 0)
    );

-- A withdrawal debit is cash, is the capture of a hold, and carries the payout
-- reason; the payout reason is carried by nothing else. No existing entry has
-- either, so no existing entry can fail it.
ALTER TABLE "credit_ledger_entries"
    ADD CONSTRAINT "ledger_entries_withdrawal_shape" CHECK (
        ("entry_type" = 'WITHDRAWAL_DEBIT') = ("reason_code" IS NOT DISTINCT FROM 'WITHDRAWAL_PAID')
        AND ("entry_type" <> 'WITHDRAWAL_DEBIT' OR (
            "credit_class" = 'CASH'
            AND "reference_type" IS NOT DISTINCT FROM 'CREDIT_HOLD'
            AND "reference_id" IS NOT NULL))
    );

-- One payout debit per hold, whatever the application does.
CREATE UNIQUE INDEX "ledger_entries_one_withdrawal_debit"
    ON "credit_ledger_entries"("reference_id")
    WHERE "entry_type" = 'WITHDRAWAL_DEBIT';

-- A withdrawal hold reserves CASH only — never promotional credit — for one
-- named request, and has no deadline of its own: it stands until the request
-- is paid, rejected or cancelled. No existing hold has this purpose.
ALTER TABLE "credit_holds"
    ADD CONSTRAINT "credit_holds_withdrawal_shape" CHECK (
        "purpose" <> 'WITHDRAWAL' OR (
            "credit_class" = 'CASH'
            AND "reference_type" IS NOT DISTINCT FROM 'WITHDRAWAL_REQUEST'
            AND "reference_id" IS NOT NULL
            AND "expires_at" IS NULL)
    );

CREATE UNIQUE INDEX "credit_holds_one_per_withdrawal"
    ON "credit_holds"("reference_id")
    WHERE "purpose" = 'WITHDRAWAL';

-- =============================================================================
-- 14. Row-level security, privileges, classification
--
--   withdrawal_policy, withdrawal_currency_limits, withdrawal_reviewers  SYSTEM
--   payout_destinations, withdrawal_requests, withdrawal_reservations,
--   withdrawal_settlements, withdrawal_request_events, withdrawal_proofs,
--   withdrawal_accounts                                  scope-aware (below)
--   withdrawal_execution_attempts                                         SYSTEM
--
-- A user reaches only their own rows; an organization context reaches only
-- that organization's rows; PalCert finance reaches everything through the
-- audited platform elevation. The API additionally checks the permission for
-- every route — RLS is the boundary, not the authorization.
-- =============================================================================
ALTER TABLE "withdrawal_policy" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "withdrawal_policy" FORCE ROW LEVEL SECURITY;
CREATE POLICY "withdrawal_policy_read" ON "withdrawal_policy" FOR SELECT USING (true);
CREATE POLICY "withdrawal_policy_admin_write" ON "withdrawal_policy" FOR ALL
    USING (app_is_platform_admin()) WITH CHECK (app_is_platform_admin());

ALTER TABLE "withdrawal_currency_limits" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "withdrawal_currency_limits" FORCE ROW LEVEL SECURITY;
CREATE POLICY "withdrawal_currency_limits_read" ON "withdrawal_currency_limits" FOR SELECT USING (true);
CREATE POLICY "withdrawal_currency_limits_admin_write" ON "withdrawal_currency_limits" FOR ALL
    USING (app_is_platform_admin()) WITH CHECK (app_is_platform_admin());

ALTER TABLE "payout_destinations" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "payout_destinations" FORCE ROW LEVEL SECURITY;
CREATE POLICY "payout_destinations_scoped" ON "payout_destinations" FOR ALL
    USING (app_is_platform_admin()
        OR ("scope" = 'USER' AND "owner_user_id" = app_current_user_id())
        OR ("scope" = 'ORGANIZATION' AND "organization_id" = app_current_organization()))
    WITH CHECK (app_is_platform_admin()
        OR ("scope" = 'USER' AND "owner_user_id" = app_current_user_id())
        OR ("scope" = 'ORGANIZATION' AND "organization_id" = app_current_organization()));

ALTER TABLE "withdrawal_accounts" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "withdrawal_accounts" FORCE ROW LEVEL SECURITY;
CREATE POLICY "withdrawal_accounts_scoped" ON "withdrawal_accounts" FOR ALL
    USING (app_is_platform_admin()
        OR ("scope" = 'ORGANIZATION' AND "organization_id" = app_current_organization()))
    WITH CHECK (app_is_platform_admin()
        OR ("scope" = 'ORGANIZATION' AND "organization_id" = app_current_organization()));

ALTER TABLE "withdrawal_requests" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "withdrawal_requests" FORCE ROW LEVEL SECURITY;
CREATE POLICY "withdrawal_requests_scoped" ON "withdrawal_requests" FOR ALL
    USING (app_is_platform_admin()
        OR ("scope" = 'USER' AND "requester_user_id" = app_current_user_id())
        OR ("scope" = 'ORGANIZATION' AND "organization_id" = app_current_organization()))
    WITH CHECK (app_is_platform_admin()
        OR ("scope" = 'USER' AND "requester_user_id" = app_current_user_id())
        OR ("scope" = 'ORGANIZATION' AND "organization_id" = app_current_organization()));

ALTER TABLE "withdrawal_reservations" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "withdrawal_reservations" FORCE ROW LEVEL SECURITY;
CREATE POLICY "withdrawal_reservations_scoped" ON "withdrawal_reservations" FOR ALL
    USING (app_is_platform_admin()
        OR ("scope" = 'ORGANIZATION' AND "organization_id" = app_current_organization()))
    WITH CHECK (app_is_platform_admin()
        OR ("scope" = 'ORGANIZATION' AND "organization_id" = app_current_organization()));

ALTER TABLE "withdrawal_settlements" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "withdrawal_settlements" FORCE ROW LEVEL SECURITY;
CREATE POLICY "withdrawal_settlements_scoped" ON "withdrawal_settlements" FOR ALL
    USING (app_is_platform_admin()
        OR ("scope" = 'USER' AND "beneficiary_user_id" = app_current_user_id())
        OR ("scope" = 'ORGANIZATION' AND "organization_id" = app_current_organization()))
    WITH CHECK (app_is_platform_admin());

ALTER TABLE "withdrawal_execution_attempts" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "withdrawal_execution_attempts" FORCE ROW LEVEL SECURITY;
CREATE POLICY "withdrawal_execution_attempts_finance" ON "withdrawal_execution_attempts" FOR ALL
    USING (app_is_platform_admin()) WITH CHECK (app_is_platform_admin());

ALTER TABLE "withdrawal_request_events" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "withdrawal_request_events" FORCE ROW LEVEL SECURITY;
CREATE POLICY "withdrawal_request_events_scoped" ON "withdrawal_request_events" FOR ALL
    USING (app_is_platform_admin()
        OR ("organization_id" IS NULL AND "requester_user_id" = app_current_user_id())
        OR ("organization_id" IS NOT NULL AND "organization_id" = app_current_organization()))
    WITH CHECK (app_is_platform_admin()
        OR ("organization_id" IS NULL AND "requester_user_id" = app_current_user_id())
        OR ("organization_id" IS NOT NULL AND "organization_id" = app_current_organization()));

ALTER TABLE "withdrawal_proofs" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "withdrawal_proofs" FORCE ROW LEVEL SECURITY;
CREATE POLICY "withdrawal_proofs_scoped" ON "withdrawal_proofs" FOR ALL
    USING (app_is_platform_admin()
        OR ("organization_id" IS NULL AND "requester_user_id" = app_current_user_id())
        OR ("organization_id" IS NOT NULL AND "organization_id" = app_current_organization()))
    WITH CHECK (app_is_platform_admin());

ALTER TABLE "withdrawal_reviewers" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "withdrawal_reviewers" FORCE ROW LEVEL SECURITY;
CREATE POLICY "withdrawal_reviewers_admin" ON "withdrawal_reviewers" FOR ALL
    USING (app_is_platform_admin()) WITH CHECK (app_is_platform_admin());

-- Nothing financial is ever hard-deleted by the application, and history,
-- settlements and attempts are not even updatable by it except where the
-- triggers above allow exactly one transition.
GRANT SELECT, UPDATE ON "withdrawal_policy" TO "palcert_app";
REVOKE INSERT, DELETE, TRUNCATE ON "withdrawal_policy" FROM "palcert_app";
GRANT SELECT, INSERT, UPDATE, DELETE ON "withdrawal_currency_limits" TO "palcert_app";
REVOKE TRUNCATE ON "withdrawal_currency_limits" FROM "palcert_app";
GRANT SELECT, INSERT, UPDATE ON "payout_destinations" TO "palcert_app";
REVOKE DELETE, TRUNCATE ON "payout_destinations" FROM "palcert_app";
GRANT SELECT, INSERT ON "withdrawal_accounts" TO "palcert_app";
REVOKE UPDATE, DELETE, TRUNCATE ON "withdrawal_accounts" FROM "palcert_app";
-- A lock anchor is locked, never changed. PostgreSQL requires an UPDATE
-- privilege for SELECT ... FOR UPDATE, so one column is granted for that
-- purpose alone and a trigger refuses every actual update.
GRANT UPDATE ("created_at") ON "withdrawal_accounts" TO "palcert_app";
GRANT SELECT, INSERT, UPDATE ON "withdrawal_requests" TO "palcert_app";
REVOKE DELETE, TRUNCATE ON "withdrawal_requests" FROM "palcert_app";
GRANT SELECT, INSERT, UPDATE ON "withdrawal_reservations" TO "palcert_app";
REVOKE DELETE, TRUNCATE ON "withdrawal_reservations" FROM "palcert_app";
GRANT SELECT, INSERT ON "withdrawal_settlements" TO "palcert_app";
REVOKE UPDATE, DELETE, TRUNCATE ON "withdrawal_settlements" FROM "palcert_app";
GRANT SELECT, INSERT, UPDATE ON "withdrawal_execution_attempts" TO "palcert_app";
REVOKE DELETE, TRUNCATE ON "withdrawal_execution_attempts" FROM "palcert_app";
GRANT SELECT, INSERT ON "withdrawal_request_events" TO "palcert_app";
REVOKE UPDATE, DELETE, TRUNCATE ON "withdrawal_request_events" FROM "palcert_app";
GRANT SELECT, INSERT, UPDATE ON "withdrawal_proofs" TO "palcert_app";
REVOKE DELETE, TRUNCATE ON "withdrawal_proofs" FROM "palcert_app";
GRANT SELECT, INSERT, DELETE ON "withdrawal_reviewers" TO "palcert_app";
REVOKE UPDATE, TRUNCATE ON "withdrawal_reviewers" FROM "palcert_app";

INSERT INTO "table_isolation_classification" ("table_name", "classification", "tenant_column", "notes")
VALUES
    ('withdrawal_policy', 'SYSTEM', NULL,
     'Platform withdrawal clearing periods. One row, configured by PalCert administrators; readable by everyone signed in.'),
    ('withdrawal_currency_limits', 'SYSTEM', NULL,
     'Optional per-currency minimum and maximum for one withdrawal request. Configured by PalCert administrators.'),
    ('withdrawal_reviewers', 'SYSTEM', NULL,
     'PalCert finance staff assigned to receive withdrawal alerts. Only GLOBAL holders of finance:withdrawal:review may be assigned.'),
    ('withdrawal_execution_attempts', 'SYSTEM', NULL,
     'External transfer attempts recorded by PalCert finance. Platform elevation only.'),
    ('payout_destinations', 'SYSTEM', NULL,
     'Scope-aware payout destinations: a user''s own (owner_user_id), an organization''s (organization_id), or PalCert treasury. Details sealed with AES-256-GCM; never deleted.'),
    ('withdrawal_accounts', 'SYSTEM', NULL,
     'Lock anchors for organization (organization_id) and platform payouts. No balance is stored; availability is derived.'),
    ('withdrawal_requests', 'SYSTEM', NULL,
     'Scope-aware withdrawal requests: a user''s own (requester_user_id) or an organization''s (organization_id); platform requests are finance-only. Destination snapshot frozen at creation.'),
    ('withdrawal_reservations', 'SYSTEM', NULL,
     'Organization (organization_id) and platform payout reservations against derived entitlement. ACTIVE until consumed by a settlement or released.'),
    ('withdrawal_settlements', 'SYSTEM', NULL,
     'The one irreversible movement of a paid withdrawal. Unique per request and per idempotency key; append-only.'),
    ('withdrawal_request_events', 'SYSTEM', NULL,
     'Append-only withdrawal history; each side writes only as itself.'),
    ('withdrawal_proofs', 'SYSTEM', NULL,
     'Optional payout proof uploaded by finance. Private; never public, never emailed.')
ON CONFLICT ("table_name") DO UPDATE
    SET "classification" = EXCLUDED."classification",
        "tenant_column" = EXCLUDED."tenant_column",
        "notes" = EXCLUDED."notes";

-- =============================================================================
-- 15. Notifications — through the existing Phase 16 pipeline
--
-- A withdrawal's notifications go to its requester and to PalCert finance,
-- never to an organization's audience, so — like manual top-ups — their
-- events and copies carry no organization. The constraints that say "these
-- types and only these have no organization" are widened by exactly the new
-- types; every existing row has an older type and an organization, or a
-- manual top-up type and none, and still passes.
-- =============================================================================
ALTER TABLE "domain_events" DROP CONSTRAINT "domain_events_organization_scope";
ALTER TABLE "domain_events" ADD CONSTRAINT "domain_events_organization_scope" CHECK (
    ("organization_id" IS NULL) =
        ("event_type" IN ('MANUAL_TOPUP_SUBMITTED', 'MANUAL_TOPUP_APPROVED', 'MANUAL_TOPUP_REJECTED',
                          'WITHDRAWAL_PENDING_REVIEW', 'WITHDRAWAL_SUBMITTED', 'WITHDRAWAL_APPROVED',
                          'WITHDRAWAL_REJECTED', 'WITHDRAWAL_PAID', 'WITHDRAWAL_FAILED'))
);

ALTER TABLE "user_notifications" DROP CONSTRAINT "user_notifications_organization_scope";
ALTER TABLE "user_notifications" ADD CONSTRAINT "user_notifications_organization_scope" CHECK (
    ("organization_id" IS NULL) =
        ("notification_type" IN ('MANUAL_TOPUP_SUBMITTED', 'MANUAL_TOPUP_APPROVED', 'MANUAL_TOPUP_REJECTED',
                                 'WITHDRAWAL_PENDING_REVIEW', 'WITHDRAWAL_SUBMITTED', 'WITHDRAWAL_APPROVED',
                                 'WITHDRAWAL_REJECTED', 'WITHDRAWAL_PAID', 'WITHDRAWAL_FAILED'))
);

ALTER TABLE "domain_events" DROP CONSTRAINT "domain_events_source_matches_type";
ALTER TABLE "domain_events" ADD CONSTRAINT "domain_events_source_matches_type" CHECK (
    ("source_type" = 'SUBMISSION_REVISION' AND "event_type" IN
        ('SUBMISSION_READY', 'SUBMISSION_REVISION_READY'))
    OR ("source_type" = 'SUBMISSION_DECISION_EVENT' AND "event_type" IN
        ('SUBMISSION_UNDER_REVIEW', 'SUBMISSION_APPROVED',
         'SUBMISSION_REJECTED', 'SUBMISSION_REVISION_REQUESTED'))
    OR ("source_type" = 'SUBMISSION_COMMENT' AND "event_type" = 'SUBMISSION_COMMENT_ADDED')
    OR ("source_type" = 'CERTIFICATE_EVENT' AND "event_type" IN
        ('CERTIFICATE_ISSUED', 'CERTIFICATE_REVOKED'))
    OR ("source_type" = 'ATTESTATION_REQUEST_EVENT' AND "event_type" IN
        ('ATTESTATION_SUBMITTED', 'ATTESTATION_READY_FOR_REVIEW',
         'ATTESTATION_INFORMATION_REQUESTED', 'ATTESTATION_INFORMATION_PROVIDED',
         'ATTESTATION_APPROVED', 'ATTESTATION_REJECTED', 'ATTESTATION_REVOKED'))
    OR ("source_type" = 'ATTESTATION_REMINDER' AND "event_type" IN
        ('ATTESTATION_EXPIRING', 'ATTESTATION_EXPIRED'))
    OR ("source_type" = 'MANUAL_TOPUP_REQUEST_EVENT' AND "event_type" IN
        ('MANUAL_TOPUP_SUBMITTED', 'MANUAL_TOPUP_APPROVED', 'MANUAL_TOPUP_REJECTED'))
    OR ("source_type" = 'WITHDRAWAL_REQUEST_EVENT' AND "event_type" IN
        ('WITHDRAWAL_PENDING_REVIEW', 'WITHDRAWAL_SUBMITTED', 'WITHDRAWAL_APPROVED',
         'WITHDRAWAL_REJECTED', 'WITHDRAWAL_PAID', 'WITHDRAWAL_FAILED'))
);

ALTER TABLE "domain_events" DROP CONSTRAINT "domain_events_aggregate_matches_type";
ALTER TABLE "domain_events" ADD CONSTRAINT "domain_events_aggregate_matches_type" CHECK (
    ("event_type" IN ('CERTIFICATE_ISSUED', 'CERTIFICATE_REVOKED')
        AND "aggregate_type" = 'COMPLIANCE_CERTIFICATE')
    OR ("event_type"::text LIKE 'ATTESTATION\_%' AND "aggregate_type" = 'ATTESTATION_REQUEST')
    OR ("event_type"::text LIKE 'MANUAL\_TOPUP\_%' AND "aggregate_type" = 'MANUAL_TOPUP_REQUEST')
    OR ("event_type"::text LIKE 'WITHDRAWAL\_%' AND "aggregate_type" = 'WITHDRAWAL_REQUEST')
    OR ("event_type" NOT IN ('CERTIFICATE_ISSUED', 'CERTIFICATE_REVOKED')
        AND "event_type"::text NOT LIKE 'ATTESTATION\_%'
        AND "event_type"::text NOT LIKE 'MANUAL\_TOPUP\_%'
        AND "event_type"::text NOT LIKE 'WITHDRAWAL\_%'
        AND "aggregate_type" = 'OFFICIAL_SUBMISSION')
);

-- The audience rule, one place. Every earlier branch is unchanged.
CREATE OR REPLACE FUNCTION app_notification_audience(p_event_type "NotificationType")
RETURNS text
LANGUAGE sql IMMUTABLE AS $$
    SELECT CASE
        WHEN p_event_type IN ('SUBMISSION_READY', 'SUBMISSION_REVISION_READY')
            THEN 'ORGANIZATION_REVIEWERS'
        WHEN p_event_type IN ('CERTIFICATE_ISSUED', 'CERTIFICATE_REVOKED')
            THEN 'CERTIFICATE_OWNER'
        WHEN p_event_type IN ('ATTESTATION_READY_FOR_REVIEW', 'ATTESTATION_INFORMATION_PROVIDED')
            THEN 'ATTESTATION_REVIEWERS'
        WHEN p_event_type::text LIKE 'ATTESTATION\_%'
            THEN 'ATTESTATION_OWNER'
        WHEN p_event_type = 'MANUAL_TOPUP_SUBMITTED'
            THEN 'PLATFORM_FINANCE_REVIEWERS'
        WHEN p_event_type IN ('MANUAL_TOPUP_APPROVED', 'MANUAL_TOPUP_REJECTED')
            THEN 'MANUAL_TOPUP_OWNER'
        WHEN p_event_type = 'WITHDRAWAL_PENDING_REVIEW'
            THEN 'WITHDRAWAL_FINANCE_REVIEWERS'
        WHEN p_event_type::text LIKE 'WITHDRAWAL\_%'
            THEN 'WITHDRAWAL_OWNER'
        ELSE 'SUBMISSION_OWNER'
    END;
$$;

CREATE OR REPLACE FUNCTION app_notification_reviewer_permission(p_audience text)
RETURNS text
LANGUAGE sql IMMUTABLE AS $$
    SELECT CASE p_audience
        WHEN 'ORGANIZATION_REVIEWERS' THEN 'submission:review:read'
        WHEN 'ATTESTATION_REVIEWERS' THEN 'attestation:request:review'
        WHEN 'PLATFORM_FINANCE_REVIEWERS' THEN 'finance:manual-topup:review'
        WHEN 'WITHDRAWAL_FINANCE_REVIEWERS' THEN 'finance:withdrawal:review'
        ELSE NULL
    END;
$$;

CREATE OR REPLACE FUNCTION app_notification_is_platform_audience(p_audience text)
RETURNS boolean
LANGUAGE sql IMMUTABLE AS $$
    SELECT p_audience IN ('PLATFORM_FINANCE_REVIEWERS', 'WITHDRAWAL_FINANCE_REVIEWERS');
$$;

-- How a withdrawal alert's reviewers are chosen, and how many there are:
--   ASSIGNED_REVIEWERS      assigned reviewers who still qualify exist
--   FALLBACK_NO_ELIGIBLE    reviewers are assigned, none still qualifies: the
--                           global audience is used, and the fan-out records it
--   GLOBAL_NOT_CONFIGURED   nobody is assigned: every global holder
CREATE OR REPLACE FUNCTION app_withdrawal_reviewer_routing(p_event_id uuid)
RETURNS TABLE (
    "routing" text,
    "configured_count" integer,
    "eligible_count" integer,
    "global_count" integer
)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE
    v_configured integer;
    v_eligible integer;
    v_global integer;
BEGIN
    IF NOT app_is_notification_fanout_context() THEN
        RAISE EXCEPTION 'resolving notification recipients is system work'
            USING ERRCODE = 'insufficient_privilege';
    END IF;

    SELECT count(*)::integer,
           count(*) FILTER (WHERE app_notification_is_platform_reviewer(
               wr."user_id", 'finance:withdrawal:review'))::integer
      INTO v_configured, v_eligible
      FROM "withdrawal_reviewers" wr;

    SELECT count(DISTINCT ur."user_id")::integer INTO v_global
      FROM "user_roles" ur
      JOIN "role_permissions" rp ON rp."role_id" = ur."role_id"
      JOIN "permissions" perm
        ON perm."id" = rp."permission_id" AND perm."code" = 'finance:withdrawal:review'
      JOIN "users" u ON u."id" = ur."user_id"
     WHERE ur."scope" = 'GLOBAL' AND ur."organization_id" IS NULL AND u."status" = 'ACTIVE';

    RETURN QUERY SELECT
        CASE
            WHEN v_eligible > 0 THEN 'ASSIGNED_REVIEWERS'
            WHEN v_configured > 0 THEN 'FALLBACK_NO_ELIGIBLE'
            ELSE 'GLOBAL_NOT_CONFIGURED'
        END,
        v_configured, v_eligible, v_global;
END;
$$;

-- The reviewer resolver. Organization audiences and the manual top-up
-- audience are resolved exactly as before. The withdrawal audience prefers
-- the assigned withdrawal reviewers who still qualify, and otherwise resolves
-- from every GLOBAL holder of finance:withdrawal:review.
CREATE OR REPLACE FUNCTION app_notification_submission_reviewers(
    p_event_id uuid,
    p_limit integer DEFAULT 100,
    p_after uuid DEFAULT NULL
) RETURNS TABLE ("user_id" uuid)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE
    event_row "domain_events"%ROWTYPE;
    v_limit integer;
    v_audience text;
    v_permission text;
    v_method uuid;
BEGIN
    IF NOT app_is_notification_fanout_context() THEN
        RAISE EXCEPTION 'resolving notification recipients is system work'
            USING ERRCODE = 'insufficient_privilege';
    END IF;

    SELECT * INTO event_row FROM "domain_events" WHERE "id" = p_event_id;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'domain_event % does not exist', p_event_id;
    END IF;

    v_audience := app_notification_audience(event_row."event_type");
    v_permission := app_notification_reviewer_permission(v_audience);
    IF v_permission IS NULL THEN
        RAISE EXCEPTION 'domain_event % is not a reviewer-audience event', p_event_id
            USING ERRCODE = 'check_violation';
    END IF;

    v_limit := LEAST(GREATEST(COALESCE(p_limit, 100), 1), 500);

    IF app_notification_is_platform_audience(v_audience) THEN
        IF event_row."organization_id" IS NOT NULL THEN
            RAISE EXCEPTION 'domain_event % names an organization but is platform-scoped', p_event_id
                USING ERRCODE = 'check_violation';
        END IF;

        IF v_audience = 'WITHDRAWAL_FINANCE_REVIEWERS' THEN
            IF EXISTS (
                SELECT 1 FROM "withdrawal_reviewers" wr
                 WHERE app_notification_is_platform_reviewer(wr."user_id", v_permission))
            THEN
                RETURN QUERY
                SELECT wr."user_id"
                  FROM "withdrawal_reviewers" wr
                 WHERE app_notification_is_platform_reviewer(wr."user_id", v_permission)
                   AND (p_after IS NULL OR wr."user_id" > p_after)
                 ORDER BY wr."user_id"
                 LIMIT v_limit;
                RETURN;
            END IF;
        ELSE
            v_method := app_manual_topup_event_method(p_event_id);
            IF v_method IS NOT NULL AND EXISTS (
                SELECT 1 FROM "manual_payment_method_reviewers" mr
                 WHERE mr."payment_method_id" = v_method
                   AND app_notification_is_platform_reviewer(mr."user_id", v_permission))
            THEN
                RETURN QUERY
                SELECT mr."user_id"
                  FROM "manual_payment_method_reviewers" mr
                 WHERE mr."payment_method_id" = v_method
                   AND app_notification_is_platform_reviewer(mr."user_id", v_permission)
                   AND (p_after IS NULL OR mr."user_id" > p_after)
                 ORDER BY mr."user_id"
                 LIMIT v_limit;
                RETURN;
            END IF;
        END IF;

        RETURN QUERY
        SELECT DISTINCT ur."user_id"
          FROM "user_roles" ur
          JOIN "role_permissions" rp ON rp."role_id" = ur."role_id"
          JOIN "permissions" perm
            ON perm."id" = rp."permission_id" AND perm."code" = v_permission
          JOIN "users" u ON u."id" = ur."user_id"
         WHERE ur."scope" = 'GLOBAL'
           AND ur."organization_id" IS NULL
           AND u."status" = 'ACTIVE'
           AND (p_after IS NULL OR ur."user_id" > p_after)
         ORDER BY ur."user_id"
         LIMIT v_limit;
        RETURN;
    END IF;

    RETURN QUERY
    SELECT DISTINCT m."user_id"
      FROM "organization_memberships" m
      JOIN "user_roles" ur
        ON ur."user_id" = m."user_id" AND ur."organization_id" = m."organization_id"
      JOIN "role_permissions" rp ON rp."role_id" = ur."role_id"
      JOIN "permissions" perm
        ON perm."id" = rp."permission_id" AND perm."code" = v_permission
      JOIN "users" u ON u."id" = m."user_id"
     WHERE m."organization_id" = event_row."organization_id"
       AND m."status" = 'ACTIVE'
       AND u."status" = 'ACTIVE'
       AND (p_after IS NULL OR m."user_id" > p_after)
     ORDER BY m."user_id"
     LIMIT v_limit;
END;
$$;

-- Emitting from one withdrawal history row. The notification types are
-- derived from the row; a caller cannot ask for one the row did not produce.
-- A submission produces two: finance's alert and the requester's receipt.
-- Only the requester (for their own request) or PalCert's elevated finance
-- path can emit, and the events carry no organization.
CREATE OR REPLACE FUNCTION app_domain_event_emit_withdrawal(p_request_event_id uuid)
RETURNS uuid[]
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
    history "withdrawal_request_events"%ROWTYPE;
    v_types "NotificationType"[];
    v_type "NotificationType";
    v_id uuid;
    v_ids uuid[] := ARRAY[]::uuid[];
BEGIN
    SELECT * INTO history FROM "withdrawal_request_events" WHERE "id" = p_request_event_id;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'withdrawal_request_event % does not exist', p_request_event_id;
    END IF;

    IF NOT COALESCE(
        app_is_platform_admin()
        OR (app_current_user_id() IS NOT NULL AND history."requester_user_id" = app_current_user_id()),
        false)
    THEN
        RAISE EXCEPTION 'withdrawal_request_event % is not the caller''s to report', p_request_event_id
            USING ERRCODE = 'insufficient_privilege';
    END IF;

    v_types := CASE history."event_type"
        WHEN 'SUBMITTED' THEN ARRAY['WITHDRAWAL_PENDING_REVIEW', 'WITHDRAWAL_SUBMITTED']::"NotificationType"[]
        WHEN 'APPROVED' THEN ARRAY['WITHDRAWAL_APPROVED']::"NotificationType"[]
        WHEN 'REJECTED' THEN ARRAY['WITHDRAWAL_REJECTED']::"NotificationType"[]
        WHEN 'PAID' THEN ARRAY['WITHDRAWAL_PAID']::"NotificationType"[]
        WHEN 'FAILED' THEN ARRAY['WITHDRAWAL_FAILED']::"NotificationType"[]
        ELSE ARRAY[]::"NotificationType"[]
    END;

    FOREACH v_type IN ARRAY v_types LOOP
        v_id := NULL;
        INSERT INTO "domain_events" (
            "id", "event_type", "event_schema_version", "source_type", "source_id",
            "aggregate_type", "aggregate_id", "owner_user_id", "organization_id",
            "occurred_at", "payload", "webhook_eligible"
        ) VALUES (
            gen_random_uuid(), v_type, 1, 'WITHDRAWAL_REQUEST_EVENT', history."id",
            'WITHDRAWAL_REQUEST', history."request_id",
            history."requester_user_id", NULL,
            history."created_at",
            jsonb_build_object('withdrawalRequestId', history."request_id"),
            false
        )
        ON CONFLICT ("source_type", "source_id", "event_type") DO NOTHING
        RETURNING "id" INTO v_id;

        IF v_id IS NULL THEN
            SELECT "id" INTO v_id FROM "domain_events"
             WHERE "source_type" = 'WITHDRAWAL_REQUEST_EVENT'
               AND "source_id" = history."id"
               AND "event_type" = v_type;
        END IF;
        v_ids := v_ids || v_id;
    END LOOP;

    RETURN v_ids;
END;
$$;

-- The typed facts a withdrawal notification may show: amount, currency,
-- scope, beneficiary name, organization name, the requester's name and
-- address (masked by the application before use), the reference and, for a
-- rejection, the reason code. Never a destination — no IBAN, account, wallet
-- number or instruction — and never a proof. Only to the fan-out system path
-- or the notification's own recipient.
CREATE OR REPLACE FUNCTION app_withdrawal_notification_facts(
    p_event_id uuid, p_recipient_user_id uuid
) RETURNS TABLE (
    "request_id" uuid,
    "scope" text,
    "amount_minor" bigint,
    "currency" text,
    "beneficiary_name" text,
    "organization_id" uuid,
    "organization_name" text,
    "requester_name" text,
    "requester_email" text,
    "rejection_reason" text,
    "submitted_at" timestamptz
)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE
    event_row "domain_events"%ROWTYPE;
BEGIN
    SELECT * INTO event_row FROM "domain_events" WHERE "id" = p_event_id;
    IF NOT FOUND OR event_row."aggregate_type" <> 'WITHDRAWAL_REQUEST' THEN
        RETURN;
    END IF;

    IF NOT app_is_notification_fanout_context() THEN
        IF app_current_user_id() IS NULL
           OR app_current_user_id() <> p_recipient_user_id
           OR NOT EXISTS (
                SELECT 1 FROM "user_notifications" n
                 WHERE n."source_event_id" = p_event_id
                   AND n."recipient_user_id" = p_recipient_user_id)
        THEN
            RAISE EXCEPTION 'withdrawal notification facts are for their recipient'
                USING ERRCODE = 'insufficient_privilege';
        END IF;
    END IF;

    RETURN QUERY
    SELECT r."id",
           r."scope"::text,
           r."amount_minor",
           r."currency"::text,
           r."destination_snapshot"->>'beneficiaryName',
           r."organization_id",
           o."display_name"::text,
           u."display_name"::text,
           u."email"::text,
           r."rejection_reason"::text,
           r."submitted_at"
      FROM "withdrawal_requests" r
      JOIN "users" u ON u."id" = r."requester_user_id"
      LEFT JOIN "organizations" o ON o."id" = r."organization_id"
     WHERE r."id" = event_row."aggregate_id";
END;
$$;

-- "No email arrived": the delivery report behind the admin diagnostics panel.
-- Statuses and routing only — never a title, a body, a link or a secret.
CREATE OR REPLACE FUNCTION app_withdrawal_notification_report(p_request_id uuid)
RETURNS TABLE (
    "recipient_user_id" uuid,
    "display_name" text,
    "email" text,
    "email_verified" boolean,
    "notification_type" text,
    "notified_at" timestamptz,
    "in_app_status" text,
    "email_status" text,
    "email_skip_reason" text,
    "email_attempts" integer
)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
BEGIN
    IF NOT app_is_platform_admin() THEN
        RAISE EXCEPTION 'the withdrawal notification report is for PalCert staff'
            USING ERRCODE = 'insufficient_privilege';
    END IF;

    RETURN QUERY
    SELECT n."recipient_user_id",
           u."display_name"::text,
           u."email"::text,
           (u."email_verified_at" IS NOT NULL),
           n."notification_type"::text,
           n."created_at",
           ia."status"::text,
           em."status"::text,
           em."skip_reason"::text,
           em."attempt_count"
      FROM "domain_events" e
      JOIN "user_notifications" n ON n."source_event_id" = e."id"
      JOIN "users" u ON u."id" = n."recipient_user_id"
      LEFT JOIN "notification_deliveries" ia
        ON ia."notification_id" = n."id" AND ia."channel" = 'IN_APP'
      LEFT JOIN "notification_deliveries" em
        ON em."notification_id" = n."id" AND em."channel" = 'EMAIL'
     WHERE e."aggregate_type" = 'WITHDRAWAL_REQUEST'
       AND e."aggregate_id" = p_request_id
     ORDER BY n."created_at", n."recipient_user_id";
END;
$$;

-- =============================================================================
-- 16. Durable jobs
--
-- A payout proof's scan is filed under the finance user who uploaded it, the
-- existing "owner, no organization" branch, so only the vocabulary widens.
-- =============================================================================
ALTER TABLE "processing_jobs" DROP CONSTRAINT "processing_jobs_resource_type_known";
ALTER TABLE "processing_jobs"
    ADD CONSTRAINT "processing_jobs_resource_type_known"
    CHECK ("resource_type" IN (
        'DOCUMENT_VERSION', 'DOCUMENT', 'DOCUMENT_ANALYSIS', 'DOCUMENT_CHECK', 'CHECK_RUN', 'AI_REVIEW',
        'STANDARD_SOURCE_ASSET', 'RULE_EXTRACTION_RUN',
        'PAYMENT_PROVIDER_EVENT', 'PAYMENT_RECONCILIATION',
        'SMARTFIX_REQUEST', 'SUBMISSION_REVISION', 'COMPLIANCE_CERTIFICATE',
        'DOMAIN_EVENT', 'NOTIFICATION_DELIVERY',
        'WEBHOOK_DELIVERY', 'WEBHOOK_VERIFICATION_OPERATION',
        'ATTESTATION_ARTIFACT', 'ATTESTATION_REQUEST',
        'MANUAL_TOPUP_RECEIPT', 'MANUAL_PAYMENT_METHOD_LOGO',
        'WITHDRAWAL_PROOF'));

-- =============================================================================
-- 17. Permissions
--
-- Viewing, reviewing, approving and executing are separate. PALCERT_FINANCE
-- holds them all and may request a platform payout; the service and the
-- constraints above still stop anyone approving their own request, and stop
-- one person requesting, approving and executing PalCert's own payout.
-- PALCERT_ADMIN configures policy and reviewers and reads the queue; it
-- approves nothing. Only an organization's owner requests its payouts.
-- =============================================================================
INSERT INTO "permissions" ("id", "code", "description") VALUES
    (gen_random_uuid(), 'balance:withdraw:self',
     'Request a payout of your own eligible real money and manage your own payout destinations'),
    (gen_random_uuid(), 'finance:withdrawal:read',
     'Read every withdrawal request, its history and its masked destination'),
    (gen_random_uuid(), 'finance:withdrawal:review',
     'Open a withdrawal for review, read its full destination and receive withdrawal alerts'),
    (gen_random_uuid(), 'finance:withdrawal:approve',
     'Approve or reject a withdrawal request (never one''s own)'),
    (gen_random_uuid(), 'finance:withdrawal:execute',
     'Record the external transfer of an approved withdrawal: start, mark paid, mark failed, retry, release'),
    (gen_random_uuid(), 'finance:platform-withdrawal:request',
     'Request a payout of PalCert''s own realized platform revenue'),
    (gen_random_uuid(), 'finance:payout-destination:read',
     'Read PalCert treasury payout destinations (masked)'),
    (gen_random_uuid(), 'finance:payout-destination:manage',
     'Create, edit and archive PalCert treasury payout destinations'),
    (gen_random_uuid(), 'admin:withdrawal-policy:manage',
     'Configure withdrawal clearing periods, per-currency limits and withdrawal reviewers'),
    (gen_random_uuid(), 'organization:withdrawal:read',
     'Read the organization''s earnings, payout availability and payout history'),
    (gen_random_uuid(), 'organization:withdrawal:request',
     'Request a payout of the organization''s settled net earnings'),
    (gen_random_uuid(), 'organization:payout-destination:read',
     'Read the organization''s payout destinations (masked)'),
    (gen_random_uuid(), 'organization:payout-destination:manage',
     'Create, edit and archive the organization''s payout destinations')
ON CONFLICT ("code") DO NOTHING;

INSERT INTO "role_permissions" ("role_id", "permission_id")
SELECT r."id", p."id"
FROM "roles" r CROSS JOIN "permissions" p
WHERE (r."code" IN ('STUDENT', 'SERVICE_USER', 'PALCERT_ADMIN', 'PALCERT_FINANCE',
                    'PALCERT_SUPPORT', 'PALCERT_AUDITOR')
        AND p."code" = 'balance:withdraw:self')
   OR (r."code" = 'PALCERT_ADMIN' AND p."code" IN
        ('finance:withdrawal:read', 'admin:withdrawal-policy:manage'))
   OR (r."code" = 'PALCERT_FINANCE' AND p."code" IN
        ('finance:withdrawal:read', 'finance:withdrawal:review', 'finance:withdrawal:approve',
         'finance:withdrawal:execute', 'finance:platform-withdrawal:request',
         'finance:payout-destination:read', 'finance:payout-destination:manage'))
   OR (r."code" = 'PALCERT_AUDITOR' AND p."code" IN
        ('finance:withdrawal:read', 'finance:payout-destination:read'))
   OR (r."code" = 'ORGANIZATION_OWNER' AND p."code" IN
        ('organization:withdrawal:read', 'organization:withdrawal:request',
         'organization:payout-destination:read', 'organization:payout-destination:manage'))
   OR (r."code" = 'ORGANIZATION_ADMIN' AND p."code" IN
        ('organization:withdrawal:read', 'organization:payout-destination:read'))
ON CONFLICT ("role_id", "permission_id") DO NOTHING;

-- =============================================================================
-- 18. Function privileges
-- =============================================================================
REVOKE ALL ON FUNCTION payout_destinations_guard() FROM PUBLIC;
REVOKE ALL ON FUNCTION withdrawal_requests_guard() FROM PUBLIC;
REVOKE ALL ON FUNCTION withdrawal_requests_insert_guard() FROM PUBLIC;
REVOKE ALL ON FUNCTION withdrawal_reservations_guard() FROM PUBLIC;
REVOKE ALL ON FUNCTION withdrawal_reservations_no_delete() FROM PUBLIC;
REVOKE ALL ON FUNCTION withdrawal_settlements_guard() FROM PUBLIC;
REVOKE ALL ON FUNCTION withdrawal_execution_attempts_guard() FROM PUBLIC;
REVOKE ALL ON FUNCTION withdrawal_request_events_append_only() FROM PUBLIC;
REVOKE ALL ON FUNCTION withdrawal_request_events_insert_guard() FROM PUBLIC;
REVOKE ALL ON FUNCTION withdrawal_reviewers_guard() FROM PUBLIC;
REVOKE ALL ON FUNCTION app_withdrawal_reviewer_routing(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION app_domain_event_emit_withdrawal(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION app_withdrawal_notification_facts(uuid, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION app_withdrawal_notification_report(uuid) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION app_withdrawal_reviewer_routing(uuid) TO "palcert_app";
GRANT EXECUTE ON FUNCTION app_domain_event_emit_withdrawal(uuid) TO "palcert_app";
GRANT EXECUTE ON FUNCTION app_withdrawal_notification_facts(uuid, uuid) TO "palcert_app";
GRANT EXECUTE ON FUNCTION app_withdrawal_notification_report(uuid) TO "palcert_app";

COMMENT ON TABLE "withdrawal_requests" IS
    'One payout request at one scope (USER, ORGANIZATION, PLATFORM). Reserved at submission, settled exactly once in withdrawal_settlements when PAID. Destination snapshot frozen at creation.';
COMMENT ON COLUMN "withdrawal_requests"."destination_snapshot" IS
    'The masked description of the destination finance was told to pay, frozen at creation. The full details are the sealed columns beside it; editing the saved destination never changes either.';
COMMENT ON TABLE "withdrawal_accounts" IS
    'Lock anchors for organization and platform payouts. No amount is stored: availability is always derived from settlements, captured purchases and chargebacks minus payout reservations and settlements.';
