-- =============================================================================
-- ADR-0149 — Centralized billing for customer-initiated AI services
--
-- Additive only. Two catalogue rows, one nullable column on each AI table, and
-- the triggers that make a new AI run impossible without a purchase. No
-- existing price, purchase, hold, ledger entry, balance, AI review or
-- extraction run is touched: every historical AI run keeps a NULL purchase and
-- is never charged.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. The catalogue
--
--    Seeded active but with no price. A product without an ACTIVE price in the
--    customer's currency cannot be quoted, so nothing is sellable until PalCert
--    Admin decides the fee. There is deliberately no default amount here.
-- -----------------------------------------------------------------------------
INSERT INTO "service_products" ("product_code", "active", "name_en", "name_ar", "description_en", "description_ar", "updated_at")
VALUES
    ('AI_REVIEW', true, 'AI Review', 'المراجعة بالذكاء الاصطناعي',
     'An AI assessment of a delivered check report, rule by rule, with cited evidence and a summary. Advisory; it never changes the check result.',
     'تقييم بالذكاء الاصطناعي لتقرير فحص مكتمل، قاعدةً قاعدة، مع الأدلة المستشهد بها وملخص. استشاري ولا يغيّر نتيجة الفحص.',
     now()),
    ('AI_RULE_EXTRACTION', true, 'AI Rule Extraction', 'استخراج القواعد بالذكاء الاصطناعي',
     'AI extraction of proposed rules from a standard''s guideline sources, for an organization to review and accept or reject.',
     'استخراج قواعد مقترحة بالذكاء الاصطناعي من مصادر الإرشادات الخاصة بمعيار، لتراجعها المؤسسة وتقبلها أو ترفضها.',
     now())
ON CONFLICT ("product_code") DO NOTHING;

-- -----------------------------------------------------------------------------
-- 2. The binding
--
--    Nullable because every existing row predates billing and stays exactly as
--    it is. Unique because one purchase pays for one run.
-- -----------------------------------------------------------------------------
ALTER TABLE "ai_reviews" ADD COLUMN "service_purchase_id" UUID;
CREATE UNIQUE INDEX "ai_reviews_service_purchase_id_key" ON "ai_reviews"("service_purchase_id");
ALTER TABLE "ai_reviews" ADD CONSTRAINT "ai_reviews_service_purchase_id_fkey"
    FOREIGN KEY ("service_purchase_id") REFERENCES "service_purchases"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "rule_extraction_runs" ADD COLUMN "service_purchase_id" UUID;
CREATE UNIQUE INDEX "rule_extraction_runs_service_purchase_id_key" ON "rule_extraction_runs"("service_purchase_id");
ALTER TABLE "rule_extraction_runs" ADD CONSTRAINT "rule_extraction_runs_service_purchase_id_fkey"
    FOREIGN KEY ("service_purchase_id") REFERENCES "service_purchases"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;

-- -----------------------------------------------------------------------------
-- 3. No new AI run without a purchase
--
--    These fire on INSERT, so every row written after this migration must name
--    a purchase that belongs to the person who started it and points back at
--    this very row — and every row written before it is left alone. The
--    database refuses a free AI run from any role, including a direct INSERT.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION ai_reviews_require_purchase()
RETURNS trigger LANGUAGE plpgsql SET search_path = public AS $$
DECLARE
    purchase "service_purchases"%ROWTYPE;
BEGIN
    IF NEW."service_purchase_id" IS NULL THEN
        RAISE EXCEPTION 'ai_review % must be bound to a service purchase', NEW."id"
            USING ERRCODE = 'integrity_constraint_violation';
    END IF;

    SELECT * INTO purchase FROM "service_purchases" WHERE "id" = NEW."service_purchase_id";
    IF NOT FOUND THEN
        RAISE EXCEPTION 'ai_review % names a service purchase that does not exist', NEW."id"
            USING ERRCODE = 'integrity_constraint_violation';
    END IF;

    IF purchase."owner_user_id" <> NEW."owner_user_id"
        OR purchase."product_code" <> 'AI_REVIEW'
        OR purchase."resource_type" <> 'AI_REVIEW'
        OR purchase."resource_id" <> NEW."id"
    THEN
        RAISE EXCEPTION 'service_purchase % does not describe ai_review %', purchase."id", NEW."id"
            USING ERRCODE = 'integrity_constraint_violation';
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER "ai_reviews_require_purchase"
    BEFORE INSERT ON "ai_reviews"
    FOR EACH ROW EXECUTE FUNCTION ai_reviews_require_purchase();

-- The payer of an organization-scoped extraction is the member who started it
-- (`created_by_user_id`), never the organization (ADR-0149 §3).
CREATE OR REPLACE FUNCTION rule_extraction_runs_require_purchase()
RETURNS trigger LANGUAGE plpgsql SET search_path = public AS $$
DECLARE
    purchase "service_purchases"%ROWTYPE;
BEGIN
    IF NEW."service_purchase_id" IS NULL THEN
        RAISE EXCEPTION 'rule_extraction_run % must be bound to a service purchase', NEW."id"
            USING ERRCODE = 'integrity_constraint_violation';
    END IF;

    SELECT * INTO purchase FROM "service_purchases" WHERE "id" = NEW."service_purchase_id";
    IF NOT FOUND THEN
        RAISE EXCEPTION 'rule_extraction_run % names a service purchase that does not exist', NEW."id"
            USING ERRCODE = 'integrity_constraint_violation';
    END IF;

    IF NEW."created_by_user_id" IS NULL
        OR purchase."owner_user_id" <> NEW."created_by_user_id"
        OR purchase."product_code" <> 'AI_RULE_EXTRACTION'
        OR purchase."resource_type" <> 'AI_RULE_EXTRACTION'
        OR purchase."resource_id" <> NEW."id"
    THEN
        RAISE EXCEPTION 'service_purchase % does not describe rule_extraction_run %', purchase."id", NEW."id"
            USING ERRCODE = 'integrity_constraint_violation';
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER "rule_extraction_runs_require_purchase"
    BEFORE INSERT ON "rule_extraction_runs"
    FOR EACH ROW EXECUTE FUNCTION rule_extraction_runs_require_purchase();

-- Once bound, for ever bound: a run cannot be moved onto another purchase, and
-- a historical free run cannot be retro-fitted with one to look paid.
CREATE OR REPLACE FUNCTION ai_run_purchase_binding_immutable()
RETURNS trigger LANGUAGE plpgsql SET search_path = public AS $$
BEGIN
    IF NEW."service_purchase_id" IS DISTINCT FROM OLD."service_purchase_id" THEN
        RAISE EXCEPTION '% % is already bound to purchase %', TG_TABLE_NAME, OLD."id",
            COALESCE(OLD."service_purchase_id"::text, 'none')
            USING ERRCODE = 'integrity_constraint_violation';
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER "ai_reviews_purchase_binding_immutable"
    BEFORE UPDATE ON "ai_reviews"
    FOR EACH ROW EXECUTE FUNCTION ai_run_purchase_binding_immutable();

CREATE TRIGGER "rule_extraction_runs_purchase_binding_immutable"
    BEFORE UPDATE ON "rule_extraction_runs"
    FOR EACH ROW EXECUTE FUNCTION ai_run_purchase_binding_immutable();
