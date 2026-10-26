import { describe, expect, it } from 'vitest';
import {
  EMAIL_DELIVERY_STATUSES,
  EmailDeliveryStatus,
  OUTBOUND_EMAIL_FAILURES,
  OutboundEmailFailure,
  addressMatchesDomain,
  apiKeyDisplayHint,
  emailStatusAdvances,
  isHeaderSafe,
  isPlausibleResendApiKey,
  isPlausibleWebhookSecret,
  isRetryableEmailFailure,
  isValidEmailAddress,
  isValidFromName,
  isValidSendingDomain,
  outboundFailureSummary,
  webhookSecretDisplayHint,
} from './email.js';
import { ALL_PERMISSIONS as PERMISSIONS, Permission } from '../auth/permissions.js';
import { ROLE_DEFINITIONS } from '../auth/roles.js';

describe('email address validation', () => {
  it.each(['no-reply@palcert.com', 'a.b+c@mail.palcert.com', 'X_Y@example.org'])(
    'accepts %s',
    (v) => expect(isValidEmailAddress(v)).toBe(true),
  );
  it.each([
    '',
    'no-reply',
    'a@b',
    'a..b@palcert.com',
    '"quoted"@palcert.com',
    'a b@palcert.com',
    'a@palcert.com\r\nBcc: x@evil.com',
    'a@palcert.com\nX',
    `${'a'.repeat(65)}@palcert.com`,
  ])('rejects %j', (v) => expect(isValidEmailAddress(v)).toBe(false));
});

describe('sending domain validation', () => {
  it('accepts lower-case dotted domains', () => {
    expect(isValidSendingDomain('palcert.com')).toBe(true);
    expect(isValidSendingDomain('mail.palcert.com')).toBe(true);
  });
  it.each([
    '',
    'PalCert.com',
    'palcert',
    '-x.com',
    'palcert.com.',
    'https://palcert.com',
    'a b.com',
  ])('rejects %j', (v) => expect(isValidSendingDomain(v)).toBe(false));
});

describe('header safety', () => {
  it('rejects CR, LF, NUL, tab, quotes and angle brackets', () => {
    for (const bad of [
      'a\rb',
      'a\nb',
      'a\u0000b',
      'a\tb',
      'a"b',
      'a<b',
      'a>b',
      'a\\b',
      'a\u007fb',
    ]) {
      expect(isHeaderSafe(bad)).toBe(false);
    }
    expect(isHeaderSafe('PalCert')).toBe(true);
    expect(isHeaderSafe('بال سيرت')).toBe(true);
  });
  it('limits the display name', () => {
    expect(isValidFromName('PalCert')).toBe(true);
    expect(isValidFromName('  ')).toBe(false);
    expect(isValidFromName('x'.repeat(101))).toBe(false);
    expect(isValidFromName('PalCert\r\nBcc: x')).toBe(false);
  });
});

describe('sender domain alignment', () => {
  it('matches the domain and its subdomains only', () => {
    expect(addressMatchesDomain('no-reply@palcert.com', 'palcert.com')).toBe(true);
    expect(addressMatchesDomain('no-reply@mail.palcert.com', 'palcert.com')).toBe(true);
    expect(addressMatchesDomain('no-reply@notpalcert.com', 'palcert.com')).toBe(false);
    expect(addressMatchesDomain('no-reply@gmail.com', 'palcert.com')).toBe(false);
  });
});

describe('credential shapes and hints', () => {
  it('recognises plausible Resend keys and webhook secrets', () => {
    expect(isPlausibleResendApiKey('re_TESTONLY_abcdefgh123')).toBe(true);
    expect(isPlausibleResendApiKey('whsec_abc')).toBe(false);
    expect(isPlausibleResendApiKey('re_short')).toBe(false);
    expect(isPlausibleResendApiKey('"re_abcdefghijk"')).toBe(false);
    expect(isPlausibleWebhookSecret('whsec_dGVzdC1vbmx5LXNlY3JldC0xMjM0NQ==')).toBe(true);
    expect(isPlausibleWebhookSecret('re_abcdefghijkl')).toBe(false);
  });
  it('display hints reveal only the prefix and last three characters', () => {
    const key = 're_TESTONLY_abcdefgh7XQ';
    const hint = apiKeyDisplayHint(key);
    expect(hint).toBe('re_••••••••7XQ');
    expect(hint).not.toContain('TESTONLY');
    expect(webhookSecretDisplayHint('whsec_dGVzdC1vbmx5LXNlY3JldA==')).toBe('whsec_••••••••A==');
  });
});

