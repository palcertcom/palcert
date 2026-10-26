import type { Locale } from './locales';

/**
 * The proposal review console and the extraction progress panel.
 *
 * The rules of the extraction catalogue apply here too: counts, never
 * confidence numbers or percentages; nothing claims completeness; nothing
 * suggests that PalCert decides. Templates use `{name}` placeholders, filled
 * by `formatMessage`, so a sentence keeps its own word order in Arabic.
 */
export interface ReviewConsoleMessages {
  // --- progress --------------------------------------------------------------
  readonly progressTitle: string;
  readonly progressStepsLabel: string;
  readonly stepStates: {
    readonly done: string;
    readonly current: string;
    readonly upcoming: string;
  };
  readonly progressStages: Readonly<Record<string, string>>;
  readonly progressStates: Readonly<Record<string, string>>;
  readonly progressBarLabel: string;
  readonly batchesOf: string;
  readonly batchesNotYetKnown: string;
  readonly batchesFailed: string;
  readonly evidenceLabel: string;
  readonly observationsLabel: string;
  readonly proposalsLabel: string;
  readonly countedWhenSaved: string;
  readonly elapsedLabel: string;
  readonly elapsedValue: string;
  readonly validatingTogether: string;
  readonly cancelNote: string;
  readonly cancelling: string;

  // --- summary chips -----------------------------------------------------------
  readonly summaryLabel: string;
  readonly chips: {
    readonly all: string;
    readonly waiting: string;
    readonly valid: string;
    readonly cannotExpress: string;
    readonly accepted: string;
    readonly rejected: string;
  };

  // --- search, filters, sort ---------------------------------------------------
  readonly searchLabel: string;
  readonly searchPlaceholder: string;
  readonly filterKind: string;
  readonly filterStatus: string;
  readonly filterCategory: string;
  readonly filterUniformity: string;
  readonly filterAny: string;
  readonly uniformityFilterLabels: Readonly<Record<string, string>>;
  readonly clearFilters: string;
  readonly sortAscending: string;
  readonly sortDescending: string;

  // --- table -----------------------------------------------------------------
  readonly tableCaption: string;
  readonly columns: {
    readonly select: string;
    readonly ruleCode: string;
    readonly type: string;
    readonly value: string;
    readonly evidence: string;
    readonly source: string;
    readonly status: string;
    readonly actions: string;
  };
  readonly noRuleCode: string;
  readonly observedPrefix: string;
  readonly expectedPrefix: string;
  readonly passages: string;
  readonly measurements: string;
  readonly occurrences: string;
  readonly statusLabels: Readonly<Record<string, string>>;
  readonly invalidBadge: string;
  readonly conflictBadge: string;
  readonly details: string;
  readonly hideDetails: string;
  readonly selectRow: string;
  readonly noMatches: string;
  readonly loadingDetail: string;

  // --- detail panel ----------------------------------------------------------
  readonly detailExplanation: string;
  readonly detailCanCheck: string;
  readonly detailValidation: string;
  readonly detailNoIssues: string;
  readonly detailSources: string;
  readonly detailOccurrences: string;
  readonly detailUniformity: string;

  // --- selection and bulk actions --------------------------------------------
  readonly selectPage: string;
  readonly selectAllMatching: string;
  readonly clearSelection: string;
  readonly selectedCount: string;
  readonly bulkBarLabel: string;
  readonly acceptSelected: string;
  readonly rejectSelected: string;
  readonly acceptAllValid: string;
  readonly rejectAllPending: string;
  readonly working: string;

  // --- confirmations ---------------------------------------------------------
  readonly confirmAcceptTitle: string;
  readonly confirmAcceptBody: string;
  readonly confirmAcceptLeftOut: string;
  readonly confirmAcceptButton: string;
  readonly confirmRejectTitle: string;
  readonly confirmRejectBody: string;
  readonly confirmRejectLeftOut: string;
  readonly confirmRejectButton: string;
  readonly nothingToAccept: string;
  readonly nothingToReject: string;
  readonly cancel: string;
  readonly close: string;

  // --- results ---------------------------------------------------------------
  readonly resultAccepted: string;
  readonly resultRejected: string;
  readonly resultSkipped: string;

  // --- pagination ------------------------------------------------------------
  readonly paginationLabel: string;
  readonly rowsPerPage: string;
  readonly showing: string;
  readonly previousPage: string;
  readonly nextPage: string;
  readonly pageOf: string;
}

