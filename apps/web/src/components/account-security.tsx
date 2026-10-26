'use client';

import Link from 'next/link';
import { useEffect, useState, type FormEvent } from 'react';
import { Field, FormError, FormSuccess, SubmitButton } from '@/components/auth-form';
import { Dialog } from '@/components/ui/dialog';
import { StatusBadge } from '@/components/ui/status-badge';
import { getAIMessages } from '@/i18n/ai-messages';
import { getAuthMessages, messageForErrorCode } from '@/i18n/auth-messages';
import type { Locale } from '@/i18n/locales';
import { ApiError, aiApi, authApi, type AIConsentResponse } from '@/lib/api-client';

/** The session behind the request is gone: the only way on is to sign in again. */
const SESSION_ENDED = new Set([
  'UNAUTHENTICATED',
  'SESSION_EXPIRED',
  'SESSION_REVOKED',
  'REAUTHENTICATION_REQUIRED',
]);

/**
 * Turning off the second factor.
 *
 * Exactly what `DELETE /auth/mfa` requires — the current password and a
 * current code — asked for in a dialog, because removing a second factor is
 * the kind of change that deserves a pause. An account whose roles (or an
 * administrator's override) require a second factor cannot do this at all:
 * the API refuses, so it is told so instead of being offered a button that
 * would fail. The API stays the authority; this only avoids the dead end.
 */
export function DisableMfa({
  locale,
  mfaRequired,
  requiredByRole,
  canManage,
  onDisabled,
}: {
  locale: Locale;
  /** The account must keep a second factor (`UserProfileResponse.mfaRequired`). */
  mfaRequired: boolean;
  /** One of the account's roles is why (rather than an administrator's override). */
  requiredByRole: boolean;
  /** `mfa:manage:self` is held. */
  canManage: boolean;
  onDisabled: () => Promise<void> | void;
}) {
  const messages = getAuthMessages(locale);
  const [open, setOpen] = useState(false);
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sessionEnded, setSessionEnded] = useState(false);

  const requiredNote = requiredByRole ? messages.mfaRequiredByRoleNote : messages.mfaRequiredNote;
  if (mfaRequired) {
    return (
      <p className="pc-hint" data-testid="mfa-required-note">
        {requiredNote}
      </p>
    );
  }
  if (!canManage) return null;

  function close(): void {
    setOpen(false);
    setPassword('');
    setCode('');
    setError(null);
    setSessionEnded(false);
  }

  async function onSubmit(event: FormEvent): Promise<void> {
    event.preventDefault();
    if (pending) return;
    if (password.length === 0 || code.trim().length === 0) {
      setError(messages.requiredField);
      return;
    }
    setError(null);
    setSessionEnded(false);
    setPending(true);
    try {
      await authApi.disableMfa({ password, code: code.trim() });
      close();
      await onDisabled();
    } catch (caught) {
      const failure = caught instanceof ApiError ? caught.code : null;
      setSessionEnded(failure !== null && SESSION_ENDED.has(failure));
      setError(
        failure === null
          ? messages.genericError
          : failure === 'AUTHENTICATION_FAILED'
            ? messages.currentPasswordWrong
            : failure === 'PERMISSION_DENIED'
              ? requiredNote
              : messageForErrorCode(messages, failure),
      );
      // The code is single-use in practice; the password is not re-typed for nothing.
      setCode('');
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="pc-actions">
      <button
        type="button"
        className="pc-btn pc-btn-secondary"
        aria-label={messages.mfaDisable}
        onClick={() => setOpen(true)}
      >
        {messages.profileMfaTurnOff}
      </button>
      <Dialog
        open={open}
        title={messages.mfaDisable}
        description={<p>{messages.mfaDisableIntro}</p>}
        onClose={close}
        closeLabel={messages.close}
      >
        <form className="pc-form" onSubmit={onSubmit} noValidate>
          <FormError message={error} />
          {sessionEnded ? (
            <p>
              <Link
                className="pc-btn pc-btn-secondary"
                href={`/${locale}/login?next=${encodeURIComponent(`/${locale}/profile`)}`}
              >
                {messages.signInAgain}
              </Link>
            </p>
          ) : null}
          <Field
            label={messages.currentPassword}
            type="password"
            name="mfa-disable-password"
            value={password}
            onChange={setPassword}
            autoComplete="current-password"
          />
          <Field
            label={messages.mfaCode}
            type="text"
            name="mfa-disable-code"
            value={code}
            onChange={setCode}
            autoComplete="one-time-code"
            inputMode="numeric"
          />
          <div className="pc-actions">
            <button type="button" className="secondary" onClick={close}>
              {messages.cancel}
            </button>
            <SubmitButton
              label={messages.mfaDisable}
              pendingLabel={messages.sending}
              pending={pending}
            />
          </div>
        </form>
      </Dialog>
    </div>
  );
}

