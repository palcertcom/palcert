import { DEFAULT_LOCALE, type Locale } from './locales';

/**
 * The words of the application shell: navigation, the topbar, the account
 * menu, the dashboard and the sign-in frame.
 *
 * Section names are short navigation labels; each page keeps its own, longer
 * title. Where a feature catalogue already names something ("Official
 * submissions", "Sign out"), the same words are used here so a link and the
 * page it opens agree.
 */
export interface ShellMessages {
  readonly brand: string;
  readonly brandTagline: string;
  readonly skipToContent: string;
  readonly primaryNavigation: string;
  readonly openNavigation: string;
  readonly closeNavigation: string;
  readonly breadcrumbs: string;
  readonly loading: string;

  readonly dashboard: string;
  readonly groupPersonal: string;
  readonly groupOrganization: string;
  readonly groupIntegrations: string;
  readonly groupAccount: string;

  readonly documents: string;
  readonly checks: string;
  readonly certificates: string;
  readonly submissions: string;
  readonly balance: string;
  readonly notifications: string;
  readonly profile: string;
  readonly sessions: string;
  readonly organizations: string;
  readonly allOrganizations: string;
  readonly createOrganization: string;
  readonly currentOrganization: string;

  readonly accountMenu: string;
  readonly signedInAs: string;
  readonly signIn: string;
  readonly signOut: string;
  readonly createAccount: string;
  readonly language: string;
  readonly unreadNotifications: (count: number) => string;

  readonly verifyCertificate: string;
  readonly verifyCertificateHint: string;

  /** Generic names for an entity whose own name the shell has not loaded. */
  readonly entities: {
    readonly document: string;
    readonly check: string;
    readonly newCheck: string;
    readonly certificate: string;
    readonly submission: string;
    readonly standard: string;
    readonly version: string;
    readonly endpoint: string;
    readonly organization: string;
    readonly newOrganization: string;
    readonly preferences: string;
    readonly paymentReturn: string;
    readonly paymentCancelled: string;
  };

  readonly auth: {
    readonly noAccount: string;
    readonly createNewAccount: string;
    readonly haveAccount: string;
    readonly artworkLabel: string;
  };

  readonly dashboardPage: {
    readonly welcomeNamed: (name: string) => string;
    readonly welcome: string;
    readonly intro: string;
    readonly quickActions: string;
    readonly newDocument: string;
    readonly startCheck: string;
    readonly reviewSubmissions: string;
    readonly recentDocuments: string;
    readonly recentChecks: string;
    readonly recentSubmissions: string;
    readonly recentCertificates: string;
    readonly balanceTitle: string;
    readonly viewBalance: string;
    readonly noSubmissions: string;
    readonly noSubmissionsHint: string;
    readonly noCertificates: string;
    readonly noCertificatesHint: string;
    readonly yourOrganizations: string;
    readonly viewAll: string;
    readonly noDocuments: string;
    readonly noDocumentsHint: string;
    readonly noChecks: string;
    readonly noChecksHint: string;
    readonly noOrganizations: string;
    readonly noOrganizationsHint: string;
    readonly unreadTitle: string;
    readonly unreadBody: (count: number) => string;
    readonly openInbox: string;
    readonly couldNotLoad: string;
  };
}

