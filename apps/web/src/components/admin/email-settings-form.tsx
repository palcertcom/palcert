'use client';

import {
  EmailProviderKind,
  isValidEmailAddress,
  type EmailSettingsView,
  type SendTestEmailResult,
  type UpdateEmailSettingsRequest,
} from '@palcert/contracts/email';
import { useId, useState, type FormEvent } from 'react';
import { ReauthNotice } from '@/components/admin/admin-kit';
import { FormError, FormSuccess } from '@/components/auth-form';
import type { EmailMessages } from '@/i18n/email-messages';
import type { Locale } from '@/i18n/locales';
import { ApiError } from '@/lib/api-client';
import { emailAdminApi } from '@/lib/email-api';

type Draft = Omit<UpdateEmailSettingsRequest, 'apiKey' | 'webhookSecret' | 'clearWebhookSecret'> & {
  replyToEmail: string;
};

function draftOf(view: EmailSettingsView): Draft {
  return {
    provider: view.provider,
    enabled: view.enabled,
    sendingDomain: view.sendingDomain,
    fromEmail: view.fromEmail,
    fromName: view.fromName,
    replyToEmail: view.replyToEmail ?? '',
    authVerificationEnabled: view.authVerificationEnabled,
    authPasswordResetEnabled: view.authPasswordResetEnabled,
    authInvitationEnabled: view.authInvitationEnabled,
    workflowEmailEnabled: view.workflowEmailEnabled,
    deliveryTrackingEnabled: view.deliveryTrackingEnabled,
  };
}

export function describeEmailError(
  m: EmailMessages,
  caught: unknown,
): { message: string; reauth: boolean } {
  if (caught instanceof ApiError) {
    const fields = Array.isArray(caught.details?.['fields'])
      ? (caught.details?.['fields'] as string[])
      : [];
    if (caught.code === 'EMAIL_SETTINGS_INVALID' && fields.length > 0) {
      return {
        message: m.settings.invalidFields(
          fields.map((f) => m.settings.fieldNames[f] ?? f).join(', '),
        ),
        reauth: false,
      };
    }
    return {
      message: m.errors[caught.code] ?? m.genericError,
      reauth: caught.code === 'REAUTHENTICATION_REQUIRED',
    };
  }
  return { message: m.genericError, reauth: false };
}

/**
 * The settings form. Secret inputs are write-only: they start empty, are sent
 * once on save, and are cleared immediately afterwards whatever the outcome.
 */
