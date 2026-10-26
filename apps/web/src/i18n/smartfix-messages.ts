import type { Locale } from './locales';

/**
 * What a person reads about correcting their own document (Phase 12 §185–§195).
 *
 * Three rules shape every string here, and breaking any of them would mislead
 * somebody about their own thesis.
 *
 * **Never say "Fixed" before it is delivered.** Until the recheck has run and
 * the correction has been delivered, nothing has been fixed — it is being
 * prepared. Arabic keeps the same distinction: قيد التنفيذ, then تم التصحيح.
 *
 * **Describe the checked standard, not academic acceptance.** New corrections
 * require every applicable rule to pass. Historical deliveries may have used
 * the earlier partial policy, so their recheck remains the source of truth.
 *
 * **Reuse the finance vocabulary exactly.** Reserved / charged / reservation
 * released mean the same things here as in Phase 11 — محجوز / تم الخصم /
 * أُلغي الحجز — because a customer reading two screens about their own money
 * should not have to work out whether two words mean one thing.
 */
export interface SmartFixMessages {
  readonly title: string;
  readonly intro: string;
  readonly originalSafe: string;
  readonly aiConsent: string;
  readonly aiScope: string;
  readonly aiBundled: string;
  readonly aiApprove: string;
  readonly aiReserveAndPlan: string;
  readonly aiReserved: (amount: string) => string;
  readonly aiCancelReservation: string;
  readonly aiReservationEnded: string;
  readonly aiRounds: (rounds: number) => string;
  readonly aiStopReasons: Readonly<Record<string, string>>;

  readonly planTitle: string;
  readonly planIntro: string;
  readonly planFree: string;
  readonly planExpires: string;
  readonly planExpired: string;
  readonly planAgain: string;
  readonly planning: string;
  readonly nothingToCorrect: string;

  readonly willFix: (count: number) => string;
  readonly willNotFix: (count: number) => string;
  readonly changeCount: (count: number) => string;

  readonly fixability: Readonly<Record<string, string>>;
  readonly reasons: Readonly<Record<string, string>>;
  readonly refusals: Readonly<Record<string, string>>;

  readonly fullCorrectionUnavailable: string;
  readonly startTitle: string;
  readonly startHint: string;
  readonly start: string;
  readonly starting: string;
  readonly cancel: string;
  readonly cancelling: string;
  readonly cancelHint: string;

  readonly statuses: Readonly<Record<string, string>>;
  readonly statusHints: Readonly<Record<string, string>>;
  readonly failureCodes: Readonly<Record<string, string>>;

  readonly deliveredTitle: string;
  readonly deliveredHint: string;
  readonly stillFailing: string;
  readonly openCorrected: string;
  readonly openRecheck: string;

  readonly manifestTitle: string;
  readonly manifestIntro: string;
  readonly manifestEmpty: string;
  readonly proofTitle: string;
  readonly proofText: string;
  readonly proofMedia: string;
  readonly proofFields: string;
  readonly proofRelationships: string;
  readonly proofHeld: string;
  readonly proofBroken: string;

  readonly columnRule: string;
  readonly columnWhere: string;
  readonly columnBefore: string;
  readonly columnAfter: string;
  readonly notSet: string;

  readonly errors: Readonly<Record<string, string>>;
}

