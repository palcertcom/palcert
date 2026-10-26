'use client';

import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { useCallback, useEffect, useRef, useState } from 'react';
import { FormError } from '@/components/auth-form';
import { AIReviewSection } from '@/components/ai-review';
import { CheckFindings } from '@/components/check-findings';
import { CancelCheckButton, CheckBillingSummary } from '@/components/check-billing';
import { DeterminationBadge } from '@/components/determination-badge';
import { PdfDocumentNotes } from '@/components/format-compatibility';
import { SmartFixSection } from '@/components/smartfix';
import { SubmitSection } from '@/components/submission';
import { PageHeader } from '@/components/ui/page-header';
import { LoadingState } from '@/components/ui/states';
import { StepProgress } from '@/components/ui/step-progress';
import { checkStageLabel, getChecksMessages, stageForCheckStatus } from '@/i18n/checks-messages';
import { resolveLocale } from '@/i18n/locales';
import {
  ApiError,
  checksApi,
  type CheckReportMetadataResponse,
  type CheckResponse,
} from '@/lib/api-client';

/** How long to keep asking, and how far apart, before giving up (§123). */
const POLL_INTERVAL_MS = 2_000;
const POLL_BACKOFF_MS = 1.5;
const POLL_MAX_INTERVAL_MS = 15_000;
const POLL_DEADLINE_MS = 5 * 60 * 1_000;

/**
 * One check: progress while it runs, the report when it finishes (§74, §75).
 *
 * Progress is polled, not streamed, and the polling is deliberately bounded:
 * it starts at a couple of seconds, backs off, and stops after five minutes
 * rather than hammering the API for ever. A check that has not finished by
 * then is still running server-side — the page says so and invites the reader
 * back, which is honest and costs nothing.
 */
