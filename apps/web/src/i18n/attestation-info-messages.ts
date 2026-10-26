import { DEFAULT_LOCALE, type Locale } from './locales';

/**
 * The public page about institutional certificate attestation, and the
 * dashboard card that leads into the request workflow.
 *
 * Held to the homepage's rule: every sentence describes the attestation
 * workflow as it works today (components/attestation-wizard.tsx and the
 * attestation contracts). The steps are the wizard's steps in its order; the
 * formats are the ones the upload accepts; the fee wording follows the
 * reservation policy. Nothing here claims legal, governmental or
 * international recognition — the institution attests, and PalCert records
 * and presents that decision.
 */

export type AttestationInfoActor = 'you' | 'institution' | 'palcert';

interface TitledText {
  readonly title: string;
  readonly text: string;
}

export interface AttestationInfoMessages {
  readonly meta: { readonly title: string; readonly description: string };

  readonly hero: {
    readonly eyebrow: string;
    readonly title: string;
    readonly lead: string;
    readonly request: string;
    readonly myRequests: string;
    readonly newHere: string;
    readonly createAccount: string;
  };

  readonly steps: {
    readonly eyebrow: string;
    readonly title: string;
    readonly lead: string;
    readonly actors: Readonly<Record<AttestationInfoActor, string>>;
    readonly items: readonly (TitledText & { readonly actor: AttestationInfoActor })[];
  };

  readonly benefits: {
    readonly eyebrow: string;
    readonly title: string;
    readonly lead: string;
    readonly items: readonly TitledText[];
  };

  readonly institution: {
    readonly eyebrow: string;
    readonly title: string;
    readonly lead: string;
    readonly institutionTitle: string;
    readonly institutionPoints: readonly string[];
    readonly palcertTitle: string;
    readonly palcertPoints: readonly string[];
    readonly badgeNote: string;
  };

  readonly verification: {
    readonly eyebrow: string;
    readonly title: string;
    readonly lead: string;
    readonly points: readonly string[];
    readonly statusesLabel: string;
    readonly statuses: readonly (TitledText & {
      readonly key: 'VALID' | 'EXPIRED' | 'REVOKED';
    })[];
    readonly action: string;
    readonly note: string;
  };

  readonly fees: {
    readonly title: string;
    readonly lead: string;
    readonly points: readonly string[];
  };

  readonly formats: {
    readonly title: string;
    readonly lead: string;
    readonly list: readonly string[];
    readonly listLabel: string;
  };

  readonly cta: {
    readonly title: string;
    readonly lead: string;
  };

  /** The signed-in dashboard's way in. */
  readonly dashboard: {
    readonly title: string;
    readonly text: string;
    readonly newRequest: string;
    readonly myRequests: string;
    readonly learnMore: string;
  };
}

