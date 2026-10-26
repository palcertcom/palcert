import type { Locale } from './locales';

/**
 * Portable standard packages: export, the import wizard and the provenance of
 * an imported draft. Parity between locales is enforced by test.
 */
export interface StandardTransferMessages {
  readonly exportStandard: string;
  readonly exportHint: string;
  readonly exporting: string;
  readonly exported: (fileName: string) => string;

  readonly importStandard: string;
  readonly importTitle: string;
  readonly importIntro: string;
  readonly chooseFile: string;
  readonly chooseFileHint: (megabytes: number) => string;
  readonly reading: string;
  readonly fileTooLarge: (megabytes: number) => string;
  readonly chooseAnother: string;

  readonly summaryHeading: string;
  readonly source: string;
  readonly standard: string;
  readonly exportedVersion: string;
  readonly exportedStatus: string;
  readonly exportedAt: string;
  readonly documentCategory: string;
  readonly rules: string;
  readonly ruleSchema: string;
  readonly ruleSchemaValue: (from: number, to: number) => string;
  readonly integrity: string;
  readonly integrityVerified: string;
  readonly integrityNote: string;
  readonly compatibility: string;
  readonly compatible: string;
  readonly needsAttention: (count: number) => string;
  readonly ruleCounts: (total: number, valid: number, invalid: number) => string;
  readonly packageHash: string;
  readonly warnings: string;

  readonly rulesHeading: string;
  readonly search: string;
  readonly searchPlaceholder: string;
  readonly filterCategory: string;
  readonly allCategories: string;
  readonly invalidOnly: string;
  readonly colCode: string;
  readonly colCategory: string;
  readonly colValue: string;
  readonly colStatus: string;
  readonly valid: string;
  readonly invalid: string;
  readonly details: string;
  readonly hideDetails: string;
  readonly noMatches: string;
  readonly showing: (shown: number, total: number) => string;
  readonly issuesHeading: string;
  readonly scope: string;
  readonly severity: string;
  readonly blocking: string;
  readonly yes: string;
  readonly no: string;

  readonly destinationHeading: string;
  readonly modeNew: string;
  readonly modeNewHint: string;
  readonly modeExisting: string;
  readonly modeExistingHint: string;
  readonly code: string;
  readonly nameEn: string;
  readonly nameAr: string;
  readonly documentType: string;
  readonly chooseDocumentType: string;
  readonly noDocumentTypeInCategory: (category: string) => string;
  readonly versionLabel: string;
  readonly existingStandard: string;
  readonly chooseStandard: string;
  readonly incompatibleStandard: string;
  readonly draftsAlready: (count: number) => string;
  readonly labelTaken: string;
  readonly codeTakenTitle: string;
  readonly codeTakenBody: (code: string) => string;
  readonly changeCode: string;
  readonly importAsVersion: string;
  readonly duplicateTitle: string;
  readonly duplicateBody: (date: string) => string;
  readonly acknowledgeDuplicate: string;
  readonly invalidBlocks: string;
  readonly draftOnly: string;
  readonly importButton: string;
  readonly importing: string;
  readonly cancel: string;

  readonly provenanceTitle: string;
  readonly importedFrom: string;
  readonly sourceVersion: string;
  readonly sourceStatus: string;
  readonly imported: string;
  readonly provenanceNotice: string;
  readonly provenanceAdopted: string;

  readonly statuses: Readonly<Record<string, string>>;
  readonly warningText: Readonly<Record<string, string>>;
  readonly errors: Readonly<Record<string, string>>;
}

