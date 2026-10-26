import {
  ManualTopUpRejectionReason,
  NotificationAudience,
  NotificationType,
  WithdrawalRejectionReason,
  WithdrawalScope,
  formatMinorUnits,
  isManualTopUpNotificationType,
  isWithdrawalNotificationType,
  withdrawalReference,
} from '@palcert/contracts';

/**
 * The version stamped on every rendered copy (§33).
 *
 * A notification records what somebody was actually told, so changing the
 * wording must never rewrite what an old one says. The rendered strings are
 * stored on the row with this version beside them; editing the copy below
 * requires bumping it, and the golden test at the bottom of this module's
 * suite pins the current version's output byte for byte.
 */
export const NOTIFICATION_TEMPLATE_VERSION = 'notification-v1';

/** The locales PalCert renders. Anything else falls back to English (§37). */
export const NOTIFICATION_LOCALES = ['en', 'ar'] as const;
export type NotificationLocale = (typeof NOTIFICATION_LOCALES)[number];

export const DEFAULT_NOTIFICATION_LOCALE: NotificationLocale = 'en';

/**
 * A stored preference is not a promise that the value is renderable.
 *
 * `User.preferredLocale` is a free TEXT column that predates this phase, and a
 * notification is not the place to discover that. An unknown value renders in
 * English rather than failing the delivery or emitting an empty template.
 */
export function resolveNotificationLocale(value: string | null | undefined): NotificationLocale {
  const candidate = (value ?? '').trim().toLowerCase();
  return (NOTIFICATION_LOCALES as readonly string[]).includes(candidate)
    ? (candidate as NotificationLocale)
    : DEFAULT_NOTIFICATION_LOCALE;
}

interface Copy {
  /** In-app title, and the email subject. One string, so the two cannot drift. */
  readonly title: string;
  readonly body: string;
  /** What the link says. The href itself is the notification's deep link. */
  readonly action: string;
}

/**
 * The copy, in full, for both locales.
 *
 * Every string here is fixed text. No payload value is interpolated into any
 * of them, which is why there is nothing to escape in the copy itself and why
 * rendering cannot leak a document title, a filename, a comment body or an
 * address into somebody's mail. What the reader gets is the fact that
 * something happened and a link to the place it happened; the substance
 * requires signing in (§11, §31).
 *
 * Manual top-ups and withdrawals are the two closed exceptions: their copy
 * is followed by a typed list of facts (see `ManualTopUpNotificationFacts`
 * and `WithdrawalNotificationFacts`), because "your top-up was approved" is
 * not useful without saying which one. The sentences themselves remain fixed.
 */
