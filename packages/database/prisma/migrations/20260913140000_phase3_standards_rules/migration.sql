-- ===========================================================================
-- Phase 3 — Document types, standards, standard versions and rules
--
-- Structure of this file:
--
--   0. Generated DDL (tables, indexes, single-column foreign keys)
--   1. Composite foreign keys carrying organization_id
--   2. Check constraints for invariants the application also enforces
--   3. Published immutability triggers
--   4. Table isolation classification entries
--   5. Row-level security
--   6. Grants for the least-privileged application role
--   7. Standards permission seeding
--
-- Two statements the generator wanted have been removed by hand, exactly as in
-- Phase 2: `prisma migrate diff` re-emits DROPs for the composite foreign keys
-- on `user_roles` / `organization_invitations` and for
-- `table_isolation_classification`, because Prisma's schema language cannot
-- model them and so believes they are drift. Applying those drops would silently
-- delete two tenant guarantees and the RLS coverage catalogue. This is a known,
-- recurring property of the workflow and is documented in
-- docs/architecture/development-setup.md.
-- ===========================================================================

-- ===========================================================================
-- 0. Generated DDL
-- ===========================================================================

-- CreateEnum
CREATE TYPE "DocumentSystemCategory" AS ENUM ('THESIS', 'DISSERTATION', 'JOURNAL_ARTICLE', 'CONFERENCE_PAPER', 'BOOK', 'BOOK_CHAPTER', 'TECHNICAL_REPORT', 'GRANT_PROPOSAL', 'RESEARCH_PROPOSAL', 'GRADUATION_PROJECT', 'COURSE_ASSIGNMENT', 'ADMINISTRATIVE_DOCUMENT', 'OTHER');

-- CreateEnum
CREATE TYPE "DocumentTypeStatus" AS ENUM ('ACTIVE', 'ARCHIVED');

-- CreateEnum
CREATE TYPE "StandardStatus" AS ENUM ('ACTIVE', 'ARCHIVED');

-- CreateEnum
CREATE TYPE "StandardVersionStatus" AS ENUM ('DRAFT', 'PUBLISHED', 'ARCHIVED');

-- CreateEnum
CREATE TYPE "RuleCategory" AS ENUM ('PAGE_SETUP', 'MARGINS', 'TYPOGRAPHY', 'SPACING', 'ALIGNMENT', 'PAGINATION', 'HEADINGS', 'TITLE_PAGE', 'ABSTRACT', 'KEYWORDS', 'TABLE_OF_CONTENTS', 'SECTION_STRUCTURE', 'TABLES', 'FIGURES', 'CAPTIONS', 'EQUATIONS', 'CITATIONS', 'REFERENCES', 'LANGUAGE_QUALITY', 'TERMINOLOGY', 'RESEARCH_ETHICS', 'DOCUMENT_METADATA', 'FILE_TECHNICAL');

-- CreateEnum
CREATE TYPE "RuleEvaluationMode" AS ENUM ('DETERMINISTIC', 'AI_ASSISTED', 'MANUAL');

-- CreateEnum
CREATE TYPE "RuleOperator" AS ENUM ('EQUALS', 'NOT_EQUALS', 'GREATER_THAN', 'GREATER_THAN_OR_EQUAL', 'LESS_THAN', 'LESS_THAN_OR_EQUAL', 'BETWEEN', 'IN', 'NOT_IN', 'CONTAINS', 'NOT_CONTAINS', 'MATCHES_PATTERN', 'EXISTS', 'NOT_EXISTS');

-- CreateEnum
CREATE TYPE "RuleSeverity" AS ENUM ('INFO', 'MINOR', 'MAJOR', 'CRITICAL');

-- CreateEnum
CREATE TYPE "RuleAutofixCapability" AS ENUM ('NONE', 'SAFE', 'ADVANCED');

-- CreateEnum
CREATE TYPE "RuleOrigin" AS ENUM ('ORGANIZATION_POLICY', 'NATIONAL_REGULATION', 'PUBLISHER_GUIDELINE', 'STYLE_GUIDE', 'ACCESSIBILITY_STANDARD', 'PALCERT_TEMPLATE', 'OTHER');

