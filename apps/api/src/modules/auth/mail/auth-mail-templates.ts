import {
  renderEmailLayout,
  resolveEmailLocale,
  type EmailLocale,
  type RenderedEmail,
} from '../../../infrastructure/email/email-layout';
import { MailTemplate, type MailMessage } from '../ports/mail.port';

/**
 * Authentication mail, EN and AR (ADR-0146).
 *
 * These are the only templates in PalCert that carry a credential: the
 * verification, reset and invitation links. The rendered message exists in
 * memory for one send and is never stored, logged or recorded in delivery
 * history — `email_deliveries` has no column it could go in.
 *
 * Links are never built here. They arrive from the auth services, which build
 * them from `APP_PUBLIC_WEB_URL`; this module refuses any link that does not
 * start with that origin, so a bug elsewhere cannot turn a PalCert email into
 * a link to somewhere else.
 */
export class AuthMailLinkRejectedError extends Error {
  constructor() {
    super('authentication mail link does not belong to the public web origin');
    this.name = 'AuthMailLinkRejectedError';
  }
}

const ROLE_NAMES: Readonly<Record<EmailLocale, Readonly<Record<string, string>>>> = {
  en: {
    ORGANIZATION_OWNER: 'Owner',
    ORGANIZATION_ADMIN: 'Administrator',
    ORGANIZATION_REVIEWER: 'Reviewer',
    TEMPLATE_MANAGER: 'Template manager',
  },
  ar: {
    ORGANIZATION_OWNER: 'مالك',
    ORGANIZATION_ADMIN: 'مسؤول',
    ORGANIZATION_REVIEWER: 'مراجع',
    TEMPLATE_MANAGER: 'مدير القوالب',
  },
};

const FOOTER: Readonly<Record<EmailLocale, string>> = {
  en: 'You received this email because of activity on your PalCert account. If this was not you, you can ignore this message. PalCert will never ask for your password by email.',
  ar: 'وصلتك هذه الرسالة بسبب نشاط على حسابك في PalCert. إذا لم تكن أنت، يمكنك تجاهل هذه الرسالة. لن يطلب منك PalCert كلمة المرور عبر البريد الإلكتروني أبدًا.',
};

