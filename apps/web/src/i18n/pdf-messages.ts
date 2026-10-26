import type { Locale } from './locales';

/**
 * What a person reads about a PDF they uploaded (Phase 13 §63–§66, §153).
 *
 * Three rules shape every string here.
 *
 * **Say what PalCert did not read, and why.** A PDF does not store margins,
 * styles or tracked changes, and an untagged one does not say which text is a
 * heading. A rule PalCert cannot answer is reported as unanswered, with the
 * reason in a sentence a student can act on — not as a pass, and not as a
 * silence the user has to interpret.
 *
 * **Never imply a correction is coming.** PalCert does not edit PDFs, and an
 * empty SmartFix panel reads as a missing feature. The explanation is explicit
 * in both languages, and it says what to do instead: fix the source document
 * and export again.
 *
 * **Never state a verdict PalCert did not reach.** A signature field is a
 * field; a PDF/A claim is the document's claim about itself. Neither becomes
 * "signed" or "compliant" in either language.
 */
export interface PdfMessages {
  readonly formatLabel: string;
  readonly formatPdf: string;
  readonly formatDocx: string;

  readonly textLayerTitle: string;
  readonly textLayers: Readonly<Record<string, string>>;
  readonly textLayerHints: Readonly<Record<string, string>>;
  readonly scannedAdvice: string;
  readonly hybridPages: (scanned: number, total: number) => string;

  readonly taggedTitle: string;
  readonly tagged: string;
  readonly untagged: string;
  readonly untaggedExplanation: string;

  readonly smartFixTitle: string;
  readonly smartFixUnavailable: string;
  readonly smartFixAdvice: string;

  readonly coverageTitle: string;
  readonly coverageIntro: string;
  readonly coverageLevels: Readonly<Record<string, string>>;
  readonly coverageCounts: (supported: number, total: number) => string;
  readonly coverageNotAPromise: string;
  readonly coverageNone: string;
  readonly columnRule: string;
  readonly columnAnswerable: string;
  readonly columnWhy: string;
  readonly supportLevels: Readonly<Record<string, string>>;

  readonly observationsTitle: string;
  readonly signatureField: (count: number) => string;
  readonly signatureNotVerified: string;
  readonly pdfaClaim: (part: string, level: string) => string;
  readonly pdfaNotValidated: string;
  readonly attachments: (count: number) => string;
  readonly activeContent: string;
  readonly pageCount: (count: number) => string;

  readonly errors: Readonly<Record<string, string>>;
}

