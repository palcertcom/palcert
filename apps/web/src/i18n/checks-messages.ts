import type { Locale } from './locales';

/**
 * Check, result and report message catalogue (Phase 7, §75, §76).
 *
 * Every word a person reads about their check lives here, in both languages.
 * Canonical API values — `NON_COMPLIANT`, `INDETERMINATE`, `BELOW_MINIMUM` —
 * never reach the screen: a student should read "the top margin is too small",
 * not a symbol from a database column.
 *
 * Two rules shape the wording itself. PalCert never says a document was
 * approved, accepted or certified: it checks formatting against a published
 * standard and nothing more (§56). And "we could not decide" is never phrased
 * as a failure, because blaming a document for what PalCert could not read
 * would be false (§10).
 */
export interface ChecksMessages {
  readonly myChecks: string;
  readonly noChecks: string;
  readonly noChecksHint: string;
  readonly newCheck: string;
  readonly startCheck: string;
  readonly starting: string;
  readonly backToChecks: string;

  readonly chooseDocument: string;
  readonly chooseVersion: string;
  readonly chooseOrganization: string;
  readonly chooseDocumentType: string;
  readonly chooseStandard: string;
  readonly wizardLabel: string;
  readonly stepDocument: string;
  readonly stepInstitution: string;
  readonly stepStandard: string;
  readonly stepConfirm: string;
  readonly stepStates: {
    readonly done: string;
    readonly current: string;
    readonly upcoming: string;
  };
  readonly next: string;
  readonly back: string;
  readonly change: string;
  readonly reviewHeading: string;
  readonly noReadyDocuments: string;
  readonly noReadyDocumentsHint: string;
  readonly goToDocuments: string;
  readonly standardRuleCount: (count: number) => string;
  readonly checkingAgainst: string;
  readonly noCheckableStandards: string;
  readonly noCheckableStandardsHint: string;

  readonly processing: string;
  readonly processingHint: string;
  readonly stageQueued: string;
  readonly stageAnalyzing: string;
  readonly stageEvaluating: string;
  readonly stageReport: string;
  readonly stageDone: string;
  readonly stageFailed: string;
  readonly stillWorking: string;
  readonly checkBackLater: string;
  readonly retry: string;

  readonly determination: string;
  readonly determinations: Readonly<Record<string, string>>;
  readonly determinationHints: Readonly<Record<string, string>>;
  readonly score: string;
  readonly scoreUnavailable: string;
  readonly scoreUnavailableHint: string;
  readonly scorePartial: (coverage: number) => string;
  readonly scoreScopeNote: string;
  readonly notApproval: string;

  readonly findings: string;
  readonly noFindings: string;
  readonly showAll: string;
  readonly showBlocking: string;
  readonly showFailed: string;
  readonly outcomes: Readonly<Record<string, string>>;
  readonly severities: Readonly<Record<string, string>>;
  readonly blocking: string;
  readonly advisory: string;
  readonly needsReview: string;
  readonly needsReviewHint: string;
  readonly expected: string;
  readonly actual: string;
  readonly whereLabel: string;
  readonly noLocation: string;
  readonly violationCount: (returned: number, total: number) => string;
  readonly truncatedNote: string;
  readonly loadMore: string;

  readonly reportTitle: string;
  readonly reportSubtitle: string;
  readonly print: string;
  readonly checkedOn: string;
  readonly documentLabel: string;
  readonly resultLabel: string;
  readonly billingLabel: string;
  readonly loadingChecks: string;
  readonly standardLabel: string;
  readonly organizationLabel: string;
  readonly integrity: string;
  readonly downloadReportArtifact: string;
  readonly downloadReportArtifactHint: string;
  readonly reportHash: string;
  readonly evaluationHash: string;
  readonly documentFingerprint: string;
  readonly standardFingerprint: string;

  readonly counts: {
    readonly total: string;
    readonly passed: string;
    readonly failed: string;
    readonly notApplicable: string;
    readonly review: string;
    readonly undecided: string;
  };

  readonly errors: Readonly<Record<string, string>>;
  readonly genericError: string;
}