const en: AttestationInfoMessages = {
  meta: {
    title: 'Institutional Certificate Attestation',
    description:
      'Ask a participating institution to review and attest a certificate you hold. Track the ' +
      'request, then share a verification link and QR code that show the attestation’s current ' +
      'status.',
  },

  hero: {
    eyebrow: 'Certificate attestation',
    title: 'Institutional Certificate Attestation',
    lead:
      'A trusted path between certificate holders and the institutions that can confirm their ' +
      'credentials.',
    request: 'Request attestation',
    myRequests: 'View my requests',
    newHere: 'New to PalCert?',
    createAccount: 'Create an account',
  },

  steps: {
    eyebrow: 'How it works',
    title: 'From your certificate to a verifiable attestation',
    lead:
      'You prepare the request in five steps. The institution then reviews it and decides; ' +
      'PalCert keeps the record and publishes the verification.',
    actors: { you: 'You', institution: 'Institution', palcert: 'PalCert' },
    items: [
      {
        title: 'Choose the institution',
        actor: 'you',
        text:
          'Only institutions that currently offer attestation are listed. Institutions verified ' +
          'by PalCert carry a badge.',
      },
      {
        title: 'Choose the attestation type',
        actor: 'you',
        text:
          'Each type is set by the institution, with its own instructions, accepted files, usual ' +
          'validity and fee.',
      },
      {
        title: 'Describe the certificate',
        actor: 'you',
        text:
          'Give the certificate’s title and the details the institution asks for, such as the ' +
          'issuer, issue date or reference number.',
      },
      {
        title: 'Upload the certificate',
        actor: 'you',
        text:
          'Upload the exact file to be attested. It is scanned before anyone opens it, and its ' +
          'fingerprint is recorded.',
      },
      {
        title: 'Review the fee and submit',
        actor: 'you',
        text: 'The fee is shown before you submit. Submitting holds it from your PalCert balance.',
      },
      {
        title: 'The institution reviews',
        actor: 'institution',
        text:
          'The institution’s reviewers examine the request. If they need more, they ask, and you ' +
          'answer on the request page.',
      },
      {
        title: 'Receive the decision',
        actor: 'institution',
        text:
          'You are notified when the institution approves or rejects the request. A rejection ' +
          'releases the fee in full.',
      },
      {
        title: 'Share and verify',
        actor: 'palcert',
        text:
          'An approved attestation has a public verification link and a QR code that show its ' +
          'current status.',
      },
    ],
  },

  benefits: {
    eyebrow: 'What you get',
    title: 'What an attestation gives you',
    lead: 'Each item below is part of the attestation workflow today.',
    items: [
      {
        title: 'A decision by the institution',
        text: 'The institution’s own reviewers approve or reject, and the decision is dated.',
      },
      {
        title: 'Status at every step',
        text:
          'Submitted, in review, waiting for you, approved, rejected or cancelled — always shown ' +
          'on your request.',
      },
      {
        title: 'Notifications',
        text:
          'In the app, and by email if you choose: when the institution acts, when it needs ' +
          'information, and before an attestation expires.',
      },
      {
        title: 'Bound to your exact file',
        text:
          'The attestation records the SHA-256 fingerprint of the file you submitted. A different ' +
          'scan or copy does not match.',
      },
      {
        title: 'Public verification',
        text:
          'Anyone with the link can confirm the attestation without an account, and can check ' +
          'whether a copy of the file matches.',
      },
      {
        title: 'A QR code',
        text: 'Every approved attestation has a QR code that opens its verification page.',
      },
      {
        title: 'Validity and renewal',
        text:
          'The institution can set a validity period. When it ends, the verification page says ' +
          'expired, and you can request a renewal.',
      },
      {
        title: 'Revocation stated plainly',
        text:
          'If the institution withdraws an attestation, its verification page says so from then ' +
          'on — an old QR code still tells the truth.',
      },
      {
        title: 'A lasting record',
        text:
          'Every step of the request is kept in its history, and an approved attestation is ' +
          'never edited afterwards.',
      },
    ],
  },

  institution: {
    eyebrow: 'Who attests',
    title: 'Attested by the institution',
    lead:
      'PalCert connects certificate holders with participating institutions. The institution ' +
      'reviews the request and makes the attestation decision; PalCert records and presents the ' +
      'resulting verification securely.',
    institutionTitle: 'The institution',
    institutionPoints: [
      'Publishes its attestation types, instructions and fees',
      'Reviews the certificate and may ask for more information',
      'Approves or rejects, and sets the validity period',
      'Can revoke an attestation it gave',
    ],
    palcertTitle: 'PalCert',
    palcertPoints: [
      'Provides the request workflow and keeps its history',
      'Scans the file and records its fingerprint',
      'Records each decision with who made it and when',
      'Publishes the verification page and QR code',
    ],
    badgeNote:
      'PalCert does not issue or re-issue your certificate, and does not make the attestation ' +
      'decision.',
  },

  verification: {
    eyebrow: 'After approval',
    title: 'An attestation anyone can check',
    lead:
      'Once approved, the attestation is linked to the file you submitted and can be checked ' +
      'publicly at any time.',
    points: [
      'Linked to the SHA-256 fingerprint of the submitted file',
      'Opened from its verification link or QR code — no account needed',
      'Shows the attesting institution, the attestation type and the validity period',
    ],
    statusesLabel: 'What the verification page can say',
    statuses: [
      {
        key: 'VALID',
        title: 'Valid',
        text: 'The institution attested this exact file, and the attestation is in force.',
      },
      {
        key: 'EXPIRED',
        title: 'Expired',
        text: 'The validity period has ended. The page shows the date it was valid until.',
      },
      {
        key: 'REVOKED',
        title: 'Revoked',
        text: 'The institution withdrew the attestation. It is no longer valid.',
      },
    ],
    action: 'Verify a certificate',
    note:
      'An attestation is checked from its own verification link or QR code. The verification ' +
      'page also checks PalCert certificates by number.',
  },

  fees: {
    title: 'Fees',
    lead: 'Fees are defined by the institution and are shown before submission.',
    points: [
      'Some attestation types are free of charge.',
      'The fee is held from your PalCert balance when you submit.',
      'It is charged only if the institution approves, and returned in full if it rejects or if ' +
        'you cancel before review starts.',
      'Once approved, the fee is not refunded automatically, even if the attestation is later ' +
        'revoked.',
    ],
  },

  formats: {
    title: 'Accepted files',
    lead: 'Each attestation type lists the formats it accepts and its size limit before you upload.',
    listLabel: 'File formats',
    list: ['PDF', 'PNG', 'JPEG', 'WebP'],
  },

  cta: {
    title: 'Ready to request an attestation?',
    lead:
      'Sign in to choose an institution and start your request. You can save it and finish ' +
      'later.',
  },

  dashboard: {
    title: 'Certificate Attestation',
    text: 'Ask a participating institution to attest a certificate you hold.',
    newRequest: 'New attestation request',
    myRequests: 'My attestation requests',
    learnMore: 'How attestation works',
  },
};

