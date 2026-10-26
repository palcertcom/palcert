import type { Locale } from './locales';

/**
 * PalCert Balance message catalogue (Phase 10, §62, §63, §114, §115, §116).
 *
 * Four rules shape the wording.
 *
 *   - It is **PalCert Balance** or customer credit. Never a wallet, and never
 *     anything crypto (§2). What a customer holds is credit with PalCert, not
 *     a currency and not an asset.
 *   - Adding credit is never described as complete until PalCert has verified
 *     it. A page reached by a redirect says "we are confirming", because that
 *     is all the redirect proves (§40, §91).
 *   - Promotional credit is described honestly: spendable, and not returnable
 *     as cash (§9).
 *   - Status is never carried by colour alone (§116); every state has words.
 */
export interface BalanceMessages {
  readonly title: string;
  readonly subtitle: string;

  readonly available: string;
  readonly availableHint: string;
  readonly reserved: string;
  readonly reservedHint: string;
  readonly cash: string;
  readonly promotional: string;
  readonly promotionalHint: string;

  readonly addCredit: string;
  readonly amountLabel: string;
  readonly amountHint: string;
  readonly amountInvalid: string;
  readonly currencyLabel: string;
  readonly reviewTitle: string;
  readonly reviewAmount: string;
  readonly continueToPayment: string;
  readonly continueHint: string;
  readonly redirecting: string;
  readonly cancel: string;

  readonly transactions: string;
  readonly noTransactions: string;
  readonly columnActivity: string;
  readonly columnAmount: string;
  readonly columnWhen: string;
  readonly entryTypes: Readonly<Record<string, string>>;
  readonly reasonCodes: Readonly<Record<string, string>>;
  /** What a hold or capture paid for. Never shown as the raw product code. */
  readonly serviceProducts: Readonly<Record<string, string>>;
  readonly reversalNote: string;
  readonly loadMore: string;

  readonly pendingTopUps: string;
  readonly noTopUps: string;
  readonly topUpStatuses: Readonly<Record<string, string>>;
  readonly topUpFailureCodes: Readonly<Record<string, string>>;

  readonly holds: string;
  readonly noHolds: string;
  readonly holdStatuses: Readonly<Record<string, string>>;
  readonly holdPurposes: Readonly<Record<string, string>>;

  readonly refunds: string;
  readonly noRefunds: string;
  readonly refundStatuses: Readonly<Record<string, string>>;
  readonly refundInitiatedByPalCert: string;

  readonly returnTitle: string;
  readonly returnConfirming: string;
  readonly returnNotYetCredited: string;
  readonly returnAdded: string;
  readonly returnFailed: string;
  readonly returnBackToBalance: string;
  readonly cancelledTitle: string;
  readonly cancelledBody: string;

  readonly unavailable: string;
  readonly unavailableHint: string;
  readonly negativeBalance: string;

  readonly errors: Readonly<Record<string, string>>;
  readonly genericError: string;
}

