/**
 * PalCert permission catalogue.
 *
 * Naming convention (documented in docs/architecture/rbac.md):
 *
 *     <domain>:<resource>[:<sub-resource>]:<action>[:<scope>]
 *
 * A sub-resource appears only where one capability inside a resource must be
 * grantable separately (`integration:webhook:secret:rotate`); the RBAC test
 * enumerates the permissions that use it.
 *
 * `scope` is `self` when the permission only covers the acting user's own
 * records, and omitted when the permission is unscoped (an administrative
 * capability). Organization-scoped permissions arrive in Phase 2 and reuse this
 * same catalogue — scoping is expressed by the role assignment, not by a
 * separate permission name.
 *
 * Authorization is always evaluated against permissions, never against role
 * names, so adding a role never requires touching a guard.
 */
export const Permission = {
  // --- Self-service --------------------------------------------------------
  PROFILE_READ_SELF: 'profile:read:self',
  PROFILE_UPDATE_SELF: 'profile:update:self',
  SESSION_READ_SELF: 'session:read:self',
  SESSION_REVOKE_SELF: 'session:revoke:self',
  // Phase 5 — a person's private documents. Self-scoped: ownership, not an
  // organization role, is what authorizes every document action.
  DOCUMENT_READ_SELF: 'document:read:self',
  DOCUMENT_WRITE_SELF: 'document:write:self',
  DOCUMENT_DOWNLOAD_SELF: 'document:download:self',
  DOCUMENT_DELETE_SELF: 'document:delete:self',
  /** Phase 7: a user's own checks and their reports. */
  CHECK_READ_SELF: 'check:read:self',
  CHECK_CREATE_SELF: 'check:create:self',
  /**
   * Phase 12 — correcting a document of your own.
   *
   * Split from the check permissions on purpose. Planning a correction is
   * free and reads a check; buying one spends money and rewrites the
   * document, and a role that may read results is not automatically a role
   * that may change files.
   */
  SMARTFIX_READ_SELF: 'smartfix:read:self',
  SMARTFIX_CREATE_SELF: 'smartfix:create:self',
  /**
   * Phase 14 — submitting a check of your own to an institution.
   *
   * Separate from every check permission, because submitting is not reading a
   * result: it is the act of sharing one, and nothing else in PalCert shares
   * anything (§20). Self-scoped, and held by ordinary users rather than by any
   * organization role — no membership is required to submit (§17).
   */
  SUBMISSION_READ_SELF: 'submission:read:self',
  SUBMISSION_CREATE_SELF: 'submission:create:self',
  /**
   * Phase 15 — a certificate for a submission of your own.
   *
   * Read and download only. Nobody asks PalCert for a certificate: it follows
   * from the institution approving a compliant submission, and there is no
   * route by which a person could request one for themselves (§190, §191).
   */
  CERTIFICATE_READ_SELF: 'certificate:read:self',
  /**
   * Phase 16 — your own notification inbox and your own email preferences.
   *
   * Self-scoped in the strictest sense in PalCert: a notification is one
   * person's copy of an event, and no organization role and no reviewer
   * reaches another member's inbox. The preference is separate from the read
   * because turning workflow email off is a change to what PalCert sends on
   * your behalf, not a way of reading what it already sent.
   */
  NOTIFICATION_READ_SELF: 'notification:read:self',
  NOTIFICATION_WRITE_SELF: 'notification:write:self',
  NOTIFICATION_PREFERENCE_WRITE_SELF: 'notification:preference:write:self',
  /** Read your own AI reviews. */
  AI_REVIEW_READ_SELF: 'ai-review:read:self',
  /** Start an AI review of your own check, and grant the consent it needs. */
  AI_REVIEW_CREATE_SELF: 'ai-review:create:self',
  /**
   * Phase 10 — a person's own PalCert Balance.
   *
   * Self-scoped like documents and checks, and for the same reason: money a
   * customer added is theirs, and no organization role reaches it (§79).
   * Reading and topping up are separate so a future read-only integration is
   * expressible.
   */
  /**
   * Certificate attestation — asking an institution to attest a certificate
   * you already hold, and reading your own requests and attestations.
   * Self-scoped: no membership is needed to ask, as with submissions.
   */
  ATTESTATION_SUBMIT_SELF: 'attestation:submit:self',
  ATTESTATION_READ_SELF: 'attestation:read:self',
  BALANCE_READ_SELF: 'balance:read:self',
  BALANCE_TOPUP_SELF: 'balance:topup:self',
  /**
   * Withdrawals (ADR-0150): request a payout of your own eligible real money
   * and manage your own payout destinations. Withdrawability is decided by
   * the conservative policy, not by this permission.
   */
  BALANCE_WITHDRAW_SELF: 'balance:withdraw:self',
  PASSWORD_CHANGE_SELF: 'password:change:self',
  MFA_MANAGE_SELF: 'mfa:manage:self',

  // --- PalCert administration ---------------------------------------------
  ADMIN_USER_READ: 'admin:user:read',
  ADMIN_USER_SUSPEND: 'admin:user:suspend',
  ADMIN_USER_REACTIVATE: 'admin:user:reactivate',
  ADMIN_ROLE_ASSIGN: 'admin:role:assign',
  ADMIN_ROLE_REMOVE: 'admin:role:remove',
  ADMIN_SESSION_REVOKE: 'admin:session:revoke',

  // --- Organization-scoped (Phase 2) ---------------------------------------
  // These are evaluated against the caller's roles *within one organization*,
  // never globally. Holding them in Organization A grants nothing in B.
  ORGANIZATION_PROFILE_READ: 'organization:profile:read',
  ORGANIZATION_PROFILE_UPDATE: 'organization:profile:update',
  ORGANIZATION_MEMBER_READ: 'organization:member:read',
  ORGANIZATION_MEMBER_INVITE: 'organization:member:invite',
  ORGANIZATION_MEMBER_UPDATE: 'organization:member:update',
  ORGANIZATION_MEMBER_REMOVE: 'organization:member:remove',
  ORGANIZATION_ROLE_ASSIGN: 'organization:role:assign',
  ORGANIZATION_ROLE_REMOVE: 'organization:role:remove',
  ORGANIZATION_VERIFICATION_REQUEST: 'organization:verification:request',
  ORGANIZATION_VERIFICATION_READ: 'organization:verification:read',
  ORGANIZATION_OWNERSHIP_TRANSFER: 'organization:ownership:transfer',

  // --- Standards, versions and rules (Phase 3) -----------------------------
  // Organization-scoped. `publish` is deliberately separate from `update`:
  // authoring a standard and putting it into force are different acts with
  // different consequences, and an organization must be able to grant one
  // without the other.
  STANDARD_DOCUMENT_TYPE_READ: 'standard:document-type:read',
  STANDARD_DOCUMENT_TYPE_MANAGE: 'standard:document-type:manage',
  STANDARD_READ: 'standard:definition:read',
  STANDARD_CREATE: 'standard:definition:create',
  STANDARD_UPDATE: 'standard:definition:update',
  STANDARD_ARCHIVE: 'standard:definition:archive',
  STANDARD_VERSION_CREATE: 'standard:version:create',
  STANDARD_VERSION_UPDATE: 'standard:version:update',
  STANDARD_VERSION_PUBLISH: 'standard:version:publish',
  STANDARD_VERSION_ARCHIVE: 'standard:version:archive',
  STANDARD_RULE_WRITE: 'standard:rule:write',
  /**
   * Expose a standard to people outside the organization (§17).
   *
   * Deliberately separate from rule authoring: a template manager may write
   * every rule in a standard without being the person who decides the world
   * may check documents against it.
   */
  STANDARD_CHECK_AVAILABILITY_MANAGE: 'standard:check-availability:manage',

  // --- Guideline sources and rule extraction (Phase 9) ---------------------
  // Organization-scoped. Uploading a guideline, asking PalCert to read it, and
  // deciding that what it found becomes a rule are three different acts, so
  // they are three different permissions.
  STANDARD_SOURCE_READ: 'standard:source:read',
  STANDARD_SOURCE_CREATE: 'standard:source:create',
  STANDARD_SOURCE_DELETE: 'standard:source:delete',
  STANDARD_EXTRACTION_READ: 'standard:extraction:read',
  STANDARD_EXTRACTION_RUN: 'standard:extraction:run',
  STANDARD_PROPOSAL_REVIEW: 'standard:proposal:review',
  /**
   * Turn a proposal into a draft rule.
   *
   * Separate from `review` because reading what the AI suggested and putting it
   * into the institution's standard are different acts — and separate from
   * `publish`, which remains the Phase 3 permission nothing here touches (§73).
   */
  STANDARD_PROPOSAL_DECIDE: 'standard:proposal:decide',
  /**
   * Agree, on the organization's behalf, that its documents may be sent to an
   * external AI provider.
   *
   * Deliberately its own permission and granted only to owners and admins: a
   * template manager doing their job should not be able to accept external
   * data-processing terms for the whole institution (§16).
   */
  ORGANIZATION_AI_CONSENT_MANAGE: 'organization:ai-consent:manage',

  // --- Official submissions (Phase 14) -------------------------------------
  // Organization-scoped, and deliberately four permissions rather than one.
  // Reading a submission, opening its document, deciding it, and writing to
  // the author are different authorities: an institution must be able to let
  // a coordinator triage a queue without letting them approve a thesis.
  //
  // None of these is granted to TEMPLATE_MANAGER. Writing the rules a document
  // is measured against and deciding a student's submission are different
  // jobs, and the person who holds one does not automatically hold the other
  // (§55).
  /** See the queue and one submission's metadata and technical result. */
  SUBMISSION_READ: 'submission:review:read',
  /** Open the submitted document and its report snapshot. */
  SUBMISSION_EVIDENCE_READ: 'submission:evidence:read',
  /** Start a review, approve, reject or request a revision. */
  SUBMISSION_DECIDE: 'submission:decision:write',
  /** Write a review comment the author will read. */
  SUBMISSION_COMMENT: 'submission:comment:write',

  // --- Certificates (Phase 15) ---------------------------------------------
  //
  // Reading a certificate and withdrawing one are different authorities, and
  // the split matters: a coordinator who can see that a certificate exists is
  // not thereby somebody who can invalidate it. Revocation is deliberately
  // withheld from ORGANIZATION_REVIEWER and TEMPLATE_MANAGER (§63).
  /** See the certificates issued for this organization's approvals. */
  CERTIFICATE_READ: 'certificate:record:read',
  /** Withdraw a certificate. Never granted by default to a reviewer. */
  CERTIFICATE_REVOKE: 'certificate:revocation:write',

  // --- Certificate attestation ---------------------------------------------
  //
  // Organization-scoped, and split where the consequences differ. Reading the
  // queue is triage. Reviewing asks questions and may reject. Approving puts
  // PalCert's name next to the institution's on a public verification page
  // and settles money, so it is separate. Revoking withdraws a public
  // attestation and is withheld from reviewers, as certificate revocation is.
  // Configuring types and setting fees are separate again: the person who
  // writes the instructions need not be the person who sets the price.
  ATTESTATION_REQUEST_READ: 'attestation:request:read',
  ATTESTATION_REQUEST_REVIEW: 'attestation:request:review',
  ATTESTATION_REQUEST_APPROVE: 'attestation:request:approve',
  ATTESTATION_RECORD_REVOKE: 'attestation:record:revoke',
  ATTESTATION_TYPE_MANAGE: 'attestation:type:manage',
  ATTESTATION_FEE_MANAGE: 'attestation:fee:manage',
  ATTESTATION_FINANCE_READ: 'attestation:finance:read',

  // --- PalCert administration over organizations ---------------------------
  ADMIN_ORGANIZATION_READ: 'admin:organization:read',
  ADMIN_ORGANIZATION_VERIFY: 'admin:organization:verify',
  ADMIN_ORGANIZATION_SUSPEND: 'admin:organization:suspend',

  // --- Audit ---------------------------------------------------------------
  AUDIT_READ: 'audit:event:read',

  // --- Phase 10: pricing and finance --------------------------------------
  //
  // Pricing belongs to PalCert globally, never to an organization (§24, §107),
  // so these are platform permissions with no organization-scoped counterpart.
  // Creating a price and putting it into force are separate: preparing next
  // year's price should not require the authority to charge it today.
  PRICING_PRICE_READ: 'pricing:price:read',
  PRICING_PRICE_CREATE: 'pricing:price:create',
  PRICING_PRICE_ACTIVATE: 'pricing:price:activate',

  /** Read a customer's payments and top-ups for support and reconciliation. */
  FINANCE_PAYMENT_READ: 'finance:payment:read',
  /** Read the ledger behind a balance. */
  FINANCE_LEDGER_READ: 'finance:ledger:read',
  /** Send money back through the payment provider. */
  FINANCE_REFUND_CREATE: 'finance:refund:create',
  /** Credit or debit a balance directly, with a reason and an audit trail. */
  FINANCE_ADJUSTMENT_CREATE: 'finance:adjustment:create',

  /**
   * Read what a customer bought and how it was funded (Phase 11 §131).
   *
   * Read-only on purpose and separate from every mutation: answering "was this
   * check charged?" is a support and reconciliation question, and needs none
   * of the authority to change the answer.
   */
  FINANCE_PURCHASE_READ: 'finance:purchase:read',

  // --- Certificate attestation, platform side -------------------------------
  //
  // PalCert's commission is set per institution by PalCert, never by the
  // institution, and changing it is separate from reading what it produced.
  /** Read any organization's attestation requests and records, for support. */
  ADMIN_ATTESTATION_READ: 'admin:attestation:read',
  /** Set the platform commission an institution's attestation fees carry. */
  ADMIN_ATTESTATION_COMMISSION_MANAGE: 'admin:attestation-commission:manage',
  /** Read platform-wide attestation revenue and the split behind it. */
  ADMIN_ATTESTATION_FINANCE_READ: 'admin:attestation-finance:read',

  // --- Transactional email provider, platform side -------------------------
  //
  // Reading the configuration, changing it, sending a test message and reading
  // delivery history are four separate decisions. None of them ever reveals
  // the provider credential: it can be replaced, never read back.
  /** Read the email provider configuration (never the credential). */
  ADMIN_EMAIL_SETTINGS_READ: 'admin:email-settings:read',
  /** Change the email provider configuration, including its credential. */
  ADMIN_EMAIL_SETTINGS_MANAGE: 'admin:email-settings:manage',
  /** Send a configuration test message to an address the administrator names. */
  ADMIN_EMAIL_SETTINGS_TEST: 'admin:email-settings:test',
  /** Read outbound email delivery history (never message bodies). */
  ADMIN_EMAIL_DELIVERY_READ: 'admin:email-delivery:read',

  // --- Manual top-ups --------------------------------------------------------
  //
  // Configuring where people send money and deciding that money arrived are
  // different authorities, held by different roles. A platform administrator
  // can publish a bank account and read the queue; only finance can approve,
  // which is the act that creates credit. Reviewing, approving and rejecting
  // are separate so that a deployment can give a trainee the queue without
  // the authority to move money.
  /** Read the configured manual payment methods, enabled or not. */
  ADMIN_PAYMENT_METHOD_READ: 'admin:payment-method:read',
  /** Create, edit, enable, disable and archive manual payment methods. */
  ADMIN_PAYMENT_METHOD_MANAGE: 'admin:payment-method:manage',
  /** Read manual top-up requests, their receipts and their history. */
  FINANCE_MANUAL_TOPUP_READ: 'finance:manual-topup:read',
  /** Open a manual top-up for review, which ends the owner's right to cancel it. */
  FINANCE_MANUAL_TOPUP_REVIEW: 'finance:manual-topup:review',
  /** Approve a manual top-up, crediting the customer's cash balance. */
  FINANCE_MANUAL_TOPUP_APPROVE: 'finance:manual-topup:approve',
  /** Reject a manual top-up with a stated reason. Moves no money. */
  FINANCE_MANUAL_TOPUP_REJECT: 'finance:manual-topup:reject',

  // --- Withdrawals and payouts (ADR-0150) ----------------------------------
  //
  // Viewing is not approving, and approving is not executing. Each act is its
  // own permission so a deployment can separate them across people, and the
  // service additionally refuses a person acting on their own request.
  /** Read every withdrawal request, its timeline and its masked destination. */
  FINANCE_WITHDRAWAL_READ: 'finance:withdrawal:read',
  /** Open a request for review, read its full destination, receive alerts. */
  FINANCE_WITHDRAWAL_REVIEW: 'finance:withdrawal:review',
  /** Approve or reject a withdrawal request (never one's own). */
  FINANCE_WITHDRAWAL_APPROVE: 'finance:withdrawal:approve',
  /** Record the external transfer: start, mark paid, mark failed, retry, release. */
  FINANCE_WITHDRAWAL_EXECUTE: 'finance:withdrawal:execute',
  /** Request a payout of PalCert's own realized platform revenue. */
  FINANCE_PLATFORM_WITHDRAWAL_REQUEST: 'finance:platform-withdrawal:request',
  /** Read PalCert treasury payout destinations (masked). */
  FINANCE_PAYOUT_DESTINATION_READ: 'finance:payout-destination:read',
  /** Create, edit and archive PalCert treasury payout destinations. */
  FINANCE_PAYOUT_DESTINATION_MANAGE: 'finance:payout-destination:manage',
  /** Configure withdrawal clearing periods, limits and the reviewer list. */
  ADMIN_WITHDRAWAL_POLICY_MANAGE: 'admin:withdrawal-policy:manage',

  // --- Organization payouts (ADR-0150) -------------------------------------
  /** Read the organization's earnings, payout availability and payout history. */
  ORGANIZATION_WITHDRAWAL_READ: 'organization:withdrawal:read',
  /** Request a payout of the organization's settled net earnings. */
  ORGANIZATION_WITHDRAWAL_REQUEST: 'organization:withdrawal:request',
  /** Read the organization's payout destinations (masked). */
  ORGANIZATION_PAYOUT_DESTINATION_READ: 'organization:payout-destination:read',
  /** Create, edit and archive the organization's payout destinations. */
  ORGANIZATION_PAYOUT_DESTINATION_MANAGE: 'organization:payout-destination:manage',

  // --- Phase 17: outbound webhooks ----------------------------------------
  //
  // Organization-scoped. An integration is a decision about where one
  // institution's events are sent, and it is nobody else's to make.
  //
  // Four permissions rather than one, because the four acts have genuinely
  // different consequences. Reading the delivery log is a support activity.
  // Managing an endpoint changes where events go. Rotating the secret mints a
  // credential and is the one act that returns one. Replaying re-sends past
  // events, which a receiver may act on a second time.
  INTEGRATION_WEBHOOK_READ: 'integration:webhook:read',
  INTEGRATION_WEBHOOK_MANAGE: 'integration:webhook:manage',
  INTEGRATION_WEBHOOK_SECRET_ROTATE: 'integration:webhook:secret:rotate',
  INTEGRATION_WEBHOOK_REPLAY: 'integration:webhook:replay',

  // --- Phase 19: API clients ----------------------------------------------
  //
  // Organization-scoped, for the same reason the webhook permissions are: a
  // machine credential is a key to one institution's data and it is nobody
  // else's to issue.
  //
  // Three rather than one, split where the consequences differ. Reading the
  // list is an inventory question an auditor asks. Managing a client changes
  // what a machine may reach. Minting a credential is the one act that returns
  // a secret, and it is separated so that "who can see our integrations?" and
  // "who can create a key to our data?" are different answers — the second is
  // the one an organization owner may want to keep to themselves.
  INTEGRATION_API_CLIENT_READ: 'integration:api-client:read',
  INTEGRATION_API_CLIENT_MANAGE: 'integration:api-client:manage',
  INTEGRATION_API_CLIENT_SECRET_ISSUE: 'integration:api-client:secret:issue',
} as const;

