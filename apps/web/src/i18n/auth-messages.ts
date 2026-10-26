import type { Locale } from './locales';

/**
 * Authentication message catalogue (§38).
 *
 * Every key must exist in both locales with a genuine translation — enforced by
 * test, so a missing Arabic string fails CI rather than silently showing
 * English to an Arabic-speaking user.
 *
 * Error strings are keyed by the stable PalCert error code, so the server never
 * sends user-facing prose that the client cannot localize, and a code the UI
 * does not know still renders a safe generic message.
 */
export interface AuthMessages {
  readonly signIn: string;
  readonly signOut: string;
  readonly register: string;
  readonly email: string;
  readonly password: string;
  readonly currentPassword: string;
  readonly newPassword: string;
  readonly confirmPassword: string;
  readonly passwordChangeTitle: string;
  readonly passwordChanged: string;
  readonly currentPasswordWrong: string;
  readonly displayName: string;
  readonly displayNameOptional: string;
  readonly submit: string;
  readonly sending: string;

  readonly registerTitle: string;
  readonly registerSubtitle: string;
  readonly registerSuccess: string;
  readonly alreadyHaveAccount: string;

  readonly loginTitle: string;
  readonly loginSubtitle: string;
  readonly forgotPasswordLink: string;
  readonly needAccount: string;

  readonly verifyTitle: string;
  readonly verifyPending: string;
  readonly verifySuccess: string;
  readonly verifyMissingToken: string;
  readonly resendVerification: string;
  readonly resendSent: string;
  readonly resendPrompt: string;
  readonly resendCooldown: string;
  readonly emailUnconfirmed: string;
  readonly mfaDisable: string;
  readonly mfaDisableIntro: string;
  readonly mfaDisabled: string;
  readonly mfaRequiredNote: string;
  /** Said instead of {@link mfaRequiredNote} when a role (not an override) is the reason. */
  readonly mfaRequiredByRoleNote: string;
  /** Where an expired session is sent to sign in again. */
  readonly signInAgain: string;
  readonly cancel: string;
  readonly close: string;

  readonly forgotTitle: string;
  readonly forgotSubtitle: string;
  readonly forgotSent: string;

  readonly resetTitle: string;
  readonly resetSuccess: string;
  readonly resetMissingToken: string;

  readonly mfaTitle: string;
  readonly mfaSubtitle: string;
  readonly mfaCode: string;
  readonly mfaUseRecovery: string;
  readonly mfaUseAuthenticator: string;
  readonly mfaRecoveryCode: string;

  readonly mfaEnrollTitle: string;
  readonly mfaEnrollSubtitle: string;
  readonly mfaEnrollSecretLabel: string;
  readonly mfaEnrollQrAlt: string;
  readonly mfaEnrollConfirm: string;
  readonly mfaRecoveryCodesTitle: string;
  readonly mfaRecoveryCodesWarning: string;
  readonly mfaContinue: string;

  readonly profileTitle: string;
  readonly profileRoles: string;
  readonly profileStatus: string;
  readonly profileMfa: string;
  readonly profileMfaOn: string;
  readonly profileMfaOff: string;
  readonly profileMfaSetUp: string;
  /** The short visible action labels beside the status badge. */
  readonly profileMfaSetUpShort: string;
  readonly profileMfaTurnOff: string;
  readonly profileDetails: string;
  readonly profileAccount: string;
  readonly profileSecurity: string;
  readonly accountRoleLabels: Readonly<Record<string, string>>;
  readonly accountStatusLabels: Readonly<Record<string, string>>;
  readonly profileSave: string;
  readonly profileSaved: string;
  readonly preferredLanguage: string;

  readonly sessionsTitle: string;
  readonly sessionsSubtitle: string;
  readonly sessionCurrent: string;
  readonly sessionLastActive: string;
  readonly sessionExpires: string;
  readonly sessionRevoke: string;
  readonly sessionsNone: string;
  readonly signOutEverywhere: string;

  readonly forbiddenTitle: string;
  readonly forbiddenBody: string;
  readonly unauthorizedTitle: string;
  readonly unauthorizedBody: string;
  readonly backToSignIn: string;

  readonly passwordHint: string;
  readonly passwordMismatch: string;
  readonly requiredField: string;
  readonly genericError: string;
  readonly errors: Readonly<Record<string, string>>;
}