const en: ChecksMessages = {
  myChecks: 'My checks',
  noChecks: 'You have not checked a document yet.',
  noChecksHint:
    'Choose one of your uploaded documents and a published standard, and PalCert will check the ' +
    'formatting against it. Your documents and results stay private to you.',
  newCheck: 'New check',
  startCheck: 'Start check',
  starting: 'Starting…',
  backToChecks: 'Back to my checks',

  chooseDocument: 'Document',
  wizardLabel: 'Steps to start a check',
  stepDocument: 'Choose a document',
  stepInstitution: 'Institution and document type',
  stepStandard: 'Choose a standard',
  stepConfirm: 'Review and confirm',
  stepStates: { done: 'completed', current: 'current step', upcoming: 'not started' },
  next: 'Next',
  back: 'Back',
  change: 'Change',
  reviewHeading: 'Your choices',
  noReadyDocuments: 'No document is ready to check',
  noReadyDocumentsHint:
    'Upload a .docx or .pdf file to one of your documents. Once PalCert has processed it, it can be checked.',
  goToDocuments: 'Go to my documents',
  chooseVersion: 'Version',
  chooseOrganization: 'Institution',
  chooseDocumentType: 'Document type',
  chooseStandard: 'Standard',
  standardRuleCount: (count) => (count === 1 ? '1 rule' : `${count} rules`),
  checkingAgainst: 'Checked against',
  noCheckableStandards: 'No standards are available to check against yet.',
  noCheckableStandardsHint:
    'An institution publishes a standard here when it chooses to make it available. Ask yours ' +
    'whether it has done so.',

  processing: 'Checking your document',
  processingHint:
    'This usually takes a few moments. You can leave this page and come back — the check keeps ' +
    'running.',
  stageQueued: 'Waiting to start',
  stageAnalyzing: 'Reading your document',
  stageEvaluating: 'Checking the rules',
  stageReport: 'Preparing your report',
  stageDone: 'Done',
  stageFailed: 'Could not finish',
  stillWorking: 'Still working…',
  checkBackLater:
    'This is taking longer than usual. The check is still running; open it again in a few ' +
    'minutes.',
  retry: 'Try again',

  determination: 'Result',
  determinations: {
    COMPLIANT: 'Meets this standard',
    NON_COMPLIANT: 'Does not meet this standard',
    REVIEW_REQUIRED: 'Needs a person to review',
    INDETERMINATE: 'Could not be determined',
  },
  determinationHints: {
    COMPLIANT:
      'Every requirement PalCert could check automatically was met. This is a formatting check ' +
      'against this standard, not an approval of your work.',
    NON_COMPLIANT:
      'At least one required rule was not met. The findings below say which, and what to change.',
    REVIEW_REQUIRED:
      'The automatic checks passed, but this standard has requirements that only a person can ' +
      'judge.',
    INDETERMINATE:
      'PalCert could not read enough of your document to decide. This is not a failure of your ' +
      'work — some evidence was unavailable.',
  },
  score: 'Score',
  scoreUnavailable: 'No score',
  scoreUnavailableHint:
    'This standard has no requirements PalCert could measure automatically, so there is no score ' +
    'to give. That is different from scoring zero.',
  scorePartial: (coverage) =>
    `Based on ${coverage}% of the measurable requirements — the rest could not be evaluated.`,
  scoreScopeNote:
    'The score reflects the automatically measurable formatting rules in this standard only. It ' +
    'does not judge your research, and it does not decide anything about publication or ' +
    'approval.',
  notApproval:
    'PalCert checks formatting against a published standard. It does not approve, accept or ' +
    'certify your document.',

  findings: 'Findings',
  noFindings: 'No findings to show.',
  showAll: 'All',
  showBlocking: 'Required only',
  showFailed: 'Not met only',
  outcomes: {
    PASS: 'Met',
    FAIL: 'Not met',
    NOT_APPLICABLE: 'Does not apply',
    INDETERMINATE: 'Could not be checked',
    ERROR: 'Could not be checked',
  },
  severities: {
    CRITICAL: 'Critical',
    MAJOR: 'Major',
    MINOR: 'Minor',
    INFO: 'Advisory',
  },
  blocking: 'Required',
  advisory: 'Advisory',
  needsReview: 'Needs review',
  needsReviewHint: 'Only a person can judge this requirement.',
  expected: 'Required',
  actual: 'Found',
  whereLabel: 'Where',
  noLocation: 'Location not available',
  violationCount: (returned, total) =>
    returned === total
      ? `${total} ${total === 1 ? 'place' : 'places'}`
      : `Showing ${returned} of ${total} places`,
  truncatedNote:
    'Only the first few places are listed. Fixing the rule usually fixes all of them at once.',
  loadMore: 'Show more',

  reportTitle: 'Compliance report',
  reportSubtitle: 'A record of one check, against one version of one standard.',
  print: 'Print',
  checkedOn: 'Checked on',
  documentLabel: 'Document',
  resultLabel: 'Result',
  billingLabel: 'Cost',
  loadingChecks: 'Loading your checks…',
  standardLabel: 'Standard',
  organizationLabel: 'Published by',
  integrity: 'Integrity',
  downloadReportArtifact: 'Download the exact report (JSON)',
  downloadReportArtifactHint:
    'These are the bytes the report fingerprint was computed over, so anyone can check it independently.',
  reportHash: 'Report fingerprint',
  evaluationHash: 'Result fingerprint',
  documentFingerprint: 'Document fingerprint',
  standardFingerprint: 'Standard fingerprint',

  counts: {
    total: 'Rules checked',
    passed: 'Met',
    failed: 'Not met',
    notApplicable: 'Not applicable',
    review: 'Need review',
    undecided: 'Undecided',
  },

  errors: {
    CHECK_NOT_FOUND: 'That check could not be found.',
    CHECK_STANDARD_NOT_AVAILABLE:
      'That standard is not available to check against. It may have been withdrawn.',
    CHECK_DOCUMENT_NOT_READY: 'That version is still being processed. Try again in a moment.',
    CHECK_DOCUMENT_FORMAT_UNSUPPORTED: 'PalCert can currently check Word (.docx) documents only.',
    CHECK_ALREADY_COMPLETED: 'This check has already produced a report.',
    CHECK_NOT_RETRYABLE: 'Only a check that failed can be tried again.',
    REPORT_NOT_FOUND: 'This check has not produced a report yet.',
    IDEMPOTENCY_KEY_REUSED: 'That request was already used for a different check.',
  },
  genericError: 'Something went wrong. Please try again.',
};

