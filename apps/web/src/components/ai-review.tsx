'use client';

import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { AIServiceFee, useAIServiceQuote } from '@/components/ai-service-fee';
import { getAIMessages } from '@/i18n/ai-messages';
import { getChecksMessages } from '@/i18n/checks-messages';
import type { Locale } from '@/i18n/locales';
import {
  aiApi,
  ApiError,
  type AIConsentResponse,
  type AIReviewResponse,
  type AIRuleAssessmentResponseView,
  type AISupplementResponse,
} from '@/lib/api-client';

/** Bounded polling while a review runs, like the check page (§123 of Phase 7). */
const POLL_INTERVAL_MS = 2_000;
const POLL_MAX_INTERVAL_MS = 15_000;
const POLL_DEADLINE_MS = 5 * 60 * 1_000;

/**
 * The AI review section of a completed check (§65, §66, §67, §68).
 *
 * Visually and structurally secondary to the deterministic result, which is
 * the page's primary content. The two are never blended into one verdict: an
 * assessment is always shown as three separate lines — what the machine
 * measured, what the AI thinks, and what the status therefore still is — so a
 * reader can see at a glance that an AI opinion did not decide anything.
 */
export function AIReviewSection({ checkId, locale }: { checkId: string; locale: Locale }) {
  const messages = getAIMessages(locale);
  const checkMessages = getChecksMessages(locale);

  const [consent, setConsent] = useState<AIConsentResponse | null>(null);
  const [review, setReview] = useState<AIReviewResponse | null>(null);
  const [assessments, setAssessments] = useState<AIRuleAssessmentResponseView[]>([]);
  const [supplement, setSupplement] = useState<AISupplementResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [unavailable, setUnavailable] = useState(false);
  const [starting, setStarting] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  // ADR-0149: the fee is shown before the user confirms, and the start button
  // stays disabled until there is a price the balance covers.
  const fee = useAIServiceQuote('AI_REVIEW');

  const describe = useCallback(
    (caught: unknown): string =>
      caught instanceof ApiError
        ? (messages.errors[caught.code] ?? messages.genericError)
        : messages.genericError,
    [messages],
  );

  const loadOutput = useCallback(
    async (reviewId: string): Promise<void> => {
      const [loadedAssessments, loadedSupplement] = await Promise.all([
        aiApi.assessments(checkId, reviewId),
        aiApi.supplement(checkId, reviewId).catch(() => null),
      ]);
      setAssessments(loadedAssessments);
      setSupplement(loadedSupplement);
    },
    [checkId],
  );

  useEffect(() => {
    let cancelled = false;

    void (async () => {
      try {
        const [currentConsent, reviews] = await Promise.all([
          aiApi.consent(),
          aiApi.reviews(checkId),
        ]);
        if (cancelled) return;
        setConsent(currentConsent);

        const latest = reviews[0] ?? null;
        setReview(latest);
        if (latest?.status === 'COMPLETED') await loadOutput(latest.id);
      } catch (caught) {
        if (cancelled) return;
        // An unavailable AI layer is reported in place and changes nothing
        // about the technical report above it (§105).
        if (caught instanceof ApiError && caught.code === 'AI_DISABLED') {
          setUnavailable(true);
          return;
        }
        setError(describe(caught));
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [checkId, describe, loadOutput]);

  useEffect(() => {
    if (
      review === null ||
      review.status === 'COMPLETED' ||
      review.status === 'FAILED' ||
      review.status === 'CANCELLED'
    )
      return;

    let cancelled = false;
    const startedAt = Date.now();
    let interval = POLL_INTERVAL_MS;
    let timer: ReturnType<typeof setTimeout> | null = null;

    async function tick(): Promise<void> {
      try {
        const current = await aiApi.review(checkId, review!.id);
        if (cancelled) return;
        setReview(current);
        if (current.status === 'COMPLETED') {
          await loadOutput(current.id);
          return;
        }
        if (current.status === 'FAILED' || current.status === 'CANCELLED') return;
        if (Date.now() - startedAt > POLL_DEADLINE_MS) return;
        interval = Math.min(interval * 1.5, POLL_MAX_INTERVAL_MS);
        timer = setTimeout(() => void tick(), interval);
      } catch (caught) {
        if (!cancelled) setError(describe(caught));
      }
    }

    timer = setTimeout(() => void tick(), interval);
    return () => {
      cancelled = true;
      if (timer !== null) clearTimeout(timer);
    };
  }, [checkId, describe, loadOutput, review]);

  async function agree(): Promise<void> {
    try {
      setConsent(await aiApi.grantConsent());
    } catch (caught) {
      setError(describe(caught));
    }
  }

  async function start(): Promise<void> {
    if (fee.quote === null || fee.short) return;
    setStarting(true);
    setError(null);
    try {
      const started = await aiApi.startReview(checkId, fee.quote.id, crypto.randomUUID());
      setReview(started);
      setAssessments([]);
      setSupplement(null);
    } catch (caught) {
      setError(describe(caught));
    } finally {
      setStarting(false);
      // A quote funds one review; the next one needs a fresh quote.
      void fee.refresh();
    }
  }

  const cannotPay = fee.quote === null || fee.short || fee.unavailable;

  async function cancel(): Promise<void> {
    if (review === null) return;
    setCancelling(true);
    setError(null);
    try {
      setReview(await aiApi.cancelReview(checkId, review.id));
    } catch (caught) {
      setError(describe(caught));
      // The review may have moved on meanwhile; show where it actually is.
      try {
        setReview(await aiApi.review(checkId, review.id));
      } catch {
        // The error above already says what went wrong.
      }
    } finally {
      setCancelling(false);
    }
  }

  const cancellable =
    review !== null && (review.status === 'CREATED' || review.status === 'QUEUED');

  if (unavailable) {
    return (
      <section className="ai-review no-print">
        <h2>{messages.sectionTitle}</h2>
        <p>{messages.unavailable}</p>
        <p className="hint">{messages.unavailableHint}</p>
      </section>
    );
  }

  return (
    <section className="ai-review">
      <header>
        <h2>{messages.sectionTitle}</h2>
        <p className="hint">{messages.sectionSubtitle}</p>
      </header>

      {error !== null && <p role="alert">{error}</p>}

      {consent !== null && (!consent.granted || consent.renewalRequired) && (
        <div className="ai-consent">
          <h3>{messages.consentTitle}</h3>
          {/* Stated plainly before anything leaves. Hiding external processing
              behind a feature toggle would be the dishonest option (§14, §68). */}
          <p>{messages.consentExplanation}</p>
          <p className="hint">{messages.consentProviderNote}</p>
          <p className="hint">{messages.consentRetentionNote}</p>
          {consent.renewalRequired && <p className="hint">{messages.consentRenewalRequired}</p>}
          <button type="button" className="button" onClick={() => void agree()}>
            {messages.consentAgree}
          </button>
        </div>
      )}

      {consent?.granted === true && !consent.renewalRequired && review === null && (
        <div className="no-print">
          <p>{messages.noReviewYet}</p>
          <AIServiceFee state={fee} locale={locale} />
          <button
            type="button"
            className="button"
            disabled={starting || cannotPay}
            onClick={() => void start()}
          >
            {starting ? messages.starting : messages.startReview}
          </button>
        </div>
      )}

      {review !== null &&
        review.status !== 'COMPLETED' &&
        review.status !== 'FAILED' &&
        review.status !== 'CANCELLED' && (
          <div className="no-print">
            <p aria-live="polite">{messages.reviewRunning}</p>
            {cancellable && (
              <button
                type="button"
                className="button secondary"
                disabled={cancelling}
                onClick={() => void cancel()}
              >
                {cancelling ? messages.cancelling : messages.cancelReview}
              </button>
            )}
          </div>
        )}

      {review?.status === 'CANCELLED' && (
        <div className="no-print" aria-live="polite">
          <p>{messages.reviewCancelled}</p>
          {consent?.granted === true && !consent.renewalRequired && (
            <>
              <AIServiceFee state={fee} locale={locale} />
              <button
                type="button"
                className="button secondary"
                disabled={starting || cannotPay}
                onClick={() => void start()}
              >
                {starting ? messages.starting : messages.startReview}
              </button>
            </>
          )}
        </div>
      )}

      {review?.status === 'FAILED' && (
        <div className="no-print" aria-live="polite">
          <p>{messages.reviewFailed}</p>
          <p className="hint">{messages.reviewFailedHint}</p>
          {/* A failed review was not charged; trying again is a new purchase. */}
          <AIServiceFee state={fee} locale={locale} />
          <button
            type="button"
            className="button secondary"
            disabled={starting || cannotPay}
            onClick={() => void start()}
          >
            {messages.retry}
          </button>
        </div>
      )}

      {review?.status === 'COMPLETED' && (
        <>
          {review.contextTruncated && <p className="hint">{messages.contextTruncated}</p>}

          {supplement !== null && (
            <div className="ai-summary">
              <h3>{messages.summary}</h3>
              <p>{locale === 'ar' ? supplement.summaryAr : supplement.summaryEn}</p>

              {supplement.priorityRecommendations.length > 0 && (
                <>
                  <h3>{messages.recommendations}</h3>
                  <ol className="ai-recommendations">
                    {supplement.priorityRecommendations.map((recommendation, index) => (
                      <li key={index}>
                        <span className="priority">
                          {messages.priorities[recommendation.priority] ?? recommendation.priority}
                        </span>
                        <span>
                          {locale === 'ar' ? recommendation.textAr : recommendation.textEn}
                        </span>
                      </li>
                    ))}
                  </ol>
                </>
              )}
            </div>
          )}

          <h3>{messages.assessments}</h3>
          <ul className="ai-assessment-list">
            {assessments.map((assessment) => (
              <li key={assessment.id} className="ai-assessment">
                <h4>{assessment.ruleCode}</h4>

                {/*
                  Three separate lines, never merged. The distinction between
                  what was measured, what an AI thinks, and what the status
                  therefore still is has to be obvious at a glance (§66).
                */}
                <dl>
                  <dt>{messages.machineStatus}</dt>
                  <dd>
                    {assessment.deterministicOutcome === null
                      ? '—'
                      : (checkMessages.outcomes[assessment.deterministicOutcome] ??
                        assessment.deterministicOutcome)}
                  </dd>

                  <dt>{messages.aiAssessment}</dt>
                  <dd className={`ai-verdict ai-verdict-${assessment.assessment.toLowerCase()}`}>
                    {messages.assessmentLabels[assessment.assessment] ?? assessment.assessment}
                  </dd>

                  <dt>{messages.finalStatus}</dt>
                  <dd>
                    {assessment.requiresHumanReview
                      ? messages.humanReviewRequired
                      : messages.humanReviewNotRequired}
                  </dd>
                </dl>

                <p>{locale === 'ar' ? assessment.explanationAr : assessment.explanationEn}</p>

                {assessment.evidenceSufficiency === 'INSUFFICIENT' && (
                  <p className="hint">{messages.evidenceInsufficient}</p>
                )}
                {assessment.evidenceNodeIds.length > 0 && (
                  <p className="hint">
                    {messages.evidence}: {assessment.evidenceNodeIds.join(', ')}
                  </p>
                )}
              </li>
            ))}
          </ul>

          <footer className="ai-provenance">
            <p className="hint">{messages.disclaimer}</p>
            <p className="hint">{messages.notAnApproval}</p>
            <dl>
              <dt>{messages.modelLabel}</dt>
              <dd>{review.providerReturnedModel ?? review.configuredModel}</dd>
              {review.completedAt !== null && (
                <>
                  <dt>{messages.reviewedOn}</dt>
                  <dd>
                    <time dateTime={review.completedAt}>
                      {new Date(review.completedAt).toLocaleString(locale)}
                    </time>
                  </dd>
                </>
              )}
              {review.aiReviewHash !== null && (
                <>
                  <dt>{messages.integrityLabel}</dt>
                  <dd>
                    <code>{review.aiReviewHash}</code>
                  </dd>
                </>
              )}
            </dl>
          </footer>
        </>
      )}
      {consent?.granted === true && (
        <p className="hint no-print">
          <Link href={`/${locale}/profile#ai-consent`}>{messages.manageConsent}</Link>
        </p>
      )}
    </section>
  );
}