const COPY: Readonly<Record<NotificationLocale, Readonly<Record<NotificationType, Copy>>>> = {
  en: {
    [NotificationType.SUBMISSION_READY]: {
      title: 'A new submission is ready for review',
      body: 'A submission has been handed to your organization and is ready to be reviewed.',
      action: 'Open the submission',
    },
    [NotificationType.SUBMISSION_REVISION_READY]: {
      title: 'A revised submission is ready for review',
      body: 'A submission you have already seen has been resubmitted with a new revision.',
      action: 'Open the submission',
    },
    [NotificationType.SUBMISSION_UNDER_REVIEW]: {
      title: 'Your submission is under review',
      body: 'The institution has started reviewing your submission.',
      action: 'Open your submission',
    },
    [NotificationType.SUBMISSION_APPROVED]: {
      title: 'Your submission was approved',
      body: 'The institution has approved your submission.',
      action: 'Open your submission',
    },
    [NotificationType.SUBMISSION_REJECTED]: {
      title: 'Your submission was rejected',
      body: 'The institution has rejected your submission. Its reasons are on the submission itself.',
      action: 'Open your submission',
    },
    [NotificationType.SUBMISSION_REVISION_REQUESTED]: {
      title: 'A revision was requested',
      body: 'The institution has asked for changes before it can decide on your submission.',
      action: 'Open your submission',
    },
    [NotificationType.SUBMISSION_COMMENT_ADDED]: {
      title: 'A reviewer left a comment',
      body: 'A reviewer has written to you about your submission. Sign in to read it.',
      action: 'Open your submission',
    },
    [NotificationType.CERTIFICATE_ISSUED]: {
      title: 'Your certificate has been issued',
      body: 'A compliance certificate has been issued for your approved submission.',
      action: 'Open your certificate',
    },
    [NotificationType.CERTIFICATE_REVOKED]: {
      title: 'Your certificate has been revoked',
      body: 'A compliance certificate issued to you has been withdrawn and no longer verifies. Anyone checking it will be told it is revoked.',
      action: 'Open your certificate',
    },
    [NotificationType.ATTESTATION_SUBMITTED]: {
      title: 'Your attestation request was submitted',
      body: 'Your certificate has been sent to the institution for review. Any fee is reserved from your balance and is only charged if the institution approves.',
      action: 'Open your request',
    },
    [NotificationType.ATTESTATION_READY_FOR_REVIEW]: {
      title: 'A certificate is waiting for attestation',
      body: 'A user has submitted a certificate for your organization to review and attest.',
      action: 'Open the request',
    },
    [NotificationType.ATTESTATION_INFORMATION_REQUESTED]: {
      title: 'The institution needs more information',
      body: 'The institution reviewing your certificate has asked you a question. Sign in to read it and respond.',
      action: 'Open your request',
    },
    [NotificationType.ATTESTATION_INFORMATION_PROVIDED]: {
      title: 'A requester has responded',
      body: 'A user has answered your question about a certificate awaiting attestation.',
      action: 'Open the request',
    },
    [NotificationType.ATTESTATION_APPROVED]: {
      title: 'Your certificate has been attested',
      body: 'The institution approved your request. Your attestation, verification link and QR code are ready.',
      action: 'Open your attestation',
    },
    [NotificationType.ATTESTATION_REJECTED]: {
      title: 'Your attestation request was rejected',
      body: 'The institution rejected your request. Its reason is on the request, and any reserved fee has been released to your balance.',
      action: 'Open your request',
    },
    [NotificationType.ATTESTATION_REVOKED]: {
      title: 'Your attestation has been revoked',
      body: 'An attestation of your certificate has been withdrawn by the institution. Anyone verifying it will be told it is revoked.',
      action: 'Open your attestation',
    },
    [NotificationType.ATTESTATION_EXPIRING]: {
      title: 'Your attestation expires soon',
      body: 'An attestation of your certificate is approaching the end of its validity period. You can submit it for re-attestation.',
      action: 'Open your attestation',
    },
    [NotificationType.ATTESTATION_EXPIRED]: {
      title: 'Your attestation has expired',
      body: 'An attestation of your certificate has reached the end of its validity period. Anyone verifying it will be told it has expired.',
      action: 'Open your attestation',
    },
    [NotificationType.MANUAL_TOPUP_SUBMITTED]: {
      title: 'A manual top-up is waiting for verification',
      body: 'A customer reported a transfer to a PalCert payment account. Match it against the receiving account before approving it.',
      action: 'Open the top-up request',
    },
    [NotificationType.MANUAL_TOPUP_APPROVED]: {
      title: 'Your top-up was approved',
      body: 'PalCert finance verified your transfer and added it to your balance.',
      action: 'Open your top-up',
    },
    [NotificationType.MANUAL_TOPUP_REJECTED]: {
      title: 'Your top-up could not be verified',
      body: 'PalCert finance could not verify your transfer, so nothing was added to your balance.',
      action: 'Open your top-up',
    },
    [NotificationType.WITHDRAWAL_PENDING_REVIEW]: {
      title: 'Withdrawal request',
      body: 'A withdrawal request is waiting for PalCert finance review. The amount is already reserved. Check the beneficiary and the payout destination in PalCert before approving it.',
      action: 'Review in PalCert',
    },
    [NotificationType.WITHDRAWAL_SUBMITTED]: {
      title: 'Your withdrawal request was submitted',
      body: 'The amount is reserved for withdrawal and PalCert finance will review your request. Reserved money cannot be spent while the request is open.',
      action: 'Open your withdrawal',
    },
    [NotificationType.WITHDRAWAL_APPROVED]: {
      title: 'Your withdrawal was approved',
      body: 'PalCert finance approved your request. The transfer will be sent to your payout destination, and you will be told when it has been paid.',
      action: 'Open your withdrawal',
    },
    [NotificationType.WITHDRAWAL_REJECTED]: {
      title: 'Your withdrawal request was rejected',
      body: 'PalCert finance rejected your request, and the reserved amount was released.',
      action: 'Open your withdrawal',
    },
    [NotificationType.WITHDRAWAL_PAID]: {
      title: 'Your withdrawal was paid',
      body: 'PalCert finance sent the transfer to your payout destination. The transfer reference is on the request.',
      action: 'Open your withdrawal',
    },
    [NotificationType.WITHDRAWAL_FAILED]: {
      title: 'Your withdrawal transfer did not go through',
      body: 'The transfer to your payout destination failed. The amount stays reserved for withdrawal while PalCert finance retries it or releases it.',
      action: 'Open your withdrawal',
    },
  },
  ar: {
    [NotificationType.SUBMISSION_READY]: {
      title: 'طلب جديد جاهز للمراجعة',
      body: 'تم تسليم طلب إلى مؤسستك وهو جاهز للمراجعة.',
      action: 'فتح الطلب',
    },
    [NotificationType.SUBMISSION_REVISION_READY]: {
      title: 'نسخة منقّحة جاهزة للمراجعة',
      body: 'أُعيد تقديم طلب سبق أن اطّلعت عليه بنسخة منقّحة جديدة.',
      action: 'فتح الطلب',
    },
    [NotificationType.SUBMISSION_UNDER_REVIEW]: {
      title: 'طلبك قيد المراجعة',
      body: 'بدأت المؤسسة مراجعة طلبك.',
      action: 'فتح طلبك',
    },
    [NotificationType.SUBMISSION_APPROVED]: {
      title: 'تمت الموافقة على طلبك',
      body: 'وافقت المؤسسة على طلبك.',
      action: 'فتح طلبك',
    },
    [NotificationType.SUBMISSION_REJECTED]: {
      title: 'تم رفض طلبك',
      body: 'رفضت المؤسسة طلبك، وأسباب الرفض مدوّنة على الطلب نفسه.',
      action: 'فتح طلبك',
    },
    [NotificationType.SUBMISSION_REVISION_REQUESTED]: {
      title: 'طُلب إجراء تعديلات',
      body: 'طلبت المؤسسة إجراء تعديلات قبل أن تتمكن من البتّ في طلبك.',
      action: 'فتح طلبك',
    },
    [NotificationType.SUBMISSION_COMMENT_ADDED]: {
      title: 'أضاف أحد المراجعين تعليقًا',
      body: 'كتب أحد المراجعين إليك بشأن طلبك. سجّل الدخول لقراءته.',
      action: 'فتح طلبك',
    },
    [NotificationType.CERTIFICATE_ISSUED]: {
      title: 'تم إصدار شهادتك',
      body: 'صدرت شهادة امتثال لطلبك المعتمد.',
      action: 'فتح شهادتك',
    },
    [NotificationType.CERTIFICATE_REVOKED]: {
      title: 'تم سحب شهادتك',
      body: 'سُحبت شهادة امتثال صادرة لك ولم تعد صالحة للتحقق. وسيُبلَّغ كل من يتحقق منها بأنها مسحوبة.',
      action: 'فتح شهادتك',
    },
    [NotificationType.ATTESTATION_SUBMITTED]: {
      title: 'تم تقديم طلب التصديق',
      body: 'أُرسلت شهادتك إلى المؤسسة لمراجعتها. تُحجز أي رسوم من رصيدك ولا تُخصم إلا إذا وافقت المؤسسة.',
      action: 'فتح طلبك',
    },
    [NotificationType.ATTESTATION_READY_FOR_REVIEW]: {
      title: 'شهادة بانتظار التصديق',
      body: 'قدّم أحد المستخدمين شهادة لتراجعها مؤسستك وتصادق عليها.',
      action: 'فتح الطلب',
    },
    [NotificationType.ATTESTATION_INFORMATION_REQUESTED]: {
      title: 'تحتاج المؤسسة إلى معلومات إضافية',
      body: 'طرحت المؤسسة التي تراجع شهادتك سؤالًا عليك. سجّل الدخول لقراءته والرد عليه.',
      action: 'فتح طلبك',
    },
    [NotificationType.ATTESTATION_INFORMATION_PROVIDED]: {
      title: 'ردّ مقدّم الطلب',
      body: 'أجاب أحد المستخدمين عن سؤالك بشأن شهادة بانتظار التصديق.',
      action: 'فتح الطلب',
    },
    [NotificationType.ATTESTATION_APPROVED]: {
      title: 'تم تصديق شهادتك',
      body: 'وافقت المؤسسة على طلبك. أصبح التصديق ورابط التحقق ورمز QR جاهزة.',
      action: 'فتح التصديق',
    },
    [NotificationType.ATTESTATION_REJECTED]: {
      title: 'تم رفض طلب التصديق',
      body: 'رفضت المؤسسة طلبك. السبب مدوّن على الطلب، وأُعيدت أي رسوم محجوزة إلى رصيدك.',
      action: 'فتح طلبك',
    },
    [NotificationType.ATTESTATION_REVOKED]: {
      title: 'تم سحب تصديق شهادتك',
      body: 'سحبت المؤسسة تصديقًا لشهادتك. وسيُبلَّغ كل من يتحقق منه بأنه مسحوب.',
      action: 'فتح التصديق',
    },
    [NotificationType.ATTESTATION_EXPIRING]: {
      title: 'يقترب انتهاء صلاحية تصديقك',
      body: 'يقترب تصديق شهادتك من نهاية مدة صلاحيته. يمكنك تقديمها لإعادة التصديق.',
      action: 'فتح التصديق',
    },
    [NotificationType.ATTESTATION_EXPIRED]: {
      title: 'انتهت صلاحية تصديقك',
      body: 'بلغ تصديق شهادتك نهاية مدة صلاحيته. وسيُبلَّغ كل من يتحقق منه بأنه منتهي الصلاحية.',
      action: 'فتح التصديق',
    },
    [NotificationType.MANUAL_TOPUP_SUBMITTED]: {
      title: 'طلب شحن يدوي بانتظار التحقق',
      body: 'أبلغ أحد العملاء عن تحويل إلى أحد حسابات الدفع الخاصة بـ PalCert. طابِقه مع الحساب المستلم قبل الموافقة عليه.',
      action: 'فتح طلب الشحن',
    },
    [NotificationType.MANUAL_TOPUP_APPROVED]: {
      title: 'تمت الموافقة على شحن رصيدك',
      body: 'تحقق فريق المالية في PalCert من تحويلك وأضافه إلى رصيدك.',
      action: 'فتح طلب الشحن',
    },
    [NotificationType.MANUAL_TOPUP_REJECTED]: {
      title: 'تعذّر التحقق من شحن رصيدك',
      body: 'لم يتمكن فريق المالية في PalCert من التحقق من تحويلك، لذلك لم يُضَف شيء إلى رصيدك.',
      action: 'فتح طلب الشحن',
    },
    [NotificationType.WITHDRAWAL_PENDING_REVIEW]: {
      title: 'طلب سحب الأموال',
      body: 'طلب سحب أموال بانتظار مراجعة فريق المالية في PalCert، والمبلغ محجوز للسحب. تحقّق من المستفيد ومن جهة استلام الأموال في PalCert قبل اعتماده.',
      action: 'المراجعة في PalCert',
    },
    [NotificationType.WITHDRAWAL_SUBMITTED]: {
      title: 'تم تقديم طلب سحب الأموال',
      body: 'أصبح المبلغ محجوزًا للسحب، وسيراجع فريق المالية في PalCert طلبك. لا يمكن إنفاق المبلغ المحجوز ما دام الطلب مفتوحًا.',
      action: 'فتح طلب السحب',
    },
    [NotificationType.WITHDRAWAL_APPROVED]: {
      title: 'تم اعتماد طلب سحب الأموال',
      body: 'اعتمد فريق المالية في PalCert طلبك. سيُرسَل التحويل إلى جهة استلام الأموال، وسنُعلمك عند إتمامه.',
      action: 'فتح طلب السحب',
    },
    [NotificationType.WITHDRAWAL_REJECTED]: {
      title: 'تم رفض طلب سحب الأموال',
      body: 'رفض فريق المالية في PalCert طلبك، وأُفرج عن المبلغ المحجوز.',
      action: 'فتح طلب السحب',
    },
    [NotificationType.WITHDRAWAL_PAID]: {
      title: 'تم تحويل أموالك',
      body: 'أرسل فريق المالية في PalCert التحويل إلى جهة استلام الأموال. الرقم المرجعي للتحويل مدوّن على الطلب.',
      action: 'فتح طلب السحب',
    },
    [NotificationType.WITHDRAWAL_FAILED]: {
      title: 'تعذّر إتمام تحويل السحب',
      body: 'لم يكتمل التحويل إلى جهة استلام الأموال. يبقى المبلغ محجوزًا للسحب إلى أن يعيد فريق المالية في PalCert المحاولة أو يُفرج عنه.',
      action: 'فتح طلب السحب',
    },
  },
};

