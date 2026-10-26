import type { Locale } from './locales';

/**
 * What a person reads about handing their work to an institution
 * (Phase 14 §80–§94).
 *
 * Four rules shape every string here, and breaking any of them would mislead
 * somebody about their own thesis or about what a university has decided.
 *
 * **Never let the two authorities blur.** PalCert says whether a document
 * meets a standard technically. A university says whether it accepts the
 * submission. Those are different sentences and this file never merges them:
 * "compliant" is never written as "approved", and "rejected" is never written
 * as "failed". Arabic keeps the same separation — مطابق / غير مطابق for the
 * technical result, and مقبول / مرفوض for the institution's decision.
 *
 * **Never say shared before it is shared.** Until the person presses the
 * button, nothing has been handed over, and the disclosure is written in the
 * conditional: *would* be shared. Afterwards it is in the past.
 *
 * **Say what is not shared, explicitly.** "We only share what you submit" is a
 * promise nobody can check. A list is one they can, so the list is here in
 * both languages and is rendered from what the server said rather than from
 * anything hardcoded in a page.
 *
 * **A preparation failure is never a rejection.** PREPARING and FAILED belong
 * to PalCert's own copying, and the strings say so — لم تُسلَّم بعد, never
 * anything that sounds like a decision.
 */
export interface SubmissionsMessages {
  readonly title: string;
  readonly intro: string;
  readonly empty: string;
  readonly back: string;
  readonly columnDocument: string;
  readonly columnInstitution: string;
  readonly columnUpdated: string;
  readonly loading: string;

  readonly disclosureTitle: string;
  readonly disclosureIntro: (organization: string) => string;
  readonly willShare: string;
  readonly willNotShare: string;
  readonly sharedItems: Readonly<Record<string, string>>;
  readonly notSharedItems: Readonly<Record<string, string>>;
  readonly submit: string;
  readonly submitting: string;
  readonly submitHint: string;
  readonly cancel: string;

  readonly technicalTitle: string;
  readonly technicalHint: string;
  readonly decisionTitle: string;
  readonly decisionHint: string;

  readonly displayStatuses: Readonly<Record<string, string>>;
  readonly processingStatuses: Readonly<Record<string, string>>;
  readonly processingHints: Readonly<Record<string, string>>;
  readonly failureCodes: Readonly<Record<string, string>>;
  readonly reasonCodes: Readonly<Record<string, string>>;

  readonly revisionLabel: (n: number) => string;
  readonly revisionCount: (n: number) => string;
  readonly submittedAt: string;
  readonly decidedAt: string;
  readonly reviewStartedAt: string;

  readonly historyTitle: string;
  readonly historyBySystem: string;
  readonly historyByInstitution: string;
  readonly commentsTitle: string;
  readonly commentsEmpty: string;

  readonly evidenceTitle: string;
  readonly evidenceHint: string;
  readonly documentHash: string;
  readonly reportHash: string;
  readonly evidenceHash: string;
  readonly downloadDocument: string;
  readonly downloadReport: string;

  readonly resubmitTitle: string;
  readonly resubmitHint: string;

  readonly queueTitle: string;
  readonly queueIntro: string;
  readonly queueEmpty: string;
  readonly queueSubmitter: string;
  readonly queueStandard: string;
  readonly queueResult: string;
  readonly determinationLabel: string;
  readonly scoreLabel: string;
  readonly ruleCounts: (passed: number, total: number) => string;
  readonly queueStatus: string;
  readonly filterAll: string;

  readonly reviewTitle: string;
  readonly reviewIntro: string;
  readonly reviewSeparation: string;
  readonly startReview: string;
  readonly approve: string;
  readonly reject: string;
  readonly requestRevision: string;
  readonly deciding: string;
  readonly commentLabel: string;
  readonly commentRequired: string;
  readonly reasonLabel: string;
  readonly addComment: string;
  readonly addingComment: string;
  readonly commentOnlyHint: string;

  readonly genericError: string;
  readonly errors: Readonly<Record<string, string>>;
}

