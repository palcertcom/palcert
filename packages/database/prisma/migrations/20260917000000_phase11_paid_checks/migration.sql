-- =============================================================================
-- Phase 11 — Paid PalCert Check Workflow
--
-- This migration makes a document check something a customer buys.
--
-- The shape of it is one new domain and one new column. A `service_purchase`
-- is a customer buying one deliverable service; `service_purchase_allocations`
-- record which credit classes funded it, because a $5 check paid with $2 of
-- promotional credit and $3 of cash is one purchase and two reservations. The
-- column is `document_checks.service_purchase_id`.
--
-- Three guarantees are installed here rather than in a service, because a
-- service can be bypassed and a trigger cannot:
--
--   1. **No new check without a purchase.** A trigger on INSERT requires the
--      binding and verifies it names this very check. Historical checks, which
--      genuinely predate paid checks, are untouched: the trigger fires on new
--      rows only, so they stay readable for ever while the free path cannot
--      come back (§4, §21, §121).
--
--   2. **The money and the service settle together.** Deferred constraint
--      triggers check, at COMMIT, that a DELIVERED purchase has every hold
--      captured summing to its exact amount and a COMPLETED check, that a
--      COMPLETED paid check has a settled purchase, and that a RELEASED
--      purchase has no capture anywhere. Deferred, because the completion
--      transaction necessarily passes through a moment where only one of the
--      two has been written (§36, §72–§74, §124–§126).
--
--   3. **A purchase's financial identity never changes.** Owner, product,
--      resource, quote, price version, currency and amount are write-once, and
--      the status machine only moves forwards (§8, §76–§78).
-- =============================================================================

-- =============================================================================
-- 1. Generated additive DDL
-- =============================================================================
-- CreateEnum
CREATE TYPE "ServiceResourceType" AS ENUM ('DOCUMENT_CHECK');

-- CreateEnum
CREATE TYPE "ServicePurchaseStatus" AS ENUM ('RESERVED', 'PROCESSING', 'DELIVERED', 'RELEASED', 'REFUNDED', 'RECONCILIATION_REQUIRED');

-- AlterTable
ALTER TABLE "document_checks" ADD COLUMN     "service_purchase_id" UUID;