const en: PdfMessages = {
  formatLabel: 'Format',
  formatPdf: 'PDF',
  formatDocx: 'Word document',

  textLayerTitle: 'Text in this document',
  textLayers: {
    NATIVE_TEXT: 'Searchable text',
    IMAGE_ONLY: 'Scanned pages, no text',
    HYBRID: 'Partly scanned',
    EMPTY_OR_UNKNOWN: 'No readable text',
  },
  textLayerHints: {
    NATIVE_TEXT: 'PalCert could read this document’s text directly, so typography was checked.',
    IMAGE_ONLY:
      'Every page is an image. There is no text to read, so nothing about fonts, sizes or ' +
      'wording could be checked. PalCert does not guess at text in a picture.',
    HYBRID:
      'Some pages have real text and some are images. The image pages were not checked for ' +
      'anything about text.',
    EMPTY_OR_UNKNOWN: 'PalCert found no readable text on any page.',
  },
  scannedAdvice:
    'If this document was scanned or photographed, export a new PDF from the file you wrote it ' +
    'in. The text will then be readable and far more of your requirements can be checked.',
  hybridPages: (scanned, total) =>
    `${scanned} of ${total} page${total === 1 ? '' : 's'} have no readable text.`,

  taggedTitle: 'Document structure',
  tagged: 'This PDF declares its structure',
  untagged: 'This PDF does not declare its structure',
  untaggedExplanation:
    'A PDF records where text was printed, not what it means. Without a declared structure, ' +
    'PalCert cannot tell a heading from a large line of text, or a table from lines on a page. ' +
    'Requirements about headings, tables and figures are therefore reported as not checked, ' +
    'rather than guessed at.',

  smartFixTitle: 'Correcting this document',
  smartFixUnavailable: 'PalCert does not correct PDFs.',
  smartFixAdvice:
    'A PDF stores the finished page, not the instructions that produced it, so changing a ' +
    'margin or a font would mean re-laying out every page. Correct the document you wrote — ' +
    'usually a Word file — and export a new PDF, or upload that document for checking instead.',

  coverageTitle: 'What can be checked in this format',
  coverageIntro:
    'PalCert compared this standard’s requirements with what a PDF can actually answer. This ' +
    'is free and your document has not been opened yet.',
  coverageLevels: {
    FULL: 'Every requirement can be checked',
    PARTIAL: 'Some requirements can be checked',
    NONE: 'No requirement can be checked',
  },
  coverageCounts: (supported, total) => `${supported} of ${total} requirements`,
  coverageNotAPromise:
    'A requirement listed here as checkable is one PalCert can read from a PDF in principle. ' +
    'A scanned document may still leave it unanswered — that is only known once the check runs.',
  coverageNone:
    'None of this standard’s requirements can be answered from a PDF, so this check cannot be ' +
    'bought. Upload the document in a format that stores them — usually a Word file — or ' +
    'choose a different standard.',
  columnRule: 'Requirement',
  columnAnswerable: 'Checkable',
  columnWhy: 'Why',
  supportLevels: {
    EXACT: 'Yes, read from the document',
    DERIVED: 'Yes, measured by PalCert',
    UNSUPPORTED: 'No',
  },

  observationsTitle: 'What PalCert observed',
  signatureField: (count) =>
    count === 1 ? '1 signature field is present' : `${count} signature fields are present`,
  signatureNotVerified:
    'PalCert reports that the field exists. It does not check whether the signature is valid ' +
    'or who made it.',
  pdfaClaim: (part, level) => `This document states that it is PDF/A-${part}${level}`,
  pdfaNotValidated:
    'That is the document’s own statement about itself. PalCert does not verify PDF/A ' +
    'conformance.',
  attachments: (count) =>
    count === 1 ? '1 embedded file is present' : `${count} embedded files are present`,
  activeContent:
    'This document contains active content, such as a script or a link action. PalCert counted ' +
    'it and did not open, run or follow any of it.',
  pageCount: (count) => `${count} page${count === 1 ? '' : 's'}`,

  errors: {
    CHECK_STANDARD_NOT_SUPPORTED_FOR_FORMAT:
      'None of this standard’s requirements can be checked in this document’s format.',
    DOCUMENT_PASSWORD_REQUIRED:
      'This PDF is protected by a password, so PalCert could not open it. You have not been ' +
      'charged. Upload a copy without a password.',
    DOCUMENT_ENCRYPTION_UNSUPPORTED:
      'This PDF is encrypted in a way PalCert cannot open. You have not been charged.',
    DOCUMENT_INVALID: 'PalCert could not read this file as a PDF. You have not been charged.',
    DOCUMENT_TOO_COMPLEX:
      'This PDF is larger or more complex than PalCert can analyze. You have not been charged.',
  },
};

