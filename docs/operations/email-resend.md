# Transactional email with Resend (ADR-0146)

PalCert sends account emails (verification, password reset, invitations,
password-changed notices) and workflow notifications through Resend once a
platform administrator configures it in **Administration → Email settings**.
Until then PalCert behaves exactly as before.

Recommended production values for palcert.com:

| Setting | Value |
| --- | --- |
| Provider | Resend |
| Sending domain | `palcert.com` |
| From | `PalCert <no-reply@palcert.com>` |
| Links in mail | built from the deployment's `APP_PUBLIC_WEB_URL` (`https://palcert.com` in production) |

## 1. Root key (operator, once per deployment)

Generate a 32-byte key and add it to the deployment's secret store — **not**
to source control and not to the database:

```bash
echo "EMAIL_SETTINGS_ENCRYPTION_ACTIVE_KID=email-1"
echo "EMAIL_SETTINGS_ENCRYPTION_KEYS=email-1:$(openssl rand -base64 32)"
```

Restart the API and worker. Both settings set together, or neither; a
malformed value stops the process at boot. Without them PalCert still boots
and the dashboard reports *secure configuration is unavailable*.

**Back the root key up separately from database backups.** The database holds
only ciphertext; restoring it without the matching key leaves the stored API
key unreadable (mail through Resend fails closed as a configuration error
until the key is restored or an administrator re-enters the API key).

Rotation: add a new `kid:key` pair, make it active, keep the old pair, then
re-save the API key (and webhook secret) in the dashboard. Remove the old key
only afterwards.

## 2. Resend account setup (operator, in Resend)

1. Add the domain `palcert.com` in Resend and publish **exactly the DNS
   records Resend displays** for it (SPF/DKIM and any return-path records).
   PalCert does not modify DNS and cannot tell whether the domain is verified;
   wait until Resend shows it as verified.
2. Create an API key with **Sending access** only, restricted to the
   `palcert.com` domain. Copy it once; it is entered only in the PalCert
   dashboard. Never put it in source control, an env file or a ticket.
3. Optional but recommended: add a webhook pointing at
   `https://palcert.com/api/v1/webhooks/resend` with the events
   `email.sent`, `email.delivered`, `email.delivery_delayed`, `email.bounced`,
   `email.complained`, `email.failed`. Copy its signing secret (`whsec_…`).

## 3. Dashboard configuration (platform administrator)

1. Sign in (a fresh sign-in is required to save) and open
   **Administration → Email settings**.
2. Provider **Resend**; sending domain `palcert.com`; from address
   `no-reply@palcert.com`; from name `PalCert`; optional reply-to.
3. Paste the API key, and the webhook signing secret if configured. After
   saving, the page shows only `Configured re_••••••••…`.
4. Leave **Send email through this provider** off for the first save.
5. Use **Send test email** to an inbox you control, in English and Arabic.
6. When the test arrives, turn the provider on and save.

## 4. Manual smoke test (after enabling)

- [ ] Test email arrives (EN and AR); the Arabic message renders right-to-left.
- [ ] Register a new account: the verification email arrives and its link
      opens `https://palcert.com/<locale>/verify-email?...` and verifies.
- [ ] *Forgot password* for that account: the reset email arrives and works.
- [ ] *Forgot password* for an address with no account: the page response is
      identical and no email is sent.
- [ ] Invite a member to an organization: the invitation arrives.
- [ ] **Administration → Email deliveries** lists the sends as Accepted, and
      — if the webhook is configured — later Delivered. No row shows a link or
      message body.
- [ ] Turn a category switch off (e.g. invitations), invite again: the row
      shows *Not sent*; turn it back on.

## 5. Failure handling

Failures appear in the delivery console as categories:

| Category | Usual cause | Action |
| --- | --- | --- |
| API key rejected | key revoked or wrong | create a new Sending-access key, re-enter it |
| Sender or domain rejected | domain not verified, or from address outside it | finish verification in Resend; align the from address |
| Recipient rejected | invalid or suppressed recipient | nothing on PalCert's side |
| Rate limited | Resend quota | raise the plan or wait; account mail retries twice, workflow mail follows its retry ladder |
| Provider unavailable | network / Resend outage | retried automatically |
| Configuration problem | root key missing or changed | restore the root key or re-enter the API key |

To stop all provider mail immediately, turn **Send email through this
provider** off and save; PalCert returns to its previous behaviour on the next
send without a restart.

## 6. Backup and restore

`platform_email_settings`, `email_deliveries` and `email_provider_events` are
ordinary tables and are included in the logical backup (`pg_dump` of the
whole schema); the post-restore verification checks the restored schema
against the migrations, which include them. The root key is **not** in any
backup by design. See §1.
