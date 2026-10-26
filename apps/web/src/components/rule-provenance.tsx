'use client';

import { useId, useState } from 'react';
import { getExtractionMessages } from '@/i18n/extraction-messages';
import type { Locale } from '@/i18n/locales';
import {
  ApiError,
  extractionApi,
  type RuleProvenanceResponse,
  type RuleResponse,
} from '@/lib/api-client';

/**
 * Where one rule came from: the source file, the pages, and the reading that
 * proposed it. Chosen from a list rather than attached to every rule row, so
 * the rule list stays a plain list and nothing is fetched until asked for.
 */
export function RuleProvenancePanel({
  organizationId,
  versionId,
  locale,
  rules,
  api = extractionApi,
}: {
  organizationId: string;
  versionId: string;
  locale: Locale;
  rules: readonly RuleResponse[];
  api?: Pick<typeof extractionApi, 'provenance'>;
}) {
  const messages = getExtractionMessages(locale);
  const fieldId = useId();
  const [ruleId, setRuleId] = useState('');
  const [entries, setEntries] = useState<readonly RuleProvenanceResponse[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  if (rules.length === 0) return null;

  async function choose(next: string): Promise<void> {
    setRuleId(next);
    setEntries(null);
    setError(null);
    if (next === '') return;
    try {
      setEntries(await api.provenance(organizationId, versionId, next));
    } catch (caught) {
      setError(
        caught instanceof ApiError
          ? (messages.errors[caught.code] ?? messages.genericError)
          : messages.genericError,
      );
    }
  }

  const when = new Intl.DateTimeFormat(locale, { dateStyle: 'medium' });

  return (
    <section className="pc-card" aria-labelledby="rule-provenance-heading">
      <h2 id="rule-provenance-heading" className="pc-card-title">
        {messages.provenanceTitle}
      </h2>
      <p className="pc-hint">{messages.provenanceNotPartOfStandard}</p>
      <div className="pc-field">
        <label htmlFor={fieldId}>{messages.provenanceRuleLabel}</label>
        <select id={fieldId} value={ruleId} onChange={(event) => void choose(event.target.value)}>
          <option value="">{messages.provenanceChooseRule}</option>
          {rules.map((rule) => (
            <option key={rule.id} value={rule.id}>
              {rule.ruleCode} — {locale === 'ar' ? rule.titleAr : rule.titleEn}
            </option>
          ))}
        </select>
      </div>
      {error !== null && (
        <p className="pc-alert pc-alert-error" role="alert">
          {error}
        </p>
      )}
      <div aria-live="polite">
        {entries !== null && entries.length === 0 && (
          <p className="pc-hint">{messages.provenanceNone}</p>
        )}
        {entries !== null && entries.length > 0 && (
          <ul className="pc-timeline" data-testid="rule-provenance">
            {entries.map((entry) => (
              <li key={`${entry.proposalId}-${entry.sourceAssetId}-${entry.startPage ?? ''}`}>
                {messages.provenanceFrom}{' '}
                <bdi>
                  <strong>{entry.sourceFilename}</strong>
                </bdi>{' '}
                ({messages.sourceKinds[entry.sourceKind] ?? entry.sourceKind})
                {entry.startPage !== null &&
                  (entry.endPage !== null && entry.endPage !== entry.startPage
                    ? `, ${messages.provenancePages} ${entry.startPage}–${entry.endPage}`
                    : `, ${messages.evidencePage} ${entry.startPage}`)}{' '}
                <time dateTime={entry.createdAt}>{when.format(new Date(entry.createdAt))}</time>
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}
