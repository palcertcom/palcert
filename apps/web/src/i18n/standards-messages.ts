import type { Locale } from './locales';

/**
 * Standards message catalogue (§58).
 *
 * Canonical API values (`MARGINS`, `GREATER_THAN_OR_EQUAL`, `DRAFT`) never
 * reach the screen: they are looked up here, so the API contract stays stable
 * while the presentation is translated. Parity across locales — including the
 * nested label maps — is enforced by test, so an untranslated Arabic entry
 * fails CI rather than shipping as English text in an Arabic page.
 */
export interface StandardsMessages {
  // Navigation and headings
  readonly navDocumentTypes: string;
  readonly navStandards: string;
  readonly standardsTitle: string;
  readonly standardsSubtitle: string;
  readonly documentTypesTitle: string;
  readonly documentTypesSubtitle: string;

  // Document types
  readonly newDocumentType: string;
  readonly documentTypeName: string;
  readonly documentTypeNameAr: string;
  readonly systemCategory: string;
  readonly standardsUsing: string;
  readonly archive: string;
  readonly statusColumn: string;
  readonly restore: string;

  // Standards
  readonly newStandard: string;
  readonly standardCode: string;
  readonly standardCodeHint: string;
  readonly nameEn: string;
  readonly nameAr: string;
  readonly documentType: string;
  readonly versions: string;
  readonly inForce: string;
  readonly notPublished: string;
  readonly searchStandards: string;
  readonly noStandards: string;
  readonly create: string;
  readonly cancel: string;
  readonly save: string;
  readonly saved: string;
  readonly loadMore: string;

  // Versions
  readonly versionLabel: string;
  readonly newVersion: string;
  readonly cloneVersion: string;
  readonly cloneHint: string;
  readonly publish: string;
  readonly publishing: string;
  readonly published: string;
  readonly validate: string;
  readonly validationPassed: string;
  readonly validationFailed: string;
  readonly contentHash: string;
  readonly contentHashHint: string;
  readonly hashVerified: string;
  readonly hashNotVerified: string;
  readonly effectiveFrom: string;
  readonly effectiveUntil: string;
  readonly revision: string;
  readonly publishedVersionReadOnly: string;
  readonly draftVersionNotice: string;

  // Rules and the builder
  readonly rules: string;
  readonly addRule: string;
  readonly editRule: string;
  readonly deleteRule: string;
  readonly noRules: string;
  readonly ruleCode: string;
  readonly ruleCodeHint: string;
  readonly category: string;
  readonly evaluationMode: string;
  readonly scopeKind: string;
  readonly sectionKey: string;
  readonly elementType: string;
  readonly headingLevel: string;
  readonly metadataField: string;
  readonly pages: string;
  readonly property: string;
  readonly operator: string;
  readonly expectedValue: string;
  readonly valueType: string;
  readonly minimum: string;
  readonly maximum: string;
  readonly listValues: string;
  readonly listValuesHint: string;
  readonly pattern: string;
  readonly patternArgument: string;
  readonly unit: string;
  readonly tolerance: string;
  readonly toleranceHint: string;
  readonly severity: string;
  readonly blocking: string;
  readonly blockingHint: string;
  /** Shown when a non-deterministic rule is allowed to block (schema v2 on). */
  readonly blockingReviewHint: string;
  readonly upgradeRuleSchema: string;
  readonly upgradeRuleSchemaHint: (from: number, to: number) => string;
  /** Shown when the draft's schema version still restricts blocking to v1 rules. */
  readonly blockingDeterministicOnlyHint: string;
  readonly autofix: string;
  readonly origin: string;
  readonly originReference: string;
  readonly titleEn: string;
  readonly titleAr: string;
  readonly descriptionEn: string;
  readonly descriptionAr: string;
  readonly guidanceEn: string;
  readonly guidanceAr: string;
  readonly noOperandNeeded: string;

  // Reordering
  readonly reorder: string;
  readonly moveUp: string;
  readonly moveDown: string;
  readonly orderSaved: string;
  readonly reorderHint: string;

