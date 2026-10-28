import { Permission, SELF_SERVICE_PERMISSIONS } from './permissions.js';

/**
 * Capabilities every organization member has, whatever their role.
 * Reading the profile and the member list is the baseline for belonging.
 */
const ORGANIZATION_BASELINE: readonly Permission[] = [
  Permission.ORGANIZATION_PROFILE_READ,
  Permission.ORGANIZATION_MEMBER_READ,
  Permission.ORGANIZATION_VERIFICATION_READ,
  // Reading the organization's standards is part of belonging: a reviewer must
  // be able to see what a submission was judged against. It is strictly read.
  Permission.STANDARD_DOCUMENT_TYPE_READ,
  Permission.STANDARD_READ,
  // Phase 9: seeing what a standard was built from, and what an extraction
  // proposed, is part of reading the standard. Deciding on a proposal is not.
  Permission.STANDARD_SOURCE_READ,
  Permission.STANDARD_EXTRACTION_READ,
  Permission.STANDARD_PROPOSAL_REVIEW,
];

/**
 * Authoring standards: writing them, and putting them into force.
 *
 * `STANDARD_VERSION_PUBLISH` is listed separately from the editing permissions
 * everywhere it is granted, so that an organization can compose a role that
 * writes drafts without releasing them. No role holds publish without also
 * holding edit, but the reverse is expressible — which is the direction that
 * matters.
 */
const STANDARD_AUTHORING: readonly Permission[] = [
  Permission.STANDARD_DOCUMENT_TYPE_MANAGE,
  Permission.STANDARD_CREATE,
  Permission.STANDARD_UPDATE,
  Permission.STANDARD_ARCHIVE,
  Permission.STANDARD_VERSION_CREATE,
  Permission.STANDARD_VERSION_UPDATE,
  Permission.STANDARD_VERSION_ARCHIVE,
  Permission.STANDARD_RULE_WRITE,
  // Phase 9: uploading a guideline, asking PalCert to read it, and turning a
  // proposal into a draft rule are all authoring acts — and all produce draft
  // rules the holder could already have written by hand.
  Permission.STANDARD_SOURCE_CREATE,
  Permission.STANDARD_SOURCE_DELETE,
  Permission.STANDARD_EXTRACTION_RUN,
  Permission.STANDARD_PROPOSAL_DECIDE,
];

/**
 * Reviewing official submissions (Phase 14).
 *
 * Its own bundle because the authority is its own: deciding a student's
 * official submission is unrelated to authoring the standard it was measured
 * against, and TEMPLATE_MANAGER deliberately does not receive it (§55).
 */
const SUBMISSION_REVIEW: readonly Permission[] = [
  Permission.SUBMISSION_READ,
  Permission.SUBMISSION_EVIDENCE_READ,
  Permission.SUBMISSION_DECIDE,
  Permission.SUBMISSION_COMMENT,
  // Seeing that an approval produced a certificate is part of reviewing.
  // Withdrawing one is not, and is bundled separately below (§63).
  Permission.CERTIFICATE_READ,
];

/**
 * Withdrawing a certificate (Phase 15 §63).
 *
 * Its own bundle because it is its own authority. A certificate is the thing
 * a person shows an employer; invalidating one is a heavier act than deciding
 * a submission, and an institution that wants a coordinator to triage
 * submissions has not thereby decided that coordinator may revoke.
 */
const CERTIFICATE_ADMINISTRATION: readonly Permission[] = [Permission.CERTIFICATE_REVOKE];

/**
 * Reviewing certificate attestations: reading the queue, asking questions,
 * rejecting, and approving. A reviewer who decides submissions decides
 * attestations too — both are the institution vouching for what it saw.
 */
const ATTESTATION_REVIEW: readonly Permission[] = [
  Permission.ATTESTATION_REQUEST_READ,
  Permission.ATTESTATION_REQUEST_REVIEW,
  Permission.ATTESTATION_REQUEST_APPROVE,
];

/**
 * Running an institution's attestation service: withdrawing a public
 * attestation, configuring types, setting fees and reading what they earned.
 * Held by owners and admins only, as certificate revocation is.
 */
const ATTESTATION_ADMINISTRATION: readonly Permission[] = [
  Permission.ATTESTATION_RECORD_REVOKE,
  Permission.ATTESTATION_TYPE_MANAGE,
  Permission.ATTESTATION_FEE_MANAGE,
  Permission.ATTESTATION_FINANCE_READ,
];

