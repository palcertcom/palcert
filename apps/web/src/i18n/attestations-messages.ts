import type { Locale } from './locales';

/**
 * Certificate attestation, in words (EN/AR).
 *
 * Wording rules, stricter than elsewhere because strangers read the public
 * page and repeat its sentences:
 *
 * **The institution attests; PalCert records.** An attestation says that a
 * named institution confirmed a file a user submitted. It never says PalCert
 * issued that certificate, and every page that shows one carries the
 * disclaimer below, in both languages.
 *
 * **Say the exact file.** What is attested is these bytes, identified by
 * their SHA-256. A different scan of the same paper is a different file.
 *
 * **Money is stated, never implied.** The user sees the fee and whether it is
 * held, charged or returned; only the institution and PalCert finance see the
 * split.
 */
export interface AttestationsMessages {
  readonly disclaimer: string;

  readonly nav: {
    readonly mine: string;
    readonly queue: string;
    readonly types: string;
    readonly revenue: string;
    readonly adminFinance: string;
  };

  readonly statuses: Readonly<Record<string, string>>;
  readonly verificationStatuses: Readonly<Record<string, string>>;
  readonly verificationHints: Readonly<Record<string, string>>;
  readonly paymentStatuses: Readonly<Record<string, string>>;
  readonly artifactStatuses: Readonly<Record<string, string>>;
  readonly eventTypes: Readonly<Record<string, string>>;
  readonly fields: Readonly<Record<string, string>>;
  readonly rejections: Readonly<Record<string, string>>;
  readonly errors: Readonly<Record<string, string>>;
  readonly genericError: string;
  readonly loading: string;
  readonly optional: string;
  readonly required: string;
  readonly cancel: string;
  readonly close: string;
  readonly save: string;
  readonly saving: string;
  readonly copy: string;
  readonly copied: string;
  readonly loadMore: string;
  readonly noExpiry: string;
  readonly none: string;

  readonly mine: {
    readonly title: string;
    readonly intro: string;
    readonly newRequest: string;
    readonly emptyTitle: string;
    readonly emptyHint: string;
    readonly summary: Readonly<
      Record<
        'valid' | 'expiringSoon' | 'pendingReview' | 'needsInformation' | 'expired' | 'rejected',
        string
      >
    >;
    readonly institution: string;
    readonly type: string;
    readonly certificate: string;
    readonly status: string;
    readonly validity: string;
    readonly fee: string;
    readonly updated: string;
    readonly open: string;
    readonly filterLabel: string;
    readonly filterAll: string;
  };

  readonly wizard: {
    readonly title: string;
    readonly intro: string;
    readonly renewalOf: (reference: string) => string;
    readonly steps: readonly string[];
    readonly stepOf: (current: number, total: number) => string;
    readonly stepStates: {
      readonly done: string;
      readonly current: string;
      readonly upcoming: string;
    };
    readonly next: string;
    readonly back: string;
    readonly chooseInstitution: string;
    readonly institutionHint: string;
    readonly noInstitutions: string;
    readonly verifiedInstitution: string;
    readonly chooseType: string;
    readonly noTypes: string;
    readonly defaultValidity: (days: number) => string;
    readonly instructions: string;
    readonly acceptedFormats: (formats: string, maxMb: string) => string;
    readonly chooseFile: string;
    readonly fileHint: string;
    readonly upload: string;
    readonly uploading: (percent: number) => string;
    readonly checking: string;
    readonly fileReady: string;
    readonly replaceFile: string;
    readonly fingerprint: string;
    readonly detailsIntro: string;
    readonly notesForReviewer: string;
    readonly notesHint: string;
    readonly review: string;
    readonly feeLabel: string;
    readonly balanceLabel: string;
    readonly afterSubmit: string;
    readonly insufficient: (shortfall: string) => string;
    readonly topUp: string;
    readonly freeOfCharge: string;
    readonly reserveNote: string;
    readonly refundPolicy: string;
    readonly submit: string;
    readonly submitting: string;
    readonly saveDraft: string;
    readonly draftSaved: string;
    readonly createDraft: string;
  };

  readonly details: {
    readonly backToList: string;
    readonly requestTitle: string;
    readonly submittedDetails: string;
    readonly confirmedDetails: string;
    readonly confirmedHint: string;
    readonly file: string;
    readonly downloadMine: string;
    readonly history: string;
    readonly institutionAsked: string;
    readonly respond: string;
    readonly respondTitle: string;
    readonly respondIntro: string;
    readonly responseLabel: string;
    readonly send: string;
    readonly cancelRequest: string;
    readonly cancelTitle: string;
    readonly cancelIntro: string;
    readonly submitDraft: string;
    readonly continueDraft: string;
    readonly rejectedBecause: string;
    readonly renew: string;
    readonly receipt: string;
    readonly receiptTitle: string;
    readonly paidAt: string;
    readonly transaction: string;
    readonly attestation: string;
    readonly reference: string;
    readonly validFrom: string;
    readonly validUntil: string;
    readonly approvedAt: string;
    readonly revokedAt: string;
    readonly revocationReason: string;
    readonly institutionNote: string;
    readonly verificationLink: string;
    readonly openPublicPage: string;
    readonly qrCode: string;
    readonly qrAlt: string;
    readonly downloadPng: string;
    readonly downloadSvg: string;
    readonly artifactHash: string;
    readonly attestationHash: string;
    readonly hashHint: string;
  };

  readonly queue: {
    readonly title: string;
    readonly intro: string;
    readonly tabs: Readonly<Record<string, string>>;
    readonly searchLabel: string;
    readonly searchHint: string;
    readonly search: string;
    readonly typeFilter: string;
    readonly allTypes: string;
    readonly sortLabel: string;
    readonly sorts: Readonly<Record<string, string>>;
    readonly applicant: string;
    readonly certificate: string;
    readonly type: string;
    readonly submitted: string;
    readonly reviewer: string;
    readonly unassigned: string;
    readonly fee: string;
    readonly status: string;
    readonly duplicate: string;
    readonly duplicateHint: string;
    readonly emptyTitle: string;
    readonly emptyHint: string;
    readonly dashboard: Readonly<
      Record<
        | 'pendingReview'
        | 'needsAttention'
        | 'approvedThisMonth'
        | 'rejectedThisMonth'
        | 'expiringSoon'
        | 'revenueThisMonth',
        string
      >
    >;
    readonly manageTypes: string;
    readonly revenue: string;
  };

  readonly review: {
    readonly backToQueue: string;
    readonly applicant: string;
    readonly submittedFile: string;
    readonly viewFile: string;
    readonly downloadFile: string;
    readonly fileViewNote: string;
    readonly sameFile: string;
    readonly sameFileHint: string;
    readonly feeSnapshot: string;
    readonly gross: string;
    readonly platformFee: string;
    readonly institutionNet: string;
    readonly commission: string;
    readonly startReview: string;
    readonly assignToMe: string;
    readonly assignedTo: string;
    readonly requestInformation: string;
    readonly requestInformationTitle: string;
    readonly requestInformationIntro: string;
    readonly question: string;
    readonly reject: string;
    readonly rejectTitle: string;
    readonly rejectIntro: string;
    readonly rejectReason: string;
    readonly rejectReasonHint: string;
    readonly approve: string;
    readonly approveTitle: string;
    readonly approveIntro: string;
    readonly holderName: string;
    readonly showHolderName: string;
    readonly showReference: string;
    readonly validFrom: string;
    readonly validityMode: string;
    readonly validityDays: string;
    readonly validityUntil: string;
    readonly validityNone: string;
    readonly validityDaysLabel: string;
    readonly validUntilLabel: string;
    readonly institutionNote: string;
    readonly institutionNoteHint: string;
    readonly confirmLabel: string;
    readonly approving: string;
    readonly revoke: string;
    readonly revokeTitle: string;
    readonly revokeIntro: string;
    readonly revokeReason: string;
    readonly noRefundNote: string;
  };

