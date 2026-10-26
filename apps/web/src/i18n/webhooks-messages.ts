import { DEFAULT_LOCALE, type Locale } from './locales';

/**
 * What an administrator reads while running their own webhooks.
 *
 * Three wording rules run through all of it.
 *
 * **Say what is live and what is waiting.** A saved URL is not a working one.
 * The screen never shows a pending configuration as the destination, because an
 * administrator who believes their new URL is live stops watching the old one.
 *
 * **A secret is shown once, and the screen says so before it is shown.** Not
 * afterwards, and not in a tooltip. If it is lost the only way forward is to
 * rotate, and the wording says that plainly rather than implying a recovery
 * that does not exist.
 *
 * **Name the rotation hazard.** Deliveries already in flight keep the secret
 * they were signed with, so a receiver that retires the old one too early drops
 * real events. The count on the screen is the number to wait for.
 */
export interface WebhooksMessages {
  readonly navWebhooks: string;
  readonly title: string;
  readonly intro: string;
  readonly empty: string;
  readonly loading: string;

  readonly createTitle: string;
  readonly createIntro: string;
  readonly descriptionLabel: string;
  readonly urlLabel: string;
  readonly urlHint: string;
  readonly eventTypesLabel: string;
  readonly eventTypesHint: string;
  readonly create: string;
  readonly creating: string;

  readonly detailTitle: string;
  readonly destination: string;
  readonly destinationHint: string;
  readonly noDestination: string;
  readonly statusLabel: string;
  readonly configVersion: string;
  readonly pendingTitle: string;
  readonly pendingIntro: string;
  readonly lastVerificationError: string;
  readonly never: string;

  readonly verify: string;
  readonly verifyAgain: string;
  readonly verifyIntro: string;
  readonly verifyAccepted: string;
  readonly pause: string;
  readonly resume: string;
  readonly disable: string;
  readonly disableConfirm: string;
  readonly updateUrl: string;
  readonly saveSubscriptions: string;
  readonly test: string;
  readonly testAccepted: string;
  readonly rotate: string;
  readonly replay: string;
  readonly replayAccepted: string;

  readonly secretTitle: string;
  readonly secretWarning: string;
  readonly secretCopy: string;
  readonly secretCopied: string;
  readonly secretDismiss: string;
  readonly secretRecoverable: string;
  readonly secretGone: string;

  readonly rotationWarningTitle: string;
  readonly rotationWarningBody: string;
  readonly rotationPendingCount: string;
  readonly rotationClear: string;

  readonly deliveriesTitle: string;
  readonly attemptsTitle: string;
  readonly verificationHistoryTitle: string;
  readonly configHistoryTitle: string;
  readonly operationsTitle: string;
  readonly operationsIntro: string;
  readonly operationSettled: string;
  readonly operationPending: string;
  readonly operationKinds: Readonly<Record<string, string>>;
  readonly rename: string;
  readonly renamed: string;
  readonly noHistory: string;
  readonly loadMore: string;

  readonly columnEvent: string;
  readonly columnStatus: string;
  readonly columnAttempts: string;
  readonly columnError: string;
  readonly columnHttp: string;
  readonly columnWhen: string;
  readonly columnDuration: string;
  readonly columnVersion: string;

  readonly endpointStatuses: Readonly<Record<string, string>>;
  readonly deliveryStatuses: Readonly<Record<string, string>>;
  readonly configStatuses: Readonly<Record<string, string>>;
  readonly eventTypes: Readonly<Record<string, string>>;
  readonly errors: Readonly<Record<string, string>>;
  readonly genericError: string;
}

