-- Phase 11 enum values, alone in their own migration.
--
-- PostgreSQL refuses to use a value added by ALTER TYPE inside the same
-- transaction that added it, and Prisma wraps each migration in one. Phase 10
-- learned this the same way; the job types and reference types therefore land
-- one migration ahead of the tables that reference them.
ALTER TYPE "ProcessingJobType" ADD VALUE IF NOT EXISTS 'CHECK_PREPARE';
ALTER TYPE "LedgerReferenceType" ADD VALUE IF NOT EXISTS 'SERVICE_PURCHASE';
