import type { Locale } from './locales';

/**
 * What a person reads about a PalCert certificate (§109–§115).
 *
 * The wording rules are stricter here than anywhere else in the product,
 * because a certificate is read by strangers who will take its sentences
 * literally and repeat them.
 *
 * **Never claim more than PalCert did.** "Valid PalCert Technical Compliance
 * Certificate" — not "this degree is valid", not "this research is sound".
 * PalCert measured a document against a published standard and an institution
 * recorded a decision; that is the whole claim.
 *
 * **Keep the two authorities in separate words, in both languages.** Arabic
 * uses نتيجة الامتثال التقني for PalCert's measurement and قرار المؤسسة for
 * the institution's decision. One generic word for both would erase in
 * translation the distinction the architecture exists to preserve (§114).
 *
 * **Say revoked loudly.** A holder showing an old PDF needs the page to say so
 * without ambiguity, in colour-independent language (§111, §112).
 */
export interface CertificatesMessages {
  readonly title: string;
  readonly listTitle: string;
  readonly statusLabel: string;
  readonly history: string;
  readonly backToCertificates: string;
  readonly loading: string;
  readonly certificateNumber: string;
  readonly verifyTitle: string;
  readonly verifyIntro: string;
  readonly verifyPlaceholder: string;
  readonly verifyAction: string;
  readonly verifying: string;

  readonly statuses: Readonly<Record<string, string>>;
  readonly statusHints: Readonly<Record<string, string>>;

  readonly technicalResult: string;
  readonly institutionDecision: string;
  readonly compliant: string;
  readonly approved: string;
  readonly authorityNote: string;

  readonly organization: string;
  readonly documentType: string;
  readonly documentFormat: string;
  readonly standard: string;
  readonly issued: string;
  readonly validUntil: string;
  readonly noExpiry: string;
  readonly revokedAt: string;
  readonly revocationReason: string;

  readonly hashes: string;
  readonly documentHash: string;
  readonly reportHash: string;
  readonly standardHash: string;
  readonly evidenceHash: string;
  readonly claimHash: string;
  readonly artifactHash: string;
  readonly copy: string;
  readonly copied: string;
  readonly hashesHint: string;

  readonly download: string;
  readonly copyLink: string;
  readonly qrAlt: string;

  readonly issuanceStatuses: Readonly<Record<string, string>>;
  readonly ineligible: Readonly<Record<string, string>>;
  readonly reasons: Readonly<Record<string, string>>;

  readonly revoke: string;
  readonly revoking: string;
  readonly revokeHint: string;
  readonly revokeReasonLabel: string;
  readonly revokeCommentLabel: string;
  readonly revokeCommentHint: string;

  readonly notFound: string;
  readonly genericError: string;
  readonly errors: Readonly<Record<string, string>>;

  /** The organization's register of the certificates its approvals produced. */
  readonly register: {
    readonly title: string;
    readonly intro: string;
    readonly holder: string;
    readonly holderUnknown: string;
    readonly submission: string;
    readonly openSubmission: string;
    readonly view: string;
    readonly numberPending: string;
    readonly searchLabel: string;
    readonly searchHint: string;
    readonly search: string;
    readonly clearSearch: string;
    readonly filterLabel: string;
    readonly filterAll: string;
    readonly filters: Readonly<Record<string, string>>;
    readonly emptyTitle: string;
    readonly emptyHint: string;
    readonly noMatches: string;
    readonly loadMore: string;
  };
}

