'use client';

import { useParams, useRouter } from 'next/navigation';
import { useEffect, useState, type FormEvent } from 'react';
import { Field, FormError, FormShell, SubmitButton } from '@/components/auth-form';
import { ApiError, authApi } from '@/lib/api-client';
import { getAuthMessages, messageForErrorCode } from '@/i18n/auth-messages';
import { resolveLocale } from '@/i18n/locales';

interface Enrollment {
  provisioningUri: string;
  qrCodeDataUrl: string;
  secret: string;
}

export default function MfaEnrollPage() {
  const locale = resolveLocale(useParams().locale);
  const messages = getAuthMessages(locale);
  const router = useRouter();

  const [enrollment, setEnrollment] = useState<Enrollment | null>(null);
  const [recoveryCodes, setRecoveryCodes] = useState<string[] | null>(null);
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void authApi
      .mfaEnroll()
      .then((result) => {
        if (!cancelled) setEnrollment(result);
      })
      .catch((caught: unknown) => {
        if (cancelled) return;
        setError(
          caught instanceof ApiError
            ? messageForErrorCode(messages, caught.code)
            : messages.genericError,
        );
      });
    return () => {
      cancelled = true;
    };
  }, [messages]);

  async function onConfirm(event: FormEvent): Promise<void> {
    event.preventDefault();
    setError(null);
    setPending(true);

    try {
      const result = await authApi.mfaConfirm(code);
      // Shown exactly once — there is no endpoint that can retrieve them again.
      setRecoveryCodes(result.recoveryCodes);
    } catch (caught) {
      setError(
        caught instanceof ApiError
          ? messageForErrorCode(messages, caught.code)
          : messages.genericError,
      );
      setCode('');
    } finally {
      setPending(false);
    }
  }

  if (recoveryCodes !== null) {
    return (
      <FormShell title={messages.mfaRecoveryCodesTitle}>
        <p className="pc-alert pc-alert-success" role="status">
          {messages.mfaRecoveryCodesWarning}
        </p>
        <ul className="pc-recovery-codes">
          {recoveryCodes.map((recoveryCode) => (
            <li key={recoveryCode}>{recoveryCode}</li>
          ))}
        </ul>
        <div className="pc-links">
          <button
            type="button"
            className="pc-button"
            onClick={() => router.push(`/${locale}/profile`)}
          >
            {messages.mfaContinue}
          </button>
        </div>
      </FormShell>
    );
  }

  return (
    <FormShell title={messages.mfaEnrollTitle} subtitle={messages.mfaEnrollSubtitle}>
      <FormError message={error} />

      {enrollment !== null && (
        <>
          {/* A plain <img> is correct here: the source is a data: URL our own
              API generated, so next/image's remote optimization has nothing to
              do and would only add a network round trip. */}
          <img className="pc-qr" src={enrollment.qrCodeDataUrl} alt={messages.mfaEnrollQrAlt} />
          <p className="pc-hint">{messages.mfaEnrollSecretLabel}</p>
          <p className="pc-secret" dir="ltr">
            {enrollment.secret}
          </p>

          <form className="pc-form" onSubmit={onConfirm} noValidate>
            <Field
              label={messages.mfaCode}
              type="text"
              name="one-time-code"
              value={code}
              onChange={setCode}
              autoComplete="one-time-code"
              inputMode="numeric"
              maxLength={6}
            />
            <SubmitButton
              label={messages.mfaEnrollConfirm}
              pendingLabel={messages.sending}
              pending={pending}
            />
          </form>
        </>
      )}
    </FormShell>
  );
}
