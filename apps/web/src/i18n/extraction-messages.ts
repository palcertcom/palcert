import type { Locale } from './locales';

/**
 * Rule extraction message catalogue (Phase 9, §94–§98, §126, §127, §129, §147).
 *
 * The wording here is load-bearing, not decoration. Phase 9's entire safety
 * argument is that AI proposes and a person decides, and the place that promise
 * is kept or broken for a reader is the label on a card.
 *
 * Four rules shape every string:
 *
 *   - A template observation is described as something **observed in a
 *     document**, never as something the institution requires (§4, §46). The
 *     two have separate vocabularies here precisely so they cannot be
 *     conflated by accident.
 *   - Nothing claims completeness. PalCert never says every requirement was
 *     found, because it does not know that (§93).
 *   - No confidence number, score or percentage appears anywhere (§34, §147).
 *     Counts do: "187 of 196 paragraphs" is a fact a reviewer can check.
 *   - Arabic text is a translation written for the reader, and says so when it
 *     is describing an English source (§127).
 */
export interface ExtractionMessages {
  readonly sectionTitle: string;
  readonly sectionSubtitle: string;
  readonly draftOnlyNotice: string;

  // --- sources -------------------------------------------------------------
  readonly sourcesTitle: string;
  readonly sourcesSubtitle: string;
  readonly noSources: string;
  readonly addSource: string;
  readonly sourceKindLabel: string;
  readonly sourceKinds: Readonly<Record<string, string>>;
  readonly sourceKindHints: Readonly<Record<string, string>>;
  readonly authorityLabel: string;
  readonly authorities: Readonly<Record<string, string>>;
  readonly authorityHint: string;
  readonly chooseFile: string;
  readonly uploading: string;
  readonly uploadProgress: string;
  readonly sourceStatuses: Readonly<Record<string, string>>;
  readonly sourceRejected: string;
  readonly sourceRejectionReasons: Readonly<Record<string, string>>;
  readonly legacyEquationsNotice: string;
  readonly sourceImmutable: string;
  readonly retentionLocked: string;
  readonly removeSource: string;
  readonly confirmRemoveSource: string;
  readonly downloadSource: string;
  readonly pageCount: string;
  readonly digestLabel: string;

  // --- organization consent ------------------------------------------------
  readonly consentTitle: string;
  readonly consentExplanation: string;
  readonly consentProviderNote: string;
  readonly consentRetentionNote: string;
  readonly consentOrganizationScope: string;
  readonly consentAgree: string;
  readonly consentRevoke: string;
  readonly consentGrantedOn: string;
  readonly consentRenewalRequired: string;
  readonly consentNotPermitted: string;
  readonly manualAlternative: string;

  // --- runs ----------------------------------------------------------------
  readonly runTitle: string;
  readonly startExtraction: string;
  readonly starting: string;
  readonly running: string;
  readonly runStatuses: Readonly<Record<string, string>>;
  readonly runFailed: string;
  readonly runFailureKinds: Readonly<Record<string, string>>;
  readonly cancelRun: string;
  readonly noRunYet: string;
  readonly previousRuns: string;
  readonly runSupersededNotice: string;
  readonly modelLabel: string;
  readonly runHashLabel: string;
  readonly summaryTitle: string;
  readonly summaryLabels: Readonly<Record<string, string>>;
  readonly notExhaustive: string;

  // --- proposals -----------------------------------------------------------
  readonly proposalsTitle: string;
  readonly proposalsSubtitle: string;
  readonly noProposals: string;
  readonly proposalKinds: Readonly<Record<string, string>>;
  readonly proposalKindHints: Readonly<Record<string, string>>;
  readonly proposalStatuses: Readonly<Record<string, string>>;
  readonly interpretation: string;
  readonly interpretationIsTranslation: string;
  readonly suggestedRule: string;
  readonly evidenceTitle: string;
  readonly evidenceFrom: string;
  readonly evidencePage: string;
  readonly evidenceNode: string;
  readonly evidenceCharacters: string;
  readonly observationTitle: string;
  readonly observationObservedIn: string;
  readonly observationCounts: string;
  readonly observationNotARequirement: string;
  readonly uniformityLabels: Readonly<Record<string, string>>;
  readonly automationSupportLabels: Readonly<Record<string, string>>;
  readonly clarificationNeeded: string;
  readonly conflictTitle: string;
  readonly conflictExplanation: string;
  readonly conflictWithExistingRule: string;
  readonly conflictResolveYourself: string;
  readonly unrepresentableExplanation: string;
  readonly invalidProposalTitle: string;
  readonly invalidProposalExplanation: string;

  // --- decisions -----------------------------------------------------------
  readonly accept: string;
  readonly acceptEdited: string;
  readonly reject: string;
  readonly accepting: string;
  readonly acceptSelected: string;
  readonly selectForAcceptance: string;
  readonly nothingSelected: string;
  readonly skippedOnAccept: string;
  readonly decidedBy: string;
  readonly decidedOn: string;
  readonly acceptedAsEdited: string;
  readonly rejectionReasonLabel: string;
  readonly rejectionReasons: Readonly<Record<string, string>>;
  readonly reviewNotesLabel: string;
  readonly reviewNotesHint: string;
  readonly staleRevision: string;

