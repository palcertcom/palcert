-- Phase 10: two new processing job types.
--
-- PostgreSQL will not let a value added to an enum be used in the same
-- transaction that adds it, so the job types arrive in their own migration
-- ahead of the tables that enqueue them — exactly as Phases 6 through 9 did.
ALTER TYPE "ProcessingJobType" ADD VALUE IF NOT EXISTS 'PAYMENT_EVENT';
ALTER TYPE "ProcessingJobType" ADD VALUE IF NOT EXISTS 'PAYMENT_RECONCILIATION';
