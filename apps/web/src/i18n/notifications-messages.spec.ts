import { describe, expect, it } from 'vitest';
import { DEFAULT_LOCALE, LOCALES } from './locales';
import {
  NOTIFICATIONS_MESSAGES,
  getNotificationsMessages,
  type NotificationsMessages,
} from './notifications-messages';

const ARABIC_SCRIPT = /[؀-ۿ]/;

const NESTED_MAPS = ['types', 'errors'] as const;

/** The nine types Phase 16 recognises. Kept in step with the API vocabulary. */
const NOTIFICATION_TYPES = [
  'SUBMISSION_READY',
  'SUBMISSION_REVISION_READY',
  'SUBMISSION_UNDER_REVIEW',
  'SUBMISSION_APPROVED',
  'SUBMISSION_REJECTED',
  'SUBMISSION_REVISION_REQUESTED',
  'SUBMISSION_COMMENT_ADDED',
  'CERTIFICATE_ISSUED',
  'CERTIFICATE_REVOKED',
  // Manual top-ups: labelled because each names who acted (PalCert finance).
  'MANUAL_TOPUP_SUBMITTED',
  'MANUAL_TOPUP_APPROVED',
  'MANUAL_TOPUP_REJECTED',
];

/** PalCert's plumbing, which nobody reading their inbox should meet. */
const INTERNAL_TERMS =
  /\bRLS\b|\brow[- ]level security\b|\bSECURITY DEFINER\b|\bs3\b|\bbucket\b|\bobject key\b|\bidempoten|\bprisma\b|\bsigned url\b|\boutbox\b|\bSMTP\b|\bfan[- ]?out\b|\bqueue\b|\bwebhook\b/i;

/**
 * The governing rule of the phase, as a wording rule.
 *
 * A notification reports an authoritative event; it is never the authority.
 * Copy that said "your submission is approved" would read as this page being
 * the source of that fact, which is exactly the inversion the architecture
 * exists to prevent. Every label names who did it.
 */
const UNATTRIBUTED_CLAIM = /^(your submission is|this submission is|approved|rejected)\b/i;

describe('Notification message catalogue', () => {
  it('defines every key in every locale', () => {
    const reference = Object.keys(NOTIFICATIONS_MESSAGES[DEFAULT_LOCALE]).sort();
    for (const locale of LOCALES) {
      expect([locale, Object.keys(NOTIFICATIONS_MESSAGES[locale]).sort()]).toEqual([
        locale,
        reference,
      ]);
    }
  });

  it('defines every nested label in every locale', () => {
    for (const map of NESTED_MAPS) {
      const reference = Object.keys(NOTIFICATIONS_MESSAGES[DEFAULT_LOCALE][map]).sort();
      for (const locale of LOCALES) {
        expect([locale, map, Object.keys(NOTIFICATIONS_MESSAGES[locale][map]).sort()]).toEqual([
          locale,
          map,
          reference,
        ]);
      }
    }
  });

  it('labels every Phase 16 and manual top-up notification type', () => {
    for (const locale of LOCALES) {
      expect([locale, Object.keys(NOTIFICATIONS_MESSAGES[locale].types).sort()]).toEqual([
        locale,
        [...NOTIFICATION_TYPES].sort(),
      ]);
    }
  });

  it('writes Arabic in Arabic', () => {
    const ar = NOTIFICATIONS_MESSAGES.ar;
    for (const [key, value] of Object.entries(ar)) {
      if (typeof value === 'string') {
        expect([key, ARABIC_SCRIPT.test(value)]).toEqual([key, true]);
        continue;
      }
      for (const [nested, text] of Object.entries(value as Record<string, string>)) {
        expect([key, nested, ARABIC_SCRIPT.test(text)]).toEqual([key, nested, true]);
      }
    }
  });

  it('names who acted, rather than stating the outcome as its own authority', () => {
    for (const locale of LOCALES) {
      for (const [type, label] of Object.entries(NOTIFICATIONS_MESSAGES[locale].types)) {
        expect([locale, type, UNATTRIBUTED_CLAIM.test(label)]).toEqual([locale, type, false]);
      }
    }
  });

  it('explains the one switch a person does not get', () => {
    for (const locale of LOCALES) {
      const messages = NOTIFICATIONS_MESSAGES[locale];
      // A disabled control with no explanation reads as a bug rather than a
      // decision, so the reason is part of the catalogue and not optional.
      expect([locale, messages.mandatoryNote.length > 40]).toEqual([locale, true]);
      expect([locale, messages.alwaysOn.length > 0]).toEqual([locale, true]);
      // And that turning email off is not turning the notification off.
      expect([locale, messages.inAppNote.length > 0]).toEqual([locale, true]);
    }
  });

  it('never shows a reader PalCert’s plumbing', () => {
    for (const locale of LOCALES) {
      for (const [key, value] of Object.entries(NOTIFICATIONS_MESSAGES[locale])) {
        const texts = typeof value === 'string' ? [value] : Object.values(value as object);
        for (const text of texts) {
          expect([locale, key, INTERNAL_TERMS.test(String(text))]).toEqual([locale, key, false]);
        }
      }
    }
  });

  it('falls back to the default locale rather than returning nothing', () => {
    const messages: NotificationsMessages = getNotificationsMessages(
      'fr' as unknown as (typeof LOCALES)[number],
    );
    expect(messages.title).toBe(NOTIFICATIONS_MESSAGES[DEFAULT_LOCALE].title);
  });
});
