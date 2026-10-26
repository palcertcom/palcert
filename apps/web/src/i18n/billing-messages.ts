import type { Locale } from './locales';

/**
 * What a customer reads about paying for a check (Phase 11 §53–§64, §133, §134).
 *
 * One distinction runs through every string here, and getting it wrong would
 * mislead people about their own money:
 *
 *   **Reserved** — set aside, still theirs, nothing has moved.
 *   **Charged** — taken, because the report was delivered.
 *   **Reservation released** — given back, because nothing was delivered.
 *   **Refunded** — returned *after* a charge, which is a different event.
 *
 * A released reservation is never called a refund (§60, §133): nothing was
 * ever taken, and "refund" would imply it was. In Arabic the same distinction
 * is carried by محجوز / تم الخصم / أُلغي الحجز, and أُعيد المبلغ is reserved
 * for the rare case where a charge really was reversed.
 */
export interface BillingMessages {
  readonly price: string;
  readonly priceHint: string;
  readonly yourBalance: string;
  readonly quoteExpires: string;
  readonly quoteExpired: string;
  readonly refreshQuote: string;

  readonly willReserve: (amount: string) => string;
  readonly chargedOnDelivery: string;
  readonly releasedIfIncomplete: string;
  readonly confirmAndStart: string;

  readonly notEnough: string;
  readonly required: string;
  readonly available: string;
  readonly shortfall: string;
  readonly addCredit: string;
  readonly topUpUnavailable: string;

  readonly reservedNow: string;
  readonly chargedNow: string;
  readonly releasedNow: string;
  readonly refundedNow: string;
  readonly legacyFree: string;

  readonly noChargeMade: string;
  readonly reservationReturned: string;
  readonly cancelCheck: string;
  readonly cancelling: string;
  readonly cancelHint: string;

  readonly statuses: Readonly<Record<string, string>>;
  readonly failureCodes: Readonly<Record<string, string>>;
  readonly transactionLabel: string;
  readonly viewBalance: string;
  readonly errors: Readonly<Record<string, string>>;
}

const en: BillingMessages = {
  price: 'Price',
  priceHint: 'This is what PalCert charges for one check of this document.',
  yourBalance: 'Your PalCert Balance',
  quoteExpires: 'This price is held until',
  quoteExpired: 'This price is no longer current.',
  refreshQuote: 'Get the current price',

  willReserve: (amount) => `PalCert will reserve ${amount} from your balance now.`,
  chargedOnDelivery:
    'You will only be charged when the technical report is successfully completed.',
  releasedIfIncomplete:
    'If PalCert cannot complete the check, the reservation will be released and nothing will be charged.',
  confirmAndStart: 'Reserve and start the check',

  notEnough: 'Your balance is not enough for this check.',
  required: 'Required',
  available: 'Available',
  shortfall: 'Short by',
  addCredit: 'Add credit',
  topUpUnavailable:
    'Adding credit is not available at the moment. Any credit you already have can still be used.',

  reservedNow: 'Reserved',
  chargedNow: 'Charged',
  releasedNow: 'Reservation released',
  refundedNow: 'Refunded',
  legacyFree: 'No charge',

  noChargeMade: 'No charge was made.',
  reservationReturned: 'The reserved amount has been returned to your available balance.',
  cancelCheck: 'Cancel this check',
  cancelling: 'Cancelling…',
  cancelHint: 'You can cancel until the report is finished. Nothing will be charged.',

  statuses: {
    RESERVED: 'Reserved',
    PROCESSING: 'Reserved',
    DELIVERED: 'Charged',
    RELEASED: 'Reservation released',
    REFUNDED: 'Refunded',
    RECONCILIATION_REQUIRED: 'Being checked by PalCert',
  },
  failureCodes: {
    CANCELLED_BY_CUSTOMER: 'You cancelled this check.',
    SERVICE_FAILED: 'PalCert could not complete this check.',
    RESERVATION_EXPIRED: 'This check took too long, so the reservation was released.',
    POST_DELIVERY_CORRECTION: 'PalCert corrected this charge afterwards.',
  },
  transactionLabel: 'PalCert Document Check',
  viewBalance: 'View your balance',

  errors: {
    INSUFFICIENT_BALANCE: 'Your balance is not enough for this check.',
    PRICE_QUOTE_REQUIRED: 'Please get a price before starting the check.',
    QUOTE_EXPIRED: 'That price is no longer current. Please get the current price.',
    QUOTE_ALREADY_USED: 'That price has already been used. Please get a new one.',
    QUOTE_NOT_FOUND: 'That price could not be found. Please get the current price.',
    QUOTE_PRODUCT_MISMATCH: 'That price is for a different service.',
    PRICE_NOT_AVAILABLE: 'PalCert has no price for this service in your currency yet.',
    SERVICE_ALREADY_DELIVERED:
      'This check has already produced a report, so it cannot be cancelled.',
    CHECK_NOT_CANCELLABLE: 'This check can no longer be cancelled.',
    CHECK_RETRY_REQUIRES_NEW_PURCHASE:
      'No charge was made. Running this check again starts a new check at the current price.',
  },
};

