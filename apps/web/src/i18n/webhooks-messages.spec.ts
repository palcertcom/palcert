import { describe, expect, it } from 'vitest';
import { LOCALES } from './locales';
import { getWebhooksMessages, webhookLabel, type WebhooksMessages } from './webhooks-messages';

const ARABIC_SCRIPT = /[؀-ۿ]/;
const NESTED_MAPS = [
  'endpointStatuses',
  'deliveryStatuses',
  'configStatuses',
  'eventTypes',
  'errors',
] as const;

const EVENT_TYPES = [
  'submission.ready',
  'submission.revision_ready',
  'submission.under_review',
  'submission.approved',
  'submission.rejected',
  'submission.revision_requested',
  'submission.comment_added',
  'certificate.issued',
  'certificate.revoked',
];

/**
 * Material, not vocabulary.
 *
 * "Challenge" and "signature" are things the copy is allowed — and required —
 * to explain. What may never appear is a value: a `whsec_` secret, ciphertext,
 * an auth tag or an initialization vector. A catalogue is a static file, so a
 * match here means somebody pasted a real value into an example.
 */
const SECRET_SHAPED = /whsec_|ciphertext|auth[- ]?tag|initialization vector/i;

describe('Webhook message catalogue', () => {
  it('has every key in every locale', () => {
    const english = getWebhooksMessages('en');
    for (const locale of LOCALES) {
      const messages = getWebhooksMessages(locale);
      for (const key of Object.keys(english) as Array<keyof WebhooksMessages>) {
        expect(messages[key], `${locale}.${String(key)}`).toBeDefined();
      }
      for (const map of NESTED_MAPS) {
        expect(Object.keys(messages[map]).sort()).toEqual(Object.keys(english[map]).sort());
      }
    }
  });

  it('translates every string into Arabic rather than leaving English behind', () => {
    const arabic = getWebhooksMessages('ar');
    const skip = new Set(['columnHttp']);

    for (const [key, value] of Object.entries(arabic)) {
      if (typeof value === 'string') {
        if (skip.has(key)) continue;
        expect(ARABIC_SCRIPT.test(value), `ar.${key} is not translated`).toBe(true);
        continue;
      }
      for (const [nested, text] of Object.entries(value as Record<string, string>)) {
        expect(ARABIC_SCRIPT.test(text), `ar.${key}.${nested} is not translated`).toBe(true);
      }
    }
  });

  it('labels every public event type in both languages', () => {
    for (const locale of LOCALES) {
      const messages = getWebhooksMessages(locale);
      for (const eventType of EVENT_TYPES) {
        expect(messages.eventTypes[eventType], `${locale}.${eventType}`).toBeDefined();
      }
      // Exactly the nine. A tenth label would mean the UI is offering something
      // the API does not send.
      expect(Object.keys(messages.eventTypes).sort()).toEqual([...EVENT_TYPES].sort());
    }
  });

  it('never puts anything secret-shaped in a label', () => {
    for (const locale of LOCALES) {
      const messages = getWebhooksMessages(locale);
      const serialized = JSON.stringify(messages);
      expect(SECRET_SHAPED.test(serialized)).toBe(false);
    }
  });

  it('warns about the secret before it is shown, and says recovery is not a feature', () => {
    for (const locale of LOCALES) {
      const messages = getWebhooksMessages(locale);
      // The warning has to carry both halves: shown once, and rotation is the
      // only way back. A warning that says only the first leaves somebody
      // hunting for a "show it again" button that deliberately does not exist.
      expect(messages.secretWarning.length).toBeGreaterThan(40);
      expect(messages.secretGone.length).toBeGreaterThan(20);
    }
  });

  it('explains the rotation hazard rather than only naming it', () => {
    for (const locale of LOCALES) {
      const messages = getWebhooksMessages(locale);
      expect(messages.rotationWarningBody.length).toBeGreaterThan(80);
    }
  });

  it('falls back to the code when a label is missing', () => {
    expect(webhookLabel({}, 'SOMETHING_NEW')).toBe('SOMETHING_NEW');
  });
});
