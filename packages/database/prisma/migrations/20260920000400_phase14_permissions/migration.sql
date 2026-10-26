-- =============================================================================
-- Phase 14 — who may do what, and the two catalogues that had to learn a new
-- word (§53, §54, §55, §38)
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. A submission is durable work with an owner, and a reason to keep bytes
-- -----------------------------------------------------------------------------
ALTER TABLE "processing_jobs" DROP CONSTRAINT "processing_jobs_resource_type_known";
ALTER TABLE "processing_jobs"
    ADD CONSTRAINT "processing_jobs_resource_type_known"
    CHECK ("resource_type" IN (
        'DOCUMENT_VERSION', 'DOCUMENT', 'DOCUMENT_ANALYSIS', 'DOCUMENT_CHECK', 'CHECK_RUN', 'AI_REVIEW',
        'STANDARD_SOURCE_ASSET', 'RULE_EXTRACTION_RUN',
        'PAYMENT_PROVIDER_EVENT', 'PAYMENT_RECONCILIATION',
        'SMARTFIX_REQUEST', 'SUBMISSION_REVISION'));

-- §38, §39: the submitted bytes outlive the private check's own lifecycle.
-- An official submission that cannot produce the document it handed over is
-- evidence of nothing, so it holds its own lock rather than borrowing the
-- check's — and deleting the check does not quietly empty an institution's
-- record.
ALTER TABLE "document_retention_locks" DROP CONSTRAINT "document_retention_locks_type_known";
ALTER TABLE "document_retention_locks"
    ADD CONSTRAINT "document_retention_locks_type_known"
    CHECK ("lock_type" IN (
        'CHECK', 'REPORT', 'CERTIFICATE', 'FINANCIAL_RECORD', 'SUBMISSION', 'LEGAL_HOLD',
        'SMARTFIX', 'OFFICIAL_SUBMISSION'));

-- -----------------------------------------------------------------------------
-- 2. Permissions
-- -----------------------------------------------------------------------------
INSERT INTO "permissions" ("id", "code", "description") VALUES
    (gen_random_uuid(), 'submission:read:self',
     'Read your own official submissions and what institutions decided about them'),
    (gen_random_uuid(), 'submission:create:self',
     'Submit a completed check of your own to the institution that owns the standard'),
    (gen_random_uuid(), 'submission:review:read',
     'See the review queue and one submission''s metadata and technical result'),
    (gen_random_uuid(), 'submission:evidence:read',
     'Open the submitted document and its report snapshot'),
    (gen_random_uuid(), 'submission:decision:write',
     'Start a review, approve, reject or request a revision'),
    (gen_random_uuid(), 'submission:comment:write',
     'Write a review comment the submitter will read')
ON CONFLICT ("code") DO NOTHING;

-- -----------------------------------------------------------------------------
-- 3. The author's side is self-service
--
--    Granted to every role already carrying the self-service baseline, and to
--    no organization role. Submitting requires no membership anywhere (§17):
--    an independent researcher submits to a university they have never
--    belonged to, and that is the ordinary case rather than an exception.
-- -----------------------------------------------------------------------------
INSERT INTO "role_permissions" ("role_id", "permission_id")
SELECT rp."role_id", p."id"
FROM "role_permissions" rp
JOIN "permissions" baseline ON baseline."id" = rp."permission_id" AND baseline."code" = 'profile:read:self'
CROSS JOIN "permissions" p
WHERE p."code" IN ('submission:read:self', 'submission:create:self')
ON CONFLICT ("role_id", "permission_id") DO NOTHING;

-- -----------------------------------------------------------------------------
-- 4. The institution's side is permissions, not role names (§53, §54)
--
--    Reading a queue and deciding a thesis are different authorities, so they
--    are different permissions and an institution can hold them apart: a
--    coordinator who triages without approving is a real arrangement, and it
--    needs no code change to express.
--
--    TEMPLATE_MANAGER receives none of these, deliberately (§55). Writing the
--    rules a document is measured against and deciding a student's submission
--    are different jobs; the person who does the first does not automatically
--    do the second.
-- -----------------------------------------------------------------------------
INSERT INTO "role_permissions" ("role_id", "permission_id")
SELECT r."id", p."id"
FROM "roles" r
CROSS JOIN "permissions" p
WHERE r."code" IN ('ORGANIZATION_OWNER', 'ORGANIZATION_ADMIN', 'ORGANIZATION_REVIEWER')
  AND p."code" IN (
      'submission:review:read',
      'submission:evidence:read',
      'submission:decision:write',
      'submission:comment:write')
ON CONFLICT ("role_id", "permission_id") DO NOTHING;
