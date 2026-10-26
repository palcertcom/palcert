'use client';

import {
  MANUAL_TOPUP_REJECTION_REASONS,
  type AdminManualTopUpRequestView,
  type ManualTopUpNotificationReportView,
} from '@palcert/contracts/finance/manual-topups';
import { useParams } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';
import { AdminGate, ReauthNotice, useAdminLocale } from '@/components/admin/admin-kit';
import {
  DestinationDetails,
  MethodMark,
  TopUpAmount,
  TopUpStatusBadge,
  TopUpTimeline,
  describeTopUpError,
  methodName,
} from '@/components/manual-topup';
import { useShell } from '@/components/shell/shell-context';
import { ConfirmAction } from '@/components/ui/confirm-action';
import { DataTable } from '@/components/ui/data-table';
import { PageHeader } from '@/components/ui/page-header';
import { LoadingState } from '@/components/ui/states';
import type { Locale } from '@/i18n/locales';
import { getManualTopUpMessages } from '@/i18n/manual-topup-messages';
import { manualTopUpsAdminApi } from '@/lib/manual-topups-api';
import { formatMoney } from '@/lib/money';

/**
 * One reported transfer, for the reviewer: who reported it, what they say
 * they sent, where they were told to send it (as it was then), the receipt,
 * and the history. Approving is the only button in PalCert that creates
 * money in somebody's balance, so it says exactly how much, and to whom,
 * before it does.
 */
export default function AdminTopUpPage() {
  return (
    <AdminGate allowed={(can) => can.has('finance:manual-topup:read')}>
      <Review />
    </AdminGate>
  );
}

