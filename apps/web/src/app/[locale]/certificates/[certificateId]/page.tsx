'use client';

import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useEffect, useState } from 'react';
import { FormError } from '@/components/auth-form';
import { CertificateCard } from '@/components/certificate';
import { PageHeader } from '@/components/ui/page-header';
import { LoadingState } from '@/components/ui/states';
import { getCertificatesMessages } from '@/i18n/certificates-messages';
import { getShellMessages } from '@/i18n/shell-messages';
import { resolveLocale } from '@/i18n/locales';
import {
  ApiError,
  certificatesApi,
  type CertificateEventResponse,
  type CertificateResponse,
} from '@/lib/api-client';

/** One certificate of this person's own, with what has happened to it (§121). */
export default function CertificatePage() {
  const params = useParams();
  const locale = resolveLocale(params.locale);
  const certificateId = typeof params.certificateId === 'string' ? params.certificateId : '';
  const messages = getCertificatesMessages(locale);

  const [certificate, setCertificate] = useState<CertificateResponse | null>(null);
  const [events, setEvents] = useState<CertificateEventResponse[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const [one, history] = await Promise.all([
          certificatesApi.get(certificateId),
          certificatesApi.events(certificateId),
        ]);
        if (cancelled) return;
        setCertificate(one);
        setEvents(history);
      } catch (caught) {
        if (cancelled) return;
        setError(
          caught instanceof ApiError
            ? (messages.errors[caught.code] ?? messages.genericError)
            : messages.genericError,
        );
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [certificateId, messages]);

  const when = new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short' });
  const shell = getShellMessages(locale);

  return (
    <main className="pc-page">
      <p className="pc-back-link">
        <Link href={`/${locale}/certificates`}>{messages.backToCertificates}</Link>
      </p>
      {error === null ? null : <FormError message={error} />}
      {certificate === null ? (
        error === null ? (
          <LoadingState label={messages.loading} />
        ) : null
      ) : (
        <>
          <PageHeader title={messages.title} description={messages.authorityNote} />
          <div className="pc-detail-grid">
            <div className="pc-detail-main">
              <CertificateCard locale={locale} certificate={certificate} />
              <section className="pc-card" aria-labelledby="certificate-hashes">
                <h2 id="certificate-hashes" className="pc-card-title">
                  {messages.hashes}
                </h2>
                <p className="pc-hint">{messages.hashesHint}</p>
                <dl className="pc-definitions">
                  <dt>{messages.documentHash}</dt>
                  <dd>
                    <code className="pc-hash">{certificate.documentSha256}</code>
                  </dd>
                  <dt>{messages.reportHash}</dt>
                  <dd>
                    <code className="pc-hash">{certificate.reportHash}</code>
                  </dd>
                  <dt>{messages.claimHash}</dt>
                  <dd>
                    <code className="pc-hash">{certificate.certificateClaimHash ?? ''}</code>
                  </dd>
                </dl>
              </section>
            </div>

            <aside className="pc-detail-side">
              {events.length === 0 ? null : (
                <section className="pc-card" aria-labelledby="certificate-history">
                  <h2 id="certificate-history" className="pc-card-title">
                    {messages.history}
                  </h2>
                  <ol className="pc-timeline">
                    {events.map((event) => (
                      <li
                        key={event.id}
                        data-tone={event.eventType === 'REVOKED' ? 'danger' : 'success'}
                      >
                        <strong>
                          {messages.issuanceStatuses[
                            event.eventType === 'REVOKED' ? 'REVOKED' : 'ISSUED'
                          ] ?? event.eventType}
                        </strong>
                        <time dateTime={event.createdAt}>
                          {when.format(new Date(event.createdAt))}
                        </time>
                        {event.reasonCode === null ? null : (
                          <span className="pc-hint">
                            {messages.reasons[event.reasonCode] ?? event.reasonCode}
                          </span>
                        )}
                      </li>
                    ))}
                  </ol>
                </section>
              )}
              <section className="pc-card" aria-labelledby="certificate-verify">
                <h2 id="certificate-verify" className="pc-card-title">
                  {shell.verifyCertificate}
                </h2>
                <p className="pc-hint">{shell.verifyCertificateHint}</p>
                <Link href={`/${locale}/verify`}>{shell.verifyCertificate}</Link>
              </section>
            </aside>
          </div>
        </>
      )}
    </main>
  );
}
