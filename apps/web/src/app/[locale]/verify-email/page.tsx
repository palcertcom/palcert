'use client';

import Link from 'next/link';
import { useParams, useSearchParams } from 'next/navigation';
import { Suspense, useEffect, useState } from 'react';
import { FormError, FormShell, FormSuccess } from '@/components/auth-form';
import { ResendVerification } from '@/components/resend-verification';
import { ApiError, authApi } from '@/lib/api-client';
import { getAuthMessages, messageForErrorCode } from '@/i18n/auth-messages';
import { resolveLocale } from '@/i18n/locales';

function VerifyEmail() {
  const locale = resolveLocale(useParams().locale);
  const messages = getAuthMessages(locale);
  const token = useSearchParams().get('token');

  const [state, setState] = useState<'pending' | 'done' | 'failed'>('pending');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (token === null || token === '') {
      setError(messages.verifyMissingToken);
      setState('failed');
      return;
    }

    let cancelled = false;
    void authApi
      .verifyEmail(token)
      .then(() => {
        if (!cancelled) setState('done');
      })
      .catch((caught: unknown) => {
        if (cancelled) return;
        setError(
          caught instanceof ApiError
            ? messageForErrorCode(
                messages,
                // The only input here is the token in the link, so a request
                // that fails validation is a link that is not valid.
                caught.code === 'VALIDATION_FAILED' ? 'VERIFICATION_TOKEN_INVALID' : caught.code,
              )
            : messages.genericError,
        );
        setState('failed');
      });

    return () => {
      cancelled = true;
    };
  }, [token, messages]);

  return (
    <FormShell title={messages.verifyTitle}>
      {state === 'pending' && <p role="status">{messages.verifyPending}</p>}
      {state === 'done' && <FormSuccess message={messages.verifySuccess} />}
      {state === 'failed' && <FormError message={error} />}
      {/* A link that no longer works is exactly when a new one is wanted. */}
      {state === 'failed' && <ResendVerification locale={locale} />}

      <nav className="pc-links">
        <Link href={`/${locale}/login`}>{messages.backToSignIn}</Link>
      </nav>
    </FormShell>
  );
}

export default function VerifyEmailPage() {
  return (
    <Suspense fallback={null}>
      <VerifyEmail />
    </Suspense>
  );
}