const EN: WebhooksMessages = {
  navWebhooks: 'Webhooks',
  title: 'Webhooks',
  intro:
    'PalCert can tell your systems when something happens here. Each endpoint has to prove it ' +
    'receives what PalCert sends before anything real is delivered to it.',
  empty: 'No endpoints yet.',
  loading: 'Loading…',

  createTitle: 'Add an endpoint',
  createIntro:
    'You will be shown a signing secret once, when the endpoint is created. Save it before you ' +
    'close the page.',
  descriptionLabel: 'What this is for',
  urlLabel: 'HTTPS URL',
  urlHint:
    'A public HTTPS address on port 443. Query strings, IP addresses and private networks are ' +
    'refused.',
  eventTypesLabel: 'Events to send',
  eventTypesHint: 'Nothing is sent until you choose at least one.',
  create: 'Create endpoint',
  creating: 'Creating…',

  detailTitle: 'Endpoint',
  destination: 'Sending to',
  destinationHint:
    'The host PalCert sends to. The full path is encrypted and PalCert does not read it back — ' +
    'save a new URL if you need to change it.',
  noDestination: 'Nothing yet — this endpoint has never been verified.',
  statusLabel: 'Status',
  configVersion: 'Configuration version',
  pendingTitle: 'Waiting to be verified',
  pendingIntro:
    'Saved, but not yet live. The current configuration keeps receiving events until this one ' +
    'answers a challenge.',
  lastVerificationError: 'Last verification result',
  never: 'Never',

  verify: 'Verify',
  verifyAgain: 'Verify again',
  verifyIntro:
    'PalCert sends one signed challenge and expects it echoed back. Fix your receiver and ask ' +
    'again as often as you need to.',
  verifyAccepted: 'Verification started. Refresh in a moment to see the result.',
  pause: 'Pause',
  resume: 'Resume',
  disable: 'Disable',
  disableConfirm:
    'Disabling is permanent. The endpoint stops receiving events and cannot be turned back on — ' +
    'you would create a new one instead. Continue?',
  updateUrl: 'Save new URL',
  saveSubscriptions: 'Save events',
  test: 'Send a test',
  testAccepted: 'Test message queued. It appears in the delivery history below.',
  rotate: 'Rotate signing secret',
  replay: 'Send again',
  replayAccepted: 'Queued. It carries the same event id, so a receiver that deduplicates sees one.',

  secretTitle: 'Your signing secret',
  secretWarning:
    'This is the only time PalCert will show it. Save it now — if you lose it, the only way ' +
    'forward is to rotate, which means verifying again.',
  secretCopy: 'Copy',
  secretCopied: 'Copied',
  secretDismiss: 'I have saved it',
  secretRecoverable: 'Recoverable by repeating the same request until',
  secretGone: 'That secret can no longer be shown. Rotate to get a new one.',

  rotationWarningTitle: 'Keep the previous secret valid',
  rotationWarningBody:
    'Deliveries that were already scheduled keep the configuration they were created with, so ' +
    'they are still signed with the previous secret. Your receiver should accept both until the ' +
    'count below reaches zero. Sending an event again by hand uses the current configuration.',
  rotationPendingCount: 'Still signed with an older configuration',
  rotationClear: 'Nothing is left on an older configuration — the previous secret can be retired.',

  deliveriesTitle: 'Deliveries',
  attemptsTitle: 'Attempts',
  verificationHistoryTitle: 'Verification history',
  configHistoryTitle: 'Configuration history',
  operationsTitle: 'Management log',
  operationsIntro:
    'Each change that must not happen twice — creating, verifying, testing, rotating, replaying — is recorded here with its outcome.',
  operationSettled: 'Completed',
  operationPending: 'In progress',
  operationKinds: {
    CREATE_ENDPOINT: 'Endpoint created',
    UPDATE_URL: 'Address changed',
    VERIFY_CONFIG: 'Verification requested',
    TEST_ENDPOINT: 'Test sent',
    ROTATE_SECRET: 'Secret rotated',
    REPLAY_DELIVERY: 'Delivery replayed',
  },
  rename: 'Save name',
  renamed: 'Name saved.',
  noHistory: 'Nothing yet.',
  loadMore: 'Load more',

  columnEvent: 'Event',
  columnStatus: 'Status',
  columnAttempts: 'Attempts',
  columnError: 'Result',
  columnHttp: 'HTTP',
  columnWhen: 'When',
  columnDuration: 'Took',
  columnVersion: 'Version',

  endpointStatuses: {
    PENDING_VERIFICATION: 'Waiting to be verified',
    ACTIVE: 'Active',
    PAUSED: 'Paused',
    DISABLED: 'Disabled',
  },
  deliveryStatuses: {
    PENDING: 'Queued',
    SENDING: 'Sending',
    DELIVERED: 'Delivered',
    FAILED_RETRYABLE: 'Will try again',
    FAILED_PERMANENT: 'Failed',
    SKIPPED: 'Not sent',
  },
  configStatuses: {
    PENDING: 'Waiting to be verified',
    VERIFIED: 'Live',
    RETIRED: 'Retired',
    SUPERSEDED: 'Replaced',
  },
  eventTypes: {
    'submission.ready': 'Submission ready',
    'submission.revision_ready': 'Revision ready',
    'submission.under_review': 'Submission under review',
    'submission.approved': 'Submission approved',
    'submission.rejected': 'Submission rejected',
    'submission.revision_requested': 'Revision requested',
    'submission.comment_added': 'Comment added',
    'certificate.issued': 'Certificate issued',
    'certificate.revoked': 'Certificate revoked',
  },
  errors: {
    WEBHOOK_ENDPOINT_NOT_FOUND: 'That endpoint does not exist.',
    WEBHOOK_DELIVERY_NOT_FOUND: 'That delivery does not exist.',
    WEBHOOK_URL_NOT_ALLOWED:
      'PalCert will not send to that address. It must be a public HTTPS URL on port 443, with ' +
      'no query string.',
    WEBHOOK_ENDPOINT_LIMIT_REACHED: 'You already have ten endpoints. Disable one to add another.',
    WEBHOOK_ENDPOINT_NOT_VERIFIED: 'This endpoint has no verified configuration yet.',
    WEBHOOK_ENDPOINT_DISABLED: 'This endpoint was disabled, and that cannot be undone.',
    WEBHOOK_ENDPOINT_TRANSITION_INVALID: 'That change is not possible from the current status.',
    WEBHOOK_NO_PENDING_CONFIG: 'There is nothing waiting to be verified.',
    WEBHOOK_CONFIG_SUPERSEDED: 'That configuration has been replaced by a newer one.',
    WEBHOOK_EVENT_TYPE_INVALID: 'That is not one of the events PalCert sends.',
    WEBHOOK_IDEMPOTENCY_KEY_REQUIRED: 'Something went wrong sending that request. Try again.',
    WEBHOOK_IDEMPOTENCY_KEY_CONFLICT: 'Somebody else is already running that request.',
    WEBHOOK_IDEMPOTENCY_KEY_REUSED: 'That request changed while it was being retried. Start again.',
    WEBHOOK_IDEMPOTENCY_KEY_EXPIRED: 'That secret can no longer be shown. Rotate to get a new one.',
    WEBHOOK_SECRET_NO_LONGER_RECOVERABLE:
      'That secret can no longer be shown. Rotate to get a new one.',
    WEBHOOK_DELIVERY_NOT_REPLAYABLE: 'That delivery cannot be sent again.',
    WEBHOOK_TEST_DELIVERY_NOT_REPLAYABLE:
      'A test message carries no event, so there is nothing to send again. Send a new test.',
  },
  genericError: 'Something went wrong. Please try again.',
};

