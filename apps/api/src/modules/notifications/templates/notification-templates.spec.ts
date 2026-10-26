import {
  NOTIFICATION_AUDIENCE,
  NOTIFICATION_TYPES,
  NotificationAudience,
  NotificationType,
  isManualTopUpNotificationType,
  isWithdrawalNotificationType,
  type NotificationType as NotificationTypeValue,
} from '@palcert/contracts';
import {
  NOTIFICATION_LOCALES,
  NOTIFICATION_TEMPLATE_VERSION,
  notificationDeepLink,
  renderNotification,
  resolveNotificationLocale,
  type ManualTopUpNotificationFacts,
  type WithdrawalNotificationFacts,
} from './notification-templates';

const ORIGIN = 'https://app.palcert.test';
const SUBMISSION_ID = '11111111-1111-4111-8111-111111111111';
const CERTIFICATE_ID = '22222222-2222-4222-8222-222222222222';
const ORGANIZATION_ID = '33333333-3333-4333-8333-333333333333';
const TOPUP_ID = '44444444-4444-4444-8444-444444444444';
const WITHDRAWAL_ID = '55555555-5555-4555-8555-555555555555';

const FACTS: ManualTopUpNotificationFacts = {
  amountMinor: 15000n,
  currency: 'ILS',
  methodNameEn: 'Jawwal Pay',
  methodNameAr: 'جوال باي',
  reference: 'TX-2026-0001',
  rejectionReason: null,
  submittedAt: new Date('2026-10-03T14:05:30.000Z'),
};

const WITHDRAWAL_FACTS: WithdrawalNotificationFacts = {
  requestId: WITHDRAWAL_ID,
  scope: 'ORGANIZATION',
  amountMinor: 50000n,
  currency: 'USD',
  beneficiaryName: 'Birzeit Institute',
  organizationId: ORGANIZATION_ID,
  organizationName: 'Birzeit Institute',
  requesterName: 'Lina Haddad',
  requesterEmail: 'lina@example.test',
  rejectionReason: null,
  submittedAt: new Date('2026-10-03T14:05:30.000Z'),
};

/** Render any type; the manual top-up and withdrawal types get the typed facts they require. */
function render(type: NotificationTypeValue, locale: string, deepLink: string) {
  return renderNotification({
    type,
    locale,
    deepLink,
    appOrigin: ORIGIN,
    ...(isManualTopUpNotificationType(type) ? { manualTopUp: FACTS } : {}),
    ...(isWithdrawalNotificationType(type) ? { withdrawal: WITHDRAWAL_FACTS } : {}),
  });
}

/** The fixed sentence, without a facts list the two closed exceptions append. */
function fixedPart(text: string): string {
  return text.split('\n\n')[0] ?? text;
}

