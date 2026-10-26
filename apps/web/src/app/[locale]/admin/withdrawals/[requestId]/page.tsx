'use client';

import {
  WITHDRAWAL_REJECTION_REASONS,
  type AdminWithdrawalRequestView,
  type WithdrawalAttemptView,
  type WithdrawalDestinationRevealView,
  type WithdrawalNotificationReportView,
} from '@palcert/contracts/finance/withdrawals';
import { useParams } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';
import {
  AdminGate,
  ConfirmAction,
  ReauthNotice,
  useAdminLocale,
} from '@/components/admin/admin-kit';
import {
  Amount,
  DestinationSummaryView,
  WithdrawalStatusBadge,
  WithdrawalTimeline,
  describeWithdrawalError,
  destinationLine,
} from '@/components/withdrawal';
import { useShell } from '@/components/shell/shell-context';
import { DataTable } from '@/components/ui/data-table';
import { PageHeader } from '@/components/ui/page-header';
import { LoadingState } from '@/components/ui/states';
import type { Locale } from '@/i18n/locales';
import { getWithdrawalMessages } from '@/i18n/withdrawal-messages';
import { uploadToStorage } from '@/lib/api-client';
import { formatMoney } from '@/lib/money';
import { useIdempotencyKey } from '@/lib/use-idempotency-key';
import { withdrawalAdminApi } from '@/lib/withdrawals-api';

/**
 * One withdrawal, for PalCert finance (spec §21–§27, §33).
 *
 * The buttons are exactly the API's `allowedActions` for this person — the
 * same separation-of-duties rules the server enforces — and each states what
 * it will do before it does it. Recording a payout asks for the transfer
 * reference and restates amount, beneficiary and destination; it is the one
 * button here that moves money in PalCert's books, and it can be pressed
 * twice without moving it twice.
 */
export default function AdminWithdrawalPage() {
  return (
    <AdminGate allowed={(can) => can.has('finance:withdrawal:read')}>
      <Review />
    </AdminGate>
  );
}

