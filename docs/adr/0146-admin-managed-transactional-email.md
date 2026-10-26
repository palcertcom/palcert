# ADR-0146: Admin-managed transactional email provider and encrypted provider credentials

- **Status:** Accepted
- **Date:** 2026-10-02
- **Phase:** Post-RC email delivery
- **Amends:** [ADR-0118](0118-workflow-mail-cannot-carry-a-credential.md) (shared transport layer only)
- **Related:** [email API](../api/email.md), [Resend operations](../operations/email-resend.md)

## Context

PalCert produced authentication mail (verification, password reset,
invitations, password-changed notices) through `MailDeliveryPort`, whose only
production adapter logged that mail was produced. Workflow notification mail
had its own port and an environment-chosen transport (disabled, fake, SMTP).
Running PalCert at palcert.com needs real delivery, configured by a platform
administrator without a redeploy, with the provider credential never stored in
plaintext.

ADR-0118 kept the two producers apart — separate ports, separate
configuration, separate adapters — so a credential could never travel the
workflow path. Admin-managed configuration means one provider choice and one
credential for both. That is a contradiction with "separate configuration and
adapters", reported before implementation. It is resolved below by sharing
**only the bottom layer**; every invariant ADR-0118 protects is kept and is
now also asserted over the shared layer.

## Decision

1. **Two producers, one transport layer.** `MailDeliveryPort` (auth, may carry
   a single-use credential in a link) and `NotificationEmailProviderPort`
   (workflow, never carries one) remain separate. Beneath them,
   `infrastructure/email` provides: the provider configuration, the sealed
   credential, the Resend HTTPS client, and the delivery-metadata writer. The
   separation spec now also checks that this layer never imports auth code,
   never takes a `variables` bag and never names a credential token.
2. **Precedence.** If an administrator has chosen Resend *and* enabled it,
   mail goes through Resend (subject to per-category switches). Otherwise
   behaviour is exactly as before: auth mail to the logging adapter, workflow
   mail to `NOTIFICATION_EMAIL_PROVIDER`. With no settings row, nothing
   changes. The decision is made per send, from a settings cache of a few
   seconds that the saving process invalidates immediately, so a change needs
   no restart.
3. **Credential at rest.** The API key and the webhook signing secret are
   AES-256-GCM ciphertext with a random 96-bit IV, an authentication tag and
   the id of the key that sealed them, bound by additional data to their
   purpose and provider. The root keyring (`EMAIL_SETTINGS_ENCRYPTION_KEYS`,
   `EMAIL_SETTINGS_ENCRYPTION_ACTIVE_KID`) lives outside the database. It
   reuses the Phase 17 keyring primitive, generalised into
   `common/crypto/aead-keyring.ts` with the webhook additional-data bytes
   unchanged (a test reconstructs them by hand), under its own domain label so
   webhook ciphertext can never open as email material. Missing root key:
   PalCert boots, the dashboard says secure configuration is unavailable, and
   storing a credential is refused. There is no plaintext fallback. Only a
   display hint (`re_••••••••` + last three characters) is stored beside the
   ciphertext. The plaintext is opened for one send and dropped; it is never
   cached, logged, audited, returned, or placed in an error.
4. **Resend over HTTPS, without the SDK.** One authenticated `POST /emails`
   with a fixed base URL, a bounded timeout and response size, redirects
   refused (a redirect would carry the bearer token elsewhere), an
   `Idempotency-Key`, and every failure mapped to one of eight categories.
   Provider text is read to choose a category and discarded. The base URL can
   be overridden only by environment, and the schema refuses the override in
   production; it is never an admin field. Webhook verification is the Svix
   scheme in `node:crypto`. Avoiding the `resend` and `svix` packages keeps the
   dependency surface where it was for ~100 lines of code PalCert must own
   anyway (classification, redaction, bounds).
5. **Auth mail cannot leak account existence.** The managed `MailDeliveryPort`
   adapter returns immediately and dispatches afterwards, never throwing.
   Registration, reset and resend respond identically, in the same time,
   whatever the account or provider state. Transient failures retry twice with
   backoff. The cost — a process stopping mid-dispatch loses that one message —
   is accepted: the person asks again. Links are built by the auth services
   from `APP_PUBLIC_WEB_URL`, and the templates refuse any link on another
   origin.
6. **Workflow mail keeps the Phase 16 pipeline.** Fan-out, preferences,
   mandatory types, the attempt ledger, the retry ladder and the stable
   Message-ID are untouched; `NotificationEmailService` now asks a router for
   its provider per send. Resend failure categories map onto the Phase 16 codes
   with identical retryability. One idempotency key per logical delivery
   matches the stable Message-ID.
7. **Delivery metadata, never content.** `email_deliveries` records category,
   template (or notification type), provider, provider message id, recipient,
   status, a failure category and PalCert's own fixed sentence for it, and
   timestamps. There is no column for a subject, body, link, header, token or
   credential. `email_provider_events` records each signed webhook by its Svix
   id (making redelivery a no-op) with a payload hash and never the payload.
   Status only moves forward (`EMAIL_DELIVERY_STATUS_RANK`), so out-of-order
   events are recorded as stale.
8. **Authority.** `admin:email-settings:read|manage|test` and
   `admin:email-delivery:read`. Platform administrators hold all four;
   auditors read settings and history; nobody else holds any. Saving always
   requires a recent authentication. The test endpoint is rate-limited per
   administrator (5 per window) and platform-wide (20 per window), sends only
   PalCert's fixed test template, and never relays caller content.
9. **Audit.** `EMAIL_SETTINGS_UPDATED` (non-secret before/after with
   `apiKeyConfigured` booleans), `EMAIL_PROVIDER_ENABLED` /
   `EMAIL_PROVIDER_DISABLED`, `EMAIL_PROVIDER_SECRET_REPLACED` recorded only as
   `{provider:"RESEND", apiKeyChanged:true}` (or `webhookSecretChanged`), and
   `EMAIL_TEST_REQUESTED` with the recipient's domain only. Settings audits are
   written in the same transaction as the change.

## Consequences

- The migration is additive: three new SYSTEM tables, four permissions and
  their grants; nothing existing is altered and no settings row is inserted.
- The database dump contains the ciphertext but not the root key. A restore
  that should send mail needs the matching keyring, recovered separately; a
  restore without it boots and sends through the legacy path only after an
  administrator disables Resend or re-enters the key.
- Rotating the root key follows the webhook keyring procedure: add, activate,
  keep old keys until the stored values are re-saved.
- Domain verification stays in Resend; PalCert never claims a domain is
  verified and never touches DNS.
