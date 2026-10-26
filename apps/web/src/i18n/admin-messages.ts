import type { Locale } from './locales';

/**
 * The PalCert staff console.
 *
 * Staff read this, not the public, but the same rules hold: every figure on a
 * screen is one the API returned, and every action says what it will do before
 * it does it. Status names come from the shared catalogues (organization,
 * account, balance, billing) so staff and customers see the same words for the
 * same state.
 */
export interface AdminMessages {
  readonly groupLabel: string;
  readonly nav: {
    readonly overview: string;
    readonly organizations: string;
    readonly users: string;
    readonly finance: string;
  };
  readonly forbiddenTitle: string;
  readonly forbiddenBody: string;
  readonly reauthTitle: string;
  readonly reauthBody: string;
  readonly reauthAction: string;

  readonly common: {
    readonly cancel: string;
    readonly close: string;
    readonly loading: string;
    readonly loadMore: string;
    readonly search: string;
    readonly clear: string;
    readonly open: string;
    readonly never: string;
    readonly yes: string;
    readonly no: string;
    readonly optional: string;
    readonly retry: string;
  };

  readonly overview: {
    readonly title: string;
    readonly intro: string;
    readonly organizations: string;
    readonly users: string;
    readonly total: string;
    readonly pendingVerification: string;
    readonly byStatus: string;
    readonly byVerification: string;
    readonly reviewQueue: string;
    readonly asOf: string;
    readonly shortcuts: string;
  };

  readonly organizations: {
    readonly title: string;
    readonly intro: string;
    readonly tabAll: string;
    readonly tabQueue: string;
    readonly tabsLabel: string;
    readonly name: string;
    readonly type: string;
    readonly status: string;
    readonly verification: string;
    readonly country: string;
    readonly created: string;
    readonly requestedAt: string;
    readonly note: string;
    readonly empty: string;
    readonly queueEmpty: string;
    readonly review: string;
  };

  readonly organization: {
    readonly profile: string;
    readonly legalName: string;
    readonly slug: string;
    readonly website: string;
    readonly defaultLocale: string;
    readonly timezone: string;
    readonly members: string;
    readonly updated: string;
    readonly standing: string;
    readonly suspendedAt: string;
    readonly suspensionReason: string;
    readonly suspend: string;
    readonly suspendIntro: string;
    readonly suspendReason: string;
    readonly suspended: string;
    readonly reactivate: string;
    readonly reactivateIntro: string;
    readonly reactivated: string;
    readonly closedNote: string;
    readonly verificationTitle: string;
    readonly history: string;
    readonly noRequests: string;
    readonly submissionNote: string;
    readonly reviewedAt: string;
    readonly decisionReason: string;
    readonly internalNotes: string;
    readonly pendingRequest: string;
    readonly approve: string;
    readonly reject: string;
    readonly approveIntro: string;
    readonly rejectIntro: string;
    readonly decisionReasonLabel: string;
    readonly decisionReasonHint: string;
    readonly internalNotesLabel: string;
    readonly internalNotesHint: string;
    readonly approved: string;
    readonly rejected: string;
    readonly requestStatuses: Readonly<Record<string, string>>;
  };

  readonly users: {
    readonly title: string;
    readonly intro: string;
    readonly searchLabel: string;
    readonly searchHint: string;
    readonly name: string;
    readonly email: string;
    readonly status: string;
    readonly emailVerified: string;
    readonly created: string;
    readonly lastLogin: string;
    readonly empty: string;
    readonly noMatches: string;
  };

  readonly user: {
    readonly account: string;
    readonly roles: string;
    readonly noRoles: string;
    readonly mfa: string;
    readonly mfaOn: string;
    readonly mfaOff: string;
    readonly mfaRequired: string;
    readonly grantRole: string;
    readonly grantIntro: string;
    readonly privilegedWarning: string;
    readonly roleLabel: string;
    readonly granted: string;
    readonly removeRole: string;
    readonly removeIntro: string;
    readonly removed: string;
    readonly suspend: string;
    readonly suspendIntro: string;
    readonly suspendReason: string;
    readonly suspended: string;
    readonly reactivate: string;
    readonly reactivateIntro: string;
    readonly reactivated: string;
    readonly yourself: string;
    readonly finance: string;
    readonly viewFinance: string;
  };