-- CreateEnum
CREATE TYPE "RuleUnit" AS ENUM ('COUNT', 'MILLIMETRE', 'CENTIMETRE', 'INCH', 'POINT', 'PIXEL', 'PERCENT', 'LINES', 'WORDS', 'CHARACTERS', 'PAGES', 'MEGABYTE', 'DPI');

-- CreateTable
CREATE TABLE "document_types" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "system_category" "DocumentSystemCategory" NOT NULL,
    "name" TEXT NOT NULL,
    "name_ar" TEXT,
    "description" TEXT,
    "description_ar" TEXT,
    "status" "DocumentTypeStatus" NOT NULL DEFAULT 'ACTIVE',
    "created_by_user_id" UUID NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "archived_at" TIMESTAMP(3),

    CONSTRAINT "document_types_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "standards" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "document_type_id" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "name_en" TEXT NOT NULL,
    "name_ar" TEXT NOT NULL,
    "description_en" TEXT,
    "description_ar" TEXT,
    "status" "StandardStatus" NOT NULL DEFAULT 'ACTIVE',
    "created_by_user_id" UUID NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "archived_at" TIMESTAMP(3),

    CONSTRAINT "standards_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "standard_versions" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "standard_id" UUID NOT NULL,
    "version_label" TEXT NOT NULL,
    "status" "StandardVersionStatus" NOT NULL DEFAULT 'DRAFT',
    "effective_from" TIMESTAMP(3),
    "effective_until" TIMESTAMP(3),
    "content_hash" TEXT,
    "canonicalization_version" INTEGER,
    "rule_schema_version" INTEGER NOT NULL DEFAULT 1,
    "revision" INTEGER NOT NULL DEFAULT 1,
    "published_at" TIMESTAMP(3),
    "published_by_user_id" UUID,
    "archived_at" TIMESTAMP(3),
    "cloned_from_version_id" UUID,
    "created_by_user_id" UUID NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "standard_versions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "standard_rules" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "standard_version_id" UUID NOT NULL,
    "rule_code" TEXT NOT NULL,
    "category" "RuleCategory" NOT NULL,
    "evaluation_mode" "RuleEvaluationMode" NOT NULL,
    "scope" JSONB NOT NULL,
    "operator" "RuleOperator" NOT NULL,
    "expected_value" JSONB NOT NULL,
    "unit" "RuleUnit",
    "tolerance" DECIMAL(12,4),
    "severity" "RuleSeverity" NOT NULL,
    "blocking" BOOLEAN NOT NULL DEFAULT false,
    "autofix" "RuleAutofixCapability" NOT NULL DEFAULT 'NONE',
    "origin" "RuleOrigin" NOT NULL DEFAULT 'ORGANIZATION_POLICY',
    "origin_reference" TEXT,
    "title_en" TEXT NOT NULL,
    "title_ar" TEXT NOT NULL,
    "description_en" TEXT,
    "description_ar" TEXT,
    "guidance_en" TEXT,
    "guidance_ar" TEXT,
    "display_order" INTEGER NOT NULL,
    "rule_schema_version" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "standard_rules_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "standard_version_snapshots" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "standard_version_id" UUID NOT NULL,
    "canonical" JSONB NOT NULL,
    "content_hash" TEXT NOT NULL,
    "canonicalization_version" INTEGER NOT NULL,
    "rule_schema_version" INTEGER NOT NULL,
    "rule_count" INTEGER NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "standard_version_snapshots_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "document_types_organization_id_status_idx" ON "document_types"("organization_id", "status");

-- CreateIndex
CREATE INDEX "document_types_organization_id_name_id_idx" ON "document_types"("organization_id", "name", "id");

-- CreateIndex
CREATE UNIQUE INDEX "document_types_id_org_key" ON "document_types"("id", "organization_id");

-- CreateIndex
CREATE INDEX "standards_organization_id_status_idx" ON "standards"("organization_id", "status");

-- CreateIndex
CREATE INDEX "standards_organization_id_created_at_id_idx" ON "standards"("organization_id", "created_at", "id");

-- CreateIndex
CREATE INDEX "standards_document_type_id_idx" ON "standards"("document_type_id");