export type Permission = (typeof Permission)[keyof typeof Permission];

export const ALL_PERMISSIONS: readonly Permission[] = Object.values(Permission);

/** Permissions granted to every authenticated, fully-established session. */
/**
 * Permissions that are only ever meaningful inside an organization.
 *
 * The tenant guard evaluates these against the caller's roles in the resolved
 * organization; the global permissions guard never sees them, so an
 * organization role can never leak platform-wide authority.
 */
export const ORGANIZATION_SCOPED_PERMISSIONS: readonly string[] = [
  'organization:profile:read',
  'organization:profile:update',
  'organization:member:read',
  'organization:member:invite',
  'organization:member:update',
  'organization:member:remove',
  'organization:role:assign',
  'organization:role:remove',
  'organization:verification:request',
  'organization:verification:read',
  'organization:ownership:transfer',

  // Phase 3 — standards authoring is a tenant capability, never a platform one.
  'standard:document-type:read',
  'standard:document-type:manage',
  'standard:definition:read',
  'standard:definition:create',
  'standard:definition:update',
  'standard:definition:archive',
  'standard:version:create',
  'standard:version:update',
  'standard:version:publish',
  'standard:version:archive',
  'standard:rule:write',

  // Phase 7 — publishing a standard to the public check catalogue is a
  // decision about the organization's own standard, never platform authority.
  'standard:check-availability:manage',

  // Phase 9 — guideline sources, extraction and proposal review are all
  // decisions about the organization's own standards.
  'standard:source:read',
  'standard:source:create',
  'standard:source:delete',
  'standard:extraction:read',
  'standard:extraction:run',
  'standard:proposal:review',
  'standard:proposal:decide',
  'organization:ai-consent:manage',

  // Phase 14 — reviewing an official submission is an act of the organization
  // that received it. None of these is ever held globally: holding them in
  // University A grants nothing at University B, which is what stops one
  // institution reading another's submissions.
  'submission:review:read',
  'submission:evidence:read',
  'submission:decision:write',
  'submission:comment:write',

  // Phase 15 — a certificate belongs to the approval that produced it, so the
  // authority over it is the receiving organization's and nobody else's.
  'certificate:record:read',
  'certificate:revocation:write',

  // Certificate attestation — the receiving institution's authority, and
  // never a platform one: holding it at University A reaches nothing at B.
  'attestation:request:read',
  'attestation:request:review',
  'attestation:request:approve',
  'attestation:record:revoke',
  'attestation:type:manage',
  'attestation:fee:manage',
  'attestation:finance:read',

  // Phase 17 — an outbound integration belongs to the organization whose
  // events it projects. Never global: holding it at University A must not
  // let anyone point University B's events anywhere.
  'integration:webhook:read',
  'integration:webhook:manage',
  'integration:webhook:secret:rotate',
  'integration:webhook:replay',

  // Phase 19 — a machine credential is a key to one organization's data.
  // Never global: holding it at University A must not let anyone mint a
  // credential that reads University B.
  'integration:api-client:read',
  'integration:api-client:manage',
  'integration:api-client:secret:issue',

  // Withdrawals (ADR-0150) — an organization's earnings and where they are
  // paid out are that organization's alone. Holding these at University A
  // reaches nothing at University B.
  'organization:withdrawal:read',
  'organization:withdrawal:request',
  'organization:payout-destination:read',
  'organization:payout-destination:manage',
];