function Review() {
  const locale = useAdminLocale();
  const requestId = String(useParams().requestId);
  const messages = getWithdrawalMessages(locale);
  const a = messages.admin;
  const d = messages.detail;
  const actions = a.actions;
  const { globalPermissions: can } = useShell();
  const [request, setRequest] = useState<AdminWithdrawalRequestView | null>(null);
  const [failure, setFailure] = useState<{ message: string; reauth: boolean } | null>(null);
  const [revealed, setRevealed] = useState<WithdrawalDestinationRevealView | null>(null);

  const load = useCallback(async () => {
    try {
      setRequest(await withdrawalAdminApi.get(requestId));
    } catch (caught) {
      setFailure(describeWithdrawalError(messages, caught));
    }
  }, [messages, requestId]);

  useEffect(() => {
    void load();
  }, [load]);

  const allowed = new Set(request?.allowedActions ?? []);
  const money = request === null ? '' : formatMoney(request.amount, locale);
  const destination = request === null ? '' : destinationLine(request.destination, locale);
  const beneficiary = request?.beneficiaryName ?? '';
  const show = (next: AdminWithdrawalRequestView) => {
    setRequest(next);
    setFailure(null);
  };

  return (
    <main className="pc-page">
      <PageHeader title={d.title(request?.reference ?? '')} />
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
            <section className="pc-card" aria-labelledby="withdrawal-request">
              <div className="pc-section-heading">
                <h2 id="withdrawal-request">{d.summary}</h2>
                <WithdrawalStatusBadge status={request.status} locale={locale} />
              </div>
              <dl className="pc-topup-summary">
                <div>
                  <dt>{d.reference}</dt>
                  <dd className="pc-ltr">{request.reference}</dd>
                </div>
                <div>
                  <dt>{d.scope}</dt>
                  <dd>{messages.scopes[request.scope]}</dd>
                </div>
                <div>
                  <dt>{a.requester}</dt>
                  <dd>
                    {request.requesterDisplayName === null ? null : (
                      <span dir="auto">{request.requesterDisplayName} </span>
                    )}
                    <span
                      className={
                        request.requesterDisplayName === null ? 'pc-ltr' : 'pc-hint pc-ltr'
                      }
                      dir="ltr"
                    >
                      {request.requesterEmail}
                    </span>
                  </dd>
                </div>
                {request.organizationName === null ? null : (
                  <div>
                    <dt>{a.organization}</dt>
                    <dd dir="auto">{request.organizationName}</dd>
                  </div>
                )}
                <div>
                  <dt>{d.beneficiary}</dt>
                  <dd dir="auto">{request.beneficiaryName}</dd>
                </div>
                <div>
                  <dt>{d.amount}</dt>
                  <dd className="pc-topup-amount-strong">
                    <Amount amount={request.amount} locale={locale} />
                  </dd>
                </div>
                <div>
                  <dt>{a.availableBefore}</dt>
                  <dd>
                    <Amount amount={request.availableBeforeRequest} locale={locale} />
                  </dd>
                </div>
                <div>
                  <dt>{a.reservation}</dt>
                  <dd>{request.reservationActive ? a.reservationActive : a.reservationReleased}</dd>
                </div>
                {request.submittedAt === null ? null : (
                  <div>
                    <dt>{d.requestedAt}</dt>
                    <dd>
                      <time dateTime={request.submittedAt}>
                        {new Date(request.submittedAt).toLocaleString(locale)}
                      </time>
                    </dd>
                  </div>
                )}
                {request.externalTransferReference === null ? null : (
                  <div>
                    <dt>{d.transferReference}</dt>
                    <dd className="pc-ltr">{request.externalTransferReference}</dd>
                  </div>
                )}
                {request.requesterNote === null ? null : (
                  <div>
                    <dt>{d.note}</dt>
                    <dd dir="auto">{request.requesterNote}</dd>
                  </div>
                )}
                {request.releaseNote === null ? null : (
                  <div>
                    <dt>{a.releaseNote}</dt>
                    <dd dir="auto">{request.releaseNote}</dd>
                  </div>
                )}
              </dl>
              {request.status === 'REJECTED' && request.rejectionReason !== null ? (
                <div className="pc-alert pc-alert-warning">
                  <strong>
                    {d.rejection}: {messages.rejectionReasons[request.rejectionReason]}
                  </strong>
                  {request.rejectionNote === null ? null : (
                    <p dir="auto">{request.rejectionNote}</p>
                  )}
                </div>
              ) : null}
              <p className="pc-hint">{a.separation}</p>
              {allowed.size === 0 ? <p className="pc-hint">{a.readOnly}</p> : null}

              <div className="pc-actions" data-testid="withdrawal-actions">
                {allowed.has('START_REVIEW') ? (
                  <button
                    type="button"
                    className="pc-btn pc-btn-secondary"
                    onClick={() => {
                      void withdrawalAdminApi
                        .startReview(request.id)
                        .then(show)
                        .catch((caught: unknown) =>
                          setFailure(describeWithdrawalError(messages, caught)),
                        );
                    }}
                  >
                    {actions.startReview}
                  </button>
                ) : null}
                {allowed.has('APPROVE') ? (
                  <ConfirmAction
                    locale={locale}
                    label={actions.approve}
                    title={actions.approveTitle}
                    intro={actions.approveBody(money, beneficiary)}
                    confirmLabel={actions.approve}
                    buttonClassName="pc-btn pc-btn-primary"
                    onConfirm={async () => show(await withdrawalAdminApi.approve(request))}
                  />
                ) : null}
                {allowed.has('REJECT') ? (
                  <ConfirmAction
                    locale={locale}
                    label={actions.reject}
                    title={actions.rejectTitle}
                    intro={actions.rejectNoteHint}
                    confirmLabel={actions.reject}
                    danger
                    buttonClassName="pc-btn pc-btn-danger"
                    fields={[
                      {
                        name: 'reason',
                        label: actions.rejectReason,
                        maxLength: 64,
                        required: true,
                        options: WITHDRAWAL_REJECTION_REASONS.map((reason) => ({
                          value: reason,
                          label: messages.rejectionReasons[reason] ?? reason,
                        })),
                      },
                      {
                        name: 'note',
                        label: actions.rejectNote,
                        hint: actions.rejectNoteHint,
                        maxLength: 1000,
                        multiline: true,
                      },
                    ]}
                    onConfirm={async (values) =>
                      show(
                        await withdrawalAdminApi.reject(
                          request,
                          values['reason'] ?? 'OTHER',
                          values['note'] ?? null,
                        ),
                      )
                    }
                  />
                ) : null}
                {allowed.has('START_EXECUTION') ? (
                  <ConfirmAction
                    locale={locale}
                    label={actions.startExecution}
                    title={actions.startExecutionTitle}
                    intro={actions.startExecutionBody(money, beneficiary)}
                    confirmLabel={actions.startExecution}
                    buttonClassName="pc-btn pc-btn-primary"
                    onConfirm={async () => show(await withdrawalAdminApi.startExecution(request))}
                  />
                ) : null}
                {allowed.has('MARK_PAID') ? (
                  <ConfirmAction
                    locale={locale}
                    label={actions.markPaid}
                    title={actions.markPaidTitle}
                    intro={actions.markPaidBody(money, beneficiary, destination)}
                    confirmLabel={actions.markPaid}
                    buttonClassName="pc-btn pc-btn-primary"
                    fields={[
                      {
                        name: 'reference',
                        label: actions.transferReference,
                        hint: actions.transferReferenceHint,
                        maxLength: 120,
                        required: true,
                        ltr: true,
                      },
                      {
                        name: 'note',
                        label: actions.executionNote,
                        maxLength: 1000,
                        multiline: true,
                      },
                    ]}
                    onConfirm={async (values) =>
                      show(
                        await withdrawalAdminApi.markPaid(
                          request,
                          values['reference'] ?? '',
                          values['note'] ?? null,
                        ),
                      )
                    }
                  />
                ) : null}
                {allowed.has('MARK_FAILED') ? (
                  <ConfirmAction
                    locale={locale}
                    label={actions.markFailed}
                    title={actions.markFailedTitle}
                    intro={actions.markFailedBody}
                    confirmLabel={actions.markFailed}
                    danger
                    buttonClassName="pc-btn pc-btn-secondary"
                    fields={[
                      {
                        name: 'note',
                        label: actions.failureNote,
                        maxLength: 1000,
                        required: true,
                        multiline: true,
                      },
                    ]}
                    onConfirm={async (values) =>
                      show(await withdrawalAdminApi.markFailed(request, values['note'] ?? ''))
                    }
                  />
                ) : null}
                {allowed.has('RETRY') ? (
                  <ConfirmAction
                    locale={locale}
                    label={actions.retry}
                    title={actions.retryTitle}
                    intro={actions.retryBody}
                    confirmLabel={actions.retry}
                    buttonClassName="pc-btn pc-btn-primary"
                    onConfirm={async () => show(await withdrawalAdminApi.startExecution(request))}
                  />
                ) : null}
                {allowed.has('RELEASE') ? (
                  <ConfirmAction
                    locale={locale}
                    label={actions.release}
                    title={actions.releaseTitle}
                    intro={actions.releaseBody}
                    confirmLabel={actions.release}
                    danger
                    buttonClassName="pc-btn pc-btn-danger"
                    fields={[
                      {
                        name: 'note',
                        label: actions.releaseReason,
                        maxLength: 1000,
                        required: true,
                        multiline: true,
                      },
                    ]}
                    onConfirm={async (values) =>
                      show(await withdrawalAdminApi.release(request, values['note'] ?? ''))
                    }
                  />
                ) : null}
              </div>
            </section>

            <Attempts attempts={request.attempts} locale={locale} />
            <Proof
              request={request}
              locale={locale}
              canUpload={can.has('finance:withdrawal:execute')}
              onChange={show}
            />
            <Notifications requestId={request.id} locale={locale} />
          </div>

          <aside className="pc-detail-side">
            <section className="pc-card" aria-labelledby="withdrawal-destination">
              <h2 id="withdrawal-destination">{d.destination}</h2>
              <p className="pc-hint">{d.snapshotHint}</p>
              <DestinationSummaryView summary={request.destination} locale={locale} />
              {can.has('finance:withdrawal:review') ? (
                revealed === null ? (
                  <button
                    type="button"
                    className="pc-btn pc-btn-secondary pc-btn-sm"
                    onClick={() => {
                      void withdrawalAdminApi
                        .revealDestination(request.id)
                        .then(setRevealed)
                        .catch((caught: unknown) =>
                          setFailure(describeWithdrawalError(messages, caught)),
                        );
                    }}
                  >
                    {a.reveal}
                  </button>
                ) : (
                  <div className="pc-withdrawal-reveal" data-testid="destination-reveal">
                    <h3>{a.revealTitle}</h3>
                    <p className="pc-hint">{a.revealHint}</p>
                    <dl className="pc-topup-summary">
                      {(
                        [
                          ['iban', revealed.iban],
                          ['accountNumber', revealed.accountNumber],
                          ['bankName', revealed.bankName],
                          ['branch', revealed.branch],
                          ['mobileNumber', revealed.mobileNumber],
                          ['instructions', revealed.instructions],
                        ] as const
                      )
                        .filter(([, value]) => value !== null)
                        .map(([key, value]) => (
                          <div key={key}>
                            <dt>{messages.destinations.fields[key]}</dt>
                            <dd
                              className={
                                key === 'iban' || key === 'accountNumber' || key === 'mobileNumber'
                                  ? 'pc-ltr'
                                  : undefined
                              }
                              dir="auto"
                            >
                              {value}
                            </dd>
                          </div>
                        ))}
                    </dl>
                    <button
                      type="button"
                      className="pc-btn pc-btn-quiet pc-btn-sm"
                      onClick={() => setRevealed(null)}
                    >
                      {a.hide}
                    </button>
                  </div>
                )
              ) : null}
            </section>
            <section className="pc-card" aria-labelledby="withdrawal-timeline">
              <h2 id="withdrawal-timeline">{d.timeline}</h2>
              <WithdrawalTimeline events={request.events} locale={locale} />
            </section>
          </aside>
        </div>
      )}
    </main>
  );
}