describe('notification templates', () => {
  it('renders every type in every locale', () => {
    for (const locale of NOTIFICATION_LOCALES) {
      for (const type of NOTIFICATION_TYPES) {
        const rendered = render(type, locale, '/en/x');
        expect(rendered.title.length).toBeGreaterThan(0);
        expect(rendered.body.length).toBeGreaterThan(0);
        expect(rendered.locale).toBe(locale);
        expect(rendered.templateVersion).toBe(NOTIFICATION_TEMPLATE_VERSION);
        // The in-app title and the email subject are one string, so wording
        // cannot drift between the two surfaces.
        expect(rendered.subject).toBe(rendered.title);
      }
    }
  });

  it('gives each type distinct copy, so a reader can tell what happened', () => {
    for (const locale of NOTIFICATION_LOCALES) {
      const titles = NOTIFICATION_TYPES.map((type) => render(type, locale, '/en/x').title);
      expect(new Set(titles).size).toBe(NOTIFICATION_TYPES.length);
    }
  });

  it('falls back to English rather than failing on an unrenderable locale', () => {
    // preferred_locale is a free TEXT column that predates this phase. A
    // notification is not the place to discover that.
    for (const value of ['fr', '', '  ', 'en-GB', 'ar-PS', null, undefined]) {
      expect([value, resolveNotificationLocale(value)]).toEqual([value, 'en']);
    }
    expect(resolveNotificationLocale('AR')).toBe('ar');
    expect(resolveNotificationLocale(' ar ')).toBe('ar');
  });

  it('is deterministic — the same inputs produce the same bytes', () => {
    const once = renderNotification({
      type: NotificationType.CERTIFICATE_REVOKED,
      locale: 'ar',
      deepLink: `/ar/certificates/${CERTIFICATE_ID}`,
      appOrigin: ORIGIN,
    });
    const twice = renderNotification({
      type: NotificationType.CERTIFICATE_REVOKED,
      locale: 'ar',
      deepLink: `/ar/certificates/${CERTIFICATE_ID}`,
      appOrigin: ORIGIN,
    });
    expect(twice).toEqual(once);
  });

  it('marks Arabic as right-to-left in the email markup', () => {
    const ar = renderNotification({
      type: NotificationType.SUBMISSION_APPROVED,
      locale: 'ar',
      deepLink: '/ar/submissions/x',
      appOrigin: ORIGIN,
    });
    expect(ar.html).toContain('dir="rtl"');
    expect(ar.html).toContain('lang="ar"');

    const en = renderNotification({
      type: NotificationType.SUBMISSION_APPROVED,
      locale: 'en',
      deepLink: '/en/submissions/x',
      appOrigin: ORIGIN,
    });
    expect(en.html).toContain('dir="ltr"');
  });

  it('never collapses the origin and the route into a protocol-relative link', () => {
    const rendered = renderNotification({
      type: NotificationType.SUBMISSION_APPROVED,
      locale: 'en',
      deepLink: '/en/submissions/x',
      appOrigin: 'https://app.palcert.test///',
    });
    expect(rendered.text).toContain('https://app.palcert.test/en/submissions/x');
    expect(rendered.html).not.toContain('//en/submissions');
  });

  it('escapes the link it puts in an href', () => {
    const rendered = renderNotification({
      type: NotificationType.SUBMISSION_APPROVED,
      locale: 'en',
      deepLink: '/en/submissions/x',
      appOrigin: 'https://app.palcert.test/"><script>alert(1)</script>',
    });
    expect(rendered.html).not.toContain('<script>');
    expect(rendered.html).toContain('&lt;script&gt;');
  });

  it('carries no identifier, name, filename or code in the copy itself', () => {
    // §11, restated where it can fail: the reader is told that something
    // happened and given a link. The substance requires signing in.
    for (const locale of NOTIFICATION_LOCALES) {
      for (const type of NOTIFICATION_TYPES) {
        const { title, body } = render(type, locale, `/en/submissions/${SUBMISSION_ID}`);
        // The facts list is the closed, typed exception and is tested below.
        for (const text of [title, fixedPart(body)]) {
          expect(text).not.toContain(SUBMISSION_ID);
          expect(text).not.toContain(CERTIFICATE_ID);
          expect(text).not.toContain(ORGANIZATION_ID);
          expect(text).not.toMatch(/@/);
          expect(text).not.toMatch(/\.docx|\.pdf/i);
        }
      }
    }
  });
});