const en: BalanceMessages = {
  title: 'PalCert Balance',
  subtitle: 'Credit you have added, and everything it has been spent on.',

  available: 'Available',
  availableHint: 'What you can spend right now.',
  reserved: 'Reserved',
  reservedHint: 'Set aside for something in progress. Not spent yet.',
  cash: 'Added by payment',
  promotional: 'Promotional credit',
  promotionalHint:
    'Granted by PalCert. You can spend it on PalCert services; it cannot be returned to a card.',

  addCredit: 'Add credit',
  amountLabel: 'How much would you like to add?',
  amountHint: 'Enter an amount within the limits shown.',
  amountInvalid: 'Enter an amount like 20 or 20.50.',
  currencyLabel: 'Currency',
  reviewTitle: 'Check the amount',
  reviewAmount: 'You are adding',
  continueToPayment: 'Continue to secure payment',
  continueHint:
    'You will be taken to our payment provider’s page to enter your card details. PalCert never sees or stores them.',
  redirecting: 'Taking you to the payment page…',
  cancel: 'Cancel',

  transactions: 'Transaction history',
  noTransactions: 'Nothing yet.',
  columnActivity: 'What happened',
  columnAmount: 'Amount',
  columnWhen: 'When',
  entryTypes: {
    TOP_UP_CREDIT: 'Balance top-up',
    SERVICE_CHARGE: 'PalCert Document Check',
    SERVICE_REFUND: 'Document check refunded',
    PAYMENT_REFUND_DEBIT: 'Refunded to your card',
    PROMOTIONAL_CREDIT: 'Promotional credit',
    ADMIN_CREDIT: 'Credit from PalCert',
    ADMIN_DEBIT: 'Adjustment by PalCert',
    CHARGEBACK_DEBIT: 'Payment reversed by your bank',
    CHARGEBACK_REVERSAL: 'Payment reversal cancelled',
    MANUAL_TOPUP_CREDIT: 'Bank or app transfer',
    WITHDRAWAL_DEBIT: 'Withdrawal',
  },
  serviceProducts: {
    DOCUMENT_CHECK: 'Document check',
    SMARTFIX: 'SmartFix',
    AI_REVIEW: 'AI review',
    AI_RULE_EXTRACTION: 'AI rule extraction',
  },
  reasonCodes: {
    TOP_UP_VERIFIED: 'Payment confirmed',
    SERVICE_CAPTURED: 'Service completed',
    SERVICE_FAILED: 'Service could not be completed',
    SERVICE_CANCELLED: 'Service cancelled',
    CUSTOMER_REQUEST: 'At your request',
    GOODWILL: 'Goodwill',
    PROMOTION: 'Promotion',
    BILLING_CORRECTION: 'Billing correction',
    PROVIDER_DISPUTE: 'Disputed with your bank',
    PROVIDER_DISPUTE_WON: 'Dispute resolved',
    EXTERNAL_REFUND: 'Refunded to your card',
    MANUAL_TOPUP_APPROVED: 'Transfer verified by PalCert finance',
  },
  reversalNote: 'Corrects an earlier transaction.',
  loadMore: 'Show more',

  pendingTopUps: 'Top-ups',
  noTopUps: 'You have not added credit yet.',
  topUpStatuses: {
    CREATED: 'Not started',
    PENDING: 'Waiting for payment',
    SUCCEEDED: 'Added',
    FAILED: 'Did not go through',
    CANCELLED: 'Cancelled',
    EXPIRED: 'Expired',
    RECONCILIATION_REQUIRED: 'Being checked by PalCert',
  },
  topUpFailureCodes: {
    PROVIDER_DECLINED: 'The payment was declined.',
    PROVIDER_SESSION_EXPIRED: 'The payment page expired before it was completed.',
    PAYMENT_AMOUNT_MISMATCH: 'The amount did not match. PalCert is checking this.',
    PAYMENT_CURRENCY_MISMATCH: 'The currency did not match. PalCert is checking this.',
    PAYMENT_OBJECT_MISMATCH: 'PalCert could not match this payment. It is being checked.',
    PROVIDER_UNAVAILABLE: 'The payment provider could not be reached.',
    CANCELLED_BY_CUSTOMER: 'You cancelled this payment.',
  },

  holds: 'Reserved for services in progress',
  noHolds: 'Nothing is reserved.',
  holdStatuses: {
    ACTIVE: 'Reserved',
    CAPTURED: 'Spent',
    RELEASED: 'Returned to your balance',
    EXPIRED: 'Returned to your balance',
  },
  holdPurposes: {
    SERVICE: 'A PalCert service',
    EXTERNAL_REFUND: 'A refund being sent to your card',
    WITHDRAWAL: 'Reserved for withdrawal',
  },

  refunds: 'Refunds',
  noRefunds: 'No refunds.',
  refundStatuses: {
    REQUESTED: 'Requested',
    PENDING: 'On its way to your card',
    SUCCEEDED: 'Refunded',
    FAILED: 'Could not be refunded',
    RECONCILIATION_REQUIRED: 'Being checked by PalCert',
  },
  refundInitiatedByPalCert:
    'Refunds to a card are arranged by PalCert. Contact support if you need one.',

  returnTitle: 'Adding credit',
  returnConfirming: 'We are confirming your payment with the payment provider.',
  returnNotYetCredited:
    'Your balance will update as soon as the payment is confirmed. You can safely close this page — nothing is lost if you do.',
  returnAdded: 'Your credit has been added.',
  returnFailed: 'This payment did not go through. Your balance is unchanged.',
  returnBackToBalance: 'Back to PalCert Balance',
  cancelledTitle: 'Payment cancelled',
  cancelledBody: 'Nothing was charged and your balance is unchanged.',

  unavailable: 'Adding credit is not available at the moment.',
  unavailableHint:
    'Your balance and history are unaffected, and any credit you already have can still be used.',
  negativeBalance:
    'Your balance is below zero because a payment was reversed by your bank. Add credit to bring it back up before using PalCert services.',

  errors: {
    PAYMENTS_DISABLED: 'Adding credit is not available in this installation.',
    PAYMENT_PROVIDER_UNAVAILABLE:
      'The payment provider could not be reached. Your balance is unchanged.',
    CURRENCY_NOT_SUPPORTED: 'PalCert does not currently accept that currency.',
    TOPUP_AMOUNT_OUT_OF_RANGE: 'That amount is outside the limits for adding credit.',
    TOPUP_NOT_FOUND: 'That top-up could not be found.',
    INSUFFICIENT_BALANCE: 'Your available balance is not enough for that.',
    PRICE_NOT_AVAILABLE: 'That service has no price in this currency yet.',
    QUOTE_EXPIRED: 'That price quote has expired. Please ask for a new one.',
  },
  genericError: 'Something went wrong. Please try again.',
};

