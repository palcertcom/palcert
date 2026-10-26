'use client';

import type { AttestationRequestReviewView } from '@palcert/contracts';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';
import {
  AttestationDisclaimer,
  AttestationRecordCard,
  EventHistory,
  HashValue,
  RequestStatusBadge,
  SubmittedDetails,
  describeAttestationError,
  formatDate,
  money,
} from '@/components/attestation';
import { ApproveDialog } from '@/components/attestation-approve';
import { FormError } from '@/components/auth-form';
import { OrganizationShell } from '@/components/organization-shell';
import { ConfirmAction } from '@/components/ui/confirm-action';
import { PageHeader } from '@/components/ui/page-header';
import { ErrorState, LoadingState } from '@/components/ui/states';
import { getAttestationsMessages } from '@/i18n/attestations-messages';
import type { Locale } from '@/i18n/locales';
import { getOrganizationMessages } from '@/i18n/organization-messages';
import { authApi } from '@/lib/api-client';
import { attestationReviewApi } from '@/lib/attestations-api';

/** One attestation request, from the institution's side. */
export default function AttestationReviewPage() {
  const params = useParams();
  const requestId = typeof params.requestId === 'string' ? params.requestId : '';
  return (
    <OrganizationShell>
      {({ organizationId, locale, permissions }) =>
        permissions.has('attestation:request:read') ? (
          <Review
            locale={locale}
            organizationId={organizationId}
            requestId={requestId}
            canReview={permissions.has('attestation:request:review')}
            canApprove={permissions.has('attestation:request:approve')}
            canRevoke={permissions.has('attestation:record:revoke')}
          />
        ) : (
          <>
            <PageHeader title={getAttestationsMessages(locale).queue.title} />
            <ErrorState
              title={getOrganizationMessages(locale).errors['ORGANIZATION_ACCESS_DENIED'] ?? ''}
            />
          </>
        )
      }
    </OrganizationShell>
  );
}