const en: SmartFixMessages = {
  aiApprove: 'Approve the plan and correct',
  aiBundled:
    'AI planning is included in the correction price. Review the plan before approving execution; no second reservation or separate AI charge.',
  aiReserveAndPlan: 'Reserve the correction price and plan with AI',
  aiReserved: (amount) => `Already reserved for this correction: ${amount}.`,
  aiCancelReservation: 'Cancel this plan and release the reservation',
  aiReservationEnded: 'This planning reservation has ended. Nothing is charged for the preview.',
  title: 'SmartFix',
  intro:
    'SmartFix corrects formatting your report flagged — sizes, fonts, spacing, margins — and ' +
    'nothing else. It does not rewrite your writing.',
  originalSafe:
    'Your original document is never changed. SmartFix produces a corrected copy as a new ' +
    'version.',

  planTitle: 'What SmartFix would change',
  aiConsent:
    'Use AI to plan formatting corrections. I agree to sharing formatting measurements and the selected standard rules with the configured external AI provider for this plan.',
  aiScope:
    'Document paragraphs, images and file bytes are not sent. AI proposes formatting values; PalCert checks all rules and preserves the content.',
  aiRounds: (rounds) => `AI planning rounds: ${rounds}.`,
  aiStopReasons: {
    VERIFIED: 'The preview passes all applicable rules. The delivered copy will be checked again.',
    NO_PROGRESS: 'AI could not resolve all requirements. Review the remaining rules below.',
    ROUND_LIMIT:
      'The planning limit was reached. The remaining rules still prevent full correction.',
  },
  planIntro: 'Every change is listed below before you decide. Nothing is charged for this list.',
  planFree: 'Free',
  planExpires: 'This plan is valid until',
  planExpired: 'This plan is out of date. Please create a new one.',
  planAgain: 'Create a new plan',
  planning: 'Working out what can be corrected…',
  nothingToCorrect: 'There is nothing here for SmartFix to correct.',

  willFix: (count) =>
    count === 1 ? '1 rule would be corrected' : `${count} rules would be corrected`,
  willNotFix: (count) =>
    count === 1 ? '1 rule needs your attention' : `${count} rules need your attention`,
  changeCount: (count) => (count === 1 ? '1 change' : `${count} changes`),

  fixability: {
    FIXABLE: 'Will be corrected',
    PARTIALLY_FIXABLE: 'Will be partly corrected',
    NOT_SUPPORTED: 'Cannot be corrected automatically',
    MANUAL_ACTION_REQUIRED: 'You need to change this yourself',
    INSUFFICIENT_LOCATION_EVIDENCE: 'PalCert cannot tell exactly where to change this',
    AMBIGUOUS_TARGET: 'There is more than one correct answer, so you should choose',
    SOURCE_DOCUMENT_UNSAFE_TO_EDIT: 'This document cannot be edited safely',
  },
  reasons: {
    SMARTFIX_PROPERTY_NOT_SUPPORTED: 'SmartFix cannot change this setting yet.',
    SMARTFIX_SCOPE_NOT_SUPPORTED: 'This rule is not about a single part of the document.',
    SMARTFIX_OPERATOR_AMBIGUOUS:
      'This rule allows more than one correct value, so the choice is yours.',
    SMARTFIX_CONTENT_CHANGE_REQUIRED:
      'Satisfying this means adding or removing content, which is your writing.',
    SMARTFIX_RULE_NOT_DETERMINISTIC: 'This rule needs judgement rather than a measurement.',
    SMARTFIX_AUTOFIX_NOT_SAFE: 'The institution marked this rule as needing a human.',
    SMARTFIX_COUNT_NOT_EDITABLE: 'A word or item count is a result of what you wrote.',
    SMARTFIX_PAGINATION_NOT_EDITABLE: 'Page layout is decided by Word when it opens the document.',
    SMARTFIX_LOCATION_EVIDENCE_MISSING: 'The report does not say exactly where to change this.',
    SMARTFIX_EXPECTED_VALUE_UNUSABLE: 'The required value cannot be applied to this setting.',
    SMARTFIX_TARGET_NOT_REPRESENTABLE:
      'Word cannot store exactly this value, so correcting it would not satisfy the rule.',
    SMARTFIX_METADATA_NOT_SUPPORTED: 'Document properties are yours to edit.',
    SMARTFIX_ELEMENT_TYPE_NOT_EDITABLE:
      'SmartFix does not change citations or reference entries, even their formatting.',
  },
  refusals: {
    SMARTFIX_TRACKED_CHANGES_UNSUPPORTED:
      'This document has tracked changes. Please accept or reject them first, so PalCert does ' +
      'not interfere with your review.',
    SMARTFIX_DOCUMENT_PROTECTED:
      'This document is protected against editing. Please remove the protection first.',
    SMARTFIX_SIGNED_DOCUMENT_UNSUPPORTED:
      'This document is digitally signed. Any change would break the signature.',
    SMARTFIX_SOURCE_FORMAT_UNSUPPORTED: 'SmartFix can only correct Word documents.',
  },

  fullCorrectionUnavailable:
    'Full correction is not available for this plan. Review the unresolved rules or create a new plan. Any AI planning reservation is released.',
  startTitle: 'Start the correction',
  startHint:
    'PalCert will correct a copy and recheck every rule in the same standard. Delivery and charging require every applicable rule to pass.',
  start: 'Reserve and correct',
  starting: 'Starting…',
  cancel: 'Cancel this correction',
  cancelling: 'Cancelling…',
  cancelHint: 'You can cancel until the re-check finishes. Nothing will be charged.',

  statuses: {
    RESERVED: 'Preparing',
    PROCESSING: 'Correcting',
    RECHECKING: 'Checking the corrected copy',
    VALIDATING: 'Confirming the result',
    DELIVERED: 'Corrected',
    FAILED: 'Not corrected',
    CANCELLED: 'Cancelled',
  },
  statusHints: {
    RESERVED: 'The amount is reserved. Nothing has been charged.',
    PROCESSING: 'PalCert is applying the changes you approved to a copy.',
    RECHECKING: 'PalCert is running the same check again on the corrected copy.',
    VALIDATING: 'PalCert is confirming that the corrections worked and nothing else changed.',
    DELIVERED: 'The corrected copy is ready, and the amount has been charged.',
    FAILED: 'No charge was made and the reserved amount has been returned.',
    CANCELLED: 'No charge was made and the reserved amount has been returned.',
  },
  failureCodes: {
    CANCELLED_BY_CUSTOMER: 'You cancelled this correction.',
    PLAN_STALE: 'Your document changed after the plan was made. Please create a new plan.',
    SOURCE_UNSUITABLE: 'PalCert could not read this document for correction.',
    CORRECTION_REFUSED: 'PalCert could not apply the changes safely, so it made none.',
    OUTPUT_REJECTED: 'The corrected copy did not pass PalCert’s own safety checks.',
    OUTPUT_UNREADABLE: 'PalCert could not read the corrected copy back.',
    RECHECK_FAILED: 'The re-check could not be completed.',
    SMARTFIX_TARGETS_NOT_RESOLVED:
      'Some standard rules are still failed or unresolved, so nothing was ' +
      'delivered and nothing was charged.',
    SMARTFIX_REGRESSION_DETECTED:
      'The corrected copy would have broken a rule that previously passed, so PalCert discarded ' +
      'it. Nothing was charged.',
    SERVICE_FAILED: 'PalCert could not complete this correction.',
  },

  deliveredTitle: 'Your corrected copy is ready',
  deliveredHint:
    'SmartFix corrected the formatting listed below. Your original version is unchanged and ' +
    'still available.',
  stillFailing: 'See the re-check report for the result of every rule in this standard version.',
  openCorrected: 'Open the corrected version',
  openRecheck: 'See the re-check report',

  manifestTitle: 'What was changed',
  manifestIntro: 'Every change PalCert made, read back from the corrected file itself.',
  manifestEmpty: 'No changes were recorded.',
  proofTitle: 'What was not changed',
  proofText: 'Your text',
  proofMedia: 'Images and fonts',
  proofFields: 'Fields, such as the table of contents',
  proofRelationships: 'Links between parts of the document',
  proofHeld: 'Identical to your original',
  proofBroken: 'Changed — PalCert would not deliver this',

  columnRule: 'Requirement',
  columnWhere: 'Where',
  columnBefore: 'Was',
  columnAfter: 'Now',
  notSet: 'Not set',

  errors: {
    AI_DISABLED: 'AI formatting is not enabled on this server.',
    AI_CONSENT_REQUIRED: 'Agree to sharing formatting measurements before requesting AI planning.',
    AI_PROVIDER_UNAVAILABLE: 'The AI provider is unavailable. No correction was purchased.',
    AI_RESPONSE_INVALID: 'The AI response could not be validated. No correction was purchased.',
    SMARTFIX_NOT_AVAILABLE: 'SmartFix is not available for this check.',
    SMARTFIX_FAILED: 'PalCert could not complete this correction.',
    INSUFFICIENT_BALANCE: 'Your balance is not enough for this correction.',
    QUOTE_EXPIRED: 'That price is no longer current. Please get the current price.',
    QUOTE_ALREADY_USED: 'That price has already been used. Please get a new one.',
    NOT_FOUND: 'That correction could not be found.',
  },
};

