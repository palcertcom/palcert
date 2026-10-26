import { DEFAULT_LOCALE, type Locale } from './locales';

/**
 * The public homepage: what PalCert is, for whom, and how it works.
 *
 * Marketing copy, held to the same rule as every other screen: each sentence
 * describes something the product does today. Modules, steps and assurances
 * name real features (checks, SmartFix, official submissions, institution
 * review, certificates, public verification, notifications, balance, API
 * clients and webhooks); nothing promises a feature, a customer or a number
 * PalCert does not have. The product previews are illustrations and say so.
 *
 * The Arabic is written for Arabic readers, not translated word for word:
 * the same claims, in the register of institutional Arabic.
 */

export type LandingModuleKey =
  | 'documents'
  | 'checks'
  | 'smartfix'
  | 'ai'
  | 'submissions'
  | 'review'
  | 'standards'
  | 'certificates'
  | 'verification'
  | 'notifications'
  | 'balance'
  | 'integrations';

export type LandingAudienceKey = 'authors' | 'institutions' | 'reviewers' | 'verifiers';

export type LandingActor = 'institution' | 'author' | 'palcert';

interface ServiceCard {
  readonly title: string;
  readonly text: string;
  readonly points: readonly string[];
  readonly action: string;
}

interface TitledText {
  readonly title: string;
  readonly text: string;
}

export interface LandingMessages {
  readonly nav: {
    readonly label: string;
    readonly services: string;
    readonly platform: string;
    readonly howItWorks: string;
    readonly solutions: string;
    readonly trust: string;
    readonly faq: string;
    readonly openMenu: string;
    readonly closeMenu: string;
  };

  readonly hero: {
    readonly eyebrow: string;
    readonly title: string;
    readonly lead: string;
    readonly explore: string;
    /** The three services, named in the first screen. */
    readonly servicesLabel: string;
    readonly services: Readonly<Record<'checking' | 'attestation' | 'verification', TitledText>>;
    readonly previewCaption: string;
  };

  /**
   * The three services, kept apart on purpose: checking a document,
   * attestation of a certificate by an institution, and public verification.
   */
  readonly services: {
    readonly eyebrow: string;
    readonly title: string;
    readonly lead: string;
    readonly checking: ServiceCard;
    readonly attestation: ServiceCard & { readonly badge: string; readonly learnMore: string };
    readonly verification: ServiceCard;
    /** The attestation path, drawn as four stages. */
    readonly flow: {
      readonly label: string;
      readonly certificate: string;
      readonly review: string;
      readonly attested: string;
      readonly verify: string;
    };
  };

  /** Sample content for the illustrations; never presented as real records. */
  readonly sample: {
    readonly documentName: string;
    readonly secondDocumentName: string;
    readonly standardName: string;
    readonly institution: string;
    readonly certificateNumber: string;
    readonly issued: string;
    readonly issuedLabel: string;
    readonly reportTitle: string;
    readonly welcome: string;
    readonly recentDocuments: string;
    readonly recentChecks: string;
    readonly submissionQueue: string;
    readonly author: string;
    readonly secondAuthor: string;
    readonly thirdAuthor: string;
    readonly version: (n: number) => string;
  };

  readonly workflow: {
    readonly eyebrow: string;
    readonly title: string;
    readonly lead: string;
    readonly actors: Readonly<Record<LandingActor, string>>;
    readonly steps: readonly (TitledText & { readonly actor: LandingActor })[];
  };

  readonly platform: {
    readonly eyebrow: string;
    readonly title: string;
    readonly lead: string;
    readonly audiences: {
      readonly authors: string;
      readonly institutions: string;
      readonly everyone: string;
    };
    readonly modules: Readonly<Record<LandingModuleKey, TitledText>>;
  };

  readonly solutions: {
    readonly eyebrow: string;
    readonly title: string;
    readonly lead: string;
    readonly audiences: Readonly<
      Record<
        LandingAudienceKey,
        { readonly title: string; readonly lead: string; readonly points: readonly string[] }
      >
    >;
  };

  readonly value: {
    readonly eyebrow: string;
    readonly title: string;
    readonly lead: string;
    readonly pillars: readonly TitledText[];
  };

  readonly trust: {
    readonly eyebrow: string;
    readonly title: string;
    readonly lead: string;
    readonly principleLabel: string;
    readonly principle: string;
    readonly assurances: readonly TitledText[];
    readonly verifierTitle: string;
    readonly verifierLead: string;
  };

  readonly product: {
    readonly eyebrow: string;
    readonly title: string;
    readonly lead: string;
    readonly sampleNote: string;
    readonly frames: {
      readonly dashboard: TitledText;
      readonly documents: TitledText;
      readonly report: TitledText;
      readonly review: TitledText;
    };
  };

  readonly faq: {
    readonly eyebrow: string;
    readonly title: string;
    readonly items: readonly { readonly question: string; readonly answer: string }[];
  };

  readonly cta: {
    readonly title: string;
    readonly lead: string;
    readonly signInPrompt: string;
  };

  readonly footer: {
    readonly summary: string;
    readonly platformHeading: string;
    readonly accountHeading: string;
    readonly verificationHeading: string;
    readonly languageHeading: string;
    readonly resetPassword: string;
    readonly howCertificationWorks: string;
    readonly attestation: string;
    readonly boundary: string;
    readonly copyright: string;
  };
}