  readonly types: {
    readonly title: string;
    readonly intro: string;
    readonly newType: string;
    readonly editType: string;
    readonly emptyTitle: string;
    readonly emptyHint: string;
    readonly nameEn: string;
    readonly nameAr: string;
    readonly descriptionEn: string;
    readonly descriptionAr: string;
    readonly instructionsEn: string;
    readonly instructionsAr: string;
    readonly enabled: string;
    readonly disabled: string;
    readonly currency: string;
    readonly fee: string;
    readonly feeHint: string;
    readonly defaultValidityDays: string;
    readonly defaultValidityHint: string;
    readonly allowNoExpiry: string;
    readonly reviewerMayOverride: string;
    readonly requiredFields: string;
    readonly allowedFormats: string;
    readonly maxFileMb: string;
    readonly reminderDays: string;
    readonly reminderHint: string;
    readonly created: string;
    readonly saved: string;
    readonly feeChangeNote: string;
  };

  readonly revenue: {
    readonly title: string;
    readonly intro: string;
    readonly from: string;
    readonly to: string;
    readonly apply: string;
    readonly totals: string;
    readonly gross: string;
    readonly platformFee: string;
    readonly institutionNet: string;
    readonly pending: string;
    readonly settled: string;
    readonly released: string;
    readonly lines: string;
    readonly reference: string;
    readonly applicant: string;
    readonly type: string;
    readonly payment: string;
    readonly commission: string;
    readonly settledAt: string;
    readonly transaction: string;
    readonly emptyTitle: string;
    readonly emptyHint: string;
  };

  readonly admin: {
    readonly financeTitle: string;
    readonly financeIntro: string;
    readonly requests: string;
    readonly approvals: string;
    readonly rejections: string;
    readonly valid: string;
    readonly expired: string;
    readonly revoked: string;
    readonly byCurrency: string;
    readonly organization: string;
    readonly currentCommission: string;
    readonly gross: string;
    readonly platformRevenue: string;
    readonly institutionNet: string;
    readonly pending: string;
    readonly manageCommission: string;
    readonly commissionTitle: string;
    readonly commissionIntro: string;
    readonly current: string;
    readonly defaultRate: string;
    readonly effectiveFrom: string;
    readonly newRate: string;
    readonly percent: string;
    readonly percentHint: string;
    readonly reason: string;
    readonly reasonHint: string;
    readonly effectiveFromHint: string;
    readonly setRate: string;
    readonly history: string;
    readonly changedBy: string;
    readonly changedAt: string;
    readonly percentInvalid: string;
    readonly emptyTitle: string;
  };

  readonly public: {
    readonly title: string;
    readonly verifiedBy: string;
    readonly attestedBy: string;
    readonly institutionVerified: string;
    readonly institutionUnverified: string;
    readonly type: string;
    readonly certificate: string;
    readonly holder: string;
    readonly issuer: string;
    readonly issueDate: string;
    readonly referenceNumber: string;
    readonly reference: string;
    readonly validFrom: string;
    readonly validUntil: string;
    readonly attestedAt: string;
    readonly revokedAt: string;
    readonly fileFormat: string;
    readonly artifactHash: string;
    readonly attestationHash: string;
    readonly notFound: string;
    readonly noFileHere: string;
    readonly checkFileTitle: string;
    readonly checkFileIntro: string;
    readonly chooseFile: string;
    readonly checking: string;
    readonly fileMatchesOther: string;
    readonly computedHash: string;
    /** The question the validity block answers, asked plainly above it. */
    readonly validityQuestion: string;
    readonly validityTitles: Readonly<Record<string, string>>;
    readonly validityExplanations: Readonly<Record<string, string>>;
    /** Short badge words for the public page. */
    readonly validityBadges: Readonly<Record<string, string>>;
    readonly expiredOn: string;
    readonly revokedOn: string;
    readonly attestedDocument: string;
    readonly protectedDocument: string;
    readonly documentType: string;
    readonly fingerprint: string;
    readonly fileTypes: Readonly<Record<string, string>>;
    readonly otherFileType: string;
    /** The question the comparison answers, kept apart from validity. */
    readonly comparisonQuestion: string;
    readonly fileYouSelected: string;
    readonly noFileSelected: string;
    readonly staysLocal: string;
    readonly fileName: string;
    readonly fileSize: string;
    readonly imagePreviewAlt: string;
    readonly pdfNotEmbedded: string;
    readonly openLocalPreview: string;
    readonly noPreview: string;
    readonly matchTitle: string;
    readonly matchText: string;
    readonly mismatchTitle: string;
    readonly mismatchText: string;
    readonly mismatchHint: string;
    readonly detailsTitle: string;
    readonly technicalDetails: string;
  };
}

