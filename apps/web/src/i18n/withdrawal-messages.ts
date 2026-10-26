import type { Locale } from './locales';

/**
 * Withdrawals and payouts, EN and AR (ADR-0150).
 *
 * Wording rules, each with a reason:
 *
 *   - "Withdrawable" is a figure PalCert computes, never the balance. The page
 *     always shows why the two differ, in plain words, without accounting
 *     jargon (policy 5).
 *   - A card top-up is refunded to its card; it is never offered as a
 *     withdrawal. The two are named differently everywhere (policy 4).
 *   - Nothing says money was sent until finance recorded the transfer with
 *     its reference: approval is "approved", not "paid".
 *   - PalCert credit is PalCert Balance, never a wallet; a payout to a phone
 *     is to a "mobile payment app".
 *   - Status is never carried by colour alone.
 *   - The Arabic terms are the ones agreed for this feature: سحب الأموال،
 *     قابل للسحب، محجوز للسحب، جهة استلام الأموال، بانتظار المراجعة، معتمد،
 *     تم التحويل، مرفوض، الرقم المرجعي للتحويل.
 */
export interface WithdrawalMessages {
  readonly loading: string;
  readonly genericError: string;
  readonly errors: Readonly<Record<string, string>>;
  readonly nav: {
    readonly withdraw: string;
    readonly history: string;
    readonly destinations: string;
    readonly organizationPayouts: string;
    readonly adminQueue: string;
    readonly platformFunds: string;
    readonly settings: string;
  };
  readonly statuses: Readonly<Record<string, string>>;
  readonly statusHints: Readonly<Record<string, string>>;
  readonly rejectionReasons: Readonly<Record<string, string>>;
  readonly events: Readonly<Record<string, string>>;
  readonly scopes: Readonly<Record<string, string>>;
  readonly destinationTypes: Readonly<Record<string, string>>;
  readonly attemptOutcomes: Readonly<Record<string, string>>;
  readonly fileStatuses: Readonly<Record<string, string>>;
  readonly confirm: {
    readonly cancel: string;
    readonly close: string;
    readonly optional: string;
    readonly pending: string;
    readonly invalid: string;
  };
  readonly balanceCard: {
    readonly title: string;
    readonly withdrawable: string;
    readonly reservedForWithdrawal: string;
    readonly action: string;
    readonly history: string;
    readonly refundTitle: string;
    readonly refundBody: string;
  };
  readonly breakdown: {
    readonly title: string;
    readonly intro: string;
    readonly cash: string;
    readonly promotional: string;
    readonly reserved: string;
    readonly reservedForWithdrawal: string;
    readonly clearing: (days: string) => string;
    readonly notWithdrawable: string;
    readonly notWithdrawableHint: string;
    readonly withdrawable: string;
    readonly promotionalHint: string;
  };
  readonly form: {
    readonly title: string;
    readonly intro: string;
    readonly currency: string;
    readonly amount: string;
    readonly amountHint: (max: string) => string;
    readonly limits: (min: string, max: string) => string;
    readonly minimumOnly: (min: string) => string;
    readonly maximumOnly: (max: string) => string;
    readonly destination: string;
    readonly chooseDestination: string;
    readonly noDestination: string;
    readonly addDestination: string;
    readonly manageDestinations: string;
    readonly note: string;
    readonly noteHint: string;
    readonly review: string;
    readonly confirmTitle: string;
    readonly confirmBody: (amount: string, destination: string) => string;
    readonly submit: string;
    readonly invalidAmount: string;
    readonly aboveWithdrawable: string;
    readonly nothingToWithdraw: string;
    readonly submitted: string;
    readonly feeNone: string;
  };
  readonly destinations: {
    readonly title: string;
    readonly organizationTitle: string;
    readonly platformTitle: string;
    readonly intro: string;
    readonly encryptedHint: string;
    readonly empty: string;
    readonly add: string;
    readonly edit: string;
    readonly save: string;
    readonly archive: string;
    readonly archiveTitle: string;
    readonly archiveBody: string;
    readonly archived: string;
    readonly snapshotNote: string;
    readonly fields: {
      readonly type: string;
      readonly label: string;
      readonly beneficiaryName: string;
      readonly currency: string;
      readonly anyCurrency: string;
      readonly bankName: string;
      readonly iban: string;
      readonly accountNumber: string;
      readonly branch: string;
      readonly mobileNumber: string;
      readonly instructions: string;
    };
    readonly fieldHints: {
      readonly bank: string;
      readonly mobile: string;
      readonly other: string;
    };
    readonly issues: Readonly<Record<string, string>>;
  };
  readonly history: {
    readonly title: string;
    readonly organizationTitle: string;
    readonly platformTitle: string;
    readonly empty: string;
    readonly caption: string;
    readonly columns: {
      readonly reference: string;
      readonly amount: string;
      readonly destination: string;
      readonly status: string;
      readonly requested: string;
      readonly paid: string;
      readonly transferReference: string;
    };
    readonly loadMore: string;
  };
  readonly detail: {
    readonly title: (reference: string) => string;
    readonly summary: string;
    readonly reference: string;
    readonly scope: string;
    readonly amount: string;
    readonly beneficiary: string;
    readonly destination: string;
    readonly snapshotHint: string;
    readonly note: string;
    readonly requestedAt: string;
    readonly approvedAt: string;
    readonly paidAt: string;
    readonly transferReference: string;
    readonly rejection: string;
    readonly timeline: string;
    readonly proof: string;
    readonly viewProof: string;
    readonly proofAudited: string;
    readonly cancel: string;
    readonly cancelTitle: string;
    readonly cancelBody: string;
    readonly cancelConfirm: string;
    readonly back: string;
    readonly hints: Readonly<Record<string, string>>;
  };
  readonly organization: {
    readonly title: string;
    readonly intro: string;
    readonly earningsTitle: string;
    readonly earningsCaption: string;
    readonly clearingDays: (days: string) => string;
    readonly columns: {
      readonly currency: string;
      readonly realized: string;
      readonly clearing: string;
      readonly reserved: string;
      readonly paidOut: string;
      readonly available: string;
    };
    readonly empty: string;
    readonly request: string;
    readonly requestTitle: string;
    readonly noPermission: string;
    readonly netShareOnly: string;
  };
  readonly platform: {
    readonly title: string;
    readonly intro: string;
    readonly caption: string;
    readonly sources: {
      readonly cashServiceRevenue: string;
      readonly attestationCommission: string;
      readonly serviceRefunds: string;
      readonly unrecoveredChargebackLoss: string;
    };
    readonly request: string;
    readonly requestTitle: string;
    readonly threePeople: string;
    readonly empty: string;
  };
  readonly admin: {
    readonly queueTitle: string;
    readonly queueIntro: string;
    readonly tabs: Readonly<Record<string, string>>;
    readonly allStatuses: string;
    readonly filters: {
      readonly title: string;
      readonly scope: string;
      readonly anyScope: string;
      readonly currency: string;
      readonly anyCurrency: string;
      readonly from: string;
      readonly to: string;
      readonly apply: string;
      readonly clear: string;
    };
    readonly totalsTitle: string;
    readonly totalsCaption: string;
    readonly queueCaption: string;
    readonly empty: string;
    readonly columns: {
      readonly reference: string;
      readonly scope: string;
      readonly requester: string;
      readonly beneficiary: string;
      readonly amount: string;
      readonly status: string;
      readonly submitted: string;
      readonly count: string;
    };
    readonly requester: string;
    readonly organization: string;
    readonly availableBefore: string;
    readonly reservation: string;
    readonly reservationActive: string;
    readonly reservationReleased: string;
    readonly releaseNote: string;
    readonly attemptsTitle: string;
    readonly attemptsCaption: string;
    readonly attemptColumns: {
      readonly number: string;
      readonly outcome: string;
      readonly started: string;
      readonly finished: string;
      readonly reference: string;
      readonly note: string;
    };
    readonly noAttempts: string;
    readonly separation: string;
    readonly readOnly: string;
    readonly reveal: string;
    readonly revealTitle: string;
    readonly revealHint: string;
    readonly hide: string;
    readonly actions: {
      readonly startReview: string;
      readonly approve: string;
      readonly approveTitle: string;
      readonly approveBody: (amount: string, beneficiary: string) => string;
      readonly reject: string;
      readonly rejectTitle: string;
      readonly rejectReason: string;
      readonly rejectNote: string;
      readonly rejectNoteHint: string;
      readonly startExecution: string;
      readonly startExecutionTitle: string;
      readonly startExecutionBody: (amount: string, beneficiary: string) => string;
      readonly markPaid: string;
      readonly markPaidTitle: string;
      readonly markPaidBody: (amount: string, beneficiary: string, destination: string) => string;
      readonly transferReference: string;
      readonly transferReferenceHint: string;
      readonly executionNote: string;
      readonly markFailed: string;
      readonly markFailedTitle: string;
      readonly markFailedBody: string;
      readonly failureNote: string;
      readonly retry: string;
      readonly retryTitle: string;
      readonly retryBody: string;
      readonly release: string;
      readonly releaseTitle: string;
      readonly releaseBody: string;
      readonly releaseReason: string;
    };
    readonly proofTitle: string;
    readonly proofIntro: string;
    readonly proofChoose: string;
    readonly proofUploading: string;
    readonly proofUploaded: string;
    readonly proofNone: string;
    readonly notifications: {
      readonly title: string;
      readonly intro: string;
      readonly pending: string;
      readonly noReviewer: string;
      readonly routing: Readonly<Record<string, string>>;
      readonly caption: string;
      readonly columns: {
        readonly recipient: string;
        readonly type: string;
        readonly inApp: string;
        readonly email: string;
        readonly reason: string;
      };
      readonly verified: string;
      readonly notVerified: string;
      readonly none: string;
      readonly emailStatuses: Readonly<Record<string, string>>;
      readonly skipReasons: Readonly<Record<string, string>>;
      readonly types: Readonly<Record<string, string>>;
    };
  };
  readonly settings: {
    readonly title: string;
    readonly intro: string;
    readonly policyTitle: string;
    readonly userDays: string;
    readonly userDaysHint: string;
    readonly organizationDays: string;
    readonly organizationDaysHint: string;
    readonly feeNone: string;
    readonly save: string;
    readonly saved: string;
    readonly limitsTitle: string;
    readonly limitsIntro: string;
    readonly limitsCaption: string;
    readonly limitCurrency: string;
    readonly limitMinimum: string;
    readonly limitMaximum: string;
    readonly noLimit: string;
    readonly saveLimit: string;
    readonly reviewersTitle: string;
    readonly reviewersIntro: string;
    readonly reviewersEmptyMeansAll: string;
    readonly eligible: string;
    readonly notEligible: string;
    readonly saveReviewers: string;
    readonly noCandidates: string;
    readonly reconciliationTitle: string;
    readonly reconciliationIntro: string;
    readonly runReconciliation: string;
    readonly consistent: (count: string) => string;
    readonly findingsTitle: (count: string) => string;
    readonly findingsCaption: string;
    readonly findingColumns: {
      readonly code: string;
      readonly detail: string;
      readonly subject: string;
    };
    readonly readOnly: string;
  };
}

