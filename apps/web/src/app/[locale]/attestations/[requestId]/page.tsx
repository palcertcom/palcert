'use client';

import type { AttestationReceiptView, AttestationRequestOwnerView } from '@palcert/contracts';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';
import {
  AttestationDisclaimer,
  AttestationRecordCard,
  EventHistory,
  HashValue,
  PaymentBadge,
  RequestStatusBadge,
  SubmittedDetails,
  describeAttestationError,
  formatDate,
  money,
} from '@/components/attestation';
import { FormError } from '@/components/auth-form';
import { ConfirmAction } from '@/components/ui/confirm-action';
import { PageHeader } from '@/components/ui/page-header';
import { LoadingState } from '@/components/ui/states';
import { getAttestationsMessages } from '@/i18n/attestations-messages';
import { resolveLocale } from '@/i18n/locales';
import { attestationsApi } from '@/lib/attestations-api';

/** One attestation request, from the side of the person who asked. */
export default function AttestationRequestPage() {
  const params = useParams();
  const locale = resolveLocale(params.locale);
  const requestId = typeof params.requestId === 'string' ? params.requestId : '';
  const messages = getAttestationsMessages(locale);
  const d = messages.details;

  const [request, setRequest] = useState<AttestationRequestOwnerView | null>(null);
  const [receipt, setReceipt] = useState<AttestationReceiptView | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setRequest(await attestationsApi.get(requestId));
    } catch (caught) {
      setError(describeAttestationError(messages, caught));
    }
  }, [requestId, messages]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (request?.fee.paymentStatus !== 'SETTLED') return;
    void attestationsApi
      .receipt(request.id)
      .then(setReceipt)
      .catch(() => undefined);
  }, [request]);

  const labels = {
    cancel: messages.cancel,
    close: messages.close,
    optional: messages.optional,
    pending: messages.saving,
    invalid: messages.required,
  };
  const describe = (caught: unknown) => ({
    message: describeAttestationError(messages, caught),
    reauth: false,
  });

  async function downloadMine(): Promise<void> {
    try {
      const link = await attestationsApi.downloadArtifact(requestId);
      window.location.assign(link.url);
    } catch (caught) {
      setError(describeAttestationError(messages, caught));
    }
  }

  if (request === null) {
    return (
      <main className="pc-page">
        <Link className="pc-back-link" href={`/${locale}/attestations`}>
          {d.backToList}
        </Link>
        {error === null ? <LoadingState label={messages.loading} /> : <FormError message={error} />}
      </main>
    );
  }

  const typeName =
    locale === 'ar' ? request.attestationTypeName.ar : request.attestationTypeName.en;

  return (
    <main className="pc-page" data-testid="attestation-request" data-status={request.status}>
      <Link className="pc-back-link" href={`/${locale}/attestations`}>
        {d.backToList}
      </Link>
      <PageHeader
        title={<bdi>{request.submitted.certificateTitle || d.requestTitle}</bdi>}
        description={
          <>
            <bdi>{request.organizationName}</bdi> · <bdi>{typeName}</bdi>
          </>
        }
        actions={<RequestStatusBadge status={request.status} messages={messages} />}
      />
      {error === null ? null : <FormError message={error} />}

      {request.status === 'NEEDS_INFORMATION' && request.openInformationRequest !== null ? (
        <section
          className="pc-card"
          role="region"
          aria-label={d.institutionAsked}
          data-testid="information-request"
        >
          <h2 className="pc-card-title">{d.institutionAsked}</h2>
          <p>
            <bdi>{request.openInformationRequest}</bdi>
          </p>
          {request.canRespond ? (
            <ConfirmAction
              labels={labels}
              describeError={describe}
              label={d.respond}
              title={d.respondTitle}
              intro={d.respondIntro}
              confirmLabel={d.send}
              buttonClassName="pc-btn"
              fields={[
                {
                  name: 'message',
                  label: d.responseLabel,
                  maxLength: 2000,
                  required: true,
                  multiline: true,
                },
              ]}
              onConfirm={async (values) => {
                setRequest(await attestationsApi.respond(request.id, values['message'] ?? ''));
              }}
            />
          ) : null}
        </section>
      ) : null}

      {request.status === 'REJECTED' && request.rejectionReason !== null ? (
        <section className="pc-card" data-testid="rejection-reason">
          <h2 className="pc-card-title">{d.rejectedBecause}</h2>
          <p>
            <bdi>{request.rejectionReason}</bdi>
          </p>
        </section>
      ) : null}

      {request.attestation === null ? null : (
        <AttestationRecordCard
          record={request.attestation}
          messages={messages}
          locale={locale}
          qr={{
            svgPath: attestationsApi.qrPath(request.id, 'svg'),
            pngPath: attestationsApi.qrPath(request.id, 'png'),
          }}
          actions={
            <Link
              className="pc-btn pc-btn-secondary"
              href={`/${locale}/attestations/new?renew=${request.id}`}
            >
              {d.renew}
            </Link>
          }
        />
      )}

      <div className="pc-detail-grid">
        <div className="pc-detail-main">
          <section className="pc-card">
            <h2 className="pc-card-title">{d.submittedDetails}</h2>
            <SubmittedDetails metadata={request.submitted} messages={messages} locale={locale} />
          </section>

          {request.artifact === null ? null : (
            <section className="pc-card">
              <h2 className="pc-card-title">{d.file}</h2>
              <p>
                <bdi>{request.artifact.originalFilename}</bdi>{' '}
                <span className="pc-hint">
                  {messages.artifactStatuses[request.artifact.status] ?? request.artifact.status}
                </span>
              </p>
              {request.artifact.sha256 === null ? null : (
                <HashValue
                  label={d.artifactHash}
                  value={request.artifact.sha256}
                  messages={messages}
                />
              )}
              {request.artifact.status === 'READY' ? (
                <button
                  type="button"
                  className="pc-btn pc-btn-secondary pc-btn-sm"
                  onClick={() => void downloadMine()}
                >
                  {d.downloadMine}
                </button>
              ) : null}
            </section>
          )}

          <section className="pc-card">
            <h2 className="pc-card-title">{d.history}</h2>
            <EventHistory events={request.history} messages={messages} locale={locale} />
          </section>
        </div>

        <aside className="pc-detail-side">
          <section className="pc-card" data-testid="owner-fee">
            <h2 className="pc-card-title">{messages.mine.fee}</h2>
            <p className="pc-money">{money(request.fee.fee, locale)}</p>
            <PaymentBadge status={request.fee.paymentStatus} messages={messages} />
            {receipt === null ? null : (
              <dl className="pc-definitions" data-testid="attestation-receipt">
                <div>
                  <dt>{d.paidAt}</dt>
                  <dd>{formatDate(receipt.paidAt, locale, true)}</dd>
                </div>
                {receipt.paymentTransactionReference === null ? null : (
                  <div>
                    <dt>{d.transaction}</dt>
                    <dd>
                      <code dir="ltr">{receipt.paymentTransactionReference}</code>
                    </dd>
                  </div>
                )}
              </dl>
            )}
          </section>

          <div className="pc-actions">
            {request.status === 'DRAFT' ? (
              <Link className="pc-btn" href={`/${locale}/attestations/new?draft=${request.id}`}>
                {d.continueDraft}
              </Link>
            ) : null}
            {request.canCancel ? (
              <ConfirmAction
                labels={labels}
                describeError={describe}
                label={d.cancelRequest}
                title={d.cancelTitle}
                intro={d.cancelIntro}
                confirmLabel={d.cancelRequest}
                danger
                onConfirm={async () => {
                  setRequest(await attestationsApi.cancel(request.id));
                }}
              />
            ) : null}
          </div>
        </aside>
      </div>
      <AttestationDisclaimer messages={messages} />
    </main>
  );
}
