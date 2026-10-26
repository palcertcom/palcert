'use client';

import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useState, type FormEvent } from 'react';
import { Field, FormError, FormShell, FormSuccess, SubmitButton } from '@/components/auth-form';
import { ApiError, authApi } from '@/lib/api-client';
import { getAuthMessages, messageForErrorCode } from '@/i18n/auth-messages';
import { resolveLocale } from '@/i18n/locales';

export default function ForgotPasswordPage() {
  const locale = resolveLocale(useParams().locale);
  const messages = getAuthMessages(locale);

  const [email, setEmail] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function onSubmit(event: FormEvent): Promise<void> {
    event.preventDefault();
    setError(null);
    setSuccess(null);
    setPending(true);

    try {
      await authApi.forgotPassword(email);
      // Identical message regardless of whether the account exists.
      setSuccess(messages.forgotSent);
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
    <FormShell title={messages.forgotTitle} subtitle={messages.forgotSubtitle}>
      <form className="pc-form" onSubmit={onSubmit} noValidate>
        <FormError message={error} />
        <FormSuccess message={success} />
        <Field
          label={messages.email}
          type="email"
          name="email"
          value={email}
          onChange={setEmail}
          autoComplete="email"
          inputMode="email"
        />
        <SubmitButton label={messages.submit} pendingLabel={messages.sending} pending={pending} />
      </form>

      <nav className="pc-links">
        <Link href={`/${locale}/login`}>{messages.backToSignIn}</Link>
      </nav>
    </FormShell>
  );
}