const en: WithdrawalMessages = {
  loading: 'Loading…',
  genericError: 'Something went wrong. Please try again.',
  errors: {
    WITHDRAWAL_NOT_FOUND: 'That withdrawal could not be found.',
    WITHDRAWAL_INVALID: 'This withdrawal request is not valid.',
    WITHDRAWAL_AMOUNT_OUT_OF_RANGE: 'The amount is outside the allowed limits for this currency.',
    WITHDRAWAL_EXCEEDS_AVAILABLE: 'The amount is more than you can withdraw right now.',
    WITHDRAWAL_TRANSITION_INVALID: 'This withdrawal can no longer be changed that way.',
    WITHDRAWAL_ALREADY_DECIDED: 'This withdrawal has already been decided.',
    WITHDRAWAL_CONFLICT: 'This withdrawal changed since you opened it. Reload and try again.',
    WITHDRAWAL_SEPARATION_OF_DUTIES:
      'You cannot do this on this withdrawal: a different person must act at this stage.',
    WITHDRAWAL_REFERENCE_REQUIRED: 'Enter the transfer reference before marking this as paid.',
    WITHDRAWAL_CONFIRMATION_REQUIRED: 'Confirm the exact amount and currency.',
    WITHDRAWAL_TOO_MANY_OPEN: 'You already have the maximum number of open withdrawals.',
    WITHDRAWAL_PROOF_NOT_FOUND: 'There is no transfer receipt for this withdrawal.',
    WITHDRAWAL_PROOF_NOT_READY: 'The transfer receipt is still being checked.',
    PAYOUT_DESTINATION_NOT_FOUND: 'That payout destination could not be found.',
    PAYOUT_DESTINATION_INVALID: 'Check the highlighted payout destination fields.',
    PAYOUT_DESTINATION_CONFLICT: 'This payout destination changed since you opened it. Reload it.',
    PAYOUT_DESTINATION_ARCHIVED: 'An archived payout destination cannot be changed.',
    PAYOUT_DESTINATION_ENCRYPTION_UNAVAILABLE:
      'Payout destinations cannot be saved right now. Please contact PalCert support.',
    REAUTHENTICATION_REQUIRED: 'For your security, sign in again to continue.',
    FORBIDDEN: 'You do not have permission to do this.',
    VALIDATION_FAILED: 'Check the highlighted fields.',
  },
  nav: {
    withdraw: 'Withdraw funds',
    history: 'My withdrawals',
    destinations: 'Payout destinations',
    organizationPayouts: 'Earnings & payouts',
    adminQueue: 'Withdrawals',
    platformFunds: 'Platform funds',
    settings: 'Withdrawal settings',
  },
  statuses: {
    DRAFT: 'Draft',
    PENDING_REVIEW: 'Pending review',
    APPROVED: 'Approved',
    PROCESSING: 'Transfer in progress',
    PAID: 'Paid',
    REJECTED: 'Rejected',
    CANCELLED: 'Cancelled',
    FAILED: 'Transfer failed',
  },
  statusHints: {
    DRAFT: 'Not sent yet.',
    PENDING_REVIEW: 'The amount is reserved for withdrawal while PalCert finance reviews it.',
    APPROVED: 'Approved. The transfer has not been sent yet.',
    PROCESSING: 'PalCert finance is sending the transfer.',
    PAID: 'The transfer was sent. Its transfer reference is on the request.',
    REJECTED: 'Not approved. The reserved amount was released.',
    CANCELLED: 'Cancelled. The reserved amount was released.',
    FAILED: 'The transfer did not go through. The amount stays reserved for withdrawal.',
  },
  rejectionReasons: {
    DESTINATION_INVALID: 'The payout destination could not be used',
    BENEFICIARY_MISMATCH: 'The beneficiary does not match the account holder',
    VERIFICATION_REQUIRED: 'More verification is needed',
    POLICY_VIOLATION: 'Does not meet the withdrawal policy',
    SUSPECTED_FRAUD: 'Declined for security reasons',
    DUPLICATE_REQUEST: 'Duplicate request',
    OTHER: 'Other',
  },
  events: {
    CREATED: 'Requested',
    SUBMITTED: 'Sent for review',
    RESERVED: 'Amount reserved',
    REVIEW_STARTED: 'Review started',
    APPROVED: 'Approved',
    REJECTED: 'Rejected',
    CANCELLED: 'Cancelled',
    EXECUTION_STARTED: 'Transfer started',
    PAID: 'Paid',
    FAILED: 'Transfer failed',
    RETRY_STARTED: 'Transfer retried',
    RESERVATION_RELEASED: 'Reserved amount released',
    PROOF_ATTACHED: 'Transfer receipt attached',
  },
  scopes: {
    USER: 'Personal balance',
    ORGANIZATION: 'Organization earnings',
    PLATFORM: 'PalCert revenue',
  },
  destinationTypes: {
    BANK_ACCOUNT: 'Bank account',
    MOBILE_WALLET: 'Mobile payment app',
    OTHER: 'Other',
  },
  attemptOutcomes: {
    IN_PROGRESS: 'In progress',
    SUCCEEDED: 'Succeeded',
    FAILED: 'Failed',
  },
  fileStatuses: {
    AWAITING_UPLOAD: 'Waiting for upload',
    UPLOADED: 'Uploaded',
    VALIDATING: 'Checking',
    SCANNING: 'Checking',
    READY: 'Ready',
    REJECTED: 'Not accepted',
    FAILED: 'Could not be checked',
    UPLOAD_EXPIRED: 'Upload expired',
  },
  confirm: {
    cancel: 'Cancel',
    close: 'Close',
    optional: 'optional',
    pending: 'Working…',
    invalid: 'This field is required.',
  },
  balanceCard: {
    title: 'Withdraw funds',
    withdrawable: 'Withdrawable',
    reservedForWithdrawal: 'Reserved for withdrawal',
    action: 'Request withdrawal',
    history: 'My withdrawals',
    refundTitle: 'Refund card payment',
    refundBody:
      'Money you added by card goes back to that card through a refund, not to a bank account. Contact PalCert support to request one.',
  },
  breakdown: {
    title: 'What you can withdraw',
    intro: 'Only money you paid in by verified bank or mobile transfer can be withdrawn.',
    cash: 'Cash balance',
    promotional: 'Promotional credit',
    reserved: 'Reserved for services',
    reservedForWithdrawal: 'Reserved for withdrawal',
    clearing: (days) => `Transfers still clearing (${days} days)`,
    notWithdrawable: 'Spendable, not withdrawable',
    notWithdrawableHint:
      'Card top-ups and credits from PalCert can be spent on services but not withdrawn.',
    withdrawable: 'Withdrawable',
    promotionalHint: 'Promotional credit can be spent but is never withdrawable.',
  },
  form: {
    title: 'Request withdrawal',
    intro:
      'Choose the amount and where to send it. The amount is reserved for withdrawal as soon as you send the request.',
    currency: 'Currency',
    amount: 'Amount',
    amountHint: (max) => `Up to ${max}.`,
    limits: (min, max) => `Between ${min} and ${max} per request.`,
    minimumOnly: (min) => `At least ${min} per request.`,
    maximumOnly: (max) => `At most ${max} per request.`,
    destination: 'Payout destination',
    chooseDestination: 'Choose a payout destination',
    noDestination: 'Add a payout destination before requesting a withdrawal.',
    addDestination: 'Add payout destination',
    manageDestinations: 'Manage payout destinations',
    note: 'Note for PalCert finance',
    noteHint: 'Optional. Do not include account numbers here.',
    review: 'Review',
    confirmTitle: 'Send this withdrawal request?',
    confirmBody: (amount, destination) =>
      `${amount} will be reserved for withdrawal and sent to ${destination} once PalCert finance approves and makes the transfer.`,
    submit: 'Send request',
    invalidAmount:
      'Enter an amount greater than zero, with no more decimals than the currency allows.',
    aboveWithdrawable: 'This is more than you can withdraw right now.',
    nothingToWithdraw: 'There is nothing to withdraw in this currency right now.',
    submitted: 'Your withdrawal request was sent.',
    feeNone: 'No withdrawal fee.',
  },
  destinations: {
    title: 'Payout destinations',
    organizationTitle: 'Organization payout destinations',
    platformTitle: 'PalCert treasury destinations',
    intro: 'Where withdrawals are sent. Only the last digits are ever shown.',
    encryptedHint:
      'Account details are encrypted and shown only to the PalCert finance staff making the transfer.',
    empty: 'No payout destinations yet.',
    add: 'Add payout destination',
    edit: 'Edit',
    save: 'Save',
    archive: 'Archive',
    archiveTitle: 'Archive this payout destination?',
    archiveBody:
      'It can no longer be chosen for new withdrawals. Requests already sent keep their details.',
    archived: 'Archived',
    snapshotNote: 'Changing a destination never changes a request you already sent.',
    fields: {
      type: 'Type',
      label: 'Name for this destination',
      beneficiaryName: 'Beneficiary name',
      currency: 'Currency',
      anyCurrency: 'Any currency',
      bankName: 'Bank name',
      iban: 'IBAN',
      accountNumber: 'Account number',
      branch: 'Branch',
      mobileNumber: 'Mobile number',
      instructions: 'Instructions',
    },
    fieldHints: {
      bank: 'Enter an IBAN, or an account number with the bank name.',
      mobile: 'The mobile number registered with the payment app.',
      other: 'Describe exactly how PalCert finance should send the money.',
    },
    issues: {
      REQUIRED: 'Required.',
      TOO_LONG: 'Too long.',
      INVALID: 'Not valid.',
    },
  },
  history: {
    title: 'My withdrawals',
    organizationTitle: 'Payout history',
    platformTitle: 'Platform payout history',
    empty: 'No withdrawals yet.',
    caption: 'Withdrawals',
    columns: {
      reference: 'Reference',
      amount: 'Amount',
      destination: 'Payout destination',
      status: 'Status',
      requested: 'Requested',
      paid: 'Paid',
      transferReference: 'Transfer reference',
    },
    loadMore: 'Load more',
  },
  detail: {
    title: (reference) => `Withdrawal ${reference}`,
    summary: 'Request',
    reference: 'Request reference',
    scope: 'Scope',
    amount: 'Amount',
    beneficiary: 'Beneficiary',
    destination: 'Payout destination',
    snapshotHint: 'As it was when the request was sent. Later changes do not affect it.',
    note: 'Note',
    requestedAt: 'Requested',
    approvedAt: 'Approved',
    paidAt: 'Paid',
    transferReference: 'Transfer reference',
    rejection: 'Reason',
    timeline: 'History',
    proof: 'Transfer receipt',
    viewProof: 'View transfer receipt',
    proofAudited: 'Every viewing is recorded.',
    cancel: 'Cancel request',
    cancelTitle: 'Cancel this withdrawal?',
    cancelBody: 'The reserved amount will be released. You can send a new request later.',
    cancelConfirm: 'Cancel request',
    back: 'Back to withdrawals',
    hints: {
      PENDING_REVIEW: 'PalCert finance will review your request. You can still cancel it.',
      APPROVED: 'Approved. You will be told when the transfer has been sent.',
      PROCESSING: 'PalCert finance is sending the transfer. It can no longer be cancelled.',
      FAILED:
        'The transfer did not go through. PalCert finance will retry it or release the amount.',
      PAID: 'The transfer was sent to your payout destination.',
      REJECTED: 'This request was not approved and the reserved amount was released.',
      CANCELLED: 'This request was cancelled and the reserved amount was released.',
    },
  },
  organization: {
    title: 'Earnings & payouts',
    intro:
      'Your organization’s share of attestation fees, after PalCert’s commission, by currency.',
    earningsTitle: 'Earnings',
    earningsCaption: 'Organization earnings by currency',
    clearingDays: (days) => `Settled earnings become available for payout after ${days} days.`,
    columns: {
      currency: 'Currency',
      realized: 'Realized',
      clearing: 'Clearing',
      reserved: 'Reserved for payout',
      paidOut: 'Paid out',
      available: 'Available for payout',
    },
    empty: 'No earnings yet.',
    request: 'Request payout',
    requestTitle: 'Request a payout',
    noPermission: 'Only people allowed to request payouts for this organization can do this.',
    netShareOnly: 'Only your net share of settled fees is included — never PalCert’s commission.',
  },
  platform: {
    title: 'Platform funds',
    intro: 'PalCert’s realized revenue by currency, and what of it may be paid out.',
    caption: 'Platform funds by currency',
    sources: {
      cashServiceRevenue: 'Paid service revenue',
      attestationCommission: 'Attestation commission',
      serviceRefunds: 'Service refunds',
      unrecoveredChargebackLoss: 'Unrecovered chargebacks',
    },
    request: 'Request platform payout',
    requestTitle: 'Request a platform payout',
    threePeople:
      'A platform payout needs three different people: one to request, one to approve and one to make the transfer.',
    empty: 'No platform revenue yet.',
  },
  admin: {
    queueTitle: 'Withdrawals',
    queueIntro:
      'Review, approve and record payouts. Nothing here sends money: transfers are made outside PalCert and recorded with their reference.',
    tabs: {
      PENDING_REVIEW: 'Pending',
      APPROVED: 'Approved',
      PROCESSING: 'Processing',
      PAID: 'Paid',
      REJECTED: 'Rejected',
      CANCELLED: 'Cancelled',
      FAILED: 'Failed',
    },
    allStatuses: 'All',
    filters: {
      title: 'Filters',
      scope: 'Scope',
      anyScope: 'Any scope',
      currency: 'Currency',
      anyCurrency: 'Any currency',
      from: 'Submitted from',
      to: 'Submitted before',
      apply: 'Apply',
      clear: 'Clear',
    },
    totalsTitle: 'Open amounts',
    totalsCaption: 'Open withdrawal amounts by status and currency',
    queueCaption: 'Withdrawal requests',
    empty: 'No withdrawals match.',
    columns: {
      reference: 'Reference',
      scope: 'Scope',
      requester: 'Requester',
      beneficiary: 'Beneficiary',
      amount: 'Amount',
      status: 'Status',
      submitted: 'Submitted',
      count: 'Requests',
    },
    requester: 'Requester',
    organization: 'Organization',
    availableBefore: 'Withdrawable before this request',
    reservation: 'Reservation',
    reservationActive: 'Reserved',
    reservationReleased: 'Not reserved',
    releaseNote: 'Release reason',
    attemptsTitle: 'Transfer attempts',
    attemptsCaption: 'Transfer attempts',
    attemptColumns: {
      number: 'Attempt',
      outcome: 'Outcome',
      started: 'Started',
      finished: 'Finished',
      reference: 'Transfer reference',
      note: 'Note',
    },
    noAttempts: 'No transfer has been attempted yet.',
    separation:
      'Nobody may approve or pay out their own request. A PalCert payout needs three different people.',
    readOnly: 'You can view this withdrawal but not act on it.',
    reveal: 'Show full payout details',
    revealTitle: 'Full payout details',
    revealHint: 'Shown from the copy taken when the request was sent. This viewing is recorded.',
    hide: 'Hide',
    actions: {
      startReview: 'Start review',
      approve: 'Approve',
      approveTitle: 'Approve this payout?',
      approveBody: (amount, beneficiary) =>
        `Approve paying ${amount} to ${beneficiary}. No money moves yet: the amount stays reserved until the transfer is recorded.`,
      reject: 'Reject',
      rejectTitle: 'Reject this withdrawal?',
      rejectReason: 'Reason',
      rejectNote: 'Note to the requester',
      rejectNoteHint: 'Required when the reason is “Other”.',
      startExecution: 'Start transfer',
      startExecutionTitle: 'Start the transfer?',
      startExecutionBody: (amount, beneficiary) =>
        `You are about to send ${amount} to ${beneficiary} outside PalCert. Record the result here when it is done.`,
      markPaid: 'Mark as paid',
      markPaidTitle: 'Record this payout as paid?',
      markPaidBody: (amount, beneficiary, destination) =>
        `Confirm that ${amount} was sent to ${beneficiary} (${destination}). This settles the withdrawal and cannot be undone.`,
      transferReference: 'Transfer reference',
      transferReferenceHint: 'The reference the bank or payment app gave for the transfer.',
      executionNote: 'Note',
      markFailed: 'Mark transfer failed',
      markFailedTitle: 'Record a failed transfer?',
      markFailedBody: 'The amount stays reserved. You can retry the transfer or release it later.',
      failureNote: 'What happened',
      retry: 'Retry transfer',
      retryTitle: 'Retry the transfer?',
      retryBody: 'A new transfer attempt is recorded. The earlier attempt stays on record.',
      release: 'Release',
      releaseTitle: 'Release this withdrawal?',
      releaseBody: 'The withdrawal is cancelled and the reserved amount released. Give the reason.',
      releaseReason: 'Reason',
    },
    proofTitle: 'Transfer receipt',
    proofIntro: 'Optional. PDF, PNG, JPEG or WebP, up to 5 MB. Never emailed and never public.',
    proofChoose: 'Upload transfer receipt',
    proofUploading: 'Uploading…',
    proofUploaded: 'Transfer receipt uploaded. It is being checked.',
    proofNone: 'No transfer receipt.',
    notifications: {
      title: 'Notifications',
      intro: 'Who was told about this withdrawal, and what happened to each message.',
      pending: 'Not routed yet.',
      noReviewer: 'Nobody could be notified about this withdrawal.',
      routing: {
        ASSIGNED_REVIEWERS: 'Sent to the assigned withdrawal reviewers.',
        FALLBACK_NO_ELIGIBLE:
          'No assigned reviewer could act, so every PalCert finance reviewer was notified.',
        GLOBAL_NOT_CONFIGURED:
          'No reviewers are assigned, so every PalCert finance reviewer was notified.',
      },
      caption: 'Notification deliveries',
      columns: {
        recipient: 'Recipient',
        type: 'Message',
        inApp: 'In PalCert',
        email: 'Email',
        reason: 'Why not sent',
      },
      verified: 'verified email',
      notVerified: 'email not verified',
      none: '—',
      emailStatuses: {
        PENDING: 'Waiting',
        SENT: 'Sent',
        DELIVERED: 'Delivered',
        FAILED: 'Failed',
        SKIPPED: 'Not sent',
      },
      skipReasons: {
        PREFERENCE_DISABLED: 'Turned off by the recipient',
        EMAIL_NOT_VERIFIED: 'Email not verified',
        AUTHORIZATION_REVOKED: 'No longer allowed to review',
        ACCOUNT_INACTIVE: 'Account not active',
        CHANNEL_DISABLED: 'Email is turned off',
      },
      types: {
        WITHDRAWAL_PENDING_REVIEW: 'Review alert',
        WITHDRAWAL_SUBMITTED: 'Request received',
        WITHDRAWAL_APPROVED: 'Approved',
        WITHDRAWAL_REJECTED: 'Rejected',
        WITHDRAWAL_PAID: 'Paid',
        WITHDRAWAL_FAILED: 'Transfer failed',
      },
    },
  },
  settings: {
    title: 'Withdrawal settings',
    intro: 'Clearing periods, limits, who reviews withdrawals, and the consistency check.',
    policyTitle: 'Clearing periods',
    userDays: 'Manual top-ups (days)',
    userDaysHint:
      'How long a verified bank or mobile transfer waits before it can be withdrawn. 0 to 90.',
    organizationDays: 'Organization earnings (days)',
    organizationDaysHint: 'How long settled earnings wait before they can be paid out. 0 to 180.',
    feeNone: 'There is no withdrawal fee.',
    save: 'Save',
    saved: 'Saved.',
    limitsTitle: 'Limits per request',
    limitsIntro: 'Optional minimum and maximum for one withdrawal, per currency.',
    limitsCaption: 'Withdrawal limits by currency',
    limitCurrency: 'Currency',
    limitMinimum: 'Minimum',
    limitMaximum: 'Maximum',
    noLimit: 'No limit',
    saveLimit: 'Save limit',
    reviewersTitle: 'Withdrawal reviewers',
    reviewersIntro: 'PalCert finance staff who are alerted when a withdrawal is submitted.',
    reviewersEmptyMeansAll: 'If nobody is selected, every PalCert finance reviewer is alerted.',
    eligible: 'Can review',
    notEligible: 'Can no longer review',
    saveReviewers: 'Save reviewers',
    noCandidates: 'No PalCert staff can review withdrawals yet.',
    reconciliationTitle: 'Consistency check',
    reconciliationIntro:
      'Checks every withdrawal against the money it reserved and settled. It reports problems and never changes anything.',
    runReconciliation: 'Run check',
    consistent: (count) => `All ${count} withdrawals are consistent.`,
    findingsTitle: (count) => `${count} problems found`,
    findingsCaption: 'Consistency problems',
    findingColumns: {
      code: 'Problem',
      detail: 'Detail',
      subject: 'Affects',
    },
    readOnly: 'You can view these settings but not change them.',
  },
};