const en: AuthMessages = {
  signIn: 'Sign in',
  signOut: 'Sign out',
  register: 'Create account',
  email: 'Email address',
  password: 'Password',
  currentPassword: 'Current password',
  newPassword: 'New password',
  confirmPassword: 'Confirm new password',
  passwordChangeTitle: 'Change password',
  passwordChanged:
    'Your password has been changed. Every other session was signed out; this one stays signed in.',
  currentPasswordWrong: 'The current password is not correct.',
  displayName: 'Display name',
  displayNameOptional: 'Display name (optional)',
  submit: 'Continue',
  sending: 'Please wait…',

  registerTitle: 'Create your PalCert account',
  registerSubtitle: 'Check documents against your institution’s requirements.',
  registerSuccess:
    'If that address can be registered, we have sent a confirmation link. Please check your inbox.',
  alreadyHaveAccount: 'Already have an account?',

  loginTitle: 'Sign in to PalCert',
  loginSubtitle: 'Use your email address and password.',
  forgotPasswordLink: 'Forgot your password?',
  needAccount: 'Need an account?',

  verifyTitle: 'Confirm your email address',
  verifyPending: 'Confirming your email address…',
  verifySuccess: 'Your email address is confirmed. You can sign in now.',
  verifyMissingToken: 'This link is incomplete. Please use the link from your email exactly.',
  resendVerification: 'Send the confirmation link again',
  resendSent: 'If that address needs confirming, a new link is on its way.',
  resendPrompt: 'Didn’t receive the email?',
  resendCooldown: 'You can ask for another link in a minute.',
  emailUnconfirmed: 'Your email address is not confirmed yet.',
  mfaDisable: 'Turn off two-step sign-in',
  mfaDisableIntro:
    'Enter your password and a current code from your authenticator app. Both are needed, so a ' +
    'stolen session or a stolen password alone cannot remove your second factor.',
  mfaDisabled: 'Two-step sign-in has been turned off.',
  mfaRequiredNote: 'Two-step sign-in is required for your account and cannot be turned off.',
  mfaRequiredByRoleNote: 'Two-step sign-in is required for your role and cannot be turned off.',
  signInAgain: 'Sign in again',
  cancel: 'Cancel',
  close: 'Close',

  forgotTitle: 'Reset your password',
  forgotSubtitle: 'We will email you a link to choose a new password.',
  forgotSent: 'If that address has an account, a reset link is on its way.',

  resetTitle: 'Choose a new password',
  resetSuccess: 'Your password has been changed. You can sign in with it now.',
  resetMissingToken: 'This link is incomplete. Please use the link from your email exactly.',

  mfaTitle: 'Two-step sign-in',
  mfaSubtitle: 'Enter the six-digit code from your authenticator app.',
  mfaCode: 'Authenticator code',
  mfaUseRecovery: 'Use a recovery code instead',
  mfaUseAuthenticator: 'Use your authenticator app instead',
  mfaRecoveryCode: 'Recovery code',

  mfaEnrollTitle: 'Set up two-step sign-in',
  mfaEnrollSubtitle:
    'Your role requires a second factor. Scan the code with an authenticator app, then enter the code it shows.',
  mfaEnrollSecretLabel: 'Or enter this key manually',
  mfaEnrollQrAlt: 'QR code for setting up two-step sign-in',
  mfaEnrollConfirm: 'Confirm and finish',
  mfaRecoveryCodesTitle: 'Save your recovery codes',
  mfaRecoveryCodesWarning:
    'Each code works once. Store them somewhere safe — they are shown only now and cannot be retrieved later.',
  mfaContinue: 'I have saved them, continue',

  profileTitle: 'Your profile',
  profileRoles: 'Roles',
  profileStatus: 'Account status',
  profileMfa: 'Two-step sign-in',
  profileMfaOn: 'Enabled',
  profileMfaOff: 'Not enabled',
  profileMfaSetUp: 'Set up two-step sign-in',
  profileMfaSetUpShort: 'Set up',
  profileMfaTurnOff: 'Turn off',
  profileDetails: 'Your details',
  profileAccount: 'Account',
  profileSecurity: 'Security',
  accountRoleLabels: {
    STUDENT: 'Student',
    SERVICE_USER: 'User',
    PALCERT_ADMIN: 'PalCert administrator',
    PALCERT_FINANCE: 'PalCert finance',
    PALCERT_SUPPORT: 'PalCert support',
    PALCERT_AUDITOR: 'PalCert auditor',
    API_CLIENT: 'API client',
  },
  accountStatusLabels: {
    PENDING_VERIFICATION: 'Email not verified yet',
    ACTIVE: 'Active',
    SUSPENDED: 'Suspended',
    DISABLED: 'Disabled',
  },
  profileSave: 'Save changes',
  profileSaved: 'Your changes have been saved.',
  preferredLanguage: 'Preferred language',

  sessionsTitle: 'Active sessions',
  sessionsSubtitle: 'Devices and browsers currently signed in to your account.',
  sessionCurrent: 'This device',
  sessionLastActive: 'Last active',
  sessionExpires: 'Expires',
  sessionRevoke: 'Sign out',
  sessionsNone: 'No other active sessions.',
  signOutEverywhere: 'Sign out everywhere',

  forbiddenTitle: 'You do not have access to this page',
  forbiddenBody: 'Your account does not have the permissions needed here.',
  unauthorizedTitle: 'Please sign in',
  unauthorizedBody: 'You need to sign in to view this page.',
  backToSignIn: 'Back to sign in',

  passwordHint: 'Use at least 12 characters. A memorable phrase works well.',
  passwordMismatch: 'The two passwords do not match.',
  requiredField: 'This field is required.',
  genericError: 'Something went wrong. Please try again.',
  errors: {
    AUTHENTICATION_FAILED: 'Incorrect email address or password.',
    EMAIL_NOT_VERIFIED: 'Please confirm your email address before signing in.',
    ACCOUNT_SUSPENDED: 'This account is suspended. Please contact support.',
    ACCOUNT_DISABLED: 'This account is no longer available.',
    SESSION_EXPIRED: 'Your session has expired. Please sign in again.',
    UNAUTHENTICATED: 'Your session has ended. Please sign in again.',
    SESSION_REVOKED: 'This session is no longer valid. Please sign in again.',
    VERIFICATION_TOKEN_INVALID: 'This confirmation link is no longer valid.',
    VERIFICATION_TOKEN_EXPIRED: 'This confirmation link has expired. Request a new one.',
    PASSWORD_RESET_TOKEN_INVALID: 'This reset link is no longer valid.',
    PASSWORD_RESET_TOKEN_EXPIRED: 'This reset link has expired. Request a new one.',
    PASSWORD_POLICY_VIOLATION: 'Please choose a longer password.',
    MFA_REQUIRED: 'Two-step sign-in is required.',
    MFA_INVALID: 'That code is not valid. Please try again.',
    MFA_ENROLLMENT_REQUIRED: 'You need to set up two-step sign-in first.',
    MFA_ALREADY_ENROLLED: 'Two-step sign-in is already set up.',
    PERMISSION_DENIED: 'You do not have permission to do this.',
    RATE_LIMITED: 'Too many attempts. Please wait a little and try again.',
    CSRF_INVALID: 'Your request could not be verified. Please refresh the page and try again.',
    VALIDATION_FAILED: 'Please check the information you entered.',
    REAUTHENTICATION_REQUIRED: 'Please confirm your password again to continue.',
  },
};