const ar: BillingMessages = {
  price: 'السعر',
  priceHint: 'هذا ما يتقاضاه بال‌سيرت مقابل فحص واحد لهذا المستند.',
  yourBalance: 'رصيدك في بال‌سيرت',
  quoteExpires: 'هذا السعر محفوظ حتى',
  quoteExpired: 'لم يعد هذا السعر ساريًا.',
  refreshQuote: 'احصل على السعر الحالي',

  willReserve: (amount) => `سيحجز بال‌سيرت ${amount} من رصيدك الآن.`,
  chargedOnDelivery: 'ولن يُخصم منك المبلغ إلا عند اكتمال التقرير الفني بنجاح.',
  releasedIfIncomplete: 'وإذا تعذّر على بال‌سيرت إتمام الفحص، يُلغى الحجز ولا يُخصم أي مبلغ.',
  confirmAndStart: 'احجز المبلغ وابدأ الفحص',

  notEnough: 'رصيدك لا يكفي لهذا الفحص.',
  required: 'المطلوب',
  available: 'المتاح',
  shortfall: 'النقص',
  addCredit: 'إضافة رصيد',
  topUpUnavailable: 'إضافة الرصيد غير متاحة حالياً. ويمكنك استخدام أي رصيد لديك بالفعل.',

  reservedNow: 'محجوز',
  chargedNow: 'تم الخصم',
  releasedNow: 'أُلغي الحجز',
  refundedNow: 'أُعيد المبلغ',
  legacyFree: 'بدون خصم',

  noChargeMade: 'لم يُخصم أي مبلغ.',
  reservationReturned: 'أُعيد المبلغ المحجوز إلى رصيدك المتاح.',
  cancelCheck: 'إلغاء هذا الفحص',
  cancelling: 'جارٍ الإلغاء…',
  cancelHint: 'يمكنك الإلغاء حتى اكتمال التقرير. ولن يُخصم أي مبلغ.',

  statuses: {
    RESERVED: 'محجوز',
    PROCESSING: 'محجوز',
    DELIVERED: 'تم الخصم',
    RELEASED: 'أُلغي الحجز',
    REFUNDED: 'أُعيد المبلغ',
    RECONCILIATION_REQUIRED: 'قيد التحقق لدى بال‌سيرت',
  },
  failureCodes: {
    CANCELLED_BY_CUSTOMER: 'ألغيت هذا الفحص.',
    SERVICE_FAILED: 'تعذّر على بال‌سيرت إتمام هذا الفحص.',
    RESERVATION_EXPIRED: 'استغرق هذا الفحص وقتاً طويلاً، فأُلغي الحجز.',
    POST_DELIVERY_CORRECTION: 'صحّح بال‌سيرت هذا الخصم لاحقاً.',
  },
  transactionLabel: 'فحص مستند من بال‌سيرت',
  viewBalance: 'عرض رصيدك',

  errors: {
    INSUFFICIENT_BALANCE: 'رصيدك لا يكفي لهذا الفحص.',
    PRICE_QUOTE_REQUIRED: 'يرجى الحصول على السعر قبل بدء الفحص.',
    QUOTE_EXPIRED: 'لم يعد هذا السعر ساريًا. يرجى الحصول على السعر الحالي.',
    QUOTE_ALREADY_USED: 'استُخدم هذا السعر بالفعل. يرجى الحصول على سعر جديد.',
    QUOTE_NOT_FOUND: 'تعذّر العثور على هذا السعر. يرجى الحصول على السعر الحالي.',
    QUOTE_PRODUCT_MISMATCH: 'هذا السعر لخدمة أخرى.',
    PRICE_NOT_AVAILABLE: 'لا يوجد سعر لهذه الخدمة بعملتك بعد.',
    SERVICE_ALREADY_DELIVERED: 'أنتج هذا الفحص تقريراً بالفعل، فلا يمكن إلغاؤه.',
    CHECK_NOT_CANCELLABLE: 'لم يعد بالإمكان إلغاء هذا الفحص.',
    CHECK_RETRY_REQUIRES_NEW_PURCHASE:
      'لم يُخصم أي مبلغ. وتشغيل هذا الفحص من جديد يبدأ فحصاً جديداً بالسعر الحالي.',
  },
};

export const BILLING_MESSAGES: Readonly<Record<Locale, BillingMessages>> = { en, ar };

export function getBillingMessages(locale: Locale): BillingMessages {
  return BILLING_MESSAGES[locale] ?? BILLING_MESSAGES.en;
}
