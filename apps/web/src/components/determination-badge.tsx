'use client';

import { getChecksMessages } from '@/i18n/checks-messages';
import type { Locale } from '@/i18n/locales';

/**
 * The compliance verdict, in words (§75).
 *
 * Never the raw enum, and never dressed up as an approval: "meets this
 * standard" is a statement about formatting against one published standard,
 * which is the only thing PalCert is in a position to say.
 *
 * Colour is never the only signal — each state carries its own text and an
 * accessible label — because a red badge means nothing to a reader who cannot
 * distinguish it from a green one.
 */
export function DeterminationBadge({
  determination,
  locale,
  hint = false,
}: {
  determination: string;
  locale: Locale;
  hint?: boolean;
}) {
  const messages = getChecksMessages(locale);
  const label = messages.determinations[determination] ?? determination;

  return (
    <div className={`determination determination-${determination.toLowerCase()}`}>
      <p className="determination-label" role="status">
        {label}
      </p>
      {hint && <p className="hint">{messages.determinationHints[determination]}</p>}
    </div>
  );
}
