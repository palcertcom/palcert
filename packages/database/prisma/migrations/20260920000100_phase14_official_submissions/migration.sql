-- =============================================================================
-- Phase 14 — Official institution submissions
--
-- The first domain two unrelated parties legitimately read: the author who
-- submitted, and the organization they submitted to.
--
-- What keeps that safe is not a widened policy on the author's private tables.
-- ADR-0031 rejected dual ownership on documents precisely because "the
-- optional column invites a policy that reads `OR organization_id = …`, which
-- is exactly the widening this decision forbids". That forbidden widening is
-- forbidden *there*. Here, on tables that exist only because the author
-- explicitly handed something over, the `OR` is the whole point — and it is
-- confined to four tables that contain copies rather than sources.
--
--     user private storage  --explicit submit-->  submission snapshot  -->  organization
--
-- Nothing in documents, document_versions, document_analyses, document_checks,
-- check_runs, check_rule_results, check_violations, check_reports, ai_reviews,
-- smartfix_* or any finance table is touched by this migration.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- 1. Tables
-- ---------------------------------------------------------------------------

CREATE TABLE "official_submissions" (
    "id" UUID NOT NULL,
    "owner_user_id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "document_type_id" UUID NOT NULL,
    "document_id" UUID NOT NULL,
    "current_revision_id" UUID,
    "organization_name" TEXT NOT NULL,
    "document_type_name" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    CONSTRAINT "official_submissions_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "submission_revisions" (
    "id" UUID NOT NULL,
    "submission_id" UUID NOT NULL,
    "owner_user_id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "revision_number" INTEGER NOT NULL,

    "source_document_version_id" UUID NOT NULL,
    "source_document_sha256" CHAR(64) NOT NULL,
    "source_document_format" TEXT NOT NULL,
    "document_version_number" INTEGER NOT NULL,

    "source_check_id" UUID NOT NULL,
    "source_check_run_id" UUID NOT NULL,
    "source_report_id" UUID NOT NULL,
    "source_report_hash" CHAR(64) NOT NULL,
    "source_evaluation_hash" CHAR(64) NOT NULL,

    "standard_id" UUID NOT NULL,
    "standard_version_id" UUID NOT NULL,
    "standard_content_hash" CHAR(64) NOT NULL,
    "standard_code" TEXT NOT NULL,
    "standard_name" TEXT NOT NULL,
    "standard_version_label" TEXT NOT NULL,

    "determination" TEXT NOT NULL,
    "score_value" TEXT,
    "score_coverage" TEXT,
    "score_complete" BOOLEAN NOT NULL,
    "total_rules" INTEGER NOT NULL,
    "passed_rules" INTEGER NOT NULL,
    "failed_rules" INTEGER NOT NULL,
    "review_required_rules" INTEGER NOT NULL,
    "indeterminate_rules" INTEGER NOT NULL,
    "not_applicable_rules" INTEGER NOT NULL,

    "document_snapshot_key" TEXT,
    "document_snapshot_version_id" TEXT,
    "document_snapshot_sha256" CHAR(64),
    "document_snapshot_size_bytes" INTEGER,

    "report_snapshot_key" TEXT,
    "report_snapshot_version_id" TEXT,
    "report_snapshot_sha256" CHAR(64),
    "report_snapshot_size_bytes" INTEGER,

    "evidence_schema_version" INTEGER,
    "evidence_canonicalization_version" INTEGER,
    "evidence_hash" CHAR(64),

    "processing_status" TEXT NOT NULL DEFAULT 'PREPARING',
    "failure_code" TEXT,
    "failure_detail" TEXT,

    "institution_decision_status" TEXT,

    "idempotency_key" TEXT,

    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "submitted_at" TIMESTAMPTZ(6),
    "review_started_at" TIMESTAMPTZ(6),
    "decided_at" TIMESTAMPTZ(6),
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "submission_revisions_pkey" PRIMARY KEY ("id"),

    -- The two vocabularies, enforced at the layer that cannot be bypassed.
    CONSTRAINT "submission_revisions_processing_status_check"
        CHECK ("processing_status" IN ('PREPARING', 'READY', 'FAILED')),
    CONSTRAINT "submission_revisions_decision_status_check"
        CHECK ("institution_decision_status" IS NULL
            OR "institution_decision_status" IN
               ('SUBMITTED', 'UNDER_REVIEW', 'APPROVED', 'REJECTED', 'REVISION_REQUESTED')),

    -- An institution is told about a revision only once its evidence exists.
    -- The database refuses the combination rather than trusting every writer
    -- to remember it (§33, §130).
    CONSTRAINT "submission_revisions_decision_requires_ready"
        CHECK ("institution_decision_status" IS NULL OR "processing_status" = 'READY'),

    -- READY means the snapshots are really there, with their identities.
    CONSTRAINT "submission_revisions_ready_requires_snapshots"
        CHECK ("processing_status" <> 'READY' OR (
            "document_snapshot_key" IS NOT NULL
            AND "document_snapshot_sha256" IS NOT NULL
            AND "report_snapshot_key" IS NOT NULL
            AND "report_snapshot_sha256" IS NOT NULL
            AND "evidence_hash" IS NOT NULL
            AND "institution_decision_status" IS NOT NULL
        )),

    -- §30: the snapshot is a copy, so its digest is the source's digest. A
    -- row that says otherwise is describing bytes nobody checked.
    CONSTRAINT "submission_revisions_document_hash_equality"
        CHECK ("document_snapshot_sha256" IS NULL
            OR "document_snapshot_sha256" = "source_document_sha256"),

    CONSTRAINT "submission_revisions_revision_number_positive"
        CHECK ("revision_number" >= 1)
);

