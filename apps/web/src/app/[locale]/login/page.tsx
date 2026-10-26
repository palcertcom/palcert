'use client';

import Link from 'next/link';
import { useParams, useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useState, type FormEvent } from 'react';
import { Field, FormError, FormShell, SubmitButton } from '@/components/auth-form';
import { ResendVerification } from '@/components/resend-verification';
import { ApiError, authApi } from '@/lib/api-client';
import { getAuthMessages, messageForErrorCode } from '@/i18n/auth-messages';
import { resolveLocale } from '@/i18n/locales';
import { safeReturnPath } from '@/lib/return-path';

export default function LoginPage() {
  return (
    <Suspense fallback={null}>
      <Login />
    </Suspense>
  );
}

function Login() {
  const locale = resolveLocale(useParams().locale);
  const messages = getAuthMessages(locale);
  const router = useRouter();
  // "Sign in again" from a page that needed a recent sign-in comes back here.
  const next = safeReturnPath(locale, useSearchParams().get('next'));

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [unverifiedEmail, setUnverifiedEmail] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function onSubmit(event: FormEvent): Promise<void> {
    event.preventDefault();
    setError(null);
    setUnverifiedEmail(null);
    setPending(true);

    try {
      const result = await authApi.login({ email, password });
      switch (result.status) {
        case 'AUTHENTICATED':
          router.push(next ?? `/${locale}/profile`);
          break;
        case 'MFA_REQUIRED':
          router.push(
            next === null ? `/${locale}/mfa` : `/${locale}/mfa?next=${encodeURIComponent(next)}`,
          );
          break;
        case 'MFA_ENROLLMENT_REQUIRED':
          router.push(`/${locale}/mfa/enroll`);
          break;
      }
    } catch (caught) {
      setError(
        caught instanceof ApiError
          ? messageForErrorCode(messages, caught.code)
          : messages.genericError,
      );
      // Only after the password was right does the API say the address is
      // unconfirmed, so offering a new link here reveals nothing new.
      if (caught instanceof ApiError && caught.code === 'EMAIL_NOT_VERIFIED') {
        setUnverifiedEmail(email.trim());
      }
      setPending(false);
    }
  }

  return (
    <FormShell title={messages.loginTitle} subtitle={messages.loginSubtitle}>
      <form className="pc-form" onSubmit={onSubmit} noValidate>
        <FormError message={error} />
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
          label={messages.password}
          type="password"
          name="password"
          value={password}
          onChange={setPassword}
          autoComplete="current-password"
        />
        <SubmitButton label={messages.signIn} pendingLabel={messages.sending} pending={pending} />
      </form>
      {unverifiedEmail === null ? null : (
        <ResendVerification locale={locale} email={unverifiedEmail} />
      )}

      <nav className="pc-links">
        <Link href={`/${locale}/forgot-password`}>{messages.forgotPasswordLink}</Link>
        <Link href={`/${locale}/register`}>
          {messages.needAccount} {messages.register}
        </Link>
      </nav>
    </FormShell>
  );
}
