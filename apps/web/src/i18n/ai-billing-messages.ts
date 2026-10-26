import type { Locale } from './locales';

/**
 * What every paid AI action says about money, in English and Arabic (ADR-0149).
 *
 * One catalogue for every AI service, so the fee, the "charged only when it
 * completes" promise and the organization notice read the same everywhere.
 * Product names are customer words, never internal codes.
 */
export interface AIBillingMessages {
  readonly feeTitle: string;
  readonly fee: string;
  readonly available: string;
  readonly chargedOnSuccess: string;
  readonly releasedOnFailure: string;
  readonly insufficient: string;
  readonly addBalance: string;
  readonly unavailable: string;
  readonly organizationNotice: string;
  readonly loading: string;
  readonly products: Readonly<Record<string, string>>;
}

const en: AIBillingMessages = {
  feeTitle: 'AI service fee',
  fee: 'Fee',
  available: 'Available balance',
  chargedOnSuccess: 'Your balance will be charged when the AI service completes successfully.',
  releasedOnFailure: 'If it fails or is cancelled, the reserved amount returns to your balance.',
  insufficient: 'Insufficient balance',
  addBalance: 'Add balance',
  unavailable: 'This AI service is not currently available in your balance currency.',
  organizationNotice:
    'This AI service is billed to your PalCert Balance, even when used for an organization.',
  loading: 'Checking the fee…',
  products: {
    AI_REVIEW: 'AI review',
    AI_RULE_EXTRACTION: 'AI rule extraction',
  },
};

const ar: AIBillingMessages = {
  feeTitle: 'رسوم خدمة الذكاء الاصطناعي',
  fee: 'الرسوم',
  available: 'الرصيد المتاح',
  chargedOnSuccess: 'سيتم خصم الرسوم من رصيدك عند اكتمال خدمة الذكاء الاصطناعي بنجاح.',
  releasedOnFailure: 'إذا تعذّر إكمالها أو أُلغيت، يُعاد المبلغ المحجوز إلى رصيدك.',
  insufficient: 'الرصيد غير كافٍ',
  addBalance: 'إضافة رصيد',
  unavailable: 'خدمة الذكاء الاصطناعي هذه غير متاحة حالياً بعملة رصيدك.',
  organizationNotice:
    'يتم احتساب رسوم خدمة الذكاء الاصطناعي من رصيدك في PalCert حتى عند استخدامها لصالح مؤسسة.',
  loading: 'جارٍ التحقق من الرسوم…',
  products: {
    AI_REVIEW: 'مراجعة بالذكاء الاصطناعي',
    AI_RULE_EXTRACTION: 'استخراج القواعد بالذكاء الاصطناعي',
  },
};

export const AI_BILLING_MESSAGES: Readonly<Record<Locale, AIBillingMessages>> = { en, ar };

export function getAIBillingMessages(locale: Locale): AIBillingMessages {
  return AI_BILLING_MESSAGES[locale] ?? AI_BILLING_MESSAGES.en;
}
