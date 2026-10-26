import type { Locale } from './locales';

/**
 * Platform email administration (ADR-0146), EN and AR.
 *
 * Wording rules: never claim a domain is verified (PalCert cannot know); never
 * show or describe a stored credential beyond "configured" and its hint; name
 * failure categories in plain words, never the provider's own text.
 */
export interface EmailMessages {
  readonly nav: { readonly settings: string; readonly deliveries: string };
  readonly settings: {
    readonly title: string;
    readonly intro: string;
    readonly loading: string;
    readonly defaultsNotice: string;
    readonly providerSection: string;
    readonly provider: string;
    readonly providers: Readonly<Record<string, string>>;
    readonly enabled: string;
    readonly enabledHint: string;
    readonly senderSection: string;
    readonly sendingDomain: string;
    readonly sendingDomainHint: string;
    readonly fromEmail: string;
    readonly fromName: string;
    readonly replyTo: string;
    readonly replyToHint: string;
    readonly domainVerificationNote: string;
    readonly credentialSection: string;
    readonly apiKey: string;
    readonly apiKeyHint: string;
    readonly apiKeyConfigured: (hint: string) => string;
    readonly apiKeyNotConfigured: string;
    readonly apiKeyLeastPrivilege: string;
    readonly webhookSecret: string;
    readonly webhookSecretHint: string;
    readonly webhookConfigured: (hint: string) => string;
    readonly webhookNotConfigured: string;
    readonly clearWebhookSecret: string;
    readonly webhookEndpoint: string;
    readonly encryptionUnavailable: string;
    readonly switchesSection: string;
    readonly authVerification: string;
    readonly authPasswordReset: string;
    readonly authInvitation: string;
    readonly workflowEmail: string;
    readonly deliveryTracking: string;
    readonly deliveryTrackingHint: string;
    readonly save: string;
    readonly saving: string;
    readonly saved: string;
    readonly lastUpdated: (when: string) => string;
    readonly readOnly: string;
    readonly warnings: Readonly<Record<string, string>>;
    readonly invalidFields: (fields: string) => string;
    readonly fieldNames: Readonly<Record<string, string>>;
  };
  readonly test: {
    readonly title: string;
    readonly intro: string;
    readonly recipient: string;
    readonly locale: string;
    readonly locales: Readonly<Record<'en' | 'ar', string>>;
    readonly send: string;
    readonly sending: string;
    readonly accepted: string;
    readonly failed: (summary: string) => string;
    readonly unsavedChanges: string;
    readonly invalidRecipient: string;
  };
  readonly deliveries: {
    readonly title: string;
    readonly intro: string;
    readonly empty: string;
    readonly filters: string;
    readonly status: string;
    readonly category: string;
    readonly template: string;
    readonly provider: string;
    readonly from: string;
    readonly to: string;
    readonly any: string;
    readonly apply: string;
    readonly clear: string;
    readonly loadMore: string;
    readonly recipient: string;
    readonly type: string;
    readonly attempts: string;
    readonly created: string;
    readonly updated: string;
    readonly failure: string;
    readonly caption: string;
    readonly statuses: Readonly<Record<string, string>>;
    readonly categories: Readonly<Record<string, string>>;
    readonly failures: Readonly<Record<string, string>>;
  };
  readonly errors: Readonly<Record<string, string>>;
  readonly genericError: string;
}