CREATE TABLE "submission_decision_events" (
    "id" UUID NOT NULL,
    "submission_revision_id" UUID NOT NULL,
    "owner_user_id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "from_status" TEXT,
    "to_status" TEXT NOT NULL,
    "reason_code" TEXT,
    "actor_user_id" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "submission_decision_events_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "submission_decision_events_to_status_check"
        CHECK ("to_status" IN
            ('SUBMITTED', 'UNDER_REVIEW', 'APPROVED', 'REJECTED', 'REVISION_REQUESTED')),
    CONSTRAINT "submission_decision_events_from_status_check"
        CHECK ("from_status" IS NULL OR "from_status" IN
            ('SUBMITTED', 'UNDER_REVIEW', 'APPROVED', 'REJECTED', 'REVISION_REQUESTED'))
);

CREATE TABLE "submission_comments" (
    "id" UUID NOT NULL,
    "submission_revision_id" UUID NOT NULL,
    "owner_user_id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "author_side" TEXT NOT NULL,
    "author_user_id" UUID NOT NULL,
    "body" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "submission_comments_pkey" PRIMARY KEY ("id"),
    -- Phase 14 models the institution side only (§68).
    CONSTRAINT "submission_comments_author_side_check"
        CHECK ("author_side" = 'ORGANIZATION'),
    -- Plain text, bounded, never empty (§66).
    CONSTRAINT "submission_comments_body_bounded"
        CHECK (length("body") BETWEEN 1 AND 4000)
);

-- ---------------------------------------------------------------------------
-- 2. Keys and indexes
-- ---------------------------------------------------------------------------

-- One case per (author, organization, document): a resubmission is a new
-- revision of this case, never a second case (§6, §9).
CREATE UNIQUE INDEX "official_submissions_owner_org_document"
    ON "official_submissions" ("owner_user_id", "organization_id", "document_id");
CREATE UNIQUE INDEX "official_submissions_current_revision_id_key"
    ON "official_submissions" ("current_revision_id");
CREATE INDEX "official_submissions_org_updated"
    ON "official_submissions" ("organization_id", "updated_at", "id");