const ar: SmartFixMessages = {
  aiApprove: 'اعتمد الخطة وابدأ التصحيح',
  aiBundled:
    'تخطيط الذكاء الاصطناعي ضمن سعر التصحيح. راجع الخطة قبل الموافقة على تنفيذها؛ لا يُحجز المبلغ مرتين ولا توجد رسوم منفصلة للذكاء الاصطناعي.',
  aiReserveAndPlan: 'احجز سعر التصحيح وأنشئ الخطة بالذكاء الاصطناعي',
  aiReserved: (amount) => `المبلغ المحجوز لهذا التصحيح: ${amount}.`,
  aiCancelReservation: 'إلغاء الخطة وتحرير المبلغ المحجوز',
  aiReservationEnded: 'انتهى حجز هذه الخطة. لا يُخصم مبلغ مقابل المعاينة.',
  title: 'التصحيح الذكي',
  intro:
    'يصحّح التصحيح الذكي التنسيق الذي رصده تقريرك — الأحجام والخطوط والتباعد والهوامش — ولا ' +
    'يمسّ غير ذلك. وهو لا يعيد كتابة ما كتبته.',
  originalSafe: 'لا يُعدَّل مستندك الأصلي أبدًا. ينتج التصحيح الذكي نسخة مصحَّحة كإصدار جديد.',

  planTitle: 'ما الذي سيغيّره التصحيح الذكي',
  aiConsent:
    'استخدام الذكاء الاصطناعي لتخطيط تصحيح التنسيق. أوافق على إرسال قياسات التنسيق وقواعد المعيار المختار إلى مزوّد الذكاء الاصطناعي الخارجي المعتمد لهذه الخطة.',
  aiScope:
    'لا تُرسل فقرات المستند أو صوره أو الملف نفسه. يقترح الذكاء الاصطناعي قيم التنسيق، ويتحقق النظام من جميع القواعد مع الحفاظ على المحتوى.',
  aiRounds: (rounds) => `جولات التخطيط بالذكاء الاصطناعي: ${rounds}.`,
  aiStopReasons: {
    VERIFIED:
      'اجتازت النسخة التجريبية جميع القواعد المنطبقة. سيُعاد فحص النسخة النهائية قبل تسليمها.',
    NO_PROGRESS: 'لم يتمكن الذكاء الاصطناعي من حسم جميع المتطلبات. راجع القواعد المتبقية أدناه.',
    ROUND_LIMIT: 'اكتملت جولات التخطيط المتاحة، وما زالت القواعد المتبقية تمنع اكتمال التصحيح.',
  },
  planIntro: 'كل تغيير مذكور أدناه قبل أن تقرّر. ولا يُخصم أي مبلغ مقابل هذه القائمة.',
  planFree: 'مجانًا',
  planExpires: 'هذه الخطة سارية حتى',
  planExpired: 'لم تعد هذه الخطة محدَّثة. يرجى إنشاء خطة جديدة.',
  planAgain: 'أنشئ خطة جديدة',
  planning: 'جارٍ تحديد ما يمكن تصحيحه…',
  nothingToCorrect: 'لا يوجد هنا ما يمكن للتصحيح الذكي تصحيحه.',

  willFix: (count) => (count === 1 ? 'سيُصحَّح شرط واحد' : `ستُصحَّح ${count} شروط`),
  willNotFix: (count) =>
    count === 1 ? 'شرط واحد يحتاج إلى انتباهك' : `${count} شروط تحتاج إلى انتباهك`,
  changeCount: (count) => (count === 1 ? 'تغيير واحد' : `${count} تغييرات`),

  fixability: {
    FIXABLE: 'سيُصحَّح',
    PARTIALLY_FIXABLE: 'سيُصحَّح جزئيًا',
    NOT_SUPPORTED: 'لا يمكن تصحيحه تلقائيًا',
    MANUAL_ACTION_REQUIRED: 'عليك تغييره بنفسك',
    INSUFFICIENT_LOCATION_EVIDENCE: 'لا يستطيع بال‌سيرت تحديد موضع التغيير بدقة',
    AMBIGUOUS_TARGET: 'هناك أكثر من إجابة صحيحة، والاختيار لك',
    SOURCE_DOCUMENT_UNSAFE_TO_EDIT: 'لا يمكن تعديل هذا المستند بأمان',
  },
  reasons: {
    SMARTFIX_PROPERTY_NOT_SUPPORTED: 'لا يستطيع التصحيح الذكي تغيير هذا الإعداد بعد.',
    SMARTFIX_SCOPE_NOT_SUPPORTED: 'لا يتعلق هذا الشرط بجزء واحد محدَّد من المستند.',
    SMARTFIX_OPERATOR_AMBIGUOUS: 'يسمح هذا الشرط بأكثر من قيمة صحيحة، والاختيار لك.',
    SMARTFIX_CONTENT_CHANGE_REQUIRED: 'تحقيق هذا يعني إضافة محتوى أو حذفه، وهذا من كتابتك.',
    SMARTFIX_RULE_NOT_DETERMINISTIC: 'يحتاج هذا الشرط إلى تقدير بشري لا إلى قياس.',
    SMARTFIX_AUTOFIX_NOT_SAFE: 'وضعت الجهة علامة على هذا الشرط بأنه يحتاج إلى مراجعة بشرية.',
    SMARTFIX_COUNT_NOT_EDITABLE: 'عدد الكلمات أو العناصر نتيجة لما كتبته.',
    SMARTFIX_PAGINATION_NOT_EDITABLE: 'يحدّد وورد توزيع الصفحات عند فتح المستند.',
    SMARTFIX_LOCATION_EVIDENCE_MISSING: 'لا يحدّد التقرير موضع التغيير بدقة.',
    SMARTFIX_EXPECTED_VALUE_UNUSABLE: 'لا يمكن تطبيق القيمة المطلوبة على هذا الإعداد.',
    SMARTFIX_TARGET_NOT_REPRESENTABLE:
      'لا يستطيع وورد تخزين هذه القيمة بالضبط، فلن يحقّق تصحيحها الشرط.',
    SMARTFIX_METADATA_NOT_SUPPORTED: 'خصائص المستند من مسؤوليتك أنت.',
    SMARTFIX_ELEMENT_TYPE_NOT_EDITABLE:
      'لا يغيّر التصحيح الذكي الاستشهادات أو مُدخلات المراجع، ولا حتى تنسيقها.',
  },
  refusals: {
    SMARTFIX_TRACKED_CHANGES_UNSUPPORTED:
      'يحتوي هذا المستند على تعقّب تغييرات. يرجى قبولها أو رفضها أولًا حتى لا يتدخّل بال‌سيرت ' +
      'في مراجعتك.',
    SMARTFIX_DOCUMENT_PROTECTED: 'هذا المستند محميّ من التعديل. يرجى إزالة الحماية أولًا.',
    SMARTFIX_SIGNED_DOCUMENT_UNSUPPORTED: 'هذا المستند موقَّع رقميًا، وأي تغيير سيُبطل التوقيع.',
    SMARTFIX_SOURCE_FORMAT_UNSUPPORTED: 'يصحّح التصحيح الذكي مستندات وورد فقط.',
  },

  fullCorrectionUnavailable:
    'لا يمكن إكمال التصحيح بهذه الخطة. راجع القواعد غير المحسومة أو أنشئ خطة جديدة. يُحرَّر أي مبلغ حُجز لتخطيط الذكاء الاصطناعي.',
  startTitle: 'ابدأ التصحيح',
  startHint:
    'سيصحّح بال‌سيرت نسخة ويعيد فحص جميع قواعد المعيار نفسه. لن تُسلَّم النسخة ولن يُخصم المبلغ إلا بعد اجتياز جميع القواعد المنطبقة.',
  start: 'احجز المبلغ وصحّح',
  starting: 'جارٍ البدء…',
  cancel: 'ألغِ هذا التصحيح',
  cancelling: 'جارٍ الإلغاء…',
  cancelHint: 'يمكنك الإلغاء حتى انتهاء إعادة الفحص. ولن يُخصم أي مبلغ.',

  statuses: {
    RESERVED: 'قيد التحضير',
    PROCESSING: 'قيد التصحيح',
    RECHECKING: 'جارٍ فحص النسخة المصحَّحة',
    VALIDATING: 'جارٍ تأكيد النتيجة',
    DELIVERED: 'تم التصحيح',
    FAILED: 'لم يتم التصحيح',
    CANCELLED: 'أُلغي',
  },
  statusHints: {
    RESERVED: 'المبلغ محجوز. ولم يُخصم شيء.',
    PROCESSING: 'يطبّق بال‌سيرت التغييرات التي وافقت عليها على نسخة.',
    RECHECKING: 'يعيد بال‌سيرت الفحص نفسه على النسخة المصحَّحة.',
    VALIDATING: 'يؤكّد بال‌سيرت نجاح التصحيحات وعدم تغيّر أي شيء آخر.',
    DELIVERED: 'النسخة المصحَّحة جاهزة، وقد تم خصم المبلغ.',
    FAILED: 'لم يُخصم أي مبلغ، وأُعيد المبلغ المحجوز إلى رصيدك.',
    CANCELLED: 'لم يُخصم أي مبلغ، وأُعيد المبلغ المحجوز إلى رصيدك.',
  },
  failureCodes: {
    CANCELLED_BY_CUSTOMER: 'ألغيتَ هذا التصحيح.',
    PLAN_STALE: 'تغيّر مستندك بعد إنشاء الخطة. يرجى إنشاء خطة جديدة.',
    SOURCE_UNSUITABLE: 'تعذّر على بال‌سيرت قراءة هذا المستند للتصحيح.',
    CORRECTION_REFUSED: 'تعذّر على بال‌سيرت تطبيق التغييرات بأمان، فلم يُجرِ أيًّا منها.',
    OUTPUT_REJECTED: 'لم تجتز النسخة المصحَّحة فحوص الأمان الخاصة ببال‌سيرت.',
    OUTPUT_UNREADABLE: 'تعذّر على بال‌سيرت قراءة النسخة المصحَّحة.',
    RECHECK_FAILED: 'تعذّر إكمال إعادة الفحص.',
    SMARTFIX_TARGETS_NOT_RESOLVED:
      'ما زالت بعض قواعد المعيار غير محقَّقة أو غير محسومة، فلم يُسلَّم شيء ولم يُخصم ' +
      'أي مبلغ.',
    SMARTFIX_REGRESSION_DETECTED:
      'كانت النسخة المصحَّحة ستُخلّ بشرط كان محقَّقًا من قبل، فاستبعدها بال‌سيرت. ولم يُخصم أي ' +
      'مبلغ.',
    SERVICE_FAILED: 'تعذّر على بال‌سيرت إتمام هذا التصحيح.',
  },

  deliveredTitle: 'نسختك المصحَّحة جاهزة',
  deliveredHint:
    'صحّح التصحيح الذكي التنسيق المذكور أدناه. ونسختك الأصلية لم تتغيّر وما زالت متاحة.',
  stillFailing: 'اطّلع على تقرير إعادة الفحص لمعرفة نتيجة كل قاعدة في هذه النسخة من المعيار.',
  openCorrected: 'افتح النسخة المصحَّحة',
  openRecheck: 'اطّلع على تقرير إعادة الفحص',

  manifestTitle: 'ما الذي تغيّر',
  manifestIntro: 'كل تغيير أجراه بال‌سيرت، مقروءًا من الملف المصحَّح نفسه.',
  manifestEmpty: 'لم تُسجَّل أي تغييرات.',
  proofTitle: 'ما الذي لم يتغيّر',
  proofText: 'نصّك',
  proofMedia: 'الصور والخطوط',
  proofFields: 'الحقول، مثل جدول المحتويات',
  proofRelationships: 'الروابط بين أجزاء المستند',
  proofHeld: 'مطابق لأصلك تمامًا',
  proofBroken: 'تغيّر — ولن يسلّم بال‌سيرت هذه النسخة',

  columnRule: 'المتطلَّب',
  columnWhere: 'الموضع',
  columnBefore: 'كان',
  columnAfter: 'أصبح',
  notSet: 'غير محدَّد',

  errors: {
    SMARTFIX_NOT_AVAILABLE: 'التصحيح الذكي غير متاح لهذا الفحص.',
    AI_DISABLED: 'تصحيح التنسيق بالذكاء الاصطناعي غير مفعّل على الخادم.',
    AI_CONSENT_REQUIRED: 'وافق على إرسال قياسات التنسيق قبل طلب التخطيط بالذكاء الاصطناعي.',
    AI_PROVIDER_UNAVAILABLE: 'مزوّد الذكاء الاصطناعي غير متاح حاليًا. لم يتم شراء أي تصحيح.',
    AI_RESPONSE_INVALID: 'تعذّر التحقق من استجابة الذكاء الاصطناعي. لم يتم شراء أي تصحيح.',
    SMARTFIX_FAILED: 'تعذّر على بال‌سيرت إتمام هذا التصحيح.',
    INSUFFICIENT_BALANCE: 'رصيدك لا يكفي لهذا التصحيح.',
    QUOTE_EXPIRED: 'لم يعد هذا السعر ساريًا. يرجى الحصول على السعر الحالي.',
    QUOTE_ALREADY_USED: 'استُخدم هذا السعر من قبل. يرجى الحصول على سعر جديد.',
    NOT_FOUND: 'تعذّر العثور على هذا التصحيح.',
  },
};

export const SMARTFIX_MESSAGES: Readonly<Record<Locale, SmartFixMessages>> = { en, ar };

export function getSmartFixMessages(locale: Locale): SmartFixMessages {
  return SMARTFIX_MESSAGES[locale] ?? SMARTFIX_MESSAGES.en;
}
