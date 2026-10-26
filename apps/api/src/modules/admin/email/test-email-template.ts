import {
  renderEmailLayout,
  type EmailLocale,
  type RenderedEmail,
} from '../../../infrastructure/email/email-layout';

/**
 * The configuration test message (ADR-0146).
 *
 * States plainly that it is a test, names the environment and the sender it
 * was sent as, and carries a timestamp. It contains no link, no token, no
 * credential and nothing about the provider account.
 */
export function renderTestEmail(params: {
  readonly locale: EmailLocale;
  readonly environment: string;
  readonly sender: string;
  readonly sentAt: Date;
}): RenderedEmail {
  const at = `${params.sentAt.toISOString().slice(0, 19).replace('T', ' ')} UTC`;
  return params.locale === 'ar'
    ? renderEmailLayout({
        locale: 'ar',
        subject: 'اختبار إعدادات البريد الإلكتروني في PalCert',
        heading: 'هذه رسالة اختبار',
        paragraphs: [
          'أرسل أحد مسؤولي PalCert هذه الرسالة للتحقق من إعدادات البريد الإلكتروني.',
          'إذا وصلتك، فإن مزوّد البريد قَبِل الرسالة وسلّمها. لا يلزم أي إجراء.',
        ],
        facts: [
          { label: 'البيئة', value: params.environment },
          { label: 'المُرسِل', value: params.sender },
          { label: 'وقت الإرسال', value: at },
        ],
        footer: 'رسالة اختبار من PalCert. لا تحتوي على أي رابط أو بيانات حساب.',
      })
    : renderEmailLayout({
        locale: 'en',
        subject: 'PalCert email configuration test',
        heading: 'This is a test message',
        paragraphs: [
          'A PalCert administrator sent this message to check the email configuration.',
          'If you are reading it, the email provider accepted and delivered it. No action is needed.',
        ],
        facts: [
          { label: 'Environment', value: params.environment },
          { label: 'Sender', value: params.sender },
          { label: 'Sent at', value: at },
        ],
        footer: 'A PalCert test message. It contains no links and no account information.',
      });
}
