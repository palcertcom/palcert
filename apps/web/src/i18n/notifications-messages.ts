import { DEFAULT_LOCALE, type Locale } from './locales';

/**
 * What a person reads about their own notifications (§105–§113).
 *
 * Two wording rules run through all of it.
 *
 * **A notification reports; it never decides.** The screen says "the
 * institution approved your submission", never "your submission is approved"
 * as though this page were the authority. The difference matters when the two
 * disagree — a stale copy must read as an old message, not as a current fact.
 *
 * **Say why a switch is missing.** The revocation row cannot be turned off, and
 * a disabled control with no explanation reads as a bug. The screen says what
 * the rule is and why, in both languages.
 */
export interface NotificationsMessages {
  readonly title: string;
  readonly intro: string;
  readonly empty: string;
  readonly unreadLabel: string;
  readonly bellLabel: string;
  readonly markRead: string;
  readonly markAllRead: string;
  readonly loadMore: string;
  readonly loading: string;
  readonly open: string;
  readonly unreadBadge: string;

  readonly preferencesTitle: string;
  readonly preferencesIntro: string;
  readonly emailColumn: string;
  readonly typeColumn: string;
  readonly mandatoryNote: string;
  readonly alwaysOn: string;
  readonly inAppNote: string;

  /** One label per NotificationType. */
  readonly types: Readonly<Record<string, string>>;

  readonly errors: Readonly<Record<string, string>>;
  readonly genericError: string;
}

const EN: NotificationsMessages = {
  title: 'Notifications',
  intro:
    'What has happened to your submissions and certificates. Each one links to the page that ' +
    'holds the detail — you will need to sign in to read it.',
  empty: 'Nothing yet. PalCert will tell you here when something happens.',
  unreadLabel: 'Unread',
  bellLabel: 'Notifications',
  markRead: 'Mark as read',
  markAllRead: 'Mark all as read',
  loadMore: 'Show older',
  loading: 'Loading…',
  open: 'Open',
  unreadBadge: 'Unread',

  preferencesTitle: 'Email preferences',
  preferencesIntro:
    'Which of these PalCert also sends to your verified email address. Everything still ' +
    'appears here whatever you choose.',
  emailColumn: 'Email',
  typeColumn: 'What happened',
  mandatoryNote:
    'PalCert always emails you when a certificate of yours is revoked. A revocation changes ' +
    'whether a certificate you may already have shown somebody still verifies, so it is not ' +
    'something to find out by chance.',
  alwaysOn: 'Always sent',
  inAppNote: 'Turning email off never turns off the notification itself.',

  types: {
    SUBMISSION_READY: 'A submission reached an institution',
    SUBMISSION_REVISION_READY: 'A revised submission reached an institution',
    SUBMISSION_UNDER_REVIEW: 'An institution started reviewing your submission',
    SUBMISSION_APPROVED: 'An institution approved your submission',
    SUBMISSION_REJECTED: 'An institution rejected your submission',
    SUBMISSION_REVISION_REQUESTED: 'An institution asked for changes',
    SUBMISSION_COMMENT_ADDED: 'A reviewer left a comment',
    CERTIFICATE_ISSUED: 'A certificate was issued to you',
    CERTIFICATE_REVOKED: 'A certificate of yours was revoked',
    MANUAL_TOPUP_SUBMITTED: 'A customer reported a transfer for PalCert finance to verify',
    MANUAL_TOPUP_APPROVED: 'PalCert finance verified your transfer',
    MANUAL_TOPUP_REJECTED: 'PalCert finance could not verify your transfer',
  },

  errors: {
    NOTIFICATION_NOT_FOUND: 'That notification does not exist.',
    NOTIFICATION_TYPE_MANDATORY:
      'PalCert always emails you about a revoked certificate. That one cannot be switched off.',
    UNAUTHENTICATED: 'Please sign in again.',
    VALIDATION_FAILED: 'That request was not valid.',
  },
  genericError: 'Something went wrong. Please try again.',
};

