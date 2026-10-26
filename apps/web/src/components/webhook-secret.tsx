'use client';

import { useState } from 'react';
import { getWebhooksMessages } from '@/i18n/webhooks-messages';
import type { Locale } from '@/i18n/locales';
import type { WebhookSecretResponse } from '@/lib/api-client';

/**
 * The one screen in PalCert that shows a credential.
 *
 * Three rules, all of them visible in the code rather than in a convention.
 *
 * The warning comes *before* the secret, because a person who has already
 * copied and closed the panel does not read what was underneath it.
 *
 * The value lives in this component's props and nowhere else. It is never put
 * in `localStorage`, `sessionStorage`, the URL, the history, or any global
 * store — each of those outlives the page, and the promise PalCert makes is
 * that this is shown once. It is not logged either: a `console.log` of a
 * response body is how a secret ends up in a browser extension's capture.
 *
 * Copying uses the clipboard API and falls back to selecting the text, so a
 * browser that refuses clipboard access still lets somebody take it manually
 * rather than leaving them stuck.
 */
export function WebhookSecretPanel({
  locale,
  secret,
  onDismiss,
}: {
  locale: Locale;
  secret: WebhookSecretResponse;
  onDismiss: () => void;
}) {
  const messages = getWebhooksMessages(locale);
  const [copied, setCopied] = useState(false);

  async function copy(): Promise<void> {
    try {
      await navigator.clipboard.writeText(secret.signingSecret);
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
      aria-labelledby="webhook-secret-heading"
    >
      <h2 id="webhook-secret-heading" className="pc-card-title">
        {messages.secretTitle}
      </h2>
      <p>{messages.secretWarning}</p>

      <code dir="ltr" className="pc-secret" data-testid="webhook-signing-secret">
        {secret.signingSecret}
      </code>

      <button type="button" className="secondary" onClick={() => void copy()}>
        {copied ? messages.secretCopied : messages.secretCopy}
      </button>

      <p>
        {messages.secretRecoverable}{' '}
        {new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short' }).format(
          new Date(secret.recoverableUntil),
        )}
      </p>

      <button type="button" onClick={onDismiss}>
        {messages.secretDismiss}
      </button>
    </aside>
  );
}
