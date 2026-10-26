-- Phase 9: two new processing job types.
--
-- Its own migration because PostgreSQL refuses to use an enum value added in
-- the same transaction that added it, and the Phase 9 migration seeds rows
-- referring to these. Same reason Phase 8 split its enum change out.
ALTER TYPE "ProcessingJobType" ADD VALUE IF NOT EXISTS 'STANDARD_SOURCE_INGEST';
ALTER TYPE "ProcessingJobType" ADD VALUE IF NOT EXISTS 'RULE_EXTRACTION';