  readonly finance: {
    readonly title: string;
    readonly intro: string;
    readonly prices: string;
    readonly pricesIntro: string;
    readonly product: string;
    readonly market: string;
    readonly amount: string;
    readonly status: string;
    readonly effectiveFrom: string;
    readonly created: string;
    readonly noPrices: string;
    readonly draftPrice: string;
    readonly draftIntro: string;
    readonly currency: string;
    readonly amountHint: string;
    readonly marketLabel: string;
    readonly marketHint: string;
    readonly createDraft: string;
    readonly drafted: string;
    readonly activate: string;
    readonly activateIntro: string;
    readonly activated: string;
    readonly retire: string;
    readonly retireIntro: string;
    readonly retired: string;
    readonly invalidAmount: string;
    readonly ledger: string;
    readonly ledgerIntro: string;
    readonly runCheck: string;
    readonly checking: string;
    readonly consistent: string;
    readonly inconsistent: string;
    readonly accountsChecked: string;
    readonly entriesChecked: string;
    readonly findings: string;
    readonly customers: string;
    readonly customersIntro: string;
    readonly findCustomer: string;
    readonly refundLookup: string;
    readonly refundLookupIntro: string;
    readonly refundId: string;
    readonly lookup: string;
    readonly invalidId: string;
    readonly aiServices: string;
    readonly standardServices: string;
    readonly aiTag: string;
    readonly purchases: string;
    readonly purchasesIntro: string;
    readonly currencyNote: string;
    readonly allProducts: string;
    readonly from: string;
    readonly to: string;
    readonly applyFilters: string;
    readonly purchaseCount: string;
    readonly reservedCol: string;
    readonly capturedCol: string;
    readonly releasedCol: string;
    readonly refundedCol: string;
    readonly revenue: string;
    readonly noPurchases: string;
    readonly recentPurchases: string;
    readonly recentPurchasesIntro: string;
    readonly payer: string;
    readonly organization: string;
    readonly personalUse: string;
    readonly createdCol: string;
    readonly completedCol: string;
    readonly invalidRange: string;
  };

  readonly customer: {
    readonly title: string;
    readonly intro: string;
    readonly balance: string;
    readonly available: string;
    readonly reserved: string;
    readonly cash: string;
    readonly promotional: string;
    readonly payments: string;
    readonly noPayments: string;
    readonly paymentAmount: string;
    readonly paymentStatus: string;
    readonly paymentCreated: string;
    readonly purchases: string;
    readonly noPurchases: string;
    readonly purchaseAmount: string;
    readonly purchaseCharged: string;
    readonly purchaseStatus: string;
    readonly allocations: string;
    readonly refund: string;
    readonly refundIntro: string;
    readonly refundAmount: string;
    readonly refundReason: string;
    readonly refundCreated: string;
    readonly adjust: string;
    readonly adjustIntro: string;
    readonly direction: string;
    readonly credit: string;
    readonly debit: string;
    readonly creditClass: string;
    readonly reasonCode: string;
    readonly note: string;
    readonly adjusted: string;
    readonly backToUser: string;
  };

  readonly products: Readonly<Record<string, string>>;
  readonly priceStatuses: Readonly<Record<string, string>>;
  readonly refundReasons: Readonly<Record<string, string>>;
  readonly creditClasses: Readonly<Record<string, string>>;
  readonly errors: Readonly<Record<string, string>>;
  readonly genericError: string;
}