const en: AttestationsMessages = {
  disclaimer:
    'PalCert attests a submitted artifact. It does not imply PalCert originally issued that ' +
    'external certificate.',

  nav: {
    mine: 'Attestations',
    queue: 'Attestation requests',
    types: 'Attestation types',
    revenue: 'Attestation revenue',
    adminFinance: 'Attestation finance',
  },

  statuses: {
    DRAFT: 'Draft',
    SUBMITTED: 'Submitted',
    IN_REVIEW: 'In review',
    NEEDS_INFORMATION: 'Awaiting information',
    APPROVED: 'Approved',
    REJECTED: 'Rejected',
    CANCELLED: 'Cancelled',
  },
  verificationStatuses: {
    VALID: 'Valid',
    EXPIRED: 'Expired',
    REVOKED: 'Revoked',
  },
  verificationHints: {
    VALID: 'The institution named below attested this exact file, and the attestation is in force.',
    EXPIRED: 'The attestation’s validity period has ended. It was valid until the date shown.',
    REVOKED: 'The institution withdrew this attestation. It is no longer valid.',
  },
  paymentStatuses: {
    NOT_REQUIRED: 'No fee',
    UNPAID: 'Not yet reserved',
    RESERVED: 'Reserved from your balance',
    SETTLED: 'Charged',
    RELEASED: 'Returned to your balance',
  },
  artifactStatuses: {
    AWAITING_UPLOAD: 'Waiting for the file',
    UPLOADED: 'Uploaded',
    VALIDATING: 'Checking the file',
    SCANNING: 'Security check',
    READY: 'Ready',
    REJECTED: 'Not accepted',
    FAILED: 'Could not be checked',
    UPLOAD_EXPIRED: 'Upload expired',
    CANCELLED: 'Replaced',
  },
  eventTypes: {
    CREATED: 'Draft created',
    SUBMITTED: 'Submitted to the institution',
    REVIEW_STARTED: 'Review started',
    ASSIGNED: 'Reviewer assigned',
    INFORMATION_REQUESTED: 'The institution asked for more information',
    INFORMATION_PROVIDED: 'Information provided',
    APPROVED: 'Approved',
    REJECTED: 'Rejected',
    CANCELLED: 'Cancelled',
    REVOKED: 'Attestation revoked',
    PAYMENT_RESERVED: 'Fee reserved',
    PAYMENT_SETTLED: 'Fee charged',
    PAYMENT_RELEASED: 'Fee returned',
  },
  fields: {
    certificateTitle: 'Certificate title',
    certificateType: 'Certificate type',
    issuingOrganization: 'Issued by',
    issueDate: 'Issue date',
    referenceNumber: 'Certificate number',
    recipientName: 'Name on the certificate',
    description: 'Description',
  },
  rejections: {
    FILE_EXTENSION_UNSUPPORTED:
      'This file type is not accepted. Upload a PDF, PNG, JPEG or WebP file.',
    FILE_TYPE_UNSUPPORTED: 'This file type is not accepted. Upload a PDF, PNG, JPEG or WebP file.',
    FILE_TYPE_MISMATCH: 'The file’s contents do not match its name. Upload the original file.',
    FILE_TOO_LARGE: 'The file is larger than this institution accepts.',
    FILE_EMPTY: 'The file is empty.',
    FILE_CONTAINER_INVALID: 'The file could not be opened as a PDF or an image.',
    FILE_ARCHIVE_UNSAFE: 'The file could not pass PalCert’s security checks.',
    FILE_MALWARE_DETECTED: 'The file could not pass PalCert’s security checks.',
    FILE_CHECKSUM_MISMATCH: 'The file changed during upload. Upload it again.',
  },
  errors: {
    INSUFFICIENT_BALANCE: 'Your balance is not enough for this fee. Top up, then submit again.',
    ATTESTATION_TYPE_NOT_FOUND: 'That attestation type is not available.',
    ATTESTATION_TYPE_DISABLED: 'The institution is not accepting this attestation type right now.',
    ATTESTATION_TYPE_INVALID: 'Some settings are not valid. Check the highlighted values.',
    ATTESTATION_ORGANIZATION_UNAVAILABLE:
      'This institution cannot take attestation requests right now.',
    ATTESTATION_REQUEST_NOT_FOUND: 'That request was not found.',
    ATTESTATION_TRANSITION_INVALID:
      'That is no longer possible: the request has moved on. Reload to see where it stands.',
    ATTESTATION_METADATA_INVALID: 'Some details are missing or not valid.',
    ATTESTATION_ARTIFACT_NOT_FOUND: 'The file was not found.',
    ATTESTATION_ARTIFACT_NOT_READY: 'Upload a file and wait for it to be checked first.',
    ATTESTATION_ARTIFACT_TYPE_NOT_ALLOWED: 'This institution does not accept that file type.',
    ATTESTATION_ARTIFACT_INTEGRITY_FAILED:
      'The stored file no longer matches what was checked, so it cannot be attested.',
    ATTESTATION_VALIDITY_INVALID: 'The validity period is not valid for this attestation type.',
    ATTESTATION_CONFIRMATION_REQUIRED: 'Confirm that you reviewed the file before approving.',
    ATTESTATION_NOT_FOUND: 'That attestation was not found.',
    ATTESTATION_ALREADY_REVOKED: 'This attestation is already revoked.',
    ATTESTATION_TOO_MANY_PENDING:
      'You have too many open requests. Finish or cancel some before starting another.',
    ATTESTATION_COMMISSION_INVALID: 'Enter a percentage from 0 to 100, with at most two decimals.',
    FILE_TOO_LARGE: 'The file is larger than this institution accepts.',
    RATE_LIMITED: 'Too many attempts. Wait a moment and try again.',
    REAUTHENTICATION_REQUIRED: 'For your security, sign in again to do this.',
    FORBIDDEN: 'You do not have permission to do this.',
    NETWORK_ERROR: 'PalCert could not be reached. Check your connection and try again.',
    UPLOAD_TRANSFER_FAILED: 'The upload did not complete. Try again.',
    UPLOAD_CANCELLED: 'The upload was cancelled.',
    VALIDATION_FAILED: 'Some values are not valid.',
  },
  genericError: 'Something went wrong. Try again.',
  loading: 'Loading…',
  optional: 'optional',
  required: 'required',
  cancel: 'Cancel',
  close: 'Close',
  save: 'Save',
  saving: 'Saving…',
  copy: 'Copy',
  copied: 'Copied',
  loadMore: 'Load more',
  noExpiry: 'No expiry',
  none: '—',

  mine: {
    title: 'Attestations',
    intro:
      'Ask an institution to attest a certificate you already hold. Anyone with the link or QR ' +
      'code can then check that the institution attested that exact file.',
    newRequest: 'Request an attestation',
    emptyTitle: 'No attestation requests yet',
    emptyHint: 'Upload a certificate you hold and choose the institution that should attest it.',
    summary: {
      valid: 'Valid',
      expiringSoon: 'Expiring within 30 days',
      pendingReview: 'Waiting for the institution',
      needsInformation: 'Waiting for you',
      expired: 'Expired',
      rejected: 'Rejected',
    },
    institution: 'Institution',
    type: 'Attestation type',
    certificate: 'Certificate',
    status: 'Status',
    validity: 'Valid until',
    fee: 'Fee',
    updated: 'Updated',
    open: 'Open',
    filterLabel: 'Show',
    filterAll: 'All requests',
  },

  wizard: {
    title: 'Request an attestation',
    intro:
      'Choose the institution, upload the certificate file, describe it, and submit. The fee is ' +
      'reserved when you submit and charged only if the institution approves.',
    renewalOf: (reference) => `Renewal of attestation ${reference}`,
    steps: ['Institution', 'Attestation type', 'Details', 'File', 'Review and submit'],
    stepOf: (current, total) => `Step ${current} of ${total}`,
    stepStates: { done: 'completed', current: 'current step', upcoming: 'not started' },
    next: 'Continue',
    back: 'Back',
    chooseInstitution: 'Which institution should attest this certificate?',
    institutionHint: 'Only institutions that offer attestations are listed.',
    noInstitutions: 'No institution offers attestations yet.',
    verifiedInstitution: 'Verified by PalCert',
    chooseType: 'What kind of attestation?',
    noTypes: 'This institution has no attestation types available.',
    defaultValidity: (days) => `Usually valid for ${days} days`,
    instructions: 'Instructions from the institution',
    acceptedFormats: (formats, maxMb) => `Accepted: ${formats}, up to ${maxMb} MB.`,
    chooseFile: 'Certificate file',
    fileHint:
      'Upload the file you want attested. The institution attests exactly this file; a different ' +
      'scan or copy would not match.',
    upload: 'Upload',
    uploading: (percent) => `Uploading… ${percent}%`,
    checking: 'Checking the file…',
    fileReady: 'The file was accepted.',
    replaceFile: 'Replace the file',
    fingerprint: 'File fingerprint (SHA-256)',
    detailsIntro:
      'Describe the certificate as it appears. The institution confirms or corrects these ' +
      'details when it approves.',
    notesForReviewer: 'Note for the reviewer',
    notesHint: 'Anything that helps the institution find your record. Not shown publicly.',
    review: 'Review',
    feeLabel: 'Attestation fee',
    balanceLabel: 'Your available balance',
    afterSubmit: 'Available after submitting',
    insufficient: (shortfall) =>
      `Your balance is ${shortfall} short. Top up your balance, then come back to submit.`,
    topUp: 'Top up balance',
    freeOfCharge: 'This attestation is free of charge.',
    reserveNote:
      'The fee is held from your balance when you submit. It is charged if the institution ' +
      'approves, and returned in full if it rejects or if you cancel before review starts.',
    refundPolicy:
      'Once approved, the fee is not refunded automatically, including if the attestation is ' +
      'later revoked.',
    submit: 'Submit for attestation',
    submitting: 'Submitting…',
    saveDraft: 'Save details',
    draftSaved: 'Saved.',
    createDraft: 'Start request',
  },

  details: {
    backToList: 'Back to attestations',
    requestTitle: 'Attestation request',
    submittedDetails: 'Details you submitted',
    confirmedDetails: 'Details the institution confirmed',
    confirmedHint: 'These are what the public page shows.',
    file: 'Submitted file',
    downloadMine: 'Download my file',
    history: 'History',
    institutionAsked: 'The institution asked',
    respond: 'Respond',
    respondTitle: 'Respond to the institution',
    respondIntro: 'Your answer goes to the institution, and the request returns to its review.',
    responseLabel: 'Your answer',
    send: 'Send',
    cancelRequest: 'Cancel request',
    cancelTitle: 'Cancel this request?',
    cancelIntro:
      'The institution will not review it, and any reserved fee returns to your balance.',
    submitDraft: 'Submit',
    continueDraft: 'Continue this request',
    rejectedBecause: 'The institution’s reason',
    renew: 'Request a renewal',
    receipt: 'Receipt',
    receiptTitle: 'Payment receipt',
    paidAt: 'Paid',
    transaction: 'Transaction',
    attestation: 'Attestation',
    reference: 'Reference',
    validFrom: 'Valid from',
    validUntil: 'Valid until',
    approvedAt: 'Approved',
    revokedAt: 'Revoked',
    revocationReason: 'Reason for revocation',
    institutionNote: 'Note from the institution',
    verificationLink: 'Public verification link',
    openPublicPage: 'Open the public page',
    qrCode: 'QR code',
    qrAlt: 'QR code linking to the public verification page',
    downloadPng: 'Download PNG',
    downloadSvg: 'Download SVG',
    artifactHash: 'File fingerprint (SHA-256)',
    attestationHash: 'Attestation fingerprint',
    hashHint:
      'Anyone holding the file can compute its SHA-256 and compare it with this value to confirm ' +
      'it is the attested file.',
  },

  queue: {
    title: 'Attestation requests',
    intro: 'Certificates users have asked this institution to attest.',
    tabs: {
      PENDING: 'Pending',
      IN_REVIEW: 'In review',
      AWAITING_INFORMATION: 'Awaiting information',
      APPROVED: 'Approved',
      REJECTED: 'Rejected',
      REVOKED: 'Revoked',
      EXPIRED: 'Expired',
      ALL: 'All',
    },
    searchLabel: 'Search',
    searchHint: 'Certificate title, name, number or reference',
    search: 'Search',
    typeFilter: 'Attestation type',
    allTypes: 'All types',
    sortLabel: 'Sort',
    sorts: {
      'submittedAt:asc': 'Oldest first',
      'submittedAt:desc': 'Newest first',
      'updatedAt:desc': 'Recently updated',
    },
    applicant: 'Applicant',
    certificate: 'Certificate',
    type: 'Type',
    submitted: 'Submitted',
    reviewer: 'Reviewer',
    unassigned: 'Unassigned',
    fee: 'Fee',
    status: 'Status',
    duplicate: 'Same file seen before',
    duplicateHint: 'This institution has received a request with exactly this file before.',
    emptyTitle: 'Nothing here',
    emptyHint: 'Requests appear here when users submit them.',
    dashboard: {
      pendingReview: 'Pending review',
      needsAttention: 'Answered, needs attention',
      approvedThisMonth: 'Approved this month',
      rejectedThisMonth: 'Rejected this month',
      expiringSoon: 'Expiring within 30 days',
      revenueThisMonth: 'Net revenue this month',
    },
    manageTypes: 'Attestation types and fees',
    revenue: 'Revenue',
  },

  review: {
    backToQueue: 'Back to requests',
    applicant: 'Applicant',
    submittedFile: 'Submitted file',
    viewFile: 'View file',
    downloadFile: 'Download file',
    fileViewNote: 'Opening the file is recorded in the audit log.',
    sameFile: 'Earlier requests with this exact file',
    sameFileHint: 'Only requests to this institution are shown.',
    feeSnapshot: 'Fee at submission',
    gross: 'Paid by the applicant',
    platformFee: 'PalCert commission',
    institutionNet: 'Institution net',
    commission: 'Commission rate',
    startReview: 'Start review',
    assignToMe: 'Assign to me',
    assignedTo: 'Assigned to',
    requestInformation: 'Ask for information',
    requestInformationTitle: 'Ask the applicant for information',
    requestInformationIntro: 'The applicant is notified and can answer on the request page.',
    question: 'Your question',
    reject: 'Reject',
    rejectTitle: 'Reject this request?',
    rejectIntro:
      'The applicant sees your reason, and the reserved fee returns to their balance in full.',
    rejectReason: 'Reason shown to the applicant',
    rejectReasonHint: 'Be specific: this is what the applicant reads.',
    approve: 'Approve and attest',
    approveTitle: 'Approve and attest',
    approveIntro:
      'Confirm the details exactly as they should appear publicly. The attestation cannot be ' +
      'edited afterwards; it can only be revoked.',
    holderName: 'Holder name',
    showHolderName: 'Show the holder name on the public page',
    showReference: 'Show the certificate number on the public page',
    validFrom: 'Valid from',
    validityMode: 'Validity',
    validityDays: 'For a number of days',
    validityUntil: 'Until a date',
    validityNone: 'No expiry',
    validityDaysLabel: 'Days',
    validUntilLabel: 'Valid until (end of day, UTC)',
    institutionNote: 'Note to the applicant',
    institutionNoteHint: 'Shown to the applicant only, never publicly.',
    confirmLabel:
      'I reviewed the submitted file and confirm the details above on behalf of this institution.',
    approving: 'Approving…',
    revoke: 'Revoke attestation',
    revokeTitle: 'Revoke this attestation?',
    revokeIntro:
      'The public page will say REVOKED from now on. The applicant is notified. This cannot be undone.',
    revokeReason: 'Reason (recorded; not shown publicly)',
    noRefundNote: 'Revocation does not refund the fee automatically.',
  },

  types: {
    title: 'Attestation types',
    intro:
      'What this institution attests, what it costs, and how long an attestation lasts. A change ' +
      'applies to new requests; submitted requests keep the price they were submitted at.',
    newType: 'New attestation type',
    editType: 'Edit',
    emptyTitle: 'No attestation types yet',
    emptyHint: 'Create a type, such as “Degree certificate”, to start receiving requests.',
    nameEn: 'Name (English)',
    nameAr: 'Name (Arabic)',
    descriptionEn: 'Description (English)',
    descriptionAr: 'Description (Arabic)',
    instructionsEn: 'Instructions for applicants (English)',
    instructionsAr: 'Instructions for applicants (Arabic)',
    enabled: 'Accepting requests',
    disabled: 'Not accepting requests',
    currency: 'Currency',
    fee: 'Fee',
    feeHint: 'In the currency’s main unit, for example 10.00. Zero means free.',
    defaultValidityDays: 'Default validity (days)',
    defaultValidityHint: 'Leave empty for no expiry.',
    allowNoExpiry: 'Reviewers may approve with no expiry',
    reviewerMayOverride: 'Reviewers may change the validity period',
    requiredFields: 'Details the applicant must provide',
    allowedFormats: 'Accepted file types',
    maxFileMb: 'Largest file (MB)',
    reminderDays: 'Expiry reminders (days before)',
    reminderHint: 'Comma-separated, for example 30, 14, 7, 1.',
    created: 'Attestation type created.',
    saved: 'Saved.',
    feeChangeNote: 'Changing the fee does not change requests already submitted.',
  },

  revenue: {
    title: 'Attestation revenue',
    intro:
      'What applicants paid, PalCert’s commission, and this institution’s net, per request. ' +
      'Amounts are recorded when each request is decided.',
    from: 'From',
    to: 'To',
    apply: 'Apply',
    totals: 'Totals',
    gross: 'Gross',
    platformFee: 'PalCert commission',
    institutionNet: 'Institution net',
    pending: 'Reserved, not yet decided',
    settled: 'Settled',
    released: 'Returned to applicants',
    lines: 'Requests',
    reference: 'Reference',
    applicant: 'Applicant',
    type: 'Type',
    payment: 'Payment',
    commission: 'Commission',
    settledAt: 'Settled',
    transaction: 'Transaction',
    emptyTitle: 'No revenue yet',
    emptyHint: 'Settled attestation fees appear here.',
  },

  admin: {
    financeTitle: 'Attestation finance',
    financeIntro: 'Attestation fees across all institutions, and PalCert’s commission on each.',
    requests: 'Requests',
    approvals: 'Approvals',
    rejections: 'Rejections',
    valid: 'Valid',
    expired: 'Expired',
    revoked: 'Revoked',
    byCurrency: 'By currency',
    organization: 'Institution',
    currentCommission: 'Current commission',
    gross: 'Gross',
    platformRevenue: 'PalCert revenue',
    institutionNet: 'Institution net',
    pending: 'Pending',
    manageCommission: 'Commission',
    commissionTitle: 'Attestation commission',
    commissionIntro:
      'The percentage PalCert keeps from each attestation fee this institution receives. A new ' +
      'rate applies to requests submitted from its effective time; earlier requests keep theirs.',
    current: 'Current rate',
    defaultRate: 'Default (no rate set)',
    effectiveFrom: 'Effective from',
    newRate: 'Set a new rate',
    percent: 'Commission (%)',
    percentHint: 'From 0 to 100, with at most two decimals.',
    reason: 'Reason for the change',
    reasonHint: 'Recorded in the history and the audit log.',
    effectiveFromHint: 'Leave empty to apply from now.',
    setRate: 'Set rate',
    history: 'History',
    changedBy: 'Changed by',
    changedAt: 'Recorded',
    percentInvalid: 'Enter a percentage from 0 to 100, with at most two decimals.',
    emptyTitle: 'No attestation activity yet',
  },

  public: {
    title: 'Certificate attestation',
    verifiedBy: 'Verification by PalCert',
    attestedBy: 'Attested by',
    institutionVerified: 'Institution verified by PalCert',
    institutionUnverified: 'Institution not currently verified by PalCert',
    type: 'Attestation type',
    certificate: 'Certificate',
    holder: 'Holder',
    issuer: 'Issued by',
    issueDate: 'Issue date',
    referenceNumber: 'Certificate number',
    reference: 'Attestation reference',
    validFrom: 'Valid from',
    validUntil: 'Valid until',
    attestedAt: 'Attested',
    revokedAt: 'Revoked',
    fileFormat: 'File format',
    artifactHash: 'Attested file (SHA-256)',
    attestationHash: 'Attestation fingerprint',
    notFound:
      'No attestation matches this link. Check that the whole link was copied, or ask the ' +
      'certificate holder for a new one.',
    noFileHere:
      'The attested file is not published. Ask the holder for the file, then check it below.',
    checkFileTitle: 'Check a file against this attestation',
    checkFileIntro:
      'Choose the file you were given. Its fingerprint is computed on this device; the file is ' +
      'not uploaded.',
    chooseFile: 'File to check',
    checking: 'Computing the fingerprint…',
    fileMatchesOther: 'This file is attested, but by a different attestation.',
    computedHash: 'Fingerprint of your file',
    validityQuestion: 'Is this institutional attestation currently in force?',
    validityTitles: {
      VALID: 'Valid attestation',
      EXPIRED: 'Expired attestation',
      REVOKED: 'Revoked attestation',
    },
    validityExplanations: {
      VALID:
        'The institution named here attested this exact file, and the attestation is currently in force.',
      EXPIRED: 'The validity period of this attestation has ended. It is no longer in force.',
      REVOKED: 'The institution withdrew this attestation. It is no longer in force.',
    },
    validityBadges: { VALID: 'Valid', EXPIRED: 'Expired', REVOKED: 'Revoked' },
    expiredOn: 'Expired on',
    revokedOn: 'Revoked on',
    attestedDocument: 'Attested document',
    protectedDocument: 'Protected · not published',
    documentType: 'Document type',
    fingerprint: 'Fingerprint',
    fileTypes: {
      'application/pdf': 'PDF document',
      'image/png': 'PNG image',
      'image/jpeg': 'JPEG image',
      'image/webp': 'WebP image',
    },
    otherFileType: 'File',
    comparisonQuestion: 'Is this exact file the one the institution attested?',
    fileYouSelected: 'File you selected',
    noFileSelected: 'No file selected yet. Choose the file you were given to compare it.',
    staysLocal: 'Stays on this device. Only its fingerprint is compared.',
    fileName: 'File name',
    fileSize: 'Size',
    imagePreviewAlt: 'Preview of the file you selected',
    pdfNotEmbedded: 'PDF files are not embedded on this page.',
    openLocalPreview: 'Open a preview in a new tab',
    noPreview: 'No preview for this type of file. The comparison still uses its exact fingerprint.',
    matchTitle: 'Match confirmed',
    matchText: 'The selected file is exactly the file that this institution attested.',
    mismatchTitle: 'Not a match',
    mismatchText: 'The selected file is not the file covered by this attestation.',
    mismatchHint: 'Even a re-scan or re-save of the same paper changes the fingerprint.',
    detailsTitle: 'Attestation details',
    technicalDetails: 'Technical details',
  },
};