const ar: AuthMessages = {
  signIn: 'تسجيل الدخول',
  signOut: 'تسجيل الخروج',
  register: 'إنشاء حساب',
  email: 'البريد الإلكتروني',
  password: 'كلمة المرور',
  currentPassword: 'كلمة المرور الحالية',
  newPassword: 'كلمة المرور الجديدة',
  confirmPassword: 'تأكيد كلمة المرور الجديدة',
  passwordChangeTitle: 'تغيير كلمة المرور',
  passwordChanged: 'تم تغيير كلمة المرور. خرجت كل الجلسات الأخرى، وتبقى هذه الجلسة مسجّلة الدخول.',
  currentPasswordWrong: 'كلمة المرور الحالية غير صحيحة.',
  displayName: 'الاسم الظاهر',
  displayNameOptional: 'الاسم الظاهر (اختياري)',
  submit: 'متابعة',
  sending: 'يرجى الانتظار…',

  registerTitle: 'أنشئ حسابك في بال‌سيرت',
  registerSubtitle: 'افحص المستندات وفق متطلبات مؤسستك.',
  registerSuccess:
    'إذا كان بالإمكان تسجيل هذا العنوان، فقد أرسلنا رابط تأكيد. يرجى مراجعة بريدك الإلكتروني.',
  alreadyHaveAccount: 'لديك حساب بالفعل؟',

  loginTitle: 'تسجيل الدخول إلى بال‌سيرت',
  loginSubtitle: 'استخدم بريدك الإلكتروني وكلمة المرور.',
  forgotPasswordLink: 'هل نسيت كلمة المرور؟',
  needAccount: 'تحتاج إلى حساب؟',

  verifyTitle: 'تأكيد بريدك الإلكتروني',
  verifyPending: 'جارٍ تأكيد بريدك الإلكتروني…',
  verifySuccess: 'تم تأكيد بريدك الإلكتروني. يمكنك تسجيل الدخول الآن.',
  verifyMissingToken: 'هذا الرابط غير مكتمل. يرجى استخدام الرابط من بريدك كما هو.',
  resendVerification: 'إعادة إرسال رابط التأكيد',
  resendSent: 'إذا كان هذا العنوان بحاجة إلى تأكيد، فالرابط الجديد في طريقه إليك.',
  resendPrompt: 'لم تصلك الرسالة؟',
  resendCooldown: 'يمكنك طلب رابط آخر بعد دقيقة.',
  emailUnconfirmed: 'لم يتم تأكيد بريدك الإلكتروني بعد.',
  mfaDisable: 'إيقاف التحقق بخطوتين',
  mfaDisableIntro:
    'أدخل كلمة المرور ورمزًا حاليًا من تطبيق المصادقة. كلاهما مطلوب، حتى لا تكفي جلسة مسروقة ' +
    'أو كلمة مرور مسروقة وحدها لإزالة العامل الثاني.',
  mfaDisabled: 'تم إيقاف التحقق بخطوتين.',
  mfaRequiredNote: 'التحقق بخطوتين إلزامي لحسابك ولا يمكن إيقافه.',
  mfaRequiredByRoleNote: 'التحقق بخطوتين إلزامي لهذا الدور ولا يمكن إيقافه.',
  signInAgain: 'تسجيل الدخول مرة أخرى',
  cancel: 'إلغاء',
  close: 'إغلاق',

  forgotTitle: 'إعادة تعيين كلمة المرور',
  forgotSubtitle: 'سنرسل إليك رابطًا لاختيار كلمة مرور جديدة.',
  forgotSent: 'إذا كان لهذا العنوان حساب، فرابط إعادة التعيين في طريقه إليك.',

  resetTitle: 'اختر كلمة مرور جديدة',
  resetSuccess: 'تم تغيير كلمة المرور. يمكنك تسجيل الدخول بها الآن.',
  resetMissingToken: 'هذا الرابط غير مكتمل. يرجى استخدام الرابط من بريدك كما هو.',

  mfaTitle: 'التحقق بخطوتين',
  mfaSubtitle: 'أدخل الرمز المكوّن من ستة أرقام من تطبيق المصادقة.',
  mfaCode: 'رمز التحقق',
  mfaUseRecovery: 'استخدام رمز استرداد بدلاً من ذلك',
  mfaUseAuthenticator: 'استخدام تطبيق المصادقة بدلاً من ذلك',
  mfaRecoveryCode: 'رمز الاسترداد',

  mfaEnrollTitle: 'إعداد التحقق بخطوتين',
  mfaEnrollSubtitle:
    'يتطلب دورك عاملاً ثانيًا. امسح الرمز بتطبيق المصادقة، ثم أدخل الرمز الذي يعرضه.',
  mfaEnrollSecretLabel: 'أو أدخل هذا المفتاح يدويًا',
  mfaEnrollQrAlt: 'رمز الاستجابة السريعة لإعداد التحقق بخطوتين',
  mfaEnrollConfirm: 'تأكيد وإنهاء',
  mfaRecoveryCodesTitle: 'احفظ رموز الاسترداد',
  mfaRecoveryCodesWarning:
    'يعمل كل رمز مرة واحدة. احفظها في مكان آمن — تُعرض الآن فقط ولا يمكن استرجاعها لاحقًا.',
  mfaContinue: 'لقد حفظتها، متابعة',

  profileTitle: 'ملفك الشخصي',
  profileRoles: 'الأدوار',
  profileStatus: 'حالة الحساب',
  profileMfa: 'التحقق بخطوتين',
  profileMfaOn: 'مفعّل',
  profileMfaOff: 'غير مفعّل',
  profileMfaSetUp: 'إعداد التحقق بخطوتين',
  profileMfaSetUpShort: 'إعداد',
  profileMfaTurnOff: 'إيقاف',
  profileDetails: 'بياناتك',
  profileAccount: 'الحساب',
  profileSecurity: 'الأمان',
  accountRoleLabels: {
    STUDENT: 'طالب',
    SERVICE_USER: 'مستخدم',
    PALCERT_ADMIN: 'مسؤول بال‌سيرت',
    PALCERT_FINANCE: 'الشؤون المالية في بال‌سيرت',
    PALCERT_SUPPORT: 'دعم بال‌سيرت',
    PALCERT_AUDITOR: 'مدقّق بال‌سيرت',
    API_CLIENT: 'عميل واجهة برمجية',
  },
  accountStatusLabels: {
    PENDING_VERIFICATION: 'لم يُتحقق من البريد بعد',
    ACTIVE: 'نشط',
    SUSPENDED: 'موقوف',
    DISABLED: 'معطّل',
  },
  profileSave: 'حفظ التغييرات',
  profileSaved: 'تم حفظ التغييرات.',
  preferredLanguage: 'اللغة المفضلة',

  sessionsTitle: 'الجلسات النشطة',
  sessionsSubtitle: 'الأجهزة والمتصفحات المسجّلة الدخول إلى حسابك حاليًا.',
  sessionCurrent: 'هذا الجهاز',
  sessionLastActive: 'آخر نشاط',
  sessionExpires: 'تنتهي في',
  sessionRevoke: 'تسجيل الخروج',
  sessionsNone: 'لا توجد جلسات نشطة أخرى.',
  signOutEverywhere: 'تسجيل الخروج من كل الأجهزة',

  forbiddenTitle: 'لا تملك صلاحية الوصول إلى هذه الصفحة',
  forbiddenBody: 'حسابك لا يملك الصلاحيات المطلوبة هنا.',
  unauthorizedTitle: 'يرجى تسجيل الدخول',
  unauthorizedBody: 'تحتاج إلى تسجيل الدخول لعرض هذه الصفحة.',
  backToSignIn: 'العودة إلى تسجيل الدخول',

  passwordHint: 'استخدم ١٢ حرفًا على الأقل. العبارة التي يسهل تذكّرها خيار جيد.',
  passwordMismatch: 'كلمتا المرور غير متطابقتين.',
  requiredField: 'هذا الحقل مطلوب.',
  genericError: 'حدث خطأ ما. يرجى المحاولة مرة أخرى.',
  errors: {
    AUTHENTICATION_FAILED: 'البريد الإلكتروني أو كلمة المرور غير صحيحة.',
    EMAIL_NOT_VERIFIED: 'يرجى تأكيد بريدك الإلكتروني قبل تسجيل الدخول.',
    ACCOUNT_SUSPENDED: 'هذا الحساب موقوف. يرجى التواصل مع الدعم.',
    ACCOUNT_DISABLED: 'هذا الحساب لم يعد متاحًا.',
    SESSION_EXPIRED: 'انتهت جلستك. يرجى تسجيل الدخول مرة أخرى.',
    UNAUTHENTICATED: 'انتهت جلستك. يرجى تسجيل الدخول مرة أخرى.',
    SESSION_REVOKED: 'هذه الجلسة لم تعد صالحة. يرجى تسجيل الدخول مرة أخرى.',
    VERIFICATION_TOKEN_INVALID: 'رابط التأكيد هذا لم يعد صالحًا.',
    VERIFICATION_TOKEN_EXPIRED: 'انتهت صلاحية رابط التأكيد. اطلب رابطًا جديدًا.',
    PASSWORD_RESET_TOKEN_INVALID: 'رابط إعادة التعيين هذا لم يعد صالحًا.',
    PASSWORD_RESET_TOKEN_EXPIRED: 'انتهت صلاحية رابط إعادة التعيين. اطلب رابطًا جديدًا.',
    PASSWORD_POLICY_VIOLATION: 'يرجى اختيار كلمة مرور أطول.',
    MFA_REQUIRED: 'التحقق بخطوتين مطلوب.',
    MFA_INVALID: 'هذا الرمز غير صحيح. يرجى المحاولة مرة أخرى.',
    MFA_ENROLLMENT_REQUIRED: 'عليك إعداد التحقق بخطوتين أولاً.',
    MFA_ALREADY_ENROLLED: 'التحقق بخطوتين مُعدّ بالفعل.',
    PERMISSION_DENIED: 'لا تملك صلاحية القيام بذلك.',
    RATE_LIMITED: 'محاولات كثيرة. يرجى الانتظار قليلاً ثم المحاولة مجددًا.',
    CSRF_INVALID: 'تعذّر التحقق من طلبك. يرجى تحديث الصفحة والمحاولة مرة أخرى.',
    VALIDATION_FAILED: 'يرجى التحقق من المعلومات التي أدخلتها.',
    REAUTHENTICATION_REQUIRED: 'يرجى تأكيد كلمة المرور مرة أخرى للمتابعة.',
  },
};

export const AUTH_MESSAGES: Record<Locale, AuthMessages> = { en, ar };

export function getAuthMessages(locale: Locale): AuthMessages {
  return AUTH_MESSAGES[locale] ?? AUTH_MESSAGES.en;
}

/** Resolve a server error code to localized prose, falling back safely. */
export function messageForErrorCode(messages: AuthMessages, code: string | undefined): string {
  if (code === undefined) return messages.genericError;
  return messages.errors[code] ?? messages.genericError;
}