function Attempts({
  attempts,
  locale,
}: {
  attempts: readonly WithdrawalAttemptView[];
  locale: Locale;
}) {
  const messages = getWithdrawalMessages(locale);
  const a = messages.admin;
  return (
    <section className="pc-card" aria-labelledby="transfer-attempts">
      <h2 id="transfer-attempts">{a.attemptsTitle}</h2>
      {attempts.length === 0 ? (
        <p className="pc-hint">{a.noAttempts}</p>
      ) : (
        <DataTable<WithdrawalAttemptView>
          caption={a.attemptsCaption}
          scrollable
          rows={attempts}
          rowKey={(row) => String(row.attemptNumber)}
          columns={[
            {
              key: 'number',
              header: a.attemptColumns.number,
              primary: true,
              cell: (row) => `#${row.attemptNumber}`,
            },
            {
              key: 'outcome',
              header: a.attemptColumns.outcome,
              cell: (row) => messages.attemptOutcomes[row.outcome] ?? row.outcome,
            },
            {
              key: 'started',
              header: a.attemptColumns.started,
              cell: (row) => (
                <span>
                  <time dateTime={row.startedAt}>
                    {new Date(row.startedAt).toLocaleString(locale)}
                  </time>
                  {row.startedByDisplayName === null ? null : (
                    <span className="pc-hint" dir="auto">
                      {' '}
                      · {row.startedByDisplayName}
                    </span>
                  )}
                </span>
              ),
            },
            {
              key: 'finished',
              header: a.attemptColumns.finished,
              cell: (row) =>
                row.finishedAt === null ? (
                  '—'
                ) : (
                  <time dateTime={row.finishedAt}>
                    {new Date(row.finishedAt).toLocaleString(locale)}
                  </time>
                ),
            },
            {
              key: 'reference',
              header: a.attemptColumns.reference,
              cell: (row) => <span className="pc-ltr">{row.externalReference ?? '—'}</span>,
            },
            {
              key: 'note',
              header: a.attemptColumns.note,
              cell: (row) => <span dir="auto">{row.note ?? '—'}</span>,
            },
          ]}
        />
      )}
    </section>
  );
}