const ar: AttestationsMessages = {
  disclaimer:
    'تُصادق PalCert على ملف مُقدَّم. ولا يعني ذلك أن PalCert هي من أصدرت تلك الشهادة الخارجية في الأصل.',

  nav: {
    mine: 'المصادقات',
    queue: 'طلبات المصادقة',
    types: 'أنواع المصادقة',
    revenue: 'إيرادات المصادقة',
    adminFinance: 'مالية المصادقات',
  },

  statuses: {
    DRAFT: 'مسودة',
    SUBMITTED: 'مُقدَّم',
    IN_REVIEW: 'قيد المراجعة',
    NEEDS_INFORMATION: 'بانتظار معلومات',
    APPROVED: 'مقبول',
    REJECTED: 'مرفوض',
    CANCELLED: 'مُلغى',
  },
  verificationStatuses: {
    VALID: 'سارية',
    EXPIRED: 'منتهية',
    REVOKED: 'مسحوبة',
  },
  verificationHints: {
    VALID: 'صادقت المؤسسة المذكورة أدناه على هذا الملف بعينه، والمصادقة سارية.',
    EXPIRED: 'انتهت مدة سريان المصادقة. كانت سارية حتى التاريخ المبيَّن.',
    REVOKED: 'سحبت المؤسسة هذه المصادقة، ولم تعد سارية.',
  },
  paymentStatuses: {
    NOT_REQUIRED: 'بلا رسوم',
    UNPAID: 'لم يُحجز بعد',
    RESERVED: 'محجوز من رصيدك',
    SETTLED: 'مُحصَّل',
    RELEASED: 'أُعيد إلى رصيدك',
  },
  artifactStatuses: {
    AWAITING_UPLOAD: 'بانتظار الملف',
    UPLOADED: 'تم الرفع',
    VALIDATING: 'جارٍ فحص الملف',
    SCANNING: 'فحص الأمان',
    READY: 'جاهز',
    REJECTED: 'غير مقبول',
    FAILED: 'تعذّر الفحص',
    UPLOAD_EXPIRED: 'انتهت مهلة الرفع',
    CANCELLED: 'تم استبداله',
  },
  eventTypes: {
    CREATED: 'أُنشئت المسودة',
    SUBMITTED: 'قُدِّم إلى المؤسسة',
    REVIEW_STARTED: 'بدأت المراجعة',
    ASSIGNED: 'عُيِّن مراجع',
    INFORMATION_REQUESTED: 'طلبت المؤسسة معلومات إضافية',
    INFORMATION_PROVIDED: 'قُدِّمت المعلومات',
    APPROVED: 'تمت الموافقة',
    REJECTED: 'رُفض',
    CANCELLED: 'أُلغي',
    REVOKED: 'سُحبت المصادقة',
    PAYMENT_RESERVED: 'حُجزت الرسوم',
    PAYMENT_SETTLED: 'حُصِّلت الرسوم',
    PAYMENT_RELEASED: 'أُعيدت الرسوم',
  },
  fields: {
    certificateTitle: 'عنوان الشهادة',
    certificateType: 'نوع الشهادة',
    issuingOrganization: 'الجهة المُصدِرة',
    issueDate: 'تاريخ الإصدار',
    referenceNumber: 'رقم الشهادة',
    recipientName: 'الاسم الوارد في الشهادة',
    description: 'الوصف',
  },
  rejections: {
    FILE_EXTENSION_UNSUPPORTED: 'نوع الملف غير مقبول. ارفع ملف PDF أو PNG أو JPEG أو WebP.',
    FILE_TYPE_UNSUPPORTED: 'نوع الملف غير مقبول. ارفع ملف PDF أو PNG أو JPEG أو WebP.',
    FILE_TYPE_MISMATCH: 'محتوى الملف لا يطابق اسمه. ارفع الملف الأصلي.',
    FILE_TOO_LARGE: 'حجم الملف أكبر مما تقبله هذه المؤسسة.',
    FILE_EMPTY: 'الملف فارغ.',
    FILE_CONTAINER_INVALID: 'تعذّر فتح الملف بوصفه PDF أو صورة.',
    FILE_ARCHIVE_UNSAFE: 'لم يجتز الملف فحوص الأمان في PalCert.',
    FILE_MALWARE_DETECTED: 'لم يجتز الملف فحوص الأمان في PalCert.',
    FILE_CHECKSUM_MISMATCH: 'تغيّر الملف أثناء الرفع. ارفعه مرة أخرى.',
  },
  errors: {
    INSUFFICIENT_BALANCE: 'رصيدك لا يكفي لهذه الرسوم. اشحن رصيدك ثم قدّم الطلب مجددًا.',
    ATTESTATION_TYPE_NOT_FOUND: 'نوع المصادقة هذا غير متاح.',
    ATTESTATION_TYPE_DISABLED: 'المؤسسة لا تستقبل هذا النوع من المصادقات حاليًا.',
    ATTESTATION_TYPE_INVALID: 'بعض الإعدادات غير صالحة. راجع القيم المحددة.',
    ATTESTATION_ORGANIZATION_UNAVAILABLE: 'لا تستطيع هذه المؤسسة استقبال طلبات مصادقة حاليًا.',
    ATTESTATION_REQUEST_NOT_FOUND: 'لم يُعثر على هذا الطلب.',
    ATTESTATION_TRANSITION_INVALID: 'لم يعد ذلك ممكنًا لأن الطلب تغيّرت حالته. أعد تحميل الصفحة.',
    ATTESTATION_METADATA_INVALID: 'بعض البيانات ناقصة أو غير صالحة.',
    ATTESTATION_ARTIFACT_NOT_FOUND: 'لم يُعثر على الملف.',
    ATTESTATION_ARTIFACT_NOT_READY: 'ارفع ملفًا وانتظر حتى يكتمل فحصه أولًا.',
    ATTESTATION_ARTIFACT_TYPE_NOT_ALLOWED: 'لا تقبل هذه المؤسسة هذا النوع من الملفات.',
    ATTESTATION_ARTIFACT_INTEGRITY_FAILED:
      'الملف المخزَّن لم يعد مطابقًا لما فُحص، لذا لا يمكن المصادقة عليه.',
    ATTESTATION_VALIDITY_INVALID: 'مدة السريان غير صالحة لهذا النوع من المصادقة.',
    ATTESTATION_CONFIRMATION_REQUIRED: 'أكّد أنك راجعت الملف قبل الموافقة.',
    ATTESTATION_NOT_FOUND: 'لم يُعثر على هذه المصادقة.',
    ATTESTATION_ALREADY_REVOKED: 'هذه المصادقة مسحوبة بالفعل.',
    ATTESTATION_TOO_MANY_PENDING:
      'لديك طلبات مفتوحة كثيرة. أكمل بعضها أو ألغِه قبل البدء بطلب جديد.',
    ATTESTATION_COMMISSION_INVALID: 'أدخل نسبة من 0 إلى 100 بمنزلتين عشريتين على الأكثر.',
    FILE_TOO_LARGE: 'حجم الملف أكبر مما تقبله هذه المؤسسة.',
    RATE_LIMITED: 'محاولات كثيرة. انتظر قليلًا ثم حاول مجددًا.',
    REAUTHENTICATION_REQUIRED: 'لحمايتك، سجّل الدخول مجددًا لتنفيذ ذلك.',
    FORBIDDEN: 'ليست لديك صلاحية لتنفيذ ذلك.',
    NETWORK_ERROR: 'تعذّر الوصول إلى PalCert. تحقّق من اتصالك وحاول مجددًا.',
    UPLOAD_TRANSFER_FAILED: 'لم يكتمل الرفع. حاول مجددًا.',
    UPLOAD_CANCELLED: 'أُلغي الرفع.',
    VALIDATION_FAILED: 'بعض القيم غير صالحة.',
  },
  genericError: 'حدث خطأ ما. حاول مجددًا.',
  loading: 'جارٍ التحميل…',
  optional: 'اختياري',
  required: 'مطلوب',
  cancel: 'إلغاء',
  close: 'إغلاق',
  save: 'حفظ',
  saving: 'جارٍ الحفظ…',
  copy: 'نسخ',
  copied: 'تم النسخ',
  loadMore: 'عرض المزيد',
  noExpiry: 'بلا انتهاء',
  none: '—',

  mine: {
    title: 'المصادقات',
    intro:
      'اطلب من مؤسسة المصادقة على شهادة تحملها. بعد ذلك يستطيع أي شخص لديه الرابط أو رمز QR ' +
      'التحقق من أن المؤسسة صادقت على هذا الملف بعينه.',
    newRequest: 'طلب مصادقة',
    emptyTitle: 'لا توجد طلبات مصادقة بعد',
    emptyHint: 'ارفع شهادة تحملها واختر المؤسسة التي ينبغي أن تصادق عليها.',
    summary: {
      valid: 'سارية',
      expiringSoon: 'تنتهي خلال 30 يومًا',
      pendingReview: 'بانتظار المؤسسة',
      needsInformation: 'بانتظارك',
      expired: 'منتهية',
      rejected: 'مرفوضة',
    },
    institution: 'المؤسسة',
    type: 'نوع المصادقة',
    certificate: 'الشهادة',
    status: 'الحالة',
    validity: 'سارية حتى',
    fee: 'الرسوم',
    updated: 'آخر تحديث',
    open: 'فتح',
    filterLabel: 'عرض',
    filterAll: 'كل الطلبات',
  },

  wizard: {
    title: 'طلب مصادقة',
    intro:
      'اختر المؤسسة، وارفع ملف الشهادة، وصِفها، ثم قدّم الطلب. تُحجز الرسوم عند التقديم ولا ' +
      'تُحصَّل إلا إذا وافقت المؤسسة.',
    renewalOf: (reference) => `تجديد المصادقة ${reference}`,
    steps: ['المؤسسة', 'نوع المصادقة', 'البيانات', 'الملف', 'المراجعة والتقديم'],
    stepOf: (current, total) => `الخطوة ${current} من ${total}`,
    stepStates: { done: 'مكتملة', current: 'الخطوة الحالية', upcoming: 'لم تبدأ' },
    next: 'متابعة',
    back: 'رجوع',
    chooseInstitution: 'أي مؤسسة ينبغي أن تصادق على هذه الشهادة؟',
    institutionHint: 'تُعرض فقط المؤسسات التي تقدّم خدمة المصادقة.',
    noInstitutions: 'لا توجد مؤسسة تقدّم خدمة المصادقة بعد.',
    verifiedInstitution: 'موثّقة من PalCert',
    chooseType: 'ما نوع المصادقة؟',
    noTypes: 'لا تتوفر لدى هذه المؤسسة أنواع مصادقة.',
    defaultValidity: (days) => `تسري عادةً ${days} يومًا`,
    instructions: 'تعليمات المؤسسة',
    acceptedFormats: (formats, maxMb) => `المقبول: ${formats}، حتى ${maxMb} ميغابايت.`,
    chooseFile: 'ملف الشهادة',
    fileHint:
      'ارفع الملف الذي تريد المصادقة عليه. تصادق المؤسسة على هذا الملف بعينه؛ ولن يطابقه مسح ' +
      'ضوئي آخر أو نسخة أخرى.',
    upload: 'رفع',
    uploading: (percent) => `جارٍ الرفع… ${percent}٪`,
    checking: 'جارٍ فحص الملف…',
    fileReady: 'قُبل الملف.',
    replaceFile: 'استبدال الملف',
    fingerprint: 'بصمة الملف (SHA-256)',
    detailsIntro: 'صِف الشهادة كما تظهر. تؤكّد المؤسسة هذه البيانات أو تصحّحها عند الموافقة.',
    notesForReviewer: 'ملاحظة للمراجع',
    notesHint: 'أي شيء يساعد المؤسسة على إيجاد سجلك. لا يُعرض علنًا.',
    review: 'المراجعة',
    feeLabel: 'رسوم المصادقة',
    balanceLabel: 'رصيدك المتاح',
    afterSubmit: 'المتاح بعد التقديم',
    insufficient: (shortfall) => `ينقص رصيدك ${shortfall}. اشحن رصيدك ثم عُد لتقديم الطلب.`,
    topUp: 'شحن الرصيد',
    freeOfCharge: 'هذه المصادقة بلا رسوم.',
    reserveNote:
      'تُحجز الرسوم من رصيدك عند التقديم، وتُحصَّل إذا وافقت المؤسسة، وتُعاد كاملة إذا رفضت ' +
      'أو إذا ألغيت قبل بدء المراجعة.',
    refundPolicy: 'بعد الموافقة لا تُسترد الرسوم تلقائيًا، حتى لو سُحبت المصادقة لاحقًا.',
    submit: 'تقديم للمصادقة',
    submitting: 'جارٍ التقديم…',
    saveDraft: 'حفظ البيانات',
    draftSaved: 'تم الحفظ.',
    createDraft: 'بدء الطلب',
  },

  details: {
    backToList: 'العودة إلى المصادقات',
    requestTitle: 'طلب مصادقة',
    submittedDetails: 'البيانات التي قدّمتها',
    confirmedDetails: 'البيانات التي أكّدتها المؤسسة',
    confirmedHint: 'هذه هي البيانات المعروضة في الصفحة العامة.',
    file: 'الملف المُقدَّم',
    downloadMine: 'تنزيل ملفي',
    history: 'السجل',
    institutionAsked: 'سؤال المؤسسة',
    respond: 'الرد',
    respondTitle: 'الرد على المؤسسة',
    respondIntro: 'يصل ردّك إلى المؤسسة، ويعود الطلب إلى المراجعة.',
    responseLabel: 'ردّك',
    send: 'إرسال',
    cancelRequest: 'إلغاء الطلب',
    cancelTitle: 'إلغاء هذا الطلب؟',
    cancelIntro: 'لن تراجعه المؤسسة، وتعود أي رسوم محجوزة إلى رصيدك.',
    submitDraft: 'تقديم',
    continueDraft: 'متابعة هذا الطلب',
    rejectedBecause: 'سبب المؤسسة',
    renew: 'طلب تجديد',
    receipt: 'الإيصال',
    receiptTitle: 'إيصال الدفع',
    paidAt: 'تاريخ الدفع',
    transaction: 'المعاملة',
    attestation: 'المصادقة',
    reference: 'المرجع',
    validFrom: 'سارية من',
    validUntil: 'سارية حتى',
    approvedAt: 'تاريخ الموافقة',
    revokedAt: 'تاريخ السحب',
    revocationReason: 'سبب السحب',
    institutionNote: 'ملاحظة من المؤسسة',
    verificationLink: 'رابط التحقق العام',
    openPublicPage: 'فتح الصفحة العامة',
    qrCode: 'رمز QR',
    qrAlt: 'رمز QR يؤدي إلى صفحة التحقق العامة',
    downloadPng: 'تنزيل PNG',
    downloadSvg: 'تنزيل SVG',
    artifactHash: 'بصمة الملف (SHA-256)',
    attestationHash: 'بصمة المصادقة',
    hashHint:
      'يستطيع كل من يحمل الملف حساب SHA-256 له ومقارنته بهذه القيمة للتأكد من أنه الملف المصادَق عليه.',
  },

  queue: {
    title: 'طلبات المصادقة',
    intro: 'الشهادات التي طلب المستخدمون من هذه المؤسسة المصادقة عليها.',
    tabs: {
      PENDING: 'قيد الانتظار',
      IN_REVIEW: 'قيد المراجعة',
      AWAITING_INFORMATION: 'بانتظار معلومات',
      APPROVED: 'مقبولة',
      REJECTED: 'مرفوضة',
      REVOKED: 'مسحوبة',
      EXPIRED: 'منتهية',
      ALL: 'الكل',
    },
    searchLabel: 'بحث',
    searchHint: 'عنوان الشهادة أو الاسم أو الرقم أو المرجع',
    search: 'بحث',
    typeFilter: 'نوع المصادقة',
    allTypes: 'كل الأنواع',
    sortLabel: 'الترتيب',
    sorts: {
      'submittedAt:asc': 'الأقدم أولًا',
      'submittedAt:desc': 'الأحدث أولًا',
      'updatedAt:desc': 'المحدَّثة مؤخرًا',
    },
    applicant: 'مقدّم الطلب',
    certificate: 'الشهادة',
    type: 'النوع',
    submitted: 'تاريخ التقديم',
    reviewer: 'المراجع',
    unassigned: 'غير معيَّن',
    fee: 'الرسوم',
    status: 'الحالة',
    duplicate: 'سبق ورود الملف نفسه',
    duplicateHint: 'تلقّت هذه المؤسسة من قبل طلبًا بهذا الملف بعينه.',
    emptyTitle: 'لا شيء هنا',
    emptyHint: 'تظهر الطلبات هنا عندما يقدّمها المستخدمون.',
    dashboard: {
      pendingReview: 'بانتظار المراجعة',
      needsAttention: 'ورد الرد، يحتاج متابعة',
      approvedThisMonth: 'المقبولة هذا الشهر',
      rejectedThisMonth: 'المرفوضة هذا الشهر',
      expiringSoon: 'تنتهي خلال 30 يومًا',
      revenueThisMonth: 'صافي الإيرادات هذا الشهر',
    },
    manageTypes: 'أنواع المصادقة ورسومها',
    revenue: 'الإيرادات',
  },

  review: {
    backToQueue: 'العودة إلى الطلبات',
    applicant: 'مقدّم الطلب',
    submittedFile: 'الملف المُقدَّم',
    viewFile: 'عرض الملف',
    downloadFile: 'تنزيل الملف',
    fileViewNote: 'يُسجَّل فتح الملف في سجل التدقيق.',
    sameFile: 'طلبات سابقة بالملف نفسه',
    sameFileHint: 'تُعرض فقط الطلبات المقدَّمة إلى هذه المؤسسة.',
    feeSnapshot: 'الرسوم عند التقديم',
    gross: 'ما دفعه مقدّم الطلب',
    platformFee: 'عمولة PalCert',
    institutionNet: 'صافي المؤسسة',
    commission: 'نسبة العمولة',
    startReview: 'بدء المراجعة',
    assignToMe: 'تعيينه لي',
    assignedTo: 'المراجع المعيَّن',
    requestInformation: 'طلب معلومات',
    requestInformationTitle: 'طلب معلومات من مقدّم الطلب',
    requestInformationIntro: 'يصل إشعار إلى مقدّم الطلب، ويمكنه الرد من صفحة الطلب.',
    question: 'سؤالك',
    reject: 'رفض',
    rejectTitle: 'رفض هذا الطلب؟',
    rejectIntro: 'يرى مقدّم الطلب السبب، وتعود الرسوم المحجوزة إلى رصيده كاملة.',
    rejectReason: 'السبب الذي يراه مقدّم الطلب',
    rejectReasonHint: 'كن محددًا، فهذا ما سيقرؤه مقدّم الطلب.',
    approve: 'الموافقة والمصادقة',
    approveTitle: 'الموافقة والمصادقة',
    approveIntro:
      'أكّد البيانات تمامًا كما ينبغي أن تظهر علنًا. لا يمكن تعديل المصادقة بعد ذلك، ويمكن سحبها فقط.',
    holderName: 'اسم حامل الشهادة',
    showHolderName: 'إظهار اسم حامل الشهادة في الصفحة العامة',
    showReference: 'إظهار رقم الشهادة في الصفحة العامة',
    validFrom: 'سارية من',
    validityMode: 'مدة السريان',
    validityDays: 'لعدد من الأيام',
    validityUntil: 'حتى تاريخ',
    validityNone: 'بلا انتهاء',
    validityDaysLabel: 'الأيام',
    validUntilLabel: 'سارية حتى (نهاية اليوم بالتوقيت العالمي)',
    institutionNote: 'ملاحظة لمقدّم الطلب',
    institutionNoteHint: 'تظهر لمقدّم الطلب فقط، ولا تُعرض علنًا.',
    confirmLabel: 'راجعتُ الملف المُقدَّم وأؤكّد البيانات أعلاه نيابةً عن هذه المؤسسة.',
    approving: 'جارٍ الاعتماد…',
    revoke: 'سحب المصادقة',
    revokeTitle: 'سحب هذه المصادقة؟',
    revokeIntro:
      'ستعرض الصفحة العامة «مسحوبة» من الآن فصاعدًا، ويُبلَّغ مقدّم الطلب. لا يمكن التراجع عن ذلك.',
    revokeReason: 'السبب (يُسجَّل ولا يُعرض علنًا)',
    noRefundNote: 'لا يترتب على السحب استرداد تلقائي للرسوم.',
  },

  types: {
    title: 'أنواع المصادقة',
    intro:
      'ما تصادق عليه هذه المؤسسة، وكم يكلّف، وكم تدوم المصادقة. يسري أي تغيير على الطلبات ' +
      'الجديدة؛ وتحتفظ الطلبات المقدَّمة بالسعر الذي قُدّمت به.',
    newType: 'نوع مصادقة جديد',
    editType: 'تعديل',
    emptyTitle: 'لا توجد أنواع مصادقة بعد',
    emptyHint: 'أنشئ نوعًا، مثل «شهادة تخرّج»، لتبدأ باستقبال الطلبات.',
    nameEn: 'الاسم (بالإنجليزية)',
    nameAr: 'الاسم (بالعربية)',
    descriptionEn: 'الوصف (بالإنجليزية)',
    descriptionAr: 'الوصف (بالعربية)',
    instructionsEn: 'تعليمات لمقدّمي الطلبات (بالإنجليزية)',
    instructionsAr: 'تعليمات لمقدّمي الطلبات (بالعربية)',
    enabled: 'يستقبل الطلبات',
    disabled: 'لا يستقبل الطلبات',
    currency: 'العملة',
    fee: 'الرسوم',
    feeHint: 'بالوحدة الرئيسية للعملة، مثل 10.00. الصفر يعني بلا رسوم.',
    defaultValidityDays: 'مدة السريان الافتراضية (بالأيام)',
    defaultValidityHint: 'اتركها فارغة لتكون بلا انتهاء.',
    allowNoExpiry: 'يجوز للمراجعين الموافقة بلا انتهاء',
    reviewerMayOverride: 'يجوز للمراجعين تغيير مدة السريان',
    requiredFields: 'البيانات المطلوبة من مقدّم الطلب',
    allowedFormats: 'أنواع الملفات المقبولة',
    maxFileMb: 'أكبر حجم للملف (ميغابايت)',
    reminderDays: 'تذكيرات الانتهاء (قبل الانتهاء بأيام)',
    reminderHint: 'مفصولة بفواصل، مثل 30، 14، 7، 1.',
    created: 'أُنشئ نوع المصادقة.',
    saved: 'تم الحفظ.',
    feeChangeNote: 'تغيير الرسوم لا يغيّر الطلبات المقدَّمة سابقًا.',
  },

  revenue: {
    title: 'إيرادات المصادقة',
    intro:
      'ما دفعه مقدّمو الطلبات، وعمولة PalCert، وصافي هذه المؤسسة لكل طلب. تُسجَّل المبالغ عند ' +
      'البتّ في كل طلب.',
    from: 'من',
    to: 'إلى',
    apply: 'تطبيق',
    totals: 'الإجماليات',
    gross: 'الإجمالي',
    platformFee: 'عمولة PalCert',
    institutionNet: 'صافي المؤسسة',
    pending: 'محجوز ولم يُبتّ فيه',
    settled: 'مُسوّى',
    released: 'أُعيد إلى مقدّمي الطلبات',
    lines: 'الطلبات',
    reference: 'المرجع',
    applicant: 'مقدّم الطلب',
    type: 'النوع',
    payment: 'الدفع',
    commission: 'العمولة',
    settledAt: 'تاريخ التسوية',
    transaction: 'المعاملة',
    emptyTitle: 'لا توجد إيرادات بعد',
    emptyHint: 'تظهر هنا رسوم المصادقة المُسوّاة.',
  },

  admin: {
    financeTitle: 'مالية المصادقات',
    financeIntro: 'رسوم المصادقة لدى جميع المؤسسات، وعمولة PalCert على كل منها.',
    requests: 'الطلبات',
    approvals: 'الموافقات',
    rejections: 'حالات الرفض',
    valid: 'سارية',
    expired: 'منتهية',
    revoked: 'مسحوبة',
    byCurrency: 'حسب العملة',
    organization: 'المؤسسة',
    currentCommission: 'العمولة الحالية',
    gross: 'الإجمالي',
    platformRevenue: 'إيرادات PalCert',
    institutionNet: 'صافي المؤسسة',
    pending: 'قيد الانتظار',
    manageCommission: 'العمولة',
    commissionTitle: 'عمولة المصادقة',
    commissionIntro:
      'النسبة التي تحتفظ بها PalCert من كل رسوم مصادقة تتلقاها هذه المؤسسة. تسري النسبة ' +
      'الجديدة على الطلبات المقدَّمة منذ وقت سريانها، وتحتفظ الطلبات السابقة بنسبتها.',
    current: 'النسبة الحالية',
    defaultRate: 'الافتراضية (لم تُحدَّد نسبة)',
    effectiveFrom: 'تسري من',
    newRate: 'تحديد نسبة جديدة',
    percent: 'العمولة (٪)',
    percentHint: 'من 0 إلى 100، بمنزلتين عشريتين على الأكثر.',
    reason: 'سبب التغيير',
    reasonHint: 'يُسجَّل في السجل وفي سجل التدقيق.',
    effectiveFromHint: 'اتركه فارغًا ليسري من الآن.',
    setRate: 'تحديد النسبة',
    history: 'السجل',
    changedBy: 'بواسطة',
    changedAt: 'تاريخ التسجيل',
    percentInvalid: 'أدخل نسبة من 0 إلى 100 بمنزلتين عشريتين على الأكثر.',
    emptyTitle: 'لا يوجد نشاط مصادقة بعد',
  },

  public: {
    title: 'مصادقة شهادة',
    verifiedBy: 'تحقّق عبر PalCert',
    attestedBy: 'صادقت عليها',
    institutionVerified: 'مؤسسة موثّقة من PalCert',
    institutionUnverified: 'مؤسسة غير موثّقة حاليًا من PalCert',
    type: 'نوع المصادقة',
    certificate: 'الشهادة',
    holder: 'حامل الشهادة',
    issuer: 'الجهة المُصدِرة',
    issueDate: 'تاريخ الإصدار',
    referenceNumber: 'رقم الشهادة',
    reference: 'مرجع المصادقة',
    validFrom: 'سارية من',
    validUntil: 'سارية حتى',
    attestedAt: 'تاريخ المصادقة',
    revokedAt: 'تاريخ السحب',
    fileFormat: 'صيغة الملف',
    artifactHash: 'الملف المصادَق عليه (SHA-256)',
    attestationHash: 'بصمة المصادقة',
    notFound:
      'لا توجد مصادقة تطابق هذا الرابط. تأكّد من نسخ الرابط كاملًا، أو اطلب رابطًا جديدًا من حامل الشهادة.',
    noFileHere: 'لا يتم نشر المستند المصدق. اطلب الملف من صاحبه، ثم تحقّق منه أدناه.',
    checkFileTitle: 'فحص ملف مقابل هذه المصادقة',
    checkFileIntro: 'اختر الملف الذي تلقيته. تُحسب بصمته على هذا الجهاز، ولا يُرفع الملف.',
    chooseFile: 'الملف المراد فحصه',
    checking: 'جارٍ حساب البصمة…',
    fileMatchesOther: 'هذا الملف مصادَق عليه، ولكن بمصادقة أخرى.',
    computedHash: 'بصمة ملفك',
    validityQuestion: 'هل هذه المصادقة المؤسسية سارية المفعول حاليًا؟',
    validityTitles: {
      VALID: 'مصادقة سارية',
      EXPIRED: 'مصادقة منتهية',
      REVOKED: 'مصادقة ملغاة',
    },
    validityExplanations: {
      VALID: 'صادقت المؤسسة المذكورة هنا على هذا الملف بعينه، والمصادقة سارية المفعول حاليًا.',
      EXPIRED: 'انتهت مدة سريان هذه المصادقة، ولم تعد سارية المفعول.',
      REVOKED: 'ألغت المؤسسة هذه المصادقة، ولم تعد سارية المفعول.',
    },
    validityBadges: { VALID: 'سارية', EXPIRED: 'منتهية', REVOKED: 'ملغاة' },
    expiredOn: 'انتهت في',
    revokedOn: 'أُلغيت في',
    attestedDocument: 'المستند المصدق',
    protectedDocument: 'محمي · غير منشور',
    documentType: 'نوع المستند',
    fingerprint: 'البصمة',
    fileTypes: {
      'application/pdf': 'مستند PDF',
      'image/png': 'صورة PNG',
      'image/jpeg': 'صورة JPEG',
      'image/webp': 'صورة WebP',
    },
    otherFileType: 'ملف',
    comparisonQuestion: 'هل هذا الملف بعينه هو الذي صادقت عليه المؤسسة؟',
    fileYouSelected: 'الملف الذي اخترته',
    noFileSelected: 'لم تختر ملفًا بعد. اختر الملف الذي تلقيته لمقارنته.',
    staysLocal: 'يبقى على هذا الجهاز، ولا تُقارَن إلا بصمته.',
    fileName: 'اسم الملف',
    fileSize: 'الحجم',
    imagePreviewAlt: 'معاينة الملف الذي اخترته',
    pdfNotEmbedded: 'لا تُضمَّن ملفات PDF في هذه الصفحة.',
    openLocalPreview: 'فتح معاينة في علامة تبويب جديدة',
    noPreview: 'لا تتوفر معاينة لهذا النوع من الملفات. ومع ذلك تعتمد المقارنة على بصمته الدقيقة.',
    matchTitle: 'تم تأكيد التطابق',
    matchText: 'الملف المحدد مطابق تماماً للملف الذي صادقت عليه المؤسسة.',
    mismatchTitle: 'غير مطابق',
    mismatchText: 'الملف المحدد ليس هو الملف المشمول بهذه المصادقة.',
    mismatchHint: 'حتى إعادة مسح الورقة نفسها أو إعادة حفظ الملف تغيّر البصمة.',
    detailsTitle: 'تفاصيل المصادقة',
    technicalDetails: 'التفاصيل التقنية',
  },
};

export const ATTESTATIONS_MESSAGES: Readonly<Record<Locale, AttestationsMessages>> = { en, ar };

export function getAttestationsMessages(locale: Locale): AttestationsMessages {
  return ATTESTATIONS_MESSAGES[locale] ?? ATTESTATIONS_MESSAGES.en;
}
