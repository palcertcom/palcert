# Platform email API (ADR-0146)

All routes are under `/api/v1`, use the session cookie and CSRF header like
every other staff route, and return PalCert's standard error envelope. No
response ever contains a provider credential in any form (plaintext,
ciphertext, IV, tag or key id).

| Method | Path | Permission | Notes |
| --- | --- | --- | --- |
| GET | `/admin/email-settings` | `admin:email-settings:read` | `EmailSettingsView` |
| PUT | `/admin/email-settings` | `admin:email-settings:manage` + recent sign-in | `UpdateEmailSettingsRequest` → `EmailSettingsView` |
| POST | `/admin/email-settings/test` | `admin:email-settings:test` | `{recipient, locale: "en"\|"ar"}` → `SendTestEmailResult`; rate-limited |
| GET | `/admin/email-deliveries` | `admin:email-delivery:read` | filters `status`, `category`, `template`, `provider`, `from`, `to`; cursor pagination (`cursor`, `limit` ≤ 100) |
| GET | `/admin/email-deliveries/:id` | `admin:email-delivery:read` | `EmailDeliveryView` |
| POST | `/webhooks/resend` | none (Svix signature) | Resend delivery events |

## `GET /admin/email-settings`

```json
{
  "provider": "RESEND",
  "enabled": true,
  "sendingDomain": "palcert.com",
  "fromEmail": "no-reply@palcert.com",
  "fromName": "PalCert",
  "replyToEmail": null,
  "authVerificationEnabled": true,
  "authPasswordResetEnabled": true,
  "authInvitationEnabled": true,
  "workflowEmailEnabled": true,
  "deliveryTrackingEnabled": true,
  "apiKeyConfigured": true,
  "apiKeyDisplayHint": "re_••••••••7XQ",
  "webhookSecretConfigured": false,
  "webhookSecretDisplayHint": null,
  "encryptionAvailable": true,
  "isDefault": false,
  "warnings": ["WEBHOOK_SECRET_MISSING"],
  "environment": "production (palcert.com)",
  "updatedAt": "2026-10-02T09:00:00.000Z",
  "updatedByUserId": "…"
}
```

`isDefault: true` means no administrator has saved settings: PalCert behaves
exactly as before the feature. Warnings are codes:
`FROM_OUTSIDE_DOMAIN`, `API_KEY_MISSING`, `DOMAIN_MISSING`,
`ENCRYPTION_UNAVAILABLE`, `WEBHOOK_SECRET_MISSING`.

## `PUT /admin/email-settings`

Every non-secret field is required. The write-only credential fields
(`apiKey`, the webhook signing secret field and its clear flag) are accepted
by the API but deliberately absent from the published OpenAPI document, whose
contract forbids naming a provider secret as a schema field. `apiKey` / `webhookSecret`: omitted, null
or blank **keeps** the stored value; there is no way to erase the API key with
a blank field. `clearWebhookSecret: true` removes the webhook secret.

| Status | Code | When |
| --- | --- | --- |
| 422 | `EMAIL_SETTINGS_INVALID` | `details.fields` names invalid fields (address, domain, header-unsafe name, key shape), or Resend enabled without a key |
| 409 | `EMAIL_ENCRYPTION_UNAVAILABLE` | a secret was supplied but the server has no root key, or the stored key was sealed with a key the server does not hold |
| 403 | `REAUTHENTICATION_REQUIRED` | the session is not recent enough |

## `POST /admin/email-settings/test`

Sends PalCert's fixed test message (subject *PalCert email configuration
test* / *اختبار إعدادات البريد الإلكتروني في PalCert*) using the saved
settings. Works when Resend is chosen with a saved key even if not yet
enabled. Returns `{deliveryId, accepted, status, failure, failureSummary}`;
`failure` is one of `PROVIDER_UNAVAILABLE`, `AUTHENTICATION_REJECTED`,
`SENDER_REJECTED`, `RECIPIENT_REJECTED`, `RATE_LIMITED`, `PROVIDER_REJECTED`,
`CONFIGURATION_ERROR`, `UNKNOWN` — never provider text. `409
EMAIL_PROVIDER_NOT_CONFIGURED` when Resend is not chosen or has no key; `429
RATE_LIMITED` beyond 5 per administrator or 20 platform-wide per window.

## Delivery views

`EmailDeliveryView` carries metadata only: `id, category (AUTH|WORKFLOW|TEST),
template, provider, providerMessageId, recipient, status, failureCode,
failureSummary, attemptCount, createdAt, updatedAt, acceptedAt, deliveredAt,
failedAt, lastEventAt`. Status values: `QUEUED, ACCEPTED, DELAYED, DELIVERED,
BOUNCED, COMPLAINED, FAILED, SKIPPED`.

## `POST /webhooks/resend`

Authenticated by `svix-id`, `svix-timestamp` and `svix-signature` over the raw
body with the saved signing secret; timestamps older than five minutes are
refused. `200 {received, duplicate}` for any verified event (a redelivery is
`duplicate: true` and changes nothing); `400 EMAIL_WEBHOOK_SIGNATURE_INVALID`
otherwise, including when no secret is saved. Mapped events: `email.sent`,
`email.delivery_delayed`, `email.delivered`, `email.bounced`,
`email.complained`, `email.failed`, `email.suppressed`; others are recorded as
ignored. A delivery's status never moves backwards.