  // Label maps for canonical API values
  readonly manage: {
    readonly catalogueTitle: string;
    readonly catalogueHint: string;
    readonly cataloguePublic: string;
    readonly cataloguePrivate: string;
    readonly addToCatalogue: string;
    readonly addToCatalogueIntro: string;
    readonly withdrawFromCatalogue: string;
    readonly withdrawFromCatalogueIntro: string;
    readonly catalogueChanged: string;
    readonly editStandard: string;
    readonly editStandardIntro: string;
    readonly archiveStandard: string;
    readonly archiveStandardIntro: string;
    readonly restoreStandard: string;
    readonly restoreStandardIntro: string;
    readonly archivedNotice: string;
    readonly editDraft: string;
    readonly editDraftIntro: string;
    readonly effectiveHint: string;
    readonly archiveVersion: string;
    readonly archiveVersionIntro: string;
    readonly downloadSnapshot: string;
    readonly snapshotHint: string;
    readonly editDocumentType: string;
    readonly editDocumentTypeIntro: string;
    readonly descriptionLabel: string;
    readonly descriptionArLabel: string;
    readonly close: string;
    readonly optional: string;
    readonly working: string;
    readonly required: string;
  };
  /** Publishing over the version in force, and reading a version's history. */
  readonly lifecycle: {
    readonly confirmTitle: (next: string) => string;
    readonly confirmBody: (current: string, next: string) => string;
    readonly confirmReplace: (current: string) => string;
    readonly publishedReplacing: (next: string, previous: string) => string;
    readonly historyColumn: string;
    readonly inForceSince: (date: string) => string;
    readonly supersededBy: (label: string) => string;
    readonly supersededByOn: (label: string, date: string) => string;
    readonly archivedOn: (date: string) => string;
    readonly supersededNotice: (label: string, date: string) => string;
    readonly archivedNotice: string;
    readonly publishedOn: string;
    readonly publishedBy: string;
    readonly supersededOn: string;
    readonly supersededByLabel: string;
    readonly unknownPerson: string;
    readonly usageTitle: string;
    readonly usageHint: string;
    readonly usageSubmissions: string;
    readonly usageCertificates: string;
    readonly viewCertificates: string;
    readonly cloneHistoricalHint: string;
  };
  readonly versionStatuses: Readonly<Record<string, string>>;
  readonly statuses: Readonly<Record<string, string>>;
  readonly categories: Readonly<Record<string, string>>;
  readonly evaluationModes: Readonly<Record<string, string>>;
  readonly severities: Readonly<Record<string, string>>;
  readonly autofixCapabilities: Readonly<Record<string, string>>;
  readonly origins: Readonly<Record<string, string>>;
  readonly operators: Readonly<Record<string, string>>;
  readonly units: Readonly<Record<string, string>>;
  readonly scopeKinds: Readonly<Record<string, string>>;
  readonly systemCategories: Readonly<Record<string, string>>;
  readonly errors: Readonly<Record<string, string>>;
}

