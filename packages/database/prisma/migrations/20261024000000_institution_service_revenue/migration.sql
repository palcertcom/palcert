-- Additive: historical purchases/attestations keep their original economics.
-- Financial facts are derived from server-owned resources and cash ledger entries.
CREATE TABLE organization_service_shares (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
  product_code "ServiceProductCode" NOT NULL REFERENCES service_products(product_code),
  institution_bps integer NOT NULL CHECK (institution_bps BETWEEN 0 AND 10000),
  effective_from timestamptz(6) NOT NULL,
  changed_by_user_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  change_reason text NOT NULL CHECK (length(trim(change_reason)) BETWEEN 1 AND 500),
  created_at timestamptz(6) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX organization_service_shares_current_idx ON organization_service_shares
  (organization_id, product_code, effective_from DESC, created_at DESC, id DESC);

CREATE TABLE service_revenue_snapshots (
  purchase_id uuid PRIMARY KEY REFERENCES service_purchases(id) ON DELETE RESTRICT,
  owner_user_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
  product_code "ServiceProductCode" NOT NULL,
  policy_id uuid REFERENCES organization_service_shares(id) ON DELETE RESTRICT,
  institution_bps integer NOT NULL CHECK (institution_bps BETWEEN 0 AND 10000),
  created_at timestamptz(6) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE service_revenue_entries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  purchase_id uuid NOT NULL REFERENCES service_revenue_snapshots(purchase_id) ON DELETE RESTRICT,
  ledger_entry_id uuid NOT NULL UNIQUE REFERENCES credit_ledger_entries(id) ON DELETE RESTRICT,
  reversal_of_id uuid UNIQUE REFERENCES service_revenue_entries(id) ON DELETE RESTRICT,
  owner_user_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
  product_code "ServiceProductCode" NOT NULL,
  currency varchar(3) NOT NULL,
  gross_minor bigint NOT NULL,
  institution_minor bigint NOT NULL,
  platform_minor bigint NOT NULL,
  created_at timestamptz(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CHECK (gross_minor = institution_minor + platform_minor),
  CHECK ((reversal_of_id IS NULL AND gross_minor > 0 AND institution_minor >= 0 AND platform_minor >= 0)
      OR (reversal_of_id IS NOT NULL AND gross_minor < 0 AND institution_minor <= 0 AND platform_minor <= 0))
);
CREATE INDEX service_revenue_entries_org_idx ON service_revenue_entries(organization_id, created_at, id);
CREATE INDEX service_revenue_entries_purchase_idx ON service_revenue_entries(purchase_id);

CREATE FUNCTION service_revenue_append_only() RETURNS trigger LANGUAGE plpgsql SET search_path = public AS $$
BEGIN
  RAISE EXCEPTION 'Revenue history is append-only' USING ERRCODE = 'integrity_constraint_violation';
END;
$$;
CREATE TRIGGER shares_append_only BEFORE UPDATE OR DELETE ON organization_service_shares
  FOR EACH ROW EXECUTE FUNCTION service_revenue_append_only();
CREATE TRIGGER snapshots_append_only BEFORE UPDATE OR DELETE ON service_revenue_snapshots
  FOR EACH ROW EXECUTE FUNCTION service_revenue_append_only();
CREATE TRIGGER revenue_append_only BEFORE UPDATE OR DELETE ON service_revenue_entries
  FOR EACH ROW EXECUTE FUNCTION service_revenue_append_only();

-- Trigger-only, no callable elevated write API. The organization comes from the
-- immutable check/standard binding, never the customer's claimed affiliation.
CREATE FUNCTION service_revenue_snapshot_resource() RETURNS trigger LANGUAGE plpgsql
SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  p service_purchases%ROWTYPE;
  policy organization_service_shares%ROWTYPE;
  org uuid;
  existing service_revenue_snapshots%ROWTYPE;
BEGIN
  IF NEW.service_purchase_id IS NULL THEN RETURN NEW; END IF;
  SELECT * INTO STRICT p FROM service_purchases WHERE id = NEW.service_purchase_id;
  IF TG_TABLE_NAME = 'rule_extraction_runs' OR TG_TABLE_NAME = 'document_checks' THEN
    org := NEW.organization_id;
  ELSE
    SELECT organization_id INTO STRICT org FROM document_checks WHERE id = NEW.check_id AND owner_user_id = p.owner_user_id;
  END IF;
  IF org IS NULL THEN RAISE EXCEPTION 'Revenue attribution requires the service institution'; END IF;
  SELECT * INTO existing FROM service_revenue_snapshots WHERE purchase_id = p.id;
  IF FOUND THEN
    -- AI SmartFix reserves before approval, then reuses the identical purchase.
    IF existing.organization_id <> org OR existing.product_code <> p.product_code THEN
      RAISE EXCEPTION 'Revenue attribution cannot change';
    END IF;
    RETURN NEW;
  END IF;
  SELECT * INTO policy FROM organization_service_shares
    WHERE organization_id = org AND product_code = p.product_code AND effective_from <= p.reserved_at
    ORDER BY effective_from DESC, created_at DESC, id DESC LIMIT 1;
  INSERT INTO service_revenue_snapshots(purchase_id, owner_user_id, organization_id, product_code, policy_id, institution_bps, created_at)
    VALUES(p.id, p.owner_user_id, org, p.product_code, policy.id, coalesce(policy.institution_bps, 0), p.reserved_at);
  RETURN NEW;
END;
$$;
CREATE TRIGGER revenue_snapshot AFTER INSERT ON document_checks FOR EACH ROW EXECUTE FUNCTION service_revenue_snapshot_resource();
CREATE TRIGGER revenue_snapshot AFTER INSERT ON smartfix_requests FOR EACH ROW EXECUTE FUNCTION service_revenue_snapshot_resource();
CREATE TRIGGER revenue_snapshot AFTER INSERT ON smartfix_planning_reservations FOR EACH ROW EXECUTE FUNCTION service_revenue_snapshot_resource();
CREATE TRIGGER revenue_snapshot AFTER INSERT ON ai_reviews FOR EACH ROW EXECUTE FUNCTION service_revenue_snapshot_resource();
CREATE TRIGGER revenue_snapshot AFTER INSERT ON rule_extraction_runs FOR EACH ROW EXECUTE FUNCTION service_revenue_snapshot_resource();

-- The cash capture is the financial source. Coupons never create cash payable
-- to an institution. Integer arithmetic, with the rounding remainder assigned
-- to the institution, matches the existing attestation settlement convention.
CREATE FUNCTION service_revenue_capture() RETURNS trigger LANGUAGE plpgsql
SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE s service_revenue_snapshots%ROWTYPE; e credit_ledger_entries%ROWTYPE; platform bigint;
BEGIN
  IF NEW.status <> 'CAPTURED' OR OLD.status = 'CAPTURED' OR NEW.credit_class <> 'CASH' THEN RETURN NEW; END IF;
  SELECT snap.* INTO s FROM service_revenue_snapshots snap
    JOIN service_purchase_allocations a ON a.purchase_id = snap.purchase_id WHERE a.hold_id = NEW.id;
  IF NOT FOUND THEN RETURN NEW; END IF; -- Pre-migration purchases keep their original allocation.
  SELECT * INTO STRICT e FROM credit_ledger_entries WHERE id = NEW.captured_entry_id;
  IF e.entry_type <> 'SERVICE_CHARGE' OR e.amount_minor_signed <> -NEW.amount_minor
     OR e.owner_user_id <> s.owner_user_id OR e.currency <> NEW.currency THEN
    RAISE EXCEPTION 'Revenue must match the captured cash';
  END IF;
  -- Explicit floor: PostgreSQL numeric-to-integer casts round, not truncate.
  platform := floor(NEW.amount_minor::numeric * (10000 - s.institution_bps) / 10000)::bigint;
  INSERT INTO service_revenue_entries(purchase_id, ledger_entry_id, owner_user_id, organization_id, product_code, currency, gross_minor, institution_minor, platform_minor, created_at)
    VALUES(s.purchase_id, e.id, s.owner_user_id, s.organization_id, s.product_code, e.currency, NEW.amount_minor, NEW.amount_minor - platform, platform, NEW.captured_at);
  RETURN NEW;
END;
$$;
CREATE TRIGGER revenue_capture AFTER UPDATE ON credit_holds FOR EACH ROW EXECUTE FUNCTION service_revenue_capture();

-- Refunds reverse the original split, including its rounding and old rate.
CREATE FUNCTION service_revenue_refund() RETURNS trigger LANGUAGE plpgsql
SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE original service_revenue_entries%ROWTYPE;
BEGIN
  IF NEW.entry_type <> 'SERVICE_REFUND' OR NEW.credit_class <> 'CASH' THEN RETURN NEW; END IF;
  SELECT * INTO original FROM service_revenue_entries WHERE ledger_entry_id = NEW.reversal_of_entry_id;
  IF NOT FOUND THEN RETURN NEW; END IF;
  IF NEW.amount_minor_signed <> original.gross_minor OR NEW.owner_user_id <> original.owner_user_id
    OR NEW.currency <> original.currency OR original.reversal_of_id IS NOT NULL THEN
    RAISE EXCEPTION 'A service refund must reverse the original cash capture exactly';
  END IF;
  -- Use the same accounts that serialize payout requests before reducing
  -- their backing funds. Always platform then institution to keep lock order.
  INSERT INTO withdrawal_accounts(scope, organization_id, currency) VALUES ('PLATFORM', NULL, original.currency)
    ON CONFLICT (currency) WHERE scope = 'PLATFORM' DO NOTHING;
  PERFORM id FROM withdrawal_accounts WHERE scope = 'PLATFORM' AND currency = original.currency FOR UPDATE;
  INSERT INTO withdrawal_accounts(scope, organization_id, currency) VALUES ('ORGANIZATION', original.organization_id, original.currency)
    ON CONFLICT (organization_id, currency) WHERE scope = 'ORGANIZATION' DO NOTHING;
  PERFORM id FROM withdrawal_accounts WHERE scope = 'ORGANIZATION' AND organization_id = original.organization_id AND currency = original.currency FOR UPDATE;
  INSERT INTO service_revenue_entries(purchase_id, ledger_entry_id, reversal_of_id, owner_user_id, organization_id, product_code, currency, gross_minor, institution_minor, platform_minor)
    VALUES(original.purchase_id, NEW.id, original.id, original.owner_user_id, original.organization_id, original.product_code, original.currency, -original.gross_minor, -original.institution_minor, -original.platform_minor);
  RETURN NEW;
END;
$$;
CREATE TRIGGER revenue_refund AFTER INSERT ON credit_ledger_entries FOR EACH ROW EXECUTE FUNCTION service_revenue_refund();

INSERT INTO table_isolation_classification(table_name, classification, tenant_column, notes) VALUES
 ('organization_service_shares', 'TENANT_SCOPED', 'organization_id', 'Append-only platform-admin revenue policy'),
 ('service_revenue_snapshots', 'DUAL_PARTY_SCOPED', 'organization_id', 'Immutable purchaser/institution financial attribution; no document content'),
 ('service_revenue_entries', 'DUAL_PARTY_SCOPED', 'organization_id', 'Cash settlement and reversal records; no document content');
ALTER TABLE organization_service_shares ENABLE ROW LEVEL SECURITY;
ALTER TABLE organization_service_shares FORCE ROW LEVEL SECURITY;
ALTER TABLE service_revenue_snapshots ENABLE ROW LEVEL SECURITY;
ALTER TABLE service_revenue_snapshots FORCE ROW LEVEL SECURITY;
ALTER TABLE service_revenue_entries ENABLE ROW LEVEL SECURITY;
ALTER TABLE service_revenue_entries FORCE ROW LEVEL SECURITY;
CREATE POLICY shares_read ON organization_service_shares FOR SELECT
  USING (app_is_platform_admin() OR organization_id = app_current_organization());
CREATE POLICY shares_admin_insert ON organization_service_shares FOR INSERT WITH CHECK (app_is_platform_admin());
-- Append-only: a new rate is a new row. The refusals are explicit policies
-- (the Phase 16/17 convention) so the coverage audit can tell "considered,
-- and the answer is no" from an oversight; the trigger above and the absent
-- UPDATE/DELETE grants refuse as well.
CREATE POLICY shares_no_update ON organization_service_shares FOR UPDATE USING (false) WITH CHECK (false);
CREATE POLICY shares_no_delete ON organization_service_shares FOR DELETE USING (false);
CREATE POLICY snapshots_read ON service_revenue_snapshots FOR SELECT
  USING (app_is_platform_admin() OR owner_user_id = app_current_user_id() OR organization_id = app_current_organization());
CREATE POLICY revenue_read ON service_revenue_entries FOR SELECT
  USING (app_is_platform_admin() OR owner_user_id = app_current_user_id() OR organization_id = app_current_organization());
REVOKE ALL ON organization_service_shares, service_revenue_snapshots, service_revenue_entries FROM palcert_app;
GRANT SELECT, INSERT ON organization_service_shares TO palcert_app;
GRANT SELECT ON service_revenue_snapshots, service_revenue_entries TO palcert_app;
REVOKE ALL ON FUNCTION service_revenue_append_only(), service_revenue_snapshot_resource(), service_revenue_capture(), service_revenue_refund() FROM PUBLIC;

INSERT INTO permissions(id, code, description) VALUES
 (gen_random_uuid(), 'admin:revenue-share:manage', 'Set institution revenue shares by service'),
 (gen_random_uuid(), 'admin:revenue-share:read', 'Read institution revenue shares and settlements') ON CONFLICT(code) DO NOTHING;
INSERT INTO role_permissions(role_id, permission_id)
 SELECT r.id, p.id FROM roles r CROSS JOIN permissions p
 WHERE (r.code = 'PALCERT_ADMIN' AND p.code IN ('admin:revenue-share:manage', 'admin:revenue-share:read'))
    OR (r.code IN ('PALCERT_FINANCE', 'PALCERT_AUDITOR') AND p.code = 'admin:revenue-share:read')
 ON CONFLICT DO NOTHING;

CREATE UNIQUE INDEX service_revenue_one_capture ON service_revenue_entries(purchase_id) WHERE reversal_of_id IS NULL;
CREATE FUNCTION service_revenue_delivery_guard() RETURNS trigger LANGUAGE plpgsql
SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM service_purchases WHERE id = NEW.purchase_id AND status IN ('DELIVERED', 'REFUNDED')) THEN
    RAISE EXCEPTION 'Revenue requires a delivered service' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NULL;
END;
$$;
CREATE CONSTRAINT TRIGGER revenue_requires_delivery AFTER INSERT ON service_revenue_entries
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION service_revenue_delivery_guard();
REVOKE ALL ON FUNCTION service_revenue_delivery_guard() FROM PUBLIC;