const en: StandardTransferMessages = {
  exportStandard: 'Export standard',
  exportHint:
    'Download this version as a portable .palcert.json file another PalCert organization can ' +
    'import as a draft. It contains the standard and its rules only — no people, checks, ' +
    'certificates or source documents.',
  exporting: 'Preparing file…',
  exported: (fileName) => `Downloaded ${fileName}.`,

  importStandard: 'Import standard',
  importTitle: 'Import standard',
  importIntro:
    'Import a .palcert.json file exported from PalCert. Nothing is created until you have ' +
    'reviewed it, and it always arrives as a draft you check and publish yourself.',
  chooseFile: 'Standard file',
  chooseFileHint: (megabytes) => `A .palcert.json or .json file, up to ${megabytes} MB.`,
  reading: 'Checking the file…',
  fileTooLarge: (megabytes) => `The file is larger than ${megabytes} MB.`,
  chooseAnother: 'Choose another file',

  summaryHeading: 'What the file contains',
  source: 'Source',
  standard: 'Standard',
  exportedVersion: 'Exported version',
  exportedStatus: 'Status at the source',
  exportedAt: 'Exported',
  documentCategory: 'Document category',
  rules: 'Rules',
  ruleSchema: 'Rule schema',
  ruleSchemaValue: (from, to) => (from === to ? `v${to}` : `v${from} → imported as v${to}`),
  integrity: 'Integrity',
  integrityVerified: 'Verified',
  integrityNote:
    'The file has not been changed since it was exported. This does not prove who exported it.',
  compatibility: 'Compatibility',
  compatible: 'Compatible',
  needsAttention: (count) => `${count} rule${count === 1 ? '' : 's'} need attention`,
  ruleCounts: (total, valid, invalid) =>
    `${total} rules found · ${valid} valid · ${invalid} need attention`,
  packageHash: 'Package hash',
  warnings: 'Before you import',

  rulesHeading: 'Rules in the file',
  search: 'Search rules',
  searchPlaceholder: 'Rule code or title',
  filterCategory: 'Category',
  allCategories: 'All categories',
  invalidOnly: 'Only rules that need attention',
  colCode: 'Rule code',
  colCategory: 'Category',
  colValue: 'Value',
  colStatus: 'Status',
  valid: 'Valid',
  invalid: 'Needs attention',
  details: 'Details',
  hideDetails: 'Hide',
  noMatches: 'No rules match.',
  showing: (shown, total) => `Showing ${shown} of ${total}`,
  issuesHeading: 'Problems',
  scope: 'Applies to',
  severity: 'Severity',
  blocking: 'Blocks certification',
  yes: 'Yes',
  no: 'No',

  destinationHeading: 'Where to import it',
  modeNew: 'Create a new standard',
  modeNewHint: 'A new standard with this version as its first draft.',
  modeExisting: 'Add a draft to an existing standard',
  modeExistingHint: 'A new draft version. Existing versions are never changed.',
  code: 'Code',
  nameEn: 'Name (English)',
  nameAr: 'Name (Arabic)',
  documentType: 'Document type',
  chooseDocumentType: 'Choose a document type…',
  noDocumentTypeInCategory: (category) =>
    `Your organization has no document type in the ${category} category yet. Create one under ` +
    'Document types first.',
  versionLabel: 'Version label',
  existingStandard: 'Standard',
  chooseStandard: 'Choose a standard…',
  incompatibleStandard: 'for another kind of document',
  draftsAlready: (count) =>
    `This standard already has ${count} draft${count === 1 ? '' : 's'}. The import creates a ` +
    'separate new draft; nothing is merged.',
  labelTaken: 'This standard already has a version with this label.',
  codeTakenTitle: 'This code is already in use',
  codeTakenBody: (code) =>
    `Your organization already has a standard with the code ${code}. It will not be overwritten.`,
  changeCode: 'Change the code',
  importAsVersion: 'Import as a new version of that standard',
  duplicateTitle: 'Already imported',
  duplicateBody: (date) => `This package was already imported on ${date}.`,
  acknowledgeDuplicate: 'Import it again anyway, as a separate draft',
  invalidBlocks:
    'Some rules need attention, so this file cannot be imported. Ask the organization that ' +
    'exported it to correct them and export it again.',
  draftOnly:
    'The import creates a draft only. Nothing is published and no document is checked against ' +
    'it until you review it and publish it yourself.',
  importButton: 'Import as draft',
  importing: 'Importing…',
  cancel: 'Cancel',

  provenanceTitle: 'Imported standard',
  importedFrom: 'Imported from',
  sourceVersion: 'Source version',
  sourceStatus: 'Status at the source',
  imported: 'Imported',
  provenanceNotice:
    'This is now a draft in your organization. Review it before publishing: its rules become ' +
    'your organization’s requirements only when you publish it.',
  provenanceAdopted: 'Your organization has reviewed and published this content.',

  statuses: {
    DRAFT: 'Draft',
    PUBLISHED: 'Published',
    SUPERSEDED: 'Superseded',
    ARCHIVED: 'Archived',
  },
  warningText: {
    RULE_SCHEMA_UPGRADED:
      'This file uses an older rule schema; PalCert will import it using the current one.',
    SOURCE_WAS_DRAFT:
      'This file was exported from a draft the source organization had not published.',
    SIGNATURES_NOT_VERIFIED:
      'The file carries signatures, which this version of PalCert does not verify.',
    ALREADY_IMPORTED: 'This file has been imported into your organization before.',
    CODE_TAKEN: 'Your organization already has a standard with this code.',
    NO_MATCHING_DOCUMENT_TYPE: 'Your organization has no document type in this category.',
  },
  errors: {
    STANDARD_IMPORT_PACKAGE_INVALID: 'This is not a valid PalCert standard file.',
    STANDARD_IMPORT_PACKAGE_TOO_LARGE: 'The file is too large.',
    STANDARD_IMPORT_INTEGRITY_FAILED:
      "The file's integrity check failed. The contents may have been changed after export.",
    STANDARD_IMPORT_UNSUPPORTED:
      'This standard was created by a newer PalCert format that this installation does not support.',
    STANDARD_IMPORT_RULES_INVALID:
      'Some rules in this file need attention, so nothing was imported.',
    STANDARD_IMPORT_PACKAGE_CHANGED: 'The file changed after it was previewed. Choose it again.',
    STANDARD_IMPORT_DUPLICATE: 'This file was already imported. Confirm below to import it again.',
    STANDARD_IMPORT_INCOMPATIBLE: 'That choice is for another kind of document.',
    STANDARD_CODE_TAKEN: 'Your organization already has a standard with this code.',
    STANDARD_VERSION_LABEL_TAKEN: 'This standard already has a version with this label.',
    STANDARD_VERSION_EMPTY: 'This version has no rules, so there is nothing to export.',
    STANDARD_ARCHIVED: 'That standard is archived. Restore it first.',
    DOCUMENT_TYPE_ARCHIVED: 'That document type is archived.',
    VALIDATION_FAILED: 'Please check the information you entered.',
    PERMISSION_DENIED: 'You do not have permission to do this.',
  },
};