const en: SubmissionsMessages = {
  title: 'Official submissions',
  intro:
    'A PalCert check is private. An official submission is the separate, deliberate act of ' +
    'handing one exact document and its report to the institution that owns the standard.',
  empty: 'You have not submitted anything officially.',
  back: 'Back',
  columnDocument: 'Document',
  columnInstitution: 'Institution',
  columnUpdated: 'Updated',
  loading: 'Loading your submissions…',

  disclosureTitle: 'Before you submit',
  disclosureIntro: (organization) =>
    `This would send the following to ${organization}. Nothing is sent until you press submit.`,
  willShare: 'What would be shared',
  willNotShare: 'What would not be shared',
  sharedItems: {
    SUBMITTED_DOCUMENT_VERSION: 'This exact version of your document',
    TECHNICAL_REPORT: 'The technical report for this check',
    TECHNICAL_DETERMINATION: 'The technical determination',
    DETERMINISTIC_SCORE_AND_FINDINGS: 'The score and the rule-by-rule findings',
    STANDARD_AND_VERSION: 'The standard and version it was checked against',
    SUBMITTER_IDENTITY: 'Your name and email address',
  },
  notSharedItems: {
    OTHER_DOCUMENT_VERSIONS: 'Any other version of this document',
    OTHER_CHECKS: 'Any other check you have run',
    AI_REVIEW: 'Your AI review',
    SMARTFIX_PLAN_AND_MANIFEST: 'Your SmartFix plan and what it changed',
    BALANCE_AND_PAYMENTS: 'Your balance and your payments',
    UNRELATED_FILES: 'Any other file in your account',
  },
  submit: 'Submit officially',
  submitting: 'Submitting…',
  submitHint:
    'PalCert copies the exact bytes and the exact report, verifies them, and only then puts the ' +
    'submission in the institution’s queue.',
  cancel: 'Cancel',

  technicalTitle: 'PalCert’s technical result',
  technicalHint:
    'What the standard’s rules measured. It is not the institution’s decision, and the ' +
    'institution is free to reach a different conclusion.',
  decisionTitle: 'The institution’s decision',
  decisionHint:
    'An administrative decision made by the institution about this submission. PalCert records ' +
    'it and does not influence it.',

  displayStatuses: {
    NOT_SUBMITTED: 'Not submitted',
    SUBMITTED: 'Submitted',
    UNDER_REVIEW: 'Under review',
    APPROVED: 'Approved',
    REJECTED: 'Rejected',
    REVISION_REQUESTED: 'Revision requested',
  },
  processingStatuses: {
    PREPARING: 'Preparing',
    READY: 'Delivered',
    FAILED: 'Could not be prepared',
  },
  processingHints: {
    PREPARING:
      'PalCert is copying and verifying the evidence. The institution has not been shown ' +
      'anything yet.',
    READY: 'The institution has received this submission.',
    FAILED:
      'Preparation did not finish, so nothing was sent. This is not a decision by the ' +
      'institution.',
  },
  failureCodes: {
    SOURCE_UNAVAILABLE: 'The document or report could not be read.',
    DIGEST_MISMATCH: 'The stored bytes no longer match what the check recorded.',
    SNAPSHOT_COPY_FAILED: 'The copy could not be completed.',
    SNAPSHOT_VERIFICATION_FAILED: 'The copy did not match the original.',
  },
  reasonCodes: {
    TECHNICAL_CORRECTIONS_REQUIRED: 'Technical corrections required',
    DOCUMENT_INCOMPLETE: 'Document incomplete',
    ADMINISTRATIVE_REQUIREMENT: 'Administrative requirement',
    OTHER: 'Other',
  },

  revisionLabel: (n) => `Revision ${n}`,
  revisionCount: (n) => (n === 1 ? '1 revision' : `${n} revisions`),
  submittedAt: 'Submitted',
  decidedAt: 'Decided',
  reviewStartedAt: 'Review started',

  historyTitle: 'History',
  historyBySystem: 'PalCert',
  historyByInstitution: 'The institution',
  commentsTitle: 'Comments from the institution',
  commentsEmpty: 'No comments yet.',

  evidenceTitle: 'Evidence',
  evidenceHint:
    'The institution reads this exact copy. Nothing was regenerated, re-rendered or rebuilt.',
  documentHash: 'Document digest',
  reportHash: 'Report digest',
  evidenceHash: 'Evidence digest',
  downloadDocument: 'Open the submitted document',
  downloadReport: 'Open the submitted report',

  resubmitTitle: 'Send a revised version',
  resubmitHint:
    'Run a new check on the corrected document, then submit that check. It joins this case as ' +
    'the next revision.',

  queueTitle: 'Submission queue',
  queueIntro:
    'Documents people have chosen to submit to you. You see the exact copy each person handed ' +
    'over, and nothing else from their account.',
  queueEmpty: 'Nothing is waiting for review.',
  queueSubmitter: 'Submitter',
  queueStandard: 'Standard',
  queueResult: 'Technical result',
  determinationLabel: 'Determination',
  scoreLabel: 'Score',
  ruleCounts: (passed, total) => `${passed} of ${total} rules passed`,
  queueStatus: 'Decision',
  filterAll: 'All',

  reviewTitle: 'Review submission',
  reviewIntro: 'The exact document and report this person submitted.',
  reviewSeparation:
    'PalCert’s technical result is fixed and cannot be changed here. Your decision is separate ' +
    'from it: you may approve a submission PalCert found non-compliant, or reject one it found ' +
    'compliant.',
  startReview: 'Start review',
  approve: 'Approve',
  reject: 'Reject',
  requestRevision: 'Request a revision',
  deciding: 'Recording…',
  commentLabel: 'Comment',
  commentRequired: 'A rejection or a revision request must say why.',
  reasonLabel: 'Reason',
  addComment: 'Add comment',
  addingComment: 'Adding…',
  commentOnlyHint: 'A comment is a message to the submitter. It changes no status.',

  genericError: 'Something went wrong. Please try again.',
  errors: {
    SUBMISSION_NOT_FOUND: 'That submission could not be found.',
    SUBMISSION_REVISION_NOT_FOUND: 'That submission could not be found.',
    SUBMISSION_CHECK_NOT_COMPLETED: 'This check has not finished, so it cannot be submitted.',
    SUBMISSION_NOT_READY: 'This submission has not been handed over yet.',
    SUBMISSION_INVALID_TRANSITION: 'That decision is not available from the current state.',
    SUBMISSION_ALREADY_DECIDED: 'This submission has already been decided.',
    SUBMISSION_REVISION_CONFLICT:
      'This submission changed while you were reviewing it. Reload and look again.',
    SUBMISSION_RESUBMISSION_NOT_ALLOWED:
      'The institution has not asked for a revised version of this submission.',
    SUBMISSION_CHECK_ALREADY_SUBMITTED: 'You have already submitted this check.',
    SUBMISSION_COMMENT_REQUIRED: 'A rejection or a revision request must say why.',
    SUBMISSION_ORGANIZATION_NOT_ELIGIBLE:
      'This institution is not currently accepting official submissions.',
    SUBMISSION_ORGANIZATION_MISMATCH:
      'This check was not measured against that institution’s standard.',
    SUBMISSION_DOCUMENT_MISMATCH: 'A revision must be a check of the same document type.',
    IDEMPOTENCY_KEY_REUSED: 'That request was already used for a different submission.',
  },
};