const en: AdminMessages = {
  groupLabel: 'Administration',
  nav: {
    overview: 'Overview',
    organizations: 'Organizations',
    users: 'Users',
    finance: 'Finance',
  },
  forbiddenTitle: 'For PalCert staff only',
  forbiddenBody:
    'This part of PalCert is for PalCert staff. If you need access, ask a PalCert administrator.',
  reauthTitle: 'Please sign in again',
  reauthBody:
    'This action needs a recent sign-in. Sign in again and you will come straight back here.',
  reauthAction: 'Sign in again',

  common: {
    cancel: 'Cancel',
    close: 'Close',
    loading: 'Loading…',
    loadMore: 'Show more',
    search: 'Search',
    clear: 'Clear',
    open: 'Open',
    never: 'Never',
    yes: 'Yes',
    no: 'No',
    optional: 'Optional',
    retry: 'Try again',
  },

  overview: {
    title: 'Administration',
    intro: 'The platform as the database reports it right now.',
    organizations: 'Organizations',
    users: 'Accounts',
    total: 'Total',
    pendingVerification: 'Awaiting verification review',
    byStatus: 'By status',
    byVerification: 'By verification',
    reviewQueue: 'Open the review queue',
    asOf: 'Counted at',
    shortcuts: 'Go to',
  },

  organizations: {
    title: 'Organizations',
    intro: 'Every organization on PalCert, newest first, and the ones waiting for verification.',
    tabAll: 'All organizations',
    tabQueue: 'Verification queue',
    tabsLabel: 'Organization lists',
    name: 'Organization',
    type: 'Type',
    status: 'Status',
    verification: 'Verification',
    country: 'Country',
    created: 'Created',
    requestedAt: 'Requested',
    note: 'Note from the organization',
    empty: 'No organizations yet.',
    queueEmpty: 'Nothing is waiting for verification review.',
    review: 'Review',
  },

  organization: {
    profile: 'Profile',
    legalName: 'Legal name',
    slug: 'Address name',
    website: 'Website',
    defaultLocale: 'Default language',
    timezone: 'Time zone',
    members: 'Active members',
    updated: 'Last updated',
    standing: 'Standing',
    suspendedAt: 'Suspended on',
    suspensionReason: 'Reason given',
    suspend: 'Suspend organization',
    suspendIntro:
      'Every organization-scoped action stops immediately: its members cannot review, publish ' +
      'or manage anything in it. Their PalCert accounts and other organizations are not affected. ' +
      'You can reactivate it later.',
    suspendReason: 'Reason (recorded, shown to staff)',
    suspended: 'The organization is suspended.',
    reactivate: 'Reactivate organization',
    reactivateIntro: 'The organization and its members can work in it again straight away.',
    reactivated: 'The organization is active again.',
    closedNote: 'This organization is closed. A closed organization cannot be reopened.',
    verificationTitle: 'Verification',
    history: 'Request history',
    noRequests: 'This organization has never asked to be verified.',
    submissionNote: 'Their note',
    reviewedAt: 'Decided on',
    decisionReason: 'Reason given to them',
    internalNotes: 'Internal notes',
    pendingRequest: 'A verification request is waiting for a decision.',
    approve: 'Approve verification',
    reject: 'Reject verification',
    approveIntro:
      'The organization becomes verified. It can then accept official submissions and publish ' +
      'standards to the check catalogue.',
    rejectIntro:
      'The request is declined. The organization stays active and may ask again. Tell them ' +
      'what to fix.',
    decisionReasonLabel: 'Reason shown to the organization',
    decisionReasonHint: 'They will read this. Up to 1,000 characters.',
    internalNotesLabel: 'Internal notes',
    internalNotesHint: 'Only PalCert staff see these. Up to 2,000 characters.',
    approved: 'The organization is verified.',
    rejected: 'The verification request was rejected.',
    requestStatuses: {
      PENDING: 'Waiting for review',
      APPROVED: 'Approved',
      REJECTED: 'Rejected',
      CANCELLED: 'Withdrawn',
    },
  },

  users: {
    title: 'Users',
    intro: 'PalCert accounts, newest first.',
    searchLabel: 'Find an account',
    searchHint: 'Part of an email address or a name.',
    name: 'Account',
    email: 'Email address',
    status: 'Status',
    emailVerified: 'Email confirmed',
    created: 'Created',
    lastLogin: 'Last sign-in',
    empty: 'No accounts yet.',
    noMatches: 'No account matches this search.',
  },

  user: {
    account: 'Account',
    roles: 'PalCert roles',
    noRoles: 'No PalCert-wide roles.',
    mfa: 'Two-step sign-in',
    mfaOn: 'Enabled',
    mfaOff: 'Not enabled',
    mfaRequired: 'Required by role',
    grantRole: 'Grant a role',
    grantIntro:
      'The account gains every permission of this role at once. Organization roles are granted ' +
      'by each organization, not here.',
    privilegedWarning:
      'This is a staff role. The account must use two-step sign-in, and granting it needs a ' +
      'recent sign-in.',
    roleLabel: 'Role',
    granted: 'The role was granted.',
    removeRole: 'Remove role',
    removeIntro: 'The account loses this role’s permissions immediately.',
    removed: 'The role was removed.',
    suspend: 'Suspend account',
    suspendIntro:
      'Every session this account holds ends now, and it cannot sign in until it is reactivated.',
    suspendReason: 'Reason (recorded)',
    suspended: 'The account is suspended.',
    reactivate: 'Reactivate account',
    reactivateIntro: 'The account can sign in again.',
    reactivated: 'The account is active again.',
    yourself:
      'This is your own account. Its status and roles are changed by another administrator.',
    finance: 'Money',
    viewFinance: 'Balance, payments and purchases',
  },

  finance: {
    title: 'Finance',
    intro:
      'Prices, the ledger check, and each customer’s money. Reading, pricing, refunding and ' +
      'adjusting are separate permissions.',
    prices: 'Prices',
    pricesIntro:
      'Every price version, current and past. A draft charges nobody; putting it into force ' +
      'retires the one before it in the same step.',
    product: 'Service',
    market: 'Market',
    amount: 'Amount',
    status: 'Status',
    effectiveFrom: 'In force from',
    created: 'Created',
    noPrices: 'No prices have been set.',
    draftPrice: 'Draft a price',
    draftIntro: 'A draft is not quoted to anyone until it is put into force.',
    currency: 'Currency',
    amountHint: 'In whole units, for example 12.50.',
    marketLabel: 'Market code',
    marketHint: 'Leave empty for the default market. Capital letters, digits and _.',
    createDraft: 'Save draft',
    drafted: 'The draft price was saved.',
    activate: 'Put into force',
    activateIntro:
      'This price is quoted from now on and the current price for the same service and market is ' +
      'retired. Its amount can never change after this.',
    activated: 'The price is in force.',
    retire: 'Retire',
    retireIntro:
      'The price stops being quoted. What customers were charged under it does not change.',
    retired: 'The price was retired.',
    invalidAmount: 'Enter an amount with no more decimal places than the currency has.',
    ledger: 'Ledger check',
    ledgerIntro:
      'Replays every account from its entries and checks each payment, charge and refund left ' +
      'exactly one ledger row. It reads only; it never repairs anything.',
    runCheck: 'Run the check',
    checking: 'Checking…',
    consistent: 'Consistent: no discrepancies found.',
    inconsistent: 'Discrepancies found. Each needs a person to understand it.',
    accountsChecked: 'Accounts checked',
    entriesChecked: 'Entries checked',
    findings: 'Findings',
    customers: 'A customer’s money',
    customersIntro: 'Find the account under Users, then open its balance, payments and purchases.',
    findCustomer: 'Find an account',
    refundLookup: 'Look up a refund',
    refundLookupIntro: 'Paste a refund reference to see where it stands.',
    refundId: 'Refund reference',
    lookup: 'Look up',
    invalidId: 'That is not a valid reference.',
    aiServices: 'AI services',
    standardServices: 'Document services',
    aiTag: 'AI',
    purchases: 'Purchases by product',
    purchasesIntro:
      'What customers reserved, were charged and had released, per product and currency. Figures come from service purchases and the ledger; there is no separate AI revenue record.',
    currencyNote:
      'Each currency is its own row. Amounts in different currencies are never added together.',
    allProducts: 'All products',
    from: 'From',
    to: 'To',
    applyFilters: 'Show',
    purchaseCount: 'Purchases',
    reservedCol: 'Reserved',
    capturedCol: 'Completed and charged',
    releasedCol: 'Released, not charged',
    refundedCol: 'Refunded',
    revenue: 'Captured revenue',
    noPurchases: 'No purchases match these filters.',
    recentPurchases: 'Recent purchases',
    recentPurchasesIntro:
      'The newest purchases for these filters. For organization AI work the payer is the person who started it; the organization is shown for context and paid nothing.',
    payer: 'Paid by',
    organization: 'Organization',
    personalUse: 'Personal',
    createdCol: 'Started',
    completedCol: 'Completed',
    invalidRange: 'The start date must be on or before the end date.',
  },

  customer: {
    title: 'Customer finance',
    intro: 'Read from the ledger. Adjusting and refunding each append a reasoned, audited entry.',
    balance: 'Balance',
    available: 'Available',
    reserved: 'Reserved',
    cash: 'Paid credit',
    promotional: 'Promotional credit',
    payments: 'Payments',
    noPayments: 'No payments.',
    paymentAmount: 'Amount',
    paymentStatus: 'Status',
    paymentCreated: 'Started',
    purchases: 'Purchases',
    noPurchases: 'No purchases.',
    purchaseAmount: 'Price',
    purchaseCharged: 'Charged',
    purchaseStatus: 'Status',
    allocations: 'Paid from',
    refund: 'Refund',
    refundIntro:
      'The customer’s paid credit is reserved first, so it cannot be spent while the refund ' +
      'settles. Never more than the payment, and never promotional credit.',
    refundAmount: 'Amount to refund',
    refundReason: 'Reason',
    refundCreated: 'The refund was requested.',
    adjust: 'Adjust balance',
    adjustIntro:
      'Adds a ledger entry with a reason. Existing entries are never edited; a correction is a ' +
      'new, opposite entry.',
    direction: 'Direction',
    credit: 'Credit the customer',
    debit: 'Debit the customer',
    creditClass: 'Credit type',
    reasonCode: 'Reason',
    note: 'Note for the record',
    adjusted: 'The adjustment was recorded.',
    backToUser: 'Back to the account',
  },

  products: {
    DOCUMENT_CHECK: 'Document check',
    SMARTFIX: 'SmartFix',
    EXPERTFIX: 'ExpertFix',
    AI_REVIEW: 'AI Review',
    AI_RULE_EXTRACTION: 'AI Rule Extraction',
  },
  priceStatuses: {
    DRAFT: 'Draft',
    ACTIVE: 'In force',
    RETIRED: 'Retired',
  },
  refundReasons: {
    REQUESTED_BY_CUSTOMER: 'Requested by the customer',
    DUPLICATE: 'Duplicate payment',
    FRAUDULENT: 'Fraudulent payment',
    SERVICE_NOT_DELIVERED: 'Service not delivered',
    GOODWILL: 'Goodwill',
  },
  creditClasses: {
    CASH: 'Paid credit',
    PROMOTIONAL: 'Promotional credit',
  },
  errors: {
    PERMISSION_DENIED: 'Your role does not allow this.',
    REAUTHENTICATION_REQUIRED: 'This action needs a recent sign-in.',
    ORGANIZATION_NOT_FOUND: 'That organization does not exist.',
    NOT_FOUND: 'That record does not exist.',
    CONFLICT: 'That change is not possible in the current state. Refresh and try again.',
    VALIDATION_FAILED: 'Some of the details are not valid.',
    PRICE_ALREADY_ACTIVE: 'That price is already in force.',
    PRICE_IMMUTABLE: 'A price in force cannot be changed.',
    REFUND_EXCEEDS_REMAINING: 'That is more than is left to refund on this payment.',
    REFUND_NOT_ELIGIBLE: 'This payment cannot be refunded.',
    INSUFFICIENT_BALANCE: 'The customer has already spent that credit.',
    RATE_LIMITED: 'Too many requests. Please wait a moment.',
    UNAUTHENTICATED: 'Your session has ended. Please sign in again.',
    SESSION_EXPIRED: 'Your session has ended. Please sign in again.',
  },
  genericError: 'Something went wrong. Please try again.',
};

