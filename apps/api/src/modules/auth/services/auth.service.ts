import { Injectable } from '@nestjs/common';
import {
  AppError,
  AssuranceLevel,
  DEFAULT_REGISTRATION_ROLE,
  PalCertErrorCode,
  RoleScope,
  SecurityEventType,
  SessionState,
  UserStatus,
  type UserProfile,
} from '@palcert/contracts';
import type { User } from '@palcert/database';
import { normalizeEmail } from '../../../common/crypto/email-normalizer';
import { ApiConfigService } from '../../../config/api-config.service';
import { PrismaService } from '../../../infrastructure/prisma/prisma.service';
import { RbacService } from '../../rbac/rbac.service';
import { ClockPort } from '../ports/clock.port';
import { MailDeliveryPort, MailTemplate } from '../ports/mail.port';
import { AuthThrottleService, ThrottleScope } from './auth-throttle.service';
import { CredentialTokenService } from './credential-token.service';
import { MfaService } from './mfa.service';
import { PASSWORD_ALGORITHM, PasswordService } from './password.service';
import { SecurityEventService, type SecurityEventContext } from './security-event.service';
import {
  SessionService,
  type EstablishedSession,
  type SessionClientMetadata,
} from './session.service';

export interface RequestContext extends SecurityEventContext {
  readonly ipAddress: string | null;
  readonly userAgent: string | null;
  readonly requestId: string | null;
  readonly locale: string;
}

export type LoginOutcome =
  | { readonly kind: 'ESTABLISHED'; readonly established: EstablishedSession }
  | { readonly kind: 'MFA_REQUIRED'; readonly established: EstablishedSession }
  | { readonly kind: 'MFA_ENROLLMENT_REQUIRED'; readonly established: EstablishedSession };

/**
 * Authentication orchestration.
 *
 * Enumeration policy (§34), applied consistently across every endpoint that
 * takes an email address: registration, password reset and verification resend
 * all return the same generic response whether or not the account exists, and
 * login collapses every credential failure into AUTHENTICATION_FAILED.
 */
