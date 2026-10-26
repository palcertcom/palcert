import type { Locale } from './locales';

/**
 * Organization message catalogue (§58).
 *
 * Canonical API enum values (`ORGANIZATION_OWNER`, `PENDING`, …) never appear in
 * the UI directly: they are looked up here, so the API contract stays stable
 * while the presentation is translated. Parity across locales is enforced by
 * test, including for the nested label maps.
 */
export interface OrganizationMessages {
  readonly teamManage: {
    readonly removeRole: string;
    readonly removeRoleIntro: string;
    readonly roleRemoved: string;
    readonly transferTitle: string;
    readonly transferIntro: string;
    readonly transferTo: string;
    readonly stepDown: string;
    readonly stayOwner: string;
    readonly transfer: string;
    readonly transferred: string;
    readonly noCandidates: string;
    readonly cancel: string;
    readonly close: string;
    readonly optional: string;
    readonly working: string;
    readonly required: string;
  };
  readonly organizations: string;
  readonly noOrganizations: string;
  readonly createOrganization: string;
  readonly switchOrganization: string;
  readonly currentOrganization: string;

  readonly createTitle: string;
  readonly createSubtitle: string;
  readonly displayName: string;
  readonly legalName: string;
  readonly organizationType: string;
  readonly country: string;
  readonly website: string;
  readonly websiteOptional: string;
  readonly timezone: string;
  readonly defaultLanguage: string;
  readonly handle: string;
  readonly handleHint: string;
  readonly create: string;

  readonly navOverview: string;
  readonly navProfile: string;
  readonly navTeam: string;
  readonly navInvitations: string;
  readonly navVerification: string;
  readonly navSettings: string;

  readonly overviewTitle: string;
  readonly organizationSections: string;
  readonly memberCount: string;
  readonly created: string;

  readonly profileTitle: string;
  readonly saveChanges: string;
  readonly saved: string;

  readonly teamTitle: string;
  readonly teamSubtitle: string;
  readonly member: string;
  readonly roles: string;
  readonly memberStatus: string;
  readonly joined: string;
  readonly actions: string;
  readonly suspend: string;
  readonly reactivate: string;
  readonly remove: string;
  readonly addRole: string;
  readonly removeRole: string;
  readonly loadMore: string;

  readonly invitationsTitle: string;
  readonly inviteSomeone: string;
  readonly emailAddress: string;
  readonly role: string;
  readonly sendInvitation: string;
  readonly invitationSent: string;
  readonly revoke: string;
  readonly expires: string;
  readonly noInvitations: string;

  readonly acceptTitle: string;
  readonly acceptSubtitle: string;
  readonly acceptInvitation: string;
  readonly acceptRegisterFirst: string;
  readonly acceptedMessage: string;

  readonly verificationTitle: string;
  readonly verificationSemantics: string;
  readonly requestVerification: string;
  readonly verificationNote: string;
  readonly verificationRequested: string;
  readonly verificationReason: string;
  readonly verifiedBadge: string;

  readonly confirmSuspend: string;
  readonly confirmRemove: string;
  readonly cancel: string;
  readonly confirm: string;

  readonly typeLabels: Readonly<Record<string, string>>;
  readonly roleLabels: Readonly<Record<string, string>>;
  readonly statusLabels: Readonly<Record<string, string>>;
  readonly verificationLabels: Readonly<Record<string, string>>;
  readonly errors: Readonly<Record<string, string>>;
}