const ar: SubmissionsMessages = {
  title: 'التقديمات الرسمية',
  intro:
    'فحص بال‌سيرت خاص بك. أما التقديم الرسمي فهو إجراء منفصل ومقصود: تسليم نسخة واحدة بعينها من ' +
    'مستندك وتقريرها إلى الجهة صاحبة المعيار.',
  empty: 'لم تقدّم أي مستند رسميًا بعد.',
  back: 'رجوع',
  columnDocument: 'المستند',
  columnInstitution: 'المؤسسة',
  columnUpdated: 'آخر تحديث',
  loading: 'جارٍ تحميل تقديماتك…',

  disclosureTitle: 'قبل التقديم',
  disclosureIntro: (organization) =>
    `سيُرسل ما يلي إلى ${organization}. لا يُرسل شيء حتى تضغط على «تقديم رسمي».`,
  willShare: 'ما ستتم مشاركته',
  willNotShare: 'ما لن تتم مشاركته',
  sharedItems: {
    SUBMITTED_DOCUMENT_VERSION: 'هذه النسخة بعينها من مستندك',
    TECHNICAL_REPORT: 'التقرير الفني لهذا الفحص',
    TECHNICAL_DETERMINATION: 'النتيجة الفنية',
    DETERMINISTIC_SCORE_AND_FINDINGS: 'الدرجة والنتائج قاعدةً بقاعدة',
    STANDARD_AND_VERSION: 'المعيار والإصدار الذي جرى الفحص وفقه',
    SUBMITTER_IDENTITY: 'اسمك وبريدك الإلكتروني',
  },
  notSharedItems: {
    OTHER_DOCUMENT_VERSIONS: 'أي نسخة أخرى من هذا المستند',
    OTHER_CHECKS: 'أي فحص آخر أجريته',
    AI_REVIEW: 'مراجعة الذكاء الاصطناعي الخاصة بك',
    SMARTFIX_PLAN_AND_MANIFEST: 'خطة التصحيح الذكي وما غيّرته',
    BALANCE_AND_PAYMENTS: 'رصيدك ومدفوعاتك',
    UNRELATED_FILES: 'أي ملف آخر في حسابك',
  },
  submit: 'تقديم رسمي',
  submitting: 'جارٍ التقديم…',
  submitHint:
    'ينسخ بال‌سيرت البايتات نفسها والتقرير نفسه ويتحقق منهما، ولا يضع التقديم في قائمة الجهة ' +
    'إلا بعد ذلك.',
  cancel: 'إلغاء',

  technicalTitle: 'النتيجة الفنية من بال‌سيرت',
  technicalHint: 'ما قاسته قواعد المعيار. وهي ليست قرار الجهة، وللجهة أن تصل إلى نتيجة مختلفة.',
  decisionTitle: 'قرار الجهة',
  decisionHint: 'قرار إداري تتخذه الجهة بشأن هذا التقديم. يسجّله بال‌سيرت ولا يؤثر فيه.',

  displayStatuses: {
    NOT_SUBMITTED: 'لم يُقدَّم',
    SUBMITTED: 'مُقدَّم',
    UNDER_REVIEW: 'قيد المراجعة',
    APPROVED: 'مقبول',
    REJECTED: 'مرفوض',
    REVISION_REQUESTED: 'مطلوب تعديل',
  },
  processingStatuses: {
    PREPARING: 'قيد التحضير',
    READY: 'تم التسليم',
    FAILED: 'تعذّر التحضير',
  },
  processingHints: {
    PREPARING: 'يقوم بال‌سيرت بنسخ الأدلة والتحقق منها. لم يُعرض على الجهة أي شيء بعد.',
    READY: 'استلمت الجهة هذا التقديم.',
    FAILED: 'لم يكتمل التحضير، فلم يُرسل شيء. وهذا ليس قرارًا من الجهة.',
  },
  failureCodes: {
    SOURCE_UNAVAILABLE: 'تعذّرت قراءة المستند أو التقرير.',
    DIGEST_MISMATCH: 'لم تعد البايتات المحفوظة مطابقة لما سجّله الفحص.',
    SNAPSHOT_COPY_FAILED: 'تعذّر إتمام النسخ.',
    SNAPSHOT_VERIFICATION_FAILED: 'لم تطابق النسخة الأصل.',
  },
  reasonCodes: {
    TECHNICAL_CORRECTIONS_REQUIRED: 'مطلوب تصحيحات فنية',
    DOCUMENT_INCOMPLETE: 'المستند غير مكتمل',
    ADMINISTRATIVE_REQUIREMENT: 'متطلب إداري',
    OTHER: 'أخرى',
  },

  revisionLabel: (n) => `المراجعة ${n}`,
  revisionCount: (n) => (n === 1 ? 'مراجعة واحدة' : `${n} مراجعات`),
  submittedAt: 'تاريخ التقديم',
  decidedAt: 'تاريخ القرار',
  reviewStartedAt: 'بدء المراجعة',

  historyTitle: 'السجل',
  historyBySystem: 'بال‌سيرت',
  historyByInstitution: 'الجهة',
  commentsTitle: 'ملاحظات الجهة',
  commentsEmpty: 'لا توجد ملاحظات بعد.',

  evidenceTitle: 'الأدلة',
  evidenceHint: 'تقرأ الجهة هذه النسخة بعينها. لم يُعد توليد أي شيء أو بناؤه من جديد.',
  documentHash: 'بصمة المستند',
  reportHash: 'بصمة التقرير',
  evidenceHash: 'بصمة الأدلة',
  downloadDocument: 'فتح المستند المُقدَّم',
  downloadReport: 'فتح التقرير المُقدَّم',

  resubmitTitle: 'إرسال نسخة معدَّلة',
  resubmitHint:
    'أجرِ فحصًا جديدًا للمستند بعد تصحيحه، ثم قدّم ذلك الفحص. سينضم إلى هذه الحالة بوصفه المراجعة ' +
    'التالية.',

  queueTitle: 'قائمة التقديمات',
  queueIntro:
    'مستندات اختار أصحابها تقديمها إليكم. ترون النسخة التي سلّمها كل شخص بعينها، ولا شيء آخر من حسابه.',
  queueEmpty: 'لا يوجد ما ينتظر المراجعة.',
  queueSubmitter: 'مقدِّم الطلب',
  queueStandard: 'المعيار',
  queueResult: 'النتيجة الفنية',
  determinationLabel: 'الحكم',
  scoreLabel: 'الدرجة',
  ruleCounts: (passed, total) => `اجتاز ${passed} من ${total} قاعدة`,
  queueStatus: 'القرار',
  filterAll: 'الكل',

  reviewTitle: 'مراجعة التقديم',
  reviewIntro: 'المستند والتقرير اللذان قدّمهما هذا الشخص بعينهما.',
  reviewSeparation:
    'النتيجة الفنية من بال‌سيرت ثابتة ولا يمكن تغييرها هنا. وقرارك منفصل عنها: لك أن تقبل تقديمًا ' +
    'وجده بال‌سيرت غير مطابق، أو ترفض تقديمًا وجده مطابقًا.',
  startReview: 'بدء المراجعة',
  approve: 'قبول',
  reject: 'رفض',
  requestRevision: 'طلب تعديل',
  deciding: 'جارٍ التسجيل…',
  commentLabel: 'ملاحظة',
  commentRequired: 'يجب بيان سبب الرفض أو طلب التعديل.',
  reasonLabel: 'السبب',
  addComment: 'إضافة ملاحظة',
  addingComment: 'جارٍ الإضافة…',
  commentOnlyHint: 'الملاحظة رسالة إلى مقدِّم الطلب، ولا تغيّر أي حالة.',

  genericError: 'حدث خطأ ما. يرجى المحاولة مرة أخرى.',
  errors: {
    SUBMISSION_NOT_FOUND: 'تعذّر العثور على هذا التقديم.',
    SUBMISSION_REVISION_NOT_FOUND: 'تعذّر العثور على هذا التقديم.',
    SUBMISSION_CHECK_NOT_COMPLETED: 'لم ينتهِ هذا الفحص، فلا يمكن تقديمه.',
    SUBMISSION_NOT_READY: 'لم يُسلَّم هذا التقديم بعد.',
    SUBMISSION_INVALID_TRANSITION: 'هذا القرار غير متاح من الحالة الراهنة.',
    SUBMISSION_ALREADY_DECIDED: 'صدر قرار بشأن هذا التقديم من قبل.',
    SUBMISSION_REVISION_CONFLICT: 'تغيّر هذا التقديم أثناء مراجعتك له. أعد التحميل ثم انظر مجددًا.',
    SUBMISSION_RESUBMISSION_NOT_ALLOWED: 'لم تطلب الجهة نسخة معدَّلة من هذا التقديم.',
    SUBMISSION_CHECK_ALREADY_SUBMITTED: 'سبق أن قدّمت هذا الفحص.',
    SUBMISSION_COMMENT_REQUIRED: 'يجب بيان سبب الرفض أو طلب التعديل.',
    SUBMISSION_ORGANIZATION_NOT_ELIGIBLE: 'هذه الجهة لا تستقبل تقديمات رسمية حاليًا.',
    SUBMISSION_ORGANIZATION_MISMATCH: 'لم يُفحص هذا المستند وفق معيار تلك الجهة.',
    SUBMISSION_DOCUMENT_MISMATCH: 'يجب أن تكون المراجعة فحصًا لنوع المستند نفسه.',
    IDEMPOTENCY_KEY_REUSED: 'استُخدم هذا الطلب من قبل لتقديم مختلف.',
  },
};

export const SUBMISSIONS_MESSAGES: Readonly<Record<Locale, SubmissionsMessages>> = { en, ar };

export function getSubmissionsMessages(locale: Locale): SubmissionsMessages {
  return SUBMISSIONS_MESSAGES[locale] ?? SUBMISSIONS_MESSAGES.en;
}
