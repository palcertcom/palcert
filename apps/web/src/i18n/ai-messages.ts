import type { Locale } from './locales';

/**
 * AI review message catalogue (Phase 8, §65–§68, §89).
 *
 * Every word a person reads about AI output lives here, in both languages, and
 * the wording carries the phase's central claim: the deterministic result is
 * the technical answer, and the AI is a separate, advisory second opinion that
 * cannot approve anything.
 *
 * Three rules shape it. It never says approved, accepted or certified. It
 * describes an AI assessment as an appearance ("appears satisfied"), never as
 * a fact. And the disclaimer is professional rather than alarmist: a wall of
 * warnings teaches people to skip warnings.
 */
export interface AIMessages {
  readonly sectionTitle: string;
  readonly sectionSubtitle: string;
  readonly technicalResultTitle: string;

  readonly consentTitle: string;
  readonly consentExplanation: string;
  readonly consentProviderNote: string;
  readonly consentRetentionNote: string;
  readonly consentAgree: string;
  readonly consentWithdraw: string;
  readonly consentGrantedOn: string;
  readonly consentSettingsTitle: string;
  readonly consentNone: string;
  readonly consentWithdrawIntro: string;
  readonly consentWithdrawn: string;
  readonly consentRenewalRequired: string;

  readonly startReview: string;
  readonly starting: string;
  readonly unavailable: string;
  readonly unavailableHint: string;
  readonly noReviewYet: string;
  readonly reviewRunning: string;
  readonly reviewFailed: string;
  readonly reviewFailedHint: string;
  readonly retry: string;
  readonly cancelReview: string;
  readonly cancelling: string;
  readonly reviewCancelled: string;
  readonly manageConsent: string;

  readonly assessments: string;
  readonly assessmentLabels: Readonly<Record<string, string>>;
  readonly machineStatus: string;
  readonly aiAssessment: string;
  readonly finalStatus: string;
  readonly humanReviewRequired: string;
  readonly humanReviewNotRequired: string;
  readonly evidence: string;
  readonly evidenceInsufficient: string;
  readonly contextTruncated: string;

  readonly summary: string;
  readonly recommendations: string;
  readonly priorities: Readonly<Record<string, string>>;

  readonly disclaimer: string;
  readonly notAnApproval: string;
  readonly modelLabel: string;
  readonly reviewedOn: string;
  readonly integrityLabel: string;

  readonly errors: Readonly<Record<string, string>>;
  readonly genericError: string;
}