  // --- provenance and the version page -------------------------------------
  readonly provenanceTitle: string;
  readonly provenanceFrom: string;
  readonly provenanceNotPartOfStandard: string;
  readonly provenanceRuleLabel: string;
  readonly provenanceChooseRule: string;
  readonly provenanceNone: string;
  readonly provenancePages: string;
  readonly countersTitle: string;
  readonly counterLabels: Readonly<Record<string, string>>;
  readonly publishWithPendingProposals: string;

  readonly errors: Readonly<Record<string, string>>;
  readonly genericError: string;
}

const en: ExtractionMessages = {
  sectionTitle: 'Guidelines and templates',
  sectionSubtitle:
    'Upload the documents your institution already has, and PalCert will read them and propose rules for this draft. Nothing is added to the standard until someone here accepts it.',
  draftOnlyNotice: 'Sources can be added and read only while this version is a draft.',

  sourcesTitle: 'Source documents',
  sourcesSubtitle:
    'These belong to the institution, not to the person who uploaded them, and stay attached to this version.',
  noSources: 'No source documents yet.',
  addSource: 'Add a source document',
  sourceKindLabel: 'What is this document?',
  sourceKinds: {
    GUIDELINE_PDF: 'Guidelines (PDF)',
    GUIDELINE_DOCX: 'Guidelines (Word)',
    TEMPLATE_DOCX: 'Template (Word)',
  },
  sourceKindHints: {
    GUIDELINE_PDF: 'A document that states what is required.',
    GUIDELINE_DOCX: 'A document that states what is required.',
    TEMPLATE_DOCX:
      'A model document that shows formatting. PalCert measures it and reports what it observes; what it observes is not automatically a requirement.',
  },
  authorityLabel: 'How authoritative is this source?',
  authorities: {
    PRIMARY: 'Primary — the official statement',
    SUPPLEMENTARY: 'Supplementary — adds detail',
    REFERENCE: 'Reference — for context only',
  },
  authorityHint:
    'Used when two sources disagree, so the people reviewing know which document the institution treats as governing. PalCert does not decide that for you.',
  chooseFile: 'Choose a file',
  uploading: 'Uploading…',
  uploadProgress: 'Uploaded',
  sourceStatuses: {
    AWAITING_UPLOAD: 'Waiting for the file',
    UPLOADED: 'Uploaded',
    SCANNING: 'Checking the file',
    VALIDATING: 'Checking the file',
    ANALYZING: 'Reading the file',
    READY: 'Ready',
    REJECTED: 'Not accepted',
    FAILED: 'Could not be processed',
    DELETED: 'Removed',
  },
  sourceRejected: 'PalCert did not accept this file.',
  sourceRejectionReasons: {
    FILE_EXTENSION_UNSUPPORTED: 'That file type cannot be read as a guideline or template.',
    FILE_TYPE_UNSUPPORTED: 'That file type cannot be read as a guideline or template.',
    FILE_TYPE_MISMATCH: 'The file’s contents do not match its type. Upload the original file.',
    FILE_TOO_LARGE: 'The file is larger than this installation allows.',
    FILE_EMPTY: 'The file is empty.',
    FILE_CONTAINER_INVALID: 'The file could not be opened as a valid document.',
    FILE_ARCHIVE_UNSAFE: 'The file is structured in a way PalCert will not expand.',
    FILE_MACRO_UNSUPPORTED: 'The file contains macros, which PalCert does not open.',
    FILE_EMBEDDED_OBJECT_UNSUPPORTED:
      'This Word document contains an embedded object that PalCert cannot safely process.',
    FILE_EXTERNAL_CONTENT_UNSUPPORTED:
      'The file pulls in content from outside itself, which PalCert does not follow.',
    FILE_MALWARE_DETECTED: 'The file did not pass the malware scan.',
    FILE_CHECKSUM_MISMATCH: 'The uploaded bytes did not match what was declared.',
  },
  legacyEquationsNotice:
    'Legacy equation objects were detected. PalCert processed them in safe mode without executing embedded content.',
  sourceImmutable:
    'An uploaded source cannot be edited. Upload a new one if the document changes; the old one stays, so earlier proposals still point at what was actually read.',
  retentionLocked:
    'A rule in this standard was accepted from this document, so it is kept as evidence and cannot be removed.',
  removeSource: 'Remove',
  confirmRemoveSource: 'Remove this source document from the draft?',
  downloadSource: 'Download',
  pageCount: 'Pages',
  digestLabel: 'File digest',

  consentTitle: 'Before PalCert reads your guidelines',
  consentExplanation:
    'To propose rules, PalCert sends the text of the source documents you upload here to an external AI provider configured by PalCert. It reads guidelines and templates; it does not send member data, and it never sends anyone’s thesis.',
  consentProviderNote: 'Processing happens at that provider, not only on PalCert’s own servers.',
  consentRetentionNote:
    'How long the provider retains what it processes is governed by PalCert’s agreement with them, which your institution or PalCert can describe on request.',
  consentOrganizationScope:
    'This agreement is given once for the whole institution, by someone authorized to give it, and applies to every standard here. It is separate from the agreement an individual gives for their own document.',
  consentAgree: 'I am authorized — agree for this institution',
  consentRevoke: 'Withdraw this institution’s agreement',
  consentGrantedOn: 'Agreed on',
  consentRenewalRequired: 'The notice has changed since your institution last agreed.',
  consentNotPermitted:
    'Only an administrator of this institution can agree to external processing on its behalf.',
  manualAlternative:
    'You can still upload sources and write rules by hand without this agreement. Only the reading step needs it.',

  runTitle: 'Reading the sources',
  startExtraction: 'Read the sources and propose rules',
  starting: 'Starting…',
  running: 'PalCert is reading the sources. This can take a few minutes.',
  runStatuses: {
    CREATED: 'Queued',
    QUEUED: 'Queued',
    DISCOVERING_EVIDENCE: 'Finding the relevant passages',
    GENERATING_PROPOSALS: 'Turning passages into proposals',
    VALIDATING: 'Checking the proposals',
    COMPLETED: 'Finished',
    FAILED: 'Did not finish',
    CANCELLED: 'Cancelled',
  },
  runFailed: 'PalCert could not finish reading the sources. Nothing was added to the draft.',
  runFailureKinds: {
    SOURCE_INTEGRITY_FAILED: 'A source document changed or could not be verified.',
    SOURCE_TOO_LARGE: 'The sources are larger than this installation can read in one pass.',
    ANALYSIS_UNAVAILABLE: 'A source could not be analyzed.',
    NO_EVIDENCE_DISCOVERED: 'No passage stating a requirement was found in the sources supplied.',
    PARTIAL_SOURCE_FAILURE: 'One of the sources could not be read.',
    DATABASE_TRANSACTION_FAILED:
      'PalCert could not save the results. This was a problem on PalCert’s side, not with the AI provider. Nothing was added to the draft.',
    DATABASE_UNAVAILABLE:
      'PalCert’s storage was briefly unavailable. Nothing was added to the draft.',
    PROVIDER_UNAVAILABLE: 'The AI provider was unavailable. Nothing was changed.',
    PROVIDER_REFUSAL: 'The AI provider declined this request. Nothing was changed.',
    OUTPUT_INVALID: 'What came back did not meet PalCert’s requirements, so it was discarded.',
    TIMEOUT: 'The provider did not answer in time. Nothing was changed.',
  },
  cancelRun: 'Cancel',
  noRunYet: 'The sources have not been read yet.',
  previousRuns: 'Earlier readings',
  runSupersededNotice:
    'A newer reading exists. Earlier proposals are kept as they were and are not re-checked.',
  modelLabel: 'Read by',
  runHashLabel: 'Reading digest',
  summaryTitle: 'What this reading produced',
  summaryLabels: {
    sourcesProcessed: 'Sources read',
    evidenceBlocks: 'Passages quoted',
    templateObservations: 'Template measurements',
    explicitRequirementProposals: 'Stated requirements',
    templateInferenceProposals: 'Observed in a template',
    ambiguousRequirements: 'Need clarification',
    conflictingRequirements: 'Sources disagree',
    unrepresentableRequirements: 'Cannot be expressed as a rule',
    invalidProposals: 'Not usable as written',
  },
  notExhaustive:
    'This is what PalCert found in the documents supplied. Treat it as a starting point and read your guidelines yourself.',

  proposalsTitle: 'Proposed rules',
  proposalsSubtitle:
    'Each of these is a suggestion with the passage it came from. Nothing becomes part of the standard until you accept it.',
  noProposals: 'No proposals from this reading.',
  proposalKinds: {
    EXPLICIT_REQUIREMENT: 'Stated in the guidelines',
    TEMPLATE_INFERENCE: 'Observed in the template',
    AMBIGUOUS_REQUIREMENT: 'Needs clarification',
    CONFLICTING_REQUIREMENT: 'Sources disagree',
    UNREPRESENTABLE_REQUIREMENT: 'Cannot be expressed as a rule',
  },
  proposalKindHints: {
    EXPLICIT_REQUIREMENT: 'The quoted passage states this requirement.',
    TEMPLATE_INFERENCE:
      'Measured in the template document. That the template does this consistently does not make it a requirement — only your institution can say that.',
    AMBIGUOUS_REQUIREMENT:
      'The guidelines require something here but do not say what. PalCert has not chosen a value.',
    CONFLICTING_REQUIREMENT:
      'Two sources require different things. PalCert has not chosen between them.',
    UNREPRESENTABLE_REQUIREMENT:
      'A real requirement PalCert cannot check as a formatting rule. It is reported so it is not lost.',
  },
  proposalStatuses: {
    PENDING_REVIEW: 'Waiting for a decision',
    ACCEPTED: 'Accepted',
    ACCEPTED_WITH_EDITS: 'Accepted, with changes',
    REJECTED: 'Rejected',
    SUPERSEDED: 'Superseded',
  },
  interpretation: 'What PalCert understood',
  interpretationIsTranslation:
    'This explanation is PalCert’s wording, not the source document’s. The quoted passage below is the source’s own words.',
  suggestedRule: 'Suggested rule',
  evidenceTitle: 'From the source',
  evidenceFrom: 'In',
  evidencePage: 'page',
  evidenceNode: 'paragraph',
  evidenceCharacters: 'characters',
  observationTitle: 'Measured in the template',
  observationObservedIn: 'Observed in',
  observationCounts: 'of',
  observationNotARequirement:
    'This is what the template document does. It is not a statement of what your institution requires.',
  uniformityLabels: {
    UNIFORM: 'Every occurrence agrees',
    MOSTLY_UNIFORM: 'Most occurrences agree',
    MIXED: 'The template is not consistent here',
    INSUFFICIENT_SAMPLE: 'Too few occurrences to say anything',
  },
  automationSupportLabels: {
    SUPPORTED_DOCX: 'PalCert can check this in Word documents',
    PARTIAL_DOCX: 'PalCert can check part of this in Word documents',
    NOT_CURRENTLY_MEASURABLE: 'PalCert cannot check this yet',
    NOT_APPLICABLE: 'Not checked by measurement',
  },
  clarificationNeeded: 'Ask your institution what value applies, then write the rule yourself.',
  conflictTitle: 'These sources disagree',
  conflictExplanation:
    'PalCert has deliberately not chosen between them. Which document governs is your institution’s decision, not something that can be inferred from upload order or file type.',
  conflictWithExistingRule: 'This draft already has a rule covering the same thing.',
  conflictResolveYourself:
    'Decide which applies, then accept one and reject the other — or reject both and write the rule yourself.',
  unrepresentableExplanation:
    'Recorded here so it is not lost. It cannot be checked automatically and is not part of the standard.',
  invalidProposalTitle: 'Not usable as written',
  invalidProposalExplanation:
    'PalCert checked this suggestion the same way it checks a rule written by hand, and it did not pass. It is shown unchanged so you can see what was suggested and correct it yourself.',

  accept: 'Accept',
  acceptEdited: 'Change and accept',
  reject: 'Reject',
  accepting: 'Accepting…',
  acceptSelected: 'Accept the selected proposals',
  selectForAcceptance: 'Select this proposal',
  nothingSelected: 'Select at least one proposal first.',
  skippedOnAccept: 'Not accepted',
  decidedBy: 'Decided by',
  decidedOn: 'Decided on',
  acceptedAsEdited: 'This was changed before it was accepted. Both versions are kept.',
  rejectionReasonLabel: 'Why are you rejecting it?',
  rejectionReasons: {
    NOT_A_REQUIREMENT: 'It is not a requirement',
    INCORRECT_INTERPRETATION: 'PalCert misread the source',
    ALREADY_COVERED: 'Already covered by another rule',
    NOT_ENFORCEABLE: 'We do not want to enforce this',
    WRONG_SCOPE: 'It applies to the wrong part of the document',
    OTHER: 'Another reason',
  },
  reviewNotesLabel: 'Notes (optional)',
  reviewNotesHint:
    'Kept inside PalCert so your colleagues can see why you decided this. It is not sent to the AI provider and no model is trained on it.',
  staleRevision:
    'This draft changed while you were reading it. Reload the page and decide again, so you are deciding against what the draft actually says now.',

  provenanceTitle: 'Where this rule came from',
  provenanceFrom: 'Quoted from',
  provenanceNotPartOfStandard:
    'Provenance is a record of how this rule was written. It is not part of the standard itself and does not change its content.',
  provenanceRuleLabel: 'Rule',
  provenanceChooseRule: 'Choose a rule…',
  provenanceNone: 'This rule was written by hand; no reading of a source produced it.',
  provenancePages: 'pages',
  countersTitle: 'Extraction',
  counterLabels: {
    sources: 'Sources',
    extractionRuns: 'Readings',
    pendingProposals: 'Waiting for a decision',
    acceptedProposals: 'Accepted',
    rejectedProposals: 'Rejected',
    conflicts: 'Disagreements',
  },
  publishWithPendingProposals:
    'Some proposals are still waiting for a decision. Publishing now does not include them, and they stay on this version.',

  errors: {
    AI_DISABLED: 'Reading source documents is not available in this installation.',
    ORGANIZATION_AI_CONSENT_REQUIRED:
      'Your institution has not yet agreed to external processing, so the sources cannot be read.',
    ORGANIZATION_AI_CONSENT_NOT_PERMITTED:
      'Only an administrator of this institution can give that agreement.',
    STANDARD_SOURCE_NOT_FOUND: 'That source document could not be found.',
    STANDARD_SOURCE_NOT_READY: 'That source document is not ready to be read yet.',
    STANDARD_SOURCE_IMMUTABLE: 'An uploaded source cannot be changed.',
    STANDARD_SOURCE_RETENTION_LOCKED:
      'A rule was accepted from this document, so it is kept as evidence.',
    STANDARD_VERSION_NOT_DRAFT: 'Sources can only be added or read while the version is a draft.',
    EXTRACTION_NO_USABLE_SOURCES: 'None of the sources on this draft are ready to be read.',
    EXTRACTION_ALREADY_RUNNING: 'This draft is already being read.',
    EXTRACTION_RUN_NOT_FOUND: 'That reading could not be found.',
    EXTRACTION_NOT_CANCELLABLE: 'That reading has already finished.',
    RULE_PROPOSAL_NOT_FOUND: 'That proposal could not be found.',
    RULE_PROPOSAL_ALREADY_DECIDED: 'Someone has already decided on this proposal.',
    RULE_PROPOSAL_NOT_ACCEPTABLE:
      'This proposal cannot be accepted as it stands. Correct it first, or write the rule yourself.',
    STALE_STANDARD_REVISION:
      'This draft changed while you were reading it. Reload the page and decide again.',
  },
  genericError: 'Something went wrong. Please try again.',
};