/** Everything an organization administrator can do short of transferring ownership. */
/**
 * Phase 17 — outbound webhook administration.
 *
 * Kept as its own bundle so that the day an organization wants a role that
 * may read the delivery log without being able to change an endpoint, the
 * split already exists in the catalogue and only the bundle has to change.
 */
const WEBHOOK_ADMINISTRATION: readonly Permission[] = [
  Permission.INTEGRATION_WEBHOOK_READ,
  Permission.INTEGRATION_WEBHOOK_MANAGE,
  Permission.INTEGRATION_WEBHOOK_SECRET_ROTATE,
  Permission.INTEGRATION_WEBHOOK_REPLAY,
];

/**
 * Phase 19 — API-client administration.
 *
 * Its own bundle for the same reason the webhook one is, and with a sharper
 * edge: issuing a secret is the act that creates a durable key to this
 * organization's data, usable without anybody present. An institution that
 * wants an administrator to see which integrations exist has not thereby
 * decided that administrator may mint a new one, so the read and the issue
 * permissions are separate rows even though this bundle currently holds both.
 */
const API_CLIENT_ADMINISTRATION: readonly Permission[] = [
  Permission.INTEGRATION_API_CLIENT_READ,
  Permission.INTEGRATION_API_CLIENT_MANAGE,
  Permission.INTEGRATION_API_CLIENT_SECRET_ISSUE,
];

const ORGANIZATION_ADMINISTRATION: readonly Permission[] = [
  ...ORGANIZATION_BASELINE,
  Permission.ORGANIZATION_PROFILE_UPDATE,
  Permission.ORGANIZATION_MEMBER_INVITE,
  Permission.ORGANIZATION_MEMBER_UPDATE,
  Permission.ORGANIZATION_MEMBER_REMOVE,
  Permission.ORGANIZATION_ROLE_ASSIGN,
  Permission.ORGANIZATION_ROLE_REMOVE,
  Permission.ORGANIZATION_VERIFICATION_REQUEST,
  ...STANDARD_AUTHORING,
  Permission.STANDARD_VERSION_PUBLISH,
  // Exposing a standard to people outside the organization is an
  // organization-level act, so it sits with administration rather than with
  // rule authoring (§17).
  Permission.STANDARD_CHECK_AVAILABILITY_MANAGE,
  // Committing the organization to external AI processing of its own documents
  // is an organization-level act, deliberately not an authoring one: a template
  // manager doing their job must not be able to accept those terms for the
  // institution (Phase 9 §16).
  Permission.ORGANIZATION_AI_CONSENT_MANAGE,
  // An owner or admin can always review submissions: somebody has to be able
  // to, and an organization with no reviewer appointed yet would otherwise
  // have a queue nobody can open.
  ...SUBMISSION_REVIEW,
  ...CERTIFICATE_ADMINISTRATION,
  ...ATTESTATION_REVIEW,
  ...ATTESTATION_ADMINISTRATION,
  // Phase 17 — pointing the organization's events at an external system is an
  // administrative act, not a reviewing or authoring one. A reviewer deciding
  // submissions must not be able to redirect where those decisions are
  // announced, and a template manager authoring rules has no business minting
  // a signing secret. Granted here and nowhere else.
  ...WEBHOOK_ADMINISTRATION,
  // Phase 19 — issuing a machine credential is administration for the same
  // reason: it decides what can read this organization's data without a person
  // present. A reviewer must not be able to mint one, and neither must a
  // template manager.
  ...API_CLIENT_ADMINISTRATION,
  // Payouts (ADR-0150): seeing what the organization earned and what was paid
  // out is administration; requesting a payout is the owner's alone.
  Permission.ORGANIZATION_WITHDRAWAL_READ,
  Permission.ORGANIZATION_PAYOUT_DESTINATION_READ,
];

/**
 * Role scope.
 *
 * `GLOBAL` roles apply platform-wide. `ORGANIZATION` roles are meaningful only
 * in combination with an organization, which Phase 2 introduces: their
 * definitions exist now so the catalogue is complete and the assignment table
 * is shaped correctly, but they can never be granted globally (enforced by the
 * RBAC service and by a database constraint).
 */
export const RoleScope = {
  GLOBAL: 'GLOBAL',
  ORGANIZATION: 'ORGANIZATION',
} as const;

export type RoleScope = (typeof RoleScope)[keyof typeof RoleScope];