const ar: BalanceMessages = {
  title: 'رصيد بال‌سيرت',
  subtitle: 'الرصيد الذي أضفته، وكل ما أُنفق منه.',

  available: 'المتاح',
  availableHint: 'ما يمكنك إنفاقه الآن.',
  reserved: 'محجوز',
  reservedHint: 'مخصص لخدمة قيد التنفيذ. ولم يُنفق بعد.',
  cash: 'مضاف بالدفع',
  promotional: 'رصيد ترويجي',
  promotionalHint:
    'ممنوح من بال‌سيرت. يمكنك إنفاقه على خدمات بال‌سيرت، ولا يمكن إعادته إلى البطاقة.',

  addCredit: 'إضافة رصيد',
  amountLabel: 'ما المبلغ الذي تريد إضافته؟',
  amountHint: 'أدخل مبلغاً ضمن الحدود المبينة.',
  amountInvalid: 'أدخل مبلغاً مثل 20 أو 20.50.',
  currencyLabel: 'العملة',
  reviewTitle: 'تحقق من المبلغ',
  reviewAmount: 'أنت تضيف',
  continueToPayment: 'المتابعة إلى الدفع الآمن',
  continueHint:
    'سيجري نقلك إلى صفحة مزوّد الدفع لإدخال بيانات بطاقتك. ولا يرى بال‌سيرت هذه البيانات ولا يخزنها.',
  redirecting: 'جارٍ نقلك إلى صفحة الدفع…',
  cancel: 'إلغاء',

  transactions: 'سجل المعاملات',
  noTransactions: 'لا شيء بعد.',
  columnActivity: 'ما الذي حدث',
  columnAmount: 'المبلغ',
  columnWhen: 'التاريخ',
  entryTypes: {
    TOP_UP_CREDIT: 'إضافة رصيد',
    SERVICE_CHARGE: 'فحص مستند من بال‌سيرت',
    SERVICE_REFUND: 'استرداد قيمة فحص',
    PAYMENT_REFUND_DEBIT: 'أُعيد إلى بطاقتك',
    PROMOTIONAL_CREDIT: 'رصيد ترويجي',
    ADMIN_CREDIT: 'رصيد من بال‌سيرت',
    ADMIN_DEBIT: 'تسوية من بال‌سيرت',
    CHARGEBACK_DEBIT: 'عكس بنكك عملية الدفع',
    CHARGEBACK_REVERSAL: 'أُلغي عكس عملية الدفع',
    MANUAL_TOPUP_CREDIT: 'تحويل بنكي أو عبر تطبيق',
    WITHDRAWAL_DEBIT: 'سحب الأموال',
  },
  serviceProducts: {
    DOCUMENT_CHECK: 'فحص مستند',
    SMARTFIX: 'تصحيح SmartFix',
    AI_REVIEW: 'مراجعة بالذكاء الاصطناعي',
    AI_RULE_EXTRACTION: 'استخراج القواعد بالذكاء الاصطناعي',
  },
  reasonCodes: {
    TOP_UP_VERIFIED: 'تأكد الدفع',
    SERVICE_CAPTURED: 'اكتملت الخدمة',
    SERVICE_FAILED: 'تعذّر إتمام الخدمة',
    SERVICE_CANCELLED: 'أُلغيت الخدمة',
    CUSTOMER_REQUEST: 'بناءً على طلبك',
    GOODWILL: 'مجاملة',
    PROMOTION: 'عرض ترويجي',
    BILLING_CORRECTION: 'تصحيح محاسبي',
    PROVIDER_DISPUTE: 'نزاع لدى بنكك',
    PROVIDER_DISPUTE_WON: 'حُسم النزاع',
    EXTERNAL_REFUND: 'أُعيد إلى بطاقتك',
    MANUAL_TOPUP_APPROVED: 'تحقق منه فريق المالية في بال‌سيرت',
  },
  reversalNote: 'يصحّح معاملة سابقة.',
  loadMore: 'عرض المزيد',

  pendingTopUps: 'عمليات إضافة الرصيد',
  noTopUps: 'لم تضف رصيداً بعد.',
  topUpStatuses: {
    CREATED: 'لم تبدأ',
    PENDING: 'بانتظار الدفع',
    SUCCEEDED: 'أُضيف',
    FAILED: 'لم تتم',
    CANCELLED: 'أُلغيت',
    EXPIRED: 'انتهت صلاحيتها',
    RECONCILIATION_REQUIRED: 'قيد التحقق لدى بال‌سيرت',
  },
  topUpFailureCodes: {
    PROVIDER_DECLINED: 'رُفضت عملية الدفع.',
    PROVIDER_SESSION_EXPIRED: 'انتهت صلاحية صفحة الدفع قبل إتمامها.',
    PAYMENT_AMOUNT_MISMATCH: 'لم يتطابق المبلغ. ويتحقق بال‌سيرت من ذلك.',
    PAYMENT_CURRENCY_MISMATCH: 'لم تتطابق العملة. ويتحقق بال‌سيرت من ذلك.',
    PAYMENT_OBJECT_MISMATCH: 'تعذّر على بال‌سيرت مطابقة هذه العملية. وهي قيد التحقق.',
    PROVIDER_UNAVAILABLE: 'تعذّر الوصول إلى مزوّد الدفع.',
    CANCELLED_BY_CUSTOMER: 'ألغيت عملية الدفع هذه.',
  },

  holds: 'محجوز لخدمات قيد التنفيذ',
  noHolds: 'لا يوجد شيء محجوز.',
  holdStatuses: {
    ACTIVE: 'محجوز',
    CAPTURED: 'أُنفق',
    RELEASED: 'أُعيد إلى رصيدك',
    EXPIRED: 'أُعيد إلى رصيدك',
  },
  holdPurposes: {
    SERVICE: 'خدمة من بال‌سيرت',
    EXTERNAL_REFUND: 'مبلغ قيد الإعادة إلى بطاقتك',
    WITHDRAWAL: 'محجوز للسحب',
  },

  refunds: 'المبالغ المعادة',
  noRefunds: 'لا توجد مبالغ معادة.',
  refundStatuses: {
    REQUESTED: 'مطلوبة',
    PENDING: 'في طريقها إلى بطاقتك',
    SUCCEEDED: 'أُعيدت',
    FAILED: 'تعذّرت إعادتها',
    RECONCILIATION_REQUIRED: 'قيد التحقق لدى بال‌سيرت',
  },
  refundInitiatedByPalCert:
    'تُرتَّب الإعادة إلى البطاقة من قِبل بال‌سيرت. تواصل مع الدعم إذا احتجت إليها.',

  returnTitle: 'إضافة رصيد',
  returnConfirming: 'نتحقق من عملية الدفع لدى مزوّد الدفع.',
  returnNotYetCredited:
    'سيتحدّث رصيدك فور تأكيد الدفع. ويمكنك إغلاق هذه الصفحة بأمان — لن يضيع شيء.',
  returnAdded: 'أُضيف رصيدك.',
  returnFailed: 'لم تتم عملية الدفع هذه. ورصيدك دون تغيير.',
  returnBackToBalance: 'العودة إلى رصيد بال‌سيرت',
  cancelledTitle: 'أُلغيت عملية الدفع',
  cancelledBody: 'لم يُخصم أي مبلغ ورصيدك دون تغيير.',

  unavailable: 'إضافة الرصيد غير متاحة حالياً.',
  unavailableHint: 'رصيدك وسجلك دون تأثر، ويمكنك استخدام أي رصيد لديك بالفعل.',
  negativeBalance:
    'رصيدك دون الصفر لأن بنكك عكس عملية دفع. أضف رصيداً لرفعه قبل استخدام خدمات بال‌سيرت.',

  errors: {
    PAYMENTS_DISABLED: 'إضافة الرصيد غير متاحة في هذا التثبيت.',
    PAYMENT_PROVIDER_UNAVAILABLE: 'تعذّر الوصول إلى مزوّد الدفع. ورصيدك دون تغيير.',
    CURRENCY_NOT_SUPPORTED: 'لا يقبل بال‌سيرت هذه العملة حالياً.',
    TOPUP_AMOUNT_OUT_OF_RANGE: 'هذا المبلغ خارج حدود إضافة الرصيد.',
    TOPUP_NOT_FOUND: 'تعذّر العثور على عملية إضافة الرصيد هذه.',
    INSUFFICIENT_BALANCE: 'رصيدك المتاح لا يكفي لذلك.',
    PRICE_NOT_AVAILABLE: 'لا يوجد سعر لهذه الخدمة بهذه العملة بعد.',
    QUOTE_EXPIRED: 'انتهت صلاحية عرض السعر. يرجى طلب عرض جديد.',
  },
  genericError: 'حدث خطأ ما. يرجى المحاولة مرة أخرى.',
};

export const BALANCE_MESSAGES: Readonly<Record<Locale, BalanceMessages>> = { en, ar };

export function getBalanceMessages(locale: Locale): BalanceMessages {
  return BALANCE_MESSAGES[locale] ?? BALANCE_MESSAGES.en;
}
