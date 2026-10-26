'use client';

import type { ManualTopUpRequestView } from '@palcert/contracts/finance/manual-topups';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';
import {
  DestinationDetails,
  MethodMark,
  TopUpAmount,
  TopUpStatusBadge,
  TopUpTimeline,
  describeTopUpError,
  methodName,
} from '@/components/manual-topup';
import { ConfirmAction } from '@/components/ui/confirm-action';
import { PageHeader } from '@/components/ui/page-header';
import { LoadingState } from '@/components/ui/states';
import { resolveLocale } from '@/i18n/locales';
import { getManualTopUpMessages } from '@/i18n/manual-topup-messages';
import { manualTopUpsApi } from '@/lib/manual-topups-api';

/**
 * One reported transfer, from the person's side: where it stands, what they
 * reported, where they sent it, and what happened. While it waits, the page
 * checks back on its own, so the moment finance decides is the moment the
 * person sees it.
 */
export default function TopUpRequestPage() {
  const params = useParams();
  const locale = resolveLocale(params.locale);
  const requestId = String(params.requestId);
  const messages = getManualTopUpMessages(locale);
  const v = messages.waiting;
  const [request, setRequest] = useState<ManualTopUpRequestView | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setRequest(await manualTopUpsApi.get(requestId));
    } catch (caught) {
      setError(describeTopUpError(messages, caught).message);
    }
  }, [messages, requestId]);

  useEffect(() => {
    void load();
  }, [load]);

  // Check back while it is waiting for finance; stop once it is decided.
  useEffect(() => {
    if (request?.status !== 'PENDING_REVIEW') return;
    const timer = window.setInterval(() => void load(), 30_000);
    return () => window.clearInterval(timer);
  }, [load, request?.status]);

  async function openReceipt(): Promise<void> {
    try {
      const grant = await manualTopUpsApi.receipt(requestId);
      window.open(grant.url, '_blank', 'noopener,noreferrer');
    } catch (caught) {
      setError(describeTopUpError(messages, caught).message);
    }
  }

  const body =
    request === null
      ? null
      : {
          DRAFT: v.draftBody,
          PENDING_REVIEW: v.submittedBody,
          APPROVED: v.approvedBody,
          REJECTED: v.rejectedBody,
          CANCELLED: v.cancelledBody,
        }[request.status];

  return (
    <main className="pc-page">
      <PageHeader title={request?.status === 'PENDING_REVIEW' ? v.submittedTitle : v.title} />
      {error === null ? null : (
        <p className="pc-error" role="alert">
          {error}
        </p>
      )}
      {request === null && error === null ? <LoadingState label={messages.loading} /> : null}

      {request === null ? null : (
        <div className="pc-detail-grid">
          <div className="pc-detail-main">
            <section className="pc-card pc-topup-status" data-status={request.status}>
              <TopUpStatusBadge status={request.status} locale={locale} />
              <p role="status">{body}</p>
              {request.status === 'REJECTED' && request.rejectionReason !== null ? (
                <div className="pc-alert pc-alert-warning">
                  <strong>{messages.rejectionReasons[request.rejectionReason]}</strong>
                  {request.rejectionNote === null ? null : (
                    <p>
                      <span className="pc-hint">{v.rejectionNote}: </span>
                      {request.rejectionNote}
                    </p>
                  )}
                </div>
              ) : null}
              <div className="pc-actions">
                {request.status === 'DRAFT' ? (
                  <Link
                    className="pc-btn pc-btn-primary"
                    href={`/${locale}/balance/add?draft=${request.id}`}
                  >
                    {v.continueDraft}
                  </Link>
                ) : null}
                {request.status === 'REJECTED' ? (
                  <Link className="pc-btn pc-btn-primary" href={`/${locale}/balance/add`}>
                    {v.tryAgain}
                  </Link>
                ) : null}
                {request.cancellable ? (
                  <ConfirmAction
                    labels={messages.confirm}
                    describeError={(caught) => describeTopUpError(messages, caught)}
                    label={v.cancel}
                    title={v.cancelConfirmTitle}
                    intro={v.cancelConfirmBody}
                    confirmLabel={v.cancelConfirm}
                    danger
                    buttonClassName="pc-btn pc-btn-secondary"
                    onConfirm={async () => {
                      setRequest(await manualTopUpsApi.cancel(request.id));
                    }}
                  />
                ) : null}
                <Link className="pc-btn pc-btn-quiet" href={`/${locale}/balance`}>
                  {v.backToBalance}
                </Link>
              </div>
            </section>

            <section className="pc-card" aria-labelledby="topup-summary">
              <h2 id="topup-summary">{v.summary}</h2>
              <dl className="pc-topup-summary">
                <div>
                  <dt>{v.amount}</dt>
                  <dd>
                    {request.amount.minorUnits === '0' ? (
                      '—'
                    ) : (
                      <TopUpAmount amount={request.amount} locale={locale} />
                    )}
                  </dd>
                </div>
                <div>
                  <dt>{v.reference}</dt>
                  <dd className="pc-ltr" dir="ltr">
                    {request.reference ?? '—'}
                  </dd>
                </div>
                {request.customerNote === null ? null : (
                  <div>
                    <dt>{v.note}</dt>
                    <dd>{request.customerNote}</dd>
                  </div>
                )}
                {request.submittedAt === null ? null : (
                  <div>
                    <dt>{v.submittedAt}</dt>
                    <dd>
                      <time dateTime={request.submittedAt}>
                        {new Date(request.submittedAt).toLocaleString(locale)}
                      </time>
                    </dd>
                  </div>
                )}
                {request.decidedAt === null ? null : (
                  <div>
                    <dt>{v.decidedAt}</dt>
                    <dd>
                      <time dateTime={request.decidedAt}>
                        {new Date(request.decidedAt).toLocaleString(locale)}
                      </time>
                    </dd>
                  </div>
                )}
              </dl>
              {request.receipt?.status === 'READY' ? (
                <button
                  type="button"
                  className="pc-btn pc-btn-secondary pc-btn-sm"
                  onClick={() => void openReceipt()}
                >
                  {v.openReceipt}
                </button>
              ) : null}
            </section>
          </div>

          <aside className="pc-detail-side">
            <section className="pc-card" aria-labelledby="topup-method">
              <div className="pc-topup-method-head">
                <MethodMark method={request.paymentMethod} locale={locale} size={32} />
                <h2 id="topup-method">
                  {v.method}: {methodName(request.paymentMethod, locale)}
                </h2>
              </div>
              <DestinationDetails
                destination={request.paymentMethod}
                locale={locale}
                copyable={false}
              />
            </section>
            <section className="pc-card" aria-labelledby="topup-timeline">
              <h2 id="topup-timeline">{v.timeline}</h2>
              <TopUpTimeline events={request.events} locale={locale} />
            </section>
          </aside>
        </div>
      )}
    </main>
  );
}