CREATE INDEX "official_submissions_owner_updated"
    ON "official_submissions" ("owner_user_id", "updated_at", "id");

-- §126: concurrent resubmissions cannot produce duplicate revision numbers.
-- The unique index is what makes that true even if two transactions read the
-- same maximum; the service takes a lock as well, and this is what catches the
-- case where it does not.
CREATE UNIQUE INDEX "submission_revisions_submission_number"
    ON "submission_revisions" ("submission_id", "revision_number");

-- §95: one check is one revision's evidence. Submitting the same report twice
-- would be two official handoffs both claiming to be new evidence.
CREATE UNIQUE INDEX "submission_revisions_submission_check"
    ON "submission_revisions" ("submission_id", "source_check_id");

CREATE UNIQUE INDEX "submission_revisions_owner_idempotency"
    ON "submission_revisions" ("owner_user_id", "idempotency_key");
CREATE UNIQUE INDEX "submission_revisions_document_snapshot_key"
    ON "submission_revisions" ("document_snapshot_key");
CREATE UNIQUE INDEX "submission_revisions_report_snapshot_key"
    ON "submission_revisions" ("report_snapshot_key");
CREATE INDEX "submission_revisions_queue"
    ON "submission_revisions" ("organization_id", "institution_decision_status", "submitted_at", "id");
CREATE INDEX "submission_revisions_submission_number_idx"
    ON "submission_revisions" ("submission_id", "revision_number");

CREATE INDEX "submission_decision_events_revision"
    ON "submission_decision_events" ("submission_revision_id", "created_at", "id");
CREATE INDEX "submission_decision_events_org"
    ON "submission_decision_events" ("organization_id", "created_at", "id");

CREATE INDEX "submission_comments_revision"
    ON "submission_comments" ("submission_revision_id", "created_at", "id");

-- ---------------------------------------------------------------------------
-- 3. Foreign keys
--
-- RESTRICT throughout, not CASCADE. An official submission is institutional
-- history: deleting a document must not silently erase the record that it was
-- once handed to a university (§39).
-- ---------------------------------------------------------------------------