const en: LandingMessages = {
  nav: {
    label: 'Homepage sections',
    services: 'Services',
    platform: 'Platform',
    howItWorks: 'How it works',
    solutions: 'Solutions',
    trust: 'Trust',
    faq: 'FAQ',
    openMenu: 'Open menu',
    closeMenu: 'Close menu',
  },

  hero: {
    eyebrow: 'Document checking · Certificate attestation · Verification',
    title: 'Trusted documents. Verified credentials.',
    lead:
      'Check documents against institutional standards, request certificate attestation from ' +
      'participating institutions, and verify trusted credentials through PalCert.',
    explore: 'Explore the services',
    servicesLabel: 'What PalCert does',
    services: {
      checking: {
        title: 'Document checking',
        text: 'Word and PDF, against the standards institutions publish',
      },
      attestation: {
        title: 'Institutional certificate attestation',
        text: 'Reviewed and decided by the participating institution',
      },
      verification: {
        title: 'Certificate verification',
        text: 'By number, link or QR code — no account needed',
      },
    },
    previewCaption: 'Illustration of the PalCert workspace, with sample data.',
  },

  services: {
    eyebrow: 'Services',
    title: 'Three services, each with its own purpose',
    lead:
      'Checking a document, attesting a certificate and verifying a credential are separate ' +
      'steps with separate owners. PalCert keeps them apart — and connects them.',
    checking: {
      title: 'Document checking',
      text:
        'Check a Word or PDF document against a standard an institution has published. The ' +
        'report shows, rule by rule, what is met and what is not, and SmartFix can correct ' +
        'flagged formatting.',
      points: [
        'Reports tied to the exact document version',
        'Official submission to the institution when required',
      ],
      action: 'Start a check',
    },
    attestation: {
      badge: 'From the institution',
      title: 'Institutional Certificate Attestation',
      text:
        'Submit your certificate to a participating institution for review and attestation. ' +
        'Track the request, receive notifications, and obtain a verifiable attestation when ' +
        'approved.',
      points: [
        'The institution reviews and decides',
        'The fee is shown before you submit',
        'A verification link and QR code once approved',
      ],
      action: 'Request attestation',
      learnMore: 'How attestation works',
    },
    verification: {
      title: 'Certificate verification',
      text:
        'Anyone can confirm a PalCert certificate by its number or QR code, and an attestation ' +
        'by its verification link or QR code — no account needed.',
      points: ['Valid, expired and revoked, stated plainly', 'No search by name'],
      action: 'Verify a certificate',
    },
    flow: {
      label: 'From certificate to verifiable attestation',
      certificate: 'Your certificate',
      review: 'Institution review',
      attested: 'Attested credential',
      verify: 'QR and public verification',
    },
  },

  sample: {
    documentName: 'Master’s thesis — final.docx',
    secondDocumentName: 'Research proposal.pdf',
    standardName: 'Graduate Thesis Formatting · v3',
    institution: 'Sample University',
    certificateNumber: 'PC-7Q4K2M9A-3F8D1C6B',
    issued: '14 Sep 2026',
    issuedLabel: 'Issued',
    reportTitle: 'Compliance report',
    welcome: 'Welcome back',
    recentDocuments: 'Recent documents',
    recentChecks: 'Recent checks',
    submissionQueue: 'Submission queue',
    author: 'L. Haddad',
    secondAuthor: 'O. Nasser',
    thirdAuthor: 'R. Khalil',
    version: (n) => `Version ${n}`,
  },

  workflow: {
    eyebrow: 'Document checking — how it works',
    title: 'Six stages, one accountable record',
    lead:
      'Every document moves through the same defined stages. Each stage has an owner, and each ' +
      'leaves a record the next one can rely on.',
    actors: {
      institution: 'Institution',
      author: 'Author',
      palcert: 'PalCert',
    },
    steps: [
      {
        title: 'Define',
        actor: 'institution',
        text:
          'Institutions publish formatting standards as versioned rules — written directly or ' +
          'proposed from their existing guidelines, and accepted by a person before they count.',
      },
      {
        title: 'Check',
        actor: 'author',
        text:
          'Upload a Word or PDF document and check it against a published standard. The report ' +
          'states, rule by rule, what was met, what was not, and what needs a person to review.',
      },
      {
        title: 'Fix',
        actor: 'author',
        text:
          'SmartFix lists every formatting correction before it runs, then produces a corrected ' +
          'copy as a new version. Your original is never changed and your writing never rewritten.',
      },
      {
        title: 'Verify',
        actor: 'palcert',
        text:
          'Check the corrected version again. Every report and result carries a cryptographic ' +
          'fingerprint, so what was checked is exactly what is submitted.',
      },
      {
        title: 'Approve',
        actor: 'institution',
        text:
          'Submit that exact version officially. The institution’s reviewers approve it, request ' +
          'a revision or reject it — and every decision is recorded.',
      },
      {
        title: 'Certify',
        actor: 'palcert',
        text:
          'An approved, compliant submission receives a certificate with a unique number and QR ' +
          'code. Anyone can verify it, and a revoked certificate says so.',
      },
    ],
  },

  platform: {
    eyebrow: 'Platform',
    title: 'Everything the workflow needs, in one platform',
    lead:
      'Each module below is part of the working product — used by authors, by institutions, or ' +
      'by anyone holding a certificate.',
    audiences: {
      authors: 'For authors',
      institutions: 'For institutions',
      everyone: 'For everyone',
    },
    modules: {
      documents: {
        title: 'Documents',
        text:
          'Private, versioned storage for every document. Each upload is scanned before it is ' +
          'processed, and every version is kept.',
      },
      checks: {
        title: 'Checks and reports',
        text:
          'Rule-by-rule compliance reports against a published standard, with a clear result and ' +
          'a record of anything that could not be measured.',
      },
      smartfix: {
        title: 'SmartFix',
        text:
          'Automatic correction of flagged formatting in Word documents — sizes, fonts, spacing, ' +
          'margins — shown in full before it runs.',
      },
      ai: {
        title: 'AI review',
        text:
          'An optional second opinion on requirements that need reading rather than measuring. ' +
          'It runs only with your consent and never changes the technical result.',
      },
      submissions: {
        title: 'Official submissions',
        text:
          'Hand one exact document version and its report to the institution that owns the ' +
          'standard, then follow it through review and revision.',
      },
      review: {
        title: 'Institution review',
        text:
          'A queue of official submissions for reviewers, with comments, revision requests and ' +
          'recorded decisions.',
      },
      standards: {
        title: 'Standards and document types',
        text:
          'Versioned standards that move from draft to published, built from rules or from the ' +
          'guidelines and templates an institution already has.',
      },
      certificates: {
        title: 'Certificates',
        text:
          'Technical compliance certificates bound to the approved submission, with a number, a ' +
          'QR code, a validity period and a full history.',
      },
      verification: {
        title: 'Public verification',
        text:
          'A public page where anyone confirms a certificate by its number or QR code — no ' +
          'account needed, and no search by name.',
      },
      notifications: {
        title: 'Notifications',
        text:
          'An inbox for every change to a submission or certificate, with email delivery you ' +
          'choose event by event.',
      },
      balance: {
        title: 'Balance and billing',
        text:
          'A prepaid balance. The price is shown before a check starts, reserved while it runs, ' +
          'and charged only when the report is delivered.',
      },
      integrations: {
        title: 'Integrations',
        text:
          'API clients and signed webhooks, so an institution’s own systems can follow ' +
          'submissions and certificates.',
      },
    },
  },

  solutions: {
    eyebrow: 'Solutions',
    title: 'One platform, four points of view',
    lead:
      'PalCert gives each party in the process what it needs to act — and nothing it should ' +
      'not see.',
    audiences: {
      authors: {
        title: 'Graduates and authors',
        lead: 'Submit with confidence, not guesswork.',
        points: [
          'Know which formatting rules your document meets before you submit it',
          'Correct flagged formatting automatically, without touching your writing',
          'Follow your official submission through review and revision',
          'Receive a certificate you can share and anyone can verify',
          'Ask a participating institution to attest a certificate you already hold',
        ],
      },
      institutions: {
        title: 'Universities and institutions',
        lead: 'Publish the standard once. Apply it the same way every time.',
        points: [
          'Turn existing guidelines and templates into versioned, published standards',
          'Receive submissions already checked against your standard',
          'Manage your team, roles and invitations in one organization',
          'Review attestation requests and set your attestation types and fees',
          'Connect your own systems through API clients and webhooks',
        ],
      },
      reviewers: {
        title: 'Reviewers and certifying staff',
        lead: 'Review the exact document, with its evidence attached.',
        points: [
          'Work from a single queue of official submissions',
          'See the compliance report and fingerprints of the version under review',
          'Approve, request a revision or reject — with comments on the record',
          'Every decision is attributed and dated',
        ],
      },
      verifiers: {
        title: 'Employers and external verifiers',
        lead: 'Confirm a certificate directly, with no account needed.',
        points: [
          'Enter the certificate number or scan its QR code',
          'Open an attestation’s verification link to see its current status',
          'See the technical result and the institution decision it records',
          'Revoked and expired certificates are stated plainly',
          'No public directory — certificates cannot be searched by name',
        ],
      },
    },
  },

  value: {
    eyebrow: 'Why PalCert',
    title: 'Built for decisions that have to hold up',
    lead:
      'Compliance work breaks down when rules are vague, corrections are manual and approvals ' +
      'cannot be traced. PalCert is designed around the opposite.',
    pillars: [
      {
        title: 'Published standards, not opinions',
        text:
          'Every check runs against one published version of an institution’s standard, so the ' +
          'same document always receives the same answer.',
      },
      {
        title: 'Corrections without rewriting',
        text:
          'SmartFix changes formatting only, lists every change first, and keeps your original ' +
          'untouched.',
      },
      {
        title: 'The exact version, every time',
        text:
          'Reports, submissions and certificates point to one fingerprinted document version, so ' +
          'nothing can be swapped along the way.',
      },
      {
        title: 'Decisions stay with institutions',
        text:
          'PalCert measures formatting. Approval, revision and rejection belong to the ' +
          'institution’s own reviewers.',
      },
      {
        title: 'Certificates anyone can check',
        text:
          'A number and a QR code lead to a public verification page that states validity, ' +
          'expiry and revocation.',
      },
      {
        title: 'Arabic and English as equals',
        text:
          'Every screen works fully in both languages, with Arabic typography chosen for reading ' +
          'and the correct direction in each.',
      },
    ],
  },

  trust: {
    eyebrow: 'Trust and security',
    title: 'Security that follows the record, end to end',
    lead:
      'PalCert holds documents, decisions and certificates that people rely on. Each is ' +
      'protected, recorded and checkable on its own.',
    principleLabel: 'Where PalCert stops',
    principle:
      'PalCert checks formatting against a published standard. It does not judge research, and ' +
      'it does not make the institution’s decision.',
    assurances: [
      {
        title: 'Two-step sign-in',
        text:
          'Authenticator-app codes and one-time recovery codes protect accounts, with active ' +
          'sessions you can review and end.',
      },
      {
        title: 'Isolation by organization',
        text:
          'Each organization’s data is separated in the database itself, not only in the ' +
          'application.',
      },
      {
        title: 'Scanned uploads',
        text: 'Every file is scanned before PalCert reads it; anything suspicious is quarantined.',
      },
      {
        title: 'A recorded chain of decisions',
        text: 'Submissions, reviews, decisions and revocations are recorded with who acted and when.',
      },
      {
        title: 'Fingerprinted results',
        text:
          'Reports, results and certificates carry cryptographic fingerprints that expose any ' +
          'later change.',
      },
      {
        title: 'Verified institutions',
        text: 'PalCert verifies organizations, and a verified organization carries a visible badge.',
      },
      {
        title: 'Consent before AI',
        text:
          'No part of a document reaches an AI provider until its owner has agreed, knowing what ' +
          'will be sent.',
      },
      {
        title: 'Charges you can follow',
        text: 'Every reservation, charge and release appears in your balance history.',
      },
    ],
    verifierTitle: 'What a verifier sees',
    verifierLead:
      'The public verification page states the certificate’s status, the technical result and ' +
      'the institution’s decision — nothing more about the holder.',
  },

  product: {
    eyebrow: 'The product',
    title: 'One workspace for every role',
    lead:
      'The same platform serves the author at the desk, the reviewer at the queue and the ' +
      'verifier with a certificate in hand.',
    sampleNote: 'Illustrations with sample data.',
    frames: {
      dashboard: {
        title: 'Personal dashboard',
        text: 'Recent documents, checks, submissions and certificates in one place.',
      },
      documents: {
        title: 'Documents and versions',
        text: 'Every upload kept as a version, with its processing status.',
      },
      report: {
        title: 'Compliance report',
        text: 'A clear result, rule counts and every finding explained.',
      },
      review: {
        title: 'Institution review queue',
        text: 'Official submissions waiting for a decision.',
      },
    },
  },

  faq: {
    eyebrow: 'FAQ',
    title: 'Common questions',
    items: [
      {
        question: 'What is PalCert?',
        answer:
          'PalCert is a platform for checking documents against the formatting standards ' +
          'institutions publish, correcting what can be corrected, submitting documents ' +
          'officially for review, and issuing certificates anyone can verify. It also lets ' +
          'people ask participating institutions to attest certificates they already hold.',
      },
      {
        question: 'Who can use it?',
        answer:
          'Anyone can create an account to check their own documents. Universities and other ' +
          'institutions create an organization to publish standards and review submissions. ' +
          'Verifying a certificate needs no account at all.',
      },
      {
        question: 'How do I verify a certificate?',
        answer:
          'Open the verification page and enter the certificate number printed on the ' +
          'certificate, or scan its QR code. The page states whether it is valid, expired or ' +
          'revoked, and what it certifies.',
      },
      {
        question: 'What is institutional certificate attestation?',
        answer:
          'You upload a certificate you already hold and ask a participating institution to ' +
          'attest it. The institution reviews that exact file and approves or rejects the ' +
          'request. An approved attestation has a public verification link and QR code that show ' +
          'whether it is valid, expired or revoked.',
      },
      {
        question: 'Does PalCert attest certificates itself?',
        answer:
          'No. The institution reviews the request and makes the decision. PalCert provides the ' +
          'request workflow, records the decision and the file’s fingerprint, and presents the ' +
          'verification.',
      },
      {
        question: 'Is PalCert only for institutions?',
        answer:
          'No. Individuals use PalCert to check and correct their documents against any ' +
          'published standard, whether or not they then submit officially.',
      },
      {
        question: 'Can I track review and correction status?',
        answer:
          'Yes. Each official submission shows its current status and every decision made on ' +
          'it, and PalCert tells you in the app — and by email, if you choose.',
      },
      {
        question: 'How does certification work?',
        answer:
          'When an institution approves an official submission that PalCert found compliant, ' +
          'PalCert issues a technical compliance certificate for that exact document version, ' +
          'recording both the technical result and the institution’s decision.',
      },
      {
        question: 'How are checks paid for?',
        answer:
          'From a prepaid PalCert balance. You see the price before you start; it is reserved ' +
          'while the check runs and charged only when the report is delivered.',
      },
    ],
  },

  cta: {
    title: 'Bring standards, submissions and certificates into one accountable workflow.',
    lead:
      'Create an account to check a document or request an attestation, or verify a ' +
      'certificate you were given.',
    signInPrompt: 'Already have an account?',
  },

  footer: {
    summary:
      'Document checking, certificate attestation and public verification — for institutions ' +
      'and the people who rely on their credentials.',
    platformHeading: 'Platform',
    accountHeading: 'Account',
    verificationHeading: 'Verification',
    languageHeading: 'Language',
    resetPassword: 'Reset your password',
    howCertificationWorks: 'How certification works',
    attestation: 'Certificate attestation',
    boundary:
      'PalCert certifies technical compliance with a published standard and records ' +
      'institutions’ decisions, including attestations. Academic judgement and attestation ' +
      'decisions remain with the institution.',
    copyright: '© PalCert',
  },
};

