'use client';

import { useEffect, useId, useState, type FormEvent } from 'react';
import { Field, FormError } from '@/components/auth-form';
import { getAuthMessages, messageForErrorCode } from '@/i18n/auth-messages';
import type { Locale } from '@/i18n/locales';
import { ApiError, authApi } from '@/lib/api-client';

/** Long enough that a double click, or an impatient second click, sends nothing. */
export const RESEND_COOLDOWN_MS = 60_000;

/**
 * Ask for another confirmation link.
 *
 * The API answers the same way whether or not the address has an account
 * waiting to be confirmed, and so does this: the confirmation says what
 * *would* happen, never whether it did. After a send the button rests for a
 * minute, which the server's per-address limit would enforce anyway — this
 * only saves the person a wasted click.
 *
 * With an `email`, it is one button (the address is already known: the
 * sign-in form, the registration just made, the signed-in account). Without
 * one, it asks for the address.
 */
export function ResendVerification({ locale, email }: { locale: Locale; email?: string }) {
  const messages = getAuthMessages(locale);
  const statusId = useId();
  const [address, setAddress] = useState(email ?? '');
  const [pending, setPending] = useState(false);
  const [sent, setSent] = useState(false);
  const [coolingDown, setCoolingDown] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!coolingDown) return;
    const timer = setTimeout(() => setCoolingDown(false), RESEND_COOLDOWN_MS);
    return () => clearTimeout(timer);
  }, [coolingDown]);

  async function onSubmit(event: FormEvent): Promise<void> {
    event.preventDefault();
    if (pending || coolingDown) return;
    const target = (email ?? address).trim();
    if (target.length === 0) {
      setError(messages.requiredField);
      return;
    }
    setError(null);
    setPending(true);
    try {
      await authApi.resendVerification(target);
      setSent(true);
      setCoolingDown(true);
    } catch (caught) {
      setError(
        caught instanceof ApiError
          ? messageForErrorCode(messages, caught.code)
          : messages.genericError,
      );
    } finally {
      setPending(false);
    }
  }

  return (
    <form className="pc-resend" onSubmit={onSubmit} noValidate aria-describedby={statusId}>
      <p className="pc-resend-prompt">{messages.resendPrompt}</p>
      {email === undefined && (
        <Field
          label={messages.email}
          type="email"
          name="resend-email"
          value={address}
          onChange={setAddress}
          autoComplete="email"
          inputMode="email"
        />
      )}
      <button
        type="submit"
        className="secondary"
        disabled={pending || coolingDown}
        aria-busy={pending}
      >
        {pending ? messages.sending : messages.resendVerification}
      </button>
      <div id={statusId} role="status" aria-live="polite">
        {sent ? (
          <p className="pc-resend-sent">
            {messages.resendSent} {coolingDown ? messages.resendCooldown : null}
          </p>
        ) : null}
      </div>
      <FormError message={error} />
    </form>
  );
}