describe('notification deep links', () => {
  it('sends each audience to the page it is actually authorized for', () => {
    expect(
      notificationDeepLink({
        audience: NotificationAudience.ORGANIZATION_REVIEWERS,
        locale: 'en',
        organizationId: ORGANIZATION_ID,
        submissionId: SUBMISSION_ID,
      }),
    ).toBe(`/en/organizations/${ORGANIZATION_ID}/submissions/${SUBMISSION_ID}`);

    expect(
      notificationDeepLink({
        audience: NotificationAudience.SUBMISSION_OWNER,
        locale: 'ar',
        organizationId: ORGANIZATION_ID,
        submissionId: SUBMISSION_ID,
      }),
    ).toBe(`/ar/submissions/${SUBMISSION_ID}`);

    expect(
      notificationDeepLink({
        audience: NotificationAudience.CERTIFICATE_OWNER,
        locale: 'en',
        organizationId: ORGANIZATION_ID,
        certificateId: CERTIFICATE_ID,
      }),
    ).toBe(`/en/certificates/${CERTIFICATE_ID}`);

    // An attestation opens the owner's request, or the institution's copy of it.
    expect(
      notificationDeepLink({
        audience: NotificationAudience.ATTESTATION_OWNER,
        locale: 'ar',
        organizationId: ORGANIZATION_ID,
        attestationRequestId: SUBMISSION_ID,
      }),
    ).toBe(`/ar/attestations/${SUBMISSION_ID}`);
    expect(
      notificationDeepLink({
        audience: NotificationAudience.ATTESTATION_REVIEWERS,
        locale: 'en',
        organizationId: ORGANIZATION_ID,
        attestationRequestId: SUBMISSION_ID,
      }),
    ).toBe(`/en/organizations/${ORGANIZATION_ID}/attestations/${SUBMISSION_ID}`);
  });

  it('produces a link the database will accept for every notification type', () => {
    // The stored column has a CHECK that refuses anything but a relative
    // application route, so a link this builder produces must satisfy it or
    // the whole fan-out fails at insert time.
    const acceptedByDatabase = /^\/[A-Za-z0-9/_-]*$/;

    for (const locale of NOTIFICATION_LOCALES) {
      for (const type of NOTIFICATION_TYPES) {
        const link = notificationDeepLink({
          audience: NOTIFICATION_AUDIENCE[type],
          locale,
          organizationId: ORGANIZATION_ID,
          submissionId: SUBMISSION_ID,
          certificateId: CERTIFICATE_ID,
          attestationRequestId: SUBMISSION_ID,
          manualTopUpRequestId: TOPUP_ID,
          withdrawal: {
            requestId: WITHDRAWAL_ID,
            scope: 'ORGANIZATION',
            organizationId: ORGANIZATION_ID,
          },
        });
        expect([type, link, acceptedByDatabase.test(link)]).toEqual([type, link, true]);
      }
    }
  });

  it('refuses to invent an identifier it was not given', () => {
    expect(() =>
      notificationDeepLink({
        audience: NotificationAudience.SUBMISSION_OWNER,
        locale: 'en',
        organizationId: ORGANIZATION_ID,
      }),
    ).toThrow(/submission id/);

    expect(() =>
      notificationDeepLink({
        audience: NotificationAudience.CERTIFICATE_OWNER,
        locale: 'en',
        organizationId: ORGANIZATION_ID,
      }),
    ).toThrow(/certificate id/);

    expect(() =>
      notificationDeepLink({
        audience: NotificationAudience.ATTESTATION_OWNER,
        locale: 'en',
        organizationId: ORGANIZATION_ID,
      }),
    ).toThrow(/request id/);
  });

  it('sends a manual top-up to the person’s own request or to the finance queue, never to an organization', () => {
    expect(
      notificationDeepLink({
        audience: NotificationAudience.MANUAL_TOPUP_OWNER,
        locale: 'ar',
        organizationId: null,
        manualTopUpRequestId: TOPUP_ID,
      }),
    ).toBe(`/ar/balance/top-ups/${TOPUP_ID}`);
    expect(
      notificationDeepLink({
        audience: NotificationAudience.PLATFORM_FINANCE_REVIEWERS,
        locale: 'en',
        organizationId: null,
        manualTopUpRequestId: TOPUP_ID,
      }),
    ).toBe(`/en/admin/top-ups/${TOPUP_ID}`);
    expect(() =>
      notificationDeepLink({
        audience: NotificationAudience.MANUAL_TOPUP_OWNER,
        locale: 'en',
        organizationId: null,
      }),
    ).toThrow(/request id/);
  });

  it('still requires an organization for every organization-scoped audience', () => {
    expect(() =>
      notificationDeepLink({
        audience: NotificationAudience.ORGANIZATION_REVIEWERS,
        locale: 'en',
        organizationId: null,
        submissionId: SUBMISSION_ID,
      }),
    ).toThrow(/organization/);
  });
});