describe('delivery status precedence', () => {
  it('never moves backwards and never leaves SKIPPED', () => {
    expect(emailStatusAdvances(EmailDeliveryStatus.ACCEPTED, EmailDeliveryStatus.DELIVERED)).toBe(
      true,
    );
    expect(emailStatusAdvances(EmailDeliveryStatus.DELIVERED, EmailDeliveryStatus.ACCEPTED)).toBe(
      false,
    );
    expect(emailStatusAdvances(EmailDeliveryStatus.BOUNCED, EmailDeliveryStatus.DELIVERED)).toBe(
      false,
    );
    expect(emailStatusAdvances(EmailDeliveryStatus.DELIVERED, EmailDeliveryStatus.COMPLAINED)).toBe(
      true,
    );
    expect(emailStatusAdvances(EmailDeliveryStatus.DELIVERED, EmailDeliveryStatus.DELIVERED)).toBe(
      false,
    );
    for (const s of EMAIL_DELIVERY_STATUSES) {
      expect(emailStatusAdvances(EmailDeliveryStatus.SKIPPED, s)).toBe(false);
    }
  });
});

describe('failure categories', () => {
  it('only transient categories are retryable', () => {
    expect(OUTBOUND_EMAIL_FAILURES.filter(isRetryableEmailFailure).sort()).toEqual(
      ['PROVIDER_UNAVAILABLE', 'RATE_LIMITED', 'UNKNOWN'].sort(),
    );
  });
  it('every category has a fixed, data-free summary', () => {
    const summaries = OUTBOUND_EMAIL_FAILURES.map(outboundFailureSummary);
    expect(new Set(summaries).size).toBe(OUTBOUND_EMAIL_FAILURES.length);
    expect(outboundFailureSummary(OutboundEmailFailure.AUTHENTICATION_REJECTED)).not.toMatch(/re_/);
  });
});

describe('email permissions', () => {
  const grants = (role: string) =>
    new Set(ROLE_DEFINITIONS.find((r) => r.code === role)?.permissions ?? []);

  it('are registered', () => {
    for (const p of [
      Permission.ADMIN_EMAIL_SETTINGS_READ,
      Permission.ADMIN_EMAIL_SETTINGS_MANAGE,
      Permission.ADMIN_EMAIL_SETTINGS_TEST,
      Permission.ADMIN_EMAIL_DELIVERY_READ,
    ]) {
      expect(PERMISSIONS).toContain(p);
    }
  });
  it('platform admin holds all four, auditor reads only, finance nothing', () => {
    const admin = grants('PALCERT_ADMIN');
    expect(admin.has(Permission.ADMIN_EMAIL_SETTINGS_MANAGE)).toBe(true);
    expect(admin.has(Permission.ADMIN_EMAIL_SETTINGS_TEST)).toBe(true);
    const auditor = grants('PALCERT_AUDITOR');
    expect(auditor.has(Permission.ADMIN_EMAIL_SETTINGS_READ)).toBe(true);
    expect(auditor.has(Permission.ADMIN_EMAIL_DELIVERY_READ)).toBe(true);
    expect(auditor.has(Permission.ADMIN_EMAIL_SETTINGS_MANAGE)).toBe(false);
    expect(auditor.has(Permission.ADMIN_EMAIL_SETTINGS_TEST)).toBe(false);
    for (const role of ROLE_DEFINITIONS) {
      if (role.code === 'PALCERT_ADMIN' || role.code === 'PALCERT_AUDITOR') continue;
      const held = new Set(role.permissions);
      expect([...held].filter((p) => p.startsWith('admin:email'))).toEqual([]);
    }
  });
});