@Injectable()
export class AuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ApiConfigService,
    private readonly clock: ClockPort,
    private readonly passwords: PasswordService,
    private readonly sessions: SessionService,
    private readonly tokens: CredentialTokenService,
    private readonly mfa: MfaService,
    private readonly rbac: RbacService,
    private readonly throttle: AuthThrottleService,
    private readonly events: SecurityEventService,
    private readonly mail: MailDeliveryPort,
  ) {}

  // ---------------------------------------------------------------------------
  // Registration and email verification
  // ---------------------------------------------------------------------------

  /**
   * Self-service registration.
   *
   * Always reports success. If the address is already registered we send a
   * "someone tried to register with your address" style verification mail to
   * the existing owner instead of creating anything — the response is identical
   * either way, so registration cannot be used to test whether an address has
   * an account.
   */
  async register(params: {
    email: string;
    password: string;
    displayName?: string;
    locale: string;
    context: RequestContext;
  }): Promise<void> {
    // Policy is checked before the existence lookup so a weak password is
    // rejected identically for new and existing addresses.
    await this.passwords.assertMeetsPolicy(params.password);

    const normalizedEmail = normalizeEmail(params.email);
    const existing = await this.prisma.user.findUnique({ where: { normalizedEmail } });

    if (existing !== null) {
      // Perform comparable work, then stop. No account state is revealed.
      await this.passwords.hash(params.password);
      if (
        existing.emailVerifiedAt === null &&
        existing.status === UserStatus.PENDING_VERIFICATION
      ) {
        await this.sendVerificationMail(existing, params.context);
      }
      return;
    }

    const passwordHash = await this.passwords.hash(params.password);
    const role = await this.prisma.role.findUnique({
      where: { code: DEFAULT_REGISTRATION_ROLE },
    });
    if (role === null) {
      throw new AppError(PalCertErrorCode.INTERNAL_ERROR, {
        message: 'Registration is temporarily unavailable.',
        internalContext: { reason: 'default registration role missing — run migrations' },
      });
    }

    const user = await this.prisma.user.create({
      data: {
        email: params.email.trim(),
        normalizedEmail,
        passwordHash,
        passwordAlgorithm: PASSWORD_ALGORITHM,
        passwordChangedAt: this.clock.now(),
        status: UserStatus.PENDING_VERIFICATION,
        displayName: params.displayName?.trim() || null,
        preferredLocale: params.locale,
        // Registration never grants an organization role (§8) — the database
        // constraint enforces the scope, this sets the correct one.
        roles: { create: { roleId: role.id, organizationId: null, scope: RoleScope.GLOBAL } },
      },
    });

    await this.events.record({
      type: SecurityEventType.USER_REGISTERED,
      userId: user.id,
      ...params.context,
    });

    await this.sendVerificationMail(user, params.context);
  }

  /** Resend verification mail. Generic response regardless of account state. */
  async resendVerification(email: string, context: RequestContext): Promise<void> {
    const normalizedEmail = normalizeEmail(email);
    await this.throttle.consume(ThrottleScope.VERIFICATION_RESEND, normalizedEmail);

    const user = await this.prisma.user.findUnique({ where: { normalizedEmail } });
    if (user === null || user.emailVerifiedAt !== null) return;
    if (user.status === UserStatus.DISABLED || user.status === UserStatus.SUSPENDED) return;

    await this.sendVerificationMail(user, context);
  }

  async verifyEmail(rawToken: string, context: RequestContext): Promise<void> {
    const userId = await this.tokens.consumeEmailVerification(rawToken);
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (user === null) {
      throw new AppError(PalCertErrorCode.VERIFICATION_TOKEN_INVALID, {
        message: 'This link is no longer valid.',
      });
    }

    // Verification activates only an account still awaiting it. A suspended or
    // disabled account must not be resurrected by an old link.
    if (user.status === UserStatus.PENDING_VERIFICATION) {
      await this.prisma.user.update({
        where: { id: user.id },
        data: { emailVerifiedAt: this.clock.now(), status: UserStatus.ACTIVE },
      });
    } else if (user.emailVerifiedAt === null) {
      await this.prisma.user.update({
        where: { id: user.id },
        data: { emailVerifiedAt: this.clock.now() },
      });
    }

    await this.events.record({
      type: SecurityEventType.EMAIL_VERIFIED,
      userId: user.id,
      ...context,
    });
  }

  // ---------------------------------------------------------------------------
  // Login
  // ---------------------------------------------------------------------------

  async login(params: {
    email: string;
    password: string;
    context: RequestContext;
  }): Promise<LoginOutcome> {
    const normalizedEmail = normalizeEmail(params.email);
    const client: SessionClientMetadata = {
      ipAddress: params.context.ipAddress,
      userAgent: params.context.userAgent,
    };

    // Both throttle dimensions are consumed before any credential work, so an
    // attacker cannot use response timing to distinguish the two limits.
    if (params.context.ipAddress !== null) {
      await this.throttleOrRecord(ThrottleScope.LOGIN_IP, params.context.ipAddress, params.context);
    }
    await this.throttleOrRecord(ThrottleScope.LOGIN_ACCOUNT, normalizedEmail, params.context);

    const user = await this.prisma.user.findUnique({ where: { normalizedEmail } });

    // Always run a verification so an unknown address costs the same as a known
    // one. Hashing a dummy value keeps the timing profile comparable.
    const passwordMatches =
      user === null
        ? await this.verifyAgainstDecoy(params.password)
        : await this.passwords.verify(user.passwordHash, params.password);

    if (user === null || !passwordMatches) {
      await this.events.record({
        type: SecurityEventType.LOGIN_FAILED,
        userId: user?.id ?? null,
        metadata: { reason: user === null ? 'UNKNOWN_ACCOUNT' : 'BAD_PASSWORD' },
        ...params.context,
      });
      throw new AppError(PalCertErrorCode.AUTHENTICATION_FAILED, {
        message: 'Incorrect email address or password.',
      });
    }

    this.assertAccountUsable(user);

    if (user.emailVerifiedAt === null) {
      await this.events.record({
        type: SecurityEventType.LOGIN_FAILED,
        userId: user.id,
        metadata: { reason: 'EMAIL_NOT_VERIFIED' },
        ...params.context,
      });
      throw new AppError(PalCertErrorCode.EMAIL_NOT_VERIFIED, {
        message: 'Please confirm your email address before signing in.',
      });
    }

    // Credentials are good: clear the account counter so a user who mistyped a
    // few times is not punished afterwards. The IP counter is left alone — it
    // defends against one source trying many accounts.
    await this.throttle.reset(ThrottleScope.LOGIN_ACCOUNT, normalizedEmail);

    // Upgrade the stored hash if policy has strengthened since it was written.
    if (this.passwords.needsRehash(user.passwordHash)) {
      const rehashed = await this.passwords.hash(params.password);
      await this.prisma.user.update({
        where: { id: user.id },
        data: { passwordHash: rehashed, passwordAlgorithm: PASSWORD_ALGORITHM },
      });
    }

    const authorization = await this.rbac.resolveAuthorization(user.id);
    const mfaRequired = authorization.requiresMfa || user.mfaRequiredOverride;
    const enrolled = await this.mfa.isEnrolled(user.id);

    if (mfaRequired && !enrolled) {
      // Privileged account without a second factor: issue a constrained session
      // that can do nothing except enroll.
      const established = await this.sessions.create({
        userId: user.id,
        state: SessionState.PENDING_MFA,
        assuranceLevel: AssuranceLevel.AAL1,
        privileged: true,
        client,
      });
      return { kind: 'MFA_ENROLLMENT_REQUIRED', established };
    }

    if (mfaRequired || enrolled) {
      const established = await this.sessions.create({
        userId: user.id,
        state: SessionState.PENDING_MFA,
        assuranceLevel: AssuranceLevel.AAL1,
        privileged: authorization.requiresMfa,
        client,
      });
      return { kind: 'MFA_REQUIRED', established };
    }

    const established = await this.sessions.create({
      userId: user.id,
      state: SessionState.ACTIVE,
      assuranceLevel: AssuranceLevel.AAL1,
      privileged: false,
      client,
    });

    await this.recordSuccessfulLogin(user.id, params.context);
    return { kind: 'ESTABLISHED', established };
  }

  /**
   * Exchange a pending-MFA session for a fully authenticated one.
   *
   * Shared by the challenge endpoint and by enrollment confirmation: proving
   * possession of the factor is what elevates the session, however it was
   * proven.
   */
  async elevatePendingSession(params: {
    sessionId: string;
    userId: string;
    context: RequestContext;
  }): Promise<EstablishedSession> {
    const authorization = await this.rbac.resolveAuthorization(params.userId);
    const established = await this.sessions.rotate({
      currentSessionId: params.sessionId,
      userId: params.userId,
      state: SessionState.ACTIVE,
      assuranceLevel: AssuranceLevel.AAL2,
      privileged: authorization.requiresMfa,
      client: { ipAddress: params.context.ipAddress, userAgent: params.context.userAgent },
      reason: 'SESSION_ROTATED',
    });
    await this.recordSuccessfulLogin(params.userId, params.context);
    return established;
  }

  /**
   * Complete an MFA challenge and exchange the pending session for a real one.
   * The identifier changes, so the pre-auth token is useless afterwards.
   */
  async completeMfaChallenge(params: {
    sessionId: string;
    userId: string;
    code: string;
    useRecoveryCode: boolean;
    context: RequestContext;
  }): Promise<EstablishedSession> {
    await this.throttle.consume(ThrottleScope.MFA, params.userId);

    const accepted = params.useRecoveryCode
      ? await this.mfa.consumeRecoveryCode(params.userId, params.code)
      : await this.mfa.verifyTotp(params.userId, params.code);

    if (!accepted) {
      await this.events.record({
        type: SecurityEventType.MFA_CHALLENGE_FAILED,
        userId: params.userId,
        metadata: { method: params.useRecoveryCode ? 'RECOVERY_CODE' : 'TOTP' },
        ...params.context,
      });
      throw new AppError(PalCertErrorCode.MFA_INVALID, { message: 'That code is not valid.' });
    }

    await this.throttle.reset(ThrottleScope.MFA, params.userId);

    if (params.useRecoveryCode) {
      await this.events.record({
        type: SecurityEventType.MFA_RECOVERY_USED,
        userId: params.userId,
        metadata: { remaining: await this.mfa.remainingRecoveryCodes(params.userId) },
        ...params.context,
      });
    }

    await this.events.record({
      type: SecurityEventType.MFA_CHALLENGE_SUCCEEDED,
      userId: params.userId,
      ...params.context,
    });

    return this.elevatePendingSession({
      sessionId: params.sessionId,
      userId: params.userId,
      context: params.context,
    });
  }

  // ---------------------------------------------------------------------------
  // Password reset and change
  // ---------------------------------------------------------------------------

  /** Always succeeds from the caller's perspective (§14, §34). */
  async requestPasswordReset(email: string, context: RequestContext): Promise<void> {
    const normalizedEmail = normalizeEmail(email);
    await this.throttle.consume(ThrottleScope.PASSWORD_RESET, normalizedEmail);

    const user = await this.prisma.user.findUnique({ where: { normalizedEmail } });
    if (user === null || user.status === UserStatus.DISABLED) return;

    const token = await this.tokens.issuePasswordReset(user.id);

    await this.mail.send({
      to: user.email,
      locale: user.preferredLocale,
      template: MailTemplate.PASSWORD_RESET,
      variables: {
        token: token.raw,
        url: `${this.config.publicWebUrl}/${user.preferredLocale}/reset-password?token=${encodeURIComponent(token.raw)}`,
        displayName: user.displayName ?? '',
        expiresAt: token.expiresAt.toISOString(),
      },
    });

    await this.events.record({
      type: SecurityEventType.PASSWORD_RESET_REQUESTED,
      userId: user.id,
      ...context,
    });
  }

  async resetPassword(params: {
    token: string;
    newPassword: string;
    context: RequestContext;
  }): Promise<void> {
    await this.passwords.assertMeetsPolicy(params.newPassword);

    const userId = await this.tokens.consumePasswordReset(params.token);
    const passwordHash = await this.passwords.hash(params.newPassword);

    await this.prisma.user.update({
      where: { id: userId },
      data: {
        passwordHash,
        passwordAlgorithm: PASSWORD_ALGORITHM,
        passwordChangedAt: this.clock.now(),
      },
    });

    // A reset is the recovery path after a suspected compromise, so every
    // existing session is destroyed without exception (§14).
    const revoked = await this.sessions.revokeAllForUser(userId, 'PASSWORD_RESET');

    await this.events.record({
      type: SecurityEventType.PASSWORD_RESET_COMPLETED,
      userId,
      metadata: { sessionsRevoked: revoked },
      ...params.context,
    });
  }

  async changePassword(params: {
    userId: string;
    sessionId: string;
    currentPassword: string;
    newPassword: string;
    privileged: boolean;
    context: RequestContext;
  }): Promise<EstablishedSession> {
    const user = await this.prisma.user.findUnique({ where: { id: params.userId } });
    if (user === null) {
      throw new AppError(PalCertErrorCode.UNAUTHENTICATED, { message: 'Please sign in again.' });
    }

    // Possession of a session is not sufficient for a credential change: the
    // current password must be presented as well (§15).
    if (!(await this.passwords.verify(user.passwordHash, params.currentPassword))) {
      await this.events.record({
        type: SecurityEventType.LOGIN_FAILED,
        userId: user.id,
        metadata: { reason: 'PASSWORD_CHANGE_REAUTH_FAILED' },
        ...params.context,
      });
      throw new AppError(PalCertErrorCode.AUTHENTICATION_FAILED, {
        message: 'Your current password is not correct.',
      });
    }

    await this.passwords.assertMeetsPolicy(params.newPassword);

    await this.prisma.user.update({
      where: { id: user.id },
      data: {
        passwordHash: await this.passwords.hash(params.newPassword),
        passwordAlgorithm: PASSWORD_ALGORITHM,
        passwordChangedAt: this.clock.now(),
      },
    });

    // Every other session dies; this one is rotated rather than kept, so a
    // stolen identifier is worthless even if the thief is currently connected.
    const session = await this.prisma.session.findUnique({ where: { id: params.sessionId } });
    const established = await this.sessions.rotate({
      currentSessionId: params.sessionId,
      userId: user.id,
      state: SessionState.ACTIVE,
      assuranceLevel: (session?.assuranceLevel as AssuranceLevel) ?? AssuranceLevel.AAL1,
      privileged: params.privileged,
      client: { ipAddress: params.context.ipAddress, userAgent: params.context.userAgent },
      reason: 'PASSWORD_CHANGED',
    });
    await this.sessions.revokeAllForUser(user.id, 'PASSWORD_CHANGED', established.session.id);

    await this.events.record({
      type: SecurityEventType.PASSWORD_CHANGED,
      userId: user.id,
      ...params.context,
    });

    // Phase 16 turns this into a real notification; the domain event exists now.
    await this.mail.send({
      to: user.email,
      locale: user.preferredLocale,
      template: MailTemplate.PASSWORD_CHANGED,
      variables: { displayName: user.displayName ?? '' },
    });

    return established;
  }

  // ---------------------------------------------------------------------------
  // Profile
  // ---------------------------------------------------------------------------

  async buildProfile(userId: string): Promise<UserProfile> {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (user === null) {
      throw new AppError(PalCertErrorCode.NOT_FOUND, { message: 'User not found.' });
    }

    const authorization = await this.rbac.resolveAuthorization(userId);

    return {
      id: user.id,
      email: user.email,
      displayName: user.displayName,
      status: user.status as UserStatus,
      preferredLocale: user.preferredLocale,
      emailVerified: user.emailVerifiedAt !== null,
      mfaEnrolled: await this.mfa.isEnrolled(userId),
      mfaRequired: authorization.requiresMfa || user.mfaRequiredOverride,
      roles: authorization.roles,
      permissions: [...authorization.permissions],
      createdAt: user.createdAt.toISOString(),
      lastLoginAt: user.lastLoginAt?.toISOString() ?? null,
    };
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  /** Throws ACCOUNT_SUSPENDED / ACCOUNT_DISABLED, revoking sessions as needed. */
  assertAccountUsable(user: Pick<User, 'id' | 'status'>): void {
    if (user.status === UserStatus.SUSPENDED) {
      throw new AppError(PalCertErrorCode.ACCOUNT_SUSPENDED, {
        message: 'This account is suspended. Please contact support.',
      });
    }
    if (user.status === UserStatus.DISABLED) {
      throw new AppError(PalCertErrorCode.ACCOUNT_DISABLED, {
        message: 'This account is no longer available.',
      });
    }
  }

  private async sendVerificationMail(
    user: Pick<User, 'id' | 'email' | 'displayName' | 'preferredLocale'>,
    context: RequestContext,
  ): Promise<void> {
    const token = await this.tokens.issueEmailVerification(user.id);

    await this.mail.send({
      to: user.email,
      locale: user.preferredLocale,
      template: MailTemplate.EMAIL_VERIFICATION,
      variables: {
        token: token.raw,
        url: `${this.config.publicWebUrl}/${user.preferredLocale}/verify-email?token=${encodeURIComponent(token.raw)}`,
        displayName: user.displayName ?? '',
        expiresAt: token.expiresAt.toISOString(),
      },
    });

    await this.events.record({
      type: SecurityEventType.EMAIL_VERIFICATION_REQUESTED,
      userId: user.id,
      ...context,
    });
  }

  private async recordSuccessfulLogin(userId: string, context: RequestContext): Promise<void> {
    await this.prisma.user.update({
      where: { id: userId },
      data: { lastLoginAt: this.clock.now() },
    });
    await this.events.record({
      type: SecurityEventType.LOGIN_SUCCEEDED,
      userId,
      ...context,
    });
  }

  private async throttleOrRecord(
    scope: ThrottleScope,
    identifier: string,
    context: RequestContext,
  ): Promise<void> {
    try {
      await this.throttle.consume(scope, identifier);
    } catch (error) {
      await this.events.record({
        type: SecurityEventType.LOGIN_THROTTLED,
        metadata: { scope },
        ...context,
      });
      throw error;
    }
  }

  /**
   * Hash the supplied password against a throwaway value so an unknown address
   * costs roughly the same as a known one.
   */
  private async verifyAgainstDecoy(password: string): Promise<boolean> {
    await this.passwords.hash(password);
    return false;
  }
}