/**
 * The facts a manual top-up notification shows, and nothing else.
 *
 * The one exception to "fixed text only", and a closed one: five typed
 * fields read from the request itself at render time — never from the event
 * payload, never from a caller — plus a reason code that selects a fixed
 * sentence. There is no receipt, no IBAN, no phone number and no customer
 * address here, and no way to add one without changing this type. Every
 * value is escaped before it reaches HTML.
 */
export interface ManualTopUpNotificationFacts {
  readonly amountMinor: bigint;
  readonly currency: string;
  readonly methodNameEn: string;
  readonly methodNameAr: string;
  /** What the person typed as the transfer reference. */
  readonly reference: string;
  readonly rejectionReason: ManualTopUpRejectionReason | null;
  /** When the person sent it for verification; null before then. */
  readonly submittedAt: Date | null;
}

const FACT_LABELS: Readonly<
  Record<
    NotificationLocale,
    { amount: string; method: string; reference: string; submitted: string; reason: string }
  >
> = {
  en: {
    amount: 'Amount',
    method: 'Payment method',
    reference: 'Reference',
    submitted: 'Submitted',
    reason: 'Reason',
  },
  ar: {
    amount: 'المبلغ',
    method: 'طريقة الدفع',
    reference: 'المرجع',
    submitted: 'وقت الإرسال',
    reason: 'السبب',
  },
};