-- CreateIndex
CREATE UNIQUE INDEX "standards_organization_id_code_key" ON "standards"("organization_id", "code");

-- CreateIndex
CREATE UNIQUE INDEX "standards_id_org_key" ON "standards"("id", "organization_id");

-- CreateIndex
CREATE INDEX "standard_versions_organization_id_status_idx" ON "standard_versions"("organization_id", "status");

-- CreateIndex
CREATE INDEX "standard_versions_standard_id_status_idx" ON "standard_versions"("standard_id", "status");

-- CreateIndex
CREATE INDEX "standard_versions_standard_id_created_at_id_idx" ON "standard_versions"("standard_id", "created_at", "id");

-- CreateIndex
CREATE INDEX "standard_versions_content_hash_idx" ON "standard_versions"("content_hash");

-- CreateIndex
CREATE UNIQUE INDEX "standard_versions_standard_id_version_label_key" ON "standard_versions"("standard_id", "version_label");

-- CreateIndex
CREATE UNIQUE INDEX "standard_versions_id_org_key" ON "standard_versions"("id", "organization_id");

-- CreateIndex
CREATE INDEX "standard_rules_organization_id_idx" ON "standard_rules"("organization_id");

-- CreateIndex
CREATE INDEX "standard_rules_standard_version_id_display_order_id_idx" ON "standard_rules"("standard_version_id", "display_order", "id");

-- CreateIndex
CREATE INDEX "standard_rules_standard_version_id_category_idx" ON "standard_rules"("standard_version_id", "category");

-- CreateIndex
CREATE UNIQUE INDEX "standard_rules_standard_version_id_rule_code_key" ON "standard_rules"("standard_version_id", "rule_code");

-- CreateIndex
CREATE UNIQUE INDEX "standard_version_snapshots_standard_version_id_key" ON "standard_version_snapshots"("standard_version_id");

-- CreateIndex
CREATE INDEX "standard_version_snapshots_organization_id_idx" ON "standard_version_snapshots"("organization_id");

-- CreateIndex
CREATE INDEX "standard_version_snapshots_content_hash_idx" ON "standard_version_snapshots"("content_hash");