const en: AIMessages = {
  sectionTitle: 'PalCert AI review',
  sectionSubtitle:
    'A second opinion on the requirements that need reading rather than measuring. It does not change the technical result above.',
  technicalResultTitle: 'PalCert technical result',

  consentTitle: 'Before your first AI review',
  consentExplanation:
    'To review the requirements that need reading, PalCert sends selected parts of your document — an outline, the paragraphs relevant to those requirements, and the findings already measured — to an external AI provider configured by PalCert. It does not send your whole document, and it never sends your file.',
  consentProviderNote: 'Processing happens at that provider, not only on PalCert’s own servers.',
  consentRetentionNote:
    'How long the provider retains what it processes is governed by PalCert’s agreement with them, which your institution or PalCert can describe on request.',
  consentAgree: 'I understand — run an AI review',
  consentWithdraw: 'Withdraw my agreement',
  consentGrantedOn: 'You agreed on',
  consentSettingsTitle: 'External AI processing',
  consentNone:
    'You have not agreed to external AI processing. PalCert asks before your first AI review.',
  consentWithdrawIntro:
    'PalCert will stop sending parts of your documents to the external AI provider. Reviews ' +
    'already completed stay as they are. You will be asked again before any new AI review.',
  consentWithdrawn: 'Your agreement is withdrawn. PalCert will ask before any new AI review.',
  consentRenewalRequired:
    'What PalCert sends has changed since you last agreed. Please read the notice again.',

  startReview: 'Run an AI review',
  starting: 'Starting…',
  unavailable: 'AI review is temporarily unavailable.',
  unavailableHint: 'Your PalCert technical report is unaffected.',
  noReviewYet: 'No AI review has been run for this check.',
  reviewRunning: 'The AI review is running. You can leave this page and come back.',
  reviewFailed: 'The AI review could not be completed.',
  reviewFailedHint: 'Your PalCert technical report is unaffected. You can try again.',
  retry: 'Try again',
  cancelReview: 'Cancel this review',
  cancelling: 'Cancelling…',
  reviewCancelled: 'This review was cancelled before anything was sent for analysis.',
  manageConsent: 'Change your AI agreement in your profile',

  assessments: 'AI-assisted requirements',
  assessmentLabels: {
    SATISFIED: 'Appears satisfied',
    NOT_SATISFIED: 'Appears not satisfied',
    INSUFFICIENT_EVIDENCE: 'Not enough evidence to say',
  },
  machineStatus: 'Machine status',
  aiAssessment: 'AI assessment',
  finalStatus: 'Final status',
  humanReviewRequired: 'Human review still required',
  humanReviewNotRequired: 'Advisory only',
  evidence: 'Based on',
  evidenceInsufficient: 'The supplied evidence could not support a conclusion.',
  contextTruncated:
    'Only part of the document was sent, so some requirements may be answered as “not enough evidence”.',

  summary: 'What this means',
  recommendations: 'Suggested next steps',
  priorities: { HIGH: 'Most important', MEDIUM: 'Worth doing', LOW: 'Optional' },

  disclaimer:
    'AI-generated assessments can be wrong. The measurements in the technical report above are unchanged by this review, and requirements marked as needing human review still do.',
  notAnApproval:
    'PalCert checks formatting against a published standard. Neither the technical report nor this AI review approves, accepts or certifies your document.',
  modelLabel: 'Reviewed by',
  reviewedOn: 'Reviewed on',
  integrityLabel: 'AI review fingerprint',

  errors: {
    AI_DISABLED: 'AI review is not available on this deployment.',
    AI_CONSENT_REQUIRED: 'AI review runs only after you agree to external processing.',
    AI_REVIEW_NOT_FOUND: 'That AI review could not be found.',
    AI_REVIEW_CHECK_NOT_COMPLETED: 'AI review runs on a completed check.',
    AI_REVIEW_NO_ASSESSABLE_RULES: 'This standard has no requirements that need an AI review.',
    AI_REVIEW_NOT_CANCELLABLE: 'This review has already started and cannot be cancelled.',
    AI_EVIDENCE_INTEGRITY_FAILED:
      'The evidence behind this report could not be verified, so no AI review was run.',
    AI_PROVIDER_UNAVAILABLE: 'AI review is temporarily unavailable.',
  },
  genericError: 'Something went wrong. Please try again.',
};

