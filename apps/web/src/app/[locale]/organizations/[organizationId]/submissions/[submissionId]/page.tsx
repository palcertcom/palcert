'use client';

import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';
import { OrganizationShell } from '@/components/organization-shell';
import { DecisionHistory, Digest } from '@/components/submission';
import { PageHeader } from '@/components/ui/page-header';
import { LoadingState } from '@/components/ui/states';
import { StatusBadge } from '@/components/ui/status-badge';
import { getChecksMessages } from '@/i18n/checks-messages';
import { getShellMessages } from '@/i18n/shell-messages';
import type { Locale } from '@/i18n/locales';
import { getSubmissionsMessages } from '@/i18n/submissions-messages';
import {
  ApiError,
  submissionReviewApi,
  type OrganizationSubmissionResponse,
  type SubmissionCommentResponse,
  type SubmissionDecisionEventResponse,
} from '@/lib/api-client';

const REASONS = [
  'TECHNICAL_CORRECTIONS_REQUIRED',
  'DOCUMENT_INCOMPLETE',
  'ADMINISTRATIVE_REQUIREMENT',
  'OTHER',
] as const;

/**
 * One submission, as the receiving institution reviews it (§57, §58).
 *
 * The page says plainly what a reviewer can and cannot do. PalCert's technical
 * result is displayed and is not editable — not because the form omits the
 * field, but because the database refuses the write. The decision beside it is
 * the institution's own, and approving a non-compliant submission is a
 * legitimate thing to do here rather than an error to be prevented.
 */
export default function OrganizationSubmissionPage() {
  return (
    <OrganizationShell>
      {({ organizationId, locale }) => <Review locale={locale} organizationId={organizationId} />}
    </OrganizationShell>
  );
}