describe('manual top-up notification facts', () => {
  it('names the amount, method and reference, exactly and per locale', () => {
    const en = render(
      NotificationType.MANUAL_TOPUP_APPROVED,
      'en',
      `/en/balance/top-ups/${TOPUP_ID}`,
    );
    expect(en.body).toContain('Amount: 150.00 ILS');
    expect(en.body).toContain('Payment method: Jawwal Pay');
    expect(en.body).toContain('Reference: TX-2026-0001');
    expect(en.text).toContain('Amount: 150.00 ILS');
    expect(en.html).toContain('<li>Amount: 150.00 ILS</li>');

    const ar = render(
      NotificationType.MANUAL_TOPUP_APPROVED,
      'ar',
      `/ar/balance/top-ups/${TOPUP_ID}`,
    );
    expect(ar.body).toContain('المبلغ: 150.00 ILS');
    expect(ar.body).toContain('طريقة الدفع: جوال باي');
  });

  it('states when it was submitted, in UTC, and never attaches or names the receipt', () => {
    const en = render(
      NotificationType.MANUAL_TOPUP_SUBMITTED,
      'en',
      `/en/admin/top-ups/${TOPUP_ID}`,
    );
    expect(en.body).toContain('Submitted: 2026-10-03 14:05 UTC');
    expect(en.html).toContain(`/en/admin/top-ups/${TOPUP_ID}`);
    expect(`${en.text} ${en.html}`).not.toMatch(/receipt|إيصال/i);
    const ar = render(
      NotificationType.MANUAL_TOPUP_SUBMITTED,
      'ar',
      `/ar/admin/top-ups/${TOPUP_ID}`,
    );
    expect(ar.body).toContain('وقت الإرسال: 2026-10-03 14:05 UTC');
    // A draft has no submitted time, and then the line is simply absent.
    const draft = renderNotification({
      type: NotificationType.MANUAL_TOPUP_SUBMITTED,
      locale: 'en',
      deepLink: `/en/admin/top-ups/${TOPUP_ID}`,
      appOrigin: ORIGIN,
      manualTopUp: { ...FACTS, submittedAt: null },
    });
    expect(draft.body).not.toContain('Submitted:');
  });

  it('states a rejection reason as a fixed sentence, never as free text', () => {
    const rendered = renderNotification({
      type: NotificationType.MANUAL_TOPUP_REJECTED,
      locale: 'en',
      deepLink: `/en/balance/top-ups/${TOPUP_ID}`,
      appOrigin: ORIGIN,
      manualTopUp: { ...FACTS, rejectionReason: 'AMOUNT_MISMATCH' },
    });
    expect(rendered.body).toContain(
      'Reason: The amount received does not match the amount reported.',
    );
  });

  it('escapes the values a person typed before they reach markup', () => {
    const rendered = renderNotification({
      type: NotificationType.MANUAL_TOPUP_SUBMITTED,
      locale: 'en',
      deepLink: `/en/admin/top-ups/${TOPUP_ID}`,
      appOrigin: ORIGIN,
      manualTopUp: { ...FACTS, methodNameEn: '<b>Bank</b>', reference: '"><img src=x>' },
    });
    expect(rendered.html).not.toContain('<b>Bank</b>');
    expect(rendered.html).not.toContain('<img');
    expect(rendered.html).toContain('&lt;b&gt;Bank&lt;/b&gt;');
  });

  it('is required for the top-up types and refused for every other type', () => {
    expect(() =>
      renderNotification({
        type: NotificationType.MANUAL_TOPUP_APPROVED,
        locale: 'en',
        deepLink: '/en/x',
        appOrigin: ORIGIN,
      }),
    ).toThrow(/needs its top-up facts/);
    expect(() =>
      renderNotification({
        type: NotificationType.SUBMISSION_APPROVED,
        locale: 'en',
        deepLink: '/en/x',
        appOrigin: ORIGIN,
        manualTopUp: FACTS,
      }),
    ).toThrow(/takes no top-up facts/);
  });

  it('leaves every organization-scoped type byte-for-byte as it was', () => {
    // The facts list exists only for top-ups; nothing else gains markup.
    for (const type of NOTIFICATION_TYPES.filter(
      (t) => !isManualTopUpNotificationType(t) && !isWithdrawalNotificationType(t),
    )) {
      const rendered = render(type, 'en', '/en/x');
      expect(rendered.html).not.toContain('<ul>');
      expect(rendered.body).not.toContain('\n');
    }
  });
});

