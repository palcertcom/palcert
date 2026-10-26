import type { Locale } from './locales';

/**
 * Documents and upload message catalogue (Phase 5, §82).
 *
 * Canonical API statuses (`AWAITING_UPLOAD`, `READY`, …) and rejection codes
 * never reach the screen directly: they are looked up here. Internal terms —
 * scanner names, buckets, queues — never appear in any locale (§78).
 */
export interface DocumentsMessages {
  readonly myDocuments: string;
  readonly noDocuments: string;
  readonly noDocumentsHint: string;
  readonly newDocument: string;
  readonly documentName: string;
  readonly documentNameHint: string;
  readonly create: string;
  readonly rename: string;
  readonly save: string;
  readonly cancel: string;
  readonly deleteDocument: string;
  readonly deleteConfirm: string;
  readonly deleted: string;
  readonly backToDocuments: string;
  readonly latestVersion: string;
  readonly noVersions: string;
  readonly created: string;
  readonly updated: string;
  readonly details: string;
  readonly loadingDocuments: string;
  readonly loadMore: string;

  readonly uploadTitle: string;
  readonly chooseFile: string;
  readonly chooseFileHint: string;
  readonly noFileChosen: string;
  readonly upload: string;
  readonly uploading: string;
  readonly cancelUpload: string;
  readonly uploadCancelled: string;
  readonly uploadComplete: string;
  readonly uploadProgress: (percent: number) => string;

  readonly stageUploading: string;
  readonly stageSecurityCheck: string;
  readonly stageProcessing: string;
  readonly stageReady: string;
  readonly stageRejected: string;
  readonly stageFailed: string;

  readonly versionHistory: string;
  readonly version: (number: number) => string;
  readonly size: string;
  readonly fingerprint: string;
  readonly download: string;
  readonly downloadPreparing: string;
  readonly retryProcessing: string;
  readonly retryQueued: string;
  readonly statuses: Readonly<Record<string, string>>;
  readonly rejections: Readonly<Record<string, string>>;
  readonly failedExplanation: string;
  readonly failedNotInvalid: string;
  readonly errors: Readonly<Record<string, string>>;
  readonly genericError: string;
}

