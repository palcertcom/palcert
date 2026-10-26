-- =============================================================================
-- Phase 15 — finding eligible approvals that have no certificate (§78)
--
-- Reconciliation is PalCert's own housekeeping: it has to see across every
-- owner to notice work nobody else knows is missing. That is not an ordinary
-- tenant read, and it is not a human's platform elevation either — there is no
-- actor to audit, because no person asked for it.
--
-- So it gets the same treatment as every other system path in Phases 14 and
-- 15: a narrow SECURITY DEFINER function with a fixed search_path, a fixed
-- return shape, and no mutation. It returns two identifiers and nothing else —
-- no names, no digests, no decision data — because a sweeper only needs to
-- know what to enqueue.
-- =============================================================================

CREATE OR REPLACE FUNCTION app_certificate_outstanding(p_limit integer)
RETURNS TABLE ("revision_id" uuid, "owner_user_id" uuid)
LANGUAGE sql SECURITY DEFINER SET search_path = public STABLE AS $$
    SELECT r."id", r."owner_user_id"
      FROM "submission_revisions" r
      JOIN "official_submissions" s ON s."id" = r."submission_id"
      LEFT JOIN "compliance_certificates" c ON c."submission_revision_id" = r."id"
     WHERE r."processing_status" = 'READY'
       AND r."determination" = 'COMPLIANT'
       AND r."institution_decision_status" = 'APPROVED'
       AND s."current_revision_id" = r."id"
       AND (
            c."id" IS NULL
            -- A retryable failure is still work to do. A permanent one is
            -- fail-closed for good and must never be picked up again.
            OR c."issuance_status" = 'FAILED_RETRYABLE'
           )
     ORDER BY r."submitted_at" ASC
     LIMIT GREATEST(p_limit, 0);
$$;

GRANT EXECUTE ON FUNCTION app_certificate_outstanding(integer) TO "palcert_app";