/** A UTC timestamp, the same bytes in every process: 2026-10-03 14:05 UTC. */
function utcMinute(value: Date): string {
  return `${value.toISOString().slice(0, 16).replace('T', ' ')} UTC`;
}

const REJECTION_SENTENCES: Readonly<
  Record<NotificationLocale, Readonly<Record<ManualTopUpRejectionReason, string>>>
> = {
  en: {
    REFERENCE_NOT_FOUND: 'No transfer with this reference was found on the receiving account.',
    AMOUNT_MISMATCH: 'The amount received does not match the amount reported.',
    DUPLICATE_REFERENCE: 'This transfer has already been reported.',
    RECEIPT_UNCLEAR: 'The receipt could not be read clearly enough to verify the transfer.',
    PAYMENT_NOT_RECEIVED: 'The payment has not arrived on the receiving account.',
    INVALID_PAYMENT_METHOD: 'The transfer was not made to the selected payment method.',
    OTHER: 'See the request for details from PalCert finance.',
  },
  ar: {
    REFERENCE_NOT_FOUND: 'لم يُعثر على تحويل بهذا المرجع في الحساب المستلم.',
    AMOUNT_MISMATCH: 'المبلغ المستلم لا يطابق المبلغ المُبلَّغ عنه.',
    DUPLICATE_REFERENCE: 'تم الإبلاغ عن هذا التحويل من قبل.',
    RECEIPT_UNCLEAR: 'تعذّرت قراءة الإيصال بوضوح كافٍ للتحقق من التحويل.',
    PAYMENT_NOT_RECEIVED: 'لم تصل الدفعة إلى الحساب المستلم بعد.',
    INVALID_PAYMENT_METHOD: 'لم يُجرَ التحويل إلى طريقة الدفع المختارة.',
    OTHER: 'راجع الطلب لمعرفة التفاصيل من فريق المالية في PalCert.',
  },
};