const EN: EmailMessages = {
  nav: { settings: 'Email settings', deliveries: 'Email deliveries' },
  settings: {
    title: 'Email settings',
    intro:
      'Choose how PalCert sends account emails (verification, password reset, invitations) and workflow notifications.',
    loading: 'Loading email settings…',
    defaultsNotice:
      'No email provider has been configured yet. PalCert behaves exactly as it did before: account emails are not sent through a provider.',
    providerSection: 'Provider',
    provider: 'Email provider',
    providers: { DISABLED: 'Disabled', RESEND: 'Resend' },
    enabled: 'Send email through this provider',
    enabledHint:
      'When this is off, PalCert keeps its previous behaviour. You can still send a test email.',
    senderSection: 'Sender',
    sendingDomain: 'Sending domain',
    sendingDomainHint: 'For example palcert.com.',
    fromEmail: 'From address',
    fromName: 'From name',
    replyTo: 'Reply-to address',
    replyToHint: 'Optional. Where replies go.',
    domainVerificationNote:
      'The sending domain must be verified in Resend before production mail can be delivered. Domain verification is managed in Resend. Use Send test email to validate delivery.',
    credentialSection: 'Credentials',
    apiKey: 'Resend API key',
    apiKeyHint: 'Leave blank to keep the saved key. A saved key is never shown again.',
    apiKeyConfigured: (hint) => `Configured ${hint}`,
    apiKeyNotConfigured: 'Not configured',
    apiKeyLeastPrivilege: 'Use a Resend key with “Sending access” only, limited to this domain.',
    webhookSecret: 'Webhook signing secret',
    webhookSecretHint:
      'From the Resend webhook settings (starts with whsec_). Leave blank to keep the saved secret.',
    webhookConfigured: (hint) => `Configured ${hint}`,
    webhookNotConfigured: 'Not configured',
    clearWebhookSecret: 'Remove the saved webhook secret',
    webhookEndpoint: 'Webhook endpoint to register in Resend',
    encryptionUnavailable:
      'Secure configuration is unavailable: this server has no email settings encryption key, so a key or secret cannot be saved. Ask the operator to configure EMAIL_SETTINGS_ENCRYPTION_KEYS.',
    switchesSection: 'What to send',
    authVerification: 'Email address verification',
    authPasswordReset: 'Password reset',
    authInvitation: 'Organization invitations',
    workflowEmail: 'Workflow notifications',
    deliveryTracking: 'Delivery tracking',
    deliveryTrackingHint: 'Record delivered, bounced and complaint events from Resend webhooks.',
    save: 'Save settings',
    saving: 'Saving…',
    saved: 'Settings saved.',
    lastUpdated: (when) => `Last updated ${when}`,
    readOnly: 'You can view these settings but not change them.',
    warnings: {
      FROM_OUTSIDE_DOMAIN: 'The from address is not on the sending domain. Resend will refuse it.',
      API_KEY_MISSING: 'No API key is saved. Resend cannot be used until one is.',
      DOMAIN_MISSING: 'Enter a sending domain.',
      ENCRYPTION_UNAVAILABLE: 'Secure configuration is unavailable on this server.',
      WEBHOOK_SECRET_MISSING:
        'Delivery tracking is on but no webhook secret is saved, so delivery events cannot be accepted.',
    },
    invalidFields: (fields) => `Check these fields: ${fields}.`,
    fieldNames: {
      sendingDomain: 'Sending domain',
      fromEmail: 'From address',
      fromName: 'From name',
      replyToEmail: 'Reply-to address',
      apiKey: 'Resend API key',
      webhookSecret: 'Webhook signing secret',
      recipient: 'Recipient',
    },
  },
  test: {
    title: 'Send test email',
    intro:
      'Sends one message, clearly marked as a test, using the saved settings. Nothing is sent until you press the button.',
    recipient: 'Recipient',
    locale: 'Language',
    locales: { en: 'English', ar: 'Arabic' },
    send: 'Send test email',
    sending: 'Sending…',
    accepted: 'Resend accepted the test email. Check the recipient’s inbox.',
    failed: (summary) => `The test email was not sent. ${summary}`,
    unsavedChanges: 'Save your changes first: the test uses the saved settings.',
    invalidRecipient: 'Enter a valid email address.',
  },
  deliveries: {
    title: 'Email deliveries',
    intro:
      'What PalCert handed to the email provider and what the provider reported back. Message contents are never stored.',
    empty: 'No email deliveries match.',
    filters: 'Filters',
    status: 'Status',
    category: 'Kind',
    template: 'Type',
    provider: 'Provider',
    from: 'From date',
    to: 'To date',
    any: 'Any',
    apply: 'Apply',
    clear: 'Clear',
    loadMore: 'Load more',
    recipient: 'Recipient',
    type: 'Type',
    attempts: 'Attempts',
    created: 'Created',
    updated: 'Last update',
    failure: 'Problem',
    caption: 'Email deliveries, newest first',
    statuses: {
      QUEUED: 'Queued',
      ACCEPTED: 'Accepted',
      DELAYED: 'Delayed',
      DELIVERED: 'Delivered',
      BOUNCED: 'Bounced',
      COMPLAINED: 'Marked as spam',
      FAILED: 'Failed',
      SKIPPED: 'Not sent',
    },
    categories: { AUTH: 'Account', WORKFLOW: 'Notification', TEST: 'Test' },
    failures: {
      PROVIDER_UNAVAILABLE: 'Provider unavailable',
      AUTHENTICATION_REJECTED: 'API key rejected',
      SENDER_REJECTED: 'Sender or domain rejected',
      RECIPIENT_REJECTED: 'Recipient rejected',
      RATE_LIMITED: 'Rate limited',
      PROVIDER_REJECTED: 'Rejected by provider',
      CONFIGURATION_ERROR: 'Configuration problem',
      UNKNOWN: 'Unexpected response',
    },
  },
  errors: {
    EMAIL_SETTINGS_INVALID: 'Some settings are not valid.',
    EMAIL_ENCRYPTION_UNAVAILABLE:
      'Secure configuration is unavailable, so the key or secret was not saved.',
    EMAIL_PROVIDER_NOT_CONFIGURED: 'Choose Resend and save an API key before sending a test email.',
    EMAIL_DELIVERY_NOT_FOUND: 'That delivery no longer exists.',
    RATE_LIMITED: 'Too many test emails. Wait a few minutes and try again.',
    REAUTHENTICATION_REQUIRED: 'Please sign in again to change email settings.',
    FORBIDDEN: 'You do not have permission to do this.',
  },
  genericError: 'Something went wrong. Please try again.',
};

