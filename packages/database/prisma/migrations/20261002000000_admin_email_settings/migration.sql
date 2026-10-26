-- =============================================================================
-- Admin-managed transactional email (ADR-0146)
--
-- Strictly additive. Three new tables and four new permissions; no existing
-- table, column, row, constraint or function is altered.
--
-- No settings row is inserted. The absence of a row *is* the default state —
-- provider DISABLED — and every send path then behaves exactly as it did
-- before this migration: authentication mail goes to the logging adapter and
-- workflow mail to whatever NOTIFICATION_EMAIL_PROVIDER says.
--
--   platform_email_settings  SYSTEM — one platform-wide row; secrets sealed
--   email_deliveries         SYSTEM — delivery metadata, never a body or token
--   email_provider_events    SYSTEM — append-only receipt of provider webhooks
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. platform_email_settings
--
-- A singleton: the primary key is fixed at 1. The provider credential and the
-- webhook signing secret are stored only as AES-256-GCM ciphertext under a key
-- held outside the database (EMAIL_SETTINGS_ENCRYPTION_KEYS), each with its own
-- IV, authentication tag and key id. A database dump alone cannot recover them.
-- -----------------------------------------------------------------------------
CREATE TABLE "platform_email_settings" (
    "id" SMALLINT NOT NULL DEFAULT 1,
    "provider" TEXT NOT NULL DEFAULT 'DISABLED',
    "enabled" BOOLEAN NOT NULL DEFAULT false,

    "sending_domain" TEXT NOT NULL DEFAULT 'palcert.com',
    "from_email" TEXT NOT NULL DEFAULT 'no-reply@palcert.com',
    "from_name" TEXT NOT NULL DEFAULT 'PalCert',
    "reply_to_email" TEXT,

    "auth_verification_enabled" BOOLEAN NOT NULL DEFAULT true,
    "auth_password_reset_enabled" BOOLEAN NOT NULL DEFAULT true,
    "auth_invitation_enabled" BOOLEAN NOT NULL DEFAULT true,
    "workflow_email_enabled" BOOLEAN NOT NULL DEFAULT true,
    "delivery_tracking_enabled" BOOLEAN NOT NULL DEFAULT true,

    -- Sealed provider credential. Never plaintext.
    "api_key_ciphertext" TEXT,
    "api_key_iv" TEXT,
    "api_key_auth_tag" TEXT,
    "api_key_kid" TEXT,
    -- "re_••••••••7XQ": the prefix and the last three characters, no more.
    "api_key_display_hint" TEXT,

    -- Sealed webhook signing secret. Never plaintext.
    "webhook_secret_ciphertext" TEXT,
    "webhook_secret_iv" TEXT,
    "webhook_secret_auth_tag" TEXT,
    "webhook_secret_kid" TEXT,
    "webhook_secret_display_hint" TEXT,

    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "updated_by_user_id" UUID,

    CONSTRAINT "platform_email_settings_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "platform_email_settings_singleton" CHECK ("id" = 1),
    CONSTRAINT "platform_email_settings_provider_known"
        CHECK ("provider" IN ('DISABLED', 'RESEND')),
    CONSTRAINT "platform_email_settings_text_bounds" CHECK (
        char_length("sending_domain") <= 253
        AND char_length("from_email") <= 254
        AND char_length("from_name") BETWEEN 1 AND 100
        AND ("reply_to_email" IS NULL OR char_length("reply_to_email") <= 254)
    ),
    -- A header-injection backstop: no control characters in anything that
    -- becomes a header.
    CONSTRAINT "platform_email_settings_header_safe" CHECK (
        "sending_domain" !~ '[[:cntrl:]]'
        AND "from_email" !~ '[[:cntrl:]]'
        AND "from_name" !~ '[[:cntrl:]]'
        AND ("reply_to_email" IS NULL OR "reply_to_email" !~ '[[:cntrl:]]')
    ),
    -- A sealed value is all four parts or none.
    CONSTRAINT "platform_email_settings_api_key_shape" CHECK (
        ("api_key_ciphertext" IS NULL AND "api_key_iv" IS NULL
            AND "api_key_auth_tag" IS NULL AND "api_key_kid" IS NULL
            AND "api_key_display_hint" IS NULL)
        OR ("api_key_ciphertext" IS NOT NULL AND "api_key_iv" IS NOT NULL
            AND "api_key_auth_tag" IS NOT NULL AND "api_key_kid" IS NOT NULL
            AND "api_key_display_hint" IS NOT NULL)
    ),
    CONSTRAINT "platform_email_settings_webhook_secret_shape" CHECK (
        ("webhook_secret_ciphertext" IS NULL AND "webhook_secret_iv" IS NULL
            AND "webhook_secret_auth_tag" IS NULL AND "webhook_secret_kid" IS NULL
            AND "webhook_secret_display_hint" IS NULL)
        OR ("webhook_secret_ciphertext" IS NOT NULL AND "webhook_secret_iv" IS NOT NULL
            AND "webhook_secret_auth_tag" IS NOT NULL AND "webhook_secret_kid" IS NOT NULL
            AND "webhook_secret_display_hint" IS NOT NULL)
    ),
    -- Resend cannot be switched on without a credential to send with.
    CONSTRAINT "platform_email_settings_enabled_needs_key" CHECK (
        NOT ("enabled" AND "provider" = 'RESEND') OR "api_key_ciphertext" IS NOT NULL
    )
);

