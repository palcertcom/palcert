'use client';

import { PageHeader } from '@/components/ui/page-header';
import { LoadingState } from '@/components/ui/states';
import { StatusBadge } from '@/components/ui/status-badge';
import { useParams } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';
import { FormError } from '@/components/auth-form';
import { AuthorityRows, RevokeCertificate } from '@/components/certificate';
import { getCertificatesMessages } from '@/i18n/certificates-messages';
import { resolveLocale } from '@/i18n/locales';
import {
  ApiError,
  certificateReviewApi,
  type CertificateEventResponse,
  type CertificateResponse,
} from '@/lib/api-client';

/**
 * A certificate as the institution that caused it sees it (§119).
 *
 * Reading is part of reviewing. Revoking is not: the button below only works
 * for somebody holding the separate revocation permission, which reviewers
 * and template managers do not have by default — withdrawing the thing a
 * person shows an employer is a heavier act than recording a decision.
 */
export default function OrganizationCertificatePage() {
  const params = useParams();
  const locale = resolveLocale(params.locale);
  const organizationId = typeof params.organizationId === 'string' ? params.organizationId : '';
  const certificateId = typeof params.certificateId === 'string' ? params.certificateId : '';
  const messages = getCertificatesMessages(locale);

  const [certificate, setCertificate] = useState<CertificateResponse | null>(null);
  const [events, setEvents] = useState<CertificateEventResponse[]>([]);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const [one, history] = await Promise.all([
        certificateReviewApi.get(organizationId, certificateId),
        certificateReviewApi.events(organizationId, certificateId),
      ]);
      setCertificate(one);
      setEvents(history);
    } catch (caught) {
      setError(
        caught instanceof ApiError
          ? (messages.errors[caught.code] ?? messages.genericError)
          : messages.genericError,
      );
    }
  }, [certificateId, messages, organizationId]);

  useEffect(() => {
    void load();
  }, [load]);

  const when = new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short' });

  return (
    <main className="pc-page">
      <PageHeader title={messages.title} />
      {error === null ? null : <FormError message={error} />}

      {certificate === null ? (
        error === null ? (
          <LoadingState label={messages.loading} />
        ) : null
      ) : (
        <div className="pc-detail-grid">
          <section className="pc-card" aria-labelledby="org-certificate-status">
            <h2 id="org-certificate-status" className="pc-card-title">
              <StatusBadge
                tone={certificate.revokedAt === null ? 'success' : 'danger'}
                label={
                  (certificate.revokedAt === null
                    ? messages.statuses.VALID
                    : messages.statuses.REVOKED) ?? ''
                }
              />
            </h2>
            <dl className="pc-summary">
              <dt>{messages.certificateNumber}</dt>
              <dd>
                <code>{certificate.certificateNumber ?? '—'}</code>
              </dd>
              <AuthorityRows
                locale={locale}
                technicalResult={certificate.technicalResult}
                institutionDecision={certificate.institutionDecision}
              />
              <dt>{messages.documentType}</dt>
              <dd>
                <bdi>{certificate.documentTypeName}</bdi>
              </dd>
              <dt>{messages.standard}</dt>
              <dd>
                <bdi>
                  {certificate.standardName} · {certificate.standardVersionLabel}
                </bdi>
              </dd>
            </dl>
          </section>

          <div className="pc-detail-side">
            <section className="pc-card" aria-labelledby="org-certificate-history">
              <h2 id="org-certificate-history" className="pc-card-title">
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
                    <time dateTime={event.createdAt}>{when.format(new Date(event.createdAt))}</time>
                    {event.reasonCode === null ? null : (
                      <span>{messages.reasons[event.reasonCode] ?? event.reasonCode}</span>
                    )}
                  </li>
                ))}
              </ol>
            </section>

            {certificate.revokedAt === null ? (
              <RevokeCertificate
                locale={locale}
                organizationId={organizationId}
                certificateId={certificateId}
                onRevoked={(revoked) => {
                  setCertificate(revoked);
                  void load();
                }}
              />
            ) : null}
          </div>
        </div>
      )}
    </main>
  );
}