const ar: ExtractionMessages = {
  sectionTitle: 'الأدلة والقوالب',
  sectionSubtitle:
    'ارفع المستندات التي لدى مؤسستك، ويقرؤها بال‌سيرت ويقترح قواعد لهذه المسودة. ولا يُضاف شيء إلى المعيار حتى يقبله شخص هنا.',
  draftOnlyNotice: 'لا تُضاف المصادر ولا تُقرأ إلا ما دامت هذه النسخة مسودة.',

  sourcesTitle: 'المستندات المصدر',
  sourcesSubtitle: 'هذه المستندات ملك للمؤسسة لا لمن رفعها، وتبقى مرتبطة بهذه النسخة.',
  noSources: 'لا توجد مستندات مصدر بعد.',
  addSource: 'إضافة مستند مصدر',
  sourceKindLabel: 'ما نوع هذا المستند؟',
  sourceKinds: {
    GUIDELINE_PDF: 'دليل (PDF)',
    GUIDELINE_DOCX: 'دليل (Word)',
    TEMPLATE_DOCX: 'قالب (Word)',
  },
  sourceKindHints: {
    GUIDELINE_PDF: 'مستند ينص على ما هو مطلوب.',
    GUIDELINE_DOCX: 'مستند ينص على ما هو مطلوب.',
    TEMPLATE_DOCX:
      'مستند نموذجي يُظهر التنسيق. يقيسه بال‌سيرت ويذكر ما يلاحظه، وما يلاحظه ليس متطلباً بالضرورة.',
  },
  authorityLabel: 'ما مدى حجية هذا المصدر؟',
  authorities: {
    PRIMARY: 'أساسي — النص الرسمي',
    SUPPLEMENTARY: 'مكمّل — يضيف تفصيلاً',
    REFERENCE: 'مرجعي — للسياق فقط',
  },
  authorityHint:
    'يُستخدم عند اختلاف مصدرين، ليعرف المراجعون أي مستند تعتبره المؤسسة حاكماً. ولا يقرر بال‌سيرت ذلك نيابة عنكم.',
  chooseFile: 'اختيار ملف',
  uploading: 'جارٍ الرفع…',
  uploadProgress: 'تم رفع',
  sourceStatuses: {
    AWAITING_UPLOAD: 'بانتظار الملف',
    UPLOADED: 'تم الرفع',
    SCANNING: 'جارٍ فحص الملف',
    VALIDATING: 'جارٍ فحص الملف',
    ANALYZING: 'جارٍ قراءة الملف',
    READY: 'جاهز',
    REJECTED: 'غير مقبول',
    FAILED: 'تعذّرت معالجته',
    DELETED: 'أُزيل',
  },
  sourceRejected: 'لم يقبل بال‌سيرت هذا الملف.',
  sourceRejectionReasons: {
    FILE_EXTENSION_UNSUPPORTED: 'لا يمكن قراءة هذا النوع من الملفات كدليل أو قالب.',
    FILE_TYPE_UNSUPPORTED: 'لا يمكن قراءة هذا النوع من الملفات كدليل أو قالب.',
    FILE_TYPE_MISMATCH: 'محتوى الملف لا يطابق نوعه. ارفع الملف الأصلي.',
    FILE_TOO_LARGE: 'حجم الملف أكبر مما يسمح به هذا التثبيت.',
    FILE_EMPTY: 'الملف فارغ.',
    FILE_CONTAINER_INVALID: 'تعذّر فتح الملف كمستند صالح.',
    FILE_ARCHIVE_UNSAFE: 'بنية الملف لا يفكّها بال‌سيرت.',
    FILE_MACRO_UNSUPPORTED: 'يحتوي الملف على وحدات ماكرو، ولا يفتحها بال‌سيرت.',
    FILE_EMBEDDED_OBJECT_UNSUPPORTED:
      'يحتوي مستند Word على عنصر مضمّن لا يستطيع PalCert معالجته بأمان.',
    FILE_EXTERNAL_CONTENT_UNSUPPORTED: 'يستدعي الملف محتوى من خارجه، ولا يتبعه بال‌سيرت.',
    FILE_MALWARE_DETECTED: 'لم يجتز الملف فحص البرمجيات الخبيثة.',
    FILE_CHECKSUM_MISMATCH: 'لم تطابق البايتات المرفوعة ما أُعلن عنه.',
  },
  legacyEquationsNotice:
    'تم اكتشاف معادلات قديمة مضمّنة. عالجها PalCert في الوضع الآمن دون تشغيل أي محتوى مضمّن.',
  sourceImmutable:
    'لا يمكن تعديل مصدر بعد رفعه. ارفع مصدراً جديداً إذا تغيّر المستند؛ ويبقى القديم كي تظل المقترحات السابقة مشيرة إلى ما قُرئ فعلاً.',
  retentionLocked:
    'قُبلت قاعدة في هذا المعيار استناداً إلى هذا المستند، فيُحفظ كدليل ولا يمكن إزالته.',
  removeSource: 'إزالة',
  confirmRemoveSource: 'هل تريد إزالة هذا المستند المصدر من المسودة؟',
  downloadSource: 'تنزيل',
  pageCount: 'الصفحات',
  digestLabel: 'بصمة الملف',

  consentTitle: 'قبل أن يقرأ بال‌سيرت أدلتكم',
  consentExplanation:
    'لاقتراح القواعد، يرسل بال‌سيرت نص المستندات المصدر التي ترفعونها هنا إلى مزوّد ذكاء اصطناعي خارجي يحدده بال‌سيرت. يقرأ الأدلة والقوالب، ولا يرسل بيانات الأعضاء، ولا يرسل رسالة أحد.',
  consentProviderNote: 'تجري المعالجة لدى ذلك المزوّد، لا على خوادم بال‌سيرت وحدها.',
  consentRetentionNote:
    'مدة احتفاظ المزوّد بما يعالجه تحكمها اتفاقية بال‌سيرت معه، ويمكن لمؤسستكم أو لبال‌سيرت بيانها عند الطلب.',
  consentOrganizationScope:
    'تُمنح هذه الموافقة مرة واحدة للمؤسسة كلها، ممن يملك صلاحية منحها، وتسري على كل معيار هنا. وهي منفصلة عن موافقة الفرد على مستنده الخاص.',
  consentAgree: 'أملك الصلاحية — الموافقة نيابة عن المؤسسة',
  consentRevoke: 'سحب موافقة المؤسسة',
  consentGrantedOn: 'تاريخ الموافقة',
  consentRenewalRequired: 'تغيّر الإشعار منذ آخر موافقة لمؤسستكم.',
  consentNotPermitted: 'لا يملك الموافقة على المعالجة الخارجية نيابة عن المؤسسة إلا مدير فيها.',
  manualAlternative:
    'يمكنكم رفع المصادر وكتابة القواعد يدوياً دون هذه الموافقة. خطوة القراءة وحدها هي التي تحتاجها.',

  runTitle: 'قراءة المصادر',
  startExtraction: 'اقرأ المصادر واقترح قواعد',
  starting: 'جارٍ البدء…',
  running: 'يقرأ بال‌سيرت المصادر. قد يستغرق ذلك بضع دقائق.',
  runStatuses: {
    CREATED: 'في الانتظار',
    QUEUED: 'في الانتظار',
    DISCOVERING_EVIDENCE: 'البحث عن المقاطع ذات الصلة',
    GENERATING_PROPOSALS: 'تحويل المقاطع إلى مقترحات',
    VALIDATING: 'التحقق من المقترحات',
    COMPLETED: 'انتهت',
    FAILED: 'لم تكتمل',
    CANCELLED: 'أُلغيت',
  },
  runFailed: 'تعذّر على بال‌سيرت إتمام قراءة المصادر. ولم يُضَف شيء إلى المسودة.',
  runFailureKinds: {
    SOURCE_INTEGRITY_FAILED: 'تغيّر مستند مصدر أو تعذّر التحقق منه.',
    SOURCE_TOO_LARGE: 'حجم المصادر أكبر مما يمكن لهذا التثبيت قراءته دفعة واحدة.',
    ANALYSIS_UNAVAILABLE: 'تعذّر تحليل أحد المصادر.',
    NO_EVIDENCE_DISCOVERED: 'لم يُعثر في المصادر المقدَّمة على مقطع ينص على متطلب.',
    PARTIAL_SOURCE_FAILURE: 'تعذّرت قراءة أحد المصادر.',
    DATABASE_TRANSACTION_FAILED:
      'تعذّر على PalCert حفظ النتائج. كانت المشكلة لدى PalCert وليست لدى مزوّد الذكاء الاصطناعي. لم يُضف شيء إلى المسودة.',
    DATABASE_UNAVAILABLE: 'كان تخزين PalCert غير متاح مؤقتًا. لم يُضف شيء إلى المسودة.',
    PROVIDER_UNAVAILABLE: 'مزوّد الذكاء الاصطناعي غير متاح. ولم يتغيّر شيء.',
    PROVIDER_REFUSAL: 'رفض مزوّد الذكاء الاصطناعي هذا الطلب. ولم يتغيّر شيء.',
    OUTPUT_INVALID: 'لم يستوفِ ما ورد متطلبات بال‌سيرت، فاستُبعد.',
    TIMEOUT: 'لم يردّ المزوّد في الوقت المحدد. ولم يتغيّر شيء.',
  },
  cancelRun: 'إلغاء',
  noRunYet: 'لم تُقرأ المصادر بعد.',
  previousRuns: 'قراءات سابقة',
  runSupersededNotice: 'توجد قراءة أحدث. وتبقى المقترحات السابقة كما هي ولا يُعاد فحصها.',
  modelLabel: 'قرأها',
  runHashLabel: 'بصمة القراءة',
  summaryTitle: 'ما أنتجته هذه القراءة',
  summaryLabels: {
    sourcesProcessed: 'المصادر المقروءة',
    evidenceBlocks: 'المقاطع المقتبسة',
    templateObservations: 'قياسات القالب',
    explicitRequirementProposals: 'متطلبات منصوص عليها',
    templateInferenceProposals: 'ملاحَظ في قالب',
    ambiguousRequirements: 'تحتاج توضيحاً',
    conflictingRequirements: 'اختلاف بين المصادر',
    unrepresentableRequirements: 'لا يمكن التعبير عنها كقاعدة',
    invalidProposals: 'غير صالحة كما هي',
  },
  notExhaustive:
    'هذا ما وجده بال‌سيرت في المستندات المقدَّمة. اعتبروه نقطة بداية واقرؤوا أدلتكم بأنفسكم.',

  proposalsTitle: 'القواعد المقترحة',
  proposalsSubtitle:
    'كل واحد من هذه اقتراح مصحوب بالمقطع الذي جاء منه. ولا يصبح شيء جزءاً من المعيار حتى تقبلوه.',
  noProposals: 'لا مقترحات من هذه القراءة.',
  proposalKinds: {
    EXPLICIT_REQUIREMENT: 'منصوص عليه في الدليل',
    TEMPLATE_INFERENCE: 'ملاحَظ في القالب',
    AMBIGUOUS_REQUIREMENT: 'يحتاج توضيحاً',
    CONFLICTING_REQUIREMENT: 'اختلاف بين المصادر',
    UNREPRESENTABLE_REQUIREMENT: 'لا يمكن التعبير عنه كقاعدة',
  },
  proposalKindHints: {
    EXPLICIT_REQUIREMENT: 'المقطع المقتبس ينص على هذا المتطلب.',
    TEMPLATE_INFERENCE:
      'قيس في مستند القالب. وكون القالب يفعل ذلك باطراد لا يجعله متطلباً؛ مؤسستكم وحدها من يقرر ذلك.',
    AMBIGUOUS_REQUIREMENT: 'يوجب الدليل شيئاً هنا دون أن يحدده. ولم يختر بال‌سيرت قيمة.',
    CONFLICTING_REQUIREMENT: 'يوجب مصدران أمرين مختلفين. ولم يختر بال‌سيرت بينهما.',
    UNREPRESENTABLE_REQUIREMENT:
      'متطلب حقيقي لا يستطيع بال‌سيرت فحصه كقاعدة تنسيق. ويُذكر كي لا يضيع.',
  },
  proposalStatuses: {
    PENDING_REVIEW: 'بانتظار قرار',
    ACCEPTED: 'مقبول',
    ACCEPTED_WITH_EDITS: 'مقبول بعد تعديل',
    REJECTED: 'مرفوض',
    SUPERSEDED: 'حلّ محله غيره',
  },
  interpretation: 'ما فهمه بال‌سيرت',
  interpretationIsTranslation:
    'هذا الشرح صياغة بال‌سيرت لا صياغة المستند المصدر. والمقطع المقتبس أدناه هو كلام المصدر نفسه.',
  suggestedRule: 'القاعدة المقترحة',
  evidenceTitle: 'من المصدر',
  evidenceFrom: 'في',
  evidencePage: 'صفحة',
  evidenceNode: 'فقرة',
  evidenceCharacters: 'محارف',
  observationTitle: 'مقيس في القالب',
  observationObservedIn: 'ملاحَظ في',
  observationCounts: 'من',
  observationNotARequirement: 'هذا ما يفعله مستند القالب. وليس بياناً لما تشترطه مؤسستكم.',
  uniformityLabels: {
    UNIFORM: 'كل المواضع متفقة',
    MOSTLY_UNIFORM: 'معظم المواضع متفقة',
    MIXED: 'القالب غير مطّرد هنا',
    INSUFFICIENT_SAMPLE: 'المواضع أقل من أن يُستدل بها',
  },
  automationSupportLabels: {
    SUPPORTED_DOCX: 'يستطيع بال‌سيرت فحص هذا في مستندات Word',
    PARTIAL_DOCX: 'يستطيع بال‌سيرت فحص جزء من هذا في مستندات Word',
    NOT_CURRENTLY_MEASURABLE: 'لا يستطيع بال‌سيرت فحص هذا بعد',
    NOT_APPLICABLE: 'لا يُفحص بالقياس',
  },
  clarificationNeeded: 'اسألوا مؤسستكم عن القيمة المطلوبة ثم اكتبوا القاعدة بأنفسكم.',
  conflictTitle: 'هذان المصدران مختلفان',
  conflictExplanation:
    'لم يختر بال‌سيرت بينهما عن قصد. وتحديد المستند الحاكم قرار مؤسستكم، لا أمر يُستنتج من ترتيب الرفع أو نوع الملف.',
  conflictWithExistingRule: 'في هذه المسودة قاعدة تغطي الأمر نفسه.',
  conflictResolveYourself:
    'قرروا أيهما ينطبق، ثم اقبلوا واحداً وارفضوا الآخر — أو ارفضوهما واكتبوا القاعدة بأنفسكم.',
  unrepresentableExplanation: 'يُسجَّل هنا كي لا يضيع. ولا يمكن فحصه آلياً وليس جزءاً من المعيار.',
  invalidProposalTitle: 'غير صالحة كما هي',
  invalidProposalExplanation:
    'فحص بال‌سيرت هذا الاقتراح كما يفحص قاعدة مكتوبة بخط اليد، فلم يجتز الفحص. ويُعرض دون تغيير كي تروا ما اقتُرح وتصححوه بأنفسكم.',

  accept: 'قبول',
  acceptEdited: 'تعديل وقبول',
  reject: 'رفض',
  accepting: 'جارٍ القبول…',
  acceptSelected: 'قبول المقترحات المحددة',
  selectForAcceptance: 'تحديد هذا المقترح',
  nothingSelected: 'حددوا مقترحاً واحداً على الأقل.',
  skippedOnAccept: 'لم يُقبل',
  decidedBy: 'قرّره',
  decidedOn: 'تاريخ القرار',
  acceptedAsEdited: 'عُدّل هذا قبل قبوله. والنسختان محفوظتان.',
  rejectionReasonLabel: 'ما سبب الرفض؟',
  rejectionReasons: {
    NOT_A_REQUIREMENT: 'ليس متطلباً',
    INCORRECT_INTERPRETATION: 'أساء بال‌سيرت قراءة المصدر',
    ALREADY_COVERED: 'تغطيه قاعدة أخرى',
    NOT_ENFORCEABLE: 'لا نريد إلزام أحد به',
    WRONG_SCOPE: 'ينطبق على جزء آخر من المستند',
    OTHER: 'سبب آخر',
  },
  reviewNotesLabel: 'ملاحظات (اختياري)',
  reviewNotesHint:
    'تُحفظ داخل بال‌سيرت ليرى زملاؤكم سبب قراركم. ولا تُرسل إلى مزوّد الذكاء الاصطناعي ولا يُدرَّب عليها نموذج.',
  staleRevision:
    'تغيّرت هذه المسودة أثناء قراءتكم لها. أعيدوا تحميل الصفحة ثم قرروا من جديد، كي يكون قراركم على ما تقوله المسودة الآن.',

  provenanceTitle: 'من أين جاءت هذه القاعدة',
  provenanceFrom: 'مقتبسة من',
  provenanceNotPartOfStandard:
    'المصدرية سجل لكيفية كتابة هذه القاعدة. وليست جزءاً من المعيار نفسه ولا تغيّر محتواه.',
  provenanceRuleLabel: 'القاعدة',
  provenanceChooseRule: 'اختر قاعدة…',
  provenanceNone: 'كُتبت هذه القاعدة يدويًا؛ لم تنتج عن قراءة أي مصدر.',
  provenancePages: 'الصفحات',
  countersTitle: 'الاستخلاص',
  counterLabels: {
    sources: 'المصادر',
    extractionRuns: 'القراءات',
    pendingProposals: 'بانتظار قرار',
    acceptedProposals: 'مقبولة',
    rejectedProposals: 'مرفوضة',
    conflicts: 'اختلافات',
  },
  publishWithPendingProposals:
    'ما زالت بعض المقترحات تنتظر قراراً. والنشر الآن لا يتضمنها، وتبقى على هذه النسخة.',

  errors: {
    AI_DISABLED: 'قراءة المستندات المصدر غير متاحة في هذا التثبيت.',
    ORGANIZATION_AI_CONSENT_REQUIRED:
      'لم توافق مؤسستكم بعد على المعالجة الخارجية، فتعذّرت قراءة المصادر.',
    ORGANIZATION_AI_CONSENT_NOT_PERMITTED: 'لا يمنح تلك الموافقة إلا مدير في هذه المؤسسة.',
    STANDARD_SOURCE_NOT_FOUND: 'تعذّر العثور على هذا المستند المصدر.',
    STANDARD_SOURCE_NOT_READY: 'هذا المستند المصدر ليس جاهزاً للقراءة بعد.',
    STANDARD_SOURCE_IMMUTABLE: 'لا يمكن تغيير مصدر بعد رفعه.',
    STANDARD_SOURCE_RETENTION_LOCKED: 'قُبلت قاعدة استناداً إلى هذا المستند، فيُحفظ كدليل.',
    STANDARD_VERSION_NOT_DRAFT: 'لا تُضاف المصادر ولا تُقرأ إلا ما دامت النسخة مسودة.',
    EXTRACTION_NO_USABLE_SOURCES: 'لا يوجد في هذه المسودة مصدر جاهز للقراءة.',
    EXTRACTION_ALREADY_RUNNING: 'تُقرأ هذه المسودة بالفعل.',
    EXTRACTION_RUN_NOT_FOUND: 'تعذّر العثور على تلك القراءة.',
    EXTRACTION_NOT_CANCELLABLE: 'انتهت تلك القراءة بالفعل.',
    RULE_PROPOSAL_NOT_FOUND: 'تعذّر العثور على هذا المقترح.',
    RULE_PROPOSAL_ALREADY_DECIDED: 'سبق أن قرّر أحدهم في هذا المقترح.',
    RULE_PROPOSAL_NOT_ACCEPTABLE:
      'لا يمكن قبول هذا المقترح كما هو. صححوه أولاً، أو اكتبوا القاعدة بأنفسكم.',
    STALE_STANDARD_REVISION:
      'تغيّرت هذه المسودة أثناء قراءتكم لها. أعيدوا تحميل الصفحة ثم قرروا من جديد.',
  },
  genericError: 'حدث خطأ ما. يرجى المحاولة مرة أخرى.',
};

export const EXTRACTION_MESSAGES: Readonly<Record<Locale, ExtractionMessages>> = { en, ar };

export function getExtractionMessages(locale: Locale): ExtractionMessages {
  return EXTRACTION_MESSAGES[locale] ?? EXTRACTION_MESSAGES.en;
}