export function renderAuthMail(message: MailMessage, publicWebUrl: string): RenderedEmail {
  const locale = resolveEmailLocale(message.locale);
  const vars = message.variables;
  const name = (vars.displayName ?? '').trim();
  const expiry = formatExpiry(vars.expiresAt, locale);

  switch (message.template) {
    case MailTemplate.EMAIL_VERIFICATION: {
      const url = checkedLink(vars.url, publicWebUrl);
      return locale === 'ar'
        ? renderEmailLayout({
            locale,
            subject: 'تأكيد عنوان بريدك الإلكتروني في PalCert',
            heading: 'أكّد عنوان بريدك الإلكتروني',
            paragraphs: [
              name ? `مرحبًا ${name}،` : 'مرحبًا،',
              'شكرًا لإنشاء حساب في PalCert. لإكمال التسجيل، أكّد أن هذا العنوان يخصك.',
              ...(expiry
                ? [`ينتهي هذا الرابط في ${expiry}، ولا يمكن استخدامه إلا مرة واحدة.`]
                : []),
            ],
            action: { label: 'تأكيد البريد الإلكتروني', url },
            footer: FOOTER.ar,
          })
        : renderEmailLayout({
            locale,
            subject: 'Verify your PalCert email address',
            heading: 'Confirm your email address',
            paragraphs: [
              name ? `Hello ${name},` : 'Hello,',
              'Thank you for creating a PalCert account. To finish signing up, confirm that this address belongs to you.',
              ...(expiry ? [`This link expires on ${expiry} and can be used once.`] : []),
            ],
            action: { label: 'Verify email address', url },
            footer: FOOTER.en,
          });
    }
    case MailTemplate.PASSWORD_RESET: {
      const url = checkedLink(vars.url, publicWebUrl);
      return locale === 'ar'
        ? renderEmailLayout({
            locale,
            subject: 'إعادة تعيين كلمة مرور PalCert',
            heading: 'إعادة تعيين كلمة المرور',
            paragraphs: [
              name ? `مرحبًا ${name}،` : 'مرحبًا،',
              'تلقّينا طلبًا لإعادة تعيين كلمة مرور حسابك في PalCert. استخدم الزر أدناه لاختيار كلمة مرور جديدة.',
              ...(expiry
                ? [`ينتهي هذا الرابط في ${expiry}، ولا يمكن استخدامه إلا مرة واحدة.`]
                : []),
              'إذا لم تطلب ذلك، فلا داعي لأي إجراء: ستبقى كلمة مرورك كما هي.',
            ],
            action: { label: 'إعادة تعيين كلمة المرور', url },
            footer: FOOTER.ar,
          })
        : renderEmailLayout({
            locale,
            subject: 'Reset your PalCert password',
            heading: 'Reset your password',
            paragraphs: [
              name ? `Hello ${name},` : 'Hello,',
              'We received a request to reset the password for your PalCert account. Use the button below to choose a new password.',
              ...(expiry ? [`This link expires on ${expiry} and can be used once.`] : []),
              'If you did not ask for this, no action is needed: your password stays the same.',
            ],
            action: { label: 'Reset password', url },
            footer: FOOTER.en,
          });
    }
    case MailTemplate.ORGANIZATION_INVITATION: {
      const url = checkedLink(vars.url, publicWebUrl);
      const organization = (vars.organizationName ?? '').trim() || 'PalCert';
      const role = ROLE_NAMES[locale][vars.roleCode ?? ''] ?? vars.roleCode ?? '';
      return locale === 'ar'
        ? renderEmailLayout({
            locale,
            subject: 'تمت دعوتك إلى PalCert',
            heading: `دعوة للانضمام إلى ${organization}`,
            paragraphs: [
              role
                ? `تمت دعوتك للانضمام إلى ${organization} في PalCert بدور ${role}.`
                : `تمت دعوتك للانضمام إلى ${organization} في PalCert.`,
              'لقبول الدعوة، سجّل الدخول أو أنشئ حسابًا بهذا العنوان نفسه.',
              ...(expiry ? [`تنتهي هذه الدعوة في ${expiry}.`] : []),
            ],
            action: { label: 'قبول الدعوة', url },
            footer: FOOTER.ar,
          })
        : renderEmailLayout({
            locale,
            subject: 'You have been invited to PalCert',
            heading: `Join ${organization} on PalCert`,
            paragraphs: [
              role
                ? `You have been invited to join ${organization} on PalCert as ${role}.`
                : `You have been invited to join ${organization} on PalCert.`,
              'To accept, sign in or create an account with this same email address.',
              ...(expiry ? [`This invitation expires on ${expiry}.`] : []),
            ],
            action: { label: 'Accept invitation', url },
            footer: FOOTER.en,
          });
    }
    case MailTemplate.PASSWORD_CHANGED: {
      const signIn = `${trimSlash(publicWebUrl)}/${locale}/login`;
      return locale === 'ar'
        ? renderEmailLayout({
            locale,
            subject: 'تم تغيير كلمة مرور PalCert',
            heading: 'تم تغيير كلمة المرور',
            paragraphs: [
              name ? `مرحبًا ${name}،` : 'مرحبًا،',
              'تم تغيير كلمة مرور حسابك في PalCert للتو.',
              'إذا لم تقم بذلك، فأعد تعيين كلمة المرور فورًا وتواصل مع الدعم.',
            ],
            action: { label: 'تسجيل الدخول إلى PalCert', url: signIn },
            footer: FOOTER.ar,
          })
        : renderEmailLayout({
            locale,
            subject: 'Your PalCert password was changed',
            heading: 'Your password was changed',
            paragraphs: [
              name ? `Hello ${name},` : 'Hello,',
              'The password for your PalCert account was just changed.',
              'If this was not you, reset your password immediately and contact support.',
            ],
            action: { label: 'Sign in to PalCert', url: signIn },
            footer: FOOTER.en,
          });
    }
  }
}

/** The link must be an absolute URL on the deployment's public web origin. */
function checkedLink(url: string | undefined, publicWebUrl: string): string {
  if (url === undefined) throw new AuthMailLinkRejectedError();
  let parsed: URL;
  let origin: URL;
  try {
    parsed = new URL(url);
    origin = new URL(publicWebUrl);
  } catch {
    throw new AuthMailLinkRejectedError();
  }
  if (parsed.origin !== origin.origin) throw new AuthMailLinkRejectedError();
  return parsed.toString();
}

function formatExpiry(value: string | undefined, locale: EmailLocale): string | null {
  if (value === undefined) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  try {
    const formatted = new Intl.DateTimeFormat(locale === 'ar' ? 'ar-u-nu-latn' : 'en-GB', {
      dateStyle: 'long',
      timeStyle: 'short',
      timeZone: 'UTC',
    }).format(date);
    return `${formatted} UTC`;
  } catch {
    return `${date.toISOString().slice(0, 16).replace('T', ' ')} UTC`;
  }
}

function trimSlash(value: string): string {
  return value.endsWith('/') ? value.slice(0, -1) : value;
}