const en: DocumentsMessages = {
  myDocuments: 'My documents',
  noDocuments: 'You have no documents yet.',
  noDocumentsHint:
    'Create a document, then upload a .docx or .pdf file to it. Your documents are private to you.',
  newDocument: 'New document',
  documentName: 'Document name',
  documentNameHint: 'For example: "PhD thesis — final draft". You can rename it later.',
  create: 'Create',
  rename: 'Rename',
  save: 'Save',
  cancel: 'Cancel',
  deleteDocument: 'Delete document',
  deleteConfirm: 'Delete this document and every uploaded version? This cannot be undone.',
  deleted: 'The document was deleted.',
  backToDocuments: 'Back to my documents',
  latestVersion: 'Latest version',
  noVersions: 'No file uploaded yet.',
  created: 'Created',
  updated: 'Updated',
  details: 'Details',
  loadingDocuments: 'Loading your documents…',
  loadMore: 'Show more',

  uploadTitle: 'Upload a new version',
  chooseFile: 'Choose a file',
  chooseFileHint:
    'Word (.docx) or PDF (.pdf). The file is checked for safety before it is accepted.',
  noFileChosen: 'No file chosen',
  upload: 'Upload',
  uploading: 'Uploading…',
  cancelUpload: 'Cancel upload',
  uploadCancelled: 'The upload was cancelled.',
  uploadComplete: 'Upload complete. PalCert is now checking the file.',
  uploadProgress: (percent) => `Uploading, ${percent}% complete`,

  stageUploading: 'Uploading',
  stageSecurityCheck: 'Security check',
  stageProcessing: 'Processing',
  stageReady: 'Ready',
  stageRejected: 'Not accepted',
  stageFailed: 'Could not finish',

  versionHistory: 'Version history',
  version: (number) => `Version ${number}`,
  size: 'Size',
  fingerprint: 'Fingerprint (SHA-256)',
  download: 'Download',
  downloadPreparing: 'Preparing your download…',
  retryProcessing: 'Try processing again',
  retryQueued: 'PalCert will process this file again.',
  statuses: {
    AWAITING_UPLOAD: 'Waiting for upload',
    UPLOADED: 'Uploaded',
    VALIDATING: 'Checking the file',
    SCANNING: 'Security check',
    READY: 'Ready',
    REJECTED: 'Not accepted',
    FAILED: 'Could not finish',
    UPLOAD_EXPIRED: 'Upload expired',
    CANCELLED: 'Cancelled',
  },
  rejections: {
    FILE_EXTENSION_UNSUPPORTED:
      'This file type is not supported. Please upload a .docx or .pdf file.',
    FILE_TYPE_UNSUPPORTED: 'This file type is not supported. Please upload a .docx or .pdf file.',
    FILE_TYPE_MISMATCH:
      'The file does not match its extension. Please upload the original .docx or .pdf file.',
    FILE_TOO_LARGE: 'The file is too large.',
    FILE_EMPTY: 'The file is empty.',
    FILE_CONTAINER_INVALID: 'The uploaded file does not appear to be a valid document.',
    FILE_ARCHIVE_UNSAFE: 'The file could not pass PalCert’s security checks.',
    FILE_MACRO_UNSUPPORTED:
      'This file contains unsupported macro content. Save it as a plain .docx and try again.',
    FILE_EMBEDDED_OBJECT_UNSUPPORTED:
      'This Word document contains an embedded object that PalCert cannot safely process.',
    FILE_EXTERNAL_CONTENT_UNSUPPORTED:
      'This file references external content that is not supported.',
    FILE_MALWARE_DETECTED: 'The file could not pass PalCert’s security checks.',
    FILE_CHECKSUM_MISMATCH: 'The file changed during upload. Please try again.',
  },
  failedExplanation:
    'PalCert could not finish processing this file. The document has not been accepted yet.',
  failedNotInvalid:
    'This is not a problem with your document. You can try again without uploading the file again.',
  errors: {
    DOCUMENT_NOT_FOUND: 'That document does not exist.',
    DOCUMENT_DELETED: 'That document has been deleted.',
    DOCUMENT_VERSION_NOT_FOUND: 'That version does not exist.',
    DOCUMENT_NOT_READY: 'This version has not been accepted yet, so it cannot be downloaded.',
    DOCUMENT_VERSION_NOT_RETRYABLE: 'This version cannot be retried.',
    UPLOAD_SESSION_EXPIRED: 'The upload took too long and expired. Please upload the file again.',
    UPLOAD_SESSION_CANCELLED: 'This upload was cancelled.',
    UPLOAD_ALREADY_FINALIZED: 'This upload has already been completed.',
    UPLOAD_OBJECT_NOT_FOUND: 'The file has not finished uploading yet.',
    UPLOAD_SIZE_MISMATCH: 'The uploaded file is not the one that was selected. Please try again.',
    FILE_TOO_LARGE: 'The file is too large.',
    FILE_EXTENSION_UNSUPPORTED: 'Only .docx and .pdf files can be uploaded.',
    UPLOAD_TRANSFER_FAILED: 'The upload could not be completed. Please try again.',
    UPLOAD_CANCELLED: 'The upload was cancelled.',
    STORAGE_UNAVAILABLE: 'File storage is temporarily unavailable. Please try again shortly.',
    VALIDATION_FAILED: 'Please check the highlighted fields.',
  },
  genericError: 'Something went wrong. Please try again.',
};