const en: OrganizationMessages = {
  organizations: 'Organizations',
  noOrganizations: 'You do not belong to any organization yet.',
  createOrganization: 'Create an organization',
  switchOrganization: 'Switch organization',
  currentOrganization: 'Current organization',

  createTitle: 'Create an organization',
  createSubtitle: 'Set up your university, journal, publisher or institution on PalCert.',
  displayName: 'Organization name',
  legalName: 'Legal name',
  organizationType: 'Organization type',
  country: 'Country',
  website: 'Website',
  websiteOptional: 'Website (optional)',
  timezone: 'Timezone',
  defaultLanguage: 'Default language',
  handle: 'Handle (optional)',
  handleHint:
    'Used in links. Lowercase letters, digits and hyphens. Derived from the name if left blank.',
  create: 'Create',

  navOverview: 'Overview',
  navProfile: 'Profile',
  navTeam: 'Team',
  navInvitations: 'Invitations',
  navVerification: 'Verification',
  navSettings: 'Settings',

  overviewTitle: 'Overview',
  organizationSections: 'Organization sections',
  memberCount: 'Members',
  created: 'Created',

  profileTitle: 'Organization profile',
  saveChanges: 'Save changes',
  saved: 'Your changes have been saved.',

  teamTitle: 'Team',
  teamSubtitle: 'People who can work in this organization.',
  member: 'Member',
  roles: 'Roles',
  memberStatus: 'Status',
  joined: 'Joined',
  actions: 'Actions',
  suspend: 'Suspend',
  reactivate: 'Reactivate',
  remove: 'Remove',
  addRole: 'Add role',
  removeRole: 'Remove role',
  teamManage: {
    removeRole: 'Remove role',
    removeRoleIntro:
      'The member loses this role’s permissions immediately. An organization must always keep ' +
      'at least one owner.',
    roleRemoved: 'The role was removed.',
    transferTitle: 'Transfer ownership',
    transferIntro:
      'The new owner is given the owner role before anything else changes, so the organization is ' +
      'never without an owner. This needs a recent sign-in.',
    transferTo: 'New owner',
    stepDown: 'Give up my owner role',
    stayOwner: 'Stay an owner as well',
    transfer: 'Transfer ownership',
    transferred: 'Ownership was transferred.',
    noCandidates: 'Invite someone and wait for them to join before transferring ownership.',
    cancel: 'Cancel',
    close: 'Close',
    optional: 'Optional',
    working: 'Please wait…',
    required: 'This field is required.',
  },
  loadMore: 'Load more',

  invitationsTitle: 'Invitations',
  inviteSomeone: 'Invite someone',
  emailAddress: 'Email address',
  role: 'Role',
  sendInvitation: 'Send invitation',
  invitationSent: 'The invitation has been sent.',
  revoke: 'Revoke',
  expires: 'Expires',
  noInvitations: 'No invitations yet.',

  acceptTitle: 'Join an organization',
  acceptSubtitle: 'You have been invited to PalCert.',
  acceptInvitation: 'Accept invitation',
  acceptRegisterFirst:
    'Create an account with the invited email address, then return to this link.',
  acceptedMessage: 'You have joined the organization.',

  verificationTitle: 'Verification',
  verificationSemantics:
    'PalCert verification confirms that the organization’s identity and account have passed ' +
    'PalCert’s verification process. It is not an assessment of academic quality, research ' +
    'validity or editorial standards.',
  requestVerification: 'Request verification',
  verificationNote: 'Anything PalCert should know (optional)',
  verificationRequested: 'Your verification request is with the PalCert team.',
  verificationReason: 'Reason',
  verifiedBadge: 'Verified organization',

  confirmSuspend: 'Suspend this member’s access to the organization?',
  confirmRemove: 'Remove this member from the organization?',
  cancel: 'Cancel',
  confirm: 'Confirm',

  typeLabels: {
    UNIVERSITY: 'University',
    SCIENTIFIC_JOURNAL: 'Scientific journal',
    PUBLISHER: 'Publisher',
    RESEARCH_INSTITUTION: 'Research institution',
    GOVERNMENT: 'Government',
    COMPANY: 'Company',
    OTHER: 'Other',
  },
  roleLabels: {
    ORGANIZATION_OWNER: 'Owner',
    ORGANIZATION_ADMIN: 'Administrator',
    ORGANIZATION_REVIEWER: 'Reviewer',
    TEMPLATE_MANAGER: 'Template manager',
  },
  statusLabels: {
    ACTIVE: 'Active',
    SUSPENDED: 'Suspended',
    REMOVED: 'Removed',
    CLOSED: 'Closed',
    PENDING: 'Pending',
    ACCEPTED: 'Accepted',
    REVOKED: 'Revoked',
    EXPIRED: 'Expired',
  },
  verificationLabels: {
    UNVERIFIED: 'Not verified',
    PENDING: 'Under review',
    VERIFIED: 'Verified',
    REJECTED: 'Not accepted',
  },
  errors: {
    ORGANIZATION_NOT_FOUND: 'That organization is not available to you.',
    ORGANIZATION_ACCESS_DENIED: 'You do not have permission to do this in this organization.',
    ORGANIZATION_SUSPENDED: 'This organization is suspended. Please contact PalCert support.',
    ORGANIZATION_CLOSED: 'This organization has been closed.',
    ORGANIZATION_SLUG_TAKEN: 'That handle is already in use.',
    ORGANIZATION_ALREADY_VERIFIED: 'This organization is already verified.',
    ORGANIZATION_VERIFICATION_PENDING: 'A verification request is already under review.',
    MEMBERSHIP_NOT_FOUND: 'That member could not be found.',
    MEMBERSHIP_SUSPENDED: 'Your access to this organization is suspended.',
    MEMBERSHIP_ALREADY_EXISTS: 'That person is already a member.',
    LAST_OWNER_REQUIRED:
      'An organization must always have at least one owner. Transfer ownership first.',
    INVITATION_NOT_FOUND: 'This invitation link is not valid.',
    INVITATION_EXPIRED: 'This invitation has expired. Ask for a new one.',
    INVITATION_REVOKED: 'This invitation has been withdrawn.',
    INVITATION_ALREADY_USED: 'This invitation has already been used.',
    INVITATION_EMAIL_MISMATCH: 'This invitation was sent to a different email address.',
    INVITATION_ALREADY_PENDING: 'An invitation for that address is already outstanding.',
    ROLE_SCOPE_INVALID: 'That role cannot be granted here.',
    TENANT_ACCESS_DENIED: 'You do not have access to this organization.',
  },
};