const en: StandardsMessages = {
  navDocumentTypes: 'Document types',
  navStandards: 'Standards',
  standardsTitle: 'Standards',
  standardsSubtitle: 'The requirements documents are checked against.',
  documentTypesTitle: 'Document types',
  documentTypesSubtitle: 'What kinds of document your organization works with.',

  newDocumentType: 'New document type',
  documentTypeName: 'Name',
  documentTypeNameAr: 'Name (Arabic)',
  systemCategory: 'Category',
  standardsUsing: 'Standards using it',
  archive: 'Archive',
  statusColumn: 'Status',
  restore: 'Restore',

  newStandard: 'New standard',
  standardCode: 'Code',
  standardCodeHint: 'A stable handle, e.g. IUG.THESIS.FORMAT. It cannot be changed later.',
  nameEn: 'Name (English)',
  nameAr: 'Name (Arabic)',
  documentType: 'Document type',
  versions: 'Versions',
  inForce: 'In force',
  notPublished: 'No published version yet',
  searchStandards: 'Search standards',
  noStandards: 'No standards yet.',
  create: 'Create',
  cancel: 'Cancel',
  save: 'Save',
  saved: 'Saved.',
  loadMore: 'Load more',

  versionLabel: 'Version',
  newVersion: 'New version',
  cloneVersion: 'Clone to a new draft',
  cloneHint:
    'A published version cannot be edited. Clone it, change the copy, and publish that instead.',
  publish: 'Publish',
  publishing: 'Publishing…',
  published: 'Published',
  validate: 'Check for problems',
  validationPassed: 'This draft is ready to publish.',
  validationFailed: 'This draft has problems that must be fixed before publishing.',
  contentHash: 'Content hash',
  contentHashHint:
    'A SHA-256 of this version’s exact content. Anyone can recompute it to prove the standard has not changed.',
  hashVerified: 'Verified',
  hashNotVerified: 'Does not match',
  effectiveFrom: 'In force from',
  effectiveUntil: 'In force until',
  revision: 'Revision',
  publishedVersionReadOnly: 'This version is published and can no longer be changed.',
  draftVersionNotice:
    'This version is a draft. No document is checked against it until it is published.',

  rules: 'Rules',
  addRule: 'Add rule',
  editRule: 'Edit rule',
  deleteRule: 'Delete',
  noRules: 'No rules yet. A version needs at least one rule before it can be published.',
  ruleCode: 'Rule code',
  ruleCodeHint: 'UPPERCASE, dot-separated, e.g. MARGIN.TOP.MIN. Reports quote it.',
  category: 'Category',
  evaluationMode: 'How it is decided',
  scopeKind: 'Applies to',
  sectionKey: 'Section',
  elementType: 'Element',
  headingLevel: 'Heading level',
  metadataField: 'Metadata field',
  pages: 'Pages',
  property: 'Property',
  operator: 'Condition',
  expectedValue: 'Expected value',
  valueType: 'Value type',
  minimum: 'Minimum',
  maximum: 'Maximum',
  listValues: 'Allowed values',
  listValuesHint: 'One per line.',
  pattern: 'Pattern',
  patternArgument: 'Pattern text',
  unit: 'Unit',
  tolerance: 'Tolerance',
  toleranceHint: 'How far from the expected value still counts as compliant.',
  severity: 'Severity',
  blocking: 'Blocks certification',
  blockingHint: 'A document that breaks this rule cannot be certified.',
  upgradeRuleSchema: 'Upgrade the rule schema',
  upgradeRuleSchemaHint: (from, to) =>
    `The copy will be written under rule schema version ${to} instead of ${from}, which allows ` +
    `a reviewed rule to block certification. This version itself is not changed.`,
  blockingReviewHint:
    'A document that breaks this rule cannot be certified. Because this rule is judged rather ' +
    'than measured, certification stays open until a reviewer resolves it — the result is never ' +
    'decided automatically.',
  blockingDeterministicOnlyHint:
    'This standard uses rule schema version 1, under which only a measured rule may block ' +
    'certification. Clone it and upgrade the schema to block on a reviewed rule.',
  autofix: 'Automatic correction',
  origin: 'Source',
  originReference: 'Reference',
  titleEn: 'Title (English)',
  titleAr: 'Title (Arabic)',
  descriptionEn: 'Description (English)',
  descriptionAr: 'Description (Arabic)',
  guidanceEn: 'Guidance (English)',
  guidanceAr: 'Guidance (Arabic)',
  noOperandNeeded: 'This condition takes no value.',

  reorder: 'Reorder',
  moveUp: 'Move up',
  moveDown: 'Move down',
  orderSaved: 'Order saved.',
  reorderHint: 'Use the move buttons, or focus a rule and press the arrow keys.',

  manage: {
    catalogueTitle: 'Check catalogue',
    catalogueHint:
      'Anyone can check a document against a standard in the catalogue. They never see its ' +
      'rules, and you never see their documents or results. It is listed only while your ' +
      'organization is verified and a version is published.',
    cataloguePublic: 'In the check catalogue',
    cataloguePrivate: 'Private to your organization',
    addToCatalogue: 'Add to the check catalogue',
    addToCatalogueIntro:
      'People outside your organization will be able to check their documents against this ' +
      'standard. Its rules stay private, and you see nothing of their documents.',
    withdrawFromCatalogue: 'Withdraw from the check catalogue',
    withdrawFromCatalogueIntro:
      'New checks against this standard stop. Reports already produced are not changed.',
    catalogueChanged: 'The check catalogue was updated.',
    editStandard: 'Edit standard',
    editStandardIntro: 'Names and descriptions. The code and the rules do not change here.',
    archiveStandard: 'Archive standard',
    archiveStandardIntro:
      'The standard is kept with all its versions, but no new version can be made and it leaves ' +
      'the check catalogue. You can restore it.',
    restoreStandard: 'Restore standard',
    restoreStandardIntro: 'The standard becomes active again.',
    archivedNotice: 'This standard is archived.',
    editDraft: 'Edit draft',
    editDraftIntro: 'The label and the dates it applies. A published version cannot be edited.',
    effectiveHint: 'A date, for example 2027-09-01.',
    archiveVersion: 'Archive version',
    archiveVersionIntro:
      'The version is kept for the record but can no longer be used for new checks.',
    downloadSnapshot: 'Download the published snapshot',
    snapshotHint:
      'The exact canonical content that was published and hashed, as JSON, to check against ' +
      'the content hash.',
    editDocumentType: 'Edit',
    editDocumentTypeIntro: 'Names and descriptions shown to people who submit to you.',
    descriptionLabel: 'Description (English)',
    descriptionArLabel: 'Description (Arabic)',
    close: 'Close',
    optional: 'Optional',
    working: 'Please wait…',
    required: 'This field is required.',
  },
  lifecycle: {
    confirmTitle: (next) => `Publish version ${next}?`,
    confirmBody: (current, next) =>
      `Version ${current} is currently in force. Publishing ${next} will make ${next} the ` +
      `active version and retain ${current} as a superseded historical version.`,
    confirmReplace: (current) => `Publish and replace ${current}`,
    publishedReplacing: (next, previous) =>
      `Version ${next} is now in force. Version ${previous} is kept as a superseded version.`,
    historyColumn: 'History',
    inForceSince: (date) => `In force since ${date}`,
    supersededBy: (label) => `Superseded by version ${label}`,
    supersededByOn: (label, date) => `Superseded by version ${label} on ${date}`,
    archivedOn: (date) => `Archived on ${date}`,
    supersededNotice: (label, date) =>
      `Superseded by version ${label} on ${date}. It is kept unchanged as the record that past ` +
      'checks, reports and certificates refer to, and is no longer offered for new checks. Clone ' +
      'it to use its content again.',
    archivedNotice:
      'This version was archived. It is kept for the record and cannot be edited or published.',
    publishedOn: 'Published',
    publishedBy: 'Published by',
    supersededOn: 'Superseded',
    supersededByLabel: 'Replaced by',
    unknownPerson: 'A former member',
    usageTitle: 'Relied on by',
    usageHint:
      'Submissions to your organization checked against this version, and certificates issued ' +
      'on them. Individual checks belong to the people who ran them and are not shown.',
    usageSubmissions: 'Submissions',
    usageCertificates: 'Certificates issued',
    viewCertificates: 'View certificates',
    cloneHistoricalHint:
      'This version is history and cannot be edited or published again. Clone it into a new ' +
      'draft, review it, and publish that to bring its content back.',
  },
  versionStatuses: {
    DRAFT: 'Draft',
    PUBLISHED: 'Published · in force',
    SUPERSEDED: 'Superseded',
    ARCHIVED: 'Archived',
  },
  statuses: {
    ACTIVE: 'Active',
    ARCHIVED: 'Archived',
  },
  categories: {
    PAGE_SETUP: 'Page setup',
    MARGINS: 'Margins',
    TYPOGRAPHY: 'Typography',
    SPACING: 'Spacing',
    ALIGNMENT: 'Alignment',
    PAGINATION: 'Pagination',
    HEADINGS: 'Headings',
    TITLE_PAGE: 'Title page',
    ABSTRACT: 'Abstract',
    KEYWORDS: 'Keywords',
    TABLE_OF_CONTENTS: 'Table of contents',
    SECTION_STRUCTURE: 'Section structure',
    TABLES: 'Tables',
    FIGURES: 'Figures',
    CAPTIONS: 'Captions',
    EQUATIONS: 'Equations',
    CITATIONS: 'Citations',
    REFERENCES: 'References',
    LANGUAGE_QUALITY: 'Language quality',
    TERMINOLOGY: 'Terminology',
    RESEARCH_ETHICS: 'Research ethics',
    DOCUMENT_METADATA: 'Document metadata',
    FILE_TECHNICAL: 'File and technical',
  },
  evaluationModes: {
    DETERMINISTIC: 'Measured',
    AI_ASSISTED: 'AI-assisted',
    MANUAL: 'Checked by a person',
  },
  severities: {
    INFO: 'Information',
    MINOR: 'Minor',
    MAJOR: 'Major',
    CRITICAL: 'Critical',
  },
  autofixCapabilities: {
    NONE: 'None',
    SAFE: 'Safe changes only',
    ADVANCED: 'Advanced (needs approval)',
  },
  origins: {
    ORGANIZATION_POLICY: 'Organization policy',
    NATIONAL_REGULATION: 'National regulation',
    PUBLISHER_GUIDELINE: 'Publisher guideline',
    STYLE_GUIDE: 'Style guide',
    ACCESSIBILITY_STANDARD: 'Accessibility standard',
    PALCERT_TEMPLATE: 'PalCert template',
    OTHER: 'Other',
  },
  operators: {
    EQUALS: 'is exactly',
    NOT_EQUALS: 'is not',
    GREATER_THAN: 'is more than',
    GREATER_THAN_OR_EQUAL: 'is at least',
    LESS_THAN: 'is less than',
    LESS_THAN_OR_EQUAL: 'is at most',
    BETWEEN: 'is between',
    IN: 'is one of',
    NOT_IN: 'is none of',
    CONTAINS: 'contains',
    NOT_CONTAINS: 'does not contain',
    MATCHES_PATTERN: 'matches',
    EXISTS: 'is present',
    NOT_EXISTS: 'is absent',
  },
  units: {
    COUNT: 'count',
    MILLIMETRE: 'mm',
    CENTIMETRE: 'cm',
    INCH: 'in',
    POINT: 'pt',
    PIXEL: 'px',
    PERCENT: '%',
    LINES: 'lines',
    WORDS: 'words',
    CHARACTERS: 'characters',
    PAGES: 'pages',
    MEGABYTE: 'MB',
    DPI: 'DPI',
  },
  scopeKinds: {
    DOCUMENT: 'The whole document',
    SECTION: 'A section',
    ELEMENT: 'An element',
    METADATA: 'Document metadata',
    PAGE: 'A page',
  },
  systemCategories: {
    THESIS: 'Thesis',
    DISSERTATION: 'Dissertation',
    JOURNAL_ARTICLE: 'Journal article',
    CONFERENCE_PAPER: 'Conference paper',
    BOOK: 'Book',
    BOOK_CHAPTER: 'Book chapter',
    TECHNICAL_REPORT: 'Technical report',
    GRANT_PROPOSAL: 'Grant proposal',
    RESEARCH_PROPOSAL: 'Research proposal',
    GRADUATION_PROJECT: 'Graduation project',
    COURSE_ASSIGNMENT: 'Course assignment',
    ADMINISTRATIVE_DOCUMENT: 'Administrative document',
    OTHER: 'Other',
  },
  errors: {
    DOCUMENT_TYPE_NOT_FOUND: 'That document type is not available.',
    DOCUMENT_TYPE_NAME_TAKEN: 'A document type with that name already exists.',
    DOCUMENT_TYPE_ARCHIVED: 'That document type is archived.',
    DOCUMENT_TYPE_IN_USE: 'Standards still use this document type. Archive them first.',
    STANDARD_NOT_FOUND: 'That standard is not available.',
    STANDARD_CODE_TAKEN: 'A standard with that code already exists.',
    STANDARD_ARCHIVED: 'This standard is archived. Restore it before editing.',
    STANDARD_VERSION_NOT_FOUND: 'That version is not available.',
    STANDARD_VERSION_LABEL_TAKEN: 'This standard already has a version with that label.',
    STANDARD_VERSION_ARCHIVED: 'This version is archived.',
    STANDARD_VERSION_SUPERSEDED:
      'This version was superseded by a newer version. It cannot be edited or published again; ' +
      'clone it into a new draft instead.',
    STANDARD_VERSION_IMMUTABLE:
      'This version is published and cannot be edited. Clone it into a new draft instead.',
    STANDARD_VERSION_NOT_DRAFT: 'This version has not been published.',
    STANDARD_VERSION_CONFLICT:
      'Someone else changed this version while you were editing. Reload and reapply your change.',
    STANDARD_VERSION_EMPTY: 'Add at least one rule before publishing.',
    STANDARD_VERSION_INVALID: 'This draft has problems that must be fixed before publishing.',
    RULE_NOT_FOUND: 'That rule is not available.',
    RULE_CODE_TAKEN: 'Another rule in this version already uses that code.',
    RULE_SCHEMA_INVALID: 'Please correct the highlighted fields.',
    RULE_OPERATOR_INCOMPATIBLE: 'That condition does not accept this kind of value.',
    RULE_SCOPE_INVALID: 'That scope is not valid.',
    CONFLICT: 'That change conflicts with the current state.',
    VALIDATION_FAILED: 'Please check the highlighted fields.',
  },
};