const ar: DocumentsMessages = {
  myDocuments: 'مستنداتي',
  noDocuments: 'لا توجد لديك مستندات بعد.',
  noDocumentsHint: 'أنشئ مستندًا ثم ارفع إليه ملف .docx أو .pdf. مستنداتك خاصة بك وحدك.',
  newDocument: 'مستند جديد',
  documentName: 'اسم المستند',
  documentNameHint: 'مثلًا: «رسالة الدكتوراه — المسودة النهائية». يمكنك تغيير الاسم لاحقًا.',
  create: 'إنشاء',
  rename: 'تغيير الاسم',
  save: 'حفظ',
  cancel: 'إلغاء',
  deleteDocument: 'حذف المستند',
  deleteConfirm: 'هل تريد حذف هذا المستند وجميع النسخ المرفوعة؟ لا يمكن التراجع عن ذلك.',
  deleted: 'تم حذف المستند.',
  backToDocuments: 'الرجوع إلى مستنداتي',
  latestVersion: 'أحدث نسخة',
  noVersions: 'لم يُرفع أي ملف بعد.',
  created: 'تاريخ الإنشاء',
  updated: 'آخر تحديث',
  details: 'التفاصيل',
  loadingDocuments: 'جارٍ تحميل مستنداتك…',
  loadMore: 'عرض المزيد',

  uploadTitle: 'رفع نسخة جديدة',
  chooseFile: 'اختر ملفًا',
  chooseFileHint: 'ملف Word (.docx) أو PDF (.pdf). يُفحص الملف للتأكد من سلامته قبل قبوله.',
  noFileChosen: 'لم يُختر أي ملف',
  upload: 'رفع',
  uploading: 'جارٍ الرفع…',
  cancelUpload: 'إلغاء الرفع',
  uploadCancelled: 'تم إلغاء الرفع.',
  uploadComplete: 'اكتمل الرفع. تفحص بال‌سيرت الملف الآن.',
  uploadProgress: (percent) => `جارٍ الرفع، اكتمل ${percent}٪`,

  stageUploading: 'الرفع',
  stageSecurityCheck: 'الفحص الأمني',
  stageProcessing: 'المعالجة',
  stageReady: 'جاهز',
  stageRejected: 'غير مقبول',
  stageFailed: 'لم تكتمل المعالجة',

  versionHistory: 'سجل النسخ',
  version: (number) => `النسخة ${number}`,
  size: 'الحجم',
  fingerprint: 'البصمة (SHA-256)',
  download: 'تنزيل',
  downloadPreparing: 'جارٍ تجهيز التنزيل…',
  retryProcessing: 'إعادة المعالجة',
  retryQueued: 'ستعالج بال‌سيرت هذا الملف مرة أخرى.',
  statuses: {
    AWAITING_UPLOAD: 'بانتظار الرفع',
    UPLOADED: 'تم الرفع',
    VALIDATING: 'جارٍ فحص الملف',
    SCANNING: 'الفحص الأمني',
    READY: 'جاهز',
    REJECTED: 'غير مقبول',
    FAILED: 'لم تكتمل المعالجة',
    UPLOAD_EXPIRED: 'انتهت صلاحية الرفع',
    CANCELLED: 'أُلغي',
  },
  rejections: {
    FILE_EXTENSION_UNSUPPORTED: 'نوع الملف غير مدعوم. يُرجى رفع ملف .docx أو .pdf.',
    FILE_TYPE_UNSUPPORTED: 'نوع الملف غير مدعوم. يُرجى رفع ملف .docx أو .pdf.',
    FILE_TYPE_MISMATCH: 'محتوى الملف لا يطابق امتداده. يُرجى رفع ملف .docx أو .pdf الأصلي.',
    FILE_TOO_LARGE: 'حجم الملف كبير جدًا.',
    FILE_EMPTY: 'الملف فارغ.',
    FILE_CONTAINER_INVALID: 'لا يبدو أن الملف المرفوع مستند صالح.',
    FILE_ARCHIVE_UNSAFE: 'لم يجتز الملف فحوصات الأمان في بال‌سيرت.',
    FILE_MACRO_UNSUPPORTED:
      'يحتوي هذا الملف على وحدات ماكرو غير مدعومة. احفظه بصيغة .docx عادية وحاول مجددًا.',
    FILE_EMBEDDED_OBJECT_UNSUPPORTED:
      'يحتوي مستند Word على عنصر مضمّن لا يستطيع PalCert معالجته بأمان.',
    FILE_EXTERNAL_CONTENT_UNSUPPORTED: 'يشير هذا الملف إلى محتوى خارجي غير مدعوم.',
    FILE_MALWARE_DETECTED: 'لم يجتز الملف فحوصات الأمان في بال‌سيرت.',
    FILE_CHECKSUM_MISMATCH: 'تغيّر الملف أثناء الرفع. يُرجى المحاولة مرة أخرى.',
  },
  failedExplanation: 'لم تتمكن بال‌سيرت من إتمام معالجة هذا الملف. لم يُقبل المستند بعد.',
  failedNotInvalid: 'المشكلة ليست في مستندك. يمكنك المحاولة مجددًا دون إعادة رفع الملف.',
  errors: {
    DOCUMENT_NOT_FOUND: 'هذا المستند غير موجود.',
    DOCUMENT_DELETED: 'تم حذف هذا المستند.',
    DOCUMENT_VERSION_NOT_FOUND: 'هذه النسخة غير موجودة.',
    DOCUMENT_NOT_READY: 'لم تُقبل هذه النسخة بعد، لذا لا يمكن تنزيلها.',
    DOCUMENT_VERSION_NOT_RETRYABLE: 'لا يمكن إعادة معالجة هذه النسخة.',
    UPLOAD_SESSION_EXPIRED: 'استغرق الرفع وقتًا طويلًا وانتهت صلاحيته. يُرجى رفع الملف مجددًا.',
    UPLOAD_SESSION_CANCELLED: 'أُلغي هذا الرفع.',
    UPLOAD_ALREADY_FINALIZED: 'اكتمل هذا الرفع من قبل.',
    UPLOAD_OBJECT_NOT_FOUND: 'لم ينتهِ رفع الملف بعد.',
    UPLOAD_SIZE_MISMATCH: 'الملف المرفوع ليس الملف الذي تم اختياره. يُرجى المحاولة مجددًا.',
    FILE_TOO_LARGE: 'حجم الملف كبير جدًا.',
    FILE_EXTENSION_UNSUPPORTED: 'يمكن رفع ملفات .docx و.pdf فقط.',
    UPLOAD_TRANSFER_FAILED: 'لم يكتمل الرفع. يُرجى المحاولة مجددًا.',
    UPLOAD_CANCELLED: 'تم إلغاء الرفع.',
    STORAGE_UNAVAILABLE: 'تخزين الملفات غير متاح مؤقتًا. يُرجى المحاولة بعد قليل.',
    VALIDATION_FAILED: 'يُرجى مراجعة الحقول المحددة.',
  },
  genericError: 'حدث خطأ ما. يُرجى المحاولة مجددًا.',
};

export const DOCUMENTS_MESSAGES: Record<Locale, DocumentsMessages> = { en, ar };

export function getDocumentsMessages(locale: Locale): DocumentsMessages {
  return DOCUMENTS_MESSAGES[locale] ?? DOCUMENTS_MESSAGES.en;
}

/** Which of the four user-facing stages a canonical status belongs to (§78). */
export type UploadStage =
  'UPLOADING' | 'SECURITY_CHECK' | 'PROCESSING' | 'READY' | 'REJECTED' | 'FAILED';

export function stageForStatus(status: string): UploadStage {
  switch (status) {
    case 'AWAITING_UPLOAD':
      return 'UPLOADING';
    case 'UPLOADED':
    case 'VALIDATING':
      return 'PROCESSING';
    case 'SCANNING':
      return 'SECURITY_CHECK';
    case 'READY':
      return 'READY';
    case 'REJECTED':
      return 'REJECTED';
    default:
      return 'FAILED';
  }
}
