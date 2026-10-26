/**
 * Stable, client-safe PalCert application error codes (Master Prompt §47).
 *
 * These codes are part of the public API contract: they are returned verbatim to
 * clients and may be relied upon by integrations. Never rename an existing code —
 * add a new one and deprecate the old one instead.
 */
export const PalCertErrorCode = {
  // --- Generic / transport -------------------------------------------------
  VALIDATION_FAILED: 'VALIDATION_FAILED',
  NOT_FOUND: 'NOT_FOUND',
  CONFLICT: 'CONFLICT',
  RATE_LIMITED: 'RATE_LIMITED',
  INTERNAL_ERROR: 'INTERNAL_ERROR',
  SERVICE_UNAVAILABLE: 'SERVICE_UNAVAILABLE',

  // --- Auth / access -------------------------------------------------------
  UNAUTHENTICATED: 'UNAUTHENTICATED',
  FORBIDDEN: 'FORBIDDEN',
  TENANT_ACCESS_DENIED: 'TENANT_ACCESS_DENIED',
  PERMISSION_DENIED: 'PERMISSION_DENIED',
  CSRF_INVALID: 'CSRF_INVALID',

  // --- Authentication ------------------------------------------------------
  /**
   * Deliberately single code for "email unknown", "password wrong" and
   * "credentials malformed" so login cannot be used to enumerate accounts.
   */
  AUTHENTICATION_FAILED: 'AUTHENTICATION_FAILED',
  EMAIL_NOT_VERIFIED: 'EMAIL_NOT_VERIFIED',
  ACCOUNT_SUSPENDED: 'ACCOUNT_SUSPENDED',
  ACCOUNT_DISABLED: 'ACCOUNT_DISABLED',
  REAUTHENTICATION_REQUIRED: 'REAUTHENTICATION_REQUIRED',

  // --- Sessions ------------------------------------------------------------
  SESSION_EXPIRED: 'SESSION_EXPIRED',
  SESSION_REVOKED: 'SESSION_REVOKED',

  // --- Credential tokens ---------------------------------------------------
  VERIFICATION_TOKEN_INVALID: 'VERIFICATION_TOKEN_INVALID',
  VERIFICATION_TOKEN_EXPIRED: 'VERIFICATION_TOKEN_EXPIRED',
  PASSWORD_RESET_TOKEN_INVALID: 'PASSWORD_RESET_TOKEN_INVALID',
  PASSWORD_RESET_TOKEN_EXPIRED: 'PASSWORD_RESET_TOKEN_EXPIRED',
  PASSWORD_POLICY_VIOLATION: 'PASSWORD_POLICY_VIOLATION',

  // --- Multi-factor authentication -----------------------------------------
  MFA_REQUIRED: 'MFA_REQUIRED',
  MFA_INVALID: 'MFA_INVALID',
  MFA_ENROLLMENT_REQUIRED: 'MFA_ENROLLMENT_REQUIRED',
  MFA_ALREADY_ENROLLED: 'MFA_ALREADY_ENROLLED',

  // --- Organizations and tenancy (Phase 2) ---------------------------------
  /**
   * Returned when the caller has no valid standing in the organization — and
   * deliberately also when the organization does not exist at all, so a caller
   * cannot use the difference to discover which organization IDs are real.
   */
  ORGANIZATION_NOT_FOUND: 'ORGANIZATION_NOT_FOUND',
  ORGANIZATION_ACCESS_DENIED: 'ORGANIZATION_ACCESS_DENIED',
  ORGANIZATION_SUSPENDED: 'ORGANIZATION_SUSPENDED',
  ORGANIZATION_CLOSED: 'ORGANIZATION_CLOSED',
  ORGANIZATION_SLUG_TAKEN: 'ORGANIZATION_SLUG_TAKEN',
  ORGANIZATION_ALREADY_VERIFIED: 'ORGANIZATION_ALREADY_VERIFIED',
  ORGANIZATION_VERIFICATION_PENDING: 'ORGANIZATION_VERIFICATION_PENDING',

  MEMBERSHIP_NOT_FOUND: 'MEMBERSHIP_NOT_FOUND',
  MEMBERSHIP_SUSPENDED: 'MEMBERSHIP_SUSPENDED',
  MEMBERSHIP_ALREADY_EXISTS: 'MEMBERSHIP_ALREADY_EXISTS',
  LAST_OWNER_REQUIRED: 'LAST_OWNER_REQUIRED',

  INVITATION_NOT_FOUND: 'INVITATION_NOT_FOUND',
  INVITATION_EXPIRED: 'INVITATION_EXPIRED',
  INVITATION_REVOKED: 'INVITATION_REVOKED',
  INVITATION_ALREADY_USED: 'INVITATION_ALREADY_USED',
  INVITATION_EMAIL_MISMATCH: 'INVITATION_EMAIL_MISMATCH',
  INVITATION_ALREADY_PENDING: 'INVITATION_ALREADY_PENDING',

  ROLE_SCOPE_INVALID: 'ROLE_SCOPE_INVALID',

  // --- Documents -----------------------------------------------------------
  INVALID_DOCUMENT: 'INVALID_DOCUMENT',
  UNSUPPORTED_DOCUMENT: 'UNSUPPORTED_DOCUMENT',
  DOCUMENT_NOT_FOUND: 'DOCUMENT_NOT_FOUND',
  /** The document exists for the caller but the action is not permitted on it. */
  DOCUMENT_ACCESS_DENIED: 'DOCUMENT_ACCESS_DENIED',
  /** Soft-deleted; awaiting physical deletion. */
  DOCUMENT_DELETED: 'DOCUMENT_DELETED',
  DOCUMENT_VERSION_NOT_FOUND: 'DOCUMENT_VERSION_NOT_FOUND',
  /** The version has not reached READY, so there is nothing safe to download. */
  DOCUMENT_NOT_READY: 'DOCUMENT_NOT_READY',
  /** Only a FAILED version whose staged object still exists can be retried. */
  DOCUMENT_VERSION_NOT_RETRYABLE: 'DOCUMENT_VERSION_NOT_RETRYABLE',
  DOWNLOAD_NOT_AVAILABLE: 'DOWNLOAD_NOT_AVAILABLE',

  // --- Document analysis (Phase 6) -----------------------------------------
  /** No compatible analysis exists and none could be produced. */
  DOCX_ANALYSIS_NOT_AVAILABLE: 'DOCX_ANALYSIS_NOT_AVAILABLE',
  /** An analysis for this version and analyzer version is already running. */
  DOCX_ANALYSIS_ALREADY_RUNNING: 'DOCX_ANALYSIS_ALREADY_RUNNING',
  /** The analyzer refuses a version that is not a READY DOCX. */
  DOCX_ANALYSIS_UNSUPPORTED_FORMAT: 'DOCX_ANALYSIS_UNSUPPORTED_FORMAT',
  /** The stored object no longer matches the version's recorded digest (§5). */
  DOCX_SOURCE_INTEGRITY_FAILED: 'DOCX_SOURCE_INTEGRITY_FAILED',
  /** Analysis ran and could not complete. */
  DOCX_ANALYSIS_FAILED: 'DOCX_ANALYSIS_FAILED',

  // --- Document checks (Phase 7) -------------------------------------------
  CHECK_NOT_FOUND: 'CHECK_NOT_FOUND',
  CHECK_ACCESS_DENIED: 'CHECK_ACCESS_DENIED',
  CHECK_ALREADY_COMPLETED: 'CHECK_ALREADY_COMPLETED',
  CHECK_NOT_RETRYABLE: 'CHECK_NOT_RETRYABLE',
  /** The chosen version is not a READY document. */
  CHECK_DOCUMENT_NOT_READY: 'CHECK_DOCUMENT_NOT_READY',
  /** The version's format has no analyzer at all. */
  CHECK_DOCUMENT_FORMAT_UNSUPPORTED: 'CHECK_DOCUMENT_FORMAT_UNSUPPORTED',
  /**
   * The standard's rules ask nothing this format can answer (Phase 13 §66).
   *
   * Refused before payment rather than taken and returned as a report of
   * INDETERMINATE findings. Charging for a check that could never produce a
   * single verdict is the thing this code exists to prevent; a standard with
   * *partial* coverage is still sold, with the gap shown in the preview.
   */
  CHECK_STANDARD_NOT_SUPPORTED_FOR_FORMAT: 'CHECK_STANDARD_NOT_SUPPORTED_FOR_FORMAT',

  // --- Official submissions (Phase 14) -------------------------------------
  /** No such submission, or none the caller may see. Never 403 (ADR-0017). */
  SUBMISSION_NOT_FOUND: 'SUBMISSION_NOT_FOUND',
  SUBMISSION_REVISION_NOT_FOUND: 'SUBMISSION_REVISION_NOT_FOUND',
  /** Only a completed check with a verified report may be handed over. */
  SUBMISSION_CHECK_NOT_COMPLETED: 'SUBMISSION_CHECK_NOT_COMPLETED',
  /** The check was run against a different organization's standard (§15). */
  SUBMISSION_ORGANIZATION_MISMATCH: 'SUBMISSION_ORGANIZATION_MISMATCH',
  /** The new revision's check is about a different logical document (§9). */
  SUBMISSION_DOCUMENT_MISMATCH: 'SUBMISSION_DOCUMENT_MISMATCH',
  /** The revision's snapshot is still preparing, or failed (§130). */
  SUBMISSION_NOT_READY: 'SUBMISSION_NOT_READY',
  /** The requested decision is not reachable from the current one (§46). */
  SUBMISSION_INVALID_TRANSITION: 'SUBMISSION_INVALID_TRANSITION',
  /** Another reviewer already decided this revision (§72). */
  SUBMISSION_ALREADY_DECIDED: 'SUBMISSION_ALREADY_DECIDED',
  /** The revision moved under the caller: they were acting on stale state. */
  SUBMISSION_REVISION_CONFLICT: 'SUBMISSION_REVISION_CONFLICT',
  /** A new revision is allowed only after REVISION_REQUESTED (§49). */
  SUBMISSION_RESUBMISSION_NOT_ALLOWED: 'SUBMISSION_RESUBMISSION_NOT_ALLOWED',
  /** This check was already handed over as a revision of this case (§95). */
  SUBMISSION_CHECK_ALREADY_SUBMITTED: 'SUBMISSION_CHECK_ALREADY_SUBMITTED',
  /** A rejection or revision request must say why (§70). */
  SUBMISSION_COMMENT_REQUIRED: 'SUBMISSION_COMMENT_REQUIRED',
  /** The organization is no longer eligible to receive submissions (§18). */
  SUBMISSION_ORGANIZATION_NOT_ELIGIBLE: 'SUBMISSION_ORGANIZATION_NOT_ELIGIBLE',
  /** Preparation could not complete; nothing was officially handed over. */
  SUBMISSION_PREPARATION_FAILED: 'SUBMISSION_PREPARATION_FAILED',

  /** The standard is not published for public checks, or its owner is not eligible. */
  CHECK_STANDARD_NOT_AVAILABLE: 'CHECK_STANDARD_NOT_AVAILABLE',
  CHECK_STANDARD_NOT_PUBLISHED: 'CHECK_STANDARD_NOT_PUBLISHED',
  /** The stored snapshot did not hash to the version's recorded contentHash. */
  STANDARD_SNAPSHOT_INTEGRITY_FAILED: 'STANDARD_SNAPSHOT_INTEGRITY_FAILED',
  ANALYSIS_ARTIFACT_INTEGRITY_FAILED: 'ANALYSIS_ARTIFACT_INTEGRITY_FAILED',
  CHECK_EVALUATION_FAILED: 'CHECK_EVALUATION_FAILED',
  CHECK_REPORT_GENERATION_FAILED: 'CHECK_REPORT_GENERATION_FAILED',
  REPORT_NOT_FOUND: 'REPORT_NOT_FOUND',

  // --- AI review (Phase 8) ---------------------------------------------------
  /** The platform is not configured to offer AI review at all. */
  AI_DISABLED: 'AI_DISABLED',
  /** The user has not agreed to external AI processing of their document. */
  AI_CONSENT_REQUIRED: 'AI_CONSENT_REQUIRED',
  AI_REVIEW_NOT_FOUND: 'AI_REVIEW_NOT_FOUND',
  /** The check has not completed, so there is no report to supplement. */
  AI_REVIEW_CHECK_NOT_COMPLETED: 'AI_REVIEW_CHECK_NOT_COMPLETED',
  /** No AI-assisted rule in this standard, so there is nothing to assess. */
  AI_REVIEW_NO_ASSESSABLE_RULES: 'AI_REVIEW_NO_ASSESSABLE_RULES',
  AI_REVIEW_ALREADY_RUNNING: 'AI_REVIEW_ALREADY_RUNNING',
  AI_REVIEW_NOT_CANCELLABLE: 'AI_REVIEW_NOT_CANCELLABLE',
  AI_REVIEW_NOT_RETRYABLE: 'AI_REVIEW_NOT_RETRYABLE',
  /** The Phase 7 evidence this review would rest on no longer verifies. */
  AI_EVIDENCE_INTEGRITY_FAILED: 'AI_EVIDENCE_INTEGRITY_FAILED',

  // --- Guideline sources and rule extraction (Phase 9) ---------------------
  STANDARD_SOURCE_NOT_FOUND: 'STANDARD_SOURCE_NOT_FOUND',
  /** Sources attach to a draft. A published version is history (§7, §72). */
  STANDARD_SOURCE_VERSION_NOT_DRAFT: 'STANDARD_SOURCE_VERSION_NOT_DRAFT',
  STANDARD_SOURCE_NOT_READY: 'STANDARD_SOURCE_NOT_READY',
  /** Accepted-rule provenance depends on this source, so it stays (§101). */
  STANDARD_SOURCE_RETENTION_LOCKED: 'STANDARD_SOURCE_RETENTION_LOCKED',
  STANDARD_SOURCE_LIMIT_EXCEEDED: 'STANDARD_SOURCE_LIMIT_EXCEEDED',
  /** The organization has not agreed to external AI processing (§17). */
  ORGANIZATION_AI_CONSENT_REQUIRED: 'ORGANIZATION_AI_CONSENT_REQUIRED',
  EXTRACTION_RUN_NOT_FOUND: 'EXTRACTION_RUN_NOT_FOUND',
  EXTRACTION_NO_USABLE_SOURCES: 'EXTRACTION_NO_USABLE_SOURCES',
  EXTRACTION_ALREADY_RUNNING: 'EXTRACTION_ALREADY_RUNNING',
  EXTRACTION_NOT_CANCELLABLE: 'EXTRACTION_NOT_CANCELLABLE',
  /** A source is larger than the provider or the configuration allows (§89). */
  EXTRACTION_SOURCE_TOO_LARGE: 'EXTRACTION_SOURCE_TOO_LARGE',
  RULE_PROPOSAL_NOT_FOUND: 'RULE_PROPOSAL_NOT_FOUND',
  /** Someone already accepted or rejected it; decisions are not revised (§66). */
  RULE_PROPOSAL_ALREADY_DECIDED: 'RULE_PROPOSAL_ALREADY_DECIDED',
  /** Ambiguous, conflicting, unrepresentable or invalid — not acceptable (§74). */
  RULE_PROPOSAL_NOT_ACCEPTABLE: 'RULE_PROPOSAL_NOT_ACCEPTABLE',
  /** The draft moved under the reviewer; they reload and decide again (§71). */
  STALE_STANDARD_REVISION: 'STALE_STANDARD_REVISION',

  // --- Uploads (Phase 5) ---------------------------------------------------
  UPLOAD_SESSION_NOT_FOUND: 'UPLOAD_SESSION_NOT_FOUND',
  UPLOAD_SESSION_EXPIRED: 'UPLOAD_SESSION_EXPIRED',
  UPLOAD_SESSION_CANCELLED: 'UPLOAD_SESSION_CANCELLED',
  UPLOAD_ALREADY_FINALIZED: 'UPLOAD_ALREADY_FINALIZED',
  /** Finalize was called but nothing has been uploaded to the staged key yet. */
  UPLOAD_OBJECT_NOT_FOUND: 'UPLOAD_OBJECT_NOT_FOUND',
  /** The staged object's size differs from what the authorization was issued for. */
  UPLOAD_SIZE_MISMATCH: 'UPLOAD_SIZE_MISMATCH',
  /** An `Idempotency-Key` was reused with a different request body. */
  IDEMPOTENCY_KEY_REUSED: 'IDEMPOTENCY_KEY_REUSED',

  // --- File validation (Phase 5) — also the version rejection codes ---------
  FILE_TOO_LARGE: 'FILE_TOO_LARGE',
  FILE_EMPTY: 'FILE_EMPTY',
  FILE_EXTENSION_UNSUPPORTED: 'FILE_EXTENSION_UNSUPPORTED',
  FILE_TYPE_UNSUPPORTED: 'FILE_TYPE_UNSUPPORTED',
  FILE_TYPE_MISMATCH: 'FILE_TYPE_MISMATCH',
  FILE_CONTAINER_INVALID: 'FILE_CONTAINER_INVALID',
  FILE_ARCHIVE_UNSAFE: 'FILE_ARCHIVE_UNSAFE',
  FILE_MACRO_UNSUPPORTED: 'FILE_MACRO_UNSUPPORTED',
  FILE_EMBEDDED_OBJECT_UNSUPPORTED: 'FILE_EMBEDDED_OBJECT_UNSUPPORTED',
  FILE_EXTERNAL_CONTENT_UNSUPPORTED: 'FILE_EXTERNAL_CONTENT_UNSUPPORTED',
  FILE_MALWARE_DETECTED: 'FILE_MALWARE_DETECTED',
  FILE_CHECKSUM_MISMATCH: 'FILE_CHECKSUM_MISMATCH',
  FILE_SCAN_TEMPORARILY_UNAVAILABLE: 'FILE_SCAN_TEMPORARILY_UNAVAILABLE',
  FILE_PROCESSING_FAILED: 'FILE_PROCESSING_FAILED',
  STORAGE_UNAVAILABLE: 'STORAGE_UNAVAILABLE',

  // --- Document types (Phase 3) --------------------------------------------
  DOCUMENT_TYPE_NOT_FOUND: 'DOCUMENT_TYPE_NOT_FOUND',
  DOCUMENT_TYPE_NAME_TAKEN: 'DOCUMENT_TYPE_NAME_TAKEN',
  DOCUMENT_TYPE_ARCHIVED: 'DOCUMENT_TYPE_ARCHIVED',
  /** Refused rather than cascading: standards still point at it. */
  DOCUMENT_TYPE_IN_USE: 'DOCUMENT_TYPE_IN_USE',

  // --- Standards -----------------------------------------------------------
  STANDARD_NOT_FOUND: 'STANDARD_NOT_FOUND',
  STANDARD_CODE_TAKEN: 'STANDARD_CODE_TAKEN',
  STANDARD_ARCHIVED: 'STANDARD_ARCHIVED',

  STANDARD_VERSION_NOT_FOUND: 'STANDARD_VERSION_NOT_FOUND',
  STANDARD_VERSION_LABEL_TAKEN: 'STANDARD_VERSION_LABEL_TAKEN',
  STANDARD_VERSION_ARCHIVED: 'STANDARD_VERSION_ARCHIVED',
  /**
   * The version was replaced by a newer published version. It is immutable
   * history: it cannot be edited, archived or published again. Clone it into a
   * new draft to bring its content back.
   */
  STANDARD_VERSION_SUPERSEDED: 'STANDARD_VERSION_SUPERSEDED',

  // --- Portable standard packages -----------------------------------------
  /** Not a readable PalCert standard package: malformed, wrong shape or format. */
  STANDARD_IMPORT_PACKAGE_INVALID: 'STANDARD_IMPORT_PACKAGE_INVALID',
  STANDARD_IMPORT_PACKAGE_TOO_LARGE: 'STANDARD_IMPORT_PACKAGE_TOO_LARGE',
  /** The contents do not hash to the package's contentHash. */
  STANDARD_IMPORT_INTEGRITY_FAILED: 'STANDARD_IMPORT_INTEGRITY_FAILED',
  /** Written by a newer format, rule schema or canonicalization than this release reads. */
  STANDARD_IMPORT_UNSUPPORTED: 'STANDARD_IMPORT_UNSUPPORTED',
  /** At least one rule fails validation; nothing is imported. */
  STANDARD_IMPORT_RULES_INVALID: 'STANDARD_IMPORT_RULES_INVALID',
  /** The package sent to import is not the one that was previewed. */
  STANDARD_IMPORT_PACKAGE_CHANGED: 'STANDARD_IMPORT_PACKAGE_CHANGED',
  /** The same package was already imported here; re-import must be deliberate. */
  STANDARD_IMPORT_DUPLICATE: 'STANDARD_IMPORT_DUPLICATE',
  /** The chosen standard is for a different kind of document. */
  STANDARD_IMPORT_INCOMPATIBLE: 'STANDARD_IMPORT_INCOMPATIBLE',
  /**
   * The version is PUBLISHED and therefore frozen. Clone it into a new draft
   * instead — editing in place would change what a past result meant.
   */
  STANDARD_VERSION_IMMUTABLE: 'STANDARD_VERSION_IMMUTABLE',
  STANDARD_VERSION_NOT_DRAFT: 'STANDARD_VERSION_NOT_DRAFT',
  /** Optimistic concurrency: the caller's `If-Match` revision is stale. */
  STANDARD_VERSION_CONFLICT: 'STANDARD_VERSION_CONFLICT',
  /** A version with no rules would certify nothing, so it cannot be published. */
  STANDARD_VERSION_EMPTY: 'STANDARD_VERSION_EMPTY',
  /** Draft validation failed; `details.issues` names every offending field. */
  STANDARD_VERSION_INVALID: 'STANDARD_VERSION_INVALID',

  // --- Rules ---------------------------------------------------------------
  RULE_NOT_FOUND: 'RULE_NOT_FOUND',
  RULE_CODE_TAKEN: 'RULE_CODE_TAKEN',
  RULE_SCHEMA_INVALID: 'RULE_SCHEMA_INVALID',
  RULE_OPERATOR_INCOMPATIBLE: 'RULE_OPERATOR_INCOMPATIBLE',
  RULE_SCOPE_INVALID: 'RULE_SCOPE_INVALID',

  // --- Checks / SmartFix ---------------------------------------------------
  CHECK_FAILED: 'CHECK_FAILED',
  SMARTFIX_NOT_AVAILABLE: 'SMARTFIX_NOT_AVAILABLE',
  SMARTFIX_FAILED: 'SMARTFIX_FAILED',

  // --- AI ------------------------------------------------------------------
  /** The provider is unreachable. Never a statement about the document (§105). */
  AI_PROVIDER_UNAVAILABLE: 'AI_PROVIDER_UNAVAILABLE',
  AI_RESPONSE_INVALID: 'AI_RESPONSE_INVALID',

  // --- Billing (Phase 10) ---------------------------------------------------
  /** Available balance, after active holds, is less than the amount asked for. */
  INSUFFICIENT_BALANCE: 'INSUFFICIENT_BALANCE',
  PAYMENT_FAILED: 'PAYMENT_FAILED',
  /** Payments are switched off in this deployment. */
  PAYMENTS_DISABLED: 'PAYMENTS_DISABLED',
  /** The provider could not be reached. Existing balance is unaffected (§111). */
  PAYMENT_PROVIDER_UNAVAILABLE: 'PAYMENT_PROVIDER_UNAVAILABLE',
  /** Not a currency this deployment transacts in. */
  CURRENCY_NOT_SUPPORTED: 'CURRENCY_NOT_SUPPORTED',
  /** Outside the server-controlled top-up bounds (§43). */
  TOPUP_AMOUNT_OUT_OF_RANGE: 'TOPUP_AMOUNT_OUT_OF_RANGE',
  TOPUP_NOT_FOUND: 'TOPUP_NOT_FOUND',
  /** Already settled; there is nothing left to do to it. */
  TOPUP_NOT_PENDING: 'TOPUP_NOT_PENDING',
  CREDIT_HOLD_NOT_FOUND: 'CREDIT_HOLD_NOT_FOUND',
  /** The hold is captured, released or expired; it cannot change again (§21). */
  CREDIT_HOLD_NOT_ACTIVE: 'CREDIT_HOLD_NOT_ACTIVE',
  LEDGER_ENTRY_NOT_FOUND: 'LEDGER_ENTRY_NOT_FOUND',
  /** The entry is not a service charge, so there is no service fee to return. */
  LEDGER_ENTRY_NOT_REFUNDABLE: 'LEDGER_ENTRY_NOT_REFUNDABLE',
  /** Refunding this much would return more than was charged (§67, §74). */
  REFUND_EXCEEDS_REMAINING: 'REFUND_EXCEEDS_REMAINING',
  /** Promotional credit is never withdrawable through the provider (§70). */
  REFUND_NOT_ELIGIBLE: 'REFUND_NOT_ELIGIBLE',
  PAYMENT_REFUND_NOT_FOUND: 'PAYMENT_REFUND_NOT_FOUND',
  /** Provider state and PalCert state disagree; a person must look (§104). */
  RECONCILIATION_REQUIRED: 'RECONCILIATION_REQUIRED',
  /** The provider reported a different amount than PalCert asked for (§56). */
  PAYMENT_AMOUNT_MISMATCH: 'PAYMENT_AMOUNT_MISMATCH',
  /** The provider reported a different currency than PalCert asked for (§57). */
  PAYMENT_CURRENCY_MISMATCH: 'PAYMENT_CURRENCY_MISMATCH',
  /** A webhook did not carry a valid provider signature (§49). */
  WEBHOOK_SIGNATURE_INVALID: 'WEBHOOK_SIGNATURE_INVALID',
  PRICE_NOT_FOUND: 'PRICE_NOT_FOUND',
  /** No active price exists for that product and currency. */
  PRICE_NOT_AVAILABLE: 'PRICE_NOT_AVAILABLE',
  /** An active price's financial fields cannot change; make a new version (§28). */
  PRICE_IMMUTABLE: 'PRICE_IMMUTABLE',
  /** Another active price already covers this product, currency and market (§29). */
  PRICE_ALREADY_ACTIVE: 'PRICE_ALREADY_ACTIVE',
  QUOTE_NOT_FOUND: 'QUOTE_NOT_FOUND',
  QUOTE_EXPIRED: 'QUOTE_EXPIRED',
  SERVICE_PRODUCT_NOT_FOUND: 'SERVICE_PRODUCT_NOT_FOUND',
  /** Catalogued but not sellable in this phase (§25). */
  SERVICE_PRODUCT_NOT_ACTIVE: 'SERVICE_PRODUCT_NOT_ACTIVE',

  // --- Paid services (Phase 11) ---------------------------------------------
  /** A new check must name a price quote; there is no free path any more. */
  PRICE_QUOTE_REQUIRED: 'PRICE_QUOTE_REQUIRED',
  /** That quote has already funded a purchase. A second check needs a second quote. */
  QUOTE_ALREADY_USED: 'QUOTE_ALREADY_USED',
  /** The quote is for a different service than the one being bought. */
  QUOTE_PRODUCT_MISMATCH: 'QUOTE_PRODUCT_MISMATCH',
  SERVICE_PURCHASE_NOT_FOUND: 'SERVICE_PURCHASE_NOT_FOUND',
  /** The reservation timed out before PalCert finished the work (§26). */
  SERVICE_RESERVATION_EXPIRED: 'SERVICE_RESERVATION_EXPIRED',
  /** The service has already been delivered; it is too late to stop it. */
  SERVICE_ALREADY_DELIVERED: 'SERVICE_ALREADY_DELIVERED',
  /** This check is past the point where it can be cancelled. */
  CHECK_NOT_CANCELLABLE: 'CHECK_NOT_CANCELLABLE',
  /**
   * A paid check that failed is not restarted on the old reservation (§47).
   *
   * Nothing was charged; running it again is a new purchase, so the billing
   * history of the first attempt stays exactly as it happened.
   */
  CHECK_RETRY_REQUIRES_NEW_PURCHASE: 'CHECK_RETRY_REQUIRES_NEW_PURCHASE',

  // --- Certificates (Phase 15) ---------------------------------------------
  /**
   * No certificate answers that verification code.
   *
   * Deliberately the same answer for a code that never existed, one still
   * being prepared, and one whose issuance failed (§153, §154, §155). A
   * verifier learns nothing by probing, and an internal failure is nobody
   * else's business.
   */
  CERTIFICATE_NOT_FOUND: 'CERTIFICATE_NOT_FOUND',
  /**
   * Kept from an earlier phase. Public verification does *not* use this:
   * a revoked certificate answers 200 with status REVOKED, because an old QR
   * telling its holder "revoked" is the entire point of online verification
   * (§18, §157).
   */
  CERTIFICATE_REVOKED: 'CERTIFICATE_REVOKED',
  /** The submission has not met COMPLIANT + APPROVED. */
  CERTIFICATE_NOT_ELIGIBLE: 'CERTIFICATE_NOT_ELIGIBLE',
  /** The certificate exists but its artifact is not finalized yet. */
  CERTIFICATE_NOT_ISSUED: 'CERTIFICATE_NOT_ISSUED',
  /** Already withdrawn; Phase 15 has no un-revoke (§69). */
  CERTIFICATE_ALREADY_REVOKED: 'CERTIFICATE_ALREADY_REVOKED',
  /** The evidence behind this certificate did not verify (§85). */
  CERTIFICATE_EVIDENCE_INTEGRITY_FAILED: 'CERTIFICATE_EVIDENCE_INTEGRITY_FAILED',

  // --- Notifications (Phase 16) --------------------------------------------
  /** Somebody else's notification is not found, never forbidden (§165). */
  NOTIFICATION_NOT_FOUND: 'NOTIFICATION_NOT_FOUND',
  /**
   * A revocation email cannot be switched off (§70, §75).
   *
   * Refused with a stable code rather than accepted and quietly ignored: a
   * switch that appears to move and does nothing is worse than one that says
   * no, because the person walks away believing something that is false.
   */
  NOTIFICATION_TYPE_MANDATORY: 'NOTIFICATION_TYPE_MANDATORY',

  // --- Outbound webhooks (Phase 17) ----------------------------------------
  WEBHOOK_ENDPOINT_NOT_FOUND: 'WEBHOOK_ENDPOINT_NOT_FOUND',
  WEBHOOK_DELIVERY_NOT_FOUND: 'WEBHOOK_DELIVERY_NOT_FOUND',
  /**
   * The destination is refused by policy, before any packet is sent.
   *
   * One code for every refusal reason — a private address, a loopback
   * address, a special-purpose registry range, a PalCert host, a disallowed
   * port, a non-HTTPS scheme. The detail goes to the operator in the
   * rejection reason, not into a code an attacker can enumerate to map the
   * network from outside.
   */
  WEBHOOK_URL_NOT_ALLOWED: 'WEBHOOK_URL_NOT_ALLOWED',
  /** An organization may hold only so many endpoints. */
  WEBHOOK_ENDPOINT_LIMIT_REACHED: 'WEBHOOK_ENDPOINT_LIMIT_REACHED',
  /**
   * Somebody else changed the configuration since this screen was loaded.
   *
   * Refused rather than merged: two administrators editing the subscription
   * list are expressing two intentions, and silently keeping the later one
   * would lose the earlier one without either of them being told.
   */
  WEBHOOK_CONFIG_VERSION_CONFLICT: 'WEBHOOK_CONFIG_VERSION_CONFLICT',
  /** The endpoint has not yet proved it will receive what PalCert sends. */
  WEBHOOK_ENDPOINT_NOT_VERIFIED: 'WEBHOOK_ENDPOINT_NOT_VERIFIED',
  /** The endpoint did not answer the verification challenge correctly. */
  WEBHOOK_VERIFICATION_FAILED: 'WEBHOOK_VERIFICATION_FAILED',
  /**
   * The secret was shown once and that window has closed (§ secret handling).
   *
   * Deliberately not "here it is again". PalCert holds only the ciphertext,
   * so this is a statement of fact rather than a policy choice: rotating is
   * the only way to get a secret PalCert can still show.
   */
  WEBHOOK_SECRET_NO_LONGER_RECOVERABLE: 'WEBHOOK_SECRET_NO_LONGER_RECOVERABLE',
  /**
   * The same idempotency key was reused for a different request body.
   *
   * A repeat of the same request is answered with the same result; a
   * different request under the same key is a client bug worth surfacing,
   * because answering it would attribute one outcome to two intentions.
   */
  WEBHOOK_IDEMPOTENCY_KEY_REUSED: 'WEBHOOK_IDEMPOTENCY_KEY_REUSED',
  /**
   * Somebody else's key.
   *
   * Distinguished from reuse because the two mean different things to whoever
   * is debugging: this is two clients sharing a key generator, reuse is one
   * client changing its mind. Answering either with the other's result would
   * attribute one outcome to two intentions.
   */
  WEBHOOK_IDEMPOTENCY_KEY_CONFLICT: 'WEBHOOK_IDEMPOTENCY_KEY_CONFLICT',
  /**
   * The key is still the right key, and the thing it could return is gone.
   *
   * Only a secret-bearing repeat can reach this: the recovery window closed,
   * and PalCert refuses before decrypting anything rather than opening an
   * envelope it has already promised to stop opening.
   */
  WEBHOOK_IDEMPOTENCY_KEY_EXPIRED: 'WEBHOOK_IDEMPOTENCY_KEY_EXPIRED',
  /** A mutating webhook operation must carry one. */
  WEBHOOK_IDEMPOTENCY_KEY_REQUIRED: 'WEBHOOK_IDEMPOTENCY_KEY_REQUIRED',
  /** Only a finished delivery of a still-eligible event can be replayed. */
  WEBHOOK_DELIVERY_NOT_REPLAYABLE: 'WEBHOOK_DELIVERY_NOT_REPLAYABLE',
  /** A control message projects no event, so there is nothing to replay. */
  WEBHOOK_TEST_DELIVERY_NOT_REPLAYABLE: 'WEBHOOK_TEST_DELIVERY_NOT_REPLAYABLE',
  /** The organization turned this integration off; nothing may restart it. */
  WEBHOOK_ENDPOINT_DISABLED: 'WEBHOOK_ENDPOINT_DISABLED',
  /** The lifecycle has no edge from where this endpoint is to where you asked. */
  WEBHOOK_ENDPOINT_TRANSITION_INVALID: 'WEBHOOK_ENDPOINT_TRANSITION_INVALID',
  /** There is nothing waiting to be verified. */
  WEBHOOK_NO_PENDING_CONFIG: 'WEBHOOK_NO_PENDING_CONFIG',
  /** The configuration this operation was about is no longer the one waiting. */
  WEBHOOK_CONFIG_SUPERSEDED: 'WEBHOOK_CONFIG_SUPERSEDED',
  /** Not one of the nine public event types. */
  WEBHOOK_EVENT_TYPE_INVALID: 'WEBHOOK_EVENT_TYPE_INVALID',

  // --- Phase 19: API clients and machine authentication --------------------
  /**
   * A machine credential was presented and did not authenticate.
   *
   * **One code for every cause**, deliberately: no such client id, wrong
   * secret, revoked, disabled, expired, or the organization itself suspended.
   * Splitting them would let an unauthenticated caller enumerate which client
   * ids exist and which organizations are live, by reading the difference
   * between two rejections. The real reason is recorded server-side, where the
   * administrator who needs it can see it and the attacker cannot.
   */
  API_CLIENT_AUTHENTICATION_FAILED: 'API_CLIENT_AUTHENTICATION_FAILED',
  /**
   * The credential is valid and does not hold the scope this operation needs.
   *
   * Distinct from the code above on purpose, and safely so: the caller has
   * already proved it holds a credential, so telling it which scope is missing
   * discloses nothing it could not learn by trying, and saves an integrator a
   * support ticket.
   */
  API_CLIENT_SCOPE_INSUFFICIENT: 'API_CLIENT_SCOPE_INSUFFICIENT',
  /**
   * The route exists and no machine may reach it.
   *
   * Every route is closed to API clients until it names an operation. This is
   * the answer for the rest of PalCert, and it is not a 404: pretending the
   * route does not exist would mislead an integrator reading the same path in
   * the human documentation.
   */
  API_CLIENT_OPERATION_NOT_PERMITTED: 'API_CLIENT_OPERATION_NOT_PERMITTED',
  /** Too many requests on this credential, independently of the caller's IP. */
  API_CLIENT_RATE_LIMITED: 'API_CLIENT_RATE_LIMITED',
  /** No client with this id in this organization. */
  API_CLIENT_NOT_FOUND: 'API_CLIENT_NOT_FOUND',
  /** The organization already holds as many clients as it may. */
  API_CLIENT_LIMIT_REACHED: 'API_CLIENT_LIMIT_REACHED',
  /** Revoked is final: nothing re-enables, rotates or renames it. */
  API_CLIENT_REVOKED: 'API_CLIENT_REVOKED',
  /** The lifecycle has no edge from where this client is to where you asked. */
  API_CLIENT_TRANSITION_INVALID: 'API_CLIENT_TRANSITION_INVALID',
  /** A scope that is not in the published vocabulary. */
  API_CLIENT_SCOPE_INVALID: 'API_CLIENT_SCOPE_INVALID',
  /** A client with no scope could call nothing, so it is refused at creation. */
  API_CLIENT_SCOPES_REQUIRED: 'API_CLIENT_SCOPES_REQUIRED',
  /** A mutating API-client management operation must carry an idempotency key. */
  API_CLIENT_IDEMPOTENCY_KEY_REQUIRED: 'API_CLIENT_IDEMPOTENCY_KEY_REQUIRED',
  /** The same key arrived with a different request. */
  API_CLIENT_IDEMPOTENCY_KEY_CONFLICT: 'API_CLIENT_IDEMPOTENCY_KEY_CONFLICT',
  /**
   * An identical repeat arrived after the show-once recovery window closed.
   *
   * The secret is gone from the operation record by then, and PalCert will not
   * mint a different one for a request that already succeeded.
   */
  API_CLIENT_SECRET_NO_LONGER_RECOVERABLE: 'API_CLIENT_SECRET_NO_LONGER_RECOVERABLE',
  /** A rotation while an overlap is already running would leave three secrets. */
  API_CLIENT_ROTATION_IN_PROGRESS: 'API_CLIENT_ROTATION_IN_PROGRESS',
  /** The requested overlap is longer than the contract allows. */
  API_CLIENT_ROTATION_OVERLAP_TOO_LONG: 'API_CLIENT_ROTATION_OVERLAP_TOO_LONG',
  /** An expiry in the past, or further out than the contract allows. */
  API_CLIENT_EXPIRY_INVALID: 'API_CLIENT_EXPIRY_INVALID',

  // --- Certificate attestation --------------------------------------------
  /** No such attestation type in this organization, or not one you may use. */
  ATTESTATION_TYPE_NOT_FOUND: 'ATTESTATION_TYPE_NOT_FOUND',
  /** The institution is not accepting requests of this type right now. */
  ATTESTATION_TYPE_DISABLED: 'ATTESTATION_TYPE_DISABLED',
  /** An attestation type configuration that PalCert cannot accept. */
  ATTESTATION_TYPE_INVALID: 'ATTESTATION_TYPE_INVALID',
  /** The institution is not verified or not active, so it cannot attest. */
  ATTESTATION_ORGANIZATION_UNAVAILABLE: 'ATTESTATION_ORGANIZATION_UNAVAILABLE',
  /** No such attestation request, or not one you may see. */
  ATTESTATION_REQUEST_NOT_FOUND: 'ATTESTATION_REQUEST_NOT_FOUND',
  /** The request is not in a state that allows this action. */
  ATTESTATION_TRANSITION_INVALID: 'ATTESTATION_TRANSITION_INVALID',
  /** The certificate details are incomplete or malformed. */
  ATTESTATION_METADATA_INVALID: 'ATTESTATION_METADATA_INVALID',
  /** No such uploaded certificate file on this request. */
  ATTESTATION_ARTIFACT_NOT_FOUND: 'ATTESTATION_ARTIFACT_NOT_FOUND',
  /** The certificate file has not finished its security checks. */
  ATTESTATION_ARTIFACT_NOT_READY: 'ATTESTATION_ARTIFACT_NOT_READY',
  /** This attestation type does not accept that kind of file. */
  ATTESTATION_ARTIFACT_TYPE_NOT_ALLOWED: 'ATTESTATION_ARTIFACT_TYPE_NOT_ALLOWED',
  /** The stored certificate file no longer matches its recorded fingerprint. */
  ATTESTATION_ARTIFACT_INTEGRITY_FAILED: 'ATTESTATION_ARTIFACT_INTEGRITY_FAILED',
  /** The validity period is missing, reversed, or not allowed for this type. */
  ATTESTATION_VALIDITY_INVALID: 'ATTESTATION_VALIDITY_INVALID',
  /** The reviewer must explicitly confirm before approving. */
  ATTESTATION_CONFIRMATION_REQUIRED: 'ATTESTATION_CONFIRMATION_REQUIRED',
  /** No attestation matches that verification link. */
  ATTESTATION_NOT_FOUND: 'ATTESTATION_NOT_FOUND',
  /** This attestation has already been revoked. */
  ATTESTATION_ALREADY_REVOKED: 'ATTESTATION_ALREADY_REVOKED',
  /** Too many open attestation requests; wait for some to be decided. */
  ATTESTATION_TOO_MANY_PENDING: 'ATTESTATION_TOO_MANY_PENDING',
  /** A commission must be between 0% and 100%, with at most two decimals. */
  ATTESTATION_COMMISSION_INVALID: 'ATTESTATION_COMMISSION_INVALID',
  // Transactional email provider
  EMAIL_SETTINGS_INVALID: 'EMAIL_SETTINGS_INVALID',
  EMAIL_ENCRYPTION_UNAVAILABLE: 'EMAIL_ENCRYPTION_UNAVAILABLE',
  EMAIL_PROVIDER_NOT_CONFIGURED: 'EMAIL_PROVIDER_NOT_CONFIGURED',
  EMAIL_DELIVERY_NOT_FOUND: 'EMAIL_DELIVERY_NOT_FOUND',
  EMAIL_WEBHOOK_SIGNATURE_INVALID: 'EMAIL_WEBHOOK_SIGNATURE_INVALID',
  // Manual top-ups
  /** No such payment method, or not one the caller may see. */
  MANUAL_PAYMENT_METHOD_NOT_FOUND: 'MANUAL_PAYMENT_METHOD_NOT_FOUND',
  /** The method's details are incomplete or malformed for its type. */
  MANUAL_PAYMENT_METHOD_INVALID: 'MANUAL_PAYMENT_METHOD_INVALID',
  /** Another method already uses that code. */
  MANUAL_PAYMENT_METHOD_CODE_TAKEN: 'MANUAL_PAYMENT_METHOD_CODE_TAKEN',
  /** The method changed since it was read; reload and try again. */
  MANUAL_PAYMENT_METHOD_CONFLICT: 'MANUAL_PAYMENT_METHOD_CONFLICT',
  /** The method is disabled or archived and accepts no new requests. */
  MANUAL_PAYMENT_METHOD_UNAVAILABLE: 'MANUAL_PAYMENT_METHOD_UNAVAILABLE',
  /** A method cannot be offered, or left offered, with no eligible top-up reviewer. */
  MANUAL_PAYMENT_METHOD_REVIEWER_REQUIRED: 'MANUAL_PAYMENT_METHOD_REVIEWER_REQUIRED',
  /** A named reviewer does not hold finance:manual-topup:review through a platform role. */
  MANUAL_PAYMENT_METHOD_REVIEWER_INELIGIBLE: 'MANUAL_PAYMENT_METHOD_REVIEWER_INELIGIBLE',
  /** No such manual top-up, or not one the caller may see. */
  MANUAL_TOPUP_NOT_FOUND: 'MANUAL_TOPUP_NOT_FOUND',
  /** The request is incomplete: an amount and a transfer reference are required. */
  MANUAL_TOPUP_INVALID: 'MANUAL_TOPUP_INVALID',
  /** The amount is outside what this method accepts. */
  MANUAL_TOPUP_AMOUNT_OUT_OF_RANGE: 'MANUAL_TOPUP_AMOUNT_OUT_OF_RANGE',
  /** The transfer reference is not a reference PalCert can match. */
  MANUAL_TOPUP_REFERENCE_INVALID: 'MANUAL_TOPUP_REFERENCE_INVALID',
  /**
   * That reference cannot be used for this method. Deliberately generic: it
   * never says whose request already holds it, or in what state.
   */
  MANUAL_TOPUP_REFERENCE_UNAVAILABLE: 'MANUAL_TOPUP_REFERENCE_UNAVAILABLE',
  /** The request is not in a state that allows that. */
  MANUAL_TOPUP_TRANSITION_INVALID: 'MANUAL_TOPUP_TRANSITION_INVALID',
  /** Another reviewer decided this request first. */
  MANUAL_TOPUP_ALREADY_DECIDED: 'MANUAL_TOPUP_ALREADY_DECIDED',
  /** The reviewer must explicitly confirm the amount before approving. */
  MANUAL_TOPUP_CONFIRMATION_REQUIRED: 'MANUAL_TOPUP_CONFIRMATION_REQUIRED',
  /** Too many open requests; wait for some to be decided. */
  MANUAL_TOPUP_TOO_MANY_OPEN: 'MANUAL_TOPUP_TOO_MANY_OPEN',
  /** No such receipt or logo file. */
  MANUAL_TOPUP_FILE_NOT_FOUND: 'MANUAL_TOPUP_FILE_NOT_FOUND',
  /** The file has not finished its security checks, or did not pass them. */
  MANUAL_TOPUP_FILE_NOT_READY: 'MANUAL_TOPUP_FILE_NOT_READY',
  /** That kind of file is not accepted here. */
  MANUAL_TOPUP_FILE_TYPE_NOT_ALLOWED: 'MANUAL_TOPUP_FILE_TYPE_NOT_ALLOWED',
  /** No such withdrawal, or not one the caller may see. */
  WITHDRAWAL_NOT_FOUND: 'WITHDRAWAL_NOT_FOUND',
  /** The withdrawal request is incomplete or malformed. */
  WITHDRAWAL_INVALID: 'WITHDRAWAL_INVALID',
  /** The amount is below the minimum or above the maximum for its currency. */
  WITHDRAWAL_AMOUNT_OUT_OF_RANGE: 'WITHDRAWAL_AMOUNT_OUT_OF_RANGE',
  /** The amount is more than is currently withdrawable. */
  WITHDRAWAL_EXCEEDS_AVAILABLE: 'WITHDRAWAL_EXCEEDS_AVAILABLE',
  /** The withdrawal is not in a state that allows that. */
  WITHDRAWAL_TRANSITION_INVALID: 'WITHDRAWAL_TRANSITION_INVALID',
  /** Somebody else acted on this withdrawal first. */
  WITHDRAWAL_ALREADY_DECIDED: 'WITHDRAWAL_ALREADY_DECIDED',
  /** The withdrawal changed since it was read; reload and try again. */
  WITHDRAWAL_CONFLICT: 'WITHDRAWAL_CONFLICT',
  /** Separation of duties forbids this person from performing this step. */
  WITHDRAWAL_SEPARATION_OF_DUTIES: 'WITHDRAWAL_SEPARATION_OF_DUTIES',
  /** An external transfer reference is required before a payout is marked paid. */
  WITHDRAWAL_REFERENCE_REQUIRED: 'WITHDRAWAL_REFERENCE_REQUIRED',
  /** The exact amount and currency must be confirmed. */
  WITHDRAWAL_CONFIRMATION_REQUIRED: 'WITHDRAWAL_CONFIRMATION_REQUIRED',
  /** Too many open withdrawals; wait for some to finish. */
  WITHDRAWAL_TOO_MANY_OPEN: 'WITHDRAWAL_TOO_MANY_OPEN',
  /** No such payout proof. */
  WITHDRAWAL_PROOF_NOT_FOUND: 'WITHDRAWAL_PROOF_NOT_FOUND',
  /** The payout proof has not finished its security checks, or did not pass them. */
  WITHDRAWAL_PROOF_NOT_READY: 'WITHDRAWAL_PROOF_NOT_READY',
  /** No such payout destination, or not one the caller may use. */
  PAYOUT_DESTINATION_NOT_FOUND: 'PAYOUT_DESTINATION_NOT_FOUND',
  /** The payout destination is incomplete or malformed. */
  PAYOUT_DESTINATION_INVALID: 'PAYOUT_DESTINATION_INVALID',
  /** The destination changed since it was read; reload and try again. */
  PAYOUT_DESTINATION_CONFLICT: 'PAYOUT_DESTINATION_CONFLICT',
  /** The destination is archived and cannot be used or changed. */
  PAYOUT_DESTINATION_ARCHIVED: 'PAYOUT_DESTINATION_ARCHIVED',
  /** Payout destinations cannot be stored because their encryption key is not configured. */
  PAYOUT_DESTINATION_ENCRYPTION_UNAVAILABLE: 'PAYOUT_DESTINATION_ENCRYPTION_UNAVAILABLE',
} as const;

export type PalCertErrorCode = (typeof PalCertErrorCode)[keyof typeof PalCertErrorCode];

export const ALL_ERROR_CODES: readonly PalCertErrorCode[] = Object.values(PalCertErrorCode);