export function isOrganizationScopedPermission(permission: string): boolean {
  return ORGANIZATION_SCOPED_PERMISSIONS.includes(permission);
}

export const SELF_SERVICE_PERMISSIONS: readonly Permission[] = [
  Permission.PROFILE_READ_SELF,
  Permission.PROFILE_UPDATE_SELF,
  Permission.SESSION_READ_SELF,
  Permission.SESSION_REVOKE_SELF,
  Permission.PASSWORD_CHANGE_SELF,
  Permission.MFA_MANAGE_SELF,
  Permission.DOCUMENT_READ_SELF,
  Permission.DOCUMENT_WRITE_SELF,
  Permission.DOCUMENT_DOWNLOAD_SELF,
  Permission.DOCUMENT_DELETE_SELF,
  Permission.CHECK_READ_SELF,
  Permission.CHECK_CREATE_SELF,
  Permission.SMARTFIX_READ_SELF,
  Permission.SMARTFIX_CREATE_SELF,
  Permission.SUBMISSION_READ_SELF,
  Permission.SUBMISSION_CREATE_SELF,
  Permission.CERTIFICATE_READ_SELF,
  Permission.ATTESTATION_SUBMIT_SELF,
  Permission.ATTESTATION_READ_SELF,
  Permission.NOTIFICATION_READ_SELF,
  Permission.NOTIFICATION_WRITE_SELF,
  Permission.NOTIFICATION_PREFERENCE_WRITE_SELF,
  Permission.AI_REVIEW_READ_SELF,
  Permission.AI_REVIEW_CREATE_SELF,
  Permission.BALANCE_READ_SELF,
  Permission.BALANCE_TOPUP_SELF,
  Permission.BALANCE_WITHDRAW_SELF,
];