const en: ReviewConsoleMessages = {
  progressTitle: 'Reading progress',
  progressStepsLabel: 'Steps of this reading',
  stepStates: { done: 'done', current: 'in progress', upcoming: 'not started' },
  progressStages: {
    PREPARING_SOURCE: 'Preparing source',
    ANALYSING_SOURCE: 'Analysing source',
    MEASURING_TEMPLATE: 'Measuring template',
    GENERATING_PROPOSALS: 'Generating proposals',
    VALIDATING: 'Validating',
    SAVING: 'Saving',
    COMPLETED: 'Completed',
  },
  progressStates: {
    RUNNING: 'Running',
    COMPLETED: 'Completed',
    FAILED: 'Failed',
    CANCELLED: 'Cancelled',
  },
  progressBarLabel: 'Proposal batches finished',
  batchesOf: '{done} of {total} batches',
  batchesNotYetKnown: 'Batches are counted once the source passages are saved.',
  batchesFailed: '{count} failed',
  evidenceLabel: 'Guideline passages',
  observationsLabel: 'Template observations',
  proposalsLabel: 'Proposals',
  countedWhenSaved: 'Counted when saved',
  elapsedLabel: 'Elapsed',
  elapsedValue: '{minutes} min {seconds} s',
  validatingTogether: 'Validation and saving happen together, in one step.',
  cancelNote: 'A reading can be cancelled only before PalCert has sent anything to be read.',
  cancelling: 'Cancelling…',

  summaryLabel: 'Review summary',
  chips: {
    all: 'All',
    waiting: 'Waiting for decision',
    valid: 'Valid rule candidates',
    cannotExpress: 'Cannot be expressed as rule',
    accepted: 'Accepted',
    rejected: 'Rejected',
  },

  searchLabel: 'Search',
  searchPlaceholder: 'Rule code, title or property',
  filterKind: 'Kind',
  filterStatus: 'Status',
  filterCategory: 'Category',
  filterUniformity: 'Consistency',
  filterAny: 'Any',
  uniformityFilterLabels: {
    UNIFORM: 'Every occurrence agrees',
    MOSTLY_UNIFORM: 'Most occurrences agree',
    MIXED: 'Inconsistent',
    INSUFFICIENT_SAMPLE: 'Insufficient sample',
  },
  clearFilters: 'Clear filters',
  sortAscending: 'sorted ascending',
  sortDescending: 'sorted descending',

  tableCaption: 'Proposals from this reading',
  columns: {
    select: 'Select',
    ruleCode: 'Rule code',
    type: 'Category / type',
    value: 'Observed / expected',
    evidence: 'Evidence / consistency',
    source: 'Source',
    status: 'Status',
    actions: 'Actions',
  },
  noRuleCode: 'No rule',
  observedPrefix: 'Observed',
  expectedPrefix: 'Expected',
  passages: 'Passages: {count}',
  measurements: 'Measurements: {count}',
  occurrences: '{matching} of {total} occurrences',
  statusLabels: {
    PENDING_REVIEW: 'Waiting',
    ACCEPTED: 'Accepted',
    MODIFIED_AND_ACCEPTED: 'Accepted, with changes',
    ACCEPTED_WITH_EDITS: 'Accepted, with changes',
    REJECTED: 'Rejected',
    SUPERSEDED: 'Superseded',
  },
  invalidBadge: 'Invalid',
  conflictBadge: 'Conflict',
  details: 'Details',
  hideDetails: 'Hide details',
  selectRow: 'Select {code}',
  noMatches: 'No proposals match these filters.',
  loadingDetail: 'Loading the evidence…',

  detailExplanation: 'Full explanation',
  detailCanCheck: 'Can PalCert check it?',
  detailValidation: 'Validation',
  detailNoIssues: 'No problems found.',
  detailSources: 'Sources',
  detailOccurrences: 'Occurrences',
  detailUniformity: 'Consistency',

  selectPage: 'Select page',
  selectAllMatching: 'Select all {count} matching',
  clearSelection: 'Clear',
  selectedCount: '{count} selected',
  bulkBarLabel: 'Selected proposals',
  acceptSelected: 'Accept selected',
  rejectSelected: 'Reject selected',
  acceptAllValid: 'Accept all valid ({count})',
  rejectAllPending: 'Reject all pending ({count})',
  working: 'Working…',

  confirmAcceptTitle: 'Accept {count} valid proposals into this draft?',
  confirmAcceptBody:
    'Each becomes an ordinary draft rule, checked exactly as a rule written by hand. Nothing is published.',
  confirmAcceptLeftOut:
    '{count} of the selected proposals have no valid rule to accept and will be left for you.',
  confirmAcceptButton: 'Accept {count}',
  confirmRejectTitle: 'Reject {count} pending proposals?',
  confirmRejectBody:
    'They stay on record as rejected, with the reason you choose. No rule is added.',
  confirmRejectLeftOut:
    '{count} of the selected proposals were already decided and are left as they are.',
  confirmRejectButton: 'Reject {count}',
  nothingToAccept: 'None of the selected proposals has a valid rule to accept.',
  nothingToReject: 'None of the selected proposals is waiting for a decision.',
  cancel: 'Cancel',
  close: 'Close',

  resultAccepted: '{count} accepted.',
  resultRejected: '{count} rejected.',
  resultSkipped: '{count} left unchanged:',

  paginationLabel: 'Proposal pages',
  rowsPerPage: 'Rows per page',
  showing: '{from}–{to} of {total}',
  previousPage: 'Previous',
  nextPage: 'Next',
  pageOf: 'Page {page} of {pages}',
};

