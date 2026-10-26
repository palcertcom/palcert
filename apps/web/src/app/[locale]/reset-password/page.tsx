'use client';

import Link from 'next/link';
import { useParams, useSearchParams } from 'next/navigation';
import { Suspense, useState, type FormEvent } from 'react';
import { Field, FormError, FormShell, FormSuccess, SubmitButton } from '@/components/auth-form';
import { ApiError, authApi } from '@/lib/api-client';
import { getAuthMessages, messageForErrorCode } from '@/i18n/auth-messages';
import { resolveLocale } from '@/i18n/locales';

function ResetPassword() {
  const locale = resolveLocale(useParams().locale);
  const messages = getAuthMessages(locale);
  const token = useSearchParams().get('token');

  const [password, setPassword] = useState('');
  const [confirmation, setConfirmation] = useState('');
  const [mismatch, setMismatch] = useState<string | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function onSubmit(event: FormEvent): Promise<void> {
    event.preventDefault();
    setError(null);
    setMismatch(undefined);

    if (token === null || token === '') {
      setError(messages.resetMissingToken);
      return;
    }
    if (password !== confirmation) {
      setMismatch(messages.passwordMismatch);
      return;
    }

    setPending(true);
    try {
      await authApi.resetPassword({ token, newPassword: password });
      setSuccess(messages.resetSuccess);
      setPassword('');
      setConfirmation('');
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
    <FormShell title={messages.resetTitle}>
      <form className="pc-form" onSubmit={onSubmit} noValidate>
        <FormError message={error} />
        <FormSuccess message={success} />
        <Field
          label={messages.newPassword}
          type="password"
          name="new-password"
          value={password}
          onChange={setPassword}
          autoComplete="new-password"
          hint={messages.passwordHint}
        />
        <Field
          label={messages.confirmPassword}
          type="password"
          name="confirm-password"
          value={confirmation}
          onChange={setConfirmation}
          autoComplete="new-password"
          {...(mismatch !== undefined ? { error: mismatch } : {})}
        />
        <SubmitButton label={messages.submit} pendingLabel={messages.sending} pending={pending} />
      </form>

      <nav className="pc-links">
        <Link href={`/${locale}/login`}>{messages.backToSignIn}</Link>
      </nav>
    </FormShell>
  );
}

export default function ResetPasswordPage() {
  return (
    <Suspense fallback={null}>
      <ResetPassword />
    </Suspense>
  );
}