function Review() {
  const locale = useAdminLocale();
  const requestId = String(useParams().requestId);
  const messages = getManualTopUpMessages(locale);
  const a = messages.admin;
  const v = messages.waiting;
  const { globalPermissions: can } = useShell();
  const [request, setRequest] = useState<AdminManualTopUpRequestView | null>(null);
  const [failure, setFailure] = useState<{ message: string; reauth: boolean } | null>(null);

  const load = useCallback(async () => {
    try {
      setRequest(await manualTopUpsAdminApi.get(requestId));
    } catch (caught) {
      setFailure(describeTopUpError(messages, caught));
    }
  }, [messages, requestId]);

  useEffect(() => {
    void load();
  }, [load]);

  async function openReceipt(): Promise<void> {
    try {
      const grant = await manualTopUpsAdminApi.receipt(requestId);
      window.open(grant.url, '_blank', 'noopener,noreferrer');
    } catch (caught) {
      setFailure(describeTopUpError(messages, caught));
    }
  }

  const pending = request?.status === 'PENDING_REVIEW';
  const canReview = can.has('finance:manual-topup:review');
  const canApprove = can.has('finance:manual-topup:approve');
  const canReject = can.has('finance:manual-topup:reject');
  const reviewer =
    request === null || request.reviewStartedByUserId === null
      ? null
      : (request.events.find((event) => event.eventType === 'REVIEW_STARTED')?.actorDisplayName ??
        a.unknownPerson);
  const describe = (caught: unknown) => describeTopUpError(messages, caught);

  return (
    <main className="pc-page">
      <PageHeader title={a.requestTitle} />
      {failure === null ? null : failure.reauth ? (
        <ReauthNotice locale={locale} />
      ) : (
        <p className="pc-error" role="alert">
          {failure.message}
        </p>
      )}
      {request === null && failure === null ? <LoadingState label={messages.loading} /> : null}

      {request === null ? null : (
        <div className="pc-detail-grid">
          <div className="pc-detail-main">
            <section className="pc-card" aria-labelledby="reported">
              <div className="pc-section-heading">
                <h2 id="reported">{a.reportedTransfer}</h2>
                <TopUpStatusBadge status={request.status} locale={locale} audience="staff" />
              </div>
              <dl className="pc-topup-summary">
                <div>
                  <dt>{a.customer}</dt>
                  <dd>
                    {request.ownerDisplayName ?? a.unknownPerson}
                    <span className="pc-hint pc-ltr" dir="ltr">
                      {' '}
                      {request.ownerEmail}
                    </span>
                  </dd>
                </div>
                <div>
                  <dt>{v.amount}</dt>
                  <dd className="pc-topup-amount-strong">
                    <TopUpAmount amount={request.amount} locale={locale} />
                  </dd>
                </div>
                <div>
                  <dt>{v.reference}</dt>
                  <dd className="pc-ltr" dir="ltr">
                    {request.reference}
                    {request.referenceNormalized !== null &&
                    request.referenceNormalized !== request.reference ? (
                      <span className="pc-hint"> ({request.referenceNormalized})</span>
                    ) : null}
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
              </dl>

              {request.status === 'REJECTED' && request.rejectionReason !== null ? (
                <div className="pc-alert pc-alert-warning">
                  <strong>{messages.rejectionReasons[request.rejectionReason]}</strong>
                  {request.rejectionNote === null ? null : <p>{request.rejectionNote}</p>}
                </div>
              ) : null}
              {request.status === 'APPROVED' ? (
                <p className="pc-alert pc-alert-success">{a.credited}</p>
              ) : null}
              {pending && reviewer !== null ? (
                <p className="pc-hint">{a.reviewStarted(reviewer)}</p>
              ) : null}
              {!pending ? <p className="pc-hint">{a.decisionLocked}</p> : null}
              {pending && !canApprove && !canReject ? (
                <p className="pc-hint">{a.readOnly}</p>
              ) : null}

              {pending ? (
                <div className="pc-actions">
                  {canReview && request.reviewStartedAt === null ? (
                    <button
                      type="button"
                      className="pc-btn pc-btn-secondary"
                      onClick={() => {
                        void manualTopUpsAdminApi
                          .startReview(request.id)
                          .then(setRequest)
                          .catch((caught: unknown) => setFailure(describe(caught)));
                      }}
                    >
                      {a.startReview}
                    </button>
                  ) : null}
                  {canApprove ? (
                    <ConfirmAction
                      labels={messages.confirm}
                      describeError={describe}
                      reauthNotice={<ReauthNotice locale={locale} />}
                      label={a.approve}
                      title={a.approveTitle}
                      intro={`${a.approveBody(
                        formatMoney(request.amount, locale),
                        request.reference ?? '',
                        methodName(request.paymentMethod, locale),
                      )} ${a.approveCheckbox}`}
                      confirmLabel={a.approveConfirm}
                      buttonClassName="pc-btn pc-btn-primary"
                      onConfirm={async () => {
                        setRequest(
                          await manualTopUpsAdminApi.approve(
                            request.id,
                            request.amount.minorUnits,
                            request.amount.currency,
                          ),
                        );
                      }}
                    />
                  ) : null}
                  {canReject ? (
                    <ConfirmAction
                      labels={messages.confirm}
                      describeError={describe}
                      reauthNotice={<ReauthNotice locale={locale} />}
                      label={a.reject}
                      title={a.rejectTitle}
                      intro={a.rejectNoteHint}
                      confirmLabel={a.rejectConfirm}
                      danger
                      buttonClassName="pc-btn pc-btn-danger"
                      fields={[
                        {
                          name: 'reason',
                          label: a.rejectReason,
                          maxLength: 64,
                          required: true,
                          options: MANUAL_TOPUP_REJECTION_REASONS.map((reason) => ({
                            value: reason,
                            label: messages.rejectionReasons[reason] ?? reason,
                          })),
                        },
                        {
                          name: 'note',
                          label: a.rejectNote,
                          hint: a.rejectNoteHint,
                          maxLength: 1000,
                          multiline: true,
                        },
                      ]}
                      onConfirm={async (values) => {
                        setRequest(
                          await manualTopUpsAdminApi.reject(
                            request.id,
                            values['reason'] ?? 'OTHER',
                            values['note'] ?? null,
                          ),
                        );
                      }}
                    />
                  ) : null}
                </div>
              ) : null}
            </section>

            <section className="pc-card" aria-labelledby="receipt">
              <h2 id="receipt">{a.receiptTitle}</h2>
              {request.receipt === null ? (
                <p className="pc-hint">{a.noReceipt}</p>
              ) : (
                <>
                  <p>
                    {request.receipt.originalFilename}{' '}
                    <span className="pc-hint">
                      — {messages.fileStatuses[request.receipt.status] ?? request.receipt.status}
                    </span>
                  </p>
                  {request.receipt.status === 'READY' ? (
                    <button
                      type="button"
                      className="pc-btn pc-btn-secondary pc-btn-sm"
                      onClick={() => void openReceipt()}
                    >
                      {a.viewReceipt}
                    </button>
                  ) : null}
                  <p className="pc-hint">{a.receiptAudited}</p>
                </>
              )}
            </section>

            {can.has('admin:payment-method:manage') ? (
              <NotificationReport requestId={request.id} locale={locale} />
            ) : null}
          </div>

          <aside className="pc-detail-side">
            <section className="pc-card" aria-labelledby="snapshot">
              <div className="pc-topup-method-head">
                <MethodMark method={request.paymentMethod} locale={locale} size={32} />
                <h2 id="snapshot">{a.destinationSnapshot}</h2>
              </div>
              <p>{methodName(request.paymentMethod, locale)}</p>
              <p className="pc-hint">{a.snapshotHint}</p>
              <DestinationDetails
                destination={request.paymentMethod}
                locale={locale}
                copyable={false}
              />
            </section>
            <section className="pc-card" aria-labelledby="history">
              <h2 id="history">{v.timeline}</h2>
              <TopUpTimeline events={request.events} locale={locale} />
            </section>
          </aside>
        </div>
      )}
    </main>
  );
}

