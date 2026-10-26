-- Phase 0 baseline migration.
--
-- Establishes the migration pipeline and the single infrastructure table used
-- by the API health check. No business entities exist yet; each domain phase
-- adds its own migration and never edits this one (Master Prompt 45).

-- CreateTable
CREATE TABLE "app_metadata" (
    "key" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "app_metadata_pkey" PRIMARY KEY ("key")
);

-- Schema provenance: records the phase that last shaped the schema.
INSERT INTO "app_metadata" ("key", "value", "updated_at")
VALUES ('schema.phase', '0', NOW())
ON CONFLICT ("key") DO NOTHING;