/** The facts as labelled lines, in a fixed order, with no locale-sensitive formatting. */
function manualTopUpFactLines(
  locale: NotificationLocale,
  facts: ManualTopUpNotificationFacts,
): readonly string[] {
  const labels = FACT_LABELS[locale];
  // Exact and deterministic: digits sliced by the currency's exponent, then
  // the ISO code. The same bytes in every process, for ever.
  const lines = [
    `${labels.amount}: ${formatMinorUnits(facts.amountMinor, facts.currency)} ${facts.currency}`,
    `${labels.method}: ${locale === 'ar' ? facts.methodNameAr : facts.methodNameEn}`,
    `${labels.reference}: ${facts.reference}`,
  ];
  if (facts.submittedAt !== null) {
    lines.push(`${labels.submitted}: ${utcMinute(facts.submittedAt)}`);
  }
  if (facts.rejectionReason !== null) {
    lines.push(`${labels.reason}: ${REJECTION_SENTENCES[locale][facts.rejectionReason]}`);
  }
  return lines;
}

/**
 * The facts a withdrawal notification shows, and nothing else (ADR-0150).
 *
 * Closed like the manual top-up facts: read from the request at render time,
 * never from the event payload. There is no IBAN, no account number, no
 * mobile number and no proof here — not even masked — and no way to add one
 * without changing this type. Every value is escaped before it reaches HTML.
 */