const ar: ReviewConsoleMessages = {
  progressTitle: 'تقدّم القراءة',
  progressStepsLabel: 'مراحل هذه القراءة',
  stepStates: { done: 'اكتملت', current: 'جارية', upcoming: 'لم تبدأ' },
  progressStages: {
    PREPARING_SOURCE: 'تجهيز المصدر',
    ANALYSING_SOURCE: 'تحليل المصدر',
    MEASURING_TEMPLATE: 'قياس القالب',
    GENERATING_PROPOSALS: 'توليد المقترحات',
    VALIDATING: 'التحقق',
    SAVING: 'الحفظ',
    COMPLETED: 'اكتملت',
  },
  progressStates: {
    RUNNING: 'جارية',
    COMPLETED: 'اكتملت',
    FAILED: 'فشلت',
    CANCELLED: 'أُلغيت',
  },
  progressBarLabel: 'دفعات المقترحات المنجزة',
  batchesOf: '{done} من {total} دفعات',
  batchesNotYetKnown: 'تُحصى الدفعات بعد حفظ مقاطع المصدر.',
  batchesFailed: 'فشل منها {count}',
  evidenceLabel: 'مقاطع من الأدلة',
  observationsLabel: 'ملاحظات القالب',
  proposalsLabel: 'المقترحات',
  countedWhenSaved: 'تُحصى عند الحفظ',
  elapsedLabel: 'الوقت المنقضي',
  elapsedValue: '{minutes} د {seconds} ث',
  validatingTogether: 'يجري التحقق والحفظ معاً في خطوة واحدة.',
  cancelNote: 'لا يمكن إلغاء القراءة إلا قبل أن يرسل بال‌سيرت أي شيء لقراءته.',
  cancelling: 'جارٍ الإلغاء…',

  summaryLabel: 'ملخص المراجعة',
  chips: {
    all: 'الكل',
    waiting: 'بانتظار القرار',
    valid: 'قواعد صالحة مرشّحة',
    cannotExpress: 'لا يمكن التعبير عنه كقاعدة',
    accepted: 'مقبولة',
    rejected: 'مرفوضة',
  },

  searchLabel: 'بحث',
  searchPlaceholder: 'رمز القاعدة أو العنوان أو الخاصية',
  filterKind: 'النوع',
  filterStatus: 'الحالة',
  filterCategory: 'الفئة',
  filterUniformity: 'الاتساق',
  filterAny: 'الكل',
  uniformityFilterLabels: {
    UNIFORM: 'كل المواضع متفقة',
    MOSTLY_UNIFORM: 'معظم المواضع متفقة',
    MIXED: 'غير متسق',
    INSUFFICIENT_SAMPLE: 'عيّنة غير كافية',
  },
  clearFilters: 'مسح عوامل التصفية',
  sortAscending: 'مرتّب تصاعدياً',
  sortDescending: 'مرتّب تنازلياً',

  tableCaption: 'مقترحات هذه القراءة',
  columns: {
    select: 'تحديد',
    ruleCode: 'رمز القاعدة',
    type: 'الفئة / النوع',
    value: 'الملاحَظ / المتوقَّع',
    evidence: 'الدليل / الاتساق',
    source: 'المصدر',
    status: 'الحالة',
    actions: 'الإجراءات',
  },
  noRuleCode: 'بلا قاعدة',
  observedPrefix: 'الملاحَظ',
  expectedPrefix: 'المتوقَّع',
  passages: 'المقاطع: {count}',
  measurements: 'القياسات: {count}',
  occurrences: '{matching} من {total} مواضع',
  statusLabels: {
    PENDING_REVIEW: 'بانتظار القرار',
    ACCEPTED: 'مقبول',
    MODIFIED_AND_ACCEPTED: 'مقبول بعد التعديل',
    ACCEPTED_WITH_EDITS: 'مقبول بعد التعديل',
    REJECTED: 'مرفوض',
    SUPERSEDED: 'مُستبدَل',
  },
  invalidBadge: 'غير صالح',
  conflictBadge: 'تعارض',
  details: 'التفاصيل',
  hideDetails: 'إخفاء التفاصيل',
  selectRow: 'تحديد {code}',
  noMatches: 'لا توجد مقترحات تطابق عوامل التصفية هذه.',
  loadingDetail: 'جارٍ تحميل الأدلة…',

  detailExplanation: 'الشرح الكامل',
  detailCanCheck: 'هل يستطيع بال‌سيرت فحصها؟',
  detailValidation: 'التحقق',
  detailNoIssues: 'لم تُكتشف مشكلات.',
  detailSources: 'المصادر',
  detailOccurrences: 'المواضع',
  detailUniformity: 'الاتساق',

  selectPage: 'تحديد الصفحة',
  selectAllMatching: 'تحديد كل المطابقة ({count})',
  clearSelection: 'مسح',
  selectedCount: 'المحدد: {count}',
  bulkBarLabel: 'المقترحات المحددة',
  acceptSelected: 'قبول المحدد',
  rejectSelected: 'رفض المحدد',
  acceptAllValid: 'قبول كل الصالحة ({count})',
  rejectAllPending: 'رفض كل المعلّقة ({count})',
  working: 'جارٍ التنفيذ…',

  confirmAcceptTitle: 'قبول {count} من المقترحات الصالحة في هذه المسودة؟',
  confirmAcceptBody:
    'يصبح كل منها قاعدة عادية في المسودة، وتُفحص تماماً كما تُفحص قاعدة مكتوبة يدوياً. لا يُنشر شيء.',
  confirmAcceptLeftOut: 'ليس لـ{count} من المقترحات المحددة قاعدة صالحة للقبول، وستبقى لكم.',
  confirmAcceptButton: 'قبول {count}',
  confirmRejectTitle: 'رفض {count} من المقترحات المعلّقة؟',
  confirmRejectBody: 'تبقى مسجّلة بوصفها مرفوضة مع السبب الذي تختارونه. لا تُضاف أي قاعدة.',
  confirmRejectLeftOut: 'سبق البت في {count} من المقترحات المحددة، وتبقى كما هي.',
  confirmRejectButton: 'رفض {count}',
  nothingToAccept: 'لا يحمل أي من المقترحات المحددة قاعدة صالحة للقبول.',
  nothingToReject: 'لا يوجد بين المقترحات المحددة ما ينتظر قراراً.',
  cancel: 'إلغاء',
  close: 'إغلاق',

  resultAccepted: 'قُبل {count}.',
  resultRejected: 'رُفض {count}.',
  resultSkipped: 'بقي {count} دون تغيير:',

  paginationLabel: 'صفحات المقترحات',
  rowsPerPage: 'صفوف في الصفحة',
  showing: '{from}–{to} من {total}',
  previousPage: 'السابق',
  nextPage: 'التالي',
  pageOf: 'الصفحة {page} من {pages}',
};

export const REVIEW_CONSOLE_MESSAGES: Readonly<Record<Locale, ReviewConsoleMessages>> = { en, ar };

export function getReviewConsoleMessages(locale: Locale): ReviewConsoleMessages {
  return REVIEW_CONSOLE_MESSAGES[locale] ?? REVIEW_CONSOLE_MESSAGES.en;
}

/** Fill `{name}` placeholders. Numbers are written with the locale's digits left alone. */
export function formatMessage(
  template: string,
  values: Readonly<Record<string, string | number>>,
): string {
  return template.replace(/\{(\w+)\}/g, (match, name: string) =>
    name in values ? String(values[name]) : match,
  );
}
