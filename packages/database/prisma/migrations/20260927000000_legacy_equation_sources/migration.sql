-- =============================================================================
-- Legacy scientific equations in a Word source
--
-- A thesis template may carry equations as legacy OLE objects (MathType's
-- Equation.DSMT4, Microsoft Equation 3.0). Ingestion now accepts those — and
-- only those — after a structural classification, as data that is never
-- executed. The source records how many it accepted so the organization can be
-- told, plainly, that PalCert processed them in safe mode.
--
-- A count rather than a flag: it is what the ingest actually found, and it is
-- a fact about the bytes, so like the digest it does not move once settled.
-- =============================================================================

ALTER TABLE "standard_source_assets"
    ADD COLUMN "legacy_equation_count" INTEGER NOT NULL DEFAULT 0,
    ADD CONSTRAINT "standard_source_assets_legacy_equation_count_nonnegative"
        CHECK ("legacy_equation_count" >= 0);

CREATE OR REPLACE FUNCTION standard_source_assets_guard() RETURNS TRIGGER
LANGUAGE plpgsql SET search_path = public AS $$
BEGIN
    IF NEW."organization_id" <> OLD."organization_id"
        OR NEW."standard_version_id" <> OLD."standard_version_id"
        OR NEW."source_kind" <> OLD."source_kind"
        OR NEW."quarantine_object_key" <> OLD."quarantine_object_key"
        OR (OLD."sha256" IS NOT NULL AND NEW."sha256" IS DISTINCT FROM OLD."sha256")
        OR (OLD."clean_object_key" IS NOT NULL
            AND NEW."clean_object_key" IS DISTINCT FROM OLD."clean_object_key")
        OR (OLD."status" = 'READY'
            AND NEW."legacy_equation_count" <> OLD."legacy_equation_count")
    THEN
        RAISE EXCEPTION 'standard source identity is immutable'
            USING ERRCODE = 'restrict_violation';
    END IF;
    -- A settled source stays settled. Only the retention lock and the
    -- quarantine tombstone may move afterwards, because both are operational
    -- facts about storage rather than claims about the document.
    IF OLD."status" IN ('READY', 'REJECTED', 'FAILED', 'CANCELLED', 'UPLOAD_EXPIRED')
        AND NEW."status" <> OLD."status"
    THEN
        RAISE EXCEPTION 'standard source % is already settled', OLD."id"
            USING ERRCODE = 'restrict_violation';
    END IF;
    RETURN NEW;
END;
$$;
