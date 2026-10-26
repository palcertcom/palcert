import type { Locale } from './locales';

/**
 * Manual top-ups, EN and AR.
 *
 * Wording rules, each with a reason:
 *
 *   - Nothing is described as added to a balance until PalCert finance has
 *     verified it. Reporting a transfer is "sent for verification", never
 *     "added" — the person's own report is not evidence of payment.
 *   - PalCert credit is PalCert Balance, never a wallet. A payment method of
 *     that kind is a "mobile payment app" here for the same reason.
 *   - A rejection is explained with its reason, in plain words, and never
 *     blames the person.
 *   - Status is never carried by colour alone: every state has words.
 */
export interface ManualTopUpMessages {
  readonly nav: {
    readonly addBalance: string;
    readonly history: string;
    readonly adminMethods: string;
    readonly adminQueue: string;
    readonly request: string;
  };
  readonly hero: {
    readonly addBalance: string;
    readonly addBalanceHint: string;
    readonly pendingTitle: string;
    readonly pendingIntro: string;
    readonly viewAll: string;
    readonly draftsLabel: string;
  };
  readonly statuses: Readonly<Record<string, string>>;
  /** The same states as PalCert finance sees them — never "your balance". */
  readonly staffStatuses: Readonly<Record<string, string>>;
  readonly statusHints: Readonly<Record<string, string>>;
  readonly methodTypes: Readonly<Record<string, string>>;
  readonly rejectionReasons: Readonly<Record<string, string>>;
  readonly events: Readonly<Record<string, string>>;
  readonly fileStatuses: Readonly<Record<string, string>>;
  readonly destination: {
    readonly title: string;
    readonly recipientName: string;
    readonly mobileNumber: string;
    readonly iban: string;
    readonly bankName: string;
    readonly accountNumber: string;
    readonly branchName: string;
    readonly currency: string;
    readonly limits: (min: string, max: string) => string;
    readonly instructions: string;
    readonly copy: string;
    readonly copied: string;
    readonly copyLabel: (field: string) => string;
  };
  readonly wizard: {
    readonly title: string;
    readonly intro: string;
    readonly steps: readonly string[];
    readonly stepState: {
      readonly done: string;
      readonly current: string;
      readonly upcoming: string;
    };
    readonly chooseTitle: string;
    readonly chooseIntro: string;
    readonly noMethods: string;
    readonly noMethodsHint: string;
    readonly select: string;
    readonly sendTitle: string;
    readonly sendIntro: string;
    readonly sent: string;
    readonly detailsTitle: string;
    readonly detailsIntro: string;
    readonly amount: string;
    readonly amountHint: (currency: string) => string;
    readonly amountInvalid: string;
    readonly reference: string;
    readonly referenceHint: string;
    readonly receipt: string;
    readonly receiptHint: string;
    readonly receiptChoose: string;
    readonly receiptReplace: string;
    readonly receiptRemove: string;
    readonly receiptUploading: (percent: number) => string;
    readonly note: string;
    readonly noteHint: string;
    readonly reviewTitle: string;
    readonly reviewNotice: string;
    readonly reviewNoticeDetail: string;
    readonly submit: string;
    readonly submitting: string;
    readonly back: string;
    readonly next: string;
    readonly saveDraft: string;
    readonly resumeDraft: string;
  };
  readonly waiting: {
    readonly title: string;
    readonly submittedTitle: string;
    readonly submittedBody: string;
    readonly approvedBody: string;
    readonly rejectedBody: string;
    readonly cancelledBody: string;
    readonly draftBody: string;
    readonly summary: string;
    readonly amount: string;
    readonly reference: string;
    readonly method: string;
    readonly note: string;
    readonly rejectionNote: string;
    readonly submittedAt: string;
    readonly decidedAt: string;
    readonly timeline: string;
    readonly cancel: string;
    readonly cancelConfirmTitle: string;
    readonly cancelConfirmBody: string;
    readonly cancelConfirm: string;
    readonly keep: string;
    readonly openReceipt: string;
    readonly continueDraft: string;
    readonly backToBalance: string;
    readonly tryAgain: string;
  };
  readonly history: {
    readonly title: string;
    readonly intro: string;
    readonly empty: string;
    readonly columnRequest: string;
    readonly columnAmount: string;
    readonly columnStatus: string;
    readonly columnWhen: string;
    readonly open: string;
    readonly loadMore: string;
  };
  readonly admin: {
    readonly methodsTitle: string;
    readonly methodsIntro: string;
    readonly newMethod: string;
    readonly editMethod: string;
    readonly noMethods: string;
    readonly code: string;
    readonly codeHint: string;
    readonly type: string;
    readonly nameEn: string;
    readonly nameAr: string;
    readonly descriptionEn: string;
    readonly descriptionAr: string;
    readonly instructionsEn: string;
    readonly instructionsAr: string;
    readonly minAmount: string;
    readonly maxAmount: string;
    readonly displayOrder: string;
    readonly enabled: string;
    readonly disabled: string;
    readonly archived: string;
    readonly enable: string;
    readonly disable: string;
    readonly archive: string;
    readonly archiveConfirmTitle: string;
    readonly archiveConfirmBody: string;
    readonly disableConfirmBody: string;
    readonly enableConfirmBody: string;
    readonly save: string;
    readonly saving: string;
    readonly cancel: string;
    readonly saved: string;
    readonly logo: string;
    readonly logoHint: string;
    readonly logoUpload: string;
    readonly logoRemove: string;
    readonly logoNone: string;
    readonly referenced: string;
    readonly editWarning: string;
    readonly queueTitle: string;
    readonly queueIntro: string;
    readonly pendingTotals: string;
    readonly filterStatus: string;
    readonly filterMethod: string;
    readonly filterCurrency: string;
    readonly filterReference: string;
    readonly applyFilters: string;
    readonly all: string;
    readonly emptyQueue: string;
    readonly columnCustomer: string;
    readonly columnMethod: string;
    readonly columnReceipt: string;
    readonly hasReceipt: string;
    readonly noReceipt: string;
    readonly requestTitle: string;
    readonly customer: string;
    readonly reportedTransfer: string;
    readonly destinationSnapshot: string;
    readonly snapshotHint: string;
    readonly receiptTitle: string;
    readonly viewReceipt: string;
    readonly receiptAudited: string;
    readonly startReview: string;
    readonly reviewStarted: (name: string) => string;
    readonly approve: string;
    readonly approveTitle: string;
    readonly approveBody: (amount: string, reference: string, method: string) => string;
    readonly approveConfirm: string;
    readonly approveCheckbox: string;
    readonly reject: string;
    readonly rejectTitle: string;
    readonly rejectReason: string;
    readonly rejectNote: string;
    readonly rejectNoteHint: string;
    readonly rejectConfirm: string;
    readonly decisionLocked: string;
    readonly credited: string;
    readonly readOnly: string;
    readonly unknownPerson: string;
  };
  /** Assigning finance staff to a payment method (ADR-0148). */
  readonly reviewers: {
    readonly title: string;
    readonly hint: string;
    readonly assign: string;
    readonly label: string;
    readonly none: string;
    readonly noneHint: string;
    readonly required: string;
    readonly emailVerified: string;
    readonly emailNotVerified: string;
    readonly ineligible: string;
    readonly ineligibleHint: string;
    readonly noCandidates: string;
    readonly roles: Readonly<Record<string, string>>;
  };
  /** The administrator's "no email arrived" panel on a top-up. */
  readonly delivery: {
    readonly title: string;
    readonly intro: string;
    readonly routing: Readonly<Record<string, string>>;
    readonly pending: string;
    readonly noReviewer: string;
    readonly caption: string;
    readonly columns: {
      readonly reviewer: string;
      readonly address: string;
      readonly inApp: string;
      readonly email: string;
      readonly reason: string;
    };
    readonly inApp: { readonly delivered: string; readonly read: string; readonly unread: string };
    readonly emailStatuses: Readonly<Record<string, string>>;
    readonly skipReasons: Readonly<Record<string, string>>;
    readonly assigned: string;
    readonly notNotifiedTitle: string;
    readonly notNotifiedReason: string;
    readonly none: string;
  };
  readonly confirm: {
    readonly cancel: string;
    readonly close: string;
    readonly optional: string;
    readonly pending: string;
    readonly invalid: string;
  };
  readonly errors: Readonly<Record<string, string>>;
  readonly genericError: string;
  readonly loading: string;
}