const ar: AIMessages = {
  sectionTitle: 'مراجعة PalCert بالذكاء الاصطناعي',
  sectionSubtitle:
    'رأي ثانٍ حول المتطلبات التي تحتاج قراءة لا قياساً. وهي لا تغيّر النتيجة الفنية أعلاه.',
  technicalResultTitle: 'النتيجة الفنية من PalCert',

  consentTitle: 'قبل أول مراجعة بالذكاء الاصطناعي',
  consentExplanation:
    'لمراجعة المتطلبات التي تحتاج قراءة، يرسل PalCert أجزاءً مختارة من مستندك — مخططاً للعناوين، والفقرات المتصلة بتلك المتطلبات، والنتائج المقيسة سلفاً — إلى مزوّد ذكاء اصطناعي خارجي يحدده PalCert. ولا يرسل مستندك كاملاً، ولا يرسل ملفك إطلاقاً.',
  consentProviderNote: 'تجري المعالجة لدى ذلك المزوّد، لا على خوادم PalCert وحدها.',
  consentRetentionNote:
    'تخضع مدة احتفاظ المزوّد بما يعالجه لاتفاق PalCert معه، ويمكن لمؤسستك أو لـ PalCert بيانها عند الطلب.',
  consentAgree: 'أوافق — نفّذ مراجعة بالذكاء الاصطناعي',
  consentWithdraw: 'سحب الموافقة',
  consentGrantedOn: 'وافقت بتاريخ',
  consentSettingsTitle: 'المعالجة الخارجية بالذكاء الاصطناعي',
  consentNone:
    'لم توافق على المعالجة الخارجية بالذكاء الاصطناعي. يطلب PalCert موافقتك قبل أول مراجعة بالذكاء الاصطناعي.',
  consentWithdrawIntro:
    'سيتوقف PalCert عن إرسال أجزاء من مستنداتك إلى مزوّد الذكاء الاصطناعي الخارجي. وتبقى ' +
    'المراجعات المكتملة كما هي، وستُسأل مجددًا قبل أي مراجعة جديدة.',
  consentWithdrawn: 'تم سحب موافقتك. سيطلب PalCert موافقتك قبل أي مراجعة جديدة.',
  consentRenewalRequired: 'تغيّر ما يرسله PalCert منذ موافقتك الأخيرة. يرجى قراءة الإشعار مجدداً.',

  startReview: 'نفّذ مراجعة بالذكاء الاصطناعي',
  starting: 'جارٍ البدء…',
  unavailable: 'المراجعة بالذكاء الاصطناعي غير متاحة مؤقتاً.',
  unavailableHint: 'تقريرك الفني من PalCert غير متأثر.',
  noReviewYet: 'لم تُنفَّذ أي مراجعة بالذكاء الاصطناعي لهذا الفحص.',
  reviewRunning: 'المراجعة جارية. يمكنك مغادرة هذه الصفحة والعودة إليها.',
  reviewFailed: 'تعذّر إكمال المراجعة بالذكاء الاصطناعي.',
  reviewFailedHint: 'تقريرك الفني غير متأثر. يمكنك المحاولة مرة أخرى.',
  retry: 'حاول مرة أخرى',
  cancelReview: 'إلغاء هذه المراجعة',
  cancelling: 'جارٍ الإلغاء…',
  reviewCancelled: 'أُلغيت هذه المراجعة قبل إرسال أي شيء للتحليل.',
  manageConsent: 'غيّر موافقتك على الذكاء الاصطناعي من ملفك الشخصي',

  assessments: 'المتطلبات المدعومة بالذكاء الاصطناعي',
  assessmentLabels: {
    SATISFIED: 'يبدو مستوفى',
    NOT_SATISFIED: 'يبدو غير مستوفى',
    INSUFFICIENT_EVIDENCE: 'لا تكفي الأدلة للحكم',
  },
  machineStatus: 'الحالة الآلية',
  aiAssessment: 'تقييم الذكاء الاصطناعي',
  finalStatus: 'الحالة النهائية',
  humanReviewRequired: 'ما زالت المراجعة البشرية مطلوبة',
  humanReviewNotRequired: 'إرشادي فقط',
  evidence: 'استناداً إلى',
  evidenceInsufficient: 'لم تكن الأدلة المقدمة كافية للوصول إلى نتيجة.',
  contextTruncated: 'أُرسل جزء من المستند فقط، لذا قد تأتي بعض المتطلبات بنتيجة «لا تكفي الأدلة».',

  summary: 'ماذا يعني ذلك',
  recommendations: 'خطوات مقترحة',
  priorities: { HIGH: 'الأهم', MEDIUM: 'يستحق التنفيذ', LOW: 'اختياري' },

  disclaimer:
    'قد تكون تقييمات الذكاء الاصطناعي خاطئة. والقياسات في التقرير الفني أعلاه لا تتغير بهذه المراجعة، والمتطلبات الموسومة بأنها تحتاج مراجعة بشرية تظل كذلك.',
  notAnApproval:
    'يفحص PalCert التنسيق وفق معيار منشور. ولا التقرير الفني ولا هذه المراجعة يعتمدان مستندك أو يقبلانه أو يصدران له شهادة.',
  modelLabel: 'نُفِّذت بواسطة',
  reviewedOn: 'تاريخ المراجعة',
  integrityLabel: 'بصمة مراجعة الذكاء الاصطناعي',

  errors: {
    AI_DISABLED: 'المراجعة بالذكاء الاصطناعي غير متاحة في هذا التثبيت.',
    AI_CONSENT_REQUIRED: 'لا تُنفَّذ المراجعة إلا بعد موافقتك على المعالجة الخارجية.',
    AI_REVIEW_NOT_FOUND: 'تعذّر العثور على هذه المراجعة.',
    AI_REVIEW_CHECK_NOT_COMPLETED: 'تُنفَّذ المراجعة على فحص مكتمل.',
    AI_REVIEW_NO_ASSESSABLE_RULES: 'لا يتضمن هذا المعيار متطلبات تحتاج مراجعة بالذكاء الاصطناعي.',
    AI_REVIEW_NOT_CANCELLABLE: 'بدأت هذه المراجعة بالفعل ولا يمكن إلغاؤها.',
    AI_EVIDENCE_INTEGRITY_FAILED: 'تعذّر التحقق من الأدلة خلف هذا التقرير، فلم تُنفَّذ المراجعة.',
    AI_PROVIDER_UNAVAILABLE: 'المراجعة بالذكاء الاصطناعي غير متاحة مؤقتاً.',
  },
  genericError: 'حدث خطأ ما. يرجى المحاولة مرة أخرى.',
};

export const AI_MESSAGES: Readonly<Record<Locale, AIMessages>> = { en, ar };

export function getAIMessages(locale: Locale): AIMessages {
  return AI_MESSAGES[locale] ?? AI_MESSAGES.en;
}