ALTER TABLE "platform_email_settings"
    ADD CONSTRAINT "platform_email_settings_updated_by_fkey"
    FOREIGN KEY ("updated_by_user_id") REFERENCES "users"("id") ON DELETE SET NULL;

-- -----------------------------------------------------------------------------
-- 2. email_deliveries
--
-- One row per message PalCert handed (or decided not to hand) to the
-- admin-managed provider. Metadata only: who it was for, which template, what
-- the provider said in a normalized code. There is no column for a subject, a
-- body, a link, a header, a token or a credential, so none can be stored.
-- -----------------------------------------------------------------------------
CREATE TABLE "email_deliveries" (
    "id" UUID NOT NULL,
    "category" TEXT NOT NULL,
    "template" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "provider_message_id" TEXT,
    "recipient" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'QUEUED',
    "skip_reason" TEXT,
    "failure_code" TEXT,
    "failure_summary" TEXT,
    "attempt_count" INTEGER NOT NULL DEFAULT 0,
    -- For workflow mail: the Phase 16 delivery this mirrors.
    "notification_delivery_id" UUID,
    -- For a test send: the administrator who asked.
    "requested_by_user_id" UUID,

    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "accepted_at" TIMESTAMPTZ(6),
    "delivered_at" TIMESTAMPTZ(6),
    "failed_at" TIMESTAMPTZ(6),
    "last_event_at" TIMESTAMPTZ(6),

    CONSTRAINT "email_deliveries_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "email_deliveries_category_known"
        CHECK ("category" IN ('AUTH', 'WORKFLOW', 'TEST')),
    CONSTRAINT "email_deliveries_template_shape" CHECK ("template" ~ '^[A-Z][A-Z0-9_]{0,63}$'),
    CONSTRAINT "email_deliveries_provider_shape" CHECK ("provider" ~ '^[a-z][a-z0-9_-]{0,31}$'),
    CONSTRAINT "email_deliveries_status_known" CHECK ("status" IN
        ('QUEUED', 'ACCEPTED', 'DELAYED', 'DELIVERED', 'BOUNCED', 'COMPLAINED', 'FAILED', 'SKIPPED')),
    CONSTRAINT "email_deliveries_skip_reason_known" CHECK ("skip_reason" IS NULL OR "skip_reason" IN
        ('PROVIDER_DISABLED', 'CATEGORY_DISABLED', 'CREDENTIAL_UNAVAILABLE')),
    CONSTRAINT "email_deliveries_failure_code_known" CHECK ("failure_code" IS NULL OR "failure_code" IN
        ('PROVIDER_UNAVAILABLE', 'AUTHENTICATION_REJECTED', 'SENDER_REJECTED', 'RECIPIENT_REJECTED',
         'RATE_LIMITED', 'PROVIDER_REJECTED', 'CONFIGURATION_ERROR', 'UNKNOWN')),
    CONSTRAINT "email_deliveries_text_bounds" CHECK (
        char_length("recipient") <= 254
        AND ("provider_message_id" IS NULL OR char_length("provider_message_id") <= 200)
        AND ("failure_summary" IS NULL OR char_length("failure_summary") <= 300)
    ),
    CONSTRAINT "email_deliveries_attempts_sane" CHECK ("attempt_count" >= 0),
    CONSTRAINT "email_deliveries_skip_shape"
        CHECK (("status" = 'SKIPPED') = ("skip_reason" IS NOT NULL)),
    CONSTRAINT "email_deliveries_workflow_link"
        CHECK ("notification_delivery_id" IS NULL OR "category" = 'WORKFLOW')
);

-- Full unique indexes: NULLs are distinct in PostgreSQL, so rows without a
-- provider message id or a notification link never collide.
CREATE UNIQUE INDEX "email_deliveries_provider_message"
    ON "email_deliveries"("provider", "provider_message_id");
CREATE UNIQUE INDEX "email_deliveries_notification_delivery"
    ON "email_deliveries"("notification_delivery_id");
CREATE INDEX "email_deliveries_created_idx" ON "email_deliveries"("created_at" DESC, "id" DESC);
CREATE INDEX "email_deliveries_status_idx" ON "email_deliveries"("status", "created_at" DESC);

ALTER TABLE "email_deliveries"
    ADD CONSTRAINT "email_deliveries_notification_delivery_fkey"
    FOREIGN KEY ("notification_delivery_id") REFERENCES "notification_deliveries"("id")
    ON DELETE RESTRICT;
ALTER TABLE "email_deliveries"
    ADD CONSTRAINT "email_deliveries_requested_by_fkey"
    FOREIGN KEY ("requested_by_user_id") REFERENCES "users"("id") ON DELETE SET NULL;