export default function CheckPage() {
  const params = useParams();
  const locale = resolveLocale(params.locale);
  const checkId = String(params.checkId);
  const messages = getChecksMessages(locale);
  const router = useRouter();

  const [check, setCheck] = useState<CheckResponse | null>(null);
  const [report, setReport] = useState<CheckReportMetadataResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [gaveUp, setGaveUp] = useState(false);
  const [retrying, setRetrying] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

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
    let interval = POLL_INTERVAL_MS;

    async function tick(): Promise<void> {
      try {
        const current = await checksApi.get(checkId);
        if (cancelled) return;
        setCheck(current);

        if (current.status === 'COMPLETED') {
          setReport(await checksApi.report(checkId));
          return;
        }
        if (current.status === 'FAILED' || current.status === 'CANCELLED') return;

        if (Date.now() - startedAt > POLL_DEADLINE_MS) {
          setGaveUp(true);
          return;
        }
        interval = Math.min(interval * POLL_BACKOFF_MS, POLL_MAX_INTERVAL_MS);
        timer.current = setTimeout(() => void tick(), interval);
      } catch (caught) {
        if (cancelled) return;
        if (caught instanceof ApiError && caught.status === 401) {
          router.push(`/${locale}/unauthorized`);
          return;
        }
        setError(describe(caught));
      }
    }

    void tick();
    return () => {
      cancelled = true;
      if (timer.current !== null) clearTimeout(timer.current);
    };
  }, [checkId, describe, locale, router]);

  async function retry(): Promise<void> {
    setRetrying(true);
    setError(null);
    try {
      await checksApi.retry(checkId);
      router.refresh();
      window.location.reload();
    } catch (caught) {
      setError(describe(caught));
      setRetrying(false);
    }
  }

  if (check === null) {
    return (
      <main className="pc-page">
        <p className="pc-back-link">
          <Link href={`/${locale}/checks`}>{messages.backToChecks}</Link>
        </p>
        <FormError message={error} />
        {error === null ? <LoadingState label={messages.processing} /> : null}
      </main>
    );
  }

  const done = check.status === 'COMPLETED';
  const failed = check.status === 'FAILED' || check.status === 'CANCELLED';
  const stages = [
    messages.stageQueued,
    messages.stageAnalyzing,
    messages.stageEvaluating,
    messages.stageReport,
  ];
  const stageIndex = ['QUEUED', 'ANALYZING', 'EVALUATING', 'REPORT'].indexOf(
    stageForCheckStatus(check.status),
  );

  return (
    <main className="pc-page check-report">
      <p className="pc-back-link no-print">
        <Link href={`/${locale}/checks`}>{messages.backToChecks}</Link>
      </p>

      <PageHeader
        title={done ? messages.reportTitle : messages.processing}
        description={done ? messages.reportSubtitle : messages.processingHint}
        actions={
          done ? (
            <button type="button" className="secondary no-print" onClick={() => window.print()}>
              {messages.print}
            </button>
          ) : undefined
        }
      />

      <FormError message={error} />

      <div className="pc-check-summary">
        <section className="pc-card report-identity" aria-label={messages.reportTitle}>
          <dl>
            <dt>{messages.documentLabel}</dt>
            <dd>
              <bdi>{check.documentName}</bdi> (v{check.documentVersionNumber})
            </dd>
            <dt>{messages.standardLabel}</dt>
            <dd>
              <bdi>{check.standardName}</bdi> <bdi>{check.standardVersionLabel}</bdi>
            </dd>
            <dt>{messages.organizationLabel}</dt>
            <dd>
              <bdi>{check.organizationName}</bdi>
            </dd>
            {check.completedAt !== null && (
              <>
                <dt>{messages.checkedOn}</dt>
                <dd>
                  <time dateTime={check.completedAt}>
                    {new Date(check.completedAt).toLocaleString(locale)}
                  </time>
                </dd>
              </>
            )}
          </dl>
        </section>

        {/*
          What this check cost and where that money stands — shown in every
          state, because "reserved" while it runs and "charged" once it is
          delivered are exactly the two things a customer wants to know (§58,
          §59, §60).
        */}
        <section className="pc-card pc-check-billing" aria-label={messages.billingLabel}>
          <h2 className="pc-card-title">{messages.billingLabel}</h2>
          <CheckBillingSummary check={check} locale={locale} />
        </section>
      </div>

      {!done && !failed && (
        <section className="pc-card progress" aria-live="polite">
          {stageIndex >= 0 ? (
            <StepProgress
              steps={stages}
              current={stageIndex}
              label={messages.processing}
              stateLabels={messages.stepStates}
            />
          ) : null}
          <p>{checkStageLabel(check.status, messages)}</p>
          {gaveUp && <p className="pc-hint">{messages.checkBackLater}</p>}
          <CancelCheckButton
            checkId={check.id}
            status={check.status}
            locale={locale}
            onCancelled={(cancelled) => setCheck(cancelled)}
          />
        </section>
      )}

      {failed && (
        <section className="pc-card pc-check-failure failure" aria-live="polite">
          {/*
            A failed check has no verdict. It is not a document that failed to
            comply — it is a check PalCert could not finish (§10, §108).
          */}
          <h2 className="pc-card-title">{messages.stageFailed}</h2>
          <p className="pc-hint">
            {check.failureCode !== null
              ? (messages.errors[check.failureCode] ?? messages.genericError)
              : messages.genericError}
          </p>
          {check.retryable && (
            <button type="button" disabled={retrying} onClick={() => void retry()}>
              {messages.retry}
            </button>
          )}
        </section>
      )}

      {done && check.determination !== null && (
        <>
          <div className="pc-result-band">
            <DeterminationBadge determination={check.determination} locale={locale} hint />

            <section className="pc-card score" aria-labelledby="score-heading">
              <h2 id="score-heading">{messages.score}</h2>
              {check.score === null || check.score.value === null ? (
                <>
                  {/* Null is not zero, and must never render as 0% (§14). */}
                  <p className="score-value">{messages.scoreUnavailable}</p>
                  <p className="pc-hint">{messages.scoreUnavailableHint}</p>
                </>
              ) : (
                <>
                  <p className="score-value">{check.score.display}%</p>
                  {!check.score.complete && check.score.coverage !== null && (
                    <p className="pc-hint">
                      {messages.scorePartial(Math.round(Number(check.score.coverage) * 100))}
                    </p>
                  )}
                </>
              )}
              <p className="pc-hint">{messages.scoreScopeNote}</p>
            </section>
          </div>

          {check.counts !== null && (
            <section className="counts">
              <dl className="pc-stat-list">
                <div>
                  <dt>{messages.counts.total}</dt>
                  <dd>{check.counts.totalRules}</dd>
                </div>
                <div data-tone="success">
                  <dt>{messages.counts.passed}</dt>
                  <dd>{check.counts.passedRules}</dd>
                </div>
                <div data-tone="danger">
                  <dt>{messages.counts.failed}</dt>
                  <dd>{check.counts.failedRules}</dd>
                </div>
                <div>
                  <dt>{messages.counts.notApplicable}</dt>
                  <dd>{check.counts.notApplicableRules}</dd>
                </div>
                <div data-tone="warning">
                  <dt>{messages.counts.review}</dt>
                  <dd>{check.counts.reviewRequiredRules}</dd>
                </div>
                <div>
                  <dt>{messages.counts.undecided}</dt>
                  <dd>{check.counts.indeterminateRules}</dd>
                </div>
              </dl>
            </section>
          )}

          {/*
            Before the findings, not after: a reader whose pages had no text
            needs to know that before they read a list of requirements PalCert
            could not check, and the same panel is where they learn PalCert
            will not be correcting a PDF for them (Phase 13 §153).
          */}
          {check.documentFormat === 'PDF' && check.pdfDocument !== null && (
            <PdfDocumentNotes
              locale={locale}
              textLayer={check.pdfDocument.textLayer}
              tagged={check.pdfDocument.tagged}
              scannedPages={check.pdfDocument.imageOnlyPages}
              totalPages={check.pdfDocument.pageCount}
            />
          )}

          <CheckFindings checkId={checkId} locale={locale} />

          {/*
            After the deterministic findings, never mixed into them. The
            technical result stays visually primary; the AI review is a
            clearly-labelled second opinion beneath it (§65).
          */}
          <AIReviewSection checkId={checkId} locale={locale} />

          {/*
            SmartFix comes after the findings on purpose. A correction is
            something a person decides on once they have read what is wrong,
            not a button that pre-empts reading it (§112).
          */}
          {/* SmartFix is DOCX only, and the PDF panel above says so (ADR-0092). */}
          {check.documentFormat !== 'PDF' && <SmartFixSection checkId={checkId} locale={locale} />}

          {/*
            Last, and never automatic (Phase 14 §20). A check finishing, a
            correction being delivered and a payment settling all leave this
            exactly where it is: not submitted. The section shows what would be
            shared before it offers the button that shares it.
          */}
          {check.status === 'COMPLETED' && <SubmitSection checkId={checkId} locale={locale} />}

          {report !== null && (
            <section className="pc-card integrity" aria-labelledby="integrity-heading">
              <h2 id="integrity-heading">{messages.integrity}</h2>
              <dl>
                <dt>{messages.reportHash}</dt>
                <dd>
                  <code>{report.reportHash}</code>
                </dd>
                <dt>{messages.evaluationHash}</dt>
                <dd>
                  <code>{report.evaluationHash}</code>
                </dd>
              </dl>
              <p>
                <a
                  href={checksApi.reportArtifactUrl(checkId)}
                  download={`palcert-report-${checkId}.json`}
                  aria-describedby="report-artifact-hint"
                >
                  {messages.downloadReportArtifact}
                </a>
              </p>
              <p id="report-artifact-hint" className="pc-hint">
                {messages.downloadReportArtifactHint}
              </p>
            </section>
          )}

          <footer className="report-footer">
            <p className="pc-hint">{messages.notApproval}</p>
          </footer>
        </>
      )}
    </main>
  );
}