const ar: LandingMessages = {
  nav: {
    label: 'أقسام الصفحة الرئيسية',
    services: 'الخدمات',
    platform: 'المنصّة',
    howItWorks: 'آلية العمل',
    solutions: 'الحلول',
    trust: 'الثقة والأمان',
    faq: 'الأسئلة الشائعة',
    openMenu: 'فتح القائمة',
    closeMenu: 'إغلاق القائمة',
  },

  hero: {
    eyebrow: 'فحص المستندات · المصادقة على الشهادات · التحقق',
    title: 'وثائق موثوقة. شهادات قابلة للتحقق.',
    lead:
      'افحص مستنداتك وفق معايير المؤسسات، واطلب المصادقة على شهاداتك من المؤسسات المشاركة، ' +
      'وتحقّق من الشهادات والمصادقات الموثوقة عبر PalCert.',
    explore: 'تعرّف على الخدمات',
    servicesLabel: 'ما تقدّمه PalCert',
    services: {
      checking: {
        title: 'فحص المستندات',
        text: 'مستندات Word وPDF وفق المعايير التي تنشرها المؤسسات',
      },
      attestation: {
        title: 'المصادقة المؤسسية على الشهادات',
        text: 'تراجعها المؤسسة المشاركة وتتخذ قرارها',
      },
      verification: {
        title: 'التحقق من الشهادات',
        text: 'بالرقم أو الرابط أو رمز QR، دون حاجة إلى حساب',
      },
    },
    previewCaption: 'رسم توضيحي لمساحة عمل بال‌سيرت ببيانات افتراضية.',
  },

  services: {
    eyebrow: 'الخدمات',
    title: 'ثلاث خدمات، لكلٍّ منها غايتها',
    lead:
      'فحص المستند، والمصادقة على الشهادة، والتحقق منها خطوات مستقلة لكلٍّ منها صاحبها. ' +
      'تُبقي PalCert كلًّا منها في موضعه، وتصل بينها.',
    checking: {
      title: 'فحص المستندات',
      text:
        'افحص مستند Word أو PDF وفق معيار نشرته مؤسسة. يبيّن التقرير، قاعدةً قاعدة، ما ' +
        'استوفاه المستند وما لم يستوفه، ويمكن لأداة SmartFix تصحيح التنسيق المُشار إليه.',
      points: ['تقارير مرتبطة بنسخة المستند ذاتها', 'تقديم رسمي إلى المؤسسة عند الحاجة'],
      action: 'ابدأ الفحص',
    },
    attestation: {
      badge: 'من المؤسسة',
      title: 'المصادقة المؤسسية على الشهادات',
      text:
        'أرسل شهادتك إلى المؤسسة المشاركة لمراجعتها والمصادقة عليها، وتابع حالة الطلب، واستلم ' +
        'الإشعارات، واحصل على مصادقة قابلة للتحقق بعد اعتمادها.',
      points: [
        'المؤسسة هي التي تراجع الطلب وتقرّر',
        'تظهر الرسوم قبل إرسال الطلب',
        'رابط تحقق ورمز QR بعد الاعتماد',
      ],
      action: 'طلب المصادقة',
      learnMore: 'كيف تتم المصادقة',
    },
    verification: {
      title: 'التحقق من الشهادات',
      text:
        'يستطيع أي شخص التحقق من شهادة PalCert برقمها أو برمز QR الخاص بها، ومن المصادقة ' +
        'برابط التحقق أو برمز QR، دون الحاجة إلى حساب.',
      points: ['تُذكر الحالة صراحةً: سارية أو منتهية أو ملغاة', 'لا بحث بالأسماء'],
      action: 'التحقق من شهادة',
    },
    flow: {
      label: 'من الشهادة إلى مصادقة قابلة للتحقق',
      certificate: 'شهادتك',
      review: 'مراجعة المؤسسة',
      attested: 'شهادة مصادَق عليها',
      verify: 'رمز QR والتحقق العلني',
    },
  },

  sample: {
    documentName: 'رسالة الماجستير — النسخة النهائية.docx',
    secondDocumentName: 'مقترح البحث.pdf',
    standardName: 'دليل تنسيق رسائل الدراسات العليا · الإصدار 3',
    institution: 'جامعة افتراضية',
    certificateNumber: 'PC-7Q4K2M9A-3F8D1C6B',
    issued: '2026/9/14',
    issuedLabel: 'تاريخ الإصدار',
    reportTitle: 'تقرير المطابقة',
    welcome: 'مرحبًا بعودتك',
    recentDocuments: 'أحدث المستندات',
    recentChecks: 'أحدث الفحوصات',
    submissionQueue: 'قائمة التقديمات',
    author: 'ليلى حدّاد',
    secondAuthor: 'عمر ناصر',
    thirdAuthor: 'رنا خليل',
    version: (n) => `النسخة ${n}`,
  },

  workflow: {
    eyebrow: 'فحص المستندات — آلية العمل',
    title: 'ست مراحل وسجلّ واحد موثوق',
    lead:
      'يمرّ كل مستند بالمراحل المحددة نفسها. لكل مرحلة جهة مسؤولة عنها، وكل مرحلة تترك سجلًا ' +
      'تعتمد عليه المرحلة التالية.',
    actors: {
      institution: 'المؤسسة',
      author: 'المؤلف',
      palcert: 'بال‌سيرت',
    },
    steps: [
      {
        title: 'تحديد',
        actor: 'institution',
        text:
          'تنشر المؤسسات معايير التنسيق قواعدَ ذات إصدارات، تُصاغ مباشرةً أو تُقترح من أدلّتها ' +
          'القائمة، ولا تُعتمد إلا بعد أن يقبلها شخص مخوّل.',
      },
      {
        title: 'فحص',
        actor: 'author',
        text:
          'ارفع مستند Word أو PDF وافحصه وفق معيار منشور. يبيّن التقرير، قاعدةً قاعدة، ما ' +
          'استُوفي وما لم يُستوفَ وما يحتاج إلى مراجعة بشرية.',
      },
      {
        title: 'تصحيح',
        actor: 'author',
        text:
          'يعرض التصحيح الذكي كل تعديل على التنسيق قبل تنفيذه، ثم يُنتج نسخة مصحّحة جديدة. لا ' +
          'يُمسّ مستندك الأصلي، ولا يُعاد تحرير ما كتبته.',
      },
      {
        title: 'تحقق',
        actor: 'palcert',
        text:
          'افحص النسخة المصحّحة مجددًا. يحمل كل تقرير ونتيجة بصمة رقمية، فيكون ما فُحص هو ' +
          'نفسه ما يُقدَّم.',
      },
      {
        title: 'اعتماد',
        actor: 'institution',
        text:
          'قدّم تلك النسخة بعينها تقديمًا رسميًا. يقبلها مراجعو المؤسسة أو يطلبون تعديلها أو ' +
          'يرفضونها، ويُسجَّل كل قرار.',
      },
      {
        title: 'شهادة',
        actor: 'palcert',
        text:
          'يحصل التقديم المقبول والمستوفي للمعيار على شهادة برقم فريد ورمز QR. يستطيع أي شخص ' +
          'التحقق منها، والشهادة الملغاة تُعلن إلغاءها بوضوح.',
      },
    ],
  },

  platform: {
    eyebrow: 'المنصّة',
    title: 'كل ما يحتاجه سير العمل في منصّة واحدة',
    lead: 'كل وحدة أدناه جزء من المنتج العامل، يستخدمها المؤلفون أو المؤسسات أو كل من يحمل شهادة.',
    audiences: {
      authors: 'للمؤلفين',
      institutions: 'للمؤسسات',
      everyone: 'للجميع',
    },
    modules: {
      documents: {
        title: 'المستندات',
        text: 'تخزين خاص لكل مستند بنسخ متتابعة. يُفحص كل ملف مرفوع قبل معالجته، وتُحفظ كل نسخة.',
      },
      checks: {
        title: 'الفحوصات والتقارير',
        text: 'تقارير امتثال قاعدةً قاعدة وفق معيار منشور، بنتيجة واضحة وسجلّ لكل ما تعذّر قياسه.',
      },
      smartfix: {
        title: 'التصحيح الذكي',
        text:
          'تصحيح تلقائي للتنسيق المرصود في مستندات Word، من أحجام وخطوط وتباعد وهوامش، يُعرض ' +
          'كاملًا قبل تنفيذه.',
      },
      ai: {
        title: 'المراجعة بالذكاء الاصطناعي',
        text:
          'رأي ثانٍ اختياري في المتطلبات التي تحتاج إلى قراءة لا إلى قياس. لا تعمل إلا بموافقتك، ' +
          'ولا تغيّر النتيجة الفنية أبدًا.',
      },
      submissions: {
        title: 'التقديمات الرسمية',
        text:
          'سلّم نسخة محددة من مستندك مع تقريرها إلى المؤسسة صاحبة المعيار، ثم تابعها خلال ' +
          'المراجعة والتعديل.',
      },
      review: {
        title: 'مراجعة المؤسسة',
        text: 'قائمة بالتقديمات الرسمية للمراجعين، مع التعليقات وطلبات التعديل والقرارات المسجّلة.',
      },
      standards: {
        title: 'المعايير وأنواع المستندات',
        text:
          'معايير ذات إصدارات تنتقل من المسودة إلى النشر، تُبنى من القواعد مباشرةً أو من الأدلة ' +
          'والقوالب المتوفرة لدى المؤسسة.',
      },
      certificates: {
        title: 'الشهادات',
        text: 'شهادات امتثال فني مرتبطة بالتقديم المقبول، برقم ورمز QR ومدة صلاحية وسجلّ كامل.',
      },
      verification: {
        title: 'التحقق العام',
        text: 'صفحة عامة يتحقق فيها أي شخص من الشهادة برقمها أو برمز QR، دون حساب ودون بحث بالأسماء.',
      },
      notifications: {
        title: 'الإشعارات',
        text:
          'صندوق وارد لكل تغيير يطرأ على تقديم أو شهادة، مع رسائل بريد إلكتروني تختارها حدثًا ' +
          'حدثًا.',
      },
      balance: {
        title: 'الرصيد والفوترة',
        text:
          'رصيد مسبق الدفع. يظهر السعر قبل بدء الفحص، ويُحجز أثناءه، ولا يُخصم إلا عند تسليم ' +
          'التقرير.',
      },
      integrations: {
        title: 'التكامل مع الأنظمة',
        text: 'عملاء للواجهة البرمجية وإشعارات آلية موقّعة، لتتابع أنظمة المؤسسة التقديمات والشهادات.',
      },
    },
  },

  solutions: {
    eyebrow: 'الحلول',
    title: 'منصّة واحدة لأربعة أدوار',
    lead: 'تمنح بال‌سيرت كل طرف في العملية ما يحتاج إليه ليتصرّف، ولا تكشف له ما ليس من شأنه.',
    audiences: {
      authors: {
        title: 'الخريجون والمؤلفون',
        lead: 'قدّم عن ثقة، لا عن تخمين.',
        points: [
          'اعرف قواعد التنسيق التي يستوفيها مستندك قبل أن تقدّمه',
          'صحّح التنسيق المرصود تلقائيًا دون المساس بما كتبت',
          'تابع تقديمك الرسمي خلال المراجعة والتعديل',
          'احصل على شهادة يمكنك مشاركتها ويستطيع أي شخص التحقق منها',
          'اطلب من مؤسسة مشاركة المصادقة على شهادة تحملها',
        ],
      },
      institutions: {
        title: 'الجامعات والمؤسسات',
        lead: 'انشر المعيار مرة واحدة، وطبّقه بالطريقة نفسها في كل مرة.',
        points: [
          'حوّل أدلّتك وقوالبك القائمة إلى معايير منشورة ذات إصدارات',
          'استقبل تقديمات فُحصت مسبقًا وفق معيارك',
          'أدِر فريقك وأدواره ودعواته ضمن مؤسسة واحدة',
          'راجِع طلبات المصادقة وحدّد أنواع المصادقة ورسومها',
          'اربط أنظمتك عبر عملاء الواجهة البرمجية والإشعارات الآلية',
        ],
      },
      reviewers: {
        title: 'المراجعون وجهات الاعتماد',
        lead: 'راجع المستند ذاته، وأدلّته مرفقة به.',
        points: [
          'اعمل من قائمة واحدة للتقديمات الرسمية',
          'اطّلع على تقرير الامتثال وبصمات النسخة قيد المراجعة',
          'اقبل أو اطلب تعديلًا أو ارفض، مع تعليقات موثّقة',
          'كل قرار منسوب إلى صاحبه ومؤرّخ',
        ],
      },
      verifiers: {
        title: 'جهات التوظيف والتحقق الخارجي',
        lead: 'تحقّق من الشهادة مباشرةً، دون الحاجة إلى حساب.',
        points: [
          'أدخل رقم الشهادة أو امسح رمز QR الخاص بها',
          'افتح رابط التحقق من المصادقة لترى حالتها الحالية',
          'اطّلع على النتيجة الفنية وقرار المؤسسة المسجّلين فيها',
          'الشهادات الملغاة والمنتهية تُعلن حالتها بوضوح',
          'لا دليل عامًّا للشهادات، ولا بحث بالأسماء',
        ],
      },
    },
  },

  value: {
    eyebrow: 'لماذا بال‌سيرت',
    title: 'مصمَّمة لقرارات يجب أن تصمد أمام التدقيق',
    lead:
      'يتعثّر عمل الامتثال حين تكون القواعد غامضة والتصحيح يدويًا والقرارات بلا أثر يمكن ' +
      'تتبّعه. بُنيت بال‌سيرت على النقيض من ذلك.',
    pillars: [
      {
        title: 'معايير منشورة لا آراء',
        text:
          'يجري كل فحص وفق إصدار واحد منشور من معيار المؤسسة، فيحصل المستند نفسه على النتيجة ' +
          'نفسها في كل مرة.',
      },
      {
        title: 'تصحيح دون إعادة كتابة',
        text: 'يغيّر التصحيح الذكي التنسيق وحده، ويعرض كل تعديل مسبقًا، ويحفظ مستندك الأصلي كما هو.',
      },
      {
        title: 'النسخة ذاتها في كل مرحلة',
        text:
          'تشير التقارير والتقديمات والشهادات إلى نسخة واحدة موثّقة ببصمة رقمية، فلا يمكن ' +
          'استبدالها في منتصف الطريق.',
      },
      {
        title: 'القرار للمؤسسة',
        text: 'تقيس بال‌سيرت التنسيق، أما القبول وطلب التعديل والرفض فمن شأن مراجعي المؤسسة أنفسهم.',
      },
      {
        title: 'شهادات يتحقق منها الجميع',
        text: 'يقود رقم الشهادة ورمز QR إلى صفحة تحقق عامة تبيّن صلاحيتها وانتهاءها وإلغاءها.',
      },
      {
        title: 'العربية والإنجليزية على قدم المساواة',
        text: 'تعمل كل شاشة باللغتين كاملتين، بخط عربي مختار للقراءة واتجاه كتابة صحيح في كل منهما.',
      },
    ],
  },

  trust: {
    eyebrow: 'الثقة والأمان',
    title: 'أمان يرافق السجلّ من أوله إلى آخره',
    lead:
      'تحفظ بال‌سيرت مستندات وقرارات وشهادات يعتمد عليها الناس، وكل منها محميّ وموثّق وقابل ' +
      'للتحقق بذاته.',
    principleLabel: 'حدود دور بال‌سيرت',
    principle:
      'تفحص بال‌سيرت التنسيق وفق معيار منشور. لا تحكم على البحث، ولا تتخذ القرار نيابةً عن ' +
      'المؤسسة.',
    assurances: [
      {
        title: 'التحقق بخطوتين',
        text:
          'تحمي رموز تطبيق المصادقة ورموز الاسترداد لمرة واحدة الحسابات، مع جلسات نشطة يمكنك ' +
          'مراجعتها وإنهاؤها.',
      },
      {
        title: 'عزل بيانات كل مؤسسة',
        text: 'تُفصل بيانات كل مؤسسة في قاعدة البيانات نفسها، لا في التطبيق وحده.',
      },
      {
        title: 'فحص الملفات المرفوعة',
        text: 'يُفحص كل ملف قبل أن تقرأه بال‌سيرت، ويُعزل كل ما يثير الريبة.',
      },
      {
        title: 'سلسلة قرارات موثّقة',
        text: 'تُسجَّل التقديمات والمراجعات والقرارات وحالات الإلغاء مع هوية المنفّذ ووقت التنفيذ.',
      },
      {
        title: 'نتائج موثّقة ببصمات رقمية',
        text: 'تحمل التقارير والنتائج والشهادات بصمات رقمية تكشف أي تغيير لاحق.',
      },
      {
        title: 'مؤسسات موثّقة',
        text: 'تتحقق بال‌سيرت من المؤسسات، وتحمل المؤسسة الموثّقة شارة ظاهرة.',
      },
      {
        title: 'الموافقة قبل الذكاء الاصطناعي',
        text:
          'لا يصل أي جزء من المستند إلى مزوّد ذكاء اصطناعي قبل موافقة صاحبه، وهو يعلم ما الذي ' +
          'سيُرسل.',
      },
      {
        title: 'مبالغ يمكن تتبّعها',
        text: 'يظهر كل حجز وخصم وإلغاء حجز في سجلّ رصيدك.',
      },
    ],
    verifierTitle: 'ما يراه من يتحقق من الشهادة',
    verifierLead:
      'تبيّن صفحة التحقق العامة حالة الشهادة والنتيجة الفنية وقرار المؤسسة، ولا شيء غير ذلك عن ' +
      'صاحبها.',
  },

  product: {
    eyebrow: 'المنتج',
    title: 'مساحة عمل واحدة لكل دور',
    lead:
      'المنصّة ذاتها تخدم المؤلف على مكتبه، والمراجع أمام قائمة التقديمات، ومن يتحقق من شهادة ' +
      'بين يديه.',
    sampleNote: 'رسوم توضيحية ببيانات افتراضية.',
    frames: {
      dashboard: {
        title: 'لوحة التحكم الشخصية',
        text: 'أحدث المستندات والفحوصات والتقديمات والشهادات في مكان واحد.',
      },
      documents: {
        title: 'المستندات ونسخها',
        text: 'كل ملف مرفوع محفوظ نسخةً مستقلة مع حالة معالجتها.',
      },
      report: {
        title: 'تقرير المطابقة',
        text: 'نتيجة واضحة وأعداد القواعد وشرح لكل ملاحظة.',
      },
      review: {
        title: 'قائمة مراجعة المؤسسة',
        text: 'تقديمات رسمية بانتظار القرار.',
      },
    },
  },

  faq: {
    eyebrow: 'الأسئلة الشائعة',
    title: 'أسئلة متكررة',
    items: [
      {
        question: 'ما بال‌سيرت؟',
        answer:
          'بال‌سيرت منصّة لفحص المستندات وفق معايير التنسيق التي تنشرها المؤسسات، وتصحيح ما يمكن ' +
          'تصحيحه، وتقديم المستندات رسميًا للمراجعة، وإصدار شهادات يستطيع أي شخص التحقق منها. ' +
          'وتتيح أيضًا طلب المصادقة على شهادة تحملها من إحدى المؤسسات المشاركة.',
      },
      {
        question: 'من يمكنه استخدامها؟',
        answer:
          'يمكن لأي شخص إنشاء حساب لفحص مستنداته. وتنشئ الجامعات والمؤسسات الأخرى مؤسسة على ' +
          'المنصّة لنشر المعايير ومراجعة التقديمات. أما التحقق من شهادة فلا يحتاج إلى حساب أصلًا.',
      },
      {
        question: 'كيف أتحقق من شهادة؟',
        answer:
          'افتح صفحة التحقق وأدخل رقم الشهادة المطبوع عليها، أو امسح رمز QR الخاص بها. تبيّن ' +
          'الصفحة إن كانت الشهادة صالحة أو منتهية أو ملغاة، وما الذي تشهد به.',
      },
      {
        question: 'ما المصادقة المؤسسية على الشهادات؟',
        answer:
          'ترفع شهادة تحملها بالفعل وتطلب من مؤسسة مشاركة المصادقة عليها. تراجع المؤسسة الملف ' +
          'ذاته وتقبل الطلب أو ترفضه. وللمصادقة المعتمدة رابط تحقق علني ورمز QR يبيّنان إن ' +
          'كانت سارية أو منتهية أو مسحوبة.',
      },
      {
        question: 'هل تصادق PalCert على الشهادات بنفسها؟',
        answer:
          'لا. تراجع المؤسسة الطلب وتتخذ القرار، بينما توفّر PalCert مسار الطلب، وتسجّل القرار ' +
          'وبصمة الملف، وتعرض نتيجة التحقق.',
      },
      {
        question: 'هل بال‌سيرت للمؤسسات فقط؟',
        answer:
          'لا. يستخدمها الأفراد لفحص مستنداتهم وتصحيحها وفق أي معيار منشور، سواء قدّموها بعد ' +
          'ذلك تقديمًا رسميًا أم لا.',
      },
      {
        question: 'هل يمكنني متابعة حالة المراجعة والتصحيح؟',
        answer:
          'نعم. يبيّن كل تقديم رسمي حالته الحالية وكل قرار صدر بشأنه، وتُعلمك بال‌سيرت داخل ' +
          'المنصّة، وبالبريد الإلكتروني إن اخترت ذلك.',
      },
      {
        question: 'كيف تُصدر الشهادة؟',
        answer:
          'حين تقبل المؤسسة تقديمًا رسميًا وجدته بال‌سيرت مستوفيًا للمعيار، تُصدر بال‌سيرت شهادة ' +
          'امتثال فني لتلك النسخة بعينها، تسجّل النتيجة الفنية وقرار المؤسسة معًا.',
      },
      {
        question: 'كيف تُدفع تكلفة الفحص؟',
        answer:
          'من رصيد بال‌سيرت المسبق الدفع. ترى السعر قبل البدء، ويُحجز المبلغ أثناء الفحص، ولا ' +
          'يُخصم إلا عند تسليم التقرير.',
      },
    ],
  },

  cta: {
    title: 'اجمع المعايير والتقديمات والشهادات في سير عمل واحد موثوق.',
    lead: 'أنشئ حسابًا لتفحص مستندًا أو تطلب مصادقة، أو تحقّق من شهادة وصلتك.',
    signInPrompt: 'لديك حساب؟',
  },

  footer: {
    summary:
      'فحص المستندات، والمصادقة على الشهادات، والتحقق العلني منها — للمؤسسات ولمن يعتمدون على ' +
      'شهاداتها.',
    platformHeading: 'المنصّة',
    accountHeading: 'الحساب',
    verificationHeading: 'التحقق',
    languageHeading: 'اللغة',
    resetPassword: 'استعادة كلمة المرور',
    howCertificationWorks: 'كيف تُصدر الشهادات',
    attestation: 'المصادقة على الشهادات',
    boundary:
      'تشهد PalCert بالامتثال الفني لمعيار منشور وتسجّل قرارات المؤسسات، ومنها قرارات ' +
      'المصادقة. ويبقى الحكم الأكاديمي وقرار المصادقة للمؤسسة.',
    copyright: '© بال‌سيرت',
  },
};

export const LANDING_MESSAGES: Readonly<Record<Locale, LandingMessages>> = { en, ar };

export function getLandingMessages(locale: Locale): LandingMessages {
  return LANDING_MESSAGES[locale] ?? LANDING_MESSAGES[DEFAULT_LOCALE];
}
