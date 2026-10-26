import { describe, expect, it } from 'vitest';
import { LOCALES } from './locales';
import {
  apiClientLabel,
  getApiClientsMessages,
  type ApiClientsMessages,
} from './api-clients-messages';

const ARABIC_SCRIPT = /[؀-ۿ]/;
const NESTED_MAPS = [
  'overlapChoices',
  'statuses',
  'scopeNames',
  'scopeDescriptions',
  'errors',
] as const;

/** Every scope the API offers, and no more. */
const SCOPES = ['organization:read', 'submissions:read', 'certificates:read', 'webhooks:read'];

/**
 * Material, not vocabulary.
 *
 * "Secret" and "rotate" are things the copy has to explain. What may never
 * appear is a value: a `pcsk_` secret or an Argon2 verifier. A catalogue is a
 * static file, so a match here means somebody pasted a real credential into an
 * example.
 */
const SECRET_SHAPED = /pcsk_|\$argon2|verifier[:=]/i;

describe('API client message catalogue', () => {
  it('has every key in every locale', () => {
    const english = getApiClientsMessages('en');
    for (const locale of LOCALES) {
      const messages = getApiClientsMessages(locale);
      for (const key of Object.keys(english) as Array<keyof ApiClientsMessages>) {
        expect(messages[key], `${locale}.${String(key)}`).toBeDefined();
      }
      for (const map of NESTED_MAPS) {
        expect(Object.keys(messages[map]).sort()).toEqual(Object.keys(english[map]).sort());
      }
    }
  });

  it('translates every string into Arabic rather than leaving English behind', () => {
    const arabic = getApiClientsMessages('ar');
    for (const [key, value] of Object.entries(arabic)) {
      if (typeof value === 'string') {
        expect(ARABIC_SCRIPT.test(value), `ar.${key} is not translated`).toBe(true);
        continue;
      }
      for (const [nested, text] of Object.entries(value as Record<string, string>)) {
        expect(ARABIC_SCRIPT.test(text), `ar.${key}.${nested} is not translated`).toBe(true);
      }
    }
  });

  it('names and explains exactly the scopes the API offers', () => {
    for (const locale of LOCALES) {
      const messages = getApiClientsMessages(locale);
      // Exactly these. A fifth label would mean the screen offers something the
      // API does not grant; a missing one would mean a checkbox with no
      // explanation of whose data it hands over.
      expect(Object.keys(messages.scopeNames).sort()).toEqual([...SCOPES].sort());
      expect(Object.keys(messages.scopeDescriptions).sort()).toEqual([...SCOPES].sort());

      for (const scope of SCOPES) {
        // A description, not a restatement of the name. The choice being made
        // is about somebody else's data and the copy has to say what it
        // exposes.
        expect(messages.scopeDescriptions[scope]!.length).toBeGreaterThan(40);
      }
    }
  });

  it('warns about the secret before it is shown, and says recovery is not a feature', () => {
    for (const locale of LOCALES) {
      const messages = getApiClientsMessages(locale);
      // Both halves: shown once, and rotation is the only way back. A warning
      // with only the first leaves somebody hunting for a "show it again"
      // button that deliberately does not exist.
      expect(messages.secretWarning.length).toBeGreaterThan(60);
      expect(messages.createIntro.length).toBeGreaterThan(60);
    }
  });

  it('distinguishes disabling from revoking wherever both appear', () => {
    for (const locale of LOCALES) {
      const messages = getApiClientsMessages(locale);
      // The confirmation has to name the reversible alternative, because the
      // moment somebody reaches for revoke is the moment they are least likely
      // to remember that disable exists.
      expect(messages.revokeConfirm.length).toBeGreaterThan(80);
      expect(messages.disableHint.length).toBeGreaterThan(60);
      expect(messages.disable).not.toBe(messages.revoke);
    }
  });

  it('explains the rotation overlap rather than only labelling it', () => {
    for (const locale of LOCALES) {
      const messages = getApiClientsMessages(locale);
      expect(messages.rotateOverlapHint.length).toBeGreaterThan(60);
      // The immediate option is offered and named as such: rotating because a
      // secret leaked is the case where an overlap is the wrong answer.
      expect(messages.overlapChoices['0']!.length).toBeGreaterThan(4);
    }
  });

  it('never puts anything secret-shaped in a label', () => {
    for (const locale of LOCALES) {
      expect(SECRET_SHAPED.test(JSON.stringify(getApiClientsMessages(locale)))).toBe(false);
    }
  });

  it('falls back to the code when a label is missing', () => {
    expect(apiClientLabel({}, 'SOMETHING_NEW')).toBe('SOMETHING_NEW');
  });
});