-- AddForeignKey
ALTER TABLE "document_types" ADD CONSTRAINT "document_types_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "document_types" ADD CONSTRAINT "document_types_created_by_user_id_fkey" FOREIGN KEY ("created_by_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "standards" ADD CONSTRAINT "standards_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "standards" ADD CONSTRAINT "standards_document_type_id_fkey" FOREIGN KEY ("document_type_id") REFERENCES "document_types"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "standards" ADD CONSTRAINT "standards_created_by_user_id_fkey" FOREIGN KEY ("created_by_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "standard_versions" ADD CONSTRAINT "standard_versions_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "standard_versions" ADD CONSTRAINT "standard_versions_standard_id_fkey" FOREIGN KEY ("standard_id") REFERENCES "standards"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "standard_versions" ADD CONSTRAINT "standard_versions_created_by_user_id_fkey" FOREIGN KEY ("created_by_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "standard_versions" ADD CONSTRAINT "standard_versions_published_by_user_id_fkey" FOREIGN KEY ("published_by_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "standard_versions" ADD CONSTRAINT "standard_versions_cloned_from_version_id_fkey" FOREIGN KEY ("cloned_from_version_id") REFERENCES "standard_versions"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "standard_rules" ADD CONSTRAINT "standard_rules_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "standard_rules" ADD CONSTRAINT "standard_rules_standard_version_id_fkey" FOREIGN KEY ("standard_version_id") REFERENCES "standard_versions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "standard_version_snapshots" ADD CONSTRAINT "standard_version_snapshots_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "standard_version_snapshots" ADD CONSTRAINT "standard_version_snapshots_standard_version_id_fkey" FOREIGN KEY ("standard_version_id") REFERENCES "standard_versions"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- ===========================================================================
-- 1. Composite foreign keys carrying organization_id
--
--    This is the structural defence against cross-tenant parent injection: a
--    caller who POSTs a rule naming another tenant's standardVersionId, or a
--    standard naming another tenant's documentTypeId, is refused by the
--    database rather than by a check the application must remember to write.
--
--    Each child already carries `organization_id` (denormalized so that every
--    RLS policy is a single-column comparison). These constraints are what
--    keep that column honest: the pair (parent_id, organization_id) must exist
--    on the parent, so a child can never sit in one tenant while pointing at a
--    parent in another.
--
--    The single-column foreign keys the generator emitted are kept as well.
--    They are what makes ON DELETE behaviour work; these add the tenant half.
-- ===========================================================================

ALTER TABLE "standards"
    ADD CONSTRAINT "standards_document_type_org_fkey"
    FOREIGN KEY ("document_type_id", "organization_id")
    REFERENCES "document_types" ("id", "organization_id")
    ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "standard_versions"
    ADD CONSTRAINT "standard_versions_standard_org_fkey"
    FOREIGN KEY ("standard_id", "organization_id")
    REFERENCES "standards" ("id", "organization_id")
    ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "standard_rules"
    ADD CONSTRAINT "standard_rules_version_org_fkey"
    FOREIGN KEY ("standard_version_id", "organization_id")
    REFERENCES "standard_versions" ("id", "organization_id")
    ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "standard_version_snapshots"
    ADD CONSTRAINT "standard_version_snapshots_version_org_fkey"
    FOREIGN KEY ("standard_version_id", "organization_id")
    REFERENCES "standard_versions" ("id", "organization_id")
    ON DELETE CASCADE ON UPDATE CASCADE;

-- A clone must come from the same tenant. Without this, `cloned_from_version_id`
-- would be a readable pointer into another organization's history.
ALTER TABLE "standard_versions"
    ADD CONSTRAINT "standard_versions_cloned_from_org_fkey"
    FOREIGN KEY ("cloned_from_version_id", "organization_id")
    REFERENCES "standard_versions" ("id", "organization_id")
    ON DELETE SET NULL ON UPDATE CASCADE;

-- ===========================================================================
-- 2. Invariants
--
--    Each of these is also enforced in the application, where it can produce a
--    good error message. They are repeated here because the application is one
--    bug away from being wrong, and because a hand-run UPDATE during an
--    incident is exactly when these invariants matter most.
-- ===========================================================================

-- A version label is a label, not an identity, but an empty one is useless.
ALTER TABLE "standard_versions"
    ADD CONSTRAINT "standard_versions_label_not_blank"
    CHECK (btrim("version_label") <> '');

-- An effective window must not run backwards.
ALTER TABLE "standard_versions"
    ADD CONSTRAINT "standard_versions_effective_window"
    CHECK (
        "effective_from" IS NULL
        OR "effective_until" IS NULL
        OR "effective_from" <= "effective_until"
    );

-- The three publication fields move together, always.
--
--   DRAFT      none of them set -- so a failed publish cannot leave a stale
--              hash behind on a version that is still being edited.
--   PUBLISHED  all three set.
--   ARCHIVED   all three, or none: a version archived after publication keeps
--              its hash forever, while an abandoned draft archived without ever
--              being published never had one.
ALTER TABLE "standard_versions"
    ADD CONSTRAINT "standard_versions_publication_fields"
    CHECK (
        CASE "status"
            WHEN 'DRAFT' THEN
                "content_hash" IS NULL AND "canonicalization_version" IS NULL
                AND "published_at" IS NULL
            WHEN 'PUBLISHED' THEN
                "content_hash" IS NOT NULL AND "canonicalization_version" IS NOT NULL
                AND "published_at" IS NOT NULL
            ELSE
                (
                    "content_hash" IS NOT NULL AND "canonicalization_version" IS NOT NULL
                    AND "published_at" IS NOT NULL
                )
                OR (
                    "content_hash" IS NULL AND "canonicalization_version" IS NULL
                    AND "published_at" IS NULL
                )
        END
    );

-- The hash format is part of the contract, so a malformed value can never be
-- stored and later fail verification for the wrong reason.
ALTER TABLE "standard_versions"
    ADD CONSTRAINT "standard_versions_content_hash_format"
    CHECK ("content_hash" IS NULL OR "content_hash" ~ '^sha256:[0-9a-f]{64}$');

ALTER TABLE "standard_version_snapshots"
    ADD CONSTRAINT "standard_version_snapshots_content_hash_format"
    CHECK ("content_hash" ~ '^sha256:[0-9a-f]{64}$');

-- A snapshot with no rules would certify nothing.
ALTER TABLE "standard_version_snapshots"
    ADD CONSTRAINT "standard_version_snapshots_rule_count_positive"
    CHECK ("rule_count" > 0);

ALTER TABLE "standard_versions"
    ADD CONSTRAINT "standard_versions_revision_positive"
    CHECK ("revision" >= 1);

-- Only a deterministic, reproducible measurement may block certification
-- (ADR-0002). A model's judgement must never be able to.
ALTER TABLE "standard_rules"
    ADD CONSTRAINT "standard_rules_blocking_requires_deterministic"
    CHECK ("blocking" = false OR "evaluation_mode" = 'DETERMINISTIC');

-- A question put to a human cannot be answered by an automatic fix.
ALTER TABLE "standard_rules"
    ADD CONSTRAINT "standard_rules_manual_has_no_autofix"
    CHECK ("evaluation_mode" <> 'MANUAL' OR "autofix" = 'NONE');

ALTER TABLE "standard_rules"
    ADD CONSTRAINT "standard_rules_tolerance_non_negative"
    CHECK ("tolerance" IS NULL OR "tolerance" >= 0);

ALTER TABLE "standard_rules"
    ADD CONSTRAINT "standard_rules_display_order_non_negative"
    CHECK ("display_order" >= 0);

-- `ruleCode` is quoted verbatim in findings and reports; the shape is part of
-- the contract, not a presentation detail.
ALTER TABLE "standard_rules"
    ADD CONSTRAINT "standard_rules_code_format"
    CHECK ("rule_code" ~ '^[A-Z][A-Z0-9]*(\.[A-Z0-9]+)*$');

ALTER TABLE "standard_rules"
    ADD CONSTRAINT "standard_rules_titles_not_blank"
    CHECK (btrim("title_en") <> '' AND btrim("title_ar") <> '');

-- `scope` and `expected_value` are the only JSONB columns in the model. They
-- must at least be objects carrying their discriminant: a bare string or array
-- there would mean the versioned contract was bypassed entirely.
ALTER TABLE "standard_rules"
    ADD CONSTRAINT "standard_rules_scope_is_discriminated_object"
    CHECK (jsonb_typeof("scope") = 'object' AND "scope" ? 'kind');

ALTER TABLE "standard_rules"
    ADD CONSTRAINT "standard_rules_expected_is_discriminated_object"
    CHECK (jsonb_typeof("expected_value") = 'object' AND "expected_value" ? 'type');

ALTER TABLE "standard_version_snapshots"
    ADD CONSTRAINT "standard_version_snapshots_canonical_is_object"
    CHECK (jsonb_typeof("canonical") = 'object');

ALTER TABLE "standards"
    ADD CONSTRAINT "standards_code_format"
    CHECK ("code" ~ '^[A-Z][A-Z0-9]*([._-][A-Z0-9]+)*$');

ALTER TABLE "standards"
    ADD CONSTRAINT "standards_names_not_blank"
    CHECK (btrim("name_en") <> '' AND btrim("name_ar") <> '');

ALTER TABLE "document_types"
    ADD CONSTRAINT "document_types_name_not_blank"
    CHECK (btrim("name") <> '');

-- A document type's name is unique within its organization, case-insensitively:
-- "Master's Thesis" and "master's thesis" are the same thing to a human, and a
-- picker showing both is a bug report waiting to happen.
CREATE UNIQUE INDEX "document_types_org_name_key"
    ON "document_types" ("organization_id", lower("name"));

-- At most one published version may be in force per standard at a time. A
-- partial unique index rather than a trigger: it is checked by the same
-- mechanism that checks every other uniqueness constraint, and it costs nothing.
CREATE UNIQUE INDEX "standard_versions_one_published_per_standard"
    ON "standard_versions" ("standard_id")
    WHERE "status" = 'PUBLISHED';

-- ===========================================================================
-- 3. Published immutability
--
--    A published standard version has been used to judge real documents. If it
--    could still be edited, every past result would silently change meaning and
--    every issued certificate would become a claim about something that no
--    longer exists.
--
--    The services enforce this. These triggers enforce it again, because the
--    guarantee has to hold against a bug in a service, a future endpoint whose
--    author did not know, and a hand-run UPDATE during an incident — which is
--    exactly the moment someone is most likely to reach for one.
--
--    The supported way to change a published standard is clone -> edit the new
--    draft -> publish.
-- ===========================================================================

CREATE OR REPLACE FUNCTION standard_versions_freeze() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    IF TG_OP = 'DELETE' THEN
        IF OLD."status" <> 'DRAFT' THEN
            RAISE EXCEPTION
                'standard_version % is % and cannot be deleted; archive it instead',
                OLD."id", OLD."status"
                USING ERRCODE = 'restrict_violation';
        END IF;
        RETURN OLD;
    END IF;

    -- A draft is freely editable; everything below governs what may happen
    -- after publication.
    IF OLD."status" = 'DRAFT' THEN
        RETURN NEW;
    END IF;

    IF OLD."status" = 'ARCHIVED' THEN
        RAISE EXCEPTION 'standard_version % is archived and cannot be modified', OLD."id"
            USING ERRCODE = 'restrict_violation';
    END IF;

    -- OLD.status = 'PUBLISHED'. The only permitted transition is to ARCHIVED,
    -- and the only fields that may move with it are the ones that record the
    -- archiving itself. Everything that defines *what the standard says* is
    -- compared explicitly rather than trusted to a blanket rule.
    IF NEW."status" NOT IN ('PUBLISHED', 'ARCHIVED') THEN
        RAISE EXCEPTION
            'standard_version % is published; it cannot return to %',
            OLD."id", NEW."status"
            USING ERRCODE = 'restrict_violation';
    END IF;

    IF NEW."content_hash" IS DISTINCT FROM OLD."content_hash"
        OR NEW."canonicalization_version" IS DISTINCT FROM OLD."canonicalization_version"
        OR NEW."rule_schema_version" IS DISTINCT FROM OLD."rule_schema_version"
        OR NEW."version_label" IS DISTINCT FROM OLD."version_label"
        OR NEW."standard_id" IS DISTINCT FROM OLD."standard_id"
        OR NEW."organization_id" IS DISTINCT FROM OLD."organization_id"
        OR NEW."effective_from" IS DISTINCT FROM OLD."effective_from"
        OR NEW."effective_until" IS DISTINCT FROM OLD."effective_until"
        OR NEW."published_at" IS DISTINCT FROM OLD."published_at"
        OR NEW."published_by_user_id" IS DISTINCT FROM OLD."published_by_user_id"
        OR NEW."cloned_from_version_id" IS DISTINCT FROM OLD."cloned_from_version_id"
    THEN
        RAISE EXCEPTION
            'standard_version % is published; only archiving may change it', OLD."id"
            USING ERRCODE = 'restrict_violation';
    END IF;

    RETURN NEW;
END;
$$;

CREATE TRIGGER "standard_versions_freeze"
    BEFORE UPDATE OR DELETE ON "standard_versions"
    FOR EACH ROW EXECUTE FUNCTION standard_versions_freeze();

CREATE OR REPLACE FUNCTION standard_rules_freeze() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
    v_id     uuid;
    v_status "StandardVersionStatus";
BEGIN
    v_id := COALESCE(NEW."standard_version_id", OLD."standard_version_id");

    SELECT "status" INTO v_status FROM "standard_versions" WHERE "id" = v_id;

    -- No parent row is visible. That happens legitimately when the parent is
    -- being deleted and this DELETE is the cascade, so it is not an error here;
    -- the foreign key is what guarantees a rule cannot exist without a version.
    IF v_status IS NULL THEN
        RETURN COALESCE(NEW, OLD);
    END IF;

    IF v_status <> 'DRAFT' THEN
        RAISE EXCEPTION
            'standard_version % is %; its rules are frozen. Clone it to make changes.',
            v_id, v_status
            USING ERRCODE = 'restrict_violation';
    END IF;

    RETURN COALESCE(NEW, OLD);
END;
$$;

CREATE TRIGGER "standard_rules_freeze"
    BEFORE INSERT OR UPDATE OR DELETE ON "standard_rules"
    FOR EACH ROW EXECUTE FUNCTION standard_rules_freeze();

-- The snapshot is the evidence. It is written once, at publication, and is
-- append-only thereafter: if it could be rewritten, recomputing the hash from
-- it would prove nothing.
CREATE OR REPLACE FUNCTION standard_version_snapshots_append_only() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    RAISE EXCEPTION 'standard_version_snapshots is append-only (attempted %)', TG_OP
        USING ERRCODE = 'restrict_violation';
END;
$$;

-- DELETE is deliberately absent from this trigger: deleting an organization or
-- a standard must still cascade. What is forbidden is rewriting a snapshot in
-- place, or deleting one while its version survives — which the foreign key
-- makes impossible anyway.
CREATE TRIGGER "standard_version_snapshots_append_only"
    BEFORE UPDATE ON "standard_version_snapshots"
    FOR EACH ROW EXECUTE FUNCTION standard_version_snapshots_append_only();

-- ===========================================================================
-- 4. Table isolation classification
--
--    Adding these rows is not optional bookkeeping: the Phase 2 RLS coverage
--    test reads this catalogue and fails CI for any table in the schema that is
--    unclassified, or classified TENANT_SCOPED without RLS, FORCE RLS and full
--    policy coverage. That test is what makes this section impossible to forget.
-- ===========================================================================
INSERT INTO "table_isolation_classification" ("table_name", "classification", "tenant_column", "notes") VALUES
    ('document_types',             'TENANT_SCOPED', 'organization_id', 'Organization-defined document taxonomy.'),
    ('standards',                  'TENANT_SCOPED', 'organization_id', 'Composite FK to document_types(id, organization_id) blocks cross-tenant parents.'),
    ('standard_versions',          'TENANT_SCOPED', 'organization_id', 'Published rows are additionally frozen by the standard_versions_freeze trigger.'),
    ('standard_rules',             'TENANT_SCOPED', 'organization_id', 'Frozen once the parent version is published.'),
    ('standard_version_snapshots', 'TENANT_SCOPED', 'organization_id', 'Append-only published evidence; the content hash is computed over it.');

-- ===========================================================================
-- 5. Row-level security
--
--    Same shape as Phase 2, and for the same reason: application authorization
--    decides every request, and these policies are what stops a bug in that
--    layer from becoming a cross-tenant data leak.
--
--    FORCE is set on every table because the tables are owned by the migration
--    role, and PostgreSQL exempts an owner from its own policies unless forced.
--
--    Each policy is a single-column comparison against `organization_id`. There
--    is deliberately no join to a parent: a policy that resolved the tenant
--    through `standard_versions` would be both slower and dependent on that
--    parent's own policy, and a subtle mistake there would silently widen
--    access here.
-- ===========================================================================

-- --- document_types --------------------------------------------------------
ALTER TABLE "document_types" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "document_types" FORCE ROW LEVEL SECURITY;

CREATE POLICY "document_types_all" ON "document_types" FOR ALL
    USING (app_is_platform_admin() OR "organization_id" = app_current_organization())
    WITH CHECK (app_is_platform_admin() OR "organization_id" = app_current_organization());

-- --- standards -------------------------------------------------------------
ALTER TABLE "standards" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "standards" FORCE ROW LEVEL SECURITY;

CREATE POLICY "standards_all" ON "standards" FOR ALL
    USING (app_is_platform_admin() OR "organization_id" = app_current_organization())
    WITH CHECK (app_is_platform_admin() OR "organization_id" = app_current_organization());

-- --- standard_versions -----------------------------------------------------
ALTER TABLE "standard_versions" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "standard_versions" FORCE ROW LEVEL SECURITY;

CREATE POLICY "standard_versions_all" ON "standard_versions" FOR ALL
    USING (app_is_platform_admin() OR "organization_id" = app_current_organization())
    WITH CHECK (app_is_platform_admin() OR "organization_id" = app_current_organization());

-- --- standard_rules --------------------------------------------------------
ALTER TABLE "standard_rules" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "standard_rules" FORCE ROW LEVEL SECURITY;

CREATE POLICY "standard_rules_all" ON "standard_rules" FOR ALL
    USING (app_is_platform_admin() OR "organization_id" = app_current_organization())
    WITH CHECK (app_is_platform_admin() OR "organization_id" = app_current_organization());

-- --- standard_version_snapshots --------------------------------------------
ALTER TABLE "standard_version_snapshots" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "standard_version_snapshots" FORCE ROW LEVEL SECURITY;

CREATE POLICY "standard_version_snapshots_all" ON "standard_version_snapshots" FOR ALL
    USING (app_is_platform_admin() OR "organization_id" = app_current_organization())
    WITH CHECK (app_is_platform_admin() OR "organization_id" = app_current_organization());

-- ===========================================================================
-- 6. Grants
--
--    Phase 2 set ALTER DEFAULT PRIVILEGES, so these tables are already reachable
--    by the application role. The grants are repeated explicitly because default
--    privileges only apply to objects created by the role that set them, and a
--    migration that silently depends on who ran the previous one is a migration
--    that fails in someone else's environment.
--
--    Still no DDL: the application cannot drop a policy, disable RLS, or remove
--    the freeze triggers on itself.
-- ===========================================================================
GRANT SELECT, INSERT, UPDATE, DELETE ON
    "document_types", "standards", "standard_versions",
    "standard_rules", "standard_version_snapshots"
    TO palcert_app;

GRANT EXECUTE ON FUNCTION standard_versions_freeze() TO palcert_app;
GRANT EXECUTE ON FUNCTION standard_rules_freeze() TO palcert_app;
GRANT EXECUTE ON FUNCTION standard_version_snapshots_append_only() TO palcert_app;

-- ===========================================================================
-- 7. Standards permissions
--
--    `standard:version:publish` is a permission of its own rather than part of
--    `standard:version:update`, because authoring a standard and putting it
--    into force are different acts. Nothing here grants publish without also
--    granting edit; the separation exists so the reverse can be expressed.
--
--    The reviewer role gains reads only. A reviewer must be able to see what a
--    submission is judged against, and must never be able to change it.
-- ===========================================================================
INSERT INTO "permissions" ("id", "code", "description") VALUES
    (gen_random_uuid(), 'standard:document-type:read',   'Read the organization document types'),
    (gen_random_uuid(), 'standard:document-type:manage', 'Create, edit and archive document types'),
    (gen_random_uuid(), 'standard:definition:read',      'Read standards, versions and rules'),
    (gen_random_uuid(), 'standard:definition:create',    'Create a standard'),
    (gen_random_uuid(), 'standard:definition:update',    'Edit a standard'),
    (gen_random_uuid(), 'standard:definition:archive',   'Archive or restore a standard'),
    (gen_random_uuid(), 'standard:version:create',       'Create or clone a standard version'),
    (gen_random_uuid(), 'standard:version:update',       'Edit a draft standard version'),
    (gen_random_uuid(), 'standard:version:publish',      'Publish a draft standard version'),
    (gen_random_uuid(), 'standard:version:archive',      'Archive a standard version'),
    (gen_random_uuid(), 'standard:rule:write',           'Create, edit, reorder and delete rules in a draft');

INSERT INTO "role_permissions" ("role_id", "permission_id")
SELECT r."id", p."id"
FROM "roles" r
JOIN "permissions" p ON TRUE
WHERE
    -- Every organization member can read the standards they are held to.
    (r."code" IN ('ORGANIZATION_OWNER', 'ORGANIZATION_ADMIN', 'ORGANIZATION_REVIEWER', 'TEMPLATE_MANAGER')
        AND p."code" IN ('standard:document-type:read', 'standard:definition:read'))
    -- Authoring, for the roles whose job it is.
 OR (r."code" IN ('ORGANIZATION_OWNER', 'ORGANIZATION_ADMIN', 'TEMPLATE_MANAGER')
        AND p."code" IN ('standard:document-type:manage', 'standard:definition:create',
                         'standard:definition:update', 'standard:definition:archive',
                         'standard:version:create', 'standard:version:update',
                         'standard:version:archive', 'standard:rule:write',
                         'standard:version:publish'));
