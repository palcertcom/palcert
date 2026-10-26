'use client';

import { useState } from 'react';
import { getApiClientsMessages } from '@/i18n/api-clients-messages';
import type { Locale } from '@/i18n/locales';
import type { ApiClientSecretResponse } from '@/lib/api-client';

/**
 * The one screen in Phase 19 that shows a credential.
 *
 * The same three rules as the webhook secret panel, for the same reasons, and
 * written out here rather than shared because a shared "secret panel" is the
 * kind of component that grows a `persist` prop.
 *
 * The warning comes *before* the secret, because somebody who has copied and
 * closed the panel does not go back and read what was underneath it.
 *
 * The value lives in this component's props and nowhere else — not
 * `localStorage`, not `sessionStorage`, not the URL, not the history, not a
 * global store. Each of those outlives the page, and the promise PalCert makes
 * is that this is shown once. It is not logged either: a `console.log` of a
 * response body is how a secret ends up in a browser extension's capture.
 *
 * Copying falls back to leaving the text selectable, so a browser that refuses
 * clipboard access does not leave somebody stuck with a credential they can
 * see and cannot take.
 */
export function ApiClientSecretPanel({
  locale,
  reveal,
  kind,
  onDismiss,
}: {
  locale: Locale;
  reveal: ApiClientSecretResponse;
  /**
   * Which act produced this secret.
   *
   * The response cannot say: `previousSecretRetiresAt` is null both for a
   * create, where no previous secret ever existed, and for a rotation with no
   * overlap, where one was cut off just now. Those are different facts and an
   * administrator needs the second one, so the caller states which happened.
   */
  kind: 'create' | 'rotate';
  onDismiss: () => void;
}) {
  const messages = getApiClientsMessages(locale);
  const [copied, setCopied] = useState(false);

  async function copy(): Promise<void> {
    try {
      await navigator.clipboard.writeText(reveal.clientSecret);
      setCopied(true);
    } catch {
      // Selecting it is the fallback; the value is on screen either way.
      setCopied(false);
    }
  }

  return (
    <aside
      className="pc-card pc-secret-panel"
      role="alert"
      aria-labelledby="api-client-secret-heading"
    >
      <h2 id="api-client-secret-heading" className="pc-card-title">
        {messages.secretTitle}
      </h2>
      <p>{messages.secretWarning}</p>

      <p>
        {messages.secretClientId}:{' '}
        {/* Forced left-to-right inside an Arabic page. A credential is an
            opaque Latin string, and the bidirectional algorithm would reorder
            its trailing characters around the surrounding Arabic — somebody
            copying it by eye would copy something that does not work. */}
        <code dir="ltr">{reveal.client.clientId}</code>
      </p>
      <code dir="ltr" className="pc-secret" data-testid="api-client-secret">
        {reveal.clientSecret}
      </code>

      <button type="button" className="secondary" onClick={() => void copy()}>
        {copied ? messages.secretCopied : messages.secretCopy}
      </button>

      {/* Only after a rotation. On a create there is no previous secret, and a
          line about one would describe something that never existed. */}
      {kind === 'rotate' ? (
        <p data-testid="api-client-previous-retires">
          {reveal.previousSecretRetiresAt === null
            ? messages.secretPreviousRetiredNow
            : `${messages.secretPreviousRetires} ${new Intl.DateTimeFormat(locale, {
                dateStyle: 'medium',
                timeStyle: 'short',
              }).format(new Date(reveal.previousSecretRetiresAt))}`}
        </p>
      ) : null}

      <button type="button" onClick={onDismiss}>
        {messages.secretDismiss}
      </button>
    </aside>
  );
}