const ar: AdminMessages = {
  groupLabel: 'الإدارة',
  nav: {
    overview: 'نظرة عامة',
    organizations: 'المؤسسات',
    users: 'المستخدمون',
    finance: 'المالية',
  },
  forbiddenTitle: 'لفريق بال‌سيرت فقط',
  forbiddenBody:
    'هذا الجزء من بال‌سيرت مخصّص لفريق بال‌سيرت. إن كنت تحتاج إلى الوصول فاطلبه من أحد مسؤولي بال‌سيرت.',
  reauthTitle: 'يرجى تسجيل الدخول مجددًا',
  reauthBody:
    'يتطلب هذا الإجراء تسجيل دخول حديثًا. سجّل الدخول مجددًا وستعود إلى هذه الصفحة مباشرة.',
  reauthAction: 'تسجيل الدخول مجددًا',

  common: {
    cancel: 'إلغاء',
    close: 'إغلاق',
    loading: 'جارٍ التحميل…',
    loadMore: 'عرض المزيد',
    search: 'بحث',
    clear: 'مسح',
    open: 'فتح',
    never: 'أبدًا',
    yes: 'نعم',
    no: 'لا',
    optional: 'اختياري',
    retry: 'حاول مجددًا',
  },

  overview: {
    title: 'الإدارة',
    intro: 'المنصّة كما تُظهرها قاعدة البيانات الآن.',
    organizations: 'المؤسسات',
    users: 'الحسابات',
    total: 'الإجمالي',
    pendingVerification: 'بانتظار مراجعة التوثيق',
    byStatus: 'حسب الحالة',
    byVerification: 'حسب التوثيق',
    reviewQueue: 'فتح قائمة المراجعة',
    asOf: 'وقت الإحصاء',
    shortcuts: 'انتقل إلى',
  },

  organizations: {
    title: 'المؤسسات',
    intro: 'جميع المؤسسات على بال‌سيرت، الأحدث أولًا، والمؤسسات التي تنتظر التوثيق.',
    tabAll: 'جميع المؤسسات',
    tabQueue: 'قائمة التوثيق',
    tabsLabel: 'قوائم المؤسسات',
    name: 'المؤسسة',
    type: 'النوع',
    status: 'الحالة',
    verification: 'التوثيق',
    country: 'الدولة',
    created: 'تاريخ الإنشاء',
    requestedAt: 'تاريخ الطلب',
    note: 'ملاحظة المؤسسة',
    empty: 'لا توجد مؤسسات بعد.',
    queueEmpty: 'لا توجد طلبات بانتظار مراجعة التوثيق.',
    review: 'مراجعة',
  },

  organization: {
    profile: 'الملف',
    legalName: 'الاسم القانوني',
    slug: 'اسم العنوان',
    website: 'الموقع الإلكتروني',
    defaultLocale: 'اللغة الافتراضية',
    timezone: 'المنطقة الزمنية',
    members: 'الأعضاء النشطون',
    updated: 'آخر تحديث',
    standing: 'الوضع',
    suspendedAt: 'تاريخ الإيقاف',
    suspensionReason: 'السبب المذكور',
    suspend: 'إيقاف المؤسسة',
    suspendIntro:
      'تتوقف فورًا كل الإجراءات الخاصة بالمؤسسة: لا يستطيع أعضاؤها المراجعة أو النشر أو الإدارة فيها. ' +
      'ولا تتأثر حساباتهم في بال‌سيرت ولا مؤسساتهم الأخرى. ويمكنك إعادة تفعيلها لاحقًا.',
    suspendReason: 'السبب (يُسجَّل ويظهر لفريق بال‌سيرت)',
    suspended: 'تم إيقاف المؤسسة.',
    reactivate: 'إعادة تفعيل المؤسسة',
    reactivateIntro: 'تستطيع المؤسسة وأعضاؤها العمل فيها مجددًا فورًا.',
    reactivated: 'عادت المؤسسة نشطة.',
    closedNote: 'هذه المؤسسة مغلقة، ولا يمكن إعادة فتح مؤسسة مغلقة.',
    verificationTitle: 'التوثيق',
    history: 'سجل الطلبات',
    noRequests: 'لم تطلب هذه المؤسسة التوثيق من قبل.',
    submissionNote: 'ملاحظتهم',
    reviewedAt: 'تاريخ القرار',
    decisionReason: 'السبب المُبلَّغ لهم',
    internalNotes: 'ملاحظات داخلية',
    pendingRequest: 'يوجد طلب توثيق بانتظار القرار.',
    approve: 'اعتماد التوثيق',
    reject: 'رفض التوثيق',
    approveIntro:
      'تصبح المؤسسة موثّقة، فيمكنها عندئذٍ استقبال التقديمات الرسمية ونشر معاييرها في فهرس الفحص.',
    rejectIntro: 'يُرفض الطلب وتبقى المؤسسة نشطة ويمكنها الطلب مجددًا. أخبرهم بما يلزم تصحيحه.',
    decisionReasonLabel: 'السبب الذي يظهر للمؤسسة',
    decisionReasonHint: 'سيقرؤونه. حتى 1000 حرف.',
    internalNotesLabel: 'ملاحظات داخلية',
    internalNotesHint: 'لا يراها إلا فريق بال‌سيرت. حتى 2000 حرف.',
    approved: 'أصبحت المؤسسة موثّقة.',
    rejected: 'تم رفض طلب التوثيق.',
    requestStatuses: {
      PENDING: 'بانتظار المراجعة',
      APPROVED: 'مقبول',
      REJECTED: 'مرفوض',
      CANCELLED: 'مسحوب',
    },
  },

  users: {
    title: 'المستخدمون',
    intro: 'حسابات بال‌سيرت، الأحدث أولًا.',
    searchLabel: 'البحث عن حساب',
    searchHint: 'جزء من عنوان البريد الإلكتروني أو من الاسم.',
    name: 'الحساب',
    email: 'البريد الإلكتروني',
    status: 'الحالة',
    emailVerified: 'البريد مؤكَّد',
    created: 'تاريخ الإنشاء',
    lastLogin: 'آخر تسجيل دخول',
    empty: 'لا توجد حسابات بعد.',
    noMatches: 'لا يوجد حساب يطابق هذا البحث.',
  },

  user: {
    account: 'الحساب',
    roles: 'أدوار بال‌سيرت',
    noRoles: 'لا توجد أدوار على مستوى بال‌سيرت.',
    mfa: 'التحقق بخطوتين',
    mfaOn: 'مفعّل',
    mfaOff: 'غير مفعّل',
    mfaRequired: 'إلزامي بحكم الدور',
    grantRole: 'منح دور',
    grantIntro:
      'يحصل الحساب على جميع صلاحيات هذا الدور فورًا. أما أدوار المؤسسات فتمنحها كل مؤسسة، لا من هنا.',
    privilegedWarning:
      'هذا دور لفريق بال‌سيرت. يجب أن يستخدم الحساب التحقق بخطوتين، ويتطلب منحه تسجيل دخول حديثًا.',
    roleLabel: 'الدور',
    granted: 'تم منح الدور.',
    removeRole: 'إزالة الدور',
    removeIntro: 'يفقد الحساب صلاحيات هذا الدور فورًا.',
    removed: 'تمت إزالة الدور.',
    suspend: 'إيقاف الحساب',
    suspendIntro: 'تنتهي الآن كل جلسات هذا الحساب، ولا يمكنه تسجيل الدخول حتى تُعاد تفعيله.',
    suspendReason: 'السبب (يُسجَّل)',
    suspended: 'تم إيقاف الحساب.',
    reactivate: 'إعادة تفعيل الحساب',
    reactivateIntro: 'يستطيع الحساب تسجيل الدخول مجددًا.',
    reactivated: 'عاد الحساب نشطًا.',
    yourself: 'هذا حسابك أنت. يغيّر حالته وأدواره مسؤول آخر.',
    finance: 'الأموال',
    viewFinance: 'الرصيد والدفعات والمشتريات',
  },

  finance: {
    title: 'المالية',
    intro:
      'الأسعار، وفحص دفتر الأستاذ، وأموال كل عميل. القراءة والتسعير والاسترداد والتسوية صلاحيات منفصلة.',
    prices: 'الأسعار',
    pricesIntro:
      'كل إصدارات الأسعار، الحالية والسابقة. المسودة لا تُحتسب على أحد، ووضعها موضع التنفيذ يُنهي السعر ' +
      'السابق في الخطوة نفسها.',
    product: 'الخدمة',
    market: 'السوق',
    amount: 'المبلغ',
    status: 'الحالة',
    effectiveFrom: 'ساري من',
    created: 'تاريخ الإنشاء',
    noPrices: 'لم تُحدَّد أي أسعار.',
    draftPrice: 'مسودة سعر',
    draftIntro: 'لا تُعرض المسودة على أحد حتى توضع موضع التنفيذ.',
    currency: 'العملة',
    amountHint: 'بالوحدات الكاملة، مثل 12.50.',
    marketLabel: 'رمز السوق',
    marketHint: 'اتركه فارغًا للسوق الافتراضية. أحرف لاتينية كبيرة وأرقام و_.',
    createDraft: 'حفظ المسودة',
    drafted: 'تم حفظ مسودة السعر.',
    activate: 'وضعه موضع التنفيذ',
    activateIntro:
      'يُعتمد هذا السعر من الآن ويُنهى السعر الحالي للخدمة والسوق نفسيهما. ولا يمكن تغيير مبلغه بعد ذلك أبدًا.',
    activated: 'أصبح السعر ساريًا.',
    retire: 'إنهاء',
    retireIntro: 'يتوقف عرض هذا السعر، ولا يتغيّر ما دفعه العملاء بموجبه.',
    retired: 'تم إنهاء السعر.',
    invalidAmount: 'أدخل مبلغًا لا تزيد منازله العشرية على منازل العملة.',
    ledger: 'فحص دفتر الأستاذ',
    ledgerIntro:
      'يعيد بناء كل حساب من قيوده ويتحقق من أن كل دفعة وخصم واسترداد أنتج قيدًا واحدًا بالضبط. ' +
      'هو للقراءة فقط ولا يصلح شيئًا.',
    runCheck: 'تشغيل الفحص',
    checking: 'جارٍ الفحص…',
    consistent: 'متّسق: لم يُعثر على أي فروق.',
    inconsistent: 'عُثر على فروق، ويحتاج كل منها إلى شخص يفهمه.',
    accountsChecked: 'الحسابات المفحوصة',
    entriesChecked: 'القيود المفحوصة',
    findings: 'النتائج',
    customers: 'أموال عميل',
    customersIntro: 'ابحث عن الحساب في صفحة المستخدمين، ثم افتح رصيده ودفعاته ومشترياته.',
    findCustomer: 'البحث عن حساب',
    refundLookup: 'الاستعلام عن استرداد',
    refundLookupIntro: 'الصق مرجع الاسترداد لمعرفة حالته.',
    refundId: 'مرجع الاسترداد',
    lookup: 'استعلام',
    invalidId: 'هذا المرجع غير صالح.',
    aiServices: 'خدمات الذكاء الاصطناعي',
    standardServices: 'خدمات المستندات',
    aiTag: 'ذكاء اصطناعي',
    purchases: 'المشتريات حسب الخدمة',
    purchasesIntro:
      'ما حجزه العملاء وما خُصم منهم وما أُعيد إليهم، لكل خدمة وعملة. الأرقام مأخوذة من مشتريات الخدمات ودفتر الأستاذ، ولا يوجد سجل منفصل لإيرادات الذكاء الاصطناعي.',
    currencyNote: 'لكل عملة صف مستقل. لا تُجمع المبالغ بعملات مختلفة معاً أبداً.',
    allProducts: 'كل الخدمات',
    from: 'من',
    to: 'إلى',
    applyFilters: 'عرض',
    purchaseCount: 'المشتريات',
    reservedCol: 'محجوز',
    capturedCol: 'مكتمل ومخصوم',
    releasedCol: 'أُعيد دون خصم',
    refundedCol: 'مسترد',
    revenue: 'الإيراد المحصّل',
    noPurchases: 'لا توجد مشتريات تطابق هذه المرشحات.',
    recentPurchases: 'أحدث المشتريات',
    recentPurchasesIntro:
      'أحدث المشتريات وفق هذه المرشحات. في أعمال الذكاء الاصطناعي للمؤسسات يكون الدافع هو من بدأ العمل، وتظهر المؤسسة للتوضيح فقط ولم تدفع شيئاً.',
    payer: 'الدافع',
    organization: 'المؤسسة',
    personalUse: 'شخصي',
    createdCol: 'بدأ',
    completedCol: 'اكتمل',
    invalidRange: 'يجب أن يكون تاريخ البداية في تاريخ النهاية أو قبله.',
  },

  customer: {
    title: 'مالية العميل',
    intro: 'مقروءة من دفتر الأستاذ. وكل تسوية أو استرداد يضيف قيدًا مسبَّبًا ومدقَّقًا.',
    balance: 'الرصيد',
    available: 'المتاح',
    reserved: 'المحجوز',
    cash: 'رصيد مدفوع',
    promotional: 'رصيد ترويجي',
    payments: 'الدفعات',
    noPayments: 'لا توجد دفعات.',
    paymentAmount: 'المبلغ',
    paymentStatus: 'الحالة',
    paymentCreated: 'تاريخ البدء',
    purchases: 'المشتريات',
    noPurchases: 'لا توجد مشتريات.',
    purchaseAmount: 'السعر',
    purchaseCharged: 'المُحصَّل',
    purchaseStatus: 'الحالة',
    allocations: 'مصدر الدفع',
    refund: 'استرداد',
    refundIntro:
      'يُحجز الرصيد المدفوع للعميل أولًا حتى لا يُنفق أثناء إتمام الاسترداد. ولا يتجاوز المبلغ الدفعة، ' +
      'ولا يشمل الرصيد الترويجي أبدًا.',
    refundAmount: 'المبلغ المسترد',
    refundReason: 'السبب',
    refundCreated: 'تم طلب الاسترداد.',
    adjust: 'تسوية الرصيد',
    adjustIntro: 'يضيف قيدًا مع سببه. لا تُعدَّل القيود القائمة أبدًا؛ والتصحيح قيد جديد معاكس.',
    direction: 'الاتجاه',
    credit: 'إضافة إلى رصيد العميل',
    debit: 'خصم من رصيد العميل',
    creditClass: 'نوع الرصيد',
    reasonCode: 'السبب',
    note: 'ملاحظة للسجل',
    adjusted: 'تم تسجيل التسوية.',
    backToUser: 'العودة إلى الحساب',
  },

  products: {
    DOCUMENT_CHECK: 'فحص مستند',
    SMARTFIX: 'SmartFix',
    EXPERTFIX: 'ExpertFix',
    AI_REVIEW: 'المراجعة بالذكاء الاصطناعي',
    AI_RULE_EXTRACTION: 'استخراج القواعد بالذكاء الاصطناعي',
  },
  priceStatuses: {
    DRAFT: 'مسودة',
    ACTIVE: 'ساري',
    RETIRED: 'منتهٍ',
  },
  refundReasons: {
    REQUESTED_BY_CUSTOMER: 'بطلب من العميل',
    DUPLICATE: 'دفعة مكررة',
    FRAUDULENT: 'دفعة احتيالية',
    SERVICE_NOT_DELIVERED: 'لم تُقدَّم الخدمة',
    GOODWILL: 'حسن نية',
  },
  creditClasses: {
    CASH: 'رصيد مدفوع',
    PROMOTIONAL: 'رصيد ترويجي',
  },
  errors: {
    PERMISSION_DENIED: 'لا يسمح دورك بذلك.',
    REAUTHENTICATION_REQUIRED: 'يتطلب هذا الإجراء تسجيل دخول حديثًا.',
    ORGANIZATION_NOT_FOUND: 'هذه المؤسسة غير موجودة.',
    NOT_FOUND: 'هذا السجل غير موجود.',
    CONFLICT: 'هذا التغيير غير ممكن في الحالة الحالية. حدّث الصفحة وحاول مجددًا.',
    VALIDATION_FAILED: 'بعض البيانات غير صالحة.',
    PRICE_ALREADY_ACTIVE: 'هذا السعر ساري بالفعل.',
    PRICE_IMMUTABLE: 'لا يمكن تغيير سعر ساري.',
    REFUND_EXCEEDS_REMAINING: 'هذا المبلغ يتجاوز المتبقي للاسترداد من هذه الدفعة.',
    REFUND_NOT_ELIGIBLE: 'لا يمكن استرداد هذه الدفعة.',
    INSUFFICIENT_BALANCE: 'أنفق العميل هذا الرصيد بالفعل.',
    RATE_LIMITED: 'طلبات كثيرة. يرجى الانتظار قليلًا.',
    UNAUTHENTICATED: 'انتهت جلستك. يرجى تسجيل الدخول مجددًا.',
    SESSION_EXPIRED: 'انتهت جلستك. يرجى تسجيل الدخول مجددًا.',
  },
  genericError: 'حدث خطأ ما. يرجى المحاولة مرة أخرى.',
};

export const ADMIN_MESSAGES: Readonly<Record<Locale, AdminMessages>> = { en, ar };

export function getAdminMessages(locale: Locale): AdminMessages {
  return ADMIN_MESSAGES[locale];
}