/**
 * The person's own agreement to external AI processing: its date, and the
 * way to take it back. Withdrawing is confirmed first, because it changes
 * what the next AI review will ask.
 */
export function AiConsentSettings({ locale }: { locale: Locale }) {
  const ai = getAIMessages(locale);
  const auth = getAuthMessages(locale);
  const [consent, setConsent] = useState<AIConsentResponse | null>(null);
  const [unavailable, setUnavailable] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    aiApi
      .consent()
      .then((result) => {
        if (!cancelled) setConsent(result);
      })
      .catch(() => {
        // No permission for AI review, or the feature is off: say nothing
        // rather than show a card that cannot do anything.
        if (!cancelled) setUnavailable(true);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  if (unavailable || consent === null) return null;

  async function withdraw(): Promise<void> {
    if (pending) return;
    setPending(true);
    setError(null);
    try {
      setConsent(await aiApi.withdrawConsent());
      setConfirming(false);
      setDone(ai.consentWithdrawn);
    } catch (caught) {
      setError(
        caught instanceof ApiError
          ? (ai.errors[caught.code] ?? messageForErrorCode(auth, caught.code))
          : auth.genericError,
      );
    } finally {
      setPending(false);
    }
  }

  const when = new Intl.DateTimeFormat(locale, { dateStyle: 'medium' });

  return (
    <section id="ai-consent" className="pc-card" aria-labelledby="ai-consent-heading">
      <h2 id="ai-consent-heading" className="pc-card-title">
        {ai.consentSettingsTitle}
      </h2>
      <FormSuccess message={done} />
      {consent.granted ? (
        <>
          <p>
            {ai.consentGrantedOn}{' '}
            {consent.consentedAt === null ? null : (
              <time dateTime={consent.consentedAt}>
                {when.format(new Date(consent.consentedAt))}
              </time>
            )}
          </p>
          {consent.renewalRequired ? (
            <StatusBadge tone="gold" label={ai.consentRenewalRequired} />
          ) : null}
          <div className="pc-actions">
            <button
              type="button"
              className="pc-btn pc-btn-secondary"
              onClick={() => setConfirming(true)}
            >
              {ai.consentWithdraw}
            </button>
          </div>
        </>
      ) : (
        <p className="pc-hint">{ai.consentNone}</p>
      )}
      <Dialog
        open={confirming}
        title={ai.consentWithdraw}
        description={<p>{ai.consentWithdrawIntro}</p>}
        onClose={() => {
          setConfirming(false);
          setError(null);
        }}
        closeLabel={auth.close}
      >
        <FormError message={error} />
        <div className="pc-actions">
          <button type="button" className="secondary" onClick={() => setConfirming(false)}>
            {auth.cancel}
          </button>
          <button
            type="button"
            className="pc-danger"
            disabled={pending}
            aria-busy={pending}
            onClick={() => void withdraw()}
          >
            {pending ? auth.sending : ai.consentWithdraw}
          </button>
        </div>
      </Dialog>
    </section>
  );
}