const ar: StandardTransferMessages = {
  exportStandard: 'تصدير المعيار',
  exportHint:
    'نزّل هذا الإصدار ملفًا قابلًا للنقل بامتداد palcert.json. يمكن لمؤسسة أخرى في PalCert ' +
    'استيراده مسودةً. يحتوي على المعيار وقواعده فقط، دون أشخاص أو فحوصات أو شهادات أو مستندات مصدرية.',
  exporting: 'جارٍ تجهيز الملف…',
  exported: (fileName) => `تم تنزيل ${fileName}.`,

  importStandard: 'استيراد معيار',
  importTitle: 'استيراد معيار',
  importIntro:
    'استورد ملف palcert.json مصدَّرًا من PalCert. لا يُنشأ شيء قبل مراجعتك له، ويصل دائمًا ' +
    'مسودةً تفحصها وتنشرها بنفسك.',
  chooseFile: 'ملف المعيار',
  chooseFileHint: (megabytes) => `ملف palcert.json أو json بحجم لا يزيد على ${megabytes} ميغابايت.`,
  reading: 'جارٍ فحص الملف…',
  fileTooLarge: (megabytes) => `حجم الملف أكبر من ${megabytes} ميغابايت.`,
  chooseAnother: 'اختيار ملف آخر',

  summaryHeading: 'محتوى الملف',
  source: 'المصدر',
  standard: 'المعيار',
  exportedVersion: 'الإصدار المصدَّر',
  exportedStatus: 'الحالة لدى المصدر',
  exportedAt: 'تاريخ التصدير',
  documentCategory: 'فئة المستند',
  rules: 'القواعد',
  ruleSchema: 'مخطط القواعد',
  ruleSchemaValue: (from, to) =>
    from === to ? `الإصدار ${to}` : `الإصدار ${from} ← يُستورد بالإصدار ${to}`,
  integrity: 'سلامة الملف',
  integrityVerified: 'تم التحقق',
  integrityNote: 'لم يتغير الملف منذ تصديره. وهذا لا يثبت هوية من صدّره.',
  compatibility: 'التوافق',
  compatible: 'متوافق',
  needsAttention: (count) => `${count} من القواعد تحتاج إلى مراجعة`,
  ruleCounts: (total, valid, invalid) =>
    `عُثر على ${total} قاعدة · ${valid} صالحة · ${invalid} تحتاج إلى مراجعة`,
  packageHash: 'بصمة الحزمة',
  warnings: 'قبل الاستيراد',

  rulesHeading: 'القواعد في الملف',
  search: 'البحث في القواعد',
  searchPlaceholder: 'رمز القاعدة أو عنوانها',
  filterCategory: 'الفئة',
  allCategories: 'جميع الفئات',
  invalidOnly: 'القواعد التي تحتاج إلى مراجعة فقط',
  colCode: 'رمز القاعدة',
  colCategory: 'الفئة',
  colValue: 'القيمة',
  colStatus: 'الحالة',
  valid: 'صالحة',
  invalid: 'تحتاج إلى مراجعة',
  details: 'التفاصيل',
  hideDetails: 'إخفاء',
  noMatches: 'لا توجد قواعد مطابقة.',
  showing: (shown, total) => `عرض ${shown} من ${total}`,
  issuesHeading: 'المشكلات',
  scope: 'تنطبق على',
  severity: 'الخطورة',
  blocking: 'يمنع إصدار الشهادة',
  yes: 'نعم',
  no: 'لا',

  destinationHeading: 'مكان الاستيراد',
  modeNew: 'إنشاء معيار جديد',
  modeNewHint: 'معيار جديد تكون هذه النسخة مسودته الأولى.',
  modeExisting: 'إضافة مسودة إلى معيار قائم',
  modeExistingHint: 'إصدار مسودة جديد. لا تتغير الإصدارات القائمة أبدًا.',
  code: 'الرمز',
  nameEn: 'الاسم (بالإنجليزية)',
  nameAr: 'الاسم (بالعربية)',
  documentType: 'نوع المستند',
  chooseDocumentType: 'اختر نوع المستند…',
  noDocumentTypeInCategory: (category) =>
    `لا يوجد لدى مؤسستكم نوع مستند في فئة ${category} بعد. أنشئ نوعًا من صفحة أنواع المستندات أولًا.`,
  versionLabel: 'تسمية الإصدار',
  existingStandard: 'المعيار',
  chooseStandard: 'اختر معيارًا…',
  incompatibleStandard: 'لنوع آخر من المستندات',
  draftsAlready: (count) =>
    `لدى هذا المعيار ${count} من المسودات. ينشئ الاستيراد مسودة جديدة منفصلة، ولا يُدمج شيء.`,
  labelTaken: 'لدى هذا المعيار إصدار بهذه التسمية.',
  codeTakenTitle: 'هذا الرمز مستخدم',
  codeTakenBody: (code) => `لدى مؤسستكم معيار بالرمز ${code}، ولن يُستبدل.`,
  changeCode: 'تغيير الرمز',
  importAsVersion: 'الاستيراد إصدارًا جديدًا لذلك المعيار',
  duplicateTitle: 'استُورد من قبل',
  duplicateBody: (date) => `استُوردت هذه الحزمة من قبل في ${date}.`,
  acknowledgeDuplicate: 'استيرادها مرة أخرى على أي حال، مسودةً منفصلة',
  invalidBlocks:
    'بعض القواعد تحتاج إلى مراجعة، لذا لا يمكن استيراد هذا الملف. اطلب من المؤسسة التي صدّرته ' +
    'تصحيحها وتصديره من جديد.',
  draftOnly:
    'ينشئ الاستيراد مسودة فقط. لا يُنشر شيء ولا يُفحص أي مستند وفقها حتى تراجعها وتنشرها بنفسك.',
  importButton: 'الاستيراد مسودةً',
  importing: 'جارٍ الاستيراد…',
  cancel: 'إلغاء',

  provenanceTitle: 'معيار مستورد',
  importedFrom: 'مستورد من',
  sourceVersion: 'الإصدار المصدر',
  sourceStatus: 'الحالة لدى المصدر',
  imported: 'تاريخ الاستيراد',
  provenanceNotice:
    'أصبح هذا مسودة في مؤسستكم. راجعه قبل النشر: لا تصبح قواعده متطلبات مؤسستكم إلا عند نشره.',
  provenanceAdopted: 'راجعت مؤسستكم هذا المحتوى ونشرته.',

  statuses: {
    DRAFT: 'مسودة',
    PUBLISHED: 'منشور',
    SUPERSEDED: 'مُستبدَل',
    ARCHIVED: 'مؤرشف',
  },
  warningText: {
    RULE_SCHEMA_UPGRADED: 'يستخدم هذا الملف مخطط قواعد أقدم، وسيستورده PalCert بالمخطط الحالي.',
    SOURCE_WAS_DRAFT: 'صُدّر هذا الملف من مسودة لم تنشرها المؤسسة المصدر.',
    SIGNATURES_NOT_VERIFIED: 'يحمل الملف توقيعات لا يتحقق منها هذا الإصدار من PalCert.',
    ALREADY_IMPORTED: 'استُورد هذا الملف إلى مؤسستكم من قبل.',
    CODE_TAKEN: 'لدى مؤسستكم معيار بهذا الرمز.',
    NO_MATCHING_DOCUMENT_TYPE: 'لا يوجد لدى مؤسستكم نوع مستند في هذه الفئة.',
  },
  errors: {
    STANDARD_IMPORT_PACKAGE_INVALID: 'هذا ليس ملف معيار صالحًا من PalCert.',
    STANDARD_IMPORT_PACKAGE_TOO_LARGE: 'حجم الملف كبير جدًا.',
    STANDARD_IMPORT_INTEGRITY_FAILED: 'فشل التحقق من سلامة الملف. ربما تغيّر محتواه بعد التصدير.',
    STANDARD_IMPORT_UNSUPPORTED: 'أُنشئ هذا المعيار بصيغة أحدث من PalCert لا يدعمها هذا التثبيت.',
    STANDARD_IMPORT_RULES_INVALID: 'بعض القواعد في هذا الملف تحتاج إلى مراجعة، لذا لم يُستورد شيء.',
    STANDARD_IMPORT_PACKAGE_CHANGED: 'تغيّر الملف بعد معاينته. اختره مرة أخرى.',
    STANDARD_IMPORT_DUPLICATE: 'استُورد هذا الملف من قبل. أكّد أدناه لاستيراده مرة أخرى.',
    STANDARD_IMPORT_INCOMPATIBLE: 'هذا الاختيار لنوع آخر من المستندات.',
    STANDARD_CODE_TAKEN: 'لدى مؤسستكم معيار بهذا الرمز.',
    STANDARD_VERSION_LABEL_TAKEN: 'لدى هذا المعيار إصدار بهذه التسمية.',
    STANDARD_VERSION_EMPTY: 'لا يحتوي هذا الإصدار على قواعد، فلا يوجد ما يُصدَّر.',
    STANDARD_ARCHIVED: 'ذلك المعيار مؤرشف. استعده أولًا.',
    DOCUMENT_TYPE_ARCHIVED: 'نوع المستند هذا مؤرشف.',
    VALIDATION_FAILED: 'يرجى التحقق من المعلومات التي أدخلتها.',
    PERMISSION_DENIED: 'ليس لديك صلاحية للقيام بذلك.',
  },
};

export const STANDARD_TRANSFER_MESSAGES: Readonly<Record<Locale, StandardTransferMessages>> = {
  en,
  ar,
};

export function getStandardTransferMessages(locale: Locale): StandardTransferMessages {
  return STANDARD_TRANSFER_MESSAGES[locale] ?? en;
}