const EN: ManualTopUpMessages = {
  nav: {
    addBalance: 'Add balance',
    history: 'Bank and app transfers',
    adminMethods: 'Payment methods',
    adminQueue: 'Top-up reviews',
    request: 'Transfer',
  },
  hero: {
    addBalance: 'Add balance',
    addBalanceHint: 'Send a bank or app transfer, then tell PalCert about it.',
    pendingTitle: 'Transfers waiting for verification',
    pendingIntro:
      'PalCert finance checks each transfer against the receiving account before adding it.',
    viewAll: 'All transfers',
    draftsLabel: 'Not sent yet',
  },
  statuses: {
    DRAFT: 'Not sent yet',
    PENDING_REVIEW: 'Waiting for verification',
    APPROVED: 'Added to your balance',
    REJECTED: 'Not verified',
    CANCELLED: 'Cancelled',
  },
  staffStatuses: {
    DRAFT: 'Draft',
    PENDING_REVIEW: 'Waiting for verification',
    APPROVED: 'Approved and credited',
    REJECTED: 'Rejected',
    CANCELLED: 'Cancelled by customer',
  },
  statusHints: {
    DRAFT: 'Finish the details and send it for verification.',
    PENDING_REVIEW: 'PalCert finance has your report and will check the receiving account.',
    APPROVED: 'Finance verified the transfer and added it to your balance.',
    REJECTED: 'Finance could not verify the transfer. Nothing was added.',
    CANCELLED: 'This report was cancelled before it was reviewed.',
  },
  methodTypes: {
    MOBILE_WALLET: 'Mobile payment app',
    BANK_ACCOUNT: 'Bank account',
    OTHER: 'Other',
  },
  rejectionReasons: {
    REFERENCE_NOT_FOUND: 'No transfer with this reference was found on the receiving account.',
    AMOUNT_MISMATCH: 'The amount received does not match the amount reported.',
    DUPLICATE_REFERENCE: 'This transfer has already been reported.',
    RECEIPT_UNCLEAR: 'The receipt could not be read clearly enough to verify the transfer.',
    PAYMENT_NOT_RECEIVED: 'The payment has not arrived on the receiving account.',
    INVALID_PAYMENT_METHOD: 'The transfer was not made to the selected payment method.',
    OTHER: 'Another reason — see the note from PalCert finance.',
  },
  events: {
    CREATED: 'Started',
    UPDATED: 'Details changed',
    RECEIPT_ATTACHED: 'Receipt attached',
    SUBMITTED: 'Sent for verification',
    REVIEW_STARTED: 'Finance started checking',
    APPROVED: 'Verified and added',
    REJECTED: 'Not verified',
    CANCELLED: 'Cancelled',
  },
  fileStatuses: {
    AWAITING_UPLOAD: 'Waiting for the file',
    UPLOADED: 'Checking the file…',
    VALIDATING: 'Checking the file…',
    SCANNING: 'Checking the file…',
    READY: 'Receipt attached',
    REJECTED: 'This file could not be accepted',
    FAILED: 'This file could not be checked',
    UPLOAD_EXPIRED: 'The upload took too long',
  },
  destination: {
    title: 'Send your transfer to',
    recipientName: 'Recipient name',
    mobileNumber: 'Phone number',
    iban: 'IBAN',
    bankName: 'Bank',
    accountNumber: 'Account number',
    branchName: 'Branch',
    currency: 'Currency',
    limits: (min, max) => `Between ${min} and ${max} per transfer.`,
    instructions: 'Instructions',
    copy: 'Copy',
    copied: 'Copied',
    copyLabel: (field) => `Copy ${field}`,
  },
  wizard: {
    title: 'Add balance by transfer',
    intro:
      'Send money from your bank or payment app to PalCert, then report it here. PalCert finance ' +
      'checks the receiving account and adds the amount to your balance once it is verified.',
    steps: ['Method', 'Send', 'Details', 'Review'],
    stepState: { done: 'completed', current: 'current step', upcoming: 'not started' },
    chooseTitle: 'How will you pay?',
    chooseIntro: 'Choose where you will send the transfer.',
    noMethods: 'No transfer methods are available right now.',
    noMethodsHint: 'Please check again later.',
    select: 'Use this method',
    sendTitle: 'Send the transfer',
    sendIntro:
      'Use these details exactly. Keep the reference your bank or app gives you — you will need it next.',
    sent: 'I have sent the transfer',
    detailsTitle: 'Tell us about your transfer',
    detailsIntro: 'Enter what you sent, exactly as your bank or app shows it.',
    amount: 'Amount sent',
    amountHint: (currency) => `In ${currency}, for example 150.00.`,
    amountInvalid: 'Enter an amount such as 150.00.',
    reference: 'Transfer reference',
    referenceHint: 'The reference or transaction number on your bank or app confirmation.',
    receipt: 'Receipt (optional)',
    receiptHint:
      'A screenshot or PDF of the confirmation helps finance verify faster. PDF, PNG, JPEG or WebP, up to 5 MB. Only you and PalCert finance can see it.',
    receiptChoose: 'Choose a file',
    receiptReplace: 'Replace',
    receiptRemove: 'Remove',
    receiptUploading: (percent) => `Uploading… ${percent}%`,
    note: 'Note for PalCert finance (optional)',
    noteHint: 'Anything that helps match your transfer, such as the sender’s name.',
    reviewTitle: 'Check and send for verification',
    reviewNotice: 'Your balance does not change yet.',
    reviewNoticeDetail:
      'PalCert finance will check the receiving account for this transfer. When it is verified, the ' +
      'amount is added to your balance and you will be notified. If it cannot be verified, you will be told why.',
    submit: 'Send for verification',
    submitting: 'Sending…',
    back: 'Back',
    next: 'Continue',
    saveDraft: 'Save and finish later',
    resumeDraft: 'Continue this transfer',
  },
  waiting: {
    title: 'Transfer',
    submittedTitle: 'Sent for verification',
    submittedBody:
      'PalCert finance has your report. Your balance will change only after they verify the transfer — you will be notified either way.',
    approvedBody: 'PalCert finance verified this transfer and added it to your balance.',
    rejectedBody:
      'PalCert finance could not verify this transfer, so nothing was added to your balance.',
    cancelledBody: 'You cancelled this report before it was reviewed.',
    draftBody: 'This transfer has not been sent for verification yet.',
    summary: 'What you reported',
    amount: 'Amount',
    reference: 'Reference',
    method: 'Sent to',
    note: 'Your note',
    rejectionNote: 'Note from PalCert finance',
    submittedAt: 'Sent',
    decidedAt: 'Decided',
    timeline: 'History',
    cancel: 'Cancel this report',
    cancelConfirmTitle: 'Cancel this report?',
    cancelConfirmBody:
      'PalCert finance will not check it. If you did send money, you can report it again.',
    cancelConfirm: 'Cancel report',
    keep: 'Keep it',
    openReceipt: 'Open receipt',
    continueDraft: 'Continue',
    backToBalance: 'Back to balance',
    tryAgain: 'Report a transfer',
  },
  history: {
    title: 'Bank and app transfers',
    intro: 'Every transfer you have reported, and what PalCert finance decided.',
    empty: 'You have not reported any transfers.',
    columnRequest: 'Sent to',
    columnAmount: 'Amount',
    columnStatus: 'Status',
    columnWhen: 'Reported',
    open: 'Open',
    loadMore: 'Show older',
  },
  admin: {
    methodsTitle: 'Payment methods',
    methodsIntro:
      'Where customers are asked to send transfers. Changes apply to new transfers only — each report keeps the details its sender was shown.',
    newMethod: 'New method',
    editMethod: 'Edit method',
    noMethods: 'No payment methods yet.',
    code: 'Code',
    codeHint: 'A permanent identifier such as JAWWAL_PAY. It cannot change later.',
    type: 'Type',
    nameEn: 'Name (English)',
    nameAr: 'Name (Arabic)',
    descriptionEn: 'Description (English)',
    descriptionAr: 'Description (Arabic)',
    instructionsEn: 'Instructions (English)',
    instructionsAr: 'Instructions (Arabic)',
    minAmount: 'Minimum per transfer',
    maxAmount: 'Maximum per transfer',
    displayOrder: 'Display order',
    enabled: 'Offered',
    disabled: 'Not offered',
    archived: 'Archived',
    enable: 'Offer to customers',
    disable: 'Stop offering',
    archive: 'Archive',
    archiveConfirmTitle: 'Archive this method permanently?',
    archiveConfirmBody:
      'Customers will no longer see it and it cannot be offered again. Transfers already reported keep their details.',
    disableConfirmBody:
      'Customers will stop seeing it. Unsent drafts against it cannot be sent; reports already sent stay reviewable.',
    enableConfirmBody: 'Customers will see this method and its details straight away.',
    save: 'Save',
    saving: 'Saving…',
    cancel: 'Cancel',
    saved: 'Saved.',
    logo: 'Logo',
    logoHint:
      'PNG, JPEG or WebP, up to 1 MB. It is checked before customers see it. SVG is not accepted.',
    logoUpload: 'Upload logo',
    logoRemove: 'Remove logo',
    logoNone: 'No logo',
    referenced: 'Used by reported transfers',
    editWarning: 'Check every detail. Customers send real money to what you publish here.',
    queueTitle: 'Top-up reviews',
    queueIntro:
      'Reported transfers, oldest first. Verify each against the receiving account before approving.',
    pendingTotals: 'Waiting for verification',
    filterStatus: 'Status',
    filterMethod: 'Method',
    filterCurrency: 'Currency',
    filterReference: 'Reference',
    applyFilters: 'Apply',
    all: 'All',
    emptyQueue: 'Nothing matches.',
    columnCustomer: 'Customer',
    columnMethod: 'Method',
    columnReceipt: 'Receipt',
    hasReceipt: 'Attached',
    noReceipt: 'None',
    requestTitle: 'Reported transfer',
    customer: 'Customer',
    reportedTransfer: 'Reported transfer',
    destinationSnapshot: 'Where the customer was told to pay',
    snapshotHint: 'Frozen when the report started. Later edits to the method do not change it.',
    receiptTitle: 'Receipt',
    viewReceipt: 'View receipt',
    receiptAudited: 'Opening the receipt is recorded.',
    startReview: 'Start review',
    reviewStarted: (name) => `Under review by ${name}. The customer can no longer cancel.`,
    approve: 'Approve and credit',
    approveTitle: 'Approve this transfer?',
    approveBody: (amount, reference, method) =>
      `This adds ${amount} to the customer’s balance as cash, for transfer ${reference} to ${method}. It cannot be undone here.`,
    approveConfirm: 'Approve and credit',
    approveCheckbox: 'I found this exact transfer on the receiving account.',
    reject: 'Reject',
    rejectTitle: 'Reject this transfer?',
    rejectReason: 'Reason',
    rejectNote: 'Note to the customer',
    rejectNoteHint: 'Shown on the customer’s page, not in email. Required for “other”.',
    rejectConfirm: 'Reject',
    decisionLocked: 'This transfer has been decided.',
    credited: 'Credited to the customer’s cash balance.',
    readOnly: 'You can read this request. Deciding it needs PalCert finance permissions.',
    unknownPerson: 'Unknown',
  },
  reviewers: {
    title: 'Top-up reviewers',
    hint:
      'Finance staff who receive the review notification and email for top-ups sent through ' +
      'this method. Only PalCert staff who can review manual top-ups are listed.',
    assign: 'Assign reviewer',
    label: 'Reviewers',
    none: 'No reviewers assigned',
    noneHint: 'Every PalCert finance reviewer is notified until someone is assigned.',
    required:
      'Assign at least one finance reviewer before offering this payment method to customers.',
    emailVerified: 'Email verified',
    emailNotVerified: 'Email not verified',
    ineligible: 'No longer eligible',
    ineligibleHint: 'Lost the finance review permission, so is not notified.',
    noCandidates:
      'No PalCert staff member can review manual top-ups yet. Give someone the Finance role first.',
    roles: { PALCERT_FINANCE: 'Finance' },
  },
  delivery: {
    title: 'Review notifications',
    intro:
      'Who was notified about this top-up, and what happened to each notification. Visible to ' +
      'administrators only.',
    routing: {
      METHOD_REVIEWERS: 'Sent to this payment method’s assigned reviewers.',
      FALLBACK_NO_ELIGIBLE:
        'No assigned reviewer still had the review permission, so every finance reviewer was notified.',
      GLOBAL_NOT_CONFIGURED:
        'No reviewers are assigned to this payment method, so every finance reviewer was notified.',
    },
    pending: 'The notifications have not been sent yet.',
    noReviewer:
      'Nobody could be notified: no PalCert staff member holds the finance review permission.',
    caption: 'Notifications for this top-up',
    columns: {
      reviewer: 'Reviewer',
      address: 'Address',
      inApp: 'In PalCert',
      email: 'Email',
      reason: 'Reason',
    },
    inApp: { delivered: 'Delivered', read: 'Read', unread: 'Not read yet' },
    emailStatuses: {
      PENDING: 'Waiting to send',
      SENDING: 'Sending',
      DELIVERED: 'Delivered',
      SKIPPED: 'Not sent',
      FAILED_RETRYABLE: 'Failed, will retry',
      FAILED_PERMANENT: 'Failed',
    },
    skipReasons: {
      NO_VERIFIED_EMAIL: 'No verified email address',
      PREFERENCE_DISABLED: 'The reviewer turned this email off',
      AUTHORIZATION_REVOKED: 'No longer holds the review permission',
      CHANNEL_DISABLED: 'Email sending is switched off',
      ACCOUNT_INELIGIBLE: 'The account is not active',
    },
    assigned: 'Assigned',
    notNotifiedTitle: 'Assigned but not notified',
    notNotifiedReason: 'Does not currently hold the finance review permission.',
    none: '—',
  },
  errors: {
    MANUAL_PAYMENT_METHOD_NOT_FOUND: 'That payment method is not available.',
    MANUAL_PAYMENT_METHOD_INVALID: 'Some details are missing or not valid for this kind of method.',
    MANUAL_PAYMENT_METHOD_CODE_TAKEN: 'Another method already uses that code.',
    MANUAL_PAYMENT_METHOD_CONFLICT: 'Somebody else changed this method. Reload it and try again.',
    MANUAL_PAYMENT_METHOD_REVIEWER_REQUIRED:
      'Assign at least one finance reviewer before offering this payment method to customers.',
    MANUAL_PAYMENT_METHOD_REVIEWER_INELIGIBLE:
      'Only active PalCert staff who can review manual top-ups can be assigned.',
    MANUAL_PAYMENT_METHOD_UNAVAILABLE:
      'This payment method is no longer available. Your details have been kept — start again with another method.',
    MANUAL_TOPUP_NOT_FOUND: 'That transfer could not be found.',
    MANUAL_TOPUP_INVALID: 'Enter the amount and the transfer reference first.',
    MANUAL_TOPUP_AMOUNT_OUT_OF_RANGE: 'That amount is outside what this method accepts.',
    MANUAL_TOPUP_REFERENCE_INVALID:
      'Enter the reference exactly as your bank or app shows it: 4 to 64 letters and digits.',
    MANUAL_TOPUP_REFERENCE_UNAVAILABLE:
      'This transfer reference cannot be used for this method. Check it, or contact PalCert support if you believe it is correct.',
    MANUAL_TOPUP_TRANSITION_INVALID: 'This transfer can no longer be changed that way.',
    MANUAL_TOPUP_ALREADY_DECIDED: 'Another reviewer has already decided this transfer.',
    MANUAL_TOPUP_CONFIRMATION_REQUIRED: 'Confirm the exact amount before approving.',
    MANUAL_TOPUP_TOO_MANY_OPEN:
      'You already have several transfers in progress. Wait for them to be reviewed, or cancel one you no longer need.',
    MANUAL_TOPUP_FILE_NOT_FOUND: 'That file could not be found.',
    MANUAL_TOPUP_FILE_NOT_READY:
      'The receipt is still being checked, or could not be accepted. Wait a moment, or remove it.',
    MANUAL_TOPUP_FILE_TYPE_NOT_ALLOWED: 'That kind of file is not accepted here.',
    FILE_TOO_LARGE: 'That file is too large.',
    FORBIDDEN: 'You cannot do that here.',
    REAUTHENTICATION_REQUIRED: 'Please sign in again to confirm it is you.',
    RATE_LIMITED: 'Too many attempts. Please wait a little and try again.',
    VALIDATION_FAILED: 'Some details are not valid.',
    UNAUTHENTICATED: 'Please sign in again.',
  },
  confirm: {
    cancel: 'Cancel',
    close: 'Close',
    optional: 'optional',
    pending: 'Working…',
    invalid: 'required',
  },
  genericError: 'Something went wrong. Please try again.',
  loading: 'Loading…',
};