export const RoleCode = {
  // Global customer roles
  STUDENT: 'STUDENT',
  SERVICE_USER: 'SERVICE_USER',

  // Organization-scoped roles (assignable from Phase 2 only)
  ORGANIZATION_OWNER: 'ORGANIZATION_OWNER',
  ORGANIZATION_ADMIN: 'ORGANIZATION_ADMIN',
  ORGANIZATION_REVIEWER: 'ORGANIZATION_REVIEWER',
  TEMPLATE_MANAGER: 'TEMPLATE_MANAGER',

  // Global PalCert staff roles
  PALCERT_ADMIN: 'PALCERT_ADMIN',
  PALCERT_FINANCE: 'PALCERT_FINANCE',
  PALCERT_SUPPORT: 'PALCERT_SUPPORT',
  PALCERT_AUDITOR: 'PALCERT_AUDITOR',

  // Integration role (credentials issued in a later phase)
  API_CLIENT: 'API_CLIENT',
} as const;

export type RoleCode = (typeof RoleCode)[keyof typeof RoleCode];

export interface RoleDefinition {
  readonly code: RoleCode;
  readonly scope: RoleScope;
  readonly description: string;
  /** Privileged roles must complete MFA before the session reaches AAL2. */
  readonly requiresMfa: boolean;
  readonly permissions: readonly Permission[];
}

/**
 * The authoritative role catalogue. Seeded into the database by migration and
 * reconciled at boot, so the code and the database can never disagree.
 *
 * Each phase grants a role only powers over entities that already exist: Phase
 * 2 gave the organization roles their tenant capabilities, Phase 3 their
 * standards-authoring ones.
 */