const ar: AttestationInfoMessages = {
  meta: {
    title: 'المصادقة المؤسسية على الشهادات',
    description:
      'اطلب من مؤسسة مشاركة مراجعة شهادة تحملها والمصادقة عليها، وتابع الطلب، ثم شارك رابط تحقق ' +
      'ورمز QR يبيّنان حالة المصادقة الحالية.',
  },

  hero: {
    eyebrow: 'المصادقة على الشهادات',
    title: 'المصادقة المؤسسية على الشهادات',
    lead: 'مسار موثوق يربط حامل الشهادة بالمؤسسة التي يمكنها مراجعة شهادته والمصادقة عليها.',
    request: 'طلب المصادقة',
    myRequests: 'عرض طلباتي',
    newHere: 'جديد على PalCert؟',
    createAccount: 'أنشئ حسابًا',
  },

  steps: {
    eyebrow: 'آلية العمل',
    title: 'من شهادتك إلى مصادقة قابلة للتحقق',
    lead:
      'تُعدّ طلبك في خمس خطوات، ثم تراجعه المؤسسة وتتخذ قرارها، وتحفظ PalCert السجل وتنشر ' +
      'صفحة التحقق.',
    actors: { you: 'أنت', institution: 'المؤسسة', palcert: 'PalCert' },
    items: [
      {
        title: 'اختر المؤسسة',
        actor: 'you',
        text:
          'لا تظهر إلا المؤسسات التي تقدّم المصادقة حاليًا، وتحمل المؤسسات التي تحقّقت منها ' +
          'PalCert شارة تدل على ذلك.',
      },
      {
        title: 'اختر نوع المصادقة',
        actor: 'you',
        text: 'تحدّد المؤسسة كل نوع، بتعليماته والملفات التي يقبلها ومدة سريانه المعتادة ورسومه.',
      },
      {
        title: 'صِف الشهادة',
        actor: 'you',
        text:
          'أدخل عنوان الشهادة والتفاصيل التي تطلبها المؤسسة، مثل الجهة المُصدِرة أو تاريخ الإصدار ' +
          'أو الرقم المرجعي.',
      },
      {
        title: 'ارفع الشهادة',
        actor: 'you',
        text: 'ارفع الملف ذاته المطلوب المصادقة عليه. يُفحص قبل أن يفتحه أحد، وتُسجَّل بصمته.',
      },
      {
        title: 'راجع الرسوم وأرسل الطلب',
        actor: 'you',
        text: 'تظهر الرسوم قبل الإرسال، ويُحجز مبلغها من رصيدك في PalCert عند إرسال الطلب.',
      },
      {
        title: 'تراجع المؤسسة الطلب',
        actor: 'institution',
        text:
          'يفحص مراجعو المؤسسة الطلب، وإن احتاجوا إلى معلومات إضافية طلبوها، فتجيب عنها في صفحة ' +
          'الطلب.',
      },
      {
        title: 'استلم نتيجة الطلب',
        actor: 'institution',
        text: 'يصلك إشعار حين تقبل المؤسسة الطلب أو ترفضه، ويُعاد المبلغ المحجوز كاملًا عند الرفض.',
      },
      {
        title: 'شارِك وتحقّق',
        actor: 'palcert',
        text: 'للمصادقة المعتمدة رابط تحقق علني ورمز QR يبيّنان حالتها الحالية.',
      },
    ],
  },

  benefits: {
    eyebrow: 'ما تحصل عليه',
    title: 'ما تمنحك إياه المصادقة',
    lead: 'كل ما يلي جزء من مسار المصادقة كما يعمل اليوم.',
    items: [
      {
        title: 'قرار من المؤسسة نفسها',
        text: 'يقبل مراجعو المؤسسة الطلب أو يرفضونه، ويُؤرَّخ القرار.',
      },
      {
        title: 'الحالة في كل خطوة',
        text:
          'مُرسَل، أو قيد المراجعة، أو بانتظارك، أو مقبول، أو مرفوض، أو مُلغى — تظهر دائمًا في صفحة ' +
          'طلبك.',
      },
      {
        title: 'الإشعارات',
        text:
          'داخل المنصّة، وبالبريد الإلكتروني إن اخترت ذلك: حين تتخذ المؤسسة إجراءً، وحين تطلب ' +
          'معلومات، وقبل انتهاء سريان المصادقة.',
      },
      {
        title: 'مرتبطة بملفك ذاته',
        text: 'تسجّل المصادقة بصمة SHA-256 للملف الذي أرسلته، فلا تطابقها نسخة أو صورة ممسوحة أخرى.',
      },
      {
        title: 'التحقق العلني',
        text: 'يستطيع كل من لديه الرابط التأكد من المصادقة دون حساب، والتحقق من مطابقة نسخة من الملف.',
      },
      {
        title: 'رمز QR',
        text: 'لكل مصادقة معتمدة رمز QR يفتح صفحة التحقق منها.',
      },
      {
        title: 'مدة السريان والتجديد',
        text:
          'يمكن للمؤسسة تحديد مدة لسريان المصادقة، وعند انتهائها تبيّن صفحة التحقق أنها منتهية، ' +
          'ويمكنك طلب تجديدها.',
      },
      {
        title: 'السحب يُعلَن بوضوح',
        text: 'إن سحبت المؤسسة مصادقتها، تبيّن صفحة التحقق ذلك من حينه، فيبقى رمز QR القديم صادقًا.',
      },
      {
        title: 'سجل دائم',
        text: 'تُحفظ كل خطوة من الطلب في سجله، ولا تُعدَّل المصادقة المعتمدة بعد اعتمادها.',
      },
    ],
  },

  institution: {
    eyebrow: 'من يصادق',
    title: 'المصادقة من المؤسسة',
    lead:
      'يربط PalCert حامل الشهادة بالمؤسسة المشاركة. تتولى المؤسسة مراجعة الطلب واتخاذ قرار ' +
      'المصادقة، بينما يوفر PalCert مسار الطلب وسجل المصادقة وآلية التحقق.',
    institutionTitle: 'المؤسسة',
    institutionPoints: [
      'تنشر أنواع المصادقة وتعليماتها ورسومها',
      'تراجع الشهادة، وقد تطلب معلومات إضافية',
      'تقبل الطلب أو ترفضه، وتحدّد مدة السريان',
      'يمكنها سحب مصادقة منحتها',
    ],
    palcertTitle: 'PalCert',
    palcertPoints: [
      'توفّر مسار الطلب وتحفظ سجله',
      'تفحص الملف وتسجّل بصمته',
      'تسجّل كل قرار ومن اتخذه ومتى',
      'تنشر صفحة التحقق ورمز QR',
    ],
    badgeNote: 'لا تُصدر PalCert شهادتك ولا تعيد إصدارها، ولا تتخذ قرار المصادقة.',
  },

  verification: {
    eyebrow: 'بعد الاعتماد',
    title: 'مصادقة يستطيع أي شخص التحقق منها',
    lead: 'بعد الاعتماد ترتبط المصادقة بالملف الذي أرسلته، ويمكن التحقق منها علنًا في أي وقت.',
    points: [
      'مرتبطة ببصمة SHA-256 للملف المُرسَل',
      'تُفتح من رابط التحقق أو رمز QR، دون حاجة إلى حساب',
      'تبيّن المؤسسة المصادِقة ونوع المصادقة ومدة سريانها',
    ],
    statusesLabel: 'ما قد تبيّنه صفحة التحقق',
    statuses: [
      {
        key: 'VALID',
        title: 'سارية',
        text: 'صادقت المؤسسة على هذا الملف بعينه، والمصادقة سارية.',
      },
      {
        key: 'EXPIRED',
        title: 'منتهية',
        text: 'انتهت مدة السريان، وتبيّن الصفحة التاريخ الذي كانت سارية حتى نهايته.',
      },
      {
        key: 'REVOKED',
        title: 'مسحوبة',
        text: 'سحبت المؤسسة المصادقة، ولم تعد سارية.',
      },
    ],
    action: 'التحقق من شهادة',
    note:
      'يُتحقَّق من المصادقة من رابط التحقق الخاص بها أو رمز QR. وتتحقق صفحة التحقق أيضًا من ' +
      'شهادات PalCert برقمها.',
  },

  fees: {
    title: 'الرسوم',
    lead: 'تحدد المؤسسة رسوم المصادقة، وتظهر الرسوم للمستخدم قبل إرسال الطلب.',
    points: [
      'بعض أنواع المصادقة مجانية.',
      'يُحجز مبلغ الرسوم من رصيدك في PalCert عند إرسال الطلب.',
      'لا يُخصم إلا إذا قبلت المؤسسة الطلب، ويُعاد كاملًا إن رفضته أو إن ألغيت الطلب قبل بدء ' +
        'المراجعة.',
      'بعد الاعتماد لا تُسترد الرسوم تلقائيًا، حتى إن سُحبت المصادقة لاحقًا.',
    ],
  },

  formats: {
    title: 'الملفات المقبولة',
    lead: 'يبيّن كل نوع مصادقة الصيغ التي يقبلها والحد الأقصى لحجم الملف قبل الرفع.',
    listLabel: 'صيغ الملفات',
    list: ['PDF', 'PNG', 'JPEG', 'WebP'],
  },

  cta: {
    title: 'هل أنت مستعد لطلب المصادقة؟',
    lead: 'سجّل الدخول لتختار المؤسسة وتبدأ طلبك، ويمكنك حفظه وإكماله لاحقًا.',
  },

  dashboard: {
    title: 'مصادقة الشهادات',
    text: 'اطلب من مؤسسة مشاركة المصادقة على شهادة تحملها.',
    newRequest: 'طلب مصادقة جديد',
    myRequests: 'طلبات المصادقة الخاصة بي',
    learnMore: 'كيف تتم المصادقة',
  },
};

export const ATTESTATION_INFO_MESSAGES: Readonly<Record<Locale, AttestationInfoMessages>> = {
  en,
  ar,
};

export function getAttestationInfoMessages(locale: Locale): AttestationInfoMessages {
  return ATTESTATION_INFO_MESSAGES[locale] ?? ATTESTATION_INFO_MESSAGES[DEFAULT_LOCALE];
}