const ar: OrganizationMessages = {
  organizations: 'المؤسسات',
  noOrganizations: 'لا تنتمي إلى أي مؤسسة بعد.',
  createOrganization: 'إنشاء مؤسسة',
  switchOrganization: 'تبديل المؤسسة',
  currentOrganization: 'المؤسسة الحالية',

  createTitle: 'إنشاء مؤسسة',
  createSubtitle: 'سجّل جامعتك أو مجلتك أو دار النشر أو مؤسستك في بال‌سيرت.',
  displayName: 'اسم المؤسسة',
  legalName: 'الاسم القانوني',
  organizationType: 'نوع المؤسسة',
  country: 'الدولة',
  website: 'الموقع الإلكتروني',
  websiteOptional: 'الموقع الإلكتروني (اختياري)',
  timezone: 'المنطقة الزمنية',
  defaultLanguage: 'اللغة الافتراضية',
  handle: 'المعرّف (اختياري)',
  handleHint:
    'يُستخدم في الروابط. أحرف لاتينية صغيرة وأرقام وشرطات. يُشتق من الاسم إذا تُرك فارغًا.',
  create: 'إنشاء',

  navOverview: 'نظرة عامة',
  navProfile: 'الملف',
  navTeam: 'الفريق',
  navInvitations: 'الدعوات',
  navVerification: 'التحقق',
  navSettings: 'الإعدادات',

  overviewTitle: 'نظرة عامة',
  organizationSections: 'أقسام المؤسسة',
  memberCount: 'الأعضاء',
  created: 'تاريخ الإنشاء',

  profileTitle: 'ملف المؤسسة',
  saveChanges: 'حفظ التغييرات',
  saved: 'تم حفظ التغييرات.',

  teamTitle: 'الفريق',
  teamSubtitle: 'الأشخاص الذين يمكنهم العمل في هذه المؤسسة.',
  member: 'العضو',
  roles: 'الأدوار',
  memberStatus: 'الحالة',
  joined: 'تاريخ الانضمام',
  actions: 'الإجراءات',
  suspend: 'إيقاف',
  reactivate: 'إعادة التفعيل',
  remove: 'إزالة',
  addRole: 'إضافة دور',
  removeRole: 'إزالة دور',
  teamManage: {
    removeRole: 'إزالة الدور',
    removeRoleIntro:
      'يفقد العضو صلاحيات هذا الدور فورًا. ويجب أن يبقى للمؤسسة مالك واحد على الأقل دائمًا.',
    roleRemoved: 'تمت إزالة الدور.',
    transferTitle: 'نقل الملكية',
    transferIntro:
      'يُمنح المالك الجديد دور المالك قبل أي تغيير آخر، فلا تبقى المؤسسة بلا مالك. ويتطلب ذلك ' +
      'تسجيل دخول حديثًا.',
    transferTo: 'المالك الجديد',
    stepDown: 'التخلي عن دوري كمالك',
    stayOwner: 'البقاء مالكًا أيضًا',
    transfer: 'نقل الملكية',
    transferred: 'تم نقل الملكية.',
    noCandidates: 'ادعُ شخصًا وانتظر انضمامه قبل نقل الملكية.',
    cancel: 'إلغاء',
    close: 'إغلاق',
    optional: 'اختياري',
    working: 'يرجى الانتظار…',
    required: 'هذا الحقل مطلوب.',
  },
  loadMore: 'تحميل المزيد',

  invitationsTitle: 'الدعوات',
  inviteSomeone: 'دعوة شخص',
  emailAddress: 'البريد الإلكتروني',
  role: 'الدور',
  sendInvitation: 'إرسال الدعوة',
  invitationSent: 'تم إرسال الدعوة.',
  revoke: 'إلغاء',
  expires: 'تنتهي في',
  noInvitations: 'لا توجد دعوات بعد.',

  acceptTitle: 'الانضمام إلى مؤسسة',
  acceptSubtitle: 'لقد تمت دعوتك إلى بال‌سيرت.',
  acceptInvitation: 'قبول الدعوة',
  acceptRegisterFirst: 'أنشئ حسابًا بالبريد الإلكتروني المدعو، ثم عد إلى هذا الرابط.',
  acceptedMessage: 'لقد انضممت إلى المؤسسة.',

  verificationTitle: 'التحقق',
  verificationSemantics:
    'يؤكد تحقق بال‌سيرت أن هوية المؤسسة وحسابها اجتازا عملية التحقق لدى بال‌سيرت. وهو ليس ' +
    'تقييمًا للجودة الأكاديمية أو صحة البحث أو المعايير التحريرية.',
  requestVerification: 'طلب التحقق',
  verificationNote: 'أي معلومات ترغب بإطلاع بال‌سيرت عليها (اختياري)',
  verificationRequested: 'طلب التحقق قيد المراجعة لدى فريق بال‌سيرت.',
  verificationReason: 'السبب',
  verifiedBadge: 'مؤسسة موثّقة',

  confirmSuspend: 'هل تريد إيقاف وصول هذا العضو إلى المؤسسة؟',
  confirmRemove: 'هل تريد إزالة هذا العضو من المؤسسة؟',
  cancel: 'إلغاء',
  confirm: 'تأكيد',

  typeLabels: {
    UNIVERSITY: 'جامعة',
    SCIENTIFIC_JOURNAL: 'مجلة علمية',
    PUBLISHER: 'دار نشر',
    RESEARCH_INSTITUTION: 'مؤسسة بحثية',
    GOVERNMENT: 'جهة حكومية',
    COMPANY: 'شركة',
    OTHER: 'أخرى',
  },
  roleLabels: {
    ORGANIZATION_OWNER: 'مالك',
    ORGANIZATION_ADMIN: 'مدير',
    ORGANIZATION_REVIEWER: 'مراجع',
    TEMPLATE_MANAGER: 'مسؤول القوالب',
  },
  statusLabels: {
    ACTIVE: 'نشط',
    SUSPENDED: 'موقوف',
    REMOVED: 'مُزال',
    CLOSED: 'مغلق',
    PENDING: 'قيد الانتظار',
    ACCEPTED: 'مقبولة',
    REVOKED: 'ملغاة',
    EXPIRED: 'منتهية',
  },
  verificationLabels: {
    UNVERIFIED: 'غير موثّقة',
    PENDING: 'قيد المراجعة',
    VERIFIED: 'موثّقة',
    REJECTED: 'غير مقبولة',
  },
  errors: {
    ORGANIZATION_NOT_FOUND: 'هذه المؤسسة غير متاحة لك.',
    ORGANIZATION_ACCESS_DENIED: 'لا تملك صلاحية القيام بذلك في هذه المؤسسة.',
    ORGANIZATION_SUSPENDED: 'هذه المؤسسة موقوفة. يرجى التواصل مع دعم بال‌سيرت.',
    ORGANIZATION_CLOSED: 'تم إغلاق هذه المؤسسة.',
    ORGANIZATION_SLUG_TAKEN: 'هذا المعرّف مستخدم بالفعل.',
    ORGANIZATION_ALREADY_VERIFIED: 'هذه المؤسسة موثّقة بالفعل.',
    ORGANIZATION_VERIFICATION_PENDING: 'هناك طلب تحقق قيد المراجعة بالفعل.',
    MEMBERSHIP_NOT_FOUND: 'تعذّر العثور على هذا العضو.',
    MEMBERSHIP_SUSPENDED: 'وصولك إلى هذه المؤسسة موقوف.',
    MEMBERSHIP_ALREADY_EXISTS: 'هذا الشخص عضو بالفعل.',
    LAST_OWNER_REQUIRED: 'يجب أن يكون لكل مؤسسة مالك واحد على الأقل. انقل الملكية أولاً.',
    INVITATION_NOT_FOUND: 'رابط الدعوة هذا غير صالح.',
    INVITATION_EXPIRED: 'انتهت صلاحية هذه الدعوة. اطلب دعوة جديدة.',
    INVITATION_REVOKED: 'تم سحب هذه الدعوة.',
    INVITATION_ALREADY_USED: 'تم استخدام هذه الدعوة بالفعل.',
    INVITATION_EMAIL_MISMATCH: 'أُرسلت هذه الدعوة إلى بريد إلكتروني آخر.',
    INVITATION_ALREADY_PENDING: 'هناك دعوة قائمة لهذا العنوان بالفعل.',
    ROLE_SCOPE_INVALID: 'لا يمكن منح هذا الدور هنا.',
    TENANT_ACCESS_DENIED: 'لا تملك وصولاً إلى هذه المؤسسة.',
  },
};

export const ORGANIZATION_MESSAGES: Record<Locale, OrganizationMessages> = { en, ar };

export function getOrganizationMessages(locale: Locale): OrganizationMessages {
  return ORGANIZATION_MESSAGES[locale] ?? ORGANIZATION_MESSAGES.en;
}

/** Translate a canonical API enum value, falling back to the raw value. */
export function labelFor(
  labels: Readonly<Record<string, string>>,
  value: string | undefined,
): string {
  if (value === undefined) return '';
  return labels[value] ?? value;
}