const ar: WithdrawalMessages = {
  loading: 'جارٍ التحميل…',
  genericError: 'حدث خطأ ما. يُرجى المحاولة مرة أخرى.',
  errors: {
    WITHDRAWAL_NOT_FOUND: 'تعذّر العثور على طلب سحب الأموال.',
    WITHDRAWAL_INVALID: 'طلب سحب الأموال هذا غير صالح.',
    WITHDRAWAL_AMOUNT_OUT_OF_RANGE: 'المبلغ خارج الحدود المسموح بها لهذه العملة.',
    WITHDRAWAL_EXCEEDS_AVAILABLE: 'المبلغ أكبر مما يمكنك سحبه الآن.',
    WITHDRAWAL_TRANSITION_INVALID: 'لم يعد بالإمكان تغيير طلب السحب بهذه الطريقة.',
    WITHDRAWAL_ALREADY_DECIDED: 'سبق البتّ في طلب السحب هذا.',
    WITHDRAWAL_CONFLICT: 'تغيّر طلب السحب منذ فتحته. أعد التحميل وحاول مرة أخرى.',
    WITHDRAWAL_SEPARATION_OF_DUTIES:
      'لا يمكنك تنفيذ هذا الإجراء على هذا الطلب: يجب أن يتولّاه شخص آخر في هذه المرحلة.',
    WITHDRAWAL_REFERENCE_REQUIRED: 'أدخل الرقم المرجعي للتحويل قبل تسجيل الطلب على أنه تم التحويل.',
    WITHDRAWAL_CONFIRMATION_REQUIRED: 'أكّد المبلغ والعملة بدقة.',
    WITHDRAWAL_TOO_MANY_OPEN: 'لديك العدد الأقصى من طلبات السحب المفتوحة.',
    WITHDRAWAL_PROOF_NOT_FOUND: 'لا يوجد إيصال تحويل لهذا الطلب.',
    WITHDRAWAL_PROOF_NOT_READY: 'ما زال إيصال التحويل قيد الفحص.',
    PAYOUT_DESTINATION_NOT_FOUND: 'تعذّر العثور على جهة استلام الأموال.',
    PAYOUT_DESTINATION_INVALID: 'تحقّق من الحقول المحدّدة في جهة استلام الأموال.',
    PAYOUT_DESTINATION_CONFLICT: 'تغيّرت جهة استلام الأموال منذ فتحتها. أعد تحميلها.',
    PAYOUT_DESTINATION_ARCHIVED: 'لا يمكن تعديل جهة استلام أموال مؤرشفة.',
    PAYOUT_DESTINATION_ENCRYPTION_UNAVAILABLE:
      'لا يمكن حفظ جهات استلام الأموال حاليًا. يُرجى التواصل مع دعم PalCert.',
    REAUTHENTICATION_REQUIRED: 'حفاظًا على أمانك، سجّل الدخول مرة أخرى للمتابعة.',
    FORBIDDEN: 'ليست لديك صلاحية تنفيذ هذا الإجراء.',
    VALIDATION_FAILED: 'تحقّق من الحقول المحدّدة.',
  },
  nav: {
    withdraw: 'سحب الأموال',
    history: 'طلبات السحب',
    destinations: 'جهات استلام الأموال',
    organizationPayouts: 'الأرباح والمدفوعات',
    adminQueue: 'طلبات سحب الأموال',
    platformFunds: 'أموال المنصة',
    settings: 'إعدادات السحب',
  },
  statuses: {
    DRAFT: 'مسودة',
    PENDING_REVIEW: 'بانتظار المراجعة',
    APPROVED: 'معتمد',
    PROCESSING: 'التحويل قيد التنفيذ',
    PAID: 'تم التحويل',
    REJECTED: 'مرفوض',
    CANCELLED: 'ملغى',
    FAILED: 'تعذّر التحويل',
  },
  statusHints: {
    DRAFT: 'لم يُرسَل بعد.',
    PENDING_REVIEW: 'المبلغ محجوز للسحب بينما يراجع فريق المالية في PalCert الطلب.',
    APPROVED: 'معتمد. لم يُرسَل التحويل بعد.',
    PROCESSING: 'يرسل فريق المالية في PalCert التحويل.',
    PAID: 'أُرسل التحويل. الرقم المرجعي للتحويل مدوّن على الطلب.',
    REJECTED: 'لم يُعتمد الطلب، وأُفرج عن المبلغ المحجوز.',
    CANCELLED: 'أُلغي الطلب، وأُفرج عن المبلغ المحجوز.',
    FAILED: 'لم يكتمل التحويل. يبقى المبلغ محجوزًا للسحب.',
  },
  rejectionReasons: {
    DESTINATION_INVALID: 'تعذّر استخدام جهة استلام الأموال',
    BENEFICIARY_MISMATCH: 'اسم المستفيد لا يطابق صاحب الحساب',
    VERIFICATION_REQUIRED: 'يلزم مزيد من التحقق',
    POLICY_VIOLATION: 'لا يستوفي سياسة السحب',
    SUSPECTED_FRAUD: 'رُفض لأسباب أمنية',
    DUPLICATE_REQUEST: 'طلب مكرّر',
    OTHER: 'سبب آخر',
  },
  events: {
    CREATED: 'قُدّم الطلب',
    SUBMITTED: 'أُرسل للمراجعة',
    RESERVED: 'حُجز المبلغ',
    REVIEW_STARTED: 'بدأت المراجعة',
    APPROVED: 'معتمد',
    REJECTED: 'مرفوض',
    CANCELLED: 'أُلغي',
    EXECUTION_STARTED: 'بدأ التحويل',
    PAID: 'تم التحويل',
    FAILED: 'تعذّر التحويل',
    RETRY_STARTED: 'أُعيدت محاولة التحويل',
    RESERVATION_RELEASED: 'أُفرج عن المبلغ المحجوز',
    PROOF_ATTACHED: 'أُرفق إيصال التحويل',
  },
  scopes: {
    USER: 'الرصيد الشخصي',
    ORGANIZATION: 'أرباح المؤسسة',
    PLATFORM: 'إيرادات PalCert',
  },
  destinationTypes: {
    BANK_ACCOUNT: 'حساب بنكي',
    MOBILE_WALLET: 'تطبيق دفع عبر الجوال',
    OTHER: 'أخرى',
  },
  attemptOutcomes: {
    IN_PROGRESS: 'قيد التنفيذ',
    SUCCEEDED: 'ناجحة',
    FAILED: 'فاشلة',
  },
  fileStatuses: {
    AWAITING_UPLOAD: 'بانتظار الرفع',
    UPLOADED: 'تم الرفع',
    VALIDATING: 'قيد الفحص',
    SCANNING: 'قيد الفحص',
    READY: 'جاهز',
    REJECTED: 'غير مقبول',
    FAILED: 'تعذّر فحصه',
    UPLOAD_EXPIRED: 'انتهت مهلة الرفع',
  },
  confirm: {
    cancel: 'إلغاء',
    close: 'إغلاق',
    optional: 'اختياري',
    pending: 'جارٍ التنفيذ…',
    invalid: 'هذا الحقل مطلوب.',
  },
  balanceCard: {
    title: 'سحب الأموال',
    withdrawable: 'قابل للسحب',
    reservedForWithdrawal: 'محجوز للسحب',
    action: 'طلب سحب الأموال',
    history: 'طلبات السحب',
    refundTitle: 'استرداد دفعة البطاقة',
    refundBody:
      'تُعاد الأموال التي أضفتها بالبطاقة إلى البطاقة نفسها عن طريق الاسترداد، لا إلى حساب بنكي. تواصل مع دعم PalCert لطلب ذلك.',
  },
  breakdown: {
    title: 'ما يمكنك سحبه',
    intro: 'لا يمكن سحب إلا الأموال التي دفعتها بتحويل بنكي أو عبر الجوال تم التحقق منه.',
    cash: 'الرصيد النقدي',
    promotional: 'الرصيد الترويجي',
    reserved: 'محجوز للخدمات',
    reservedForWithdrawal: 'محجوز للسحب',
    clearing: (days) => `تحويلات قيد التسوية (${days} يومًا)`,
    notWithdrawable: 'قابل للإنفاق وغير قابل للسحب',
    notWithdrawableHint:
      'يمكن إنفاق الشحن بالبطاقة والأرصدة المضافة من PalCert على الخدمات، ولكن لا يمكن سحبها.',
    withdrawable: 'قابل للسحب',
    promotionalHint: 'يمكن إنفاق الرصيد الترويجي، لكنه غير قابل للسحب أبدًا.',
  },
  form: {
    title: 'طلب سحب الأموال',
    intro: 'اختر المبلغ والجهة التي يُرسَل إليها. يصبح المبلغ محجوزًا للسحب فور إرسال الطلب.',
    currency: 'العملة',
    amount: 'المبلغ',
    amountHint: (max) => `حتى ${max}.`,
    limits: (min, max) => `بين ${min} و${max} لكل طلب.`,
    minimumOnly: (min) => `${min} على الأقل لكل طلب.`,
    maximumOnly: (max) => `${max} على الأكثر لكل طلب.`,
    destination: 'جهة استلام الأموال',
    chooseDestination: 'اختر جهة استلام الأموال',
    noDestination: 'أضف جهة لاستلام الأموال قبل طلب السحب.',
    addDestination: 'إضافة جهة استلام الأموال',
    manageDestinations: 'إدارة جهات استلام الأموال',
    note: 'ملاحظة لفريق المالية في PalCert',
    noteHint: 'اختياري. لا تكتب أرقام الحسابات هنا.',
    review: 'مراجعة',
    confirmTitle: 'إرسال طلب سحب الأموال؟',
    confirmBody: (amount, destination) =>
      `سيُحجز ${amount} للسحب، ويُرسَل إلى ${destination} بعد أن يعتمده فريق المالية في PalCert وينفّذ التحويل.`,
    submit: 'إرسال الطلب',
    invalidAmount: 'أدخل مبلغًا أكبر من صفر، دون منازل عشرية أكثر مما تسمح به العملة.',
    aboveWithdrawable: 'هذا أكثر مما يمكنك سحبه الآن.',
    nothingToWithdraw: 'لا يوجد ما يمكن سحبه بهذه العملة حاليًا.',
    submitted: 'أُرسل طلب سحب الأموال.',
    feeNone: 'لا توجد رسوم على السحب.',
  },
  destinations: {
    title: 'جهات استلام الأموال',
    organizationTitle: 'جهات استلام أموال المؤسسة',
    platformTitle: 'جهات استلام أموال خزينة PalCert',
    intro: 'الجهات التي تُرسَل إليها طلبات السحب. لا تظهر منها إلا الأرقام الأخيرة.',
    encryptedHint:
      'تفاصيل الحساب مشفّرة، ولا تظهر إلا لموظفي المالية في PalCert الذين ينفّذون التحويل.',
    empty: 'لا توجد جهات لاستلام الأموال بعد.',
    add: 'إضافة جهة استلام الأموال',
    edit: 'تعديل',
    save: 'حفظ',
    archive: 'أرشفة',
    archiveTitle: 'أرشفة جهة استلام الأموال هذه؟',
    archiveBody:
      'لن يكون بالإمكان اختيارها لطلبات سحب جديدة. تحتفظ الطلبات المُرسَلة سابقًا بتفاصيلها.',
    archived: 'مؤرشفة',
    snapshotNote: 'تعديل جهة الاستلام لا يغيّر أي طلب أرسلته من قبل.',
    fields: {
      type: 'النوع',
      label: 'اسم لهذه الجهة',
      beneficiaryName: 'اسم المستفيد',
      currency: 'العملة',
      anyCurrency: 'أي عملة',
      bankName: 'اسم البنك',
      iban: 'رقم IBAN',
      accountNumber: 'رقم الحساب',
      branch: 'الفرع',
      mobileNumber: 'رقم الجوال',
      instructions: 'التعليمات',
    },
    fieldHints: {
      bank: 'أدخل رقم IBAN، أو رقم الحساب مع اسم البنك.',
      mobile: 'رقم الجوال المسجّل في تطبيق الدفع.',
      other: 'صف بدقة كيف يرسل فريق المالية في PalCert الأموال.',
    },
    issues: {
      REQUIRED: 'مطلوب.',
      TOO_LONG: 'طويل جدًا.',
      INVALID: 'غير صالح.',
    },
  },
  history: {
    title: 'طلبات السحب',
    organizationTitle: 'سجل المدفوعات',
    platformTitle: 'سجل مدفوعات المنصة',
    empty: 'لا توجد طلبات سحب بعد.',
    caption: 'طلبات سحب الأموال',
    columns: {
      reference: 'المرجع',
      amount: 'المبلغ',
      destination: 'جهة استلام الأموال',
      status: 'الحالة',
      requested: 'تاريخ الطلب',
      paid: 'تاريخ التحويل',
      transferReference: 'الرقم المرجعي للتحويل',
    },
    loadMore: 'عرض المزيد',
  },
  detail: {
    title: (reference) => `طلب سحب الأموال ${reference}`,
    summary: 'الطلب',
    reference: 'مرجع الطلب',
    scope: 'النطاق',
    amount: 'المبلغ',
    beneficiary: 'المستفيد',
    destination: 'جهة استلام الأموال',
    snapshotHint: 'كما كانت عند إرسال الطلب. التعديلات اللاحقة لا تؤثر فيه.',
    note: 'ملاحظة',
    requestedAt: 'تاريخ الطلب',
    approvedAt: 'تاريخ الاعتماد',
    paidAt: 'تاريخ التحويل',
    transferReference: 'الرقم المرجعي للتحويل',
    rejection: 'السبب',
    timeline: 'السجل',
    proof: 'إيصال التحويل',
    viewProof: 'عرض إيصال التحويل',
    proofAudited: 'تُسجَّل كل عملية عرض.',
    cancel: 'إلغاء الطلب',
    cancelTitle: 'إلغاء طلب السحب هذا؟',
    cancelBody: 'سيُفرج عن المبلغ المحجوز، ويمكنك إرسال طلب جديد لاحقًا.',
    cancelConfirm: 'إلغاء الطلب',
    back: 'العودة إلى طلبات السحب',
    hints: {
      PENDING_REVIEW: 'سيراجع فريق المالية في PalCert طلبك. ما زال بإمكانك إلغاؤه.',
      APPROVED: 'معتمد. سنُعلمك عند إرسال التحويل.',
      PROCESSING: 'يرسل فريق المالية في PalCert التحويل، ولم يعد بالإمكان إلغاء الطلب.',
      FAILED: 'لم يكتمل التحويل. سيعيد فريق المالية في PalCert المحاولة أو يُفرج عن المبلغ.',
      PAID: 'أُرسل التحويل إلى جهة استلام الأموال.',
      REJECTED: 'لم يُعتمد هذا الطلب، وأُفرج عن المبلغ المحجوز.',
      CANCELLED: 'أُلغي هذا الطلب، وأُفرج عن المبلغ المحجوز.',
    },
  },
  organization: {
    title: 'الأرباح والمدفوعات',
    intro: 'حصة مؤسستك من رسوم التصديق بعد عمولة PalCert، حسب العملة.',
    earningsTitle: 'الأرباح',
    earningsCaption: 'أرباح المؤسسة حسب العملة',
    clearingDays: (days) => `تصبح الأرباح المسوّاة متاحة للدفع بعد ${days} يومًا.`,
    columns: {
      currency: 'العملة',
      realized: 'المحقّقة',
      clearing: 'قيد التسوية',
      reserved: 'محجوز للدفع',
      paidOut: 'المدفوعة',
      available: 'متاح للدفع',
    },
    empty: 'لا توجد أرباح بعد.',
    request: 'طلب دفعة',
    requestTitle: 'طلب دفعة',
    noPermission: 'لا يمكن إجراء ذلك إلا للأشخاص المخوّلين بطلب مدفوعات هذه المؤسسة.',
    netShareOnly: 'لا تُحتسب إلا حصتك الصافية من الرسوم المسوّاة، ولا تُحتسب عمولة PalCert أبدًا.',
  },
  platform: {
    title: 'أموال المنصة',
    intro: 'الإيرادات المحقّقة لـ PalCert حسب العملة، وما يمكن دفعه منها.',
    caption: 'أموال المنصة حسب العملة',
    sources: {
      cashServiceRevenue: 'إيرادات الخدمات المدفوعة',
      attestationCommission: 'عمولة التصديق',
      serviceRefunds: 'مبالغ الخدمات المستردّة',
      unrecoveredChargebackLoss: 'استردادات بنكية غير مستعادة',
    },
    request: 'طلب دفعة من المنصة',
    requestTitle: 'طلب دفعة من المنصة',
    threePeople:
      'تحتاج دفعة المنصة إلى ثلاثة أشخاص مختلفين: واحد يطلبها، وآخر يعتمدها، وثالث ينفّذ التحويل.',
    empty: 'لا توجد إيرادات للمنصة بعد.',
  },
  admin: {
    queueTitle: 'طلبات سحب الأموال',
    queueIntro:
      'راجع المدفوعات واعتمدها وسجّلها. لا يُرسَل أي مال من هنا: تُنفَّذ التحويلات خارج PalCert وتُسجَّل برقمها المرجعي.',
    tabs: {
      PENDING_REVIEW: 'بانتظار المراجعة',
      APPROVED: 'معتمد',
      PROCESSING: 'قيد التنفيذ',
      PAID: 'تم التحويل',
      REJECTED: 'مرفوض',
      CANCELLED: 'ملغى',
      FAILED: 'تعذّر التحويل',
    },
    allStatuses: 'الكل',
    filters: {
      title: 'عوامل التصفية',
      scope: 'النطاق',
      anyScope: 'أي نطاق',
      currency: 'العملة',
      anyCurrency: 'أي عملة',
      from: 'أُرسل من تاريخ',
      to: 'أُرسل قبل تاريخ',
      apply: 'تطبيق',
      clear: 'مسح',
    },
    totalsTitle: 'المبالغ المفتوحة',
    totalsCaption: 'مبالغ طلبات السحب المفتوحة حسب الحالة والعملة',
    queueCaption: 'طلبات سحب الأموال',
    empty: 'لا توجد طلبات مطابقة.',
    columns: {
      reference: 'المرجع',
      scope: 'النطاق',
      requester: 'مقدّم الطلب',
      beneficiary: 'المستفيد',
      amount: 'المبلغ',
      status: 'الحالة',
      submitted: 'تاريخ الإرسال',
      count: 'الطلبات',
    },
    requester: 'مقدّم الطلب',
    organization: 'المؤسسة',
    availableBefore: 'القابل للسحب قبل هذا الطلب',
    reservation: 'الحجز',
    reservationActive: 'محجوز',
    reservationReleased: 'غير محجوز',
    releaseNote: 'سبب الإفراج',
    attemptsTitle: 'محاولات التحويل',
    attemptsCaption: 'محاولات التحويل',
    attemptColumns: {
      number: 'المحاولة',
      outcome: 'النتيجة',
      started: 'البدء',
      finished: 'الانتهاء',
      reference: 'الرقم المرجعي للتحويل',
      note: 'ملاحظة',
    },
    noAttempts: 'لم تُجرَ أي محاولة تحويل بعد.',
    separation:
      'لا يجوز لأحد اعتماد طلبه أو دفعه بنفسه. تحتاج دفعة PalCert إلى ثلاثة أشخاص مختلفين.',
    readOnly: 'يمكنك عرض هذا الطلب دون اتخاذ أي إجراء عليه.',
    reveal: 'عرض تفاصيل الدفع كاملة',
    revealTitle: 'تفاصيل الدفع كاملة',
    revealHint: 'تُعرض من النسخة المأخوذة عند إرسال الطلب، وتُسجَّل عملية العرض هذه.',
    hide: 'إخفاء',
    actions: {
      startReview: 'بدء المراجعة',
      approve: 'اعتماد',
      approveTitle: 'اعتماد هذه الدفعة؟',
      approveBody: (amount, beneficiary) =>
        `اعتماد دفع ${amount} إلى ${beneficiary}. لا تتحرك الأموال بعد: يبقى المبلغ محجوزًا حتى يُسجَّل التحويل.`,
      reject: 'رفض',
      rejectTitle: 'رفض طلب السحب هذا؟',
      rejectReason: 'السبب',
      rejectNote: 'ملاحظة لمقدّم الطلب',
      rejectNoteHint: 'مطلوبة عند اختيار «سبب آخر».',
      startExecution: 'بدء التحويل',
      startExecutionTitle: 'بدء التحويل؟',
      startExecutionBody: (amount, beneficiary) =>
        `ستُرسل ${amount} إلى ${beneficiary} خارج PalCert. سجّل النتيجة هنا عند الانتهاء.`,
      markPaid: 'تسجيل أنه تم التحويل',
      markPaidTitle: 'تسجيل هذه الدفعة على أنه تم التحويل؟',
      markPaidBody: (amount, beneficiary, destination) =>
        `أكّد أن ${amount} أُرسل إلى ${beneficiary} (${destination}). يُسوّي هذا طلب السحب ولا يمكن التراجع عنه.`,
      transferReference: 'الرقم المرجعي للتحويل',
      transferReferenceHint: 'الرقم المرجعي الذي أصدره البنك أو تطبيق الدفع للتحويل.',
      executionNote: 'ملاحظة',
      markFailed: 'تسجيل تعذّر التحويل',
      markFailedTitle: 'تسجيل تحويل لم يكتمل؟',
      markFailedBody: 'يبقى المبلغ محجوزًا، ويمكنك إعادة محاولة التحويل أو الإفراج عنه لاحقًا.',
      failureNote: 'ماذا حدث',
      retry: 'إعادة محاولة التحويل',
      retryTitle: 'إعادة محاولة التحويل؟',
      retryBody: 'تُسجَّل محاولة تحويل جديدة، وتبقى المحاولة السابقة في السجل.',
      release: 'إفراج',
      releaseTitle: 'الإفراج عن طلب السحب هذا؟',
      releaseBody: 'يُلغى طلب السحب ويُفرج عن المبلغ المحجوز. اذكر السبب.',
      releaseReason: 'السبب',
    },
    proofTitle: 'إيصال التحويل',
    proofIntro:
      'اختياري. ملف PDF أو PNG أو JPEG أو WebP حتى 5 ميغابايت. لا يُرسَل بالبريد ولا يكون عامًا أبدًا.',
    proofChoose: 'رفع إيصال التحويل',
    proofUploading: 'جارٍ الرفع…',
    proofUploaded: 'رُفع إيصال التحويل وهو قيد الفحص.',
    proofNone: 'لا يوجد إيصال تحويل.',
    notifications: {
      title: 'الإشعارات',
      intro: 'من أُبلغ بطلب السحب هذا، وما الذي حدث لكل رسالة.',
      pending: 'لم يُوجَّه بعد.',
      noReviewer: 'لم يكن بالإمكان إبلاغ أي شخص بطلب السحب هذا.',
      routing: {
        ASSIGNED_REVIEWERS: 'أُرسل إلى مراجعي طلبات السحب المعيّنين.',
        FALLBACK_NO_ELIGIBLE:
          'لم يكن بإمكان أي مراجع معيّن التصرّف، فأُبلغ جميع مراجعي المالية في PalCert.',
        GLOBAL_NOT_CONFIGURED: 'لا يوجد مراجعون معيّنون، فأُبلغ جميع مراجعي المالية في PalCert.',
      },
      caption: 'تسليم الإشعارات',
      columns: {
        recipient: 'المستلم',
        type: 'الرسالة',
        inApp: 'داخل PalCert',
        email: 'البريد الإلكتروني',
        reason: 'سبب عدم الإرسال',
      },
      verified: 'بريد موثّق',
      notVerified: 'بريد غير موثّق',
      none: '—',
      emailStatuses: {
        PENDING: 'بالانتظار',
        SENT: 'أُرسل',
        DELIVERED: 'وصل',
        FAILED: 'فشل',
        SKIPPED: 'لم يُرسَل',
      },
      skipReasons: {
        PREFERENCE_DISABLED: 'أوقفه المستلم',
        EMAIL_NOT_VERIFIED: 'البريد غير موثّق',
        AUTHORIZATION_REVOKED: 'لم يعد مخوّلًا بالمراجعة',
        ACCOUNT_INACTIVE: 'الحساب غير نشط',
        CHANNEL_DISABLED: 'البريد الإلكتروني متوقف',
      },
      types: {
        WITHDRAWAL_PENDING_REVIEW: 'تنبيه المراجعة',
        WITHDRAWAL_SUBMITTED: 'استلام الطلب',
        WITHDRAWAL_APPROVED: 'معتمد',
        WITHDRAWAL_REJECTED: 'مرفوض',
        WITHDRAWAL_PAID: 'تم التحويل',
        WITHDRAWAL_FAILED: 'تعذّر التحويل',
      },
    },
  },
  settings: {
    title: 'إعدادات السحب',
    intro: 'فترات التسوية والحدود ومن يراجع طلبات السحب وفحص الاتساق.',
    policyTitle: 'فترات التسوية',
    userDays: 'الشحن اليدوي (أيام)',
    userDaysHint:
      'المدة التي ينتظرها التحويل البنكي أو عبر الجوال الموثّق قبل أن يصبح قابلًا للسحب، من 0 إلى 90.',
    organizationDays: 'أرباح المؤسسات (أيام)',
    organizationDaysHint: 'المدة التي تنتظرها الأرباح المسوّاة قبل أن يمكن دفعها، من 0 إلى 180.',
    feeNone: 'لا توجد رسوم على السحب.',
    save: 'حفظ',
    saved: 'تم الحفظ.',
    limitsTitle: 'الحدود لكل طلب',
    limitsIntro: 'حدّ أدنى وأقصى اختياريان لطلب السحب الواحد، لكل عملة.',
    limitsCaption: 'حدود السحب حسب العملة',
    limitCurrency: 'العملة',
    limitMinimum: 'الحد الأدنى',
    limitMaximum: 'الحد الأقصى',
    noLimit: 'بلا حد',
    saveLimit: 'حفظ الحد',
    reviewersTitle: 'مراجعو طلبات السحب',
    reviewersIntro: 'موظفو المالية في PalCert الذين يُنبَّهون عند إرسال طلب سحب.',
    reviewersEmptyMeansAll: 'إن لم يُختر أحد، يُنبَّه جميع مراجعي المالية في PalCert.',
    eligible: 'يمكنه المراجعة',
    notEligible: 'لم يعد يمكنه المراجعة',
    saveReviewers: 'حفظ المراجعين',
    noCandidates: 'لا يوجد بعد موظفون في PalCert يمكنهم مراجعة طلبات السحب.',
    reconciliationTitle: 'فحص الاتساق',
    reconciliationIntro:
      'يقارن كل طلب سحب بالمبالغ التي حجزها وسوّاها. يُبلغ عن المشكلات ولا يغيّر أي شيء.',
    runReconciliation: 'تشغيل الفحص',
    consistent: (count) => `جميع طلبات السحب (${count}) متّسقة.`,
    findingsTitle: (count) => `وُجدت ${count} مشكلات`,
    findingsCaption: 'مشكلات الاتساق',
    findingColumns: {
      code: 'المشكلة',
      detail: 'التفاصيل',
      subject: 'يخص',
    },
    readOnly: 'يمكنك عرض هذه الإعدادات دون تغييرها.',
  },
};

export const WITHDRAWAL_MESSAGES: Readonly<Record<Locale, WithdrawalMessages>> = { en, ar };

export function getWithdrawalMessages(locale: Locale): WithdrawalMessages {
  return WITHDRAWAL_MESSAGES[locale];
}