export interface WithdrawalNotificationFacts {
  readonly requestId: string;
  readonly scope: WithdrawalScope;
  readonly amountMinor: bigint;
  readonly currency: string;
  readonly beneficiaryName: string;
  readonly organizationId: string | null;
  readonly organizationName: string | null;
  readonly requesterName: string;
  readonly requesterEmail: string;
  readonly rejectionReason: WithdrawalRejectionReason | null;
  readonly submittedAt: Date | null;
}

const WITHDRAWAL_FACT_LABELS: Readonly<
  Record<
    NotificationLocale,
    {
      reference: string;
      scope: string;
      requester: string;
      beneficiary: string;
      amount: string;
      submitted: string;
      reason: string;
    }
  >
> = {
  en: {
    reference: 'Request reference',
    scope: 'Scope',
    requester: 'Requester',
    beneficiary: 'Beneficiary',
    amount: 'Amount',
    submitted: 'Submitted',
    reason: 'Reason',
  },
  ar: {
    reference: 'مرجع الطلب',
    scope: 'النطاق',
    requester: 'مقدّم الطلب',
    beneficiary: 'المستفيد',
    amount: 'المبلغ',
    submitted: 'وقت الإرسال',
    reason: 'السبب',
  },
};

const WITHDRAWAL_SCOPE_LABELS: Readonly<
  Record<NotificationLocale, Readonly<Record<WithdrawalScope, string>>>
> = {
  en: {
    USER: 'Personal balance',
    ORGANIZATION: 'Organization earnings',
    PLATFORM: 'PalCert revenue',
  },
  ar: {
    USER: 'الرصيد الشخصي',
    ORGANIZATION: 'أرباح المؤسسة',
    PLATFORM: 'إيرادات PalCert',
  },
};

const WITHDRAWAL_REJECTION_SENTENCES: Readonly<
  Record<NotificationLocale, Readonly<Record<WithdrawalRejectionReason, string>>>
> = {
  en: {
    DESTINATION_INVALID: 'The payout destination could not be used.',
    BENEFICIARY_MISMATCH: 'The beneficiary does not match the account holder.',
    VERIFICATION_REQUIRED: 'More verification is needed before a payout can be made.',
    POLICY_VIOLATION: 'The request does not meet PalCert withdrawal policy.',
    SUSPECTED_FRAUD: 'The request could not be approved for security reasons.',
    DUPLICATE_REQUEST: 'This withdrawal was already requested.',
    OTHER: 'See the request for details from PalCert finance.',
  },
  ar: {
    DESTINATION_INVALID: 'تعذّر استخدام جهة استلام الأموال.',
    BENEFICIARY_MISMATCH: 'اسم المستفيد لا يطابق صاحب الحساب.',
    VERIFICATION_REQUIRED: 'يلزم مزيد من التحقق قبل إجراء التحويل.',
    POLICY_VIOLATION: 'الطلب لا يستوفي سياسة السحب في PalCert.',
    SUSPECTED_FRAUD: 'تعذّر اعتماد الطلب لأسباب أمنية.',
    DUPLICATE_REQUEST: 'سبق تقديم طلب السحب هذا.',
    OTHER: 'راجع الطلب لمعرفة التفاصيل من فريق المالية في PalCert.',
  },
};

function withdrawalAmount(facts: WithdrawalNotificationFacts): string {
  return `${formatMinorUnits(facts.amountMinor, facts.currency)} ${facts.currency}`;
}

/** The facts as labelled lines, in a fixed order, with no locale-sensitive formatting. */
function withdrawalFactLines(
  locale: NotificationLocale,
  type: NotificationType,
  facts: WithdrawalNotificationFacts,
): readonly string[] {
  const labels = WITHDRAWAL_FACT_LABELS[locale];
  const scope = WITHDRAWAL_SCOPE_LABELS[locale][facts.scope];
  const lines = [
    `${labels.reference}: ${withdrawalReference(facts.requestId)}`,
    `${labels.scope}: ${
      facts.organizationName === null ? scope : `${scope} — ${facts.organizationName}`
    }`,
  ];
  // Finance needs to know who asked; the requester already does.
  if (type === NotificationType.WITHDRAWAL_PENDING_REVIEW) {
    lines.push(`${labels.requester}: ${facts.requesterName} <${facts.requesterEmail}>`);
  }
  lines.push(`${labels.beneficiary}: ${facts.beneficiaryName}`);
  lines.push(`${labels.amount}: ${withdrawalAmount(facts)}`);
  if (facts.submittedAt !== null) {
    lines.push(`${labels.submitted}: ${utcMinute(facts.submittedAt)}`);
  }
  if (facts.rejectionReason !== null) {
    lines.push(
      `${labels.reason}: ${WITHDRAWAL_REJECTION_SENTENCES[locale][facts.rejectionReason]}`,
    );
  }
  return lines;
}