const AR: EmailMessages = {
  nav: { settings: 'إعدادات البريد الإلكتروني', deliveries: 'سجل رسائل البريد' },
  settings: {
    title: 'إعدادات البريد الإلكتروني',
    intro:
      'اختر كيف يرسل PalCert رسائل الحساب (تأكيد البريد، إعادة تعيين كلمة المرور، الدعوات) وإشعارات سير العمل.',
    loading: 'جارٍ تحميل إعدادات البريد…',
    defaultsNotice:
      'لم يُضبط أي مزوّد بريد بعد. يعمل PalCert تمامًا كما كان من قبل: لا تُرسل رسائل الحساب عبر مزوّد.',
    providerSection: 'المزوّد',
    provider: 'مزوّد البريد',
    providers: { DISABLED: 'معطّل', RESEND: 'Resend' },
    enabled: 'إرسال البريد عبر هذا المزوّد',
    enabledHint:
      'عند إيقاف هذا الخيار يحتفظ PalCert بسلوكه السابق. ويمكنك مع ذلك إرسال رسالة اختبار.',
    senderSection: 'المُرسِل',
    sendingDomain: 'نطاق الإرسال',
    sendingDomainHint: 'مثل palcert.com.',
    fromEmail: 'عنوان المُرسِل',
    fromName: 'اسم المُرسِل',
    replyTo: 'عنوان الرد',
    replyToHint: 'اختياري. العنوان الذي تصل إليه الردود.',
    domainVerificationNote:
      'يجب التحقق من نطاق الإرسال في Resend قبل أن يمكن تسليم بريد الإنتاج. تتم إدارة التحقق من النطاق في Resend. استخدم «إرسال رسالة اختبار» للتأكد من التسليم.',
    credentialSection: 'بيانات الاعتماد',
    apiKey: 'مفتاح Resend API',
    apiKeyHint:
      'اتركه فارغًا للإبقاء على المفتاح المحفوظ. لا يُعرض المفتاح المحفوظ مرة أخرى أبدًا.',
    apiKeyConfigured: (hint) => `مضبوط ${hint}`,
    apiKeyNotConfigured: 'غير مضبوط',
    apiKeyLeastPrivilege: 'استخدم مفتاح Resend بصلاحية «الإرسال فقط» ومقيّدًا بهذا النطاق.',
    webhookSecret: 'سرّ توقيع Webhook',
    webhookSecretHint:
      'من إعدادات Webhook في Resend (يبدأ بـ whsec_). اتركه فارغًا للإبقاء على السرّ المحفوظ.',
    webhookConfigured: (hint) => `مضبوط ${hint}`,
    webhookNotConfigured: 'غير مضبوط',
    clearWebhookSecret: 'إزالة سرّ Webhook المحفوظ',
    webhookEndpoint: 'عنوان Webhook الذي يُسجَّل في Resend',
    encryptionUnavailable:
      'الإعداد الآمن غير متاح: لا يوجد على هذا الخادم مفتاح تشفير لإعدادات البريد، لذا لا يمكن حفظ مفتاح أو سرّ. اطلب من المشغّل ضبط EMAIL_SETTINGS_ENCRYPTION_KEYS.',
    switchesSection: 'ما الذي يُرسل',
    authVerification: 'تأكيد عنوان البريد الإلكتروني',
    authPasswordReset: 'إعادة تعيين كلمة المرور',
    authInvitation: 'دعوات المؤسسات',
    workflowEmail: 'إشعارات سير العمل',
    deliveryTracking: 'تتبّع التسليم',
    deliveryTrackingHint: 'تسجيل أحداث التسليم والارتداد والشكاوى الواردة من Webhook في Resend.',
    save: 'حفظ الإعدادات',
    saving: 'جارٍ الحفظ…',
    saved: 'تم حفظ الإعدادات.',
    lastUpdated: (when) => `آخر تحديث ${when}`,
    readOnly: 'يمكنك عرض هذه الإعدادات دون تغييرها.',
    warnings: {
      FROM_OUTSIDE_DOMAIN: 'عنوان المُرسِل ليس ضمن نطاق الإرسال، وسيرفضه Resend.',
      API_KEY_MISSING: 'لا يوجد مفتاح API محفوظ. لا يمكن استخدام Resend قبل حفظ مفتاح.',
      DOMAIN_MISSING: 'أدخل نطاق الإرسال.',
      ENCRYPTION_UNAVAILABLE: 'الإعداد الآمن غير متاح على هذا الخادم.',
      WEBHOOK_SECRET_MISSING:
        'تتبّع التسليم مفعّل لكن لا يوجد سرّ Webhook محفوظ، لذا لا يمكن قبول أحداث التسليم.',
    },
    invalidFields: (fields) => `راجع هذه الحقول: ${fields}.`,
    fieldNames: {
      sendingDomain: 'نطاق الإرسال',
      fromEmail: 'عنوان المُرسِل',
      fromName: 'اسم المُرسِل',
      replyToEmail: 'عنوان الرد',
      apiKey: 'مفتاح Resend API',
      webhookSecret: 'سرّ توقيع Webhook',
      recipient: 'المستلم',
    },
  },
  test: {
    title: 'إرسال رسالة اختبار',
    intro:
      'تُرسل رسالة واحدة موسومة بوضوح بأنها اختبار، باستخدام الإعدادات المحفوظة. لا يُرسل شيء حتى تضغط الزر.',
    recipient: 'المستلم',
    locale: 'اللغة',
    locales: { en: 'الإنجليزية', ar: 'العربية' },
    send: 'إرسال رسالة اختبار',
    sending: 'جارٍ الإرسال…',
    accepted: 'قَبِل Resend رسالة الاختبار. تحقّق من صندوق بريد المستلم.',
    failed: (summary) => `لم تُرسل رسالة الاختبار. ${summary}`,
    unsavedChanges: 'احفظ تغييراتك أولًا: يستخدم الاختبار الإعدادات المحفوظة.',
    invalidRecipient: 'أدخل عنوان بريد إلكتروني صالحًا.',
  },
  deliveries: {
    title: 'سجل رسائل البريد',
    intro:
      'ما سلّمه PalCert إلى مزوّد البريد وما أبلغ عنه المزوّد. لا يُخزَّن محتوى الرسائل أبدًا.',
    empty: 'لا توجد رسائل مطابقة.',
    filters: 'عوامل التصفية',
    status: 'الحالة',
    category: 'النوع العام',
    template: 'النوع',
    provider: 'المزوّد',
    from: 'من تاريخ',
    to: 'إلى تاريخ',
    any: 'الكل',
    apply: 'تطبيق',
    clear: 'مسح',
    loadMore: 'عرض المزيد',
    recipient: 'المستلم',
    type: 'النوع',
    attempts: 'المحاولات',
    created: 'أُنشئت',
    updated: 'آخر تحديث',
    failure: 'المشكلة',
    caption: 'رسائل البريد، الأحدث أولًا',
    statuses: {
      QUEUED: 'في الانتظار',
      ACCEPTED: 'مقبولة',
      DELAYED: 'متأخرة',
      DELIVERED: 'مُسلَّمة',
      BOUNCED: 'مرتدّة',
      COMPLAINED: 'وُسمت كرسالة مزعجة',
      FAILED: 'فشلت',
      SKIPPED: 'لم تُرسل',
    },
    categories: { AUTH: 'الحساب', WORKFLOW: 'إشعار', TEST: 'اختبار' },
    failures: {
      PROVIDER_UNAVAILABLE: 'المزوّد غير متاح',
      AUTHENTICATION_REJECTED: 'رُفض مفتاح API',
      SENDER_REJECTED: 'رُفض المُرسِل أو النطاق',
      RECIPIENT_REJECTED: 'رُفض المستلم',
      RATE_LIMITED: 'تجاوز حد الإرسال',
      PROVIDER_REJECTED: 'رفضها المزوّد',
      CONFIGURATION_ERROR: 'مشكلة في الإعدادات',
      UNKNOWN: 'استجابة غير متوقعة',
    },
  },
  errors: {
    EMAIL_SETTINGS_INVALID: 'بعض الإعدادات غير صالحة.',
    EMAIL_ENCRYPTION_UNAVAILABLE: 'الإعداد الآمن غير متاح، لذا لم يُحفظ المفتاح أو السرّ.',
    EMAIL_PROVIDER_NOT_CONFIGURED: 'اختر Resend واحفظ مفتاح API قبل إرسال رسالة اختبار.',
    EMAIL_DELIVERY_NOT_FOUND: 'لم تعد هذه الرسالة موجودة.',
    RATE_LIMITED: 'رسائل اختبار كثيرة. انتظر بضع دقائق ثم حاول مجددًا.',
    REAUTHENTICATION_REQUIRED: 'يُرجى تسجيل الدخول مرة أخرى لتغيير إعدادات البريد.',
    FORBIDDEN: 'ليست لديك صلاحية لهذا الإجراء.',
  },
  genericError: 'حدث خطأ ما. يُرجى المحاولة مرة أخرى.',
};

export const EMAIL_MESSAGES: Readonly<Record<Locale, EmailMessages>> = { en: EN, ar: AR };

export function getEmailMessages(locale: Locale): EmailMessages {
  return EMAIL_MESSAGES[locale];
}
