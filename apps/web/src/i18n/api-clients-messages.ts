import { DEFAULT_LOCALE, type Locale } from './locales';

/**
 * What an administrator reads while running their own machine credentials
 * (Phase 19).
 *
 * Three wording rules run through all of it.
 *
 * **A secret is shown once, and the screen says so before it is shown.** Not
 * afterwards and not in a tooltip. If it is lost the only way forward is to
 * rotate, and the copy says that plainly rather than implying a recovery that
 * does not exist.
 *
 * **Name what each scope actually grants.** A person choosing "submissions"
 * should read what a holder of it can see, because the choice they are making
 * is about somebody else's thesis, not about a checkbox.
 *
 * **Distinguish disabling from revoking, every time both appear.** One is
 * reversible and keeps the secret; the other is final and kills it. A screen
 * that blurs them is a screen where somebody reaches for the wrong one during
 * an incident.
 */
export interface ApiClientsMessages {
  readonly navApiClients: string;
  readonly title: string;
  readonly intro: string;
  readonly empty: string;
  readonly loading: string;

  readonly createTitle: string;
  readonly createIntro: string;
  readonly displayNameLabel: string;
  readonly displayNameHint: string;
  readonly descriptionLabel: string;
  readonly scopesLabel: string;
  readonly scopesHint: string;
  readonly expiresAtLabel: string;
  readonly expiresAtHint: string;
  readonly create: string;
  readonly creating: string;

  readonly clientIdLabel: string;
  readonly statusLabel: string;
  readonly scopesColumn: string;
  readonly createdLabel: string;
  readonly expiresLabel: string;
  readonly lastUsedLabel: string;
  readonly neverUsed: string;
  readonly noExpiry: string;

  readonly rotate: string;
  readonly rotating: string;
  readonly rotateOverlapLabel: string;
  readonly rotateOverlapHint: string;
  readonly overlapEndsAt: string;
  readonly disable: string;
  readonly enable: string;
  readonly revoke: string;
  readonly revokeConfirm: string;
  readonly disableHint: string;

  readonly secretTitle: string;
  readonly secretWarning: string;
  readonly secretCopy: string;
  readonly secretCopied: string;
  readonly secretDismiss: string;
  readonly secretClientId: string;
  readonly secretPreviousRetires: string;
  readonly secretPreviousRetiredNow: string;

  readonly overlapChoices: Readonly<Record<string, string>>;
  readonly statuses: Readonly<Record<string, string>>;
  readonly scopeNames: Readonly<Record<string, string>>;
  readonly scopeDescriptions: Readonly<Record<string, string>>;
  readonly errors: Readonly<Record<string, string>>;
  readonly genericError: string;
}