const en: CertificatesMessages = {
  title: 'Certificate',
  listTitle: 'Certificates',
  statusLabel: 'Status',
  history: 'History',
  backToCertificates: 'Back to certificates',
  loading: 'Loading certificates…',
  certificateNumber: 'Certificate number',
  verifyTitle: 'Verify a PalCert certificate',
  verifyIntro:
    'Enter the certificate number printed on the certificate, or scan its QR code. PalCert ' +
    'publishes no directory of certificates and cannot be searched by name.',
  verifyPlaceholder: 'PC-XXXXXXXX-XXXXXXXX-XXXXXXXX-XXXXXXXX',
  verifyAction: 'Verify certificate',
  verifying: 'Verifying…',

  statuses: {
    VALID: 'Valid PalCert Technical Compliance Certificate',
    REVOKED: 'This PalCert certificate has been revoked.',
    EXPIRED: 'This PalCert certificate has expired.',
  },
  statusHints: {
    VALID:
      'PalCert confirms the technical compliance result and the institution decision recorded ' +
      'below for this exact submission.',
    REVOKED:
      'It is no longer valid. The technical result and the institution decision it was based ' +
      'on are unchanged; the certificate itself was withdrawn.',
    EXPIRED: 'Its validity period has ended.',
  },

  technicalResult: 'PalCert technical result',
  institutionDecision: 'Institution decision',
  compliant: 'Compliant',
  approved: 'Approved',
  authorityNote:
    'PalCert measures a document against a published standard. The institution decides ' +
    'separately whether to accept the submission. This certificate records that both happened.',

  organization: 'Organization',
  documentType: 'Document type',
  documentFormat: 'Format',
  standard: 'Standard',
  issued: 'Issued',
  validUntil: 'Valid until',
  noExpiry: 'No expiry',
  revokedAt: 'Revoked',
  revocationReason: 'Reason',

  hashes: 'Integrity',
  documentHash: 'Document SHA-256',
  reportHash: 'Report hash',
  standardHash: 'Standard content hash',
  evidenceHash: 'Submission evidence hash',
  claimHash: 'Certificate claim hash',
  artifactHash: 'Certificate PDF SHA-256',
  copy: 'Copy',
  copied: 'Copied',
  hashesHint:
    'If you hold the document or the certificate PDF, you can hash it yourself and compare.',

  download: 'Download certificate',
  copyLink: 'Copy verification link',
  qrAlt: 'QR code linking to this certificate’s verification page',

  issuanceStatuses: {
    PENDING: 'Certificate is being prepared',
    ISSUED: 'Certificate issued',
    FAILED_RETRYABLE: 'Certificate is being prepared',
    FAILED_PERMANENT: 'Certificate could not be issued',
    REVOKED: 'Certificate revoked',
  },
  ineligible: {
    AWAITING_INSTITUTION_DECISION:
      'A certificate requires an institution decision of Approved. This submission is still ' +
      'with the institution.',
    NOT_APPROVED: 'A certificate requires an institution decision of Approved.',
    NOT_COMPLIANT: 'A certificate requires a PalCert technical result of Compliant.',
    SUPERSEDED_REVISION: 'A newer revision of this submission has replaced this one.',
    NOT_HANDED_OVER: 'This submission has not been handed over yet.',
  },
  reasons: {
    ISSUED_IN_ERROR: 'Issued in error',
    EVIDENCE_INTEGRITY_FAILURE: 'Evidence integrity failure',
    ADMINISTRATIVE_CORRECTION: 'Administrative correction',
    SECURITY_INCIDENT: 'Security incident',
    OTHER: 'Other',
  },

  revoke: 'Revoke certificate',
  revoking: 'Revoking…',
  revokeHint:
    'The certificate stops being valid. The technical result, the institution decision and the ' +
    'issued PDF are unchanged, and verification will report it as revoked. This cannot be undone.',
  revokeReasonLabel: 'Reason',
  revokeCommentLabel: 'Private note',
  revokeCommentHint: 'Recorded for your organization. Never shown publicly.',

  notFound: 'No certificate matches that verification code.',
  genericError: 'Something went wrong. Please try again.',
  errors: {
    CERTIFICATE_NOT_FOUND: 'No certificate matches that verification code.',
    CERTIFICATE_NOT_ISSUED: 'This certificate is still being prepared.',
    CERTIFICATE_ALREADY_REVOKED: 'This certificate has already been revoked.',
    CERTIFICATE_NOT_ELIGIBLE: 'This submission is not eligible for a certificate.',
    RATE_LIMITED: 'Too many verification attempts. Please wait and try again.',
  },

  register: {
    title: 'Issued certificates',
    intro:
      'Certificates your organization’s approvals produced. PalCert issues each one when a ' +
      'compliant submission is approved; revoking is done from the certificate itself.',
    holder: 'Holder',
    holderUnknown: 'Account no longer available',
    submission: 'Submission',
    openSubmission: 'Open submission',
    view: 'View certificate',
    numberPending: 'Not issued yet',
    searchLabel: 'Search certificates',
    searchHint: 'A certificate number, a standard code or name, or a document type.',
    search: 'Search',
    clearSearch: 'Clear',
    filterLabel: 'Certificate status',
    filterAll: 'All',
    filters: {
      ISSUED: 'Issued',
      REVOKED: 'Revoked',
      IN_PREPARATION: 'Being prepared',
      FAILED: 'Could not be issued',
    },
    emptyTitle: 'No certificates yet',
    emptyHint:
      'A certificate appears here after your organization approves a submission that PalCert ' +
      'found compliant.',
    noMatches: 'No certificates match this search.',
    loadMore: 'Show more',
  },
};