-- -----------------------------------------------------------------------------
-- 3. email_provider_events
--
-- Proof that a signed provider webhook was received and what PalCert did with
-- it. The provider's event id is unique, which is what makes a redelivered
-- event a no-op. The payload itself is not kept — only its SHA-256 — because
-- a bounce payload can quote the recipient's mail server verbatim.
-- -----------------------------------------------------------------------------
CREATE TABLE "email_provider_events" (
    "id" UUID NOT NULL,
    "provider" TEXT NOT NULL,
    "event_id" TEXT NOT NULL,
    "event_type" TEXT NOT NULL,
    "provider_message_id" TEXT,
    "payload_sha256" TEXT NOT NULL,
    "outcome" TEXT NOT NULL,
    "occurred_at" TIMESTAMPTZ(6),
    "received_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "email_provider_events_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "email_provider_events_outcome_known" CHECK ("outcome" IN
        ('APPLIED', 'STALE', 'UNMATCHED', 'IGNORED')),
    CONSTRAINT "email_provider_events_text_bounds" CHECK (
        char_length("event_id") <= 200
        AND char_length("event_type") <= 64
        AND ("provider_message_id" IS NULL OR char_length("provider_message_id") <= 200)
        AND "payload_sha256" ~ '^[0-9a-f]{64}$'
    )
);

CREATE UNIQUE INDEX "email_provider_events_identity"
    ON "email_provider_events"("provider", "event_id");
CREATE INDEX "email_provider_events_message_idx"
    ON "email_provider_events"("provider", "provider_message_id");

-- -----------------------------------------------------------------------------
-- 4. Privileges
--
-- No route serves any of these tables to a tenant; the admin endpoints read
-- them behind platform permissions. The application role may never delete:
-- delivery metadata and webhook receipts are history.
-- -----------------------------------------------------------------------------
REVOKE ALL ON "platform_email_settings" FROM "palcert_app";
GRANT SELECT, INSERT, UPDATE ON "platform_email_settings" TO "palcert_app";
REVOKE ALL ON "email_deliveries" FROM "palcert_app";
GRANT SELECT, INSERT, UPDATE ON "email_deliveries" TO "palcert_app";
REVOKE ALL ON "email_provider_events" FROM "palcert_app";
GRANT SELECT, INSERT ON "email_provider_events" TO "palcert_app";

INSERT INTO "table_isolation_classification" ("table_name", "classification", "tenant_column", "notes")
VALUES
    ('platform_email_settings', 'SYSTEM', NULL,
     'The one platform-wide email configuration. Secrets are AES-256-GCM ciphertext under a key held outside the database; read and written only through platform-admin endpoints.'),
    ('email_deliveries', 'SYSTEM', NULL,
     'Metadata of mail handed to the admin-managed provider: recipient, template, status, normalized failure code. Never a body, link, token or credential.'),
    ('email_provider_events', 'SYSTEM', NULL,
     'Append-only receipt of signed provider webhooks, by provider event id. Keeps a payload hash, never the payload.')
ON CONFLICT ("table_name") DO UPDATE
    SET "classification" = EXCLUDED."classification",
        "tenant_column" = EXCLUDED."tenant_column",
        "notes" = EXCLUDED."notes";

COMMENT ON TABLE "platform_email_settings" IS
    'Admin-managed transactional email configuration (ADR-0146). Singleton. Secrets sealed; never plaintext.';
COMMENT ON TABLE "email_deliveries" IS
    'Delivery metadata for admin-managed provider mail. No message content and no credential.';
COMMENT ON TABLE "email_provider_events" IS
    'Signed provider webhook receipts. Idempotent by (provider, event_id). No payload.';

-- -----------------------------------------------------------------------------
-- 5. Permissions
-- -----------------------------------------------------------------------------
INSERT INTO "permissions" ("id", "code", "description") VALUES
    (gen_random_uuid(), 'admin:email-settings:read',
     'Read the platform email configuration (never the provider credential)'),
    (gen_random_uuid(), 'admin:email-settings:manage',
     'Change the platform email provider, sender and credential'),
    (gen_random_uuid(), 'admin:email-settings:test',
     'Send a configuration test email'),
    (gen_random_uuid(), 'admin:email-delivery:read',
     'Read platform email delivery history (metadata only)')
ON CONFLICT ("code") DO NOTHING;

INSERT INTO "role_permissions" ("role_id", "permission_id")
SELECT r."id", p."id"
FROM "roles" r CROSS JOIN "permissions" p
WHERE (r."code" = 'PALCERT_ADMIN' AND p."code" IN
        ('admin:email-settings:read', 'admin:email-settings:manage',
         'admin:email-settings:test', 'admin:email-delivery:read'))
   OR (r."code" = 'PALCERT_AUDITOR' AND p."code" IN
        ('admin:email-settings:read', 'admin:email-delivery:read'))
ON CONFLICT ("role_id", "permission_id") DO NOTHING;