const AR: WebhooksMessages = {
  navWebhooks: 'الويب هوك',
  title: 'الويب هوك',
  intro:
    'يمكن لبال‌سيرت إعلام أنظمتك عند وقوع حدث هنا. على كل وجهة أن تُثبت أنها تستقبل ما يرسله ' +
    'بال‌سيرت قبل أن يصلها أي حدث حقيقي.',
  empty: 'لا توجد وجهات بعد.',
  loading: 'جارٍ التحميل…',

  createTitle: 'إضافة وجهة',
  createIntro: 'سيُعرض عليك مفتاح التوقيع مرة واحدة عند إنشاء الوجهة. احفظه قبل إغلاق الصفحة.',
  descriptionLabel: 'الغرض من هذه الوجهة',
  urlLabel: 'رابط HTTPS',
  urlHint: 'عنوان HTTPS عام على المنفذ 443. تُرفض سلاسل الاستعلام وعناوين IP والشبكات الخاصة.',
  eventTypesLabel: 'الأحداث المُرسلة',
  eventTypesHint: 'لن يُرسل شيء حتى تختار حدثًا واحدًا على الأقل.',
  create: 'إنشاء وجهة',
  creating: 'جارٍ الإنشاء…',

  detailTitle: 'الوجهة',
  destination: 'الإرسال إلى',
  destinationHint:
    'المضيف الذي يرسل إليه بال‌سيرت. المسار الكامل مُشفّر ولا يقرأه بال‌سيرت مرة أخرى — احفظ ' +
    'رابطًا جديدًا إذا أردت تغييره.',
  noDestination: 'لا شيء بعد — لم يجرِ التحقق من هذه الوجهة قط.',
  statusLabel: 'الحالة',
  configVersion: 'إصدار الإعداد',
  pendingTitle: 'بانتظار التحقق',
  pendingIntro:
    'محفوظ لكنه غير مُفعّل. يستمر الإعداد الحالي في استقبال الأحداث حتى يجيب هذا الإعداد على ' +
    'تحدٍّ من بال‌سيرت.',
  lastVerificationError: 'نتيجة آخر تحقق',
  never: 'لم يحدث',

  verify: 'تحقّق',
  verifyAgain: 'أعد التحقق',
  verifyIntro:
    'يرسل بال‌سيرت تحديًا موقّعًا واحدًا ويتوقع إعادته كما هو. أصلح المستقبِل وأعد المحاولة ' +
    'كما تشاء.',
  verifyAccepted: 'بدأ التحقق. حدّث الصفحة بعد قليل لرؤية النتيجة.',
  pause: 'إيقاف مؤقت',
  resume: 'استئناف',
  disable: 'تعطيل',
  disableConfirm:
    'التعطيل نهائي. تتوقف الوجهة عن استقبال الأحداث ولا يمكن إعادة تشغيلها — ستنشئ وجهة جديدة ' +
    'بدلًا منها. هل تريد المتابعة؟',
  updateUrl: 'حفظ الرابط الجديد',
  saveSubscriptions: 'حفظ الأحداث',
  test: 'إرسال رسالة اختبار',
  testAccepted: 'أُدرجت رسالة الاختبار في الطابور، وستظهر في سجل الإرسال أدناه.',
  rotate: 'تدوير مفتاح التوقيع',
  replay: 'إعادة الإرسال',
  replayAccepted:
    'أُدرج في الطابور. يحمل مُعرِّف الحدث نفسه، فالمستقبِل الذي يمنع التكرار سيرى حدثًا واحدًا.',

  secretTitle: 'مفتاح التوقيع الخاص بك',
  secretWarning:
    'هذه المرة الوحيدة التي يعرضه فيها بال‌سيرت. احفظه الآن — إن فقدته فالسبيل الوحيد هو ' +
    'التدوير، وهو يستلزم تحققًا جديدًا.',
  secretCopy: 'نسخ',
  secretCopied: 'تم النسخ',
  secretDismiss: 'حفظته',
  secretRecoverable: 'يمكن استرجاعه بتكرار الطلب نفسه حتى',
  secretGone: 'لم يعد بالإمكان عرض ذلك المفتاح. استخدم التدوير للحصول على مفتاح جديد.',

  rotationWarningTitle: 'أبقِ المفتاح السابق صالحًا',
  rotationWarningBody:
    'الإرساليات المجدولة سابقًا تحتفظ بالإعداد الذي أُنشئت به، أي أنها ما زالت موقّعة بالمفتاح ' +
    'السابق. ينبغي أن يقبل المستقبِل المفتاحين معًا حتى يصل العدد أدناه إلى صفر. أما إعادة ' +
    'الإرسال اليدوية فتستخدم الإعداد الحالي.',
  rotationPendingCount: 'ما زالت موقّعة بإعداد أقدم',
  rotationClear: 'لم يبقَ شيء على إعداد أقدم — يمكن إيقاف المفتاح السابق.',

  deliveriesTitle: 'الإرساليات',
  attemptsTitle: 'المحاولات',
  verificationHistoryTitle: 'سجل التحقق',
  configHistoryTitle: 'سجل الإعدادات',
  operationsTitle: 'سجل الإدارة',
  operationsIntro:
    'كل تغيير لا يجوز تكراره — الإنشاء والتحقق والاختبار وتدوير السر وإعادة الإرسال — يُسجَّل هنا مع نتيجته.',
  operationSettled: 'اكتمل',
  operationPending: 'قيد التنفيذ',
  operationKinds: {
    CREATE_ENDPOINT: 'إنشاء الوجهة',
    UPDATE_URL: 'تغيير العنوان',
    VERIFY_CONFIG: 'طلب تحقق',
    TEST_ENDPOINT: 'إرسال اختبار',
    ROTATE_SECRET: 'تدوير السر',
    REPLAY_DELIVERY: 'إعادة إرسال',
  },
  rename: 'حفظ الاسم',
  renamed: 'تم حفظ الاسم.',
  noHistory: 'لا شيء بعد.',
  loadMore: 'عرض المزيد',

  columnEvent: 'الحدث',
  columnStatus: 'الحالة',
  columnAttempts: 'المحاولات',
  columnError: 'النتيجة',
  columnHttp: 'HTTP',
  columnWhen: 'الوقت',
  columnDuration: 'المدة',
  columnVersion: 'الإصدار',

  endpointStatuses: {
    PENDING_VERIFICATION: 'بانتظار التحقق',
    ACTIVE: 'نشطة',
    PAUSED: 'موقوفة مؤقتًا',
    DISABLED: 'معطّلة',
  },
  deliveryStatuses: {
    PENDING: 'في الطابور',
    SENDING: 'جارٍ الإرسال',
    DELIVERED: 'وصلت',
    FAILED_RETRYABLE: 'ستُعاد المحاولة',
    FAILED_PERMANENT: 'فشلت',
    SKIPPED: 'لم تُرسل',
  },
  configStatuses: {
    PENDING: 'بانتظار التحقق',
    VERIFIED: 'مُفعّل',
    RETIRED: 'متقاعد',
    SUPERSEDED: 'مُستبدل',
  },
  eventTypes: {
    'submission.ready': 'التقديم جاهز',
    'submission.revision_ready': 'المراجعة جاهزة',
    'submission.under_review': 'التقديم قيد المراجعة',
    'submission.approved': 'اعتُمد التقديم',
    'submission.rejected': 'رُفض التقديم',
    'submission.revision_requested': 'طُلبت مراجعة',
    'submission.comment_added': 'أُضيف تعليق',
    'certificate.issued': 'صدرت الشهادة',
    'certificate.revoked': 'أُلغيت الشهادة',
  },
  errors: {
    WEBHOOK_ENDPOINT_NOT_FOUND: 'هذه الوجهة غير موجودة.',
    WEBHOOK_DELIVERY_NOT_FOUND: 'هذه الإرسالية غير موجودة.',
    WEBHOOK_URL_NOT_ALLOWED:
      'لن يرسل بال‌سيرت إلى هذا العنوان. يجب أن يكون رابط HTTPS عامًا على المنفذ 443 وبلا ' +
      'سلسلة استعلام.',
    WEBHOOK_ENDPOINT_LIMIT_REACHED: 'لديك عشر وجهات بالفعل. عطّل واحدة لإضافة أخرى.',
    WEBHOOK_ENDPOINT_NOT_VERIFIED: 'لا يوجد إعداد مُتحقق منه لهذه الوجهة بعد.',
    WEBHOOK_ENDPOINT_DISABLED: 'عُطّلت هذه الوجهة، ولا يمكن التراجع عن ذلك.',
    WEBHOOK_ENDPOINT_TRANSITION_INVALID: 'هذا التغيير غير ممكن من الحالة الراهنة.',
    WEBHOOK_NO_PENDING_CONFIG: 'لا يوجد إعداد بانتظار التحقق.',
    WEBHOOK_CONFIG_SUPERSEDED: 'استُبدل هذا الإعداد بإعداد أحدث.',
    WEBHOOK_EVENT_TYPE_INVALID: 'هذا ليس من الأحداث التي يرسلها بال‌سيرت.',
    WEBHOOK_IDEMPOTENCY_KEY_REQUIRED: 'حدث خلل أثناء إرسال الطلب. حاول مرة أخرى.',
    WEBHOOK_IDEMPOTENCY_KEY_CONFLICT: 'شخص آخر ينفّذ هذا الطلب بالفعل.',
    WEBHOOK_IDEMPOTENCY_KEY_REUSED: 'تغيّر الطلب أثناء إعادة المحاولة. ابدأ من جديد.',
    WEBHOOK_IDEMPOTENCY_KEY_EXPIRED:
      'لم يعد بالإمكان عرض ذلك المفتاح. استخدم التدوير للحصول على مفتاح جديد.',
    WEBHOOK_SECRET_NO_LONGER_RECOVERABLE:
      'لم يعد بالإمكان عرض ذلك المفتاح. استخدم التدوير للحصول على مفتاح جديد.',
    WEBHOOK_DELIVERY_NOT_REPLAYABLE: 'لا يمكن إعادة إرسال هذه الإرسالية.',
    WEBHOOK_TEST_DELIVERY_NOT_REPLAYABLE:
      'رسالة الاختبار لا تحمل حدثًا، فلا شيء لإعادة إرساله. أرسل اختبارًا جديدًا.',
  },
  genericError: 'حدث خطأ. حاول مرة أخرى.',
};

const CATALOGUE: Record<Locale, WebhooksMessages> = { en: EN, ar: AR };

export function getWebhooksMessages(locale: Locale): WebhooksMessages {
  return CATALOGUE[locale] ?? CATALOGUE[DEFAULT_LOCALE];
}

/** A label for a code, falling back to the code itself rather than to nothing. */
export function webhookLabel(labels: Readonly<Record<string, string>>, code: string): string {
  return labels[code] ?? code;
}
