'use client';

import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';
import { FormError } from '@/components/auth-form';
import { SubmissionCertificateSection } from '@/components/certificate';
import {
  DecisionHistory,
  Digest,
  InstitutionComments,
  TechnicalSummary,
} from '@/components/submission';
import { resolveLocale } from '@/i18n/locales';
import { PageHeader } from '@/components/ui/page-header';
import { LoadingState } from '@/components/ui/states';
import { StatusBadge } from '@/components/ui/status-badge';
import { getSubmissionsMessages } from '@/i18n/submissions-messages';
import {
  ApiError,
  certificatesApi,
  submissionsApi,
  type OfficialSubmissionResponse,
  type SubmissionCommentResponse,
  type SubmissionCertificateStatusResponse,
  type SubmissionDecisionEventResponse,
} from '@/lib/api-client';

/** Keep asking only while PalCert is still copying, and not for ever (§33). */
const POLL_INTERVAL_MS = 2_000;
const POLL_DEADLINE_MS = 2 * 60 * 1_000;

/**
 * One official submission, as its author sees it (§88, §89, §92).
 *
 * The page keeps PalCert's two answers visibly apart. The technical result is
 * labelled as PalCert's measurement; the decision is labelled as the
 * institution's, with its history and its comments beneath. A revision still
 * being prepared says so in PalCert's own vocabulary, never in the
 * institution's — nothing has been shown to anybody yet.
 */