const ar: ChecksMessages = {
  myChecks: 'فحوصاتي',
  noChecks: 'لم تفحص أي مستند بعد.',
  noChecksHint:
    'اختر أحد مستنداتك المرفوعة ومعياراً منشوراً، وسيفحص PalCert التنسيق وفقه. مستنداتك ونتائجك ' +
    'تبقى خاصة بك.',
  newCheck: 'فحص جديد',
  startCheck: 'ابدأ الفحص',
  starting: 'جارٍ البدء…',
  backToChecks: 'العودة إلى فحوصاتي',

  chooseDocument: 'المستند',
  wizardLabel: 'خطوات بدء الفحص',
  stepDocument: 'اختر المستند',
  stepInstitution: 'المؤسسة ونوع المستند',
  stepStandard: 'اختر المعيار',
  stepConfirm: 'المراجعة والتأكيد',
  stepStates: { done: 'مكتملة', current: 'الخطوة الحالية', upcoming: 'لم تبدأ' },
  next: 'التالي',
  back: 'السابق',
  change: 'تغيير',
  reviewHeading: 'اختياراتك',
  noReadyDocuments: 'لا يوجد مستند جاهز للفحص',
  noReadyDocumentsHint:
    'ارفع ملف ‎.docx‎ أو ‎.pdf‎ إلى أحد مستنداتك. بعد أن تعالجه بال‌سيرت يصبح قابلًا للفحص.',
  goToDocuments: 'انتقل إلى مستنداتي',
  chooseVersion: 'النسخة',
  chooseOrganization: 'المؤسسة',
  chooseDocumentType: 'نوع المستند',
  chooseStandard: 'المعيار',
  standardRuleCount: (count) => (count === 1 ? 'قاعدة واحدة' : `${count} قاعدة`),
  checkingAgainst: 'تم الفحص وفق',
  noCheckableStandards: 'لا توجد معايير متاحة للفحص حتى الآن.',
  noCheckableStandardsHint:
    'تنشر المؤسسة معيارها هنا عندما تختار إتاحته. اسأل مؤسستك إن كانت قد فعلت ذلك.',

  processing: 'جارٍ فحص مستندك',
  processingHint:
    'يستغرق هذا عادة لحظات قليلة. يمكنك مغادرة هذه الصفحة والعودة إليها — يستمر الفحص.',
  stageQueued: 'في الانتظار',
  stageAnalyzing: 'قراءة مستندك',
  stageEvaluating: 'فحص القواعد',
  stageReport: 'تجهيز تقريرك',
  stageDone: 'اكتمل',
  stageFailed: 'تعذّر الإكمال',
  stillWorking: 'ما زال العمل جارياً…',
  checkBackLater: 'يستغرق هذا وقتاً أطول من المعتاد. الفحص ما زال جارياً؛ افتحه مجدداً بعد دقائق.',
  retry: 'حاول مرة أخرى',

  determination: 'النتيجة',
  determinations: {
    COMPLIANT: 'يستوفي هذا المعيار',
    NON_COMPLIANT: 'لا يستوفي هذا المعيار',
    REVIEW_REQUIRED: 'يحتاج مراجعة بشرية',
    INDETERMINATE: 'تعذّر التحديد',
  },
  determinationHints: {
    COMPLIANT:
      'استُوفيت كل المتطلبات التي أمكن فحصها آلياً. هذا فحص تنسيق وفق هذا المعيار، وليس إقراراً ' +
      'لعملك.',
    NON_COMPLIANT:
      'لم تُستوفَ قاعدة مطلوبة واحدة على الأقل. تبيّن النتائج أدناه أيّها وما يلزم تغييره.',
    REVIEW_REQUIRED:
      'نجحت الفحوص الآلية، لكن هذا المعيار يتضمن متطلبات لا يمكن الحكم عليها إلا من شخص.',
    INDETERMINATE:
      'تعذّر على PalCert قراءة ما يكفي من مستندك ليقرر. هذا ليس قصوراً في عملك — بعض الأدلة لم تكن متاحة.',
  },
  score: 'الدرجة',
  scoreUnavailable: 'لا توجد درجة',
  scoreUnavailableHint:
    'لا يتضمن هذا المعيار متطلبات يمكن لـ PalCert قياسها آلياً، فلا توجد درجة تُعطى. وهذا يختلف عن ' +
    'الحصول على صفر.',
  scorePartial: (coverage) =>
    `استناداً إلى ${coverage}% من المتطلبات القابلة للقياس — وتعذّر تقييم الباقي.`,
  scoreScopeNote:
    'تعبّر الدرجة عن قواعد التنسيق القابلة للقياس آلياً في هذا المعيار فقط. وهي لا تقيّم بحثك، ولا ' +
    'تقرر شيئاً بشأن النشر أو الاعتماد.',
  notApproval:
    'يفحص PalCert التنسيق وفق معيار منشور. وهو لا يعتمد مستندك ولا يقبله ولا يصدر له شهادة.',

  findings: 'النتائج',
  noFindings: 'لا توجد نتائج لعرضها.',
  showAll: 'الكل',
  showBlocking: 'المطلوبة فقط',
  showFailed: 'غير المستوفاة فقط',
  outcomes: {
    PASS: 'مستوفاة',
    FAIL: 'غير مستوفاة',
    NOT_APPLICABLE: 'لا تنطبق',
    INDETERMINATE: 'تعذّر الفحص',
    ERROR: 'تعذّر الفحص',
  },
  severities: {
    CRITICAL: 'حرجة',
    MAJOR: 'كبيرة',
    MINOR: 'طفيفة',
    INFO: 'إرشادية',
  },
  blocking: 'مطلوبة',
  advisory: 'إرشادية',
  needsReview: 'تحتاج مراجعة',
  needsReviewHint: 'لا يمكن الحكم على هذا المتطلب إلا من شخص.',
  expected: 'المطلوب',
  actual: 'الموجود',
  whereLabel: 'الموضع',
  noLocation: 'الموضع غير متاح',
  violationCount: (returned, total) =>
    returned === total ? `${total} موضع` : `عرض ${returned} من ${total} موضعاً`,
  truncatedNote: 'تُعرض المواضع الأولى فقط. وغالباً ما يصحّح إصلاح القاعدة جميعها دفعة واحدة.',
  loadMore: 'عرض المزيد',

  reportTitle: 'تقرير المطابقة',
  reportSubtitle: 'سجل لفحص واحد، وفق نسخة واحدة من معيار واحد.',
  print: 'طباعة',
  checkedOn: 'تاريخ الفحص',
  documentLabel: 'المستند',
  resultLabel: 'النتيجة',
  billingLabel: 'التكلفة',
  loadingChecks: 'جارٍ تحميل فحوصاتك…',
  standardLabel: 'المعيار',
  organizationLabel: 'جهة النشر',
  integrity: 'التحقق',
  downloadReportArtifact: 'تنزيل التقرير كما هو (JSON)',
  downloadReportArtifactHint:
    'هذه هي البايتات التي حُسبت منها بصمة التقرير، ليتمكن أي شخص من التحقق منها بنفسه.',
  reportHash: 'بصمة التقرير',
  evaluationHash: 'بصمة النتيجة',
  documentFingerprint: 'بصمة المستند',
  standardFingerprint: 'بصمة المعيار',

  counts: {
    total: 'القواعد المفحوصة',
    passed: 'مستوفاة',
    failed: 'غير مستوفاة',
    notApplicable: 'لا تنطبق',
    review: 'تحتاج مراجعة',
    undecided: 'غير محسومة',
  },

  errors: {
    CHECK_NOT_FOUND: 'تعذّر العثور على هذا الفحص.',
    CHECK_STANDARD_NOT_AVAILABLE: 'هذا المعيار غير متاح للفحص. ربما تم سحبه.',
    CHECK_DOCUMENT_NOT_READY: 'ما زالت هذه النسخة قيد المعالجة. حاول بعد لحظات.',
    CHECK_DOCUMENT_FORMAT_UNSUPPORTED: 'يفحص PalCert حالياً مستندات Word‏ (.docx) فقط.',
    CHECK_ALREADY_COMPLETED: 'أصدر هذا الفحص تقريره بالفعل.',
    CHECK_NOT_RETRYABLE: 'لا يمكن إعادة المحاولة إلا لفحص أخفق.',
    REPORT_NOT_FOUND: 'لم يصدر هذا الفحص تقريراً بعد.',
    IDEMPOTENCY_KEY_REUSED: 'استُخدم هذا الطلب بالفعل لفحص مختلف.',
  },
  genericError: 'حدث خطأ ما. يرجى المحاولة مرة أخرى.',
};