const ar: CertificatesMessages = {
  title: 'الشهادة',
  listTitle: 'الشهادات',
  statusLabel: 'الحالة',
  history: 'السجل',
  backToCertificates: 'العودة إلى الشهادات',
  loading: 'جارٍ تحميل الشهادات…',
  certificateNumber: 'رقم الشهادة',
  verifyTitle: 'التحقق من شهادة بال‌سيرت',
  verifyIntro:
    'أدخل رقم الشهادة المطبوع عليها، أو امسح رمز الاستجابة السريعة. لا ينشر بال‌سيرت أي دليل ' +
    'للشهادات، ولا يمكن البحث فيه بالاسم.',
  verifyPlaceholder: 'PC-XXXXXXXX-XXXXXXXX-XXXXXXXX-XXXXXXXX',
  verifyAction: 'تحقق من الشهادة',
  verifying: 'جارٍ التحقق…',

  statuses: {
    VALID: 'شهادة امتثال تقني سارية من بال‌سيرت',
    REVOKED: 'أُلغيت هذه الشهادة من بال‌سيرت.',
    EXPIRED: 'انتهت صلاحية هذه الشهادة من بال‌سيرت.',
  },
  statusHints: {
    VALID: 'يؤكد بال‌سيرت نتيجة الامتثال التقني وقرار المؤسسة المسجَّلين أدناه لهذا التقديم بعينه.',
    REVOKED:
      'لم تعد سارية. ونتيجة الامتثال التقني وقرار المؤسسة اللذان بُنيت عليهما لم يتغيّرا؛ ' +
      'الشهادة وحدها هي التي أُلغيت.',
    EXPIRED: 'انتهت مدة سريانها.',
  },

  technicalResult: 'نتيجة الامتثال التقني من بال‌سيرت',
  institutionDecision: 'قرار المؤسسة',
  compliant: 'مطابق',
  approved: 'مقبول',
  authorityNote:
    'يقيس بال‌سيرت المستند وفق معيار منشور. وتقرر المؤسسة على حدة قبول التقديم من عدمه. وتسجّل ' +
    'هذه الشهادة أن كلا الأمرين حدث.',

  organization: 'الجهة',
  documentType: 'نوع المستند',
  documentFormat: 'الصيغة',
  standard: 'المعيار',
  issued: 'تاريخ الإصدار',
  validUntil: 'سارية حتى',
  noExpiry: 'بلا تاريخ انتهاء',
  revokedAt: 'تاريخ الإلغاء',
  revocationReason: 'السبب',

  hashes: 'السلامة',
  documentHash: 'بصمة المستند SHA-256',
  reportHash: 'بصمة التقرير',
  standardHash: 'بصمة محتوى المعيار',
  evidenceHash: 'بصمة أدلة التقديم',
  claimHash: 'بصمة بيان الشهادة',
  artifactHash: 'بصمة ملف الشهادة SHA-256',
  copy: 'نسخ',
  copied: 'تم النسخ',
  hashesHint: 'إن كان لديك المستند أو ملف الشهادة، يمكنك حساب بصمته بنفسك ومقارنتها.',

  download: 'تنزيل الشهادة',
  copyLink: 'نسخ رابط التحقق',
  qrAlt: 'رمز استجابة سريعة يحيل إلى صفحة التحقق من هذه الشهادة',

  issuanceStatuses: {
    PENDING: 'يجري تجهيز الشهادة',
    ISSUED: 'صدرت الشهادة',
    FAILED_RETRYABLE: 'يجري تجهيز الشهادة',
    FAILED_PERMANENT: 'تعذّر إصدار الشهادة',
    REVOKED: 'أُلغيت الشهادة',
  },
  ineligible: {
    AWAITING_INSTITUTION_DECISION:
      'تتطلب الشهادة قرار مؤسسة «مقبول». ولا يزال هذا التقديم لدى الجهة.',
    NOT_APPROVED: 'تتطلب الشهادة قرار مؤسسة «مقبول».',
    NOT_COMPLIANT: 'تتطلب الشهادة نتيجة امتثال تقني «مطابق» من بال‌سيرت.',
    SUPERSEDED_REVISION: 'حلّت مراجعة أحدث من هذا التقديم محل هذه المراجعة.',
    NOT_HANDED_OVER: 'لم يُسلَّم هذا التقديم بعد.',
  },
  reasons: {
    ISSUED_IN_ERROR: 'صدرت بالخطأ',
    EVIDENCE_INTEGRITY_FAILURE: 'خلل في سلامة الأدلة',
    ADMINISTRATIVE_CORRECTION: 'تصحيح إداري',
    SECURITY_INCIDENT: 'حادث أمني',
    OTHER: 'أخرى',
  },

  revoke: 'إلغاء الشهادة',
  revoking: 'جارٍ الإلغاء…',
  revokeHint:
    'تتوقف الشهادة عن السريان. ولا تتغيّر النتيجة التقنية ولا قرار المؤسسة ولا ملف الشهادة ' +
    'الصادر، وسيُظهر التحقق أنها ملغاة. ولا يمكن التراجع عن ذلك.',
  revokeReasonLabel: 'السبب',
  revokeCommentLabel: 'ملاحظة خاصة',
  revokeCommentHint: 'تُسجَّل لجهتكم فقط، ولا تُعرض للعموم أبدًا.',

  notFound: 'لا توجد شهادة تطابق رمز التحقق هذا.',
  genericError: 'حدث خطأ ما. يرجى المحاولة مرة أخرى.',
  errors: {
    CERTIFICATE_NOT_FOUND: 'لا توجد شهادة تطابق رمز التحقق هذا.',
    CERTIFICATE_NOT_ISSUED: 'لا تزال هذه الشهادة قيد التجهيز.',
    CERTIFICATE_ALREADY_REVOKED: 'سبق أن أُلغيت هذه الشهادة.',
    CERTIFICATE_NOT_ELIGIBLE: 'هذا التقديم غير مؤهل للحصول على شهادة.',
    RATE_LIMITED: 'محاولات تحقق كثيرة. يرجى الانتظار ثم المحاولة مجددًا.',
  },

  register: {
    title: 'الشهادات الصادرة',
    intro:
      'الشهادات الصادرة بناءً على موافقات جهتكم. تُصدر بال‌سيرت كل شهادة عند الموافقة على تقديم ' +
      'مطابق، ويتم الإلغاء من صفحة الشهادة نفسها.',
    holder: 'صاحب الشهادة',
    holderUnknown: 'الحساب لم يعد متاحًا',
    submission: 'التقديم',
    openSubmission: 'فتح التقديم',
    view: 'عرض الشهادة',
    numberPending: 'لم تصدر بعد',
    searchLabel: 'البحث في الشهادات',
    searchHint: 'رقم شهادة، أو رمز معيار أو اسمه، أو نوع مستند.',
    search: 'بحث',
    clearSearch: 'مسح',
    filterLabel: 'حالة الشهادة',
    filterAll: 'الكل',
    filters: {
      ISSUED: 'صادرة',
      REVOKED: 'ملغاة',
      IN_PREPARATION: 'قيد التجهيز',
      FAILED: 'تعذّر إصدارها',
    },
    emptyTitle: 'لا توجد شهادات بعد',
    emptyHint: 'تظهر الشهادة هنا بعد أن توافق جهتكم على تقديم وجدته بال‌سيرت مطابقًا.',
    noMatches: 'لا توجد شهادات تطابق هذا البحث.',
    loadMore: 'عرض المزيد',
  },
};

export const CERTIFICATES_MESSAGES: Readonly<Record<Locale, CertificatesMessages>> = { en, ar };

export function getCertificatesMessages(locale: Locale): CertificatesMessages {
  return CERTIFICATES_MESSAGES[locale] ?? CERTIFICATES_MESSAGES.en;
}