function Review({ locale, organizationId }: { locale: Locale; organizationId: string }) {
  const params = useParams();
  const submissionId = String(params.submissionId);
  const messages = getSubmissionsMessages(locale);

  const [submission, setSubmission] = useState<OrganizationSubmissionResponse | null>(null);
  const [events, setEvents] = useState<SubmissionDecisionEventResponse[]>([]);
  const [comments, setComments] = useState<SubmissionCommentResponse[]>([]);
  const [comment, setComment] = useState('');
  const [reason, setReason] = useState<string>('TECHNICAL_CORRECTIONS_REQUIRED');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [reloadToken, setReloadToken] = useState(0);

  const describe = useCallback(
    (caught: unknown): string =>
      caught instanceof ApiError
        ? (messages.errors[caught.code] ?? messages.genericError)
        : messages.genericError,
    [messages],
  );

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const current = await submissionReviewApi.get(organizationId, submissionId);
        if (cancelled) return;
        setSubmission(current);

        if (current.currentRevisionId !== '') {
          const [history, notes] = await Promise.all([
            submissionReviewApi.history(organizationId, current.currentRevisionId),
            submissionReviewApi.comments(organizationId, current.currentRevisionId),
          ]);
          if (cancelled) return;
          setEvents(history);
          setComments(notes);
        }
      } catch (caught) {
        if (!cancelled) setError(describe(caught));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [describe, organizationId, reloadToken, submissionId]);

  const current = submission?.revisions.find((revision) => revision.isCurrent) ?? null;

  const decide = useCallback(
    async (toStatus: string) => {
      if (current === null) return;
      setError(null);
      setBusy(true);
      try {
        await submissionReviewApi.decide(organizationId, current.id, {
          toStatus,
          // §72: what this reviewer was looking at. If somebody else moved it
          // since, the server refuses rather than overwriting their decision.
          expectedStatus: current.institutionDecisionStatus,
          ...(toStatus === 'REJECTED' || toStatus === 'REVISION_REQUESTED'
            ? { comment: comment.trim(), reasonCode: reason }
            : {}),
        });
        setComment('');
        setReloadToken((token) => token + 1);
      } catch (caught) {
        setError(describe(caught));
      } finally {
        setBusy(false);
      }
    },
    [comment, current, describe, organizationId, reason],
  );

  const addComment = useCallback(async () => {
    if (current === null || comment.trim() === '') return;
    setError(null);
    setBusy(true);
    try {
      await submissionReviewApi.comment(organizationId, current.id, comment.trim());
      setComment('');
      setReloadToken((token) => token + 1);
    } catch (caught) {
      setError(describe(caught));
    } finally {
      setBusy(false);
    }
  }, [comment, current, describe, organizationId]);

  const open = useCallback(
    async (kind: 'document' | 'report') => {
      if (current === null) return;
      try {
        const grant =
          kind === 'document'
            ? await submissionReviewApi.document(organizationId, current.id)
            : await submissionReviewApi.report(organizationId, current.id);
        window.location.assign(grant.url);
      } catch (caught) {
        setError(describe(caught));
      }
    },
    [current, describe, organizationId],
  );

  if (submission === null) {
    return error === null ? (
      <LoadingState label={getShellMessages(locale).loading} />
    ) : (
      <p role="alert">{error}</p>
    );
  }

  const decided =
    current !== null &&
    ['APPROVED', 'REJECTED', 'REVISION_REQUESTED'].includes(current.institutionDecisionStatus);
  const determinations = getChecksMessages(locale).determinations;

  return (
    <>
      <p className="pc-back-link">
        <Link href={`/${locale}/organizations/${organizationId}/submissions`}>{messages.back}</Link>
      </p>
      <PageHeader title={messages.reviewTitle} description={messages.reviewIntro} />
      {error === null ? null : <p role="alert">{error}</p>}

      <section className="pc-card" aria-label={messages.reviewTitle}>
        <dl className="pc-summary">
          <dt>{messages.queueSubmitter}</dt>
          <dd>
            <bdi>{submission.submitter.displayName ?? submission.submitter.email}</bdi>
            {submission.submitter.displayName !== null && (
              <>
                {' '}
                <span dir="ltr" className="pc-ltr pc-hint">
                  {submission.submitter.email}
                </span>
              </>
            )}
          </dd>
          <dt>{messages.queueStandard}</dt>
          <dd>
            <bdi>{submission.documentTypeName}</bdi>
          </dd>
        </dl>
      </section>

      {current === null ? null : (
        <div className="pc-detail-grid">
          <div className="pc-detail-main">
            {/* PalCert's measurement. Fixed, and not the institution's to change. */}
            <section className="pc-card" aria-labelledby="org-technical-heading">
              <h2 id="org-technical-heading" className="pc-card-title">
                {messages.technicalTitle}
              </h2>
              <p>
                <StatusBadge
                  status={current.technical.determination}
                  label={
                    determinations[current.technical.determination] ??
                    current.technical.determination
                  }
                />
              </p>
              <p className="pc-hint">{messages.reviewSeparation}</p>
              <dl className="pc-summary">
                <dt>{messages.queueResult}</dt>
                <dd>
                  {messages.ruleCounts(current.technical.passedRules, current.technical.totalRules)}
                </dd>
                <dt>{messages.queueStandard}</dt>
                <dd>
                  <bdi>
                    <code>{current.standard.standardCode}</code>{' '}
                    {current.standard.standardVersionLabel}
                  </bdi>
                </dd>
              </dl>
            </section>

            <section className="pc-card" aria-labelledby="org-evidence-heading">
              <h2 id="org-evidence-heading" className="pc-card-title">
                {messages.evidenceTitle}
              </h2>
              <p className="pc-hint">{messages.evidenceHint}</p>
              <dl className="pc-summary">
                <dt>{messages.documentHash}</dt>
                <dd>
                  <Digest value={current.documentSha256} />
                </dd>
                <dt>{messages.reportHash}</dt>
                <dd>
                  <Digest value={current.reportHash} />
                </dd>
                <dt>{messages.evidenceHash}</dt>
                <dd>
                  <Digest value={current.evidenceHash} />
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

            <DecisionHistory locale={locale} events={events} />

            <section className="pc-card" aria-labelledby="org-comments-heading">
              <h2 id="org-comments-heading" className="pc-card-title">
                {messages.commentsTitle}
              </h2>
              {comments.length === 0 ? (
                <p className="pc-hint">{messages.commentsEmpty}</p>
              ) : (
                <ul className="pc-comment-list">
                  {comments.map((entry) => (
                    <li key={entry.id}>{entry.body}</li>
                  ))}
                </ul>
              )}
            </section>
          </div>

          {/* The institution's decision: a separate act by a separate party. */}
          <div className="pc-detail-side">
            <section className="pc-card pc-decision-card" aria-labelledby="org-decision-heading">
              <h2 id="org-decision-heading" className="pc-card-title">
                {messages.decisionTitle}
              </h2>
              <p>
                <StatusBadge
                  status={current.institutionDecisionStatus}
                  label={
                    messages.displayStatuses[current.institutionDecisionStatus] ??
                    current.institutionDecisionStatus
                  }
                />
              </p>

              {decided ? null : (
                <div className="pc-form">
                  <div className="pc-field">
                    <label htmlFor="decision-comment">{messages.commentLabel}</label>
                    <textarea
                      id="decision-comment"
                      value={comment}
                      rows={4}
                      maxLength={4000}
                      onChange={(event) => setComment(event.target.value)}
                    />
                    <p className="pc-hint">{messages.commentRequired}</p>
                  </div>

                  <div className="pc-field">
                    <label htmlFor="decision-reason">{messages.reasonLabel}</label>
                    <select
                      id="decision-reason"
                      value={reason}
                      onChange={(event) => setReason(event.target.value)}
                    >
                      {REASONS.map((code) => (
                        <option key={code} value={code}>
                          {messages.reasonCodes[code] ?? code}
                        </option>
                      ))}
                    </select>
                  </div>

                  <div className="pc-decision-actions">
                    {current.institutionDecisionStatus === 'SUBMITTED' ? (
                      <button
                        type="button"
                        className="secondary"
                        disabled={busy}
                        onClick={() => void decide('UNDER_REVIEW')}
                      >
                        {busy ? messages.deciding : messages.startReview}
                      </button>
                    ) : null}
                    <button type="button" disabled={busy} onClick={() => void decide('APPROVED')}>
                      {busy ? messages.deciding : messages.approve}
                    </button>
                    <button
                      type="button"
                      className="secondary"
                      disabled={busy || comment.trim() === ''}
                      onClick={() => void decide('REVISION_REQUESTED')}
                    >
                      {busy ? messages.deciding : messages.requestRevision}
                    </button>
                    <button
                      type="button"
                      className="pc-danger"
                      disabled={busy || comment.trim() === ''}
                      onClick={() => void decide('REJECTED')}
                    >
                      {busy ? messages.deciding : messages.reject}
                    </button>
                  </div>

                  <p className="pc-hint">{messages.commentOnlyHint}</p>
                  <button
                    type="button"
                    className="secondary"
                    disabled={busy || comment.trim() === ''}
                    onClick={() => void addComment()}
                  >
                    {busy ? messages.addingComment : messages.addComment}
                  </button>
                </div>
              )}
            </section>
          </div>
        </div>
      )}
    </>
  );
}
