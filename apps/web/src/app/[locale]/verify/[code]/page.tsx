'use client';

import { useParams } from 'next/navigation';
import { useEffect, useState } from 'react';
import { PublicCertificate } from '@/components/certificate';
import { getCertificatesMessages } from '@/i18n/certificates-messages';
import { resolveLocale } from '@/i18n/locales';
import {
  ApiError,
  verifyCertificate,
  type PublicCertificateVerificationResponse,
} from '@/lib/api-client';

/**
 * The answer a verifier gets (§99–§115).
 *
 * Three answers, not two: valid, revoked and expired are each stated in
 * words. A revoked certificate deliberately reaches this page rather than a
 * "not found" — an old QR code telling its holder the truth is the whole
 * reason online verification exists.
 *
 * Unknown and malformed codes share one answer, because distinguishing them
 * would tell somebody probing which of their guesses had the right shape.
 */
export default function VerifyResultPage() {
  const params = useParams();
  const locale = resolveLocale(params.locale);
  const code = typeof params.code === 'string' ? params.code : '';
  const messages = getCertificatesMessages(locale);

  const [result, setResult] = useState<PublicCertificateVerificationResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const verified = await verifyCertificate(code);
        if (!cancelled) setResult(verified);
      } catch (caught) {
        if (cancelled) return;
        setError(
          caught instanceof ApiError
            ? (messages.errors[caught.code] ?? messages.notFound)
            : messages.genericError,
        );
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [code, messages]);

  return (
    <main className="pc-page">
      <h1>{messages.verifyTitle}</h1>
      {error === null ? null : (
        <p role="alert" data-status="NOT_FOUND">
          {error}
        </p>
      )}
      {result === null ? null : <PublicCertificate locale={locale} result={result} />}
    </main>
  );
}