-- CreateTable
CREATE TABLE "service_purchases" (
    "id" UUID NOT NULL,
    "owner_user_id" UUID NOT NULL,
    "product_code" "ServiceProductCode" NOT NULL,
    "resource_type" "ServiceResourceType" NOT NULL,
    "resource_id" UUID NOT NULL,
    "price_quote_id" UUID NOT NULL,
    "price_version_id" UUID NOT NULL,
    "currency" VARCHAR(3) NOT NULL,
    "amount_minor" BIGINT NOT NULL,
    "status" "ServicePurchaseStatus" NOT NULL DEFAULT 'RESERVED',
    "failure_code" TEXT,
    "idempotency_key" VARCHAR(200),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "reserved_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "processing_at" TIMESTAMPTZ(6),
    "delivered_at" TIMESTAMPTZ(6),
    "released_at" TIMESTAMPTZ(6),
    "refunded_at" TIMESTAMPTZ(6),
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

CONSTRAINT "service_purchases_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "service_purchase_allocations" (
    "id" UUID NOT NULL,
    "owner_user_id" UUID NOT NULL,
    "purchase_id" UUID NOT NULL,
    "hold_id" UUID NOT NULL,
    "credit_class" "CreditClass" NOT NULL,
    "currency" VARCHAR(3) NOT NULL,
    "amount_minor" BIGINT NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

CONSTRAINT "service_purchase_allocations_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "service_purchases_price_quote_id_key" ON "service_purchases"("price_quote_id");

-- CreateIndex
CREATE INDEX "service_purchases_owner_user_id_created_at_id_idx" ON "service_purchases"("owner_user_id", "created_at", "id");

-- CreateIndex
CREATE INDEX "service_purchases_status_reserved_at_idx" ON "service_purchases"("status", "reserved_at");

-- CreateIndex
CREATE UNIQUE INDEX "service_purchases_id_owner_key" ON "service_purchases"("id", "owner_user_id");

-- CreateIndex
CREATE UNIQUE INDEX "service_purchases_owner_idempotency" ON "service_purchases"("owner_user_id", "idempotency_key");

-- CreateIndex
CREATE UNIQUE INDEX "service_purchases_resource_key" ON "service_purchases"("resource_type", "resource_id");

-- CreateIndex
CREATE UNIQUE INDEX "service_purchase_allocations_hold_id_key" ON "service_purchase_allocations"("hold_id");

-- CreateIndex
CREATE INDEX "service_purchase_allocations_owner_user_id_created_at_id_idx" ON "service_purchase_allocations"("owner_user_id", "created_at", "id");

-- CreateIndex
CREATE INDEX "service_purchase_allocations_purchase_id_idx" ON "service_purchase_allocations"("purchase_id");

-- CreateIndex
CREATE UNIQUE INDEX "purchase_allocations_one_per_class" ON "service_purchase_allocations"("purchase_id", "credit_class");

-- CreateIndex
CREATE UNIQUE INDEX "document_checks_service_purchase_id_key" ON "document_checks"("service_purchase_id");

-- AddForeignKey
ALTER TABLE "document_checks" ADD CONSTRAINT "document_checks_service_purchase_id_fkey" FOREIGN KEY ("service_purchase_id") REFERENCES "service_purchases"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "service_purchases" ADD CONSTRAINT "service_purchases_owner_user_id_fkey" FOREIGN KEY ("owner_user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "service_purchases" ADD CONSTRAINT "service_purchases_product_code_fkey" FOREIGN KEY ("product_code") REFERENCES "service_products"("product_code") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "service_purchases" ADD CONSTRAINT "service_purchases_price_quote_id_fkey" FOREIGN KEY ("price_quote_id") REFERENCES "price_quotes"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "service_purchases" ADD CONSTRAINT "service_purchases_price_version_id_fkey" FOREIGN KEY ("price_version_id") REFERENCES "price_versions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "service_purchase_allocations" ADD CONSTRAINT "service_purchase_allocations_owner_user_id_fkey" FOREIGN KEY ("owner_user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "service_purchase_allocations" ADD CONSTRAINT "service_purchase_allocations_purchase_id_fkey" FOREIGN KEY ("purchase_id") REFERENCES "service_purchases"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "service_purchase_allocations" ADD CONSTRAINT "service_purchase_allocations_hold_id_fkey" FOREIGN KEY ("hold_id") REFERENCES "credit_holds"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- =============================================================================
-- 2. Composite ownership keys (§70, §123)
--
--    The ordinary foreign keys above prove the row exists. These prove it
--    belongs to the same person. Without them a service bug could fund User
--    A's purchase from User B's quote, or point User A's allocation at User
--    B's hold, and every one of those is somebody's money.
-- =============================================================================
ALTER TABLE "service_purchases"
    ADD CONSTRAINT "service_purchases_quote_owner_fkey"
    FOREIGN KEY ("owner_user_id", "price_quote_id")
    REFERENCES "price_quotes" ("owner_user_id", "id") ON UPDATE CASCADE ON DELETE RESTRICT;

ALTER TABLE "service_purchase_allocations"
    ADD CONSTRAINT "purchase_allocations_purchase_owner_fkey"
    FOREIGN KEY ("owner_user_id", "purchase_id")
    REFERENCES "service_purchases" ("owner_user_id", "id") ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE "service_purchase_allocations"
    ADD CONSTRAINT "purchase_allocations_hold_owner_fkey"
    FOREIGN KEY ("owner_user_id", "hold_id")
    REFERENCES "credit_holds" ("owner_user_id", "id") ON UPDATE CASCADE ON DELETE RESTRICT;

ALTER TABLE "document_checks"
    ADD CONSTRAINT "document_checks_purchase_owner_fkey"
    FOREIGN KEY ("owner_user_id", "service_purchase_id")
    REFERENCES "service_purchases" ("owner_user_id", "id") ON UPDATE CASCADE ON DELETE RESTRICT;

-- =============================================================================
-- 3. Value invariants (§6, §72)
-- =============================================================================
ALTER TABLE "service_purchases"
    ADD CONSTRAINT "service_purchases_amount_positive"
    CHECK ("amount_minor" > 0 AND "amount_minor" <= 1000000000000000);

ALTER TABLE "service_purchases"
    ADD CONSTRAINT "service_purchases_currency_shape"
    CHECK ("currency" ~ '^[A-Z]{3}$');

-- Phase 11 sells document checks and nothing else. The domain is general; the
-- catalogue of what it may currently sell is not (§5, §147).
ALTER TABLE "service_purchases"
    ADD CONSTRAINT "service_purchases_phase11_product"
    CHECK ("resource_type" <> 'DOCUMENT_CHECK' OR "product_code" = 'DOCUMENT_CHECK');

-- A status and its timestamp agree, so "when was this charged?" is answerable
-- from the row rather than from an event log.
ALTER TABLE "service_purchases"
    ADD CONSTRAINT "service_purchases_status_timestamps" CHECK (
        ("status" IN ('RESERVED', 'PROCESSING', 'RECONCILIATION_REQUIRED'))
        OR ("status" = 'DELIVERED' AND "delivered_at" IS NOT NULL AND "released_at" IS NULL)
        OR ("status" = 'RELEASED'  AND "released_at"  IS NOT NULL AND "delivered_at" IS NULL)
        OR ("status" = 'REFUNDED'  AND "refunded_at"  IS NOT NULL AND "delivered_at" IS NOT NULL)
    );

ALTER TABLE "service_purchase_allocations"
    ADD CONSTRAINT "purchase_allocations_amount_positive"
    CHECK ("amount_minor" > 0);

ALTER TABLE "service_purchase_allocations"
    ADD CONSTRAINT "purchase_allocations_currency_shape"
    CHECK ("currency" ~ '^[A-Z]{3}$');

-- =============================================================================
-- 4. Purchase immutability and the status machine (§8, §76, §77)
-- =============================================================================
CREATE OR REPLACE FUNCTION service_purchases_guard()
RETURNS trigger LANGUAGE plpgsql SET search_path = public AS $$
DECLARE
    allowed text[];
BEGIN
    -- The financial identity. Changing any of it would mean the customer paid
    -- for something other than what the record says they bought, and a later
    -- price change must never reach a purchase that was already made (§8).
    IF NEW."owner_user_id"    <> OLD."owner_user_id"
        OR NEW."product_code"    <> OLD."product_code"
        OR NEW."resource_type"   <> OLD."resource_type"
        OR NEW."resource_id"     <> OLD."resource_id"
        OR NEW."price_quote_id"  <> OLD."price_quote_id"
        OR NEW."price_version_id" <> OLD."price_version_id"
        OR NEW."currency"        <> OLD."currency"
        OR NEW."amount_minor"    <> OLD."amount_minor"
    THEN
        RAISE EXCEPTION 'service_purchase % financial identity is immutable', OLD."id"
            USING ERRCODE = 'integrity_constraint_violation';
    END IF;

    IF NEW."status" <> OLD."status" THEN
        allowed := CASE OLD."status"
            WHEN 'RESERVED'   THEN ARRAY['PROCESSING', 'RELEASED', 'RECONCILIATION_REQUIRED']
            WHEN 'PROCESSING' THEN ARRAY['DELIVERED', 'RELEASED', 'RECONCILIATION_REQUIRED']
            WHEN 'DELIVERED'  THEN ARRAY['REFUNDED', 'RECONCILIATION_REQUIRED']
            WHEN 'RELEASED'   THEN ARRAY['RECONCILIATION_REQUIRED']
            WHEN 'REFUNDED'   THEN ARRAY['RECONCILIATION_REQUIRED']
            ELSE ARRAY[]::text[]
        END;
        IF NOT (NEW."status"::text = ANY (allowed)) THEN
            RAISE EXCEPTION 'service_purchase % cannot move from % to %',
                OLD."id", OLD."status", NEW."status"
                USING ERRCODE = 'integrity_constraint_violation';
        END IF;
    END IF;

    RETURN NEW;
END;
$$;

CREATE TRIGGER "service_purchases_guard"
    BEFORE UPDATE ON "service_purchases"
    FOR EACH ROW EXECUTE FUNCTION service_purchases_guard();

-- An allocation records what was reserved. Re-pointing one at another hold, or
-- quietly changing its amount, would break the sum invariant the whole design
-- rests on, so it is written once.
CREATE OR REPLACE FUNCTION purchase_allocations_immutable()
RETURNS trigger LANGUAGE plpgsql SET search_path = public AS $$
BEGIN
    RAISE EXCEPTION 'service_purchase_allocation % is written once and cannot be changed', OLD."id"
        USING ERRCODE = 'integrity_constraint_violation';
END;
$$;

CREATE TRIGGER "purchase_allocations_immutable"
    BEFORE UPDATE ON "service_purchase_allocations"
    FOR EACH ROW EXECUTE FUNCTION purchase_allocations_immutable();

-- =============================================================================
-- 5. No new check without a purchase (§4, §21, §121)
--
--    This is the trigger that retires the free check. It fires on INSERT, so
--    every row written after this migration must name a purchase that belongs
--    to the same person and points back at this very check — and every row
--    written before it is left exactly as it is.
-- =============================================================================
CREATE OR REPLACE FUNCTION document_checks_require_purchase()
RETURNS trigger LANGUAGE plpgsql SET search_path = public AS $$
DECLARE
    purchase "service_purchases"%ROWTYPE;
BEGIN
    IF NEW."service_purchase_id" IS NULL THEN
        RAISE EXCEPTION 'document_check % must be bound to a service purchase', NEW."id"
            USING ERRCODE = 'integrity_constraint_violation';
    END IF;

    SELECT * INTO purchase FROM "service_purchases" WHERE "id" = NEW."service_purchase_id";
    IF NOT FOUND THEN
        RAISE EXCEPTION 'document_check % names a service purchase that does not exist', NEW."id"
            USING ERRCODE = 'integrity_constraint_violation';
    END IF;

    -- The binding has to be mutual. A purchase that names a different resource
    -- would let one payment cover two checks.
    IF purchase."owner_user_id" <> NEW."owner_user_id"
        OR purchase."resource_type" <> 'DOCUMENT_CHECK'
        OR purchase."resource_id" <> NEW."id"
        OR purchase."product_code" <> 'DOCUMENT_CHECK'
    THEN
        RAISE EXCEPTION 'service_purchase % does not describe document_check %',
            purchase."id", NEW."id"
            USING ERRCODE = 'integrity_constraint_violation';
    END IF;

    RETURN NEW;
END;
$$;

CREATE TRIGGER "document_checks_require_purchase"
    BEFORE INSERT ON "document_checks"
    FOR EACH ROW EXECUTE FUNCTION document_checks_require_purchase();

-- Once bound, for ever bound. A check cannot be moved onto a cheaper purchase
-- after the fact, and a historical free check cannot be retro-fitted with one
-- to make it look paid (§78).
CREATE OR REPLACE FUNCTION document_checks_purchase_binding_immutable()
RETURNS trigger LANGUAGE plpgsql SET search_path = public AS $$
BEGIN
    IF NEW."service_purchase_id" IS DISTINCT FROM OLD."service_purchase_id" THEN
        RAISE EXCEPTION 'document_check % is already bound to purchase %',
            OLD."id", COALESCE(OLD."service_purchase_id"::text, 'none')
            USING ERRCODE = 'integrity_constraint_violation';
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER "document_checks_purchase_binding_immutable"
    BEFORE UPDATE ON "document_checks"
    FOR EACH ROW EXECUTE FUNCTION document_checks_purchase_binding_immutable();

-- =============================================================================
-- 6. Money and service settle together (§36, §72–§74, §119, §124–§126)
--
--    These are DEFERRED constraint triggers, and the deferral is the whole
--    point. The transaction that finishes a check necessarily passes through a
--    moment where the purchase has been marked DELIVERED and the check has not
--    yet been marked COMPLETED — an immediate trigger would refuse a
--    perfectly correct transaction on the strength of its intermediate state.
--    Deferred to COMMIT, they ask the only question worth asking: when this
--    transaction is over, does the money agree with the service?
-- =============================================================================
CREATE OR REPLACE FUNCTION service_purchase_allocation_sum(p_purchase_id uuid)
RETURNS void LANGUAGE plpgsql SET search_path = public AS $$
DECLARE
    purchase "service_purchases"%ROWTYPE;
    allocated bigint;
BEGIN
    SELECT * INTO purchase FROM "service_purchases" WHERE "id" = p_purchase_id;
    -- The purchase went with its owner. Nothing left to be consistent with.
    IF NOT FOUND THEN RETURN; END IF;
    -- A purchase escalated to a person is allowed not to add up: that is what
    -- the status means, and forcing it to balance would be the guessing §94
    -- forbids.
    IF purchase."status" = 'RECONCILIATION_REQUIRED' THEN RETURN; END IF;

    SELECT COALESCE(SUM("amount_minor"), 0) INTO allocated
    FROM "service_purchase_allocations" WHERE "purchase_id" = p_purchase_id;

    IF allocated <> purchase."amount_minor" THEN
        RAISE EXCEPTION 'service_purchase % is funded by % but costs %',
            purchase."id", allocated, purchase."amount_minor"
            USING ERRCODE = 'integrity_constraint_violation';
    END IF;
END;
$$;

CREATE OR REPLACE FUNCTION purchase_allocations_sum_trigger()
RETURNS trigger LANGUAGE plpgsql SET search_path = public AS $$
BEGIN
    PERFORM service_purchase_allocation_sum(COALESCE(NEW."purchase_id", OLD."purchase_id"));
    RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER "purchase_allocations_sum"
    AFTER INSERT OR UPDATE OR DELETE ON "service_purchase_allocations"
    DEFERRABLE INITIALLY DEFERRED
    FOR EACH ROW EXECUTE FUNCTION purchase_allocations_sum_trigger();

CREATE OR REPLACE FUNCTION service_purchases_settlement_trigger()
RETURNS trigger LANGUAGE plpgsql SET search_path = public AS $$
DECLARE
    captured bigint;
    uncaptured integer;
    check_status text;
    charged integer;
BEGIN
    PERFORM service_purchase_allocation_sum(NEW."id");

    IF NEW."status" = 'RECONCILIATION_REQUIRED' THEN RETURN NULL; END IF;

    IF NEW."status" IN ('DELIVERED', 'REFUNDED') THEN
        -- Every reservation must actually have been charged, and the charges
        -- must add up to exactly the price. A partial capture is the failure
        -- mode §35 exists to make impossible.
        SELECT COUNT(*) INTO uncaptured
        FROM "service_purchase_allocations" a
        JOIN "credit_holds" h ON h."id" = a."hold_id"
        WHERE a."purchase_id" = NEW."id" AND h."status" <> 'CAPTURED';

        IF uncaptured > 0 THEN
            RAISE EXCEPTION 'service_purchase % is % with % uncaptured reservation(s)',
                NEW."id", NEW."status", uncaptured
                USING ERRCODE = 'integrity_constraint_violation';
        END IF;

        SELECT COALESCE(SUM(h."amount_minor"), 0) INTO captured
        FROM "service_purchase_allocations" a
        JOIN "credit_holds" h ON h."id" = a."hold_id"
        WHERE a."purchase_id" = NEW."id";

        IF captured <> NEW."amount_minor" THEN
            RAISE EXCEPTION 'service_purchase % charged % but costs %',
                NEW."id", captured, NEW."amount_minor"
                USING ERRCODE = 'integrity_constraint_violation';
        END IF;

        -- Delivery means the service was delivered. A purchase cannot be paid
        -- for a check that never finished (§126).
        IF NEW."resource_type" = 'DOCUMENT_CHECK' THEN
            SELECT "status"::text INTO check_status
            FROM "document_checks" WHERE "id" = NEW."resource_id";
            IF check_status IS DISTINCT FROM 'COMPLETED' THEN
                RAISE EXCEPTION 'service_purchase % is % but document_check % is %',
                    NEW."id", NEW."status", NEW."resource_id", COALESCE(check_status, 'missing')
                    USING ERRCODE = 'integrity_constraint_violation';
            END IF;
        END IF;
    END IF;

    IF NEW."status" = 'RELEASED' THEN
        -- Nothing delivered, so nothing charged — checked twice, because this
        -- is the invariant that says a failed check is free (§74).
        SELECT COUNT(*) INTO charged
        FROM "service_purchase_allocations" a
        JOIN "credit_holds" h ON h."id" = a."hold_id"
        WHERE a."purchase_id" = NEW."id" AND h."status" = 'CAPTURED';

        IF charged > 0 THEN
            RAISE EXCEPTION 'service_purchase % is RELEASED but % reservation(s) were charged',
                NEW."id", charged
                USING ERRCODE = 'integrity_constraint_violation';
        END IF;

        SELECT COUNT(*) INTO charged
        FROM "service_purchase_allocations" a
        JOIN "credit_ledger_entries" e
          ON e."reference_type" = 'CREDIT_HOLD' AND e."reference_id" = a."hold_id"
        WHERE a."purchase_id" = NEW."id" AND e."entry_type" = 'SERVICE_CHARGE';

        IF charged > 0 THEN
            RAISE EXCEPTION 'service_purchase % is RELEASED but has % service charge(s)',
                NEW."id", charged
                USING ERRCODE = 'integrity_constraint_violation';
        END IF;
    END IF;

    RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER "service_purchases_settlement"
    AFTER INSERT OR UPDATE ON "service_purchases"
    DEFERRABLE INITIALLY DEFERRED
    FOR EACH ROW EXECUTE FUNCTION service_purchases_settlement_trigger();

-- The same invariant approached from the other side: a paid check that says it
-- is COMPLETED must have a purchase that was actually settled (§36, §125).
CREATE OR REPLACE FUNCTION document_checks_completion_paid_trigger()
RETURNS trigger LANGUAGE plpgsql SET search_path = public AS $$
DECLARE
    purchase_status text;
BEGIN
    IF NEW."status" <> 'COMPLETED' OR NEW."service_purchase_id" IS NULL THEN
        RETURN NULL;
    END IF;

    SELECT "status"::text INTO purchase_status
    FROM "service_purchases" WHERE "id" = NEW."service_purchase_id";

    IF purchase_status NOT IN ('DELIVERED', 'REFUNDED') THEN
        RAISE EXCEPTION 'document_check % is COMPLETED but its purchase is %',
            NEW."id", COALESCE(purchase_status, 'missing')
            USING ERRCODE = 'integrity_constraint_violation';
    END IF;
    RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER "document_checks_completion_paid"
    AFTER INSERT OR UPDATE ON "document_checks"
    DEFERRABLE INITIALLY DEFERRED
    FOR EACH ROW EXECUTE FUNCTION document_checks_completion_paid_trigger();

-- =============================================================================
-- 7. Isolation classification (§67)
-- =============================================================================
INSERT INTO "table_isolation_classification" ("table_name", "classification", "tenant_column", "notes")
VALUES
    ('service_purchases', 'USER_SCOPED', 'owner_user_id',
     'One person buying one deliverable service. The organization whose standard was checked has no access at all.'),
    ('service_purchase_allocations', 'USER_SCOPED', 'owner_user_id',
     'Which credit classes funded a purchase. Written once, alongside the reservations it records.')
ON CONFLICT ("table_name") DO NOTHING;

-- =============================================================================
-- 8. Row-level security (§67, §68, §69)
-- =============================================================================
ALTER TABLE "service_purchases" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "service_purchases" FORCE ROW LEVEL SECURITY;
CREATE POLICY "service_purchases_owner" ON "service_purchases" FOR ALL
    USING (app_is_platform_admin() OR "owner_user_id" = app_current_user_id())
    WITH CHECK (app_is_platform_admin() OR "owner_user_id" = app_current_user_id());

ALTER TABLE "service_purchase_allocations" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "service_purchase_allocations" FORCE ROW LEVEL SECURITY;
CREATE POLICY "service_purchase_allocations_owner" ON "service_purchase_allocations" FOR ALL
    USING (app_is_platform_admin() OR "owner_user_id" = app_current_user_id())
    WITH CHECK (app_is_platform_admin() OR "owner_user_id" = app_current_user_id());

-- =============================================================================
-- 9. Permissions and role grants (§130, §131)
-- =============================================================================
INSERT INTO "permissions" ("id", "code", "description") VALUES
    (gen_random_uuid(), 'finance:purchase:read', 'Read what a customer bought and how it was funded')
ON CONFLICT ("code") DO NOTHING;

-- Read-only, and given to every role that already reads payments. Answering
-- "was I charged for that check?" needs no authority to change the answer, and
-- support gets none of the mutation permissions (§130).
INSERT INTO "role_permissions" ("role_id", "permission_id")
SELECT r."id", p."id"
FROM "roles" r
CROSS JOIN "permissions" p
WHERE r."code" IN ('PALCERT_ADMIN', 'PALCERT_FINANCE', 'PALCERT_SUPPORT', 'PALCERT_AUDITOR')
  AND p."code" = 'finance:purchase:read'
ON CONFLICT ("role_id", "permission_id") DO NOTHING;

-- =============================================================================
-- 10. Grants, and the paid check's own processing intent
-- =============================================================================
GRANT SELECT, INSERT, UPDATE ON "service_purchases" TO "palcert_app";
GRANT SELECT, INSERT ON "service_purchase_allocations" TO "palcert_app";

-- Financial history is not deleted (§101, §143). As with the ledger, the
-- triggers are the belt and the revoked privilege is the braces: Phase 2's
-- default privileges would otherwise have granted DELETE quietly.
REVOKE DELETE ON "service_purchases" FROM "palcert_app";
REVOKE UPDATE, DELETE ON "service_purchase_allocations" FROM "palcert_app";

-- A paid check's durable kickoff is customer work with an owner, so it lands
-- in the ordinary owner-scoped branch of the tenancy rule (§23, §142).
ALTER TABLE "processing_jobs" DROP CONSTRAINT "processing_jobs_resource_type_known";
ALTER TABLE "processing_jobs"
    ADD CONSTRAINT "processing_jobs_resource_type_known"
    CHECK ("resource_type" IN (
        'DOCUMENT_VERSION', 'DOCUMENT', 'DOCUMENT_ANALYSIS', 'DOCUMENT_CHECK', 'CHECK_RUN', 'AI_REVIEW',
        'STANDARD_SOURCE_ASSET', 'RULE_EXTRACTION_RUN',
        'PAYMENT_PROVIDER_EVENT', 'PAYMENT_RECONCILIATION'));