/** The optional transfer receipt: uploaded by finance, scanned, never emailed. */
function Proof({
  request,
  locale,
  canUpload,
  onChange,
}: {
  request: AdminWithdrawalRequestView;
  locale: Locale;
  canUpload: boolean;
  onChange: (next: AdminWithdrawalRequestView) => void;
}) {
  const messages = getWithdrawalMessages(locale);
  const a = messages.admin;
  const [state, setState] = useState<'idle' | 'uploading' | 'done'>('idle');
  const [failure, setFailure] = useState<string | null>(null);
  const idempotency = useIdempotencyKey();
  const open = request.status === 'PROCESSING' || request.status === 'PAID';

  return (
    <section className="pc-card" aria-labelledby="transfer-proof">
      <h2 id="transfer-proof">{a.proofTitle}</h2>
      <p className="pc-hint">{a.proofIntro}</p>
      {failure === null ? null : (
        <p className="pc-error" role="alert">
          {failure}
        </p>
      )}
      {request.hasProof ? (
        <button
          type="button"
          className="pc-btn pc-btn-secondary pc-btn-sm"
          onClick={() => {
            void withdrawalAdminApi
              .proof(request.id)
              .then((grant) => window.open(grant.url, '_blank', 'noopener,noreferrer'))
              .catch((caught: unknown) =>
                setFailure(describeWithdrawalError(messages, caught).message),
              );
          }}
        >
          {messages.detail.viewProof}
        </button>
      ) : (
        <p className="pc-hint">{a.proofNone}</p>
      )}
      {canUpload && open ? (
        <div className="pc-field">
          <label htmlFor="proof-file">{a.proofChoose}</label>
          <input
            id="proof-file"
            type="file"
            accept="application/pdf,image/png,image/jpeg,image/webp"
            disabled={state === 'uploading'}
            onChange={(event) => {
              const file = event.target.files?.[0];
              if (file === undefined) return;
              setState('uploading');
              setFailure(null);
              void (async () => {
                try {
                  const created = await withdrawalAdminApi.createProof(
                    request.id,
                    {
                      originalFilename: file.name,
                      sizeBytes: file.size,
                      declaredMimeType: file.type,
                    },
                    idempotency.keyFor(
                      `${request.id}:${file.name}:${file.size}:${file.lastModified}`,
                    ),
                  );
                  await uploadToStorage(created.upload, file, () => undefined);
                  onChange(await withdrawalAdminApi.finalizeProof(request.id, created.proof.id));
                  idempotency.reset();
                  setState('done');
                } catch (caught) {
                  setFailure(describeWithdrawalError(messages, caught).message);
                  setState('idle');
                }
              })();
            }}
          />
          {state === 'uploading' ? <span className="pc-hint">{a.proofUploading}</span> : null}
          {state === 'done' ? (
            <span className="pc-hint" role="status">
              {a.proofUploaded}
            </span>
          ) : null}
        </div>
      ) : null}
      <p className="pc-hint">{messages.detail.proofAudited}</p>
    </section>
  );
}

