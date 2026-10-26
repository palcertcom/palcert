import {
  EMAIL_DELIVERY_CATEGORIES,
  EMAIL_DELIVERY_STATUSES,
  EMAIL_PROVIDER_KINDS,
  EmailSettingsWarning,
  OUTBOUND_EMAIL_FAILURES,
} from '@palcert/contracts/email';
import { describe, expect, it } from 'vitest';
import { EMAIL_MESSAGES } from './email-messages';

function flatten(value: unknown, prefix = ''): [string, string][] {
  if (typeof value === 'string') return [[prefix, value]];
  if (typeof value === 'function') return [[prefix, String((value as (a: string) => string)('X'))]];
  if (value !== null && typeof value === 'object') {
    return Object.entries(value).flatMap(([k, v]) => flatten(v, prefix ? `${prefix}.${k}` : k));
  }
  return [];
}

describe('email messages', () => {
  it('have the same keys in English and Arabic', () => {
    expect(flatten(EMAIL_MESSAGES.ar).map(([k]) => k)).toEqual(
      flatten(EMAIL_MESSAGES.en).map(([k]) => k),
    );
  });

  it('name every status, category, failure, provider and warning', () => {
    for (const locale of ['en', 'ar'] as const) {
      const m = EMAIL_MESSAGES[locale];
      for (const s of EMAIL_DELIVERY_STATUSES) expect(m.deliveries.statuses[s]).toBeTruthy();
      for (const c of EMAIL_DELIVERY_CATEGORIES) expect(m.deliveries.categories[c]).toBeTruthy();
      for (const f of OUTBOUND_EMAIL_FAILURES) expect(m.deliveries.failures[f]).toBeTruthy();
      for (const p of EMAIL_PROVIDER_KINDS) expect(m.settings.providers[p]).toBeTruthy();
      for (const w of Object.values(EmailSettingsWarning))
        expect(m.settings.warnings[w]).toBeTruthy();
    }
  });

  it('Arabic copy is written in Arabic', () => {
    const arabic = /[؀-ۿ]/;
    const english = flatten(EMAIL_MESSAGES.ar).filter(([, v]) => !arabic.test(v) && v !== 'Resend');
    expect(english).toEqual([]);
  });

  it('never claims a domain is verified', () => {
    for (const [, value] of flatten(EMAIL_MESSAGES.en)) {
      expect(value).not.toMatch(/domain (is|has been) verified/i);
    }
  });
});