const EN: ApiClientsMessages = {
  navApiClients: 'API clients',
  title: 'API clients',
  intro:
    'A credential your own systems use to read from PalCert. It belongs to this organization, ' +
    'never to a person, and it can only reach what the scopes you choose allow.',
  empty: 'No API clients yet.',
  loading: 'Loading…',

  createTitle: 'Create a client',
  createIntro:
    'You will be shown the secret once, when the client is created. Save it before you close ' +
    'the page — PalCert keeps only a one-way verifier and cannot show it again.',
  displayNameLabel: 'What this is for',
  displayNameHint:
    'A name your colleagues will recognize during an incident, such as the system that uses it.',
  descriptionLabel: 'Notes (optional)',
  scopesLabel: 'What it may read',
  scopesHint:
    'Choose the least that works. A credential is as dangerous as the widest scope it holds, ' +
    'and widening one later is a decision somebody makes on purpose.',
  expiresAtLabel: 'Stops working on (optional)',
  expiresAtHint:
    'Leave empty for a credential that does not expire. An expiry is a deadline you set now ' +
    'instead of a cleanup nobody remembers.',
  create: 'Create client',
  creating: 'Creating…',

  clientIdLabel: 'Client ID',
  statusLabel: 'Status',
  scopesColumn: 'Scopes',
  createdLabel: 'Created',
  expiresLabel: 'Expires',
  lastUsedLabel: 'Last used',
  neverUsed: 'Never used',
  noExpiry: 'Does not expire',

  rotate: 'Rotate secret',
  rotating: 'Rotating…',
  rotateOverlapLabel: 'Keep the old secret working for',
  rotateOverlapHint:
    'Long enough to deploy the new one, and no longer. During the overlap both secrets work; ' +
    'after it, only the new one. Choose no overlap to cut the old one off immediately.',
  overlapEndsAt: 'Previous secret stops working at',
  disable: 'Disable',
  enable: 'Enable',
  revoke: 'Revoke',
  revokeConfirm:
    'Revoking is permanent. Every secret stops working immediately and nothing brings this ' +
    'client back — you would create a new one and redeploy. Use Disable instead if you only ' +
    'need to pause it. Continue?',
  disableHint:
    'Disabling is reversible and the secret survives, so re-enabling does not mean redeploying. ' +
    'Revoking is final.',

  secretTitle: 'Your client secret',
  secretWarning:
    'This is the only time PalCert will show it. Save it now — if you lose it, the only way ' +
    'forward is to rotate, which means deploying a new secret.',
  secretCopy: 'Copy',
  secretCopied: 'Copied',
  secretDismiss: 'I have saved it',
  secretClientId: 'Client ID',
  secretPreviousRetires: 'The previous secret keeps working until',
  secretPreviousRetiredNow: 'The previous secret stopped working immediately.',

  overlapChoices: {
    '0': 'No overlap — cut the old secret off now',
    '900': '15 minutes',
    '3600': '1 hour',
    '21600': '6 hours',
    '43200': '12 hours (the longest allowed)',
  },
  statuses: {
    ACTIVE: 'Active',
    DISABLED: 'Disabled',
    REVOKED: 'Revoked',
  },
  scopeNames: {
    'organization:read': 'Organization and standards',
    'submissions:read': 'Submissions',
    'certificates:read': 'Certificates',
    'webhooks:read': 'Webhook configuration',
  },
  scopeDescriptions: {
    'organization:read':
      'This organization’s own profile, and the standards it has published. Not drafts.',
    'submissions:read':
      'Submissions sent to this organization and their decision history — the metadata, never ' +
      'the attached document, the report, or who submitted it.',
    'certificates:read':
      'Whether a certificate was issued, and its lifecycle. Never the certificate document and ' +
      'never the verification code.',
    'webhooks:read':
      'Whether your outbound integrations are configured and healthy. Never the destination URL ' +
      'and never a signing secret.',
  },
  errors: {
    API_CLIENT_NOT_FOUND: 'That client does not exist.',
    API_CLIENT_REVOKED: 'That client has been revoked, and revocation is final.',
    API_CLIENT_ROTATION_IN_PROGRESS:
      'A rotation is already running for this client. Wait for the overlap to end, then rotate ' +
      'again.',
    API_CLIENT_ROTATION_OVERLAP_TOO_LONG:
      'That overlap is too long. Pick something short enough to deploy in, up to twelve hours.',
    API_CLIENT_SCOPE_INVALID: 'That is not a scope PalCert offers.',
    API_CLIENT_SCOPES_REQUIRED: 'Choose at least one scope. A client with none could call nothing.',
    API_CLIENT_LIMIT_REACHED: 'You already have the maximum number of clients. Revoke one first.',
    API_CLIENT_EXPIRY_INVALID: 'Pick a date in the future, at most two years away.',
    API_CLIENT_IDEMPOTENCY_KEY_REQUIRED: 'Something went wrong sending that request. Try again.',
    API_CLIENT_IDEMPOTENCY_KEY_CONFLICT: 'That request is already running.',
    API_CLIENT_TRANSITION_INVALID: 'That change is not possible from the client’s current state.',
    API_CLIENT_OPERATION_NOT_PERMITTED: 'That operation is not one an API client may perform.',
    API_CLIENT_SECRET_NO_LONGER_RECOVERABLE:
      'That secret can no longer be shown. Rotate to get a new one.',
    FORBIDDEN: 'You do not have permission to manage API clients.',
  },
  genericError: 'Something went wrong. Please try again.',
};