export interface RenderedNotification {
  readonly templateVersion: string;
  readonly locale: NotificationLocale;
  readonly title: string;
  readonly body: string;
  readonly subject: string;
  readonly text: string;
  readonly html: string;
}

/** Escape the five characters that can end an HTML text node or an attribute. */
function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Render one notification, in-app and email copy together.
 *
 * Deterministic: the same type, locale and link produce the same bytes on
 * every call, in every process, for ever. There is no timestamp, no counter
 * and no locale-sensitive formatting in the output — which is what lets a
 * golden test pin it and what makes a re-rendered copy comparable to the one
 * that was stored.
 */
export function renderNotification(params: {
  readonly type: NotificationType;
  readonly locale: string | null | undefined;
  /** An application route, e.g. `/submissions/<id>`. */
  readonly deepLink: string;
  /** The deployment's public origin, for the link in the email. */
  readonly appOrigin: string;
  /** Required for, and only accepted with, the manual top-up types. */
  readonly manualTopUp?: ManualTopUpNotificationFacts | undefined;
  /** Required for, and only accepted with, the withdrawal types. */
  readonly withdrawal?: WithdrawalNotificationFacts | undefined;
}): RenderedNotification {
  const locale = resolveNotificationLocale(params.locale);
  const fixed = COPY[locale][params.type];
  const direction = locale === 'ar' ? 'rtl' : 'ltr';

  const isManualTopUp = isManualTopUpNotificationType(params.type);
  if (isManualTopUp !== (params.manualTopUp !== undefined)) {
    throw new Error(
      isManualTopUp
        ? `a ${params.type} notification needs its top-up facts`
        : `a ${params.type} notification takes no top-up facts`,
    );
  }
  const isWithdrawal = isWithdrawalNotificationType(params.type);
  if (isWithdrawal !== (params.withdrawal !== undefined)) {
    throw new Error(
      isWithdrawal
        ? `a ${params.type} notification needs its withdrawal facts`
        : `a ${params.type} notification takes no withdrawal facts`,
    );
  }
  // A withdrawal's subject names its amount ("Withdrawal request: 500.00
  // USD"), exact digits and an ISO code, so the inbox line alone says which.
  const copy: Copy =
    params.withdrawal === undefined
      ? fixed
      : { ...fixed, title: `${fixed.title}: ${withdrawalAmount(params.withdrawal)}` };
  const factLines =
    params.manualTopUp !== undefined
      ? manualTopUpFactLines(locale, params.manualTopUp)
      : params.withdrawal !== undefined
        ? withdrawalFactLines(locale, params.type, params.withdrawal)
        : [];
  const body = factLines.length === 0 ? copy.body : `${copy.body}\n\n${factLines.join('\n')}`;

  // Joined rather than templated so a trailing slash on the origin cannot
  // produce `//submissions/...`, which some proxies treat as a protocol-
  // relative URL and would send the reader somewhere else entirely.
  const url = `${params.appOrigin.replace(/\/+$/, '')}${params.deepLink}`;
  const safeUrl = escapeHtml(url);

  const text = `${copy.title}\n\n${body}\n\n${copy.action}: ${url}\n`;

  // The facts are their own list so that a reference or a method name, which
  // are the only values here that a person typed, are escaped text nodes and
  // can never be markup. Every other type renders byte-for-byte as before.
  const factsHtml =
    factLines.length === 0
      ? ''
      : `<ul>${factLines.map((line) => `<li>${escapeHtml(line)}</li>`).join('')}</ul>`;

  const html =
    `<!doctype html><html lang="${locale}" dir="${direction}"><body>` +
    `<h1>${escapeHtml(copy.title)}</h1>` +
    `<p>${escapeHtml(copy.body)}</p>` +
    factsHtml +
    `<p><a href="${safeUrl}">${escapeHtml(copy.action)}</a></p>` +
    `</body></html>`;

  return {
    templateVersion: NOTIFICATION_TEMPLATE_VERSION,
    locale,
    title: copy.title,
    body,
    subject: copy.title,
    text,
    html,
  };
}