const AR: ManualTopUpMessages = {
  nav: {
    addBalance: 'إضافة رصيد',
    history: 'التحويلات البنكية وعبر التطبيقات',
    adminMethods: 'طرق الدفع',
    adminQueue: 'مراجعة الشحن',
    request: 'تحويل',
  },
  hero: {
    addBalance: 'إضافة رصيد',
    addBalanceHint: 'أرسل تحويلًا بنكيًا أو عبر تطبيق، ثم أبلغ PalCert به.',
    pendingTitle: 'تحويلات بانتظار التحقق',
    pendingIntro: 'يتحقق فريق المالية في PalCert من كل تحويل في الحساب المستلم قبل إضافته.',
    viewAll: 'كل التحويلات',
    draftsLabel: 'لم يُرسَل بعد',
  },
  statuses: {
    DRAFT: 'لم يُرسَل بعد',
    PENDING_REVIEW: 'بانتظار التحقق',
    APPROVED: 'أُضيف إلى رصيدك',
    REJECTED: 'لم يُتحقَّق منه',
    CANCELLED: 'أُلغي',
  },
  staffStatuses: {
    DRAFT: 'مسودة',
    PENDING_REVIEW: 'بانتظار التحقق',
    APPROVED: 'تمت الموافقة والإضافة',
    REJECTED: 'مرفوض',
    CANCELLED: 'ألغاه العميل',
  },
  statusHints: {
    DRAFT: 'أكمل التفاصيل وأرسله للتحقق.',
    PENDING_REVIEW: 'وصل بلاغك إلى فريق المالية، وسيتحقق من الحساب المستلم.',
    APPROVED: 'تحقق فريق المالية من التحويل وأضافه إلى رصيدك.',
    REJECTED: 'تعذّر على فريق المالية التحقق من التحويل، ولم يُضَف شيء.',
    CANCELLED: 'أُلغي هذا البلاغ قبل مراجعته.',
  },
  methodTypes: {
    MOBILE_WALLET: 'تطبيق دفع عبر الجوال',
    BANK_ACCOUNT: 'حساب بنكي',
    OTHER: 'أخرى',
  },
  rejectionReasons: {
    REFERENCE_NOT_FOUND: 'لم يُعثر على تحويل بهذا المرجع في الحساب المستلم.',
    AMOUNT_MISMATCH: 'المبلغ المستلم لا يطابق المبلغ المُبلَّغ عنه.',
    DUPLICATE_REFERENCE: 'تم الإبلاغ عن هذا التحويل من قبل.',
    RECEIPT_UNCLEAR: 'تعذّرت قراءة الإيصال بوضوح كافٍ للتحقق من التحويل.',
    PAYMENT_NOT_RECEIVED: 'لم تصل الدفعة إلى الحساب المستلم بعد.',
    INVALID_PAYMENT_METHOD: 'لم يُجرَ التحويل إلى طريقة الدفع المختارة.',
    OTHER: 'سبب آخر — راجع ملاحظة فريق المالية.',
  },
  events: {
    CREATED: 'بدأ',
    UPDATED: 'عُدّلت التفاصيل',
    RECEIPT_ATTACHED: 'أُرفق الإيصال',
    SUBMITTED: 'أُرسل للتحقق',
    REVIEW_STARTED: 'بدأ فريق المالية التحقق',
    APPROVED: 'تم التحقق والإضافة',
    REJECTED: 'لم يُتحقَّق منه',
    CANCELLED: 'أُلغي',
  },
  fileStatuses: {
    AWAITING_UPLOAD: 'بانتظار الملف',
    UPLOADED: 'جارٍ فحص الملف…',
    VALIDATING: 'جارٍ فحص الملف…',
    SCANNING: 'جارٍ فحص الملف…',
    READY: 'أُرفق الإيصال',
    REJECTED: 'تعذّر قبول هذا الملف',
    FAILED: 'تعذّر فحص هذا الملف',
    UPLOAD_EXPIRED: 'استغرق الرفع وقتًا أطول من المسموح',
  },
  destination: {
    title: 'أرسل تحويلك إلى',
    recipientName: 'اسم المستلم',
    mobileNumber: 'رقم الجوال',
    iban: 'رقم الحساب الدولي (IBAN)',
    bankName: 'البنك',
    accountNumber: 'رقم الحساب',
    branchName: 'الفرع',
    currency: 'العملة',
    limits: (min, max) => `من ${min} إلى ${max} لكل تحويل.`,
    instructions: 'التعليمات',
    copy: 'نسخ',
    copied: 'تم النسخ',
    copyLabel: (field) => `نسخ ${field}`,
  },
  wizard: {
    title: 'إضافة رصيد بتحويل',
    intro:
      'أرسل المال من بنكك أو تطبيق الدفع إلى PalCert، ثم أبلغ عنه هنا. يتحقق فريق المالية من الحساب ' +
      'المستلم ويضيف المبلغ إلى رصيدك بعد التحقق منه.',
    steps: ['الطريقة', 'الإرسال', 'التفاصيل', 'المراجعة'],
    stepState: { done: 'مكتملة', current: 'الخطوة الحالية', upcoming: 'لم تبدأ' },
    chooseTitle: 'كيف ستدفع؟',
    chooseIntro: 'اختر الجهة التي سترسل إليها التحويل.',
    noMethods: 'لا تتوفر طرق تحويل حاليًا.',
    noMethodsHint: 'يُرجى المحاولة لاحقًا.',
    select: 'استخدام هذه الطريقة',
    sendTitle: 'أرسل التحويل',
    sendIntro:
      'استخدم هذه التفاصيل كما هي تمامًا. احتفظ بالمرجع الذي يعطيك إياه البنك أو التطبيق، فستحتاجه في الخطوة التالية.',
    sent: 'لقد أرسلت التحويل',
    detailsTitle: 'أخبرنا عن تحويلك',
    detailsIntro: 'أدخل ما أرسلته كما يظهر تمامًا في البنك أو التطبيق.',
    amount: 'المبلغ المُرسَل',
    amountHint: (currency) => `بعملة ${currency}، مثل 150.00.`,
    amountInvalid: 'أدخل مبلغًا مثل 150.00.',
    reference: 'مرجع التحويل',
    referenceHint: 'رقم المرجع أو رقم العملية في تأكيد البنك أو التطبيق.',
    receipt: 'الإيصال (اختياري)',
    receiptHint:
      'لقطة شاشة أو ملف PDF للتأكيد تساعد فريق المالية على التحقق أسرع. PDF أو PNG أو JPEG أو WebP، حتى 5 ميغابايت. لا يراه إلا أنت وفريق المالية في PalCert.',
    receiptChoose: 'اختيار ملف',
    receiptReplace: 'استبدال',
    receiptRemove: 'إزالة',
    receiptUploading: (percent) => `جارٍ الرفع… ${percent}%`,
    note: 'ملاحظة لفريق المالية (اختياري)',
    noteHint: 'أي شيء يساعد على مطابقة تحويلك، مثل اسم المُرسِل.',
    reviewTitle: 'راجع وأرسل للتحقق',
    reviewNotice: 'لن يتغير رصيدك الآن.',
    reviewNoticeDetail:
      'سيتحقق فريق المالية في PalCert من وصول هذا التحويل إلى الحساب المستلم. عند التحقق منه يُضاف المبلغ ' +
      'إلى رصيدك وستصلك رسالة بذلك. وإن تعذّر التحقق منه فستعرف السبب.',
    submit: 'إرسال للتحقق',
    submitting: 'جارٍ الإرسال…',
    back: 'رجوع',
    next: 'متابعة',
    saveDraft: 'حفظ والإكمال لاحقًا',
    resumeDraft: 'متابعة هذا التحويل',
  },
  waiting: {
    title: 'تحويل',
    submittedTitle: 'أُرسل للتحقق',
    submittedBody:
      'وصل بلاغك إلى فريق المالية في PalCert. لن يتغير رصيدك إلا بعد التحقق من التحويل، وستصلك رسالة في الحالتين.',
    approvedBody: 'تحقق فريق المالية في PalCert من هذا التحويل وأضافه إلى رصيدك.',
    rejectedBody:
      'تعذّر على فريق المالية في PalCert التحقق من هذا التحويل، لذلك لم يُضَف شيء إلى رصيدك.',
    cancelledBody: 'ألغيت هذا البلاغ قبل مراجعته.',
    draftBody: 'لم يُرسَل هذا التحويل للتحقق بعد.',
    summary: 'ما أبلغت عنه',
    amount: 'المبلغ',
    reference: 'المرجع',
    method: 'أُرسل إلى',
    note: 'ملاحظتك',
    rejectionNote: 'ملاحظة من فريق المالية',
    submittedAt: 'أُرسل',
    decidedAt: 'البتّ',
    timeline: 'السجل',
    cancel: 'إلغاء هذا البلاغ',
    cancelConfirmTitle: 'إلغاء هذا البلاغ؟',
    cancelConfirmBody:
      'لن يتحقق منه فريق المالية. إن كنت قد أرسلت المال فيمكنك الإبلاغ عنه مجددًا.',
    cancelConfirm: 'إلغاء البلاغ',
    keep: 'إبقاؤه',
    openReceipt: 'فتح الإيصال',
    continueDraft: 'متابعة',
    backToBalance: 'العودة إلى الرصيد',
    tryAgain: 'الإبلاغ عن تحويل',
  },
  history: {
    title: 'التحويلات البنكية وعبر التطبيقات',
    intro: 'كل تحويل أبلغت عنه، وما قرره فريق المالية في PalCert.',
    empty: 'لم تُبلغ عن أي تحويل بعد.',
    columnRequest: 'أُرسل إلى',
    columnAmount: 'المبلغ',
    columnStatus: 'الحالة',
    columnWhen: 'تاريخ البلاغ',
    open: 'فتح',
    loadMore: 'عرض الأقدم',
  },
  admin: {
    methodsTitle: 'طرق الدفع',
    methodsIntro:
      'الجهات التي يُطلب من العملاء إرسال تحويلاتهم إليها. تسري التعديلات على التحويلات الجديدة فقط، ويحتفظ كل بلاغ بالتفاصيل التي عُرضت على مُرسِله.',
    newMethod: 'طريقة جديدة',
    editMethod: 'تعديل الطريقة',
    noMethods: 'لا توجد طرق دفع بعد.',
    code: 'الرمز',
    codeHint: 'معرّف دائم مثل JAWWAL_PAY، لا يمكن تغييره لاحقًا.',
    type: 'النوع',
    nameEn: 'الاسم (بالإنجليزية)',
    nameAr: 'الاسم (بالعربية)',
    descriptionEn: 'الوصف (بالإنجليزية)',
    descriptionAr: 'الوصف (بالعربية)',
    instructionsEn: 'التعليمات (بالإنجليزية)',
    instructionsAr: 'التعليمات (بالعربية)',
    minAmount: 'الحد الأدنى لكل تحويل',
    maxAmount: 'الحد الأعلى لكل تحويل',
    displayOrder: 'ترتيب العرض',
    enabled: 'معروضة',
    disabled: 'غير معروضة',
    archived: 'مؤرشفة',
    enable: 'عرضها على العملاء',
    disable: 'إيقاف عرضها',
    archive: 'أرشفة',
    archiveConfirmTitle: 'أرشفة هذه الطريقة نهائيًا؟',
    archiveConfirmBody:
      'لن يراها العملاء بعد الآن ولا يمكن عرضها مجددًا. تحتفظ التحويلات المُبلَّغ عنها بتفاصيلها.',
    disableConfirmBody:
      'سيتوقف العملاء عن رؤيتها. لا يمكن إرسال المسودات المرتبطة بها، وتبقى البلاغات المُرسَلة قابلة للمراجعة.',
    enableConfirmBody: 'سيرى العملاء هذه الطريقة وتفاصيلها فورًا.',
    save: 'حفظ',
    saving: 'جارٍ الحفظ…',
    cancel: 'إلغاء',
    saved: 'تم الحفظ.',
    logo: 'الشعار',
    logoHint: 'PNG أو JPEG أو WebP، حتى 1 ميغابايت. يُفحص قبل أن يراه العملاء. لا يُقبل SVG.',
    logoUpload: 'رفع الشعار',
    logoRemove: 'إزالة الشعار',
    logoNone: 'لا يوجد شعار',
    referenced: 'مستخدمة في تحويلات مُبلَّغ عنها',
    editWarning: 'راجع كل التفاصيل. يرسل العملاء أموالًا حقيقية إلى ما تنشره هنا.',
    queueTitle: 'مراجعة الشحن',
    queueIntro:
      'التحويلات المُبلَّغ عنها، الأقدم أولًا. تحقق من كل منها في الحساب المستلم قبل الموافقة.',
    pendingTotals: 'بانتظار التحقق',
    filterStatus: 'الحالة',
    filterMethod: 'الطريقة',
    filterCurrency: 'العملة',
    filterReference: 'المرجع',
    applyFilters: 'تطبيق',
    all: 'الكل',
    emptyQueue: 'لا توجد نتائج مطابقة.',
    columnCustomer: 'العميل',
    columnMethod: 'الطريقة',
    columnReceipt: 'الإيصال',
    hasReceipt: 'مرفق',
    noReceipt: 'لا يوجد',
    requestTitle: 'تحويل مُبلَّغ عنه',
    customer: 'العميل',
    reportedTransfer: 'التحويل المُبلَّغ عنه',
    destinationSnapshot: 'الجهة التي طُلب من العميل الدفع إليها',
    snapshotHint: 'ثُبّتت عند بدء البلاغ، ولا تغيّرها التعديلات اللاحقة على الطريقة.',
    receiptTitle: 'الإيصال',
    viewReceipt: 'عرض الإيصال',
    receiptAudited: 'يُسجَّل فتح الإيصال.',
    startReview: 'بدء المراجعة',
    reviewStarted: (name) => `قيد المراجعة لدى ${name}. لم يعد بإمكان العميل الإلغاء.`,
    approve: 'الموافقة والإضافة',
    approveTitle: 'الموافقة على هذا التحويل؟',
    approveBody: (amount, reference, method) =>
      `سيُضاف ${amount} إلى رصيد العميل النقدي، عن التحويل ${reference} إلى ${method}. لا يمكن التراجع عن ذلك من هنا.`,
    approveConfirm: 'الموافقة والإضافة',
    approveCheckbox: 'وجدت هذا التحويل بعينه في الحساب المستلم.',
    reject: 'رفض',
    rejectTitle: 'رفض هذا التحويل؟',
    rejectReason: 'السبب',
    rejectNote: 'ملاحظة للعميل',
    rejectNoteHint: 'تظهر في صفحة العميل وليس في البريد. مطلوبة عند اختيار "أخرى".',
    rejectConfirm: 'رفض',
    decisionLocked: 'تم البتّ في هذا التحويل.',
    credited: 'أُضيف إلى الرصيد النقدي للعميل.',
    readOnly: 'يمكنك قراءة هذا الطلب. يتطلب البتّ فيه صلاحيات فريق المالية في PalCert.',
    unknownPerson: 'غير معروف',
  },
  reviewers: {
    title: 'مسؤولو مراجعة عمليات الشحن',
    hint:
      'موظفو المالية الذين يتلقون إشعار المراجعة والبريد الإلكتروني لعمليات الشحن المرسلة عبر ' +
      'طريقة الدفع هذه. لا تظهر هنا إلا أسماء موظفي PalCert القادرين على مراجعة عمليات الشحن اليدوية.',
    assign: 'تعيين مسؤول مراجعة',
    label: 'مسؤولو المراجعة',
    none: 'لم يتم تعيين مسؤولين للمراجعة',
    noneHint: 'يُرسَل الإشعار إلى جميع مسؤولي المراجعة في فريق المالية إلى أن يُعيَّن أحد.',
    required:
      'عيّن مسؤولاً مالياً واحداً على الأقل لمراجعة عمليات الشحن قبل إتاحة طريقة الدفع للعملاء.',
    emailVerified: 'البريد الإلكتروني موثّق',
    emailNotVerified: 'البريد الإلكتروني غير موثّق',
    ineligible: 'لم يعد مؤهلاً',
    ineligibleHint: 'فقد صلاحية المراجعة المالية، ولذلك لا يصله الإشعار.',
    noCandidates:
      'لا يوجد بعد موظف في PalCert يملك صلاحية مراجعة عمليات الشحن اليدوية. امنح دور المالية لأحد الموظفين أولاً.',
    roles: { PALCERT_FINANCE: 'المالية' },
  },
  delivery: {
    title: 'إشعارات المراجعة',
    intro: 'من أُشعِر بعملية الشحن هذه، وما الذي حدث لكل إشعار. يظهر هذا القسم للمشرفين فقط.',
    routing: {
      METHOD_REVIEWERS: 'أُرسل إلى مسؤولي المراجعة المعيّنين لطريقة الدفع هذه.',
      FALLBACK_NO_ELIGIBLE:
        'لم يعد لدى أي مسؤول معيّن صلاحية المراجعة، لذلك أُشعر جميع مسؤولي المراجعة في فريق المالية.',
      GLOBAL_NOT_CONFIGURED:
        'لم يُعيَّن مسؤولو مراجعة لطريقة الدفع هذه، لذلك أُشعر جميع مسؤولي المراجعة في فريق المالية.',
    },
    pending: 'لم تُرسَل الإشعارات بعد.',
    noReviewer: 'تعذّر إشعار أي أحد: لا يملك أي موظف في PalCert صلاحية المراجعة المالية.',
    caption: 'إشعارات عملية الشحن هذه',
    columns: {
      reviewer: 'المسؤول',
      address: 'العنوان',
      inApp: 'داخل PalCert',
      email: 'رسالة البريد',
      reason: 'السبب',
    },
    inApp: { delivered: 'وصل', read: 'مقروء', unread: 'لم يُقرأ بعد' },
    emailStatuses: {
      PENDING: 'بانتظار الإرسال',
      SENDING: 'جارٍ الإرسال',
      DELIVERED: 'أُرسلت',
      SKIPPED: 'لم تُرسَل',
      FAILED_RETRYABLE: 'فشلت، وستُعاد المحاولة',
      FAILED_PERMANENT: 'فشلت',
    },
    skipReasons: {
      NO_VERIFIED_EMAIL: 'لا يوجد بريد إلكتروني موثّق',
      PREFERENCE_DISABLED: 'أوقف المسؤول هذه الرسائل',
      AUTHORIZATION_REVOKED: 'لم يعد يملك صلاحية المراجعة',
      CHANNEL_DISABLED: 'إرسال البريد الإلكتروني متوقف',
      ACCOUNT_INELIGIBLE: 'الحساب غير نشط',
    },
    assigned: 'معيّن',
    notNotifiedTitle: 'معيّنون لم يُشعَروا',
    notNotifiedReason: 'لا يملك حالياً صلاحية المراجعة المالية.',
    none: 'لا يوجد',
  },
  errors: {
    MANUAL_PAYMENT_METHOD_NOT_FOUND: 'طريقة الدفع هذه غير متاحة.',
    MANUAL_PAYMENT_METHOD_INVALID: 'بعض التفاصيل ناقصة أو غير صالحة لهذا النوع من الطرق.',
    MANUAL_PAYMENT_METHOD_CODE_TAKEN: 'هناك طريقة أخرى تستخدم هذا الرمز.',
    MANUAL_PAYMENT_METHOD_CONFLICT: 'عدّل شخص آخر هذه الطريقة. أعد تحميلها وحاول مجددًا.',
    MANUAL_PAYMENT_METHOD_REVIEWER_REQUIRED:
      'عيّن مسؤولاً مالياً واحداً على الأقل لمراجعة عمليات الشحن قبل إتاحة طريقة الدفع للعملاء.',
    MANUAL_PAYMENT_METHOD_REVIEWER_INELIGIBLE:
      'لا يمكن تعيين إلا موظفي PalCert النشطين القادرين على مراجعة عمليات الشحن اليدوية.',
    MANUAL_PAYMENT_METHOD_UNAVAILABLE:
      'لم تعد طريقة الدفع هذه متاحة. احتفظنا بتفاصيلك، فابدأ من جديد بطريقة أخرى.',
    MANUAL_TOPUP_NOT_FOUND: 'تعذّر العثور على هذا التحويل.',
    MANUAL_TOPUP_INVALID: 'أدخل المبلغ ومرجع التحويل أولًا.',
    MANUAL_TOPUP_AMOUNT_OUT_OF_RANGE: 'هذا المبلغ خارج ما تقبله هذه الطريقة.',
    MANUAL_TOPUP_REFERENCE_INVALID:
      'أدخل المرجع كما يظهر تمامًا في البنك أو التطبيق: من 4 إلى 64 حرفًا ورقمًا.',
    MANUAL_TOPUP_REFERENCE_UNAVAILABLE:
      'لا يمكن استخدام مرجع التحويل هذا لهذه الطريقة. تحقق منه، أو تواصل مع دعم PalCert إن كنت متأكدًا من صحته.',
    MANUAL_TOPUP_TRANSITION_INVALID: 'لم يعد بالإمكان تغيير هذا التحويل بهذه الطريقة.',
    MANUAL_TOPUP_ALREADY_DECIDED: 'بتّ مراجع آخر في هذا التحويل بالفعل.',
    MANUAL_TOPUP_CONFIRMATION_REQUIRED: 'أكّد المبلغ بدقة قبل الموافقة.',
    MANUAL_TOPUP_TOO_MANY_OPEN:
      'لديك عدة تحويلات قيد المعالجة. انتظر مراجعتها، أو ألغِ ما لم تعد بحاجة إليه.',
    MANUAL_TOPUP_FILE_NOT_FOUND: 'تعذّر العثور على هذا الملف.',
    MANUAL_TOPUP_FILE_NOT_READY: 'ما زال الإيصال قيد الفحص أو تعذّر قبوله. انتظر قليلًا أو أزله.',
    MANUAL_TOPUP_FILE_TYPE_NOT_ALLOWED: 'هذا النوع من الملفات غير مقبول هنا.',
    FILE_TOO_LARGE: 'هذا الملف كبير جدًا.',
    FORBIDDEN: 'لا يمكنك القيام بذلك هنا.',
    REAUTHENTICATION_REQUIRED: 'يُرجى تسجيل الدخول مجددًا لتأكيد هويتك.',
    RATE_LIMITED: 'محاولات كثيرة. يُرجى الانتظار قليلًا ثم المحاولة مجددًا.',
    VALIDATION_FAILED: 'بعض التفاصيل غير صالحة.',
    UNAUTHENTICATED: 'يُرجى تسجيل الدخول مجددًا.',
  },
  confirm: {
    cancel: 'إلغاء',
    close: 'إغلاق',
    optional: 'اختياري',
    pending: 'جارٍ التنفيذ…',
    invalid: 'مطلوب',
  },
  genericError: 'حدث خطأ ما. يُرجى المحاولة مجددًا.',
  loading: 'جارٍ التحميل…',
};

export const MANUAL_TOPUP_MESSAGES: Readonly<Record<Locale, ManualTopUpMessages>> = {
  en: EN,
  ar: AR,
};

export function getManualTopUpMessages(locale: Locale): ManualTopUpMessages {
  return MANUAL_TOPUP_MESSAGES[locale];
}
