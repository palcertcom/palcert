-- Phase 15 — the durable issuance job type.
--
-- Separate from the certificate tables migration because enum values must be
-- committed before a later statement can reference them.
ALTER TYPE "ProcessingJobType" ADD VALUE IF NOT EXISTS 'CERTIFICATE_ISSUE';
