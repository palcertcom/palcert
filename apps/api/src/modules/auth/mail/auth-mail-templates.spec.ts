import { MailTemplate, type MailMessage } from '../ports/mail.port';
import { AuthMailLinkRejectedError, renderAuthMail } from './auth-mail-templates';

const WEB = 'https://staging.palcert.test';
const TOKEN = 'tok_SECRET_value_123';

function msg(
  template: MailTemplate,
  locale: string,
  extra: Record<string, string> = {},
): MailMessage {
  return {
    to: 'person@example.org',
    locale,
    template,
    variables: {
      token: TOKEN,
      url: `${WEB}/${locale}/verify-email?token=${TOKEN}`,
      displayName: 'Lina',
      expiresAt: '2026-10-03T12:00:00.000Z',
      organizationName: 'Example University',
      roleCode: 'ORGANIZATION_REVIEWER',
      ...extra,
    },
  };
}

describe('renderAuthMail', () => {
  it.each([
    [MailTemplate.EMAIL_VERIFICATION, 'en', 'Verify your PalCert email address'],
    [MailTemplate.EMAIL_VERIFICATION, 'ar', 'تأكيد عنوان بريدك الإلكتروني في PalCert'],
    [MailTemplate.PASSWORD_RESET, 'en', 'Reset your PalCert password'],
    [MailTemplate.PASSWORD_RESET, 'ar', 'إعادة تعيين كلمة مرور PalCert'],
    [MailTemplate.ORGANIZATION_INVITATION, 'en', 'You have been invited to PalCert'],
    [MailTemplate.ORGANIZATION_INVITATION, 'ar', 'تمت دعوتك إلى PalCert'],
  ])(
    '%s/%s has the specified subject and the link from APP_PUBLIC_WEB_URL',
    (template, locale, subject) => {
      const out = renderAuthMail(msg(template, locale), WEB);
      expect(out.subject).toBe(subject);
      expect(out.text).toContain(`${WEB}/${locale}/verify-email?token=${TOKEN}`);
      expect(out.html).toContain(`dir="${locale === 'ar' ? 'rtl' : 'ltr'}"`);
      expect(out.html).toContain(`lang="${locale}"`);
      expect(out.html).not.toMatch(/<script|<img|<link|javascript:/i);
    },
  );

  it('renders the password-changed notice without any token', () => {
    const out = renderAuthMail(
      {
        to: 'p@example.org',
        locale: 'en',
        template: MailTemplate.PASSWORD_CHANGED,
        variables: { displayName: 'Lina' },
      },
      WEB,
    );
    expect(out.html).toContain(`${WEB}/en/login`);
    expect(out.text).not.toContain('token');
  });

  it('escapes every interpolated value', () => {
    const out = renderAuthMail(
      msg(MailTemplate.ORGANIZATION_INVITATION, 'en', {
        organizationName: '<script>alert(1)</script>',
        displayName: '"><img src=x>',
      }),
      WEB,
    );
    expect(out.html).not.toContain('<script>');
    expect(out.html).toContain('&lt;script&gt;');
  });

  it('refuses a link outside the public web origin', () => {
    expect(() =>
      renderAuthMail(
        msg(MailTemplate.PASSWORD_RESET, 'en', {
          url: `https://evil.example/reset?token=${TOKEN}`,
        }),
        WEB,
      ),
    ).toThrow(AuthMailLinkRejectedError);
    expect(() =>
      renderAuthMail(msg(MailTemplate.PASSWORD_RESET, 'en', { url: 'javascript:alert(1)' }), WEB),
    ).toThrow(AuthMailLinkRejectedError);
  });

  it('falls back to English for an unknown locale', () => {
    expect(renderAuthMail(msg(MailTemplate.PASSWORD_RESET, 'fr'), WEB).subject).toBe(
      'Reset your PalCert password',
    );
  });
});