/**
 * "No email arrived", answered on the page: who the submission alert went
 * to, what became of the in-app copy and the email, and why an email was not
 * sent. Administrators only; addresses are masked.
 */
function NotificationReport({ requestId, locale }: { requestId: string; locale: Locale }) {
  const messages = getManualTopUpMessages(locale);
  const d = messages.delivery;
  const [report, setReport] = useState<ManualTopUpNotificationReportView | null>(null);
  const [failed, setFailed] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    manualTopUpsAdminApi
      .notificationReport(requestId)
      .then((value) => {
        if (live) setReport(value);
      })
      .catch((caught: unknown) => {
        if (live) setFailed(describeTopUpError(messages, caught).message);
      });
    return () => {
      live = false;
    };
  }, [requestId, messages]);

  type Recipient = ManualTopUpNotificationReportView['recipients'][number];
  const code = (value: string) => <span className="pc-ltr pc-topup-delivery-code"> ({value})</span>;
  const notNotified = (report?.assignedReviewers ?? []).filter((reviewer) => !reviewer.notified);

  return (
    <section className="pc-card" aria-labelledby="delivery" data-testid="notification-report">
      <h2 id="delivery">{d.title}</h2>
      <p className="pc-hint">{d.intro}</p>
      {failed !== null ? (
        <p className="pc-error" role="alert">
          {failed}
        </p>
      ) : report === null ? (
        <LoadingState label={messages.loading} />
      ) : (
        <>
          {report.noReviewerAvailable ? (
            <p className="pc-alert pc-alert-warning">{d.noReviewer}</p>
          ) : report.routing === null ? (
            <p className="pc-hint">{d.pending}</p>
          ) : (
            <p className={report.routing === 'METHOD_REVIEWERS' ? '' : 'pc-alert pc-alert-warning'}>
              {d.routing[report.routing]}
            </p>
          )}
          {report.recipients.length > 0 ? (
            <DataTable<Recipient>
              caption={d.caption}
              rows={report.recipients}
              rowKey={(row) => row.userId}
              columns={[
                {
                  key: 'reviewer',
                  header: d.columns.reviewer,
                  primary: true,
                  cell: (row) => (
                    <span>
                      <span dir="auto">{row.displayName ?? row.emailMasked}</span>
                      {row.assigned ? <span className="pc-hint"> · {d.assigned}</span> : null}
                    </span>
                  ),
                },
                {
                  key: 'address',
                  header: d.columns.address,
                  cell: (row) => (
                    <span>
                      <span className="pc-ltr">{row.emailMasked}</span>
                      <span className="pc-hint">
                        {' · '}
                        {row.emailVerified
                          ? messages.reviewers.emailVerified
                          : messages.reviewers.emailNotVerified}
                      </span>
                    </span>
                  ),
                },
                {
                  key: 'inApp',
                  header: d.columns.inApp,
                  cell: (row) =>
                    row.inAppStatus === null
                      ? d.none
                      : `${d.inApp.delivered} · ${row.readAt === null ? d.inApp.unread : d.inApp.read}`,
                },
                {
                  key: 'email',
                  header: d.columns.email,
                  cell: (row) =>
                    row.emailStatus === null ? (
                      d.none
                    ) : (
                      <span>
                        {d.emailStatuses[row.emailStatus] ?? row.emailStatus}
                        {code(row.emailStatus)}
                      </span>
                    ),
                },
                {
                  key: 'reason',
                  header: d.columns.reason,
                  cell: (row) =>
                    row.emailSkipReason !== null ? (
                      <span>
                        {d.skipReasons[row.emailSkipReason] ?? row.emailSkipReason}
                        {code(row.emailSkipReason)}
                      </span>
                    ) : row.emailErrorCode !== null ? (
                      <span className="pc-ltr">{row.emailErrorCode}</span>
                    ) : (
                      d.none
                    ),
                },
              ]}
            />
          ) : null}
          {notNotified.length > 0 ? (
            <div className="pc-topup-not-notified">
              <h3>{d.notNotifiedTitle}</h3>
              <ul role="list">
                {notNotified.map((reviewer) => (
                  <li key={reviewer.userId}>
                    <span dir="auto">{reviewer.displayName ?? reviewer.emailMasked}</span>{' '}
                    <span className="pc-ltr pc-hint">{reviewer.emailMasked}</span>
                    <span className="pc-hint"> — {d.notNotifiedReason}</span>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
        </>
      )}
    </section>
  );
}
