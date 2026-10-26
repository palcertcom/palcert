'use client';

import { useParams, useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useState, type FormEvent } from 'react';
import { Field, FormError, FormShell, SubmitButton } from '@/components/auth-form';
import { ApiError, authApi } from '@/lib/api-client';
import { getAuthMessages, messageForErrorCode } from '@/i18n/auth-messages';
import { resolveLocale } from '@/i18n/locales';
import { safeReturnPath } from '@/lib/return-path';

export default function MfaChallengePage() {
  return (
    <Suspense fallback={null}>
      <MfaChallenge />
    </Suspense>
  );
}

function MfaChallenge() {
  const locale = resolveLocale(useParams().locale);
  const messages = getAuthMessages(locale);
  const router = useRouter();
  const next = safeReturnPath(locale, useSearchParams().get('next'));

  const [code, setCode] = useState('');
  const [useRecoveryCode, setUseRecoveryCode] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function onSubmit(event: FormEvent): Promise<void> {
    event.preventDefault();
    setError(null);
    setPending(true);

    try {
      await authApi.mfaChallenge({ code, useRecoveryCode });
      router.push(next ?? `/${locale}/profile`);
    } catch (caught) {
      setError(
        caught instanceof ApiError
          ? messageForErrorCode(messages, caught.code)
          : messages.genericError,
      );
      setCode('');
      setPending(false);
    }
  }

  return (
    <FormShell title={messages.mfaTitle} subtitle={messages.mfaSubtitle}>
      <form className="pc-form" onSubmit={onSubmit} noValidate>
        <FormError message={error} />
        <Field
          label={useRecoveryCode ? messages.mfaRecoveryCode : messages.mfaCode}
          type="text"
          name={useRecoveryCode ? 'recovery-code' : 'one-time-code'}
          value={code}
          onChange={setCode}
          // `one-time-code` lets the browser and platform offer the SMS/app code.
          autoComplete={useRecoveryCode ? 'off' : 'one-time-code'}
          inputMode={useRecoveryCode ? 'text' : 'numeric'}
          maxLength={useRecoveryCode ? 32 : 6}
        />
        <SubmitButton label={messages.submit} pendingLabel={messages.sending} pending={pending} />
        <button
          type="button"
          className="pc-button pc-button-secondary"
          onClick={() => {
            setUseRecoveryCode((current) => !current);
            setCode('');
            setError(null);
          }}
        >
          {useRecoveryCode ? messages.mfaUseAuthenticator : messages.mfaUseRecovery}
        </button>
      </form>
    </FormShell>
  );
}