const AR: NotificationsMessages = {
  title: 'الإشعارات',
  intro:
    'ما جرى على طلباتك وشهاداتك. كل إشعار يقودك إلى الصفحة التي تحمل التفاصيل، وستحتاج إلى ' +
    'تسجيل الدخول لقراءتها.',
  empty: 'لا شيء بعد. ستخبرك بال‌سيرت هنا عند حدوث أي جديد.',
  unreadLabel: 'غير مقروء',
  bellLabel: 'الإشعارات',
  markRead: 'تعليم كمقروء',
  markAllRead: 'تعليم الكل كمقروء',
  loadMore: 'عرض الأقدم',
  loading: 'جارٍ التحميل…',
  open: 'فتح',
  unreadBadge: 'غير مقروء',

  preferencesTitle: 'تفضيلات البريد',
  preferencesIntro:
    'أيٌّ من هذه ترسله بال‌سيرت أيضًا إلى بريدك الموثَّق. وكلّها تظهر هنا مهما كان اختيارك.',
  emailColumn: 'البريد',
  typeColumn: 'ما الذي حدث',
  mandatoryNote:
    'ترسل بال‌سيرت بريدًا دائمًا عند سحب شهادة تخصّك. فالسحب يغيّر ما إذا كانت شهادة ربما ' +
    'عرضتها على جهة ما لا تزال صالحة للتحقق، وهذا ليس ممّا يُترك للمصادفة.',
  alwaysOn: 'يُرسل دائمًا',
  inAppNote: 'إيقاف البريد لا يوقف الإشعار نفسه.',

  types: {
    SUBMISSION_READY: 'وصل طلب إلى مؤسسة',
    SUBMISSION_REVISION_READY: 'وصلت نسخة منقّحة إلى مؤسسة',
    SUBMISSION_UNDER_REVIEW: 'بدأت مؤسسة مراجعة طلبك',
    SUBMISSION_APPROVED: 'وافقت مؤسسة على طلبك',
    SUBMISSION_REJECTED: 'رفضت مؤسسة طلبك',
    SUBMISSION_REVISION_REQUESTED: 'طلبت مؤسسة إجراء تعديلات',
    SUBMISSION_COMMENT_ADDED: 'أضاف أحد المراجعين تعليقًا',
    CERTIFICATE_ISSUED: 'صدرت لك شهادة',
    CERTIFICATE_REVOKED: 'سُحبت شهادة تخصّك',
    MANUAL_TOPUP_SUBMITTED: 'أبلغ عميل عن تحويل ليتحقق منه فريق المالية في بال‌سيرت',
    MANUAL_TOPUP_APPROVED: 'تحقق فريق المالية في بال‌سيرت من تحويلك',
    MANUAL_TOPUP_REJECTED: 'تعذّر على فريق المالية في بال‌سيرت التحقق من تحويلك',
  },

  errors: {
    NOTIFICATION_NOT_FOUND: 'هذا الإشعار غير موجود.',
    NOTIFICATION_TYPE_MANDATORY:
      'ترسل بال‌سيرت بريدًا دائمًا عند سحب شهادة. لا يمكن إيقاف هذا النوع.',
    UNAUTHENTICATED: 'يرجى تسجيل الدخول مجددًا.',
    VALIDATION_FAILED: 'هذا الطلب غير صالح.',
  },
  genericError: 'حدث خطأ ما. يرجى المحاولة مرة أخرى.',
};

export const NOTIFICATIONS_MESSAGES: Record<Locale, NotificationsMessages> = { en: EN, ar: AR };

export function getNotificationsMessages(locale: Locale): NotificationsMessages {
  return NOTIFICATIONS_MESSAGES[locale] ?? NOTIFICATIONS_MESSAGES[DEFAULT_LOCALE];
}