function Review({
  locale,
  organizationId,
  requestId,
  canReview,
  canApprove,
  canRevoke,
}: {
  locale: Locale;
  organizationId: string;
  requestId: string;
  canReview: boolean;
  canApprove: boolean;
  canRevoke: boolean;
}) {
  const messages = getAttestationsMessages(locale);
  const r = messages.review;
  const base = `/${locale}/organizations/${organizationId}`;

  const [view, setView] = useState<AttestationRequestReviewView | null>(null);
  const [me, setMe] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      setView(await attestationReviewApi.get(organizationId, requestId));
    } catch (caught) {
      setError(describeAttestationError(messages, caught));
    }
  }, [organizationId, requestId, messages]);

  useEffect(() => {
    void load();
    void authApi
      .me()
      .then((profile) => setMe(profile.id))
      .catch(() => undefined);
  }, [load]);

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

  async function act(run: () => Promise<AttestationRequestReviewView>): Promise<void> {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      setView(await run());
    } catch (caught) {
      setError(describeAttestationError(messages, caught));
    } finally {
      setBusy(false);
    }
  }

  async function openFile(disposition: 'inline' | 'attachment'): Promise<void> {
    try {
      const link = await attestationReviewApi.artifact(organizationId, requestId, disposition);
      if (disposition === 'inline') window.open(link.url, '_blank', 'noopener,noreferrer');
      else window.location.assign(link.url);
    } catch (caught) {
      setError(describeAttestationError(messages, caught));
    }
  }

  if (view === null) {
    return (
      <>
        <Link className="pc-back-link" href={`${base}/attestations`}>
          {r.backToQueue}
        </Link>
        {error === null ? <LoadingState label={messages.loading} /> : <FormError message={error} />}
      </>
    );
  }

  const open =
    view.status === 'SUBMITTED' ||
    view.status === 'IN_REVIEW' ||
    view.status === 'NEEDS_INFORMATION';
  const typeName = locale === 'ar' ? view.attestationTypeName.ar : view.attestationTypeName.en;

  return (
    <div data-testid="attestation-review" data-status={view.status}>
      <Link className="pc-back-link" href={`${base}/attestations`}>
        {r.backToQueue}
      </Link>
      <PageHeader
        title={<bdi>{view.submitted.certificateTitle}</bdi>}
        description={<bdi>{typeName}</bdi>}
        actions={<RequestStatusBadge status={view.status} messages={messages} />}
      />
      {error === null ? null : <FormError message={error} />}

      {open && (canReview || canApprove) ? (
        <div className="pc-actions" data-testid="review-actions">
          {view.status === 'SUBMITTED' && canReview ? (
            <button
              type="button"
              className="pc-btn"
              disabled={busy}
              onClick={() =>
                void act(() => attestationReviewApi.startReview(organizationId, requestId))
              }
              data-testid="start-review"
            >
              {r.startReview}
            </button>
          ) : null}
          {canReview && me !== null && view.assignedReviewer?.userId !== me ? (
            <button
              type="button"
              className="pc-btn pc-btn-secondary"
              disabled={busy}
              onClick={() =>
                void act(() => attestationReviewApi.assign(organizationId, requestId, me))
              }
            >
              {r.assignToMe}
            </button>
          ) : null}
          {view.status === 'IN_REVIEW' && canReview ? (
            <ConfirmAction
              labels={labels}
              describeError={describe}
              label={r.requestInformation}
              title={r.requestInformationTitle}
              intro={r.requestInformationIntro}
              fields={[
                {
                  name: 'message',
                  label: r.question,
                  maxLength: 2000,
                  required: true,
                  multiline: true,
                },
              ]}
              onConfirm={async (values) => {
                setView(
                  await attestationReviewApi.requestInformation(
                    organizationId,
                    requestId,
                    values['message'] ?? '',
                  ),
                );
              }}
            />
          ) : null}
          {view.status === 'IN_REVIEW' && canApprove ? (
            <>
              <ApproveDialog
                view={view}
                messages={messages}
                onApprove={async (input) => {
                  setView(await attestationReviewApi.approve(organizationId, requestId, input));
                }}
              />
              <ConfirmAction
                labels={labels}
                describeError={describe}
                label={r.reject}
                title={r.rejectTitle}
                intro={r.rejectIntro}
                danger
                fields={[
                  {
                    name: 'reason',
                    label: r.rejectReason,
                    hint: r.rejectReasonHint,
                    maxLength: 2000,
                    required: true,
                    multiline: true,
                  },
                ]}
                onConfirm={async (values) => {
                  setView(
                    await attestationReviewApi.reject(
                      organizationId,
                      requestId,
                      values['reason'] ?? '',
                    ),
                  );
                }}
              />
            </>
          ) : null}
        </div>
      ) : null}

      {view.attestation === null ? null : (
        <AttestationRecordCard
          record={view.attestation}
          messages={messages}
          locale={locale}
          qr={{
            svgPath: attestationReviewApi.qrPath(organizationId, view.attestation.id, 'svg'),
            pngPath: attestationReviewApi.qrPath(organizationId, view.attestation.id, 'png'),
          }}
          actions={
            canRevoke && view.attestation.revokedAt === null ? (
              <ConfirmAction
                labels={labels}
                describeError={describe}
                label={r.revoke}
                title={r.revokeTitle}
                intro={`${r.revokeIntro} ${r.noRefundNote}`}
                danger
                fields={[
                  {
                    name: 'reason',
                    label: r.revokeReason,
                    maxLength: 2000,
                    required: true,
                    multiline: true,
                  },
                ]}
                onConfirm={async (values) => {
                  setView(
                    await attestationReviewApi.revoke(
                      organizationId,
                      view.attestation!.id,
                      values['reason'] ?? '',
                    ),
                  );
                }}
              />
            ) : undefined
          }
        />
      )}

      <div className="pc-detail-grid">
        <div className="pc-detail-main">
          <section className="pc-card">
            <h2 className="pc-card-title">{r.submittedFile}</h2>
            {view.artifact === null ? (
              <p>{messages.none}</p>
            ) : (
              <>
                <p>
                  <bdi>{view.artifact.originalFilename}</bdi>{' '}
                  <span className="pc-hint">
                    {view.artifact.detectedMimeType ?? ''} · {view.artifact.sizeBytes ?? 0} B
                  </span>
                </p>
                {view.artifact.sha256 === null ? null : (
                  <HashValue
                    label={messages.details.artifactHash}
                    value={view.artifact.sha256}
                    messages={messages}
                  />
                )}
                <div className="pc-actions">
                  <button
                    type="button"
                    className="pc-btn pc-btn-secondary pc-btn-sm"
                    onClick={() => void openFile('inline')}
                  >
                    {r.viewFile}
                  </button>
                  <button
                    type="button"
                    className="pc-btn pc-btn-secondary pc-btn-sm"
                    onClick={() => void openFile('attachment')}
                  >
                    {r.downloadFile}
                  </button>
                </div>
                <p className="pc-hint">{r.fileViewNote}</p>
              </>
            )}
            {view.sameArtifactRequests.length === 0 ? null : (
              <div data-testid="same-file-requests">
                <h3 className="pc-card-subtitle">{r.sameFile}</h3>
                <p className="pc-hint">{r.sameFileHint}</p>
                <ul>
                  {view.sameArtifactRequests.map((other) => (
                    <li key={other.id}>
                      <Link href={`${base}/attestations/${other.id}`}>
                        {formatDate(other.submittedAt, locale)}
                      </Link>{' '}
                      <RequestStatusBadge status={other.status} messages={messages} />
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </section>

          <section className="pc-card">
            <h2 className="pc-card-title">{messages.details.submittedDetails}</h2>
            <SubmittedDetails metadata={view.submitted} messages={messages} locale={locale} />
            {view.notesForReviewer === null ? null : (
              <p>
                <span className="pc-hint">{messages.wizard.notesForReviewer}: </span>
                <bdi>{view.notesForReviewer}</bdi>
              </p>
            )}
          </section>

          <section className="pc-card">
            <h2 className="pc-card-title">{messages.details.history}</h2>
            <EventHistory events={view.history} messages={messages} locale={locale} />
          </section>
        </div>

        <aside className="pc-detail-side">
          <section className="pc-card">
            <h2 className="pc-card-title">{r.applicant}</h2>
            <p>
              <bdi>{view.owner.displayName}</bdi>
            </p>
            <p className="pc-hint" dir="ltr">
              {view.owner.email}
            </p>
            <p>
              <span className="pc-hint">{r.assignedTo}: </span>
              {view.assignedReviewer === null ? (
                messages.queue.unassigned
              ) : (
                <bdi>{view.assignedReviewer.displayName}</bdi>
              )}
            </p>
          </section>
          <section className="pc-card" data-testid="fee-snapshot">
            <h2 className="pc-card-title">{r.feeSnapshot}</h2>
            <dl className="pc-definitions">
              <div>
                <dt>{r.gross}</dt>
                <dd className="pc-money">{money(view.feeSnapshot.gross, locale)}</dd>
              </div>
              <div>
                <dt>
                  {r.platformFee} ({view.feeSnapshot.platformCommissionPercent}%)
                </dt>
                <dd className="pc-money">{money(view.feeSnapshot.platformFee, locale)}</dd>
              </div>
              <div>
                <dt>{r.institutionNet}</dt>
                <dd className="pc-money" data-testid="institution-net">
                  {money(view.feeSnapshot.institutionNet, locale)}
                </dd>
              </div>
            </dl>
            <p className="pc-hint">
              {messages.paymentStatuses[view.feeSnapshot.paymentStatus] ??
                view.feeSnapshot.paymentStatus}
            </p>
          </section>
        </aside>
      </div>
      <AttestationDisclaimer messages={messages} />
    </div>
  );
}