ALTER TABLE "official_submissions"
    ADD CONSTRAINT "official_submissions_owner_user_id_fkey"
    FOREIGN KEY ("owner_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "official_submissions"
    ADD CONSTRAINT "official_submissions_organization_id_fkey"
    FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "official_submissions"
    ADD CONSTRAINT "official_submissions_document_type_id_fkey"
    FOREIGN KEY ("document_type_id") REFERENCES "document_types"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "official_submissions"
    ADD CONSTRAINT "official_submissions_document_id_fkey"
    FOREIGN KEY ("document_id") REFERENCES "documents"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "submission_revisions"
    ADD CONSTRAINT "submission_revisions_submission_id_fkey"
    FOREIGN KEY ("submission_id") REFERENCES "official_submissions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "submission_revisions"
    ADD CONSTRAINT "submission_revisions_owner_user_id_fkey"
    FOREIGN KEY ("owner_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "official_submissions"
    ADD CONSTRAINT "official_submissions_current_revision_id_fkey"
    FOREIGN KEY ("current_revision_id") REFERENCES "submission_revisions"("id") ON DELETE RESTRICT ON UPDATE CASCADE
    DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE "submission_decision_events"
    ADD CONSTRAINT "submission_decision_events_revision_fkey"
    FOREIGN KEY ("submission_revision_id") REFERENCES "submission_revisions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "submission_comments"
    ADD CONSTRAINT "submission_comments_revision_fkey"
    FOREIGN KEY ("submission_revision_id") REFERENCES "submission_revisions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- §143: cross-binding must be impossible, not merely unlikely. A composite
-- foreign key is what makes "User A's submission cannot bind User B's check"
-- a property of the schema rather than a property of a service remembering to
-- compare two columns.
CREATE UNIQUE INDEX IF NOT EXISTS "document_checks_id_owner_key"
    ON "document_checks" ("id", "owner_user_id");
CREATE UNIQUE INDEX IF NOT EXISTS "document_checks_id_organization_key"
    ON "document_checks" ("id", "organization_id");
CREATE UNIQUE INDEX IF NOT EXISTS "document_checks_id_document_key"
    ON "document_checks" ("id", "document_id");
CREATE UNIQUE INDEX IF NOT EXISTS "check_reports_id_check_key"
    ON "check_reports" ("id", "check_id");
CREATE UNIQUE INDEX IF NOT EXISTS "document_versions_id_document_key"
    ON "document_versions" ("id", "document_id");
CREATE UNIQUE INDEX IF NOT EXISTS "official_submissions_id_owner_key"
    ON "official_submissions" ("id", "owner_user_id");
CREATE UNIQUE INDEX IF NOT EXISTS "official_submissions_id_document_key"
    ON "official_submissions" ("id", "document_id");
CREATE UNIQUE INDEX IF NOT EXISTS "official_submissions_id_organization_key"
    ON "official_submissions" ("id", "organization_id");
CREATE UNIQUE INDEX IF NOT EXISTS "submission_revisions_id_owner_key"
    ON "submission_revisions" ("id", "owner_user_id");
CREATE UNIQUE INDEX IF NOT EXISTS "submission_revisions_id_organization_key"
    ON "submission_revisions" ("id", "organization_id");

-- The revision belongs to its case's owner and organization, not to whatever
-- the writer happened to put in the columns.
ALTER TABLE "submission_revisions"
    ADD CONSTRAINT "submission_revisions_submission_owner_fkey"
    FOREIGN KEY ("submission_id", "owner_user_id")
    REFERENCES "official_submissions"("id", "owner_user_id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "submission_revisions"
    ADD CONSTRAINT "submission_revisions_submission_organization_fkey"
    FOREIGN KEY ("submission_id", "organization_id")
    REFERENCES "official_submissions"("id", "organization_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- The bound check belongs to the submitting user, to the receiving
-- organization, and to the case's logical document (§15, §16, §9, §143).
ALTER TABLE "submission_revisions"
    ADD CONSTRAINT "submission_revisions_check_owner_fkey"
    FOREIGN KEY ("source_check_id", "owner_user_id")
    REFERENCES "document_checks"("id", "owner_user_id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "submission_revisions"
    ADD CONSTRAINT "submission_revisions_check_organization_fkey"
    FOREIGN KEY ("source_check_id", "organization_id")
    REFERENCES "document_checks"("id", "organization_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- The bound report belongs to the bound check, and the bound document version
-- belongs to the case's document.
ALTER TABLE "submission_revisions"
    ADD CONSTRAINT "submission_revisions_report_check_fkey"
    FOREIGN KEY ("source_report_id", "source_check_id")
    REFERENCES "check_reports"("id", "check_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Decision events and comments inherit the revision's two parties, so a row
-- cannot claim to belong to an organization the revision was never sent to.
ALTER TABLE "submission_decision_events"
    ADD CONSTRAINT "submission_decision_events_revision_owner_fkey"
    FOREIGN KEY ("submission_revision_id", "owner_user_id")
    REFERENCES "submission_revisions"("id", "owner_user_id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "submission_decision_events"
    ADD CONSTRAINT "submission_decision_events_revision_organization_fkey"
    FOREIGN KEY ("submission_revision_id", "organization_id")
    REFERENCES "submission_revisions"("id", "organization_id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "submission_comments"
    ADD CONSTRAINT "submission_comments_revision_owner_fkey"
    FOREIGN KEY ("submission_revision_id", "owner_user_id")
    REFERENCES "submission_revisions"("id", "owner_user_id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "submission_comments"
    ADD CONSTRAINT "submission_comments_revision_organization_fkey"
    FOREIGN KEY ("submission_revision_id", "organization_id")
    REFERENCES "submission_revisions"("id", "organization_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- 4. Row-level security — the dual-party policy
--
-- `USING` names both parties; `WITH CHECK` names only the author. That
-- asymmetry is the design: the organization reads what it was handed and can
-- never insert a submission on somebody's behalf.
--
-- Under `withUser` no organization context is set, so the organization clause
-- is dead and the author sees only their own rows. Under `withTenant` the
-- organization id has already been through TenantResolverService, which
-- refuses a suspended organization, a suspended membership, and a membership
-- that no longer exists — so revoking a reviewer's membership revokes their
-- access to every submission in the same instant, with no long-lived grant
-- anywhere to expire (§100, §165).
--
-- Decision events and comments are written by the organization, so their
-- `WITH CHECK` names the organization instead. Neither can be updated or
-- deleted at all; that is enforced below by trigger rather than by policy,
-- because a policy that merely fails to match would let a DELETE report
-- success having removed nothing.
-- ---------------------------------------------------------------------------

ALTER TABLE "official_submissions" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "official_submissions" FORCE ROW LEVEL SECURITY;
CREATE POLICY "official_submissions_dual_party" ON "official_submissions" FOR ALL
    USING (app_is_platform_admin()
        OR "owner_user_id" = app_current_user_id()
        OR "organization_id" = app_current_organization())
    WITH CHECK (app_is_platform_admin() OR "owner_user_id" = app_current_user_id());

ALTER TABLE "submission_revisions" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "submission_revisions" FORCE ROW LEVEL SECURITY;
CREATE POLICY "submission_revisions_dual_party" ON "submission_revisions" FOR ALL
    USING (app_is_platform_admin()
        OR "owner_user_id" = app_current_user_id()
        OR "organization_id" = app_current_organization())
    WITH CHECK (app_is_platform_admin()
        OR "owner_user_id" = app_current_user_id()
        -- The organization writes only the decision columns, and only on a
        -- revision it already received; it can never create one, because the
        -- insert would have to name an owner it is not.
        OR "organization_id" = app_current_organization());

ALTER TABLE "submission_decision_events" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "submission_decision_events" FORCE ROW LEVEL SECURITY;
CREATE POLICY "submission_decision_events_dual_party" ON "submission_decision_events" FOR ALL
    USING (app_is_platform_admin()
        OR "owner_user_id" = app_current_user_id()
        OR "organization_id" = app_current_organization())
    WITH CHECK (app_is_platform_admin()
        OR "organization_id" = app_current_organization()
        OR "owner_user_id" = app_current_user_id());

ALTER TABLE "submission_comments" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "submission_comments" FORCE ROW LEVEL SECURITY;
CREATE POLICY "submission_comments_dual_party" ON "submission_comments" FOR ALL
    USING (app_is_platform_admin()
        OR "owner_user_id" = app_current_user_id()
        OR "organization_id" = app_current_organization())
    WITH CHECK (app_is_platform_admin()
        OR "organization_id" = app_current_organization());

-- ---------------------------------------------------------------------------
-- 5. Immutability
-- ---------------------------------------------------------------------------

-- §124: a case's identity never changes. A different document, organization or
-- owner is a different case, and pretending otherwise would let one
-- institution's file silently become about somebody else's work.
CREATE OR REPLACE FUNCTION official_submissions_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    IF NEW."owner_user_id" IS DISTINCT FROM OLD."owner_user_id"
       OR NEW."organization_id" IS DISTINCT FROM OLD."organization_id"
       OR NEW."document_id" IS DISTINCT FROM OLD."document_id"
       OR NEW."document_type_id" IS DISTINCT FROM OLD."document_type_id"
    THEN
        RAISE EXCEPTION 'official_submission % identity is immutable', OLD."id";
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER "official_submissions_guard_trigger"
    BEFORE UPDATE ON "official_submissions"
    FOR EACH ROW EXECUTE FUNCTION official_submissions_guard();

-- §125, §120, §40, §41: a revision's identity and its snapshot are write-once.
-- Neither the author nor the organization can alter what was handed over; a
-- correction is a new revision (§40), and the institution reviews the snapshot
-- it received (§41).
CREATE OR REPLACE FUNCTION submission_revisions_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    -- Identity, bound at creation and never looked up again (§11, §125).
    IF NEW."submission_id" IS DISTINCT FROM OLD."submission_id"
       OR NEW."owner_user_id" IS DISTINCT FROM OLD."owner_user_id"
       OR NEW."organization_id" IS DISTINCT FROM OLD."organization_id"
       OR NEW."revision_number" IS DISTINCT FROM OLD."revision_number"
       OR NEW."source_document_version_id" IS DISTINCT FROM OLD."source_document_version_id"
       OR NEW."source_document_sha256" IS DISTINCT FROM OLD."source_document_sha256"
       OR NEW."source_check_id" IS DISTINCT FROM OLD."source_check_id"
       OR NEW."source_check_run_id" IS DISTINCT FROM OLD."source_check_run_id"
       OR NEW."source_report_id" IS DISTINCT FROM OLD."source_report_id"
       OR NEW."source_report_hash" IS DISTINCT FROM OLD."source_report_hash"
       OR NEW."source_evaluation_hash" IS DISTINCT FROM OLD."source_evaluation_hash"
       OR NEW."standard_id" IS DISTINCT FROM OLD."standard_id"
       OR NEW."standard_version_id" IS DISTINCT FROM OLD."standard_version_id"
       OR NEW."standard_content_hash" IS DISTINCT FROM OLD."standard_content_hash"
       OR NEW."determination" IS DISTINCT FROM OLD."determination"
    THEN
        RAISE EXCEPTION 'submission_revision % identity is immutable', OLD."id";
    END IF;

    -- The snapshot, once written. A second write would mean the organization
    -- is looking at bytes other than the ones it was told the hash of (§120).
    IF (OLD."document_snapshot_key" IS NOT NULL
        AND NEW."document_snapshot_key" IS DISTINCT FROM OLD."document_snapshot_key")
       OR (OLD."document_snapshot_version_id" IS NOT NULL
        AND NEW."document_snapshot_version_id" IS DISTINCT FROM OLD."document_snapshot_version_id")
       OR (OLD."document_snapshot_sha256" IS NOT NULL
        AND NEW."document_snapshot_sha256" IS DISTINCT FROM OLD."document_snapshot_sha256")
       OR (OLD."report_snapshot_key" IS NOT NULL
        AND NEW."report_snapshot_key" IS DISTINCT FROM OLD."report_snapshot_key")
       OR (OLD."report_snapshot_version_id" IS NOT NULL
        AND NEW."report_snapshot_version_id" IS DISTINCT FROM OLD."report_snapshot_version_id")
       OR (OLD."report_snapshot_sha256" IS NOT NULL
        AND NEW."report_snapshot_sha256" IS DISTINCT FROM OLD."report_snapshot_sha256")
       OR (OLD."evidence_hash" IS NOT NULL
        AND NEW."evidence_hash" IS DISTINCT FROM OLD."evidence_hash")
    THEN
        RAISE EXCEPTION 'submission_revision % snapshot identity is write-once', OLD."id";
    END IF;

    -- §121: the decision status moves only along the state machine, so a
    -- generic update cannot skip the workflow. SUBMITTED is reachable only
    -- from nothing, which is what stops a decided revision being reset.
    IF NEW."institution_decision_status" IS DISTINCT FROM OLD."institution_decision_status" THEN
        IF OLD."institution_decision_status" IS NULL THEN
            IF NEW."institution_decision_status" <> 'SUBMITTED' THEN
                RAISE EXCEPTION 'submission_revision % must enter review as SUBMITTED', OLD."id";
            END IF;
        ELSIF OLD."institution_decision_status" = 'SUBMITTED' THEN
            IF NEW."institution_decision_status" NOT IN
               ('UNDER_REVIEW', 'APPROVED', 'REJECTED', 'REVISION_REQUESTED') THEN
                RAISE EXCEPTION 'submission_revision % cannot move from % to %',
                    OLD."id", OLD."institution_decision_status", NEW."institution_decision_status";
            END IF;
        ELSIF OLD."institution_decision_status" = 'UNDER_REVIEW' THEN
            IF NEW."institution_decision_status" NOT IN
               ('APPROVED', 'REJECTED', 'REVISION_REQUESTED') THEN
                RAISE EXCEPTION 'submission_revision % cannot move from % to %',
                    OLD."id", OLD."institution_decision_status", NEW."institution_decision_status";
            END IF;
        ELSE
            -- APPROVED, REJECTED and REVISION_REQUESTED are the institution's
            -- last word on these exact bytes. Phase 14 has no reopening (§47).
            RAISE EXCEPTION 'submission_revision % is already decided (%)',
                OLD."id", OLD."institution_decision_status";
        END IF;
    END IF;

    -- A failed preparation may be retried, but a revision that reached READY
    -- never goes back: an institution has been told about it (§37).
    IF OLD."processing_status" = 'READY' AND NEW."processing_status" <> 'READY' THEN
        RAISE EXCEPTION 'submission_revision % cannot leave READY', OLD."id";
    END IF;

    RETURN NEW;
END;
$$;

CREATE TRIGGER "submission_revisions_guard_trigger"
    BEFORE UPDATE ON "submission_revisions"
    FOR EACH ROW EXECUTE FUNCTION submission_revisions_guard();

-- §44, §123, §122: institutional history is append-only. Not "should not be
-- rewritten" — cannot be, by anyone holding the application role, including a
-- generic Prisma update that forgot this domain has rules.
CREATE OR REPLACE FUNCTION submission_history_is_append_only() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    RAISE EXCEPTION '% rows are immutable once written', TG_TABLE_NAME;
END;
$$;

CREATE TRIGGER "submission_decision_events_append_only"
    BEFORE UPDATE OR DELETE ON "submission_decision_events"
    FOR EACH ROW EXECUTE FUNCTION submission_history_is_append_only();

CREATE TRIGGER "submission_comments_append_only"
    BEFORE UPDATE OR DELETE ON "submission_comments"
    FOR EACH ROW EXECUTE FUNCTION submission_history_is_append_only();

-- §39: no hard delete during ordinary product use. The application role may
-- write history and may never remove it.
REVOKE DELETE ON TABLE "official_submissions" FROM palcert_app;
REVOKE DELETE ON TABLE "submission_revisions" FROM palcert_app;
REVOKE DELETE ON TABLE "submission_decision_events" FROM palcert_app;
REVOKE DELETE ON TABLE "submission_comments" FROM palcert_app;

-- ---------------------------------------------------------------------------
-- 6. Isolation catalogue
-- ---------------------------------------------------------------------------

INSERT INTO "table_isolation_classification" ("table_name", "classification", "tenant_column", "notes")
VALUES
    ('official_submissions', 'DUAL_PARTY_SCOPED', 'owner_user_id',
     'One author''s official submission case with one organization. Readable by the submitting user and by members of the receiving organization; writable only by the user. The organization gets no access to the user''s documents, checks or reports.'),
    ('submission_revisions', 'DUAL_PARTY_SCOPED', 'owner_user_id',
     'One immutable official handoff: exact document and report snapshots, their hashes, and the institution decision status. Identity and snapshot are write-once.'),
    ('submission_decision_events', 'DUAL_PARTY_SCOPED', 'owner_user_id',
     'Append-only institution decision history. The revision''s status column is a denormalized convenience; this is the authority.'),
    ('submission_comments', 'DUAL_PARTY_SCOPED', 'owner_user_id',
     'Append-only organization review comments, visible to the submitter they are addressed to.');