export function EmailSettingsForm({
  locale,
  messages: m,
  initial,
  canManage,
  canTest,
  webhookEndpoint,
}: {
  locale: Locale;
  messages: EmailMessages;
  initial: EmailSettingsView;
  canManage: boolean;
  canTest: boolean;
  webhookEndpoint: string;
}) {
  const id = useId();
  const [view, setView] = useState(initial);
  const [draft, setDraft] = useState<Draft>(() => draftOf(initial));
  const [apiKey, setApiKey] = useState('');
  const [webhookSecret, setWebhookSecret] = useState('');
  const [clearWebhook, setClearWebhook] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<{ message: string; reauth: boolean } | null>(null);
  const [saved, setSaved] = useState(false);

  const dirty =
    JSON.stringify(draft) !== JSON.stringify(draftOf(view)) ||
    apiKey !== '' ||
    webhookSecret !== '' ||
    clearWebhook;
  const s = m.settings;
  const disabled = !canManage || saving;
  const resend = draft.provider === EmailProviderKind.RESEND;

  const set =
    <K extends keyof Draft>(key: K) =>
    (value: Draft[K]) => {
      setSaved(false);
      setDraft((current) => ({ ...current, [key]: value }));
    };

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!canManage) return;
    setSaving(true);
    setError(null);
    setSaved(false);
    const body: UpdateEmailSettingsRequest = {
      ...draft,
      replyToEmail: draft.replyToEmail.trim() === '' ? null : draft.replyToEmail.trim(),
      ...(apiKey.trim() === '' ? {} : { apiKey: apiKey.trim() }),
      ...(webhookSecret.trim() === '' ? {} : { webhookSecret: webhookSecret.trim() }),
      ...(clearWebhook ? { clearWebhookSecret: true } : {}),
    };
    // The secrets leave component state now, whatever the outcome.
    setApiKey('');
    setWebhookSecret('');
    setClearWebhook(false);
    try {
      const next = await emailAdminApi.save(body);
      setView(next);
      setDraft(draftOf(next));
      setSaved(true);
    } catch (caught) {
      setError(describeEmailError(m, caught));
    } finally {
      setSaving(false);
    }
  }

  const check = (key: keyof Draft, label: string, hint?: string) => (
    <label className="pc-check">
      <input
        type="checkbox"
        checked={Boolean(draft[key])}
        disabled={disabled}
        onChange={(event) => set(key)(event.target.checked as never)}
        data-testid={`email-${key}`}
      />
      <span>
        {label}
        {hint ? <span className="pc-hint pc-check-hint">{hint}</span> : null}
      </span>
    </label>
  );

  const text = (
    key: 'sendingDomain' | 'fromEmail' | 'fromName' | 'replyToEmail',
    label: string,
    hint?: string,
    ltr = true,
  ) => (
    <div className="pc-field">
      <label htmlFor={`${id}-${key}`}>{label}</label>
      <input
        id={`${id}-${key}`}
        type={key === 'fromEmail' || key === 'replyToEmail' ? 'email' : 'text'}
        value={draft[key]}
        disabled={disabled}
        maxLength={key === 'fromName' ? 100 : 254}
        autoComplete="off"
        {...(ltr ? { dir: 'ltr' } : {})}
        onChange={(event) => set(key)(event.target.value)}
        data-testid={`email-${key}`}
      />
      {hint ? <p className="pc-hint">{hint}</p> : null}
    </div>
  );

  return (
    <>
      {view.isDefault ? (
        <p className="pc-alert pc-alert-info" role="status" data-testid="email-defaults-notice">
          {s.defaultsNotice}
        </p>
      ) : null}
      {!view.encryptionAvailable ? (
        <p
          className="pc-alert pc-alert-warning"
          role="alert"
          data-testid="email-encryption-unavailable"
        >
          {s.encryptionUnavailable}
        </p>
      ) : null}
      {view.warnings
        .filter((w) => w !== 'ENCRYPTION_UNAVAILABLE')
        .map((warning) => (
          <p
            key={warning}
            className="pc-alert pc-alert-warning"
            role="alert"
            data-testid={`email-warning-${warning}`}
          >
            {s.warnings[warning] ?? warning}
          </p>
        ))}
      {!canManage ? <p className="pc-hint">{s.readOnly}</p> : null}

      <form
        className="pc-form"
        onSubmit={(event) => void save(event)}
        noValidate
        data-testid="email-settings-form"
      >
        <section className="pc-card">
          <h2 className="pc-card-title">{s.providerSection}</h2>
          <div className="pc-field">
            <label htmlFor={`${id}-provider`}>{s.provider}</label>
            <select
              id={`${id}-provider`}
              value={draft.provider}
              disabled={disabled}
              onChange={(event) => set('provider')(event.target.value as Draft['provider'])}
              data-testid="email-provider"
            >
              {Object.values(EmailProviderKind).map((kind) => (
                <option key={kind} value={kind}>
                  {s.providers[kind]}
                </option>
              ))}
            </select>
          </div>
          {check('enabled', s.enabled, s.enabledHint)}
        </section>

        <section className="pc-card">
          <h2 className="pc-card-title">{s.senderSection}</h2>
          {text('sendingDomain', s.sendingDomain, s.sendingDomainHint)}
          {text('fromEmail', s.fromEmail)}
          {text('fromName', s.fromName, undefined, false)}
          {text('replyToEmail', s.replyTo, s.replyToHint)}
          {resend ? (
            <p className="pc-hint" data-testid="email-domain-note">
              {s.domainVerificationNote}
            </p>
          ) : null}
        </section>

        <section className="pc-card">
          <h2 className="pc-card-title">{s.credentialSection}</h2>
          <div className="pc-field">
            <label htmlFor={`${id}-apiKey`}>{s.apiKey}</label>
            <p className="pc-hint" data-testid="email-api-key-state">
              {view.apiKeyConfigured && view.apiKeyDisplayHint !== null ? (
                <span dir="ltr">{s.apiKeyConfigured(view.apiKeyDisplayHint)}</span>
              ) : (
                s.apiKeyNotConfigured
              )}
            </p>
            <input
              id={`${id}-apiKey`}
              type="password"
              value={apiKey}
              disabled={disabled || !view.encryptionAvailable}
              autoComplete="new-password"
              spellCheck={false}
              maxLength={200}
              dir="ltr"
              onChange={(event) => {
                setSaved(false);
                setApiKey(event.target.value);
              }}
              data-testid="email-api-key"
            />
            <p className="pc-hint">{s.apiKeyHint}</p>
            <p className="pc-hint">{s.apiKeyLeastPrivilege}</p>
          </div>
          <div className="pc-field">
            <label htmlFor={`${id}-webhook`}>{s.webhookSecret}</label>
            <p className="pc-hint" data-testid="email-webhook-state">
              {view.webhookSecretConfigured && view.webhookSecretDisplayHint !== null ? (
                <span dir="ltr">{s.webhookConfigured(view.webhookSecretDisplayHint)}</span>
              ) : (
                s.webhookNotConfigured
              )}
            </p>
            <input
              id={`${id}-webhook`}
              type="password"
              value={webhookSecret}
              disabled={disabled || !view.encryptionAvailable}
              autoComplete="new-password"
              spellCheck={false}
              maxLength={200}
              dir="ltr"
              onChange={(event) => {
                setSaved(false);
                setWebhookSecret(event.target.value);
              }}
              data-testid="email-webhook-secret"
            />
            <p className="pc-hint">{s.webhookSecretHint}</p>
            {view.webhookSecretConfigured ? (
              <label className="pc-check">
                <input
                  type="checkbox"
                  checked={clearWebhook}
                  disabled={disabled}
                  onChange={(event) => setClearWebhook(event.target.checked)}
                />
                {s.clearWebhookSecret}
              </label>
            ) : null}
            <p className="pc-hint">
              {s.webhookEndpoint}: <code dir="ltr">{webhookEndpoint}</code>
            </p>
          </div>
        </section>

        <section className="pc-card">
          <h2 className="pc-card-title">{s.switchesSection}</h2>
          {check('authVerificationEnabled', s.authVerification)}
          {check('authPasswordResetEnabled', s.authPasswordReset)}
          {check('authInvitationEnabled', s.authInvitation)}
          {check('workflowEmailEnabled', s.workflowEmail)}
          {check('deliveryTrackingEnabled', s.deliveryTracking, s.deliveryTrackingHint)}
        </section>

        {error === null ? null : error.reauth ? (
          <ReauthNotice locale={locale} />
        ) : (
          <FormError message={error.message} />
        )}
        {saved ? <FormSuccess message={s.saved} /> : null}
        {canManage ? (
          <div className="pc-actions">
            <button
              type="submit"
              className="pc-btn"
              disabled={saving || !dirty}
              data-testid="email-save"
            >
              {saving ? s.saving : s.save}
            </button>
          </div>
        ) : null}
      </form>

      {canTest ? <TestEmail messages={m} dirty={dirty} /> : null}
    </>
  );
}

