import { Prisma, PrismaClient } from '../generated/client';

export { Prisma, PrismaClient };

/**
 * Model row types, re-exported so application code can type a value without
 * reaching into the generated client's path directly.
 */
export type {
  AuditEvent,
  AppMetadata,
  EmailVerificationToken,
  MfaAuthenticator,
  MfaRecoveryCode,
  PasswordResetToken,
  Permission as PermissionRow,
  Role,
  RolePermission,
  SecurityEvent,
  Session,
  User,
  UserRole,
  DocumentType,
  Standard,
  StandardVersion,
  StandardVersionImport,
  AttestationType,
  OrganizationAttestationCommission,
  AttestationRequest,
  AttestationArtifact,
  AttestationRequestEvent,
  Attestation,
  AttestationSettlement,
  AttestationRevenueEntry,
  AttestationReminder,
  ManualPaymentMethod,
  ManualPaymentMethodLogo,
  ManualPaymentMethodReviewer,
  ManualTopUpRequest,
  ManualTopUpReceipt,
  ManualTopUpRequestEvent,
  PayoutDestination,
  WithdrawalAccount,
  WithdrawalCurrencyLimit,
  WithdrawalExecutionAttempt,
  WithdrawalPolicy,
  WithdrawalProof,
  WithdrawalRequest,
  WithdrawalRequestEvent,
  WithdrawalReservation,
  WithdrawalReviewer,
  WithdrawalSettlement,
  StandardRule,
  StandardVersionSnapshot,
  Organization,
  OrganizationMembership,
  OrganizationInvitation,
  OrganizationVerificationRequest,
  Document,
  DocumentVersion,
  UploadSession,
  ProcessingJob,
  DocumentRetentionLock,
  DocumentAnalysis,
  DocumentCheck,
  CheckRun,
  CheckRuleResult,
  CheckViolation,
  CheckReport,
  AIConsent,
  AIReview,
  AIInvocation,
  AIRuleAssessment,
  AIReportSupplement,
  StandardSourceAsset,
  OrganizationAIConsent,
  RuleExtractionRun,
  RuleExtractionRunSource,
  ExtractionInvocation,
  SourceEvidence,
  TemplateObservation,
  RuleProposal,
  RuleProposalEvidence,
  RuleProposalDecision,
  StandardRuleProvenance,
  SmartFixPlan,
  SmartFixRequest,
  SmartFixManifest,
  OfficialSubmission,
  SubmissionRevision,
  SubmissionDecisionEvent,
  SubmissionComment,
  ComplianceCertificate,
  CertificateEvent,
  DomainEvent,
  UserNotification,
  NotificationDelivery,
  NotificationDeliveryAttempt,
  NotificationPreference,
  PlatformEmailSettings,
  EmailDelivery,
  EmailProviderEvent,
} from '../generated/client';

export interface PrismaClientOptions {
  readonly databaseUrl: string;
  /**
   * Query logging is opt-in and OFF by default: query text can contain
   * customer data, and PalCert documents are confidential unpublished
   * academic material (§49).
   */
  readonly logQueries?: boolean;
}

/**
 * Build the Prisma constructor options used everywhere in PalCert, so the API,
 * the workers and scripts all connect with identical settings.
 */
export function buildPrismaClientOptions(options: PrismaClientOptions): Prisma.PrismaClientOptions {
  return {
    datasources: { db: { url: options.databaseUrl } },
    log: options.logQueries
      ? (['query', 'warn', 'error'] as const).slice()
      : (['warn', 'error'] as const).slice(),
  };
}

export function createPrismaClient(options: PrismaClientOptions): PrismaClient {
  return new PrismaClient(buildPrismaClientOptions(options));
}