describe('withdrawal notifications (ADR-0150)', () => {
  it('puts the amount in the subject and the safe facts in the body', () => {
    const en = render(
      NotificationType.WITHDRAWAL_PENDING_REVIEW,
      'en',
      `/en/admin/withdrawals/${WITHDRAWAL_ID}`,
    );
    expect(en.subject).toBe('Withdrawal request: 500.00 USD');
    expect(en.body).toContain('Request reference: W-55555555');
    expect(en.body).toContain('Scope: Organization earnings — Birzeit Institute');
    expect(en.body).toContain('Requester: Lina Haddad <lina@example.test>');
    expect(en.body).toContain('Beneficiary: Birzeit Institute');
    expect(en.body).toContain('Amount: 500.00 USD');
    expect(en.body).toContain('Submitted: 2026-10-03 14:05 UTC');
    expect(en.html).toContain('Review in PalCert');
    expect(en.html).toContain('&lt;lina@example.test&gt;');

    const ar = render(
      NotificationType.WITHDRAWAL_PENDING_REVIEW,
      'ar',
      `/ar/admin/withdrawals/${WITHDRAWAL_ID}`,
    );
    expect(ar.subject).toBe('طلب سحب الأموال: 500.00 USD');
    expect(ar.body).toContain('المستفيد: Birzeit Institute');
    expect(ar.html).toContain('dir="rtl"');
  });

  it('tells the requester about themselves without repeating their own address', () => {
    for (const type of [
      NotificationType.WITHDRAWAL_SUBMITTED,
      NotificationType.WITHDRAWAL_APPROVED,
      NotificationType.WITHDRAWAL_PAID,
      NotificationType.WITHDRAWAL_FAILED,
    ]) {
      const rendered = render(type, 'en', `/en/balance/withdrawals/${WITHDRAWAL_ID}`);
      expect(rendered.body).not.toContain('lina@example.test');
      expect(rendered.body).toContain('Amount: 500.00 USD');
    }
    const paid = render(NotificationType.WITHDRAWAL_PAID, 'ar', '/ar/x');
    expect(paid.title).toBe('تم تحويل أموالك: 500.00 USD');
  });

  it('states a rejection reason as a fixed sentence', () => {
    const rendered = renderNotification({
      type: NotificationType.WITHDRAWAL_REJECTED,
      locale: 'en',
      deepLink: '/en/x',
      appOrigin: ORIGIN,
      withdrawal: { ...WITHDRAWAL_FACTS, rejectionReason: 'BENEFICIARY_MISMATCH' },
    });
    expect(rendered.body).toContain('Reason: The beneficiary does not match the account holder.');
  });

  it('never carries a destination identifier or a proof', () => {
    for (const locale of NOTIFICATION_LOCALES) {
      for (const type of NOTIFICATION_TYPES.filter(isWithdrawalNotificationType)) {
        const { text, html } = render(type, locale, '/en/x');
        for (const output of [text, html]) {
          expect(output).not.toMatch(/IBAN|PS\d{2}|••••|proof|attachment/i);
        }
      }
    }
  });

  it('escapes the names a person typed', () => {
    const rendered = renderNotification({
      type: NotificationType.WITHDRAWAL_PENDING_REVIEW,
      locale: 'en',
      deepLink: '/en/x',
      appOrigin: ORIGIN,
      withdrawal: { ...WITHDRAWAL_FACTS, beneficiaryName: '<img src=x>' },
    });
    expect(rendered.html).not.toContain('<img');
  });

  it('is required for the withdrawal types and refused for every other type', () => {
    expect(() =>
      renderNotification({
        type: NotificationType.WITHDRAWAL_PAID,
        locale: 'en',
        deepLink: '/en/x',
        appOrigin: ORIGIN,
      }),
    ).toThrow(/needs its withdrawal facts/);
    expect(() =>
      renderNotification({
        type: NotificationType.MANUAL_TOPUP_APPROVED,
        locale: 'en',
        deepLink: '/en/x',
        appOrigin: ORIGIN,
        manualTopUp: FACTS,
        withdrawal: WITHDRAWAL_FACTS,
      }),
    ).toThrow(/takes no withdrawal facts/);
  });

  it('links each scope to the page its owner can open, and finance to the queue', () => {
    const link = (audience: NotificationAudience, scope: 'USER' | 'ORGANIZATION' | 'PLATFORM') =>
      notificationDeepLink({
        audience,
        locale: 'en',
        organizationId: null,
        withdrawal: {
          requestId: WITHDRAWAL_ID,
          scope,
          organizationId: scope === 'ORGANIZATION' ? ORGANIZATION_ID : null,
        },
      });
    expect(link(NotificationAudience.WITHDRAWAL_OWNER, 'USER')).toBe(
      `/en/balance/withdrawals/${WITHDRAWAL_ID}`,
    );
    expect(link(NotificationAudience.WITHDRAWAL_OWNER, 'ORGANIZATION')).toBe(
      `/en/organizations/${ORGANIZATION_ID}/payouts/${WITHDRAWAL_ID}`,
    );
    expect(link(NotificationAudience.WITHDRAWAL_OWNER, 'PLATFORM')).toBe(
      `/en/admin/withdrawals/${WITHDRAWAL_ID}`,
    );
    expect(link(NotificationAudience.WITHDRAWAL_FINANCE_REVIEWERS, 'USER')).toBe(
      `/en/admin/withdrawals/${WITHDRAWAL_ID}`,
    );
    expect(() =>
      notificationDeepLink({
        audience: NotificationAudience.WITHDRAWAL_OWNER,
        locale: 'en',
        organizationId: null,
      }),
    ).toThrow(/withdrawal/);
  });
});
