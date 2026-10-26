'use client';

import type { PublicAttestationView } from '@palcert/contracts';
import { useParams } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';
import { describeAttestationError } from '@/components/attestation';
import {
  PublicAttestationVerification,
  type CompareFile,
} from '@/components/attestation-verification';
import { getAttestationsMessages } from '@/i18n/attestations-messages';
import { resolveLocale } from '@/i18n/locales';
import { ApiError } from '@/lib/api-client';
import { publicAttestationsApi, sha256OfFile } from '@/lib/attestations-api';

/**
 * The public answer for one attestation link.
 *
 * VALID, EXPIRED and REVOKED are each said in words; a revoked attestation
 * reaches this page rather than "not found", because an old QR code telling
 * its holder the truth is the reason the page exists. Unknown and malformed
 * links share one answer. The attested file is never offered here (ADR-0145):
 * a visitor who holds it can check it below, on their own device.
 */
export default function PublicAttestationPage() {
  const params = useParams();
  const locale = resolveLocale(params.locale);
  const token = typeof params.token === 'string' ? params.token : '';
  const messages = getAttestationsMessages(locale);
  const p = messages.public;

  const [view, setView] = useState<PublicAttestationView | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void publicAttestationsApi
      .verify(token)
      .then((result) => {
        if (!cancelled) setView(result);
      })
      .catch((caught: unknown) => {
        if (cancelled) return;
        setError(
          caught instanceof ApiError && caught.code === 'ATTESTATION_NOT_FOUND'
            ? p.notFound
            : describeAttestationError(messages, caught),
        );
      });
    return () => {
      cancelled = true;
    };
  }, [token, messages, p.notFound]);

  // The exact bytes decide, nothing else: the digest is computed here, and
  // compared with this attestation's. Only the digest leaves the device, to ask
  // whether another attestation covers the file.
  const compare = useCallback<CompareFile>(
    async (file) => {
      const digest = await sha256OfFile(file);
      if (view !== null && digest === view.artifactSha256) return { digest, outcome: 'match' };
      const other = await publicAttestationsApi.verifyDigest(digest).catch(() => null);
      return { digest, outcome: other?.matched === true ? 'other' : 'differs' };
    },
    [view],
  );

  return (
    <main className="pc-page">
      <h1>{p.title}</h1>
      {error === null ? null : (
        <p role="alert" data-status="NOT_FOUND" data-testid="public-attestation-error">
          {error}
        </p>
      )}
      {view === null ? (
        error === null ? (
          <p className="pc-hint">{messages.loading}</p>
        ) : null
      ) : (
        <PublicAttestationVerification
          view={view}
          messages={messages}
          locale={locale}
          compare={compare}
          onFailure={() => setError(messages.genericError)}
        />
      )}
    </main>
  );
}