/**
 * Where a notification points (§32).
 *
 * Always an application route, never an absolute URL and never a signed
 * storage link: a link in an email is a link a mail provider, a spam filter
 * and anybody the message is forwarded to can follow, so it must lead to a
 * page that asks who you are rather than to bytes.
 *
 * The route differs by audience because the two audiences genuinely see
 * different pages: an author opens their own submission, a reviewer opens the
 * same submission inside the organization whose queue it is in. Sending a
 * reviewer to the author's route would be a link to a page the recipient is
 * not authorized for — a notification that reads as a permission error.
 */
export function notificationDeepLink(params: {
  readonly audience: NotificationAudience;
  readonly locale: NotificationLocale;
  readonly organizationId: string | null;
  readonly submissionId?: string;
  readonly certificateId?: string;
  readonly attestationRequestId?: string;
  readonly manualTopUpRequestId?: string;
  readonly withdrawal?: {
    readonly requestId: string;
    readonly scope: WithdrawalScope;
    readonly organizationId: string | null;
  };
}): string {
  const prefix = `/${params.locale}`;

  // Withdrawals are platform-scoped notifications whatever their scope; the
  // owner's page depends on whose money it is.
  if (params.audience === NotificationAudience.WITHDRAWAL_FINANCE_REVIEWERS) {
    if (!params.withdrawal) throw new Error('a withdrawal notification needs a request');
    return `${prefix}/admin/withdrawals/${params.withdrawal.requestId}`;
  }
  if (params.audience === NotificationAudience.WITHDRAWAL_OWNER) {
    const withdrawal = params.withdrawal;
    if (!withdrawal) throw new Error('a withdrawal notification needs a request');
    if (withdrawal.scope === WithdrawalScope.USER) {
      return `${prefix}/balance/withdrawals/${withdrawal.requestId}`;
    }
    if (withdrawal.scope === WithdrawalScope.ORGANIZATION) {
      if (withdrawal.organizationId === null) {
        throw new Error('an organization withdrawal needs its organization');
      }
      return `${prefix}/organizations/${withdrawal.organizationId}/payouts/${withdrawal.requestId}`;
    }
    return `${prefix}/admin/withdrawals/${withdrawal.requestId}`;
  }

  // Manual top-ups happen to no organization, so their links never name one.
  if (params.audience === NotificationAudience.MANUAL_TOPUP_OWNER) {
    if (!params.manualTopUpRequestId) throw new Error('a top-up notification needs a request id');
    return `${prefix}/balance/top-ups/${params.manualTopUpRequestId}`;
  }
  if (params.audience === NotificationAudience.PLATFORM_FINANCE_REVIEWERS) {
    if (!params.manualTopUpRequestId) throw new Error('a top-up notification needs a request id');
    return `${prefix}/admin/top-ups/${params.manualTopUpRequestId}`;
  }

  // Every other audience is organization-scoped, and the database guarantees
  // its events carry one.
  if (params.organizationId === null) {
    throw new Error(`a ${params.audience} notification needs an organization`);
  }

  if (params.audience === NotificationAudience.ATTESTATION_OWNER) {
    if (!params.attestationRequestId) {
      throw new Error('an attestation notification needs a request id');
    }
    return `${prefix}/attestations/${params.attestationRequestId}`;
  }
  if (params.audience === NotificationAudience.ATTESTATION_REVIEWERS) {
    if (!params.attestationRequestId) {
      throw new Error('an attestation notification needs a request id');
    }
    return `${prefix}/organizations/${params.organizationId}/attestations/${params.attestationRequestId}`;
  }

  if (params.audience === NotificationAudience.CERTIFICATE_OWNER) {
    if (!params.certificateId) throw new Error('a certificate notification needs a certificate id');
    return `${prefix}/certificates/${params.certificateId}`;
  }

  if (!params.submissionId) throw new Error('a submission notification needs a submission id');

  if (params.audience === NotificationAudience.ORGANIZATION_REVIEWERS) {
    return `${prefix}/organizations/${params.organizationId}/submissions/${params.submissionId}`;
  }

  return `${prefix}/submissions/${params.submissionId}`;
}
