-- =============================================================================
-- Portable standard packages — where an imported draft came from
--
-- A standard can be exported as a PALCERT_STANDARD package and imported by
-- another organization as a new DRAFT. The draft itself is an ordinary version
-- with ordinary rules; this table records, beside it, what it was imported
-- from. Provenance lives here rather than in the version or rule rows, so that
-- nothing foreign is mixed into the columns the canonical snapshot and the
-- content hash are built from.
--
-- Additive only: a new table, its indexes, policy, trigger and grants. No
-- existing row, id, hash, snapshot or relationship changes.
--
-- What is stored is what a person reads — the source organization's name, the
-- code, names and label it gave the standard, the status it had there — and the
-- package's content hash. No identifier from the source installation is kept,
-- because none is ever exported.
-- =============================================================================

CREATE TABLE "standard_version_imports" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "standard_id" UUID NOT NULL,
    "standard_version_id" UUID NOT NULL,
    "imported_by_user_id" UUID,
    "imported_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "package_hash" TEXT NOT NULL,
    "format_version" INTEGER NOT NULL,
    "source_organization_name" TEXT NOT NULL,
    "source_standard_code" TEXT NOT NULL,
    "source_standard_name_en" TEXT NOT NULL,
    "source_standard_name_ar" TEXT NOT NULL,
    "source_version_label" TEXT NOT NULL,
    "source_version_status" "StandardVersionStatus" NOT NULL,
    "source_rule_schema_version" INTEGER NOT NULL,
    "import_rule_schema_version" INTEGER NOT NULL,
    "rule_count" INTEGER NOT NULL,
    "created_standard" BOOLEAN NOT NULL,

    CONSTRAINT "standard_version_imports_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "standard_version_imports_package_hash_format"
        CHECK ("package_hash" ~ '^sha256:[0-9a-f]{64}$'),
    CONSTRAINT "standard_version_imports_format_version_positive" CHECK ("format_version" >= 1),
    CONSTRAINT "standard_version_imports_rule_count_positive" CHECK ("rule_count" > 0),
    CONSTRAINT "standard_version_imports_schema_versions_positive"
        CHECK ("source_rule_schema_version" >= 1 AND "import_rule_schema_version" >= 1)
);

-- One import record per version: a version is imported once, when it is made.
CREATE UNIQUE INDEX "standard_version_imports_standard_version_id_key"
    ON "standard_version_imports"("standard_version_id");
-- "Has this exact package been imported here before?"
CREATE INDEX "standard_version_imports_organization_id_package_hash_idx"
    ON "standard_version_imports"("organization_id", "package_hash");
CREATE INDEX "standard_version_imports_standard_id_idx"
    ON "standard_version_imports"("standard_id");

ALTER TABLE "standard_version_imports"
    ADD CONSTRAINT "standard_version_imports_organization_id_fkey"
    FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "standard_version_imports"
    ADD CONSTRAINT "standard_version_imports_standard_id_fkey"
    FOREIGN KEY ("standard_id") REFERENCES "standards"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "standard_version_imports"
    ADD CONSTRAINT "standard_version_imports_standard_version_id_fkey"
    FOREIGN KEY ("standard_version_id") REFERENCES "standard_versions"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "standard_version_imports"
    ADD CONSTRAINT "standard_version_imports_imported_by_user_id_fkey"
    FOREIGN KEY ("imported_by_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- The record, the version and the standard belong to one tenant. Composite keys
-- make a cross-tenant pointer impossible rather than merely unlikely.
ALTER TABLE "standard_version_imports"
    ADD CONSTRAINT "standard_version_imports_version_org_fkey"
    FOREIGN KEY ("standard_version_id", "organization_id")
    REFERENCES "standard_versions" ("id", "organization_id")
    ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "standard_version_imports"
    ADD CONSTRAINT "standard_version_imports_standard_org_fkey"
    FOREIGN KEY ("standard_id", "organization_id")
    REFERENCES "standards" ("id", "organization_id")
    ON DELETE CASCADE ON UPDATE CASCADE;

-- Provenance is written once. The Phase 9 append-only function already says
-- exactly this, for exactly this kind of record.
CREATE TRIGGER standard_version_imports_append_only
    BEFORE UPDATE ON "standard_version_imports"
    FOR EACH ROW EXECUTE FUNCTION extraction_output_append_only();

INSERT INTO "table_isolation_classification" ("table_name", "classification", "tenant_column", "notes")
VALUES
    ('standard_version_imports', 'TENANT_SCOPED', 'organization_id',
     'Where an imported draft came from: human-readable source names and the package hash. Never an identifier from the source installation. Append-only.');

ALTER TABLE "standard_version_imports" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "standard_version_imports" FORCE ROW LEVEL SECURITY;
CREATE POLICY "standard_version_imports_all" ON "standard_version_imports" FOR ALL
    USING (app_is_platform_admin() OR "organization_id" = app_current_organization())
    WITH CHECK (app_is_platform_admin() OR "organization_id" = app_current_organization());

-- Read and append. No UPDATE (the trigger would refuse it anyway) and no
-- DELETE: a record goes only when its version or organization does, by cascade.
GRANT SELECT, INSERT ON "standard_version_imports" TO "palcert_app";
