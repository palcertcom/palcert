'use client';

import { useEffect, useState } from 'react';
import { getPdfMessages } from '@/i18n/pdf-messages';
import type { Locale } from '@/i18n/locales';
import { ApiError, catalogueApi, type StandardCompatibilityResponse } from '@/lib/api-client';

/**
 * What a standard can be checked for, in this document's format (§63–§66).
 *
 * Shown before payment, because the answer changes whether buying the check is
 * worth it. Three things this panel is careful about:
 *
 * **It is not a prediction.** "Checkable" means PalCert can read the property
 * from this format at all. A scanned PDF can still leave a checkable
 * requirement unanswered, and the panel says so rather than letting a green
 * row read as a promised verdict.
 *
 * **Every unchecked requirement gets a reason.** A requirement silently absent
 * from a report is one the user assumes passed. The reason comes from the
 * shared support registry, so it is the same sentence the analyzer's own
 * coverage note is built from.
 *
 * **Zero coverage is a refusal, explained.** The check cannot be bought, and
 * the panel says what to do instead — upload a format that stores these
 * requirements, or pick a different standard.
 */
export function FormatCompatibility({
  standardId,
  documentVersionId,
  locale,
}: {
  standardId: string;
  documentVersionId: string;
  locale: Locale;
}) {
  const messages = getPdfMessages(locale);
  const [compatibility, setCompatibility] = useState<StandardCompatibilityResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const result = await catalogueApi.compatibility(standardId, documentVersionId);
        if (!cancelled) setCompatibility(result);
      } catch (caught) {
        if (cancelled) return;
        setError(
          caught instanceof ApiError
            ? (messages.errors[caught.code] ?? caught.message)
            : 'Unavailable',
        );
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [standardId, documentVersionId, messages]);

  if (error !== null) {
    return (
      <section className="compatibility">
        <h3>{messages.coverageTitle}</h3>
        <p role="alert">{error}</p>
      </section>
    );
  }
  if (compatibility === null) return null;

  const unsupported = compatibility.rules.filter((rule) => rule.support === 'UNSUPPORTED');

  return (
    <section className="compatibility">
      <h3>{messages.coverageTitle}</h3>
      <p>{messages.coverageIntro}</p>

      <p className="level" data-level={compatibility.level}>
        <strong>{messages.coverageLevels[compatibility.level]}</strong>{' '}
        <span>
          {messages.coverageCounts(compatibility.supportedRules, compatibility.totalRules)}
        </span>
      </p>

      {compatibility.level === 'NONE' ? (
        <p role="alert">{messages.coverageNone}</p>
      ) : (
        <p className="caveat">{messages.coverageNotAPromise}</p>
      )}

      {unsupported.length > 0 && (
        <table>
          <caption>{messages.columnWhy}</caption>
          <thead>
            <tr>
              <th scope="col">{messages.columnRule}</th>
              <th scope="col">{messages.columnAnswerable}</th>
              <th scope="col">{messages.columnWhy}</th>
            </tr>
          </thead>
          <tbody>
            {unsupported.map((rule) => (
              <tr key={rule.ruleCode}>
                <th scope="row">{rule.ruleCode}</th>
                <td>{messages.supportLevels[rule.support]}</td>
                <td>{rule.note}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}

/**
 * What a PDF report says about the document itself.
 *
 * The three sentences a PDF user most needs and a DOCX user never sees: that
 * their scanned pages were not read and PalCert did not guess at the text,
 * that an untagged file has no headings to check against, and that PalCert
 * does not correct PDFs at all.
 */
export function PdfDocumentNotes({
  locale,
  textLayer,
  tagged,
  scannedPages,
  totalPages,
}: {
  locale: Locale;
  textLayer: string;
  tagged: boolean;
  scannedPages: number;
  totalPages: number;
}) {
  const messages = getPdfMessages(locale);
  const scanned = textLayer === 'IMAGE_ONLY' || textLayer === 'HYBRID';

  return (
    <section className="pdf-notes">
      <h3>{messages.textLayerTitle}</h3>
      <p>
        <strong>{messages.textLayers[textLayer] ?? messages.textLayers.EMPTY_OR_UNKNOWN}</strong>
      </p>
      <p>{messages.textLayerHints[textLayer] ?? messages.textLayerHints.EMPTY_OR_UNKNOWN}</p>
      {textLayer === 'HYBRID' && <p>{messages.hybridPages(scannedPages, totalPages)}</p>}
      {scanned && <p className="advice">{messages.scannedAdvice}</p>}

      <h3>{messages.taggedTitle}</h3>
      <p>
        <strong>{tagged ? messages.tagged : messages.untagged}</strong>
      </p>
      {!tagged && <p>{messages.untaggedExplanation}</p>}

      <h3>{messages.smartFixTitle}</h3>
      <p>
        <strong>{messages.smartFixUnavailable}</strong>
      </p>
      <p>{messages.smartFixAdvice}</p>
    </section>
  );
}
