-- Read-only, content-free reporting projection. Private document/check/purchase
-- RLS remains unchanged. Scope comes only from the verified transaction context.
CREATE FUNCTION report_service_activity(p_from timestamptz, p_to timestamptz)
RETURNS TABLE(id text, service text, status text, payment text, organization text,
  currency text, quoted text, cash text, promotional text, refunded text, created_at timestamptz)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  WITH purchases AS (
    SELECT p.*, coalesce(s.organization_id, c.organization_id, sc.organization_id,
      ac.organization_id, r.organization_id) AS report_org,
      coalesce(c.status::text, sf.status::text, sp.status, a.status::text, r.status::text, p.status::text) AS activity_status
    FROM service_purchases p
    LEFT JOIN service_revenue_snapshots s ON s.purchase_id = p.id
    LEFT JOIN document_checks c ON c.service_purchase_id = p.id
    LEFT JOIN smartfix_requests sf ON sf.service_purchase_id = p.id
    LEFT JOIN smartfix_planning_reservations sp ON sp.service_purchase_id = p.id
    LEFT JOIN document_checks sc ON sc.id = coalesce(sf.check_id, sp.check_id)
    LEFT JOIN ai_reviews a ON a.service_purchase_id = p.id
    LEFT JOIN document_checks ac ON ac.id = a.check_id
    LEFT JOIN rule_extraction_runs r ON r.service_purchase_id = p.id
    WHERE p.created_at >= p_from AND p.created_at < p_to
  )
  SELECT p.id::text, p.product_code::text, p.activity_status, p.status::text,
    o.display_name, p.currency::text, p.amount_minor::text,
    coalesce(f.cash, 0)::text, coalesce(f.promo, 0)::text, coalesce(f.refund, 0)::text, p.created_at
  FROM purchases p LEFT JOIN organizations o ON o.id = p.report_org
  LEFT JOIN LATERAL (
    SELECT sum(a.amount_minor) FILTER (WHERE h.status = 'CAPTURED' AND a.credit_class = 'CASH') AS cash,
      sum(a.amount_minor) FILTER (WHERE h.status = 'CAPTURED' AND a.credit_class = 'PROMOTIONAL') AS promo,
      sum((SELECT coalesce(sum(e.amount_minor_signed),0) FROM credit_ledger_entries e
        WHERE e.reversal_of_entry_id = h.captured_entry_id AND e.entry_type = 'SERVICE_REFUND')) AS refund
    FROM service_purchase_allocations a JOIN credit_holds h ON h.id = a.hold_id WHERE a.purchase_id = p.id
  ) f ON true
  WHERE app_is_platform_admin()
    OR (app_current_organization() IS NOT NULL AND p.report_org = app_current_organization())
    OR (app_current_organization() IS NULL AND p.owner_user_id = app_current_user_id())
  UNION ALL
  SELECT a.id::text, 'ATTESTATION', a.status::text, a.payment_status::text, a.organization_name,
    a.currency::text, a.gross_fee_minor::text,
    CASE WHEN a.payment_status = 'SETTLED' THEN coalesce(a.gross_fee_minor,0) ELSE 0 END::text,
    '0', '0', a.created_at
  FROM attestation_requests a
  WHERE a.created_at >= p_from AND a.created_at < p_to AND (
    app_is_platform_admin() OR
    (app_current_organization() IS NOT NULL AND a.organization_id = app_current_organization()) OR
    (app_current_organization() IS NULL AND a.owner_user_id = app_current_user_id()))
  UNION ALL
  SELECT c.id::text, 'DOCUMENT_CHECK', c.status::text, 'NOT_BILLED', c.organization_name,
    NULL::text, NULL::text, '0', '0', '0', c.created_at
  FROM document_checks c
  WHERE c.service_purchase_id IS NULL AND c.created_at >= p_from AND c.created_at < p_to AND (
    app_is_platform_admin() OR
    (app_current_organization() IS NOT NULL AND c.organization_id = app_current_organization()) OR
    (app_current_organization() IS NULL AND c.owner_user_id = app_current_user_id()))
  UNION ALL
  SELECT a.id::text, 'AI_REVIEW', a.status::text, 'LEGACY', c.organization_name,
    NULL::text, NULL::text, '0', '0', '0', a.created_at
  FROM ai_reviews a JOIN document_checks c ON c.id = a.check_id
  WHERE a.service_purchase_id IS NULL AND a.created_at >= p_from AND a.created_at < p_to AND (
    app_is_platform_admin() OR
    (app_current_organization() IS NOT NULL AND c.organization_id = app_current_organization()) OR
    (app_current_organization() IS NULL AND a.owner_user_id = app_current_user_id()))
  UNION ALL
  SELECT r.id::text, 'AI_RULE_EXTRACTION', r.status::text, 'LEGACY', o.display_name,
    NULL::text, NULL::text, '0', '0', '0', r.created_at
  FROM rule_extraction_runs r JOIN organizations o ON o.id = r.organization_id
  WHERE r.service_purchase_id IS NULL AND r.created_at >= p_from AND r.created_at < p_to AND (
    app_is_platform_admin() OR
    (app_current_organization() IS NOT NULL AND r.organization_id = app_current_organization()) OR
    (app_current_organization() IS NULL AND r.created_by_user_id = app_current_user_id()))
$$;
REVOKE ALL ON FUNCTION report_service_activity(timestamptz,timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION report_service_activity(timestamptz,timestamptz) TO palcert_app;
COMMENT ON FUNCTION report_service_activity(timestamptz,timestamptz) IS
 'Content-free service activity: no document text, file names, student identity or storage keys. Organization scope overrides personal scope.';