const ar: StandardsMessages = {
  navDocumentTypes: 'أنواع المستندات',
  navStandards: 'المعايير',
  standardsTitle: 'المعايير',
  standardsSubtitle: 'المتطلبات التي تُفحص المستندات وفقها.',
  documentTypesTitle: 'أنواع المستندات',
  documentTypesSubtitle: 'أنواع المستندات التي تتعامل معها مؤسستك.',

  newDocumentType: 'نوع مستند جديد',
  documentTypeName: 'الاسم',
  documentTypeNameAr: 'الاسم بالعربية',
  systemCategory: 'التصنيف',
  standardsUsing: 'المعايير التي تستخدمه',
  archive: 'أرشفة',
  statusColumn: 'الحالة',
  restore: 'استعادة',

  newStandard: 'معيار جديد',
  standardCode: 'الرمز',
  standardCodeHint: 'رمز ثابت، مثل IUG.THESIS.FORMAT. لا يمكن تغييره لاحقاً.',
  nameEn: 'الاسم بالإنجليزية',
  nameAr: 'الاسم بالعربية',
  documentType: 'نوع المستند',
  versions: 'الإصدارات',
  inForce: 'ساري',
  notPublished: 'لا يوجد إصدار منشور بعد',
  searchStandards: 'ابحث في المعايير',
  noStandards: 'لا توجد معايير بعد.',
  create: 'إنشاء',
  cancel: 'إلغاء',
  save: 'حفظ',
  saved: 'تم الحفظ.',
  loadMore: 'عرض المزيد',

  versionLabel: 'الإصدار',
  newVersion: 'إصدار جديد',
  cloneVersion: 'نسخ إلى مسودة جديدة',
  cloneHint: 'لا يمكن تعديل إصدار منشور. انسخه، وعدّل النسخة، ثم انشرها.',
  publish: 'نشر',
  publishing: 'جارٍ النشر…',
  published: 'منشور',
  validate: 'تحقق من المشكلات',
  validationPassed: 'هذه المسودة جاهزة للنشر.',
  validationFailed: 'تحتوي هذه المسودة على مشكلات يجب إصلاحها قبل النشر.',
  contentHash: 'بصمة المحتوى',
  contentHashHint:
    'بصمة SHA-256 لمحتوى هذا الإصدار بالضبط. يمكن لأي جهة إعادة حسابها لإثبات أن المعيار لم يتغيّر.',
  hashVerified: 'مُتحقَّق منها',
  hashNotVerified: 'غير مطابقة',
  effectiveFrom: 'ساري من',
  effectiveUntil: 'ساري حتى',
  revision: 'المراجعة',
  publishedVersionReadOnly: 'هذا الإصدار منشور ولم يعد قابلاً للتعديل.',
  draftVersionNotice: 'هذا الإصدار مسودة، ولا يُفحص أي مستند وفقه قبل نشره.',

  rules: 'القواعد',
  addRule: 'إضافة قاعدة',
  editRule: 'تعديل القاعدة',
  deleteRule: 'حذف',
  noRules: 'لا توجد قواعد بعد. يحتاج الإصدار إلى قاعدة واحدة على الأقل قبل النشر.',
  ruleCode: 'رمز القاعدة',
  ruleCodeHint: 'أحرف كبيرة مفصولة بنقاط، مثل MARGIN.TOP.MIN. تُذكر في التقارير.',
  category: 'التصنيف',
  evaluationMode: 'طريقة التقييم',
  scopeKind: 'ينطبق على',
  sectionKey: 'القسم',
  elementType: 'العنصر',
  headingLevel: 'مستوى العنوان',
  metadataField: 'حقل البيانات الوصفية',
  pages: 'الصفحات',
  property: 'الخاصية',
  operator: 'الشرط',
  expectedValue: 'القيمة المتوقعة',
  valueType: 'نوع القيمة',
  minimum: 'الحد الأدنى',
  maximum: 'الحد الأعلى',
  listValues: 'القيم المسموح بها',
  listValuesHint: 'قيمة في كل سطر.',
  pattern: 'النمط',
  patternArgument: 'نص النمط',
  unit: 'الوحدة',
  tolerance: 'هامش السماح',
  toleranceHint: 'مقدار الانحراف عن القيمة المتوقعة الذي يظل مقبولاً.',
  severity: 'الخطورة',
  blocking: 'يمنع إصدار الشهادة',
  blockingHint: 'المستند الذي يخالف هذه القاعدة لا يمكن اعتماده.',
  upgradeRuleSchema: 'ترقية مخطط القواعد',
  upgradeRuleSchemaHint: (from, to) =>
    `ستُكتب النسخة وفق الإصدار ${to} من مخطط القواعد بدلًا من ${from}، وهو يتيح لقاعدة خاضعة ` +
    `للمراجعة أن تمنع إصدار الشهادة. أما هذا الإصدار نفسه فلا يتغير.`,
  blockingReviewHint:
    'المستند الذي يخالف هذه القاعدة لا يمكن اعتماده. ولأن هذه القاعدة تُقيَّم بالحكم لا بالقياس، ' +
    'يبقى الاعتماد معلقًا حتى يبتّ فيها مراجع؛ فالنتيجة لا تُقرَّر آليًا أبدًا.',
  blockingDeterministicOnlyHint:
    'يستخدم هذا المعيار الإصدار الأول من مخطط القواعد، وفيه لا يمنع إصدارَ الشهادة إلا قاعدة ' +
    'مقيسة. انسخ المعيار وارفع إصدار المخطط لتتمكن من المنع بقاعدة تخضع للمراجعة.',
  autofix: 'التصحيح التلقائي',
  origin: 'المصدر',
  originReference: 'المرجع',
  titleEn: 'العنوان بالإنجليزية',
  titleAr: 'العنوان بالعربية',
  descriptionEn: 'الوصف بالإنجليزية',
  descriptionAr: 'الوصف بالعربية',
  guidanceEn: 'الإرشاد بالإنجليزية',
  guidanceAr: 'الإرشاد بالعربية',
  noOperandNeeded: 'هذا الشرط لا يحتاج إلى قيمة.',

  reorder: 'إعادة الترتيب',
  moveUp: 'تحريك لأعلى',
  moveDown: 'تحريك لأسفل',
  orderSaved: 'تم حفظ الترتيب.',
  reorderHint: 'استخدم أزرار التحريك، أو ركّز على قاعدة واضغط مفاتيح الأسهم.',

  manage: {
    catalogueTitle: 'فهرس الفحص',
    catalogueHint:
      'يستطيع أي شخص فحص مستند وفق معيار مدرج في الفهرس، دون أن يرى قواعده، ودون أن تروا ' +
      'مستنداته أو نتائجه. ولا يظهر المعيار إلا ما دامت مؤسستكم موثّقة وله إصدار منشور.',
    cataloguePublic: 'مدرج في فهرس الفحص',
    cataloguePrivate: 'خاص بمؤسستكم',
    addToCatalogue: 'إدراج في فهرس الفحص',
    addToCatalogueIntro:
      'سيتمكن أشخاص من خارج مؤسستكم من فحص مستنداتهم وفق هذا المعيار. تبقى قواعده خاصة، ' +
      'ولا ترون شيئًا من مستنداتهم.',
    withdrawFromCatalogue: 'سحب من فهرس الفحص',
    withdrawFromCatalogueIntro:
      'تتوقف الفحوصات الجديدة وفق هذا المعيار، ولا تتغيّر التقارير الصادرة.',
    catalogueChanged: 'تم تحديث فهرس الفحص.',
    editStandard: 'تعديل المعيار',
    editStandardIntro: 'الأسماء والأوصاف. لا يتغيّر الرمز ولا القواعد من هنا.',
    archiveStandard: 'أرشفة المعيار',
    archiveStandardIntro:
      'يُحتفظ بالمعيار وجميع إصداراته، لكن لا يمكن إنشاء إصدار جديد ويخرج من فهرس الفحص. ' +
      'ويمكنكم استعادته.',
    restoreStandard: 'استعادة المعيار',
    restoreStandardIntro: 'يعود المعيار نشطًا.',
    archivedNotice: 'هذا المعيار مؤرشف.',
    editDraft: 'تعديل المسودة',
    editDraftIntro: 'التسمية وتواريخ السريان. لا يمكن تعديل إصدار منشور.',
    effectiveHint: 'تاريخ، مثل 2027-09-01.',
    archiveVersion: 'أرشفة الإصدار',
    archiveVersionIntro: 'يُحتفظ بالإصدار للسجل، لكن لا يمكن استخدامه لفحوصات جديدة.',
    downloadSnapshot: 'تنزيل اللقطة المنشورة',
    snapshotHint: 'المحتوى المعياري كما نُشر وحُسب بصمته، بصيغة JSON، لمطابقته مع بصمة المحتوى.',
    editDocumentType: 'تعديل',
    editDocumentTypeIntro: 'الأسماء والأوصاف التي يراها من يقدّمون إليكم.',
    descriptionLabel: 'الوصف (بالإنجليزية)',
    descriptionArLabel: 'الوصف (بالعربية)',
    close: 'إغلاق',
    optional: 'اختياري',
    working: 'يرجى الانتظار…',
    required: 'هذا الحقل مطلوب.',
  },
  lifecycle: {
    confirmTitle: (next) => `نشر الإصدار ${next}؟`,
    confirmBody: (current, next) =>
      `الإصدار ${current} هو الساري حاليًا. نشر الإصدار ${next} سيجعله الإصدار الساري، مع ` +
      `الاحتفاظ بالإصدار ${current} إصدارًا سابقًا مُستبدَلًا في السجل.`,
    confirmReplace: (current) => `النشر واستبدال الإصدار ${current}`,
    publishedReplacing: (next, previous) =>
      `أصبح الإصدار ${next} ساريًا. ويُحتفظ بالإصدار ${previous} إصدارًا مُستبدَلًا.`,
    historyColumn: 'السجل',
    inForceSince: (date) => `ساري منذ ${date}`,
    supersededBy: (label) => `استُبدل بالإصدار ${label}`,
    supersededByOn: (label, date) => `استُبدل بالإصدار ${label} في ${date}`,
    archivedOn: (date) => `أُرشف في ${date}`,
    supersededNotice: (label, date) =>
      `استُبدل بالإصدار ${label} في ${date}. يُحتفظ به دون تغيير بوصفه المرجع الذي تستند إليه ` +
      'الفحوصات والتقارير والشهادات السابقة، ولم يعد متاحًا للفحوصات الجديدة. انسخه لاستخدام ' +
      'محتواه من جديد.',
    archivedNotice: 'أُرشف هذا الإصدار. يُحتفظ به للسجل، ولا يمكن تعديله أو نشره.',
    publishedOn: 'تاريخ النشر',
    publishedBy: 'نشره',
    supersededOn: 'تاريخ الاستبدال',
    supersededByLabel: 'استُبدل بـ',
    unknownPerson: 'عضو سابق',
    usageTitle: 'ما يستند إليه',
    usageHint:
      'الطلبات المقدَّمة إلى مؤسستكم التي فُحصت وفق هذا الإصدار، والشهادات الصادرة عليها. ' +
      'أما الفحوصات الفردية فتعود لأصحابها ولا تظهر هنا.',
    usageSubmissions: 'الطلبات',
    usageCertificates: 'الشهادات الصادرة',
    viewCertificates: 'عرض الشهادات',
    cloneHistoricalHint:
      'هذا الإصدار جزء من السجل، فلا يمكن تعديله ولا نشره من جديد. انسخه إلى مسودة جديدة ' +
      'وراجعها ثم انشرها لاستعادة محتواه.',
  },
  versionStatuses: {
    DRAFT: 'مسودة',
    PUBLISHED: 'منشور · ساري',
    SUPERSEDED: 'مُستبدَل',
    ARCHIVED: 'مؤرشف',
  },
  statuses: {
    ACTIVE: 'نشط',
    ARCHIVED: 'مؤرشف',
  },
  categories: {
    PAGE_SETUP: 'إعداد الصفحة',
    MARGINS: 'الهوامش',
    TYPOGRAPHY: 'الخطوط',
    SPACING: 'التباعد',
    ALIGNMENT: 'المحاذاة',
    PAGINATION: 'ترقيم الصفحات',
    HEADINGS: 'العناوين',
    TITLE_PAGE: 'صفحة العنوان',
    ABSTRACT: 'الملخص',
    KEYWORDS: 'الكلمات المفتاحية',
    TABLE_OF_CONTENTS: 'جدول المحتويات',
    SECTION_STRUCTURE: 'بنية الأقسام',
    TABLES: 'الجداول',
    FIGURES: 'الأشكال',
    CAPTIONS: 'التسميات التوضيحية',
    EQUATIONS: 'المعادلات',
    CITATIONS: 'الاستشهادات',
    REFERENCES: 'المراجع',
    LANGUAGE_QUALITY: 'جودة اللغة',
    TERMINOLOGY: 'المصطلحات',
    RESEARCH_ETHICS: 'أخلاقيات البحث',
    DOCUMENT_METADATA: 'البيانات الوصفية للمستند',
    FILE_TECHNICAL: 'الملف والجوانب التقنية',
  },
  evaluationModes: {
    DETERMINISTIC: 'مقيسة',
    AI_ASSISTED: 'بمساعدة الذكاء الاصطناعي',
    MANUAL: 'يراجعها شخص',
  },
  severities: {
    INFO: 'معلومة',
    MINOR: 'بسيطة',
    MAJOR: 'كبيرة',
    CRITICAL: 'حرجة',
  },
  autofixCapabilities: {
    NONE: 'لا يوجد',
    SAFE: 'تعديلات آمنة فقط',
    ADVANCED: 'متقدم (يتطلب موافقة)',
  },
  origins: {
    ORGANIZATION_POLICY: 'سياسة المؤسسة',
    NATIONAL_REGULATION: 'لائحة وطنية',
    PUBLISHER_GUIDELINE: 'إرشادات الناشر',
    STYLE_GUIDE: 'دليل الأسلوب',
    ACCESSIBILITY_STANDARD: 'معيار إتاحة',
    PALCERT_TEMPLATE: 'قالب بال‌سيرت',
    OTHER: 'أخرى',
  },
  operators: {
    EQUALS: 'يساوي تماماً',
    NOT_EQUALS: 'لا يساوي',
    GREATER_THAN: 'أكبر من',
    GREATER_THAN_OR_EQUAL: 'لا يقل عن',
    LESS_THAN: 'أقل من',
    LESS_THAN_OR_EQUAL: 'لا يزيد عن',
    BETWEEN: 'بين',
    IN: 'أحد القيم',
    NOT_IN: 'ليس أياً من',
    CONTAINS: 'يحتوي على',
    NOT_CONTAINS: 'لا يحتوي على',
    MATCHES_PATTERN: 'يطابق',
    EXISTS: 'موجود',
    NOT_EXISTS: 'غير موجود',
  },
  units: {
    COUNT: 'عدد',
    MILLIMETRE: 'مم',
    CENTIMETRE: 'سم',
    INCH: 'بوصة',
    POINT: 'نقطة',
    PIXEL: 'بكسل',
    PERCENT: '٪',
    LINES: 'أسطر',
    WORDS: 'كلمات',
    CHARACTERS: 'أحرف',
    PAGES: 'صفحات',
    MEGABYTE: 'ميغابايت',
    DPI: 'نقطة/بوصة',
  },
  scopeKinds: {
    DOCUMENT: 'المستند بأكمله',
    SECTION: 'قسم',
    ELEMENT: 'عنصر',
    METADATA: 'البيانات الوصفية',
    PAGE: 'صفحة',
  },
  systemCategories: {
    THESIS: 'رسالة',
    DISSERTATION: 'أطروحة',
    JOURNAL_ARTICLE: 'مقال في مجلة',
    CONFERENCE_PAPER: 'ورقة مؤتمر',
    BOOK: 'كتاب',
    BOOK_CHAPTER: 'فصل من كتاب',
    TECHNICAL_REPORT: 'تقرير فني',
    GRANT_PROPOSAL: 'مقترح منحة',
    RESEARCH_PROPOSAL: 'مقترح بحثي',
    GRADUATION_PROJECT: 'مشروع تخرج',
    COURSE_ASSIGNMENT: 'واجب مقرر',
    ADMINISTRATIVE_DOCUMENT: 'مستند إداري',
    OTHER: 'أخرى',
  },
  errors: {
    DOCUMENT_TYPE_NOT_FOUND: 'نوع المستند هذا غير متاح.',
    DOCUMENT_TYPE_NAME_TAKEN: 'يوجد نوع مستند بهذا الاسم بالفعل.',
    DOCUMENT_TYPE_ARCHIVED: 'نوع المستند هذا مؤرشف.',
    DOCUMENT_TYPE_IN_USE: 'ما زالت هناك معايير تستخدم نوع المستند هذا. أرشفها أولاً.',
    STANDARD_NOT_FOUND: 'هذا المعيار غير متاح.',
    STANDARD_CODE_TAKEN: 'يوجد معيار بهذا الرمز بالفعل.',
    STANDARD_ARCHIVED: 'هذا المعيار مؤرشف. استعده قبل التعديل.',
    STANDARD_VERSION_NOT_FOUND: 'هذا الإصدار غير متاح.',
    STANDARD_VERSION_LABEL_TAKEN: 'يوجد إصدار بهذا الاسم في هذا المعيار بالفعل.',
    STANDARD_VERSION_ARCHIVED: 'هذا الإصدار مؤرشف.',
    STANDARD_VERSION_SUPERSEDED:
      'استُبدل هذا الإصدار بإصدار أحدث. لا يمكن تعديله ولا نشره من جديد؛ انسخه إلى مسودة جديدة بدلًا من ذلك.',
    STANDARD_VERSION_IMMUTABLE:
      'هذا الإصدار منشور ولا يمكن تعديله. انسخه إلى مسودة جديدة بدلاً من ذلك.',
    STANDARD_VERSION_NOT_DRAFT: 'لم يُنشر هذا الإصدار.',
    STANDARD_VERSION_CONFLICT:
      'قام شخص آخر بتعديل هذا الإصدار أثناء عملك. أعد التحميل ثم طبّق تعديلك.',
    STANDARD_VERSION_EMPTY: 'أضف قاعدة واحدة على الأقل قبل النشر.',
    STANDARD_VERSION_INVALID: 'تحتوي هذه المسودة على مشكلات يجب إصلاحها قبل النشر.',
    RULE_NOT_FOUND: 'هذه القاعدة غير متاحة.',
    RULE_CODE_TAKEN: 'توجد قاعدة أخرى في هذا الإصدار تستخدم هذا الرمز.',
    RULE_SCHEMA_INVALID: 'يرجى تصحيح الحقول المحددة.',
    RULE_OPERATOR_INCOMPATIBLE: 'هذا الشرط لا يقبل هذا النوع من القيم.',
    RULE_SCOPE_INVALID: 'النطاق غير صالح.',
    CONFLICT: 'هذا التغيير يتعارض مع الحالة الحالية.',
    VALIDATION_FAILED: 'يرجى مراجعة الحقول المحددة.',
  },
};

export const STANDARDS_MESSAGES: Record<Locale, StandardsMessages> = { en, ar };

export function getStandardsMessages(locale: Locale): StandardsMessages {
  return STANDARDS_MESSAGES[locale] ?? STANDARDS_MESSAGES.en;
}