const EN: ShellMessages = {
  brand: 'PalCert',
  brandTagline: 'Verification & attestation',
  skipToContent: 'Skip to main content',
  primaryNavigation: 'Main navigation',
  openNavigation: 'Open navigation',
  closeNavigation: 'Close navigation',
  breadcrumbs: 'Breadcrumb',
  loading: 'Loading…',

  dashboard: 'Dashboard',
  groupPersonal: 'Personal',
  groupOrganization: 'Organization',
  groupIntegrations: 'Integrations',
  groupAccount: 'Account',

  documents: 'Documents',
  checks: 'Checks',
  certificates: 'Certificates',
  submissions: 'Official submissions',
  balance: 'Balance',
  notifications: 'Notifications',
  profile: 'Profile',
  sessions: 'Sessions',
  organizations: 'Organizations',
  allOrganizations: 'All organizations',
  createOrganization: 'Create an organization',
  currentOrganization: 'Current organization',

  accountMenu: 'Account menu',
  signedInAs: 'Signed in as',
  signIn: 'Sign in',
  signOut: 'Sign out',
  createAccount: 'Create account',
  language: 'Language',
  unreadNotifications: (count) =>
    count === 1 ? '1 unread notification' : `${count} unread notifications`,

  verifyCertificate: 'Verify a certificate',
  verifyCertificateHint: 'Anyone can check a PalCert certificate with its verification code.',

  entities: {
    document: 'Document',
    check: 'Check',
    newCheck: 'New check',
    certificate: 'Certificate',
    submission: 'Submission',
    standard: 'Standard',
    version: 'Version',
    endpoint: 'Endpoint',
    organization: 'Organization',
    newOrganization: 'New organization',
    preferences: 'Preferences',
    paymentReturn: 'Payment',
    paymentCancelled: 'Payment cancelled',
  },

  auth: {
    noAccount: 'Don’t have an account?',
    createNewAccount: 'Create a new account',
    haveAccount: 'Already have an account?',
    artworkLabel: 'Academic documents being checked and certified',
  },

  dashboardPage: {
    welcomeNamed: (name) => `Welcome, ${name}`,
    welcome: 'Welcome',
    intro:
      'Check your documents against your institution’s standard, then submit and certify them.',
    quickActions: 'Quick actions',
    newDocument: 'New document',
    startCheck: 'Start a check',
    reviewSubmissions: 'Review submissions',
    recentDocuments: 'Recent documents',
    recentChecks: 'Recent checks',
    recentSubmissions: 'Official submissions',
    recentCertificates: 'Certificates',
    balanceTitle: 'Balance',
    viewBalance: 'View balance',
    noSubmissions: 'No submissions yet',
    noSubmissionsHint:
      'When a check meets its standard, you can submit it to the institution from the check.',
    noCertificates: 'No certificates yet',
    noCertificatesHint:
      'A certificate is issued when an institution approves a submission. You cannot request one.',
    yourOrganizations: 'Your organizations',
    viewAll: 'View all',
    noDocuments: 'No documents yet',
    noDocumentsHint: 'Create your first document and upload a DOCX or PDF.',
    noChecks: 'No checks yet',
    noChecksHint: 'Once a document is ready, check it against a published standard.',
    noOrganizations: 'You are not a member of an organization',
    noOrganizationsHint:
      'Institutions use PalCert organizations to publish standards and review submissions.',
    unreadTitle: 'Needs your attention',
    unreadBody: (count) =>
      count === 1 ? 'You have 1 unread notification.' : `You have ${count} unread notifications.`,
    openInbox: 'Open notifications',
    couldNotLoad: 'This part of the dashboard could not be loaded.',
  },
};