const AR: ApiClientsMessages = {
  navApiClients: 'عملاء الواجهة البرمجية',
  title: 'عملاء الواجهة البرمجية',
  intro:
    'بيانات اعتماد تستخدمها أنظمتك للقراءة من بال‌سيرت. تعود إلى هذه المؤسسة لا إلى شخص، ولا ' +
    'تصل إلا إلى ما تسمح به النطاقات التي تختارها.',
  empty: 'لا يوجد عملاء بعد.',
  loading: 'جارٍ التحميل…',

  createTitle: 'إنشاء عميل',
  createIntro:
    'سيُعرض المفتاح مرة واحدة عند الإنشاء. احفظه قبل إغلاق الصفحة — لا يحتفظ بال‌سيرت إلا ' +
    'ببصمة أحادية الاتجاه ولا يمكنه عرضه مجددًا.',
  displayNameLabel: 'الغرض من هذا العميل',
  displayNameHint: 'اسم يتعرف عليه زملاؤك وقت الحوادث، مثل اسم النظام الذي يستخدمه.',
  descriptionLabel: 'ملاحظات (اختياري)',
  scopesLabel: 'ما يمكنه قراءته',
  scopesHint:
    'اختر أقل ما يكفي. خطورة بيانات الاعتماد بقدر أوسع نطاق تحمله، وتوسيع النطاق لاحقًا قرار ' +
    'يتخذه أحدهم عن عمد.',
  expiresAtLabel: 'يتوقف عن العمل في (اختياري)',
  expiresAtHint:
    'اتركه فارغًا لبيانات اعتماد لا تنتهي. تحديد موعد انتهاء الآن أفضل من تنظيف لا يتذكره أحد.',
  create: 'إنشاء العميل',
  creating: 'جارٍ الإنشاء…',

  clientIdLabel: 'معرّف العميل',
  statusLabel: 'الحالة',
  scopesColumn: 'النطاقات',
  createdLabel: 'أُنشئ في',
  expiresLabel: 'ينتهي في',
  lastUsedLabel: 'آخر استخدام',
  neverUsed: 'لم يُستخدم قط',
  noExpiry: 'لا ينتهي',

  rotate: 'تدوير المفتاح',
  rotating: 'جارٍ التدوير…',
  rotateOverlapLabel: 'أبقِ المفتاح القديم عاملًا لمدة',
  rotateOverlapHint:
    'مدة تكفي لنشر المفتاح الجديد، لا أكثر. خلال التداخل يعمل المفتاحان، وبعده يعمل الجديد ' +
    'وحده. اختر «بلا تداخل» لإيقاف القديم فورًا.',
  overlapEndsAt: 'يتوقف المفتاح السابق في',
  disable: 'تعطيل',
  enable: 'تفعيل',
  revoke: 'إبطال',
  revokeConfirm:
    'الإبطال نهائي. تتوقف كل المفاتيح فورًا ولا شيء يعيد هذا العميل — ستنشئ عميلًا جديدًا ' +
    'وتعيد النشر. استخدم «تعطيل» إن أردت إيقافه مؤقتًا فقط. هل تريد المتابعة؟',
  disableHint:
    'التعطيل قابل للتراجع ويبقى المفتاح صالحًا، فإعادة التفعيل لا تعني إعادة النشر. أما ' +
    'الإبطال فنهائي.',

  secretTitle: 'مفتاح العميل',
  secretWarning:
    'هذه المرة الوحيدة التي يعرضه فيها بال‌سيرت. احفظه الآن — إن فقدته فالسبيل الوحيد هو ' +
    'التدوير، أي نشر مفتاح جديد.',
  secretCopy: 'نسخ',
  secretCopied: 'تم النسخ',
  secretDismiss: 'حفظته',
  secretClientId: 'معرّف العميل',
  secretPreviousRetires: 'يبقى المفتاح السابق عاملًا حتى',
  secretPreviousRetiredNow: 'توقف المفتاح السابق فورًا.',

  overlapChoices: {
    '0': 'بلا تداخل — أوقف المفتاح القديم الآن',
    '900': '١٥ دقيقة',
    '3600': 'ساعة واحدة',
    '21600': 'ست ساعات',
    '43200': 'اثنتا عشرة ساعة (الحد الأقصى)',
  },
  statuses: {
    ACTIVE: 'نشط',
    DISABLED: 'معطّل',
    REVOKED: 'مُبطَل',
  },
  scopeNames: {
    'organization:read': 'المؤسسة والمعايير',
    'submissions:read': 'التقديمات',
    'certificates:read': 'الشهادات',
    'webhooks:read': 'إعداد الويب‌هوك',
  },
  scopeDescriptions: {
    'organization:read': 'ملف هذه المؤسسة والمعايير التي نشرتها. دون المسودات.',
    'submissions:read':
      'التقديمات المرسلة إلى هذه المؤسسة وسجل قراراتها — البيانات الوصفية فقط، دون المستند ' +
      'المرفق ولا التقرير ولا هوية مَن قدّمه.',
    'certificates:read': 'ما إذا صدرت شهادة ودورة حياتها. دون مستند الشهادة ودون رمز التحقق.',
    'webhooks:read':
      'ما إذا كانت وجهاتك الصادرة معدّة وسليمة. دون عنوان الوجهة ودون مفتاح التوقيع.',
  },
  errors: {
    API_CLIENT_NOT_FOUND: 'هذا العميل غير موجود.',
    API_CLIENT_REVOKED: 'أُبطل هذا العميل، والإبطال نهائي.',
    API_CLIENT_ROTATION_IN_PROGRESS:
      'هناك تدوير جارٍ لهذا العميل. انتظر انتهاء التداخل ثم أعد التدوير.',
    API_CLIENT_ROTATION_OVERLAP_TOO_LONG:
      'مدة التداخل طويلة أكثر من اللازم. اختر مدة تكفي للنشر، حتى اثنتي عشرة ساعة.',
    API_CLIENT_SCOPE_INVALID: 'ليس هذا نطاقًا يقدمه بال‌سيرت.',
    API_CLIENT_SCOPES_REQUIRED: 'اختر نطاقًا واحدًا على الأقل. عميل بلا نطاقات لا يستدعي شيئًا.',
    API_CLIENT_LIMIT_REACHED: 'بلغت الحد الأقصى من العملاء. أبطِل واحدًا أولًا.',
    API_CLIENT_EXPIRY_INVALID: 'اختر تاريخًا في المستقبل لا يتجاوز سنتين.',
    API_CLIENT_IDEMPOTENCY_KEY_REQUIRED: 'حدث خلل أثناء إرسال الطلب. حاول مرة أخرى.',
    API_CLIENT_IDEMPOTENCY_KEY_CONFLICT: 'هذا الطلب قيد التنفيذ بالفعل.',
    API_CLIENT_TRANSITION_INVALID: 'هذا التغيير غير ممكن من الحالة الراهنة للعميل.',
    API_CLIENT_OPERATION_NOT_PERMITTED: 'هذه العملية ليست مما يسمح به لعميل الواجهة البرمجية.',
    API_CLIENT_SECRET_NO_LONGER_RECOVERABLE:
      'لم يعد بالإمكان عرض ذلك المفتاح. استخدم التدوير للحصول على مفتاح جديد.',
    FORBIDDEN: 'لا تملك صلاحية إدارة عملاء الواجهة البرمجية.',
  },
  genericError: 'حدث خطأ. حاول مرة أخرى.',
};

const CATALOGUE: Record<Locale, ApiClientsMessages> = { en: EN, ar: AR };

export function getApiClientsMessages(locale: Locale): ApiClientsMessages {
  return CATALOGUE[locale] ?? CATALOGUE[DEFAULT_LOCALE];
}

/** A label for a code, falling back to the code itself rather than to nothing. */
export function apiClientLabel(labels: Readonly<Record<string, string>>, code: string): string {
  return labels[code] ?? code;
}
