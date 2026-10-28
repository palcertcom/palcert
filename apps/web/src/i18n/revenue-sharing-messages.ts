import type { RevenueServiceCode } from '@palcert/contracts';
export function revenueMessages(locale: string) {
  const ar = locale === 'ar';
  return {
    title: ar ? 'نسب المؤسسة من الخدمات' : 'Institution service shares',
    intro: ar
      ? 'حدّد حصة المؤسسة لكل خدمة. تُثبّت النسبة عند شراء الخدمة وتُسجّل الأرباح عند التحصيل. الرصيد الترويجي المجاني لا يولّد أرباحًا نقدية.'
      : 'Set the institution share for each service. The rate is fixed at purchase and earnings are recorded on capture. Free promotional credit creates no cash earnings.',
    service: ar ? 'الخدمة' : 'Service',
    institution: ar ? 'حصة المؤسسة' : 'Institution share',
    platform: ar ? 'حصة المنصة' : 'Platform share',
    edit: ar ? 'تعديل النسبة' : 'Change share',
    save: ar ? 'حفظ النسبة' : 'Save share',
    percent: ar ? 'نسبة المؤسسة (%)' : 'Institution percentage (%)',
    hint: ar
      ? 'من 0 إلى 100، بمنزلتين عشريتين كحد أقصى. الباقي للمنصة.'
      : '0 to 100, up to two decimals. The remainder belongs to the platform.',
    example: ar
      ? 'مثال: دفع 10.00 USD بنسبة 50% يسجّل 5.00 للمؤسسة و5.00 للمنصة.'
      : 'Example: a 10.00 USD payment at 50% records 5.00 for the institution and 5.00 for the platform.',
    reason: ar ? 'سبب التغيير' : 'Reason for change',
    effective: ar ? 'بدء السريان (اختياري)' : 'Effective from (optional)',
    effectiveHint: ar
      ? 'اتركه فارغًا للتطبيق الآن، أو أدخل تاريخًا ووقتًا مع المنطقة الزمنية.'
      : 'Leave blank for now, or enter a date and time with timezone.',
    history: ar ? 'سجل النسب' : 'Rate history',
    date: ar ? 'التاريخ' : 'Date',
    by: ar ? 'المسؤول' : 'Changed by',
    revenue: ar ? 'إيرادات المؤسسة حسب الخدمة' : 'Institution revenue by service',
    gross: ar ? 'المدفوع النقدي' : 'Cash paid',
    currency: ar ? 'العملة' : 'Currency',
    transactions: ar ? 'القيود المالية' : 'Revenue entries',
    refund: ar ? 'استرداد' : 'Refund',
    captured: ar ? 'تحصيل' : 'Capture',
    more: ar ? 'التالي' : 'Next',
    empty: ar ? 'لا توجد قيود بعد.' : 'No entries yet.',
    default: ar ? 'النسبة الافتراضية' : 'Default rate',
    loading: ar ? 'جارٍ التحميل…' : 'Loading…',
    error: ar ? 'تعذّر تحميل البيانات.' : 'Could not load data.',
    invalid: ar ? 'أدخل نسبة صحيحة من 0 إلى 100.' : 'Enter a percentage from 0 to 100.',
    cancel: ar ? 'إلغاء' : 'Cancel',
    close: ar ? 'إغلاق' : 'Close',
    optional: ar ? 'اختياري' : 'Optional',
    pending: ar ? 'جارٍ الحفظ…' : 'Saving…',
    services: (ar
      ? {
          DOCUMENT_CHECK: 'فحص التنسيق',
          SMARTFIX: 'التصحيح الذكي',
          AI_REVIEW: 'المراجعة بالذكاء الاصطناعي',
          AI_RULE_EXTRACTION: 'استخراج قواعد المعيار',
          ATTESTATION: 'تصديق الشهادة',
        }
      : {
          DOCUMENT_CHECK: 'Formatting check',
          SMARTFIX: 'SmartFix',
          AI_REVIEW: 'AI review',
          AI_RULE_EXTRACTION: 'Standard rule extraction',
          ATTESTATION: 'Certificate attestation',
        }) satisfies Record<RevenueServiceCode, string>,
  };
}
