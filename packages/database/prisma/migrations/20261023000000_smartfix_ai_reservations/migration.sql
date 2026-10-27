-- Backward-compatible: additive reservation table; legacy plans/requests keep
-- their existing purchase and settlement rules. AI planning reserves SMARTFIX
-- credit before provider work and reuses that purchase after plan approval.
CREATE TABLE "smartfix_planning_reservations" (
  "id" uuid PRIMARY KEY,
  "owner_user_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE RESTRICT,
  "check_id" uuid NOT NULL REFERENCES "document_checks"("id") ON DELETE RESTRICT,
  "service_purchase_id" uuid NOT NULL UNIQUE REFERENCES "service_purchases"("id") ON DELETE RESTRICT,
  "plan_id" uuid UNIQUE REFERENCES "smartfix_plans"("id") ON DELETE RESTRICT,
  "status" varchar(20) NOT NULL DEFAULT 'PLANNING',
  "expires_at" timestamptz(6) NOT NULL,
  "created_at" timestamptz(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" timestamptz(6) NOT NULL,
  CONSTRAINT "smartfix_planning_owner_check" FOREIGN KEY ("check_id", "owner_user_id")
    REFERENCES "document_checks"("id", "owner_user_id"),
  CONSTRAINT "smartfix_planning_owner_plan" FOREIGN KEY ("plan_id", "owner_user_id")
    REFERENCES "smartfix_plans"("id", "owner_user_id"),
  CONSTRAINT "smartfix_planning_status" CHECK ("status" IN ('PLANNING','READY','CONSUMED','FAILED','CANCELLED')),
  CONSTRAINT "smartfix_planning_identity" CHECK ("plan_id" IS NULL OR "plan_id" = "id"),
  CONSTRAINT "smartfix_planning_ready_plan" CHECK ("status" NOT IN ('READY','CONSUMED') OR "plan_id" IS NOT NULL),
  CONSTRAINT "smartfix_planning_expiry" CHECK ("expires_at" > "created_at")
);
CREATE INDEX "smartfix_planning_reservations_status_expires_at_idx"
  ON "smartfix_planning_reservations"("status", "expires_at");

CREATE FUNCTION smartfix_planning_guard() RETURNS trigger LANGUAGE plpgsql SET search_path = public AS $$
DECLARE p "service_purchases"%ROWTYPE;
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW."status" <> 'PLANNING' OR NEW."plan_id" IS NOT NULL THEN
      RAISE EXCEPTION 'AI planning must begin with a reservation' USING ERRCODE = 'integrity_constraint_violation';
    END IF;
    SELECT * INTO p FROM "service_purchases" WHERE "id" = NEW."service_purchase_id";
    IF p."id" IS NULL OR p."owner_user_id" <> NEW."owner_user_id"
      OR p."product_code" <> 'SMARTFIX' OR p."resource_type" <> 'SMARTFIX'
      OR p."resource_id" <> NEW."id" OR p."status" <> 'RESERVED' THEN
      RAISE EXCEPTION 'AI planning purchase binding is invalid' USING ERRCODE = 'integrity_constraint_violation';
    END IF;
  ELSE
    IF (NEW."id", NEW."owner_user_id", NEW."check_id", NEW."service_purchase_id", NEW."expires_at", NEW."created_at")
      IS DISTINCT FROM (OLD."id", OLD."owner_user_id", OLD."check_id", OLD."service_purchase_id", OLD."expires_at", OLD."created_at")
      OR (OLD."plan_id" IS NOT NULL AND NEW."plan_id" IS DISTINCT FROM OLD."plan_id") THEN
      RAISE EXCEPTION 'AI planning identity is immutable' USING ERRCODE = 'integrity_constraint_violation';
    END IF;
    IF NEW."status" <> OLD."status" AND NOT (
      (OLD."status" = 'PLANNING' AND NEW."status" IN ('READY','FAILED','CANCELLED')) OR
      (OLD."status" = 'READY' AND NEW."status" IN ('CONSUMED','FAILED','CANCELLED'))
    ) THEN
      RAISE EXCEPTION 'Invalid AI planning transition' USING ERRCODE = 'integrity_constraint_violation';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER "smartfix_planning_guard" BEFORE INSERT OR UPDATE ON "smartfix_planning_reservations"
  FOR EACH ROW EXECUTE FUNCTION smartfix_planning_guard();

CREATE FUNCTION smartfix_planning_settlement() RETURNS trigger LANGUAGE plpgsql SET search_path = public AS $$
DECLARE s "smartfix_planning_reservations"%ROWTYPE; p "service_purchases"%ROWTYPE;
BEGIN
  -- Read the final row, because multiple transitions can occur in one transaction.
  SELECT * INTO s FROM "smartfix_planning_reservations" WHERE "id" = NEW."id";
  SELECT * INTO p FROM "service_purchases" WHERE "id" = s."service_purchase_id";
  IF TG_TABLE_NAME = 'smartfix_requests' AND s."id" IS NOT NULL AND s."status" <> 'CONSUMED' THEN
    RAISE EXCEPTION 'AI correction must consume its planning reservation' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF s."status" IN ('FAILED','CANCELLED') AND p."status" <> 'RELEASED' THEN
    RAISE EXCEPTION 'Ended AI planning must release its purchase' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF s."status" IN ('PLANNING','READY') AND p."status" NOT IN ('RESERVED','PROCESSING') THEN
    RAISE EXCEPTION 'Open AI planning must retain its reservation' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF s."status" = 'CONSUMED' AND NOT EXISTS (
    SELECT 1 FROM "smartfix_requests" r WHERE r."id" = s."id"
      AND r."plan_id" = s."plan_id" AND r."service_purchase_id" = s."service_purchase_id"
      AND r."owner_user_id" = s."owner_user_id" AND r."check_id" = s."check_id"
  ) THEN
    RAISE EXCEPTION 'Approved AI planning must reuse the original purchase' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NULL;
END;
$$;
CREATE CONSTRAINT TRIGGER "smartfix_planning_settlement" AFTER INSERT OR UPDATE ON "smartfix_planning_reservations"
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION smartfix_planning_settlement();

CREATE FUNCTION smartfix_planning_request_binding() RETURNS trigger LANGUAGE plpgsql SET search_path = public AS $$
DECLARE s "smartfix_planning_reservations"%ROWTYPE;
BEGIN
  SELECT * INTO s FROM "smartfix_planning_reservations" WHERE "id" = NEW."plan_id" FOR UPDATE;
  IF s."id" IS NOT NULL AND (s."status" <> 'READY' OR NEW."id" <> s."id"
    OR NEW."service_purchase_id" <> s."service_purchase_id" OR NEW."owner_user_id" <> s."owner_user_id"
    OR NEW."check_id" <> s."check_id") THEN
    RAISE EXCEPTION 'AI correction must use its approved reservation' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER "smartfix_planning_request_binding" BEFORE INSERT ON "smartfix_requests"
  FOR EACH ROW EXECUTE FUNCTION smartfix_planning_request_binding();

INSERT INTO "table_isolation_classification" ("table_name", "classification", "tenant_column", "notes")
VALUES ('smartfix_planning_reservations','USER_SCOPED','owner_user_id','AI planning and correction share one reserved SMARTFIX purchase.');
ALTER TABLE "smartfix_planning_reservations" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "smartfix_planning_reservations" FORCE ROW LEVEL SECURITY;
CREATE POLICY "smartfix_planning_owner" ON "smartfix_planning_reservations" FOR ALL
  USING (app_is_platform_admin() OR "owner_user_id" = app_current_user_id())
  WITH CHECK (app_is_platform_admin() OR "owner_user_id" = app_current_user_id());
REVOKE ALL ON "smartfix_planning_reservations" FROM "palcert_app";
GRANT SELECT, INSERT, UPDATE ON "smartfix_planning_reservations" TO "palcert_app";

CREATE CONSTRAINT TRIGGER "smartfix_planning_request_consumed" AFTER INSERT ON "smartfix_requests"
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION smartfix_planning_settlement();