export default function SubmissionPage() {
  const params = useParams();
  const locale = resolveLocale(params.locale);
  const submissionId = String(params.submissionId);
  const messages = getSubmissionsMessages(locale);

  const [submission, setSubmission] = useState<OfficialSubmissionResponse | null>(null);
  const [events, setEvents] = useState<SubmissionDecisionEventResponse[]>([]);
  const [comments, setComments] = useState<SubmissionCommentResponse[]>([]);
  const [certificate, setCertificate] = useState<SubmissionCertificateStatusResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  const describe = useCallback(
    (caught: unknown): string =>
      caught instanceof ApiError
        ? (messages.errors[caught.code] ?? messages.genericError)
        : messages.genericError,
    [messages],
  );

  useEffect(() => {
    let cancelled = false;
    const startedAt = Date.now();
    let timer: ReturnType<typeof setTimeout> | null = null;

    async function tick(): Promise<void> {
      try {
        const current = await submissionsApi.get(submissionId);
        if (cancelled) return;
        setSubmission(current);

        const revisionId = current.currentRevision?.id ?? null;
        let awaitingCertificate = false;
        if (revisionId !== null) {
          const [history, notes, certificateStatus] = await Promise.all([
            submissionsApi.history(revisionId),
            submissionsApi.comments(revisionId),
            certificatesApi.forRevision(revisionId),
          ]);
          if (cancelled) return;
          setEvents(history);
          setComments(notes);
          setCertificate(certificateStatus);
          // §71: issuance is asynchronous, so an approval that has just landed
          // legitimately shows no certificate yet. Keep asking while it is
          // being prepared, and stop at the same deadline as everything else
          // rather than polling a person's browser for ever.
          awaitingCertificate =
            certificateStatus.eligible &&
            (certificateStatus.certificate?.issuedAt ?? null) === null;
        }

        const preparing = current.currentRevision === null;
        if ((preparing || awaitingCertificate) && Date.now() - startedAt < POLL_DEADLINE_MS) {
          timer = setTimeout(() => void tick(), POLL_INTERVAL_MS);
        }
      } catch (caught) {
        if (!cancelled) setError(describe(caught));
      }
    }

    void tick();
    return () => {
      cancelled = true;
      if (timer !== null) clearTimeout(timer);
    };
  }, [describe, submissionId]);

  const open = useCallback(
    async (kind: 'document' | 'report') => {
      if (submission === null || submission.currentRevision === null) return;
      try {
        const grant =
          kind === 'document'
            ? await submissionsApi.document(submission.currentRevision.id)
            : await submissionsApi.report(submission.currentRevision.id);
        window.location.assign(grant.url);
      } catch (caught) {
        setError(describe(caught));
      }
    },
    [describe, submission],
  );

  if (error !== null) {
    return (
      <main className="pc-page">
        <p className="pc-back-link">
          <Link href={`/${locale}/submissions`}>{messages.back}</Link>
        </p>
        <FormError message={error} />
      </main>
    );
  }

  if (submission === null) {
    return (
      <main className="pc-page">
        <p className="pc-back-link">
          <Link href={`/${locale}/submissions`}>{messages.back}</Link>
        </p>
        <LoadingState label={messages.loading} />
      </main>
    );
  }

  const revision = submission.currentRevision;

  return (
    <main className="pc-page">
      <p className="pc-back-link">
        <Link href={`/${locale}/submissions`}>{messages.back}</Link>
      </p>
      <PageHeader
        title={submission.documentName}
        description={`${submission.organizationName} — ${submission.documentTypeName}`}
      />

      <div className="pc-detail-grid">
        <div className="pc-detail-main">
          <section className="pc-card" aria-labelledby="decision-heading">
            <h2 id="decision-heading" className="pc-card-title">
              {messages.decisionTitle}
            </h2>
            <p className="pc-hint">{messages.decisionHint}</p>
            <p>
              <StatusBadge
                status={submission.displayStatus}
                label={
                  messages.displayStatuses[submission.displayStatus] ?? submission.displayStatus
                }
              />
            </p>
            {revision === null ? (
              <p className="pc-hint">{messages.processingHints.PREPARING}</p>
            ) : (
              <p className="pc-hint">
                {messages.processingHints[revision.processingStatus]}
                {revision.failureCode === null
                  ? ''
                  : ` ${messages.failureCodes[revision.failureCode] ?? ''}`}
              </p>
            )}
          </section>

          {revision === null ? null : (
            <>
              <TechnicalSummary locale={locale} technical={revision.technical} />

              {certificate === null ? null : (
                <SubmissionCertificateSection locale={locale} status={certificate} />
              )}

              {submission.displayStatus !== 'REVISION_REQUESTED' ? null : (
                <section className="pc-card" aria-labelledby="resubmit-heading">
                  <h2 id="resubmit-heading" className="pc-card-title">
                    {messages.resubmitTitle}
                  </h2>
                  <p>{messages.resubmitHint}</p>
                  <Link href={`/${locale}/documents/${submission.documentId}`} dir="auto">
                    {submission.documentName}
                  </Link>
                </section>
              )}

              <DecisionHistory locale={locale} events={events} />
              <InstitutionComments locale={locale} comments={comments} />
            </>
          )}
        </div>

        {revision === null ? null : (
          <aside className="pc-detail-side">
            <section className="pc-card" aria-labelledby="evidence-heading">
              <h2 id="evidence-heading" className="pc-card-title">
                {messages.evidenceTitle}
              </h2>
              <p className="pc-hint">{messages.evidenceHint}</p>
              <dl className="pc-definitions">
                <dt>{messages.documentHash}</dt>
                <dd>
                  <Digest value={revision.documentSha256} />
                </dd>
                <dt>{messages.reportHash}</dt>
                <dd>
                  <Digest value={revision.reportHash} />
                </dd>
                <dt>{messages.evidenceHash}</dt>
                <dd>
                  <Digest value={revision.evidenceHash} />
                </dd>
              </dl>
              <div className="pc-actions">
                <button type="button" className="secondary" onClick={() => void open('document')}>
                  {messages.downloadDocument}
                </button>
                <button type="button" className="secondary" onClick={() => void open('report')}>
                  {messages.downloadReport}
                </button>
              </div>
            </section>
          </aside>
        )}
      </div>
    </main>
  );
}