/** "No email arrived", answered here: who was told and what happened to each message. */
function Notifications({ requestId, locale }: { requestId: string; locale: Locale }) {
  const messages = getWithdrawalMessages(locale);
  const n = messages.admin.notifications;
  const [report, setReport] = useState<WithdrawalNotificationReportView | null>(null);
  const [failed, setFailed] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    withdrawalAdminApi
      .notifications(requestId)
      .then((value) => {
        if (live) setReport(value);
      })
      .catch((caught: unknown) => {
        if (live) setFailed(describeWithdrawalError(messages, caught).message);
      });
    return () => {
      live = false;
    };
  }, [requestId, messages]);

  type Recipient = WithdrawalNotificationReportView['recipients'][number];
  return (
    <section
      className="pc-card"
      aria-labelledby="withdrawal-notifications"
      data-testid="notification-report"
    >
      <h2 id="withdrawal-notifications">{n.title}</h2>
      <p className="pc-hint">{n.intro}</p>
      {failed !== null ? (
        <p className="pc-error" role="alert">
          {failed}
        </p>
      ) : report === null ? (
        <LoadingState label={messages.loading} />
      ) : (
        <>
          {report.noReviewerAvailable ? (
            <p className="pc-alert pc-alert-warning">{n.noReviewer}</p>
          ) : report.routing === null ? (
            <p className="pc-hint">{n.pending}</p>
          ) : (
            <p
              className={report.routing === 'ASSIGNED_REVIEWERS' ? '' : 'pc-alert pc-alert-warning'}
            >
              {n.routing[report.routing]}
            </p>
          )}
          {report.recipients.length === 0 ? null : (
            <DataTable<Recipient>
              caption={n.caption}
              scrollable
              rows={report.recipients}
              rowKey={(row) => `${row.userId}:${row.notificationType}`}
              columns={[
                {
                  key: 'recipient',
                  header: n.columns.recipient,
                  primary: true,
                  cell: (row) => (
                    <span>
                      {row.displayName === null ? null : <span dir="auto">{row.displayName} </span>}
                      <span className="pc-hint">
                        <span className="pc-ltr">{row.emailMasked}</span> ·{' '}
                        {row.emailVerified ? n.verified : n.notVerified}
                      </span>
                    </span>
                  ),
                },
                {
                  key: 'type',
                  header: n.columns.type,
                  cell: (row) => n.types[row.notificationType] ?? row.notificationType,
                },
                { key: 'inApp', header: n.columns.inApp, cell: (row) => row.inAppStatus ?? n.none },
                {
                  key: 'email',
                  header: n.columns.email,
                  cell: (row) =>
                    row.emailStatus === null
                      ? n.none
                      : (n.emailStatuses[row.emailStatus] ?? row.emailStatus),
                },
                {
                  key: 'reason',
                  header: n.columns.reason,
                  cell: (row) =>
                    row.emailSkipReason === null
                      ? n.none
                      : (n.skipReasons[row.emailSkipReason] ?? row.emailSkipReason),
                },
              ]}
            />
          )}
        </>
      )}
    </section>
  );
}