export const ROLE_DEFINITIONS: readonly RoleDefinition[] = [
  {
    code: RoleCode.STUDENT,
    scope: RoleScope.GLOBAL,
    description: 'A student submitting academic documents for compliance checking.',
    requiresMfa: false,
    permissions: SELF_SERVICE_PERMISSIONS,
  },
  {
    code: RoleCode.SERVICE_USER,
    scope: RoleScope.GLOBAL,
    description: 'A general PalCert customer. Default role on self-registration.',
    requiresMfa: false,
    permissions: SELF_SERVICE_PERMISSIONS,
  },
  {
    code: RoleCode.ORGANIZATION_OWNER,
    scope: RoleScope.ORGANIZATION,
    description:
      'Owns an organization tenant. The only organization role that may transfer ' +
      'ownership or grant the owner role.',
    requiresMfa: false,
    permissions: [
      ...ORGANIZATION_ADMINISTRATION,
      Permission.ORGANIZATION_OWNERSHIP_TRANSFER,
      // Payouts (ADR-0150): only the owner may ask PalCert to pay out the
      // organization's earnings, or decide where they are sent. Deliberately
      // not part of ORGANIZATION_ADMINISTRATION: an admin manages members,
      // not the institution's money. The permissions are ordinary rows, so a
      // later governance decision can grant them to another role without a
      // code path that names a role.
      Permission.ORGANIZATION_WITHDRAWAL_REQUEST,
      Permission.ORGANIZATION_PAYOUT_DESTINATION_MANAGE,
    ],
  },
  {
    code: RoleCode.ORGANIZATION_ADMIN,
    scope: RoleScope.ORGANIZATION,
    description:
      'Administers an organization tenant: profile, members, invitations and ' +
      'organization roles. Cannot transfer ownership.',
    requiresMfa: false,
    permissions: ORGANIZATION_ADMINISTRATION,
  },
  {
    code: RoleCode.ORGANIZATION_REVIEWER,
    scope: RoleScope.ORGANIZATION,
    description:
      'Reviews official submissions: reads the queue, opens the submitted ' +
      'document and its report, decides, and comments. Reads the ' +
      'organization\u2019s standards so a submission can be judged against them, ' +
      'but may never edit one, and holds no authority over members.',
    requiresMfa: false,
    permissions: [...ORGANIZATION_BASELINE, ...SUBMISSION_REVIEW, ...ATTESTATION_REVIEW],
  },
  {
    code: RoleCode.TEMPLATE_MANAGER,
    scope: RoleScope.ORGANIZATION,
    description:
      'Authors the organization\u2019s document types, standards and rules, and ' +
      'publishes standard versions. Holds no authority over members or the ' +
      'organization profile.',
    requiresMfa: false,
    permissions: [
      ...ORGANIZATION_BASELINE,
      ...STANDARD_AUTHORING,
      Permission.STANDARD_VERSION_PUBLISH,
    ],
  },
  {
    code: RoleCode.PALCERT_ADMIN,
    scope: RoleScope.GLOBAL,
    description: 'PalCert platform administrator.',
    requiresMfa: true,
    permissions: [
      ...SELF_SERVICE_PERMISSIONS,
      Permission.ADMIN_USER_READ,
      Permission.ADMIN_USER_SUSPEND,
      Permission.ADMIN_USER_REACTIVATE,
      Permission.ADMIN_ROLE_ASSIGN,
      Permission.ADMIN_ROLE_REMOVE,
      Permission.ADMIN_SESSION_REVOKE,
      Permission.ADMIN_ORGANIZATION_READ,
      Permission.ADMIN_ORGANIZATION_VERIFY,
      Permission.ADMIN_ORGANIZATION_SUSPEND,
      Permission.AUDIT_READ,
      // Phase 10: an administrator can see what PalCert charges and what a
      // payment did, and still cannot refund or adjust a balance. Moving money
      // is finance's job, and separating the two is the point of having both.
      Permission.PRICING_PRICE_READ,
      Permission.FINANCE_PAYMENT_READ,
      Permission.FINANCE_LEDGER_READ,
      Permission.FINANCE_PURCHASE_READ,
      // Attestation: administrators support institutions and set the platform
      // commission each one carries.
      Permission.ADMIN_ATTESTATION_READ,
      Permission.ADMIN_ATTESTATION_COMMISSION_MANAGE,
      Permission.ADMIN_REVENUE_SHARE_MANAGE,
      Permission.ADMIN_ATTESTATION_FINANCE_READ,
      Permission.ADMIN_REVENUE_SHARE_READ,
      Permission.ADMIN_EMAIL_SETTINGS_READ,
      Permission.ADMIN_EMAIL_SETTINGS_MANAGE,
      Permission.ADMIN_EMAIL_SETTINGS_TEST,
      Permission.ADMIN_EMAIL_DELIVERY_READ,
      // Manual top-ups: an administrator publishes where people send money
      // and can see the queue, and still cannot approve one. Approving is the
      // act that creates credit, and that stays finance's (separation of
      // duties). A deployment that wants one person to do both assigns that
      // person PALCERT_FINANCE as well, explicitly.
      Permission.ADMIN_PAYMENT_METHOD_READ,
      Permission.ADMIN_PAYMENT_METHOD_MANAGE,
      Permission.FINANCE_MANUAL_TOPUP_READ,
      // Withdrawals: an administrator configures clearing periods, limits and
      // who reviews, and can read the queue. Approving and paying out are
      // finance's; PALCERT_ADMIN is not automatically finance.
      Permission.FINANCE_WITHDRAWAL_READ,
      Permission.ADMIN_WITHDRAWAL_POLICY_MANAGE,
    ],
  },
  {
    code: RoleCode.PALCERT_FINANCE,
    scope: RoleScope.GLOBAL,
    description:
      'PalCert finance staff. Sets prices, refunds payments and makes audited ' +
      'balance adjustments. Cannot edit or delete a ledger entry — corrections ' +
      'are compensating entries (Phase 10 §77).',
    requiresMfa: true,
    permissions: [
      ...SELF_SERVICE_PERMISSIONS,
      Permission.ADMIN_USER_READ,
      Permission.ADMIN_ORGANIZATION_READ,
      Permission.PRICING_PRICE_READ,
      Permission.PRICING_PRICE_CREATE,
      Permission.PRICING_PRICE_ACTIVATE,
      Permission.FINANCE_PAYMENT_READ,
      Permission.FINANCE_LEDGER_READ,
      Permission.FINANCE_REFUND_CREATE,
      Permission.FINANCE_ADJUSTMENT_CREATE,
      Permission.FINANCE_PURCHASE_READ,
      Permission.ADMIN_ATTESTATION_COMMISSION_MANAGE,
      Permission.ADMIN_ATTESTATION_FINANCE_READ,
      Permission.ADMIN_REVENUE_SHARE_READ,
      // Manual top-ups: finance verifies a reported transfer and decides it.
      // It reads the methods it is matching against but does not edit them.
      Permission.ADMIN_PAYMENT_METHOD_READ,
      Permission.FINANCE_MANUAL_TOPUP_READ,
      Permission.FINANCE_MANUAL_TOPUP_REVIEW,
      Permission.FINANCE_MANUAL_TOPUP_APPROVE,
      Permission.FINANCE_MANUAL_TOPUP_REJECT,
      // Withdrawals: finance reviews, approves and records payouts, and may ask
      // for a platform payout. The service still refuses anyone acting on a
      // request they made, and for platform money requires three different
      // people to request, approve and execute.
      Permission.FINANCE_WITHDRAWAL_READ,
      Permission.FINANCE_WITHDRAWAL_REVIEW,
      Permission.FINANCE_WITHDRAWAL_APPROVE,
      Permission.FINANCE_WITHDRAWAL_EXECUTE,
      Permission.FINANCE_PLATFORM_WITHDRAWAL_REQUEST,
      Permission.FINANCE_PAYOUT_DESTINATION_READ,
      Permission.FINANCE_PAYOUT_DESTINATION_MANAGE,
    ],
  },
  {
    code: RoleCode.PALCERT_SUPPORT,
    scope: RoleScope.GLOBAL,
    description:
      'PalCert support staff. Deliberately cannot assign roles or suspend accounts — ' +
      'support must not be a path to administrator. Sees payment status to answer ' +
      '“where is my top-up?”, and can move no money at all (Phase 10 §78).',
    requiresMfa: false,
    permissions: [
      ...SELF_SERVICE_PERMISSIONS,
      Permission.ADMIN_USER_READ,
      Permission.ADMIN_ORGANIZATION_READ,
      // Read-only, and deliberately not FINANCE_LEDGER_READ: knowing a top-up
      // succeeded answers the support question; the ledger is finance's.
      Permission.FINANCE_PAYMENT_READ,
      // Phase 11: "was I charged for that check?" is the other question
      // support is actually asked. Reading the answer is not authority to
      // change it, and support has none of the mutation permissions (§130).
      Permission.FINANCE_PURCHASE_READ,
    ],
  },
  {
    code: RoleCode.PALCERT_AUDITOR,
    scope: RoleScope.GLOBAL,
    description: 'Read-only access to audit records.',
    requiresMfa: true,
    permissions: [
      ...SELF_SERVICE_PERMISSIONS,
      Permission.AUDIT_READ,
      Permission.ADMIN_USER_READ,
      Permission.ADMIN_ORGANIZATION_READ,
      // An auditor who cannot read the ledger cannot audit the ledger.
      Permission.PRICING_PRICE_READ,
      Permission.FINANCE_PAYMENT_READ,
      Permission.FINANCE_LEDGER_READ,
      Permission.FINANCE_PURCHASE_READ,
      Permission.ADMIN_ATTESTATION_FINANCE_READ,
      Permission.ADMIN_REVENUE_SHARE_READ,
      // Read-only, and never the credential: the auditor sees that a provider
      // is configured and what was sent, not how to send.
      Permission.ADMIN_EMAIL_SETTINGS_READ,
      Permission.ADMIN_EMAIL_DELIVERY_READ,
      // Read-only: the auditor sees every manual top-up and the methods, and
      // can neither review, decide nor configure.
      Permission.ADMIN_PAYMENT_METHOD_READ,
      Permission.FINANCE_MANUAL_TOPUP_READ,
      // Read-only: every withdrawal and the masked treasury destinations.
      Permission.FINANCE_WITHDRAWAL_READ,
      Permission.FINANCE_PAYOUT_DESTINATION_READ,
    ],
  },
  {
    code: RoleCode.API_CLIENT,
    scope: RoleScope.GLOBAL,
    description:
      'Machine integration identity. Holds no permissions and never will: an API client is ' +
      'authorized by scopes against a named allow-list, not by this role.',
    requiresMfa: false,
    // Phase 19 deliberately leaves this empty.
    //
    // The tempting implementation was to give the role the organization's
    // rights and let the existing guards do the work. That would have made
    // every route a machine could reach a function of what a *person* may do
    // there, so adding a human capability would silently widen machine access
    // — the exact failure the allow-list exists to prevent. A client's
    // authority comes from its scopes and from an operation naming itself;
    // this role is only the principal's type.
    permissions: [],
  },
] as const;

const ROLE_BY_CODE = new Map<string, RoleDefinition>(
  ROLE_DEFINITIONS.map((definition) => [definition.code, definition]),
);

export function getRoleDefinition(code: string): RoleDefinition | undefined {
  return ROLE_BY_CODE.get(code);
}

export function isGlobalRole(code: string): boolean {
  return getRoleDefinition(code)?.scope === RoleScope.GLOBAL;
}

/** The role granted automatically on self-registration (§8: no org roles). */
export const DEFAULT_REGISTRATION_ROLE: RoleCode = RoleCode.SERVICE_USER;

/**
 * Roles that may never be granted through the public role-assignment API
 * without the actor already holding administrator rights. Used to make the
 * escalation rule explicit rather than implied.
 */
export const PRIVILEGED_ROLES: readonly RoleCode[] = [
  RoleCode.PALCERT_ADMIN,
  RoleCode.PALCERT_FINANCE,
  RoleCode.PALCERT_SUPPORT,
  RoleCode.PALCERT_AUDITOR,
];

export function roleRequiresMfa(code: string): boolean {
  return getRoleDefinition(code)?.requiresMfa ?? false;
}