const ar: PdfMessages = {
  formatLabel: 'الصيغة',
  formatPdf: 'PDF',
  formatDocx: 'مستند وورد',

  textLayerTitle: 'النص في هذا المستند',
  textLayers: {
    NATIVE_TEXT: 'نص قابل للبحث',
    IMAGE_ONLY: 'صفحات ممسوحة ضوئيًا، بلا نص',
    HYBRID: 'ممسوح جزئيًا',
    EMPTY_OR_UNKNOWN: 'لا يوجد نص مقروء',
  },
  textLayerHints: {
    NATIVE_TEXT: 'تمكّن بال‌سيرت من قراءة نص المستند مباشرة، فجرى فحص الخطوط والأحجام.',
    IMAGE_ONLY:
      'كل صفحة في هذا الملف صورة. لا يوجد نص لقراءته، لذلك تعذّر فحص أي شيء يتعلق بالخطوط أو ' +
      'الأحجام أو الصياغة. وبال‌سيرت لا يخمّن النص الموجود داخل الصورة.',
    HYBRID:
      'بعض الصفحات تحتوي على نص حقيقي وبعضها صور. والصفحات المصوّرة لم يجرِ فحص أي شيء ' +
      'يتعلق بالنص فيها.',
    EMPTY_OR_UNKNOWN: 'لم يجد بال‌سيرت نصًا مقروءًا في أي صفحة.',
  },
  scannedAdvice:
    'إن كان هذا المستند ممسوحًا ضوئيًا أو مصوَّرًا، فأصدر ملف PDF جديدًا من الملف الذي كتبته ' +
    'فيه. عندها يصبح النص مقروءًا ويمكن فحص عدد أكبر بكثير من متطلباتك.',
  hybridPages: (scanned, total) => `${scanned} من ${total} صفحة لا تحتوي على نص مقروء.`,

  taggedTitle: 'بنية المستند',
  tagged: 'هذا الملف يصرّح ببنيته',
  untagged: 'هذا الملف لا يصرّح ببنيته',
  untaggedExplanation:
    'يسجّل ملف PDF موضع طباعة النص لا معناه. وبغياب بنية مصرَّح بها، لا يستطيع بال‌سيرت ' +
    'التمييز بين عنوان وسطر نص كبير، ولا بين جدول وخطوط مرسومة على الصفحة. لذلك تُذكر ' +
    'المتطلبات المتعلقة بالعناوين والجداول والأشكال على أنها لم تُفحص، بدل تخمينها.',

  smartFixTitle: 'تصحيح هذا المستند',
  smartFixUnavailable: 'لا يصحّح بال‌سيرت ملفات PDF.',
  smartFixAdvice:
    'يخزّن ملف PDF الصفحة النهائية لا التعليمات التي أنتجتها، فتغيير هامش أو خط يعني إعادة ' +
    'تنسيق كل صفحة من جديد. صحّح المستند الذي كتبته — وهو غالبًا ملف وورد — ثم أصدر منه ' +
    'ملف PDF جديدًا، أو ارفع ذلك المستند للفحص بدلًا من هذا.',

  coverageTitle: 'ما الذي يمكن فحصه في هذه الصيغة',
  coverageIntro:
    'قارن بال‌سيرت متطلبات هذا المعيار بما يمكن لملف PDF أن يجيب عنه فعلًا. هذه المقارنة ' +
    'مجانية ولم يُفتح مستندك بعد.',
  coverageLevels: {
    FULL: 'يمكن فحص كل المتطلبات',
    PARTIAL: 'يمكن فحص بعض المتطلبات',
    NONE: 'لا يمكن فحص أي متطلب',
  },
  coverageCounts: (supported, total) => `${supported} من ${total} متطلبًا`,
  coverageNotAPromise:
    'المتطلب المذكور هنا على أنه قابل للفحص هو ما يستطيع بال‌سيرت قراءته من ملف PDF من حيث ' +
    'المبدأ. وقد يبقى دون إجابة في مستند ممسوح ضوئيًا، ولا يُعرف ذلك إلا عند تنفيذ الفحص.',
  coverageNone:
    'لا يمكن الإجابة عن أي من متطلبات هذا المعيار انطلاقًا من ملف PDF، لذلك لا يمكن شراء هذا ' +
    'الفحص. ارفع المستند بصيغة تحفظ هذه المتطلبات — وهي غالبًا ملف وورد — أو اختر معيارًا آخر.',
  columnRule: 'المتطلَّب',
  columnAnswerable: 'قابل للفحص',
  columnWhy: 'السبب',
  supportLevels: {
    EXACT: 'نعم، مقروء من المستند',
    DERIVED: 'نعم، بقياس من بال‌سيرت',
    UNSUPPORTED: 'لا',
  },

  observationsTitle: 'ما رصده بال‌سيرت',
  signatureField: (count) => (count === 1 ? 'يوجد حقل توقيع واحد' : `توجد ${count} حقول توقيع`),
  signatureNotVerified: 'يذكر بال‌سيرت وجود الحقل فقط، ولا يتحقق من صحة التوقيع ولا من هوية صاحبه.',
  pdfaClaim: (part, level) => `يذكر هذا المستند أنه من نوع PDF/A-${part}${level}`,
  pdfaNotValidated: 'هذا ما يذكره المستند عن نفسه. وبال‌سيرت لا يتحقق من مطابقة PDF/A.',
  attachments: (count) => (count === 1 ? 'يوجد ملف مرفق واحد' : `توجد ${count} ملفات مرفقة`),
  activeContent:
    'يحتوي هذا المستند على محتوى نشط، مثل نصّ برمجي أو إجراء ارتباط. أحصاه بال‌سيرت ولم ' +
    'يفتح أيًّا منه ولم يشغّله ولم يتتبّعه.',
  pageCount: (count) => `${count} صفحة`,

  errors: {
    CHECK_STANDARD_NOT_SUPPORTED_FOR_FORMAT:
      'لا يمكن فحص أي من متطلبات هذا المعيار بصيغة هذا المستند.',
    DOCUMENT_PASSWORD_REQUIRED:
      'هذا الملف محمي بكلمة مرور، فتعذّر على بال‌سيرت فتحه. ولم يُخصم منك أي مبلغ. ارفع نسخة ' +
      'بلا كلمة مرور.',
    DOCUMENT_ENCRYPTION_UNSUPPORTED:
      'هذا الملف مشفَّر بطريقة لا يستطيع بال‌سيرت فتحها. ولم يُخصم منك أي مبلغ.',
    DOCUMENT_INVALID: 'تعذّر على بال‌سيرت قراءة هذا الملف بصيغة PDF. ولم يُخصم منك أي مبلغ.',
    DOCUMENT_TOO_COMPLEX:
      'هذا الملف أكبر أو أعقد مما يستطيع بال‌سيرت تحليله. ولم يُخصم منك أي مبلغ.',
  },
};

export const PDF_MESSAGES: Readonly<Record<Locale, PdfMessages>> = { en, ar };

export function getPdfMessages(locale: Locale): PdfMessages {
  return PDF_MESSAGES[locale] ?? PDF_MESSAGES.en;
}