function TestEmail({ messages: m, dirty }: { messages: EmailMessages; dirty: boolean }) {
  const id = useId();
  const [recipient, setRecipient] = useState('');
  const [locale, setLocale] = useState<'en' | 'ar'>('en');
  const [sending, setSending] = useState(false);
  const [result, setResult] = useState<SendTestEmailResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const t = m.test;

  async function send(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setResult(null);
    setError(null);
    if (!isValidEmailAddress(recipient.trim())) {
      setError(t.invalidRecipient);
      return;
    }
    setSending(true);
    try {
      setResult(await emailAdminApi.sendTest({ recipient: recipient.trim(), locale }));
    } catch (caught) {
      setError(describeEmailError(m, caught).message);
    } finally {
      setSending(false);
    }
  }

  return (
    <section className="pc-card" data-testid="email-test">
      <h2 className="pc-card-title">{t.title}</h2>
      <p className="pc-hint">{t.intro}</p>
      {dirty ? (
        <p className="pc-alert pc-alert-info" role="status">
          {t.unsavedChanges}
        </p>
      ) : null}
      <form className="pc-form" onSubmit={(event) => void send(event)} noValidate>
        <div className="pc-field">
          <label htmlFor={`${id}-recipient`}>{t.recipient}</label>
          <input
            id={`${id}-recipient`}
            type="email"
            dir="ltr"
            maxLength={254}
            autoComplete="email"
            value={recipient}
            onChange={(event) => setRecipient(event.target.value)}
            data-testid="email-test-recipient"
          />
        </div>
        <div className="pc-field">
          <label htmlFor={`${id}-locale`}>{t.locale}</label>
          <select
            id={`${id}-locale`}
            value={locale}
            onChange={(event) => setLocale(event.target.value === 'ar' ? 'ar' : 'en')}
            data-testid="email-test-locale"
          >
            <option value="en">{t.locales.en}</option>
            <option value="ar">{t.locales.ar}</option>
          </select>
        </div>
        {error === null ? null : <FormError message={error} />}
        {result === null ? null : result.accepted ? (
          <FormSuccess message={t.accepted} />
        ) : (
          <FormError
            message={t.failed(
              result.failure !== null ? (m.deliveries.failures[result.failure] ?? '') : '',
            )}
          />
        )}
        <div className="pc-actions">
          <button
            type="submit"
            className="pc-btn pc-btn-secondary"
            disabled={sending || dirty}
            data-testid="email-test-send"
          >
            {sending ? t.sending : t.send}
          </button>
        </div>
      </form>
    </section>
  );
}