const AR: ShellMessages = {
  brand: 'بال‌سيرت',
  brandTagline: 'التحقق والاعتماد',
  skipToContent: 'انتقل إلى المحتوى الرئيسي',
  primaryNavigation: 'التنقل الرئيسي',
  openNavigation: 'فتح قائمة التنقل',
  closeNavigation: 'إغلاق قائمة التنقل',
  breadcrumbs: 'مسار التنقل',
  loading: 'جارٍ التحميل…',

  dashboard: 'لوحة التحكم',
  groupPersonal: 'مساحتي',
  groupOrganization: 'المؤسسة',
  groupIntegrations: 'التكاملات',
  groupAccount: 'الحساب',

  documents: 'المستندات',
  checks: 'الفحوصات',
  certificates: 'الشهادات',
  submissions: 'التقديمات الرسمية',
  balance: 'الرصيد',
  notifications: 'الإشعارات',
  profile: 'الملف الشخصي',
  sessions: 'الجلسات',
  organizations: 'المؤسسات',
  allOrganizations: 'كل المؤسسات',
  createOrganization: 'إنشاء مؤسسة',
  currentOrganization: 'المؤسسة الحالية',

  accountMenu: 'قائمة الحساب',
  signedInAs: 'مسجّل الدخول باسم',
  signIn: 'تسجيل الدخول',
  signOut: 'تسجيل الخروج',
  createAccount: 'إنشاء حساب',
  language: 'اللغة',
  unreadNotifications: (count) =>
    count === 1 ? 'إشعار واحد غير مقروء' : `${count} إشعارات غير مقروءة`,

  verifyCertificate: 'التحقق من شهادة',
  verifyCertificateHint: 'يمكن لأي شخص التحقق من شهادة بال‌سيرت برمز التحقق الخاص بها.',

  entities: {
    document: 'مستند',
    check: 'فحص',
    newCheck: 'فحص جديد',
    certificate: 'شهادة',
    submission: 'تقديم',
    standard: 'معيار',
    version: 'نسخة',
    endpoint: 'نقطة استقبال',
    organization: 'مؤسسة',
    newOrganization: 'مؤسسة جديدة',
    preferences: 'التفضيلات',
    paymentReturn: 'الدفع',
    paymentCancelled: 'أُلغي الدفع',
  },

  auth: {
    noAccount: 'ليس لديك حساب؟',
    createNewAccount: 'أنشئ حسابًا جديدًا',
    haveAccount: 'لديك حساب بالفعل؟',
    artworkLabel: 'مستندات أكاديمية يجري فحصها واعتمادها',
  },

  dashboardPage: {
    welcomeNamed: (name) => `مرحبًا، ${name}`,
    welcome: 'مرحبًا',
    intro: 'افحص مستنداتك وفق معيار مؤسستك، ثم قدّمها واحصل على اعتمادها.',
    quickActions: 'إجراءات سريعة',
    newDocument: 'مستند جديد',
    startCheck: 'بدء فحص',
    reviewSubmissions: 'مراجعة التقديمات',
    recentDocuments: 'أحدث المستندات',
    recentChecks: 'أحدث الفحوصات',
    recentSubmissions: 'التقديمات الرسمية',
    recentCertificates: 'الشهادات',
    balanceTitle: 'الرصيد',
    viewBalance: 'عرض الرصيد',
    noSubmissions: 'لا توجد تقديمات بعد',
    noSubmissionsHint: 'عندما يستوفي الفحص معياره، يمكنك تقديمه إلى المؤسسة من صفحة الفحص.',
    noCertificates: 'لا توجد شهادات بعد',
    noCertificatesHint: 'تُصدر الشهادة عندما توافق المؤسسة على التقديم، ولا يمكن طلبها.',
    yourOrganizations: 'مؤسساتك',
    viewAll: 'عرض الكل',
    noDocuments: 'لا توجد مستندات بعد',
    noDocumentsHint: 'أنشئ مستندك الأول وارفع ملف DOCX أو PDF.',
    noChecks: 'لا توجد فحوصات بعد',
    noChecksHint: 'عندما يصبح المستند جاهزًا، افحصه وفق معيار منشور.',
    noOrganizations: 'لست عضوًا في أي مؤسسة',
    noOrganizationsHint: 'تستخدم المؤسسات بال‌سيرت لنشر المعايير ومراجعة التقديمات.',
    unreadTitle: 'بحاجة إلى انتباهك',
    unreadBody: (count) =>
      count === 1 ? 'لديك إشعار واحد غير مقروء.' : `لديك ${count} إشعارات غير مقروءة.`,
    openInbox: 'فتح الإشعارات',
    couldNotLoad: 'تعذّر تحميل هذا الجزء من لوحة التحكم.',
  },
};

export const SHELL_MESSAGES: Record<Locale, ShellMessages> = { en: EN, ar: AR };

export function getShellMessages(locale: Locale): ShellMessages {
  return SHELL_MESSAGES[locale] ?? SHELL_MESSAGES[DEFAULT_LOCALE];
}
