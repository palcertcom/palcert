'use client';

import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useState, type FormEvent } from 'react';
import { ResendVerification } from '@/components/resend-verification';
import { Field, FormError, FormShell, FormSuccess, SubmitButton } from '@/components/auth-form';
import { ApiError, authApi } from '@/lib/api-client';
import { getAuthMessages, messageForErrorCode } from '@/i18n/auth-messages';
import { resolveLocale } from '@/i18n/locales';

export default function RegisterPage() {
  const locale = resolveLocale(useParams().locale);
  const messages = getAuthMessages(locale);

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [registeredEmail, setRegisteredEmail] = useState<string | null>(null);

  async function onSubmit(event: FormEvent): Promise<void> {
    event.preventDefault();
    setError(null);
    setSuccess(null);
    setPending(true);

    try {
      await authApi.register({
        email,
        password,
        locale,
        ...(displayName.trim() !== '' ? { displayName: displayName.trim() } : {}),
      });
      // Deliberately the same message whether or not the address was already
      // registered — the API does not tell us, by design.
      setSuccess(messages.registerSuccess);
      setRegisteredEmail(email.trim());
      setEmail('');
      setPassword('');
      setDisplayName('');
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
    <FormShell title={messages.registerTitle} subtitle={messages.registerSubtitle}>
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
        <Field
          label={messages.displayNameOptional}
          type="text"
          name="name"
          value={displayName}
          onChange={setDisplayName}
          autoComplete="name"
          required={false}
        />
        <Field
          label={messages.password}
          type="password"
          name="new-password"
          value={password}
          onChange={setPassword}
          autoComplete="new-password"
          hint={messages.passwordHint}
        />
        <SubmitButton label={messages.register} pendingLabel={messages.sending} pending={pending} />
      </form>
      {registeredEmail === null ? null : (
        <ResendVerification locale={locale} email={registeredEmail} />
      )}

      <nav className="pc-links">
        <Link href={`/${locale}/login`}>
          {messages.alreadyHaveAccount} {messages.signIn}
        </Link>
      </nav>
    </FormShell>
  );
}
