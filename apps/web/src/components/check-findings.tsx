'use client';

import { useCallback, useEffect, useState } from 'react';
import { getChecksMessages } from '@/i18n/checks-messages';
import type { Locale } from '@/i18n/locales';
import { ApiError, checksApi, type CheckRuleResultResponse } from '@/lib/api-client';

/**
 * The findings list (§77).
 *
 * Paged rather than loaded whole: a standard can carry hundreds of rules and a
 * long thesis can violate one of them on every paragraph, and pulling all of
 * it into a single response would make the report unusable on exactly the
 * documents that most need one.
 *
 * The order is the server's — worst first — and is deliberately not recomputed
 * here: the page and the stored report must agree about what matters most.
 */
export function CheckFindings({ checkId, locale }: { checkId: string; locale: Locale }) {
  const messages = getChecksMessages(locale);

  const [results, setResults] = useState<CheckRuleResultResponse[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [filter, setFilter] = useState<'ALL' | 'FAIL'>('ALL');
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(
    async (cursor?: string): Promise<void> => {
      try {
        const page = await checksApi.results(checkId, {
          limit: 25,
          ...(cursor === undefined ? {} : { cursor }),
          ...(filter === 'FAIL' ? { outcome: 'FAIL' } : {}),
        });
        setResults((current) => (cursor === undefined ? page.items : [...current, ...page.items]));
        setNextCursor(page.nextCursor);
      } catch (caught) {
        setError(
          caught instanceof ApiError
            ? (messages.errors[caught.code] ?? messages.genericError)
            : messages.genericError,
        );
      }
    },
    [checkId, filter, messages],
  );

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <section className="findings">
      <h2>{messages.findings}</h2>

      <div className="filters no-print" role="group" aria-label={messages.findings}>
        <button
          type="button"
          aria-pressed={filter === 'ALL'}
          onClick={() => setFilter('ALL')}
          className={filter === 'ALL' ? 'button' : 'button secondary'}
        >
          {messages.showAll}
        </button>
        <button
          type="button"
          aria-pressed={filter === 'FAIL'}
          onClick={() => setFilter('FAIL')}
          className={filter === 'FAIL' ? 'button' : 'button secondary'}
        >
          {messages.showFailed}
        </button>
      </div>

      {error !== null && <p role="alert">{error}</p>}
      {results.length === 0 && error === null && <p>{messages.noFindings}</p>}

      <ol className="finding-list">
        {results.map((result) => (
          <li key={result.id} className={`finding finding-${result.outcome.toLowerCase()}`}>
            <h3>{(locale === 'ar' ? result.titleAr : result.titleEn) ?? result.ruleCode}</h3>

            <p className="finding-status">
              {/* The words carry the meaning; colour only reinforces it. */}
              <span className="outcome">{messages.outcomes[result.outcome] ?? result.outcome}</span>
              {' · '}
              <span className="severity">
                {messages.severities[result.severity] ?? result.severity}
              </span>
              {' · '}
              <span>{result.blocking ? messages.blocking : messages.advisory}</span>
            </p>

            {result.requiresReview && (
              <p className="hint">
                {messages.needsReview} — {messages.needsReviewHint}
              </p>
            )}

            {(locale === 'ar' ? result.guidanceAr : result.guidanceEn) !== null && (
              <p className="guidance">{locale === 'ar' ? result.guidanceAr : result.guidanceEn}</p>
            )}

            {result.totalViolationCount > 0 && (
              <>
                <p className="hint">
                  {messages.violationCount(
                    result.returnedViolationCount,
                    result.totalViolationCount,
                  )}
                </p>
                {/*
                  Say so when the list is a sample. A page that presented a
                  truncated list as the whole story would send a reader off to
                  fix five of four hundred problems (§45).
                */}
                {result.violationsTruncated && <p className="hint">{messages.truncatedNote}</p>}

                <ul className="violation-list">
                  {(result.violations ?? []).map((violation) => (
                    <li key={violation.id}>
                      <span className="where">
                        {violation.sectionKey ??
                          violation.elementType ??
                          violation.nodeId ??
                          messages.noLocation}
                        {/* A page number only when the extractor knew one (§52). */}
                        {violation.page !== null && ` — ${violation.page}`}
                      </span>
                      {violation.expectedValue !== null && (
                        <span className="expected">
                          {messages.expected}: {violation.expectedValue}
                          {violation.expectedUnit !== null && ` ${violation.expectedUnit}`}
                        </span>
                      )}
                      {violation.actualValue !== null && (
                        <span className="actual">
                          {messages.actual}: {violation.actualValue}
                          {violation.actualUnit !== null && ` ${violation.actualUnit}`}
                        </span>
                      )}
                    </li>
                  ))}
                </ul>
              </>
            )}
          </li>
        ))}
      </ol>

      {nextCursor !== null && (
        <button
          type="button"
          className="button secondary no-print"
          onClick={() => void load(nextCursor)}
        >
          {messages.loadMore}
        </button>
      )}
    </section>
  );
}