export const CHECKS_MESSAGES: Readonly<Record<Locale, ChecksMessages>> = { en, ar };

export function getChecksMessages(locale: Locale): ChecksMessages {
  return CHECKS_MESSAGES[locale] ?? CHECKS_MESSAGES.en;
}

/** The four stages a person sees, mapped from the canonical check status. */
export type CheckStage = 'QUEUED' | 'ANALYZING' | 'EVALUATING' | 'REPORT' | 'DONE' | 'FAILED';

export function stageForCheckStatus(status: string): CheckStage {
  switch (status) {
    case 'CREATED':
      return 'QUEUED';
    case 'WAITING_ANALYSIS':
      return 'ANALYZING';
    case 'EVALUATING':
      return 'EVALUATING';
    case 'GENERATING_REPORT':
      return 'REPORT';
    case 'COMPLETED':
      return 'DONE';
    default:
      return 'FAILED';
  }
}

/** A check that has no verdict yet, in words: where it has got to. */
export function checkStageLabel(status: string, messages: ChecksMessages): string {
  switch (stageForCheckStatus(status)) {
    case 'QUEUED':
      return messages.stageQueued;
    case 'ANALYZING':
      return messages.stageAnalyzing;
    case 'EVALUATING':
      return messages.stageEvaluating;
    case 'REPORT':
      return messages.stageReport;
    case 'DONE':
      return messages.stageDone;
    default:
      return messages.stageFailed;
  }
}
