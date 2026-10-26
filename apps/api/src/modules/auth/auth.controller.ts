import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Req,
  Res,
} from '@nestjs/common';
import { ApiBody, ApiCookieAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import {
  AppError,
  PalCertErrorCode,
  Permission,
  SecurityEventType,
  type SessionSummary,
} from '@palcert/contracts';
import type { Response } from 'express';
import {
  requestIdOf,
  type AuthenticatedRequest,
  type RequestPrincipal,
} from './authenticated-request';
import {
  AllowsPendingMfa,
  CurrentUser,
  Public,
  RequirePermissions,
} from './decorators/auth.decorators';
import {
  ChangePasswordDto,
  EmailOnlyDto,
  LoginDto,
  MfaChallengeDto,
  MfaCodeDto,
  MfaDisableDto,
  RegisterDto,
  ResetPasswordDto,
  SessionIdParamDto,
  TokenDto,
} from './dto/auth.dto';
import {
  GenericAcknowledgementDto,
  LoginResponseDto,
  LoginResultStatus,
  MfaConfirmationResponseDto,
  MfaEnrollmentResponseDto,
  RevokedSessionsDto,
  SessionSummaryDto,
} from './dto/auth-response.dto';
import { AuthService, type RequestContext } from './services/auth.service';
import { MfaService } from './services/mfa.service';
import { PasswordService } from './services/password.service';
import { SecurityEventService } from './services/security-event.service';
import { SessionCookieService } from './services/session-cookie.service';
import { SessionService } from './services/session.service';
import { PrismaService } from '../../infrastructure/prisma/prisma.service';

@ApiTags('auth')
@Controller('auth')
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    private readonly sessions: SessionService,
    private readonly cookies: SessionCookieService,
    private readonly mfa: MfaService,
    private readonly passwords: PasswordService,
    private readonly events: SecurityEventService,
    private readonly prisma: PrismaService,
  ) {}

  // ---------------------------------------------------------------------------
  // Registration and verification
  // ---------------------------------------------------------------------------

  @Post('register')
  @Public()
  @HttpCode(HttpStatus.ACCEPTED)
  @ApiOperation({
    summary: 'Register a new account',
    description:
      'Always returns 202 whether or not the address is already registered, so this endpoint ' +
      'cannot be used to discover which addresses have accounts.',
  })
  @ApiResponse({ status: 202, type: GenericAcknowledgementDto })
  @ApiResponse({ status: 422, description: 'PASSWORD_POLICY_VIOLATION' })
  async register(
    @Body() dto: RegisterDto,
    @Req() request: AuthenticatedRequest,
  ): Promise<GenericAcknowledgementDto> {
    const context = buildContext(request, dto.locale);
    await this.auth.register({
      email: dto.email,
      password: dto.password,
      ...(dto.displayName !== undefined ? { displayName: dto.displayName } : {}),
      locale: context.locale,
      context,
    });
    return { acknowledged: true };
  }

  @Post('email/verify')
  @Public()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Confirm an email address with the token from the link' })
  @ApiResponse({ status: 200, type: GenericAcknowledgementDto })
  @ApiResponse({ status: 400, description: 'VERIFICATION_TOKEN_INVALID (includes replay)' })
  @ApiResponse({ status: 410, description: 'VERIFICATION_TOKEN_EXPIRED' })
  async verifyEmail(
    @Body() dto: TokenDto,
    @Req() request: AuthenticatedRequest,
  ): Promise<GenericAcknowledgementDto> {
    await this.auth.verifyEmail(dto.token, buildContext(request));
    return { acknowledged: true };
  }

  @Post('email/resend')
  @Public()
  @HttpCode(HttpStatus.ACCEPTED)
  @ApiOperation({
    summary: 'Resend the verification email',
    description: 'Generic acknowledgement; rate limited per address.',
  })
  @ApiResponse({ status: 202, type: GenericAcknowledgementDto })
  async resendVerification(
    @Body() dto: EmailOnlyDto,
    @Req() request: AuthenticatedRequest,
  ): Promise<GenericAcknowledgementDto> {
    await this.auth.resendVerification(dto.email, buildContext(request));
    return { acknowledged: true };
  }

  // ---------------------------------------------------------------------------
  // Login / logout
  // ---------------------------------------------------------------------------

  @Post('login')
  @Public()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Sign in with email and password',
    description:
      'On success sets the HttpOnly session cookie and the readable CSRF cookie. When the ' +
      'account requires a second factor the response is MFA_REQUIRED and the session issued is ' +
      'a constrained pre-authentication session that can only answer the challenge.',
  })
  @ApiResponse({ status: 200, type: LoginResponseDto })
  @ApiResponse({ status: 401, description: 'AUTHENTICATION_FAILED' })
  @ApiResponse({ status: 403, description: 'EMAIL_NOT_VERIFIED / ACCOUNT_SUSPENDED' })
  @ApiResponse({ status: 429, description: 'RATE_LIMITED' })
  async login(
    @Body() dto: LoginDto,
    @Req() request: AuthenticatedRequest,
    @Res({ passthrough: true }) response: Response,
  ): Promise<LoginResponseDto> {
    const outcome = await this.auth.login({
      email: dto.email,
      password: dto.password,
      context: buildContext(request),
    });

    this.applySession(response, outcome.established);

    switch (outcome.kind) {
      case 'ESTABLISHED':
        return { status: LoginResultStatus.AUTHENTICATED };
      case 'MFA_REQUIRED':
        return { status: LoginResultStatus.MFA_REQUIRED };
      case 'MFA_ENROLLMENT_REQUIRED':
        return { status: LoginResultStatus.MFA_ENROLLMENT_REQUIRED };
    }
  }

  @Post('logout')
  @ApiCookieAuth()
  @AllowsPendingMfa()
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Sign out of the current session' })
  @ApiResponse({ status: 204, description: 'Session revoked and cookies cleared.' })
  async logout(
    @Req() request: AuthenticatedRequest,
    @Res({ passthrough: true }) response: Response,
  ): Promise<void> {
    const sessionId = request.principal?.sessionId ?? request.pendingMfaPrincipal?.sessionId;
    const userId = request.principal?.userId ?? request.pendingMfaPrincipal?.userId;

    if (sessionId !== undefined) {
      await this.sessions.revokeById(sessionId, 'USER_LOGOUT');
      await this.events.record({
        type: SecurityEventType.LOGOUT,
        userId: userId ?? null,
        ...buildContext(request),
      });
    }
    this.cookies.clearSessionCookies(response);
  }

  @Post('logout-all')
  @ApiCookieAuth()
  @RequirePermissions(Permission.SESSION_REVOKE_SELF)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Sign out of every session, including this one' })
  @ApiResponse({ status: 200, type: RevokedSessionsDto })
  async logoutAll(
    @CurrentUser() principal: RequestPrincipal,
    @Req() request: AuthenticatedRequest,
    @Res({ passthrough: true }) response: Response,
  ): Promise<RevokedSessionsDto> {
    const revoked = await this.sessions.revokeAllForUser(principal.userId, 'USER_LOGOUT_ALL');
    await this.events.record({
      type: SecurityEventType.LOGOUT_ALL,
      userId: principal.userId,
      metadata: { revoked },
      ...buildContext(request),
    });
    this.cookies.clearSessionCookies(response);
    return { revoked };
  }

  // ---------------------------------------------------------------------------
  // Sessions
  // ---------------------------------------------------------------------------

  @Get('sessions')
  @ApiCookieAuth()
  @RequirePermissions(Permission.SESSION_READ_SELF)
  @ApiOperation({ summary: 'List your own active sessions' })
  @ApiResponse({ status: 200, type: [SessionSummaryDto] })
  async listSessions(@CurrentUser() principal: RequestPrincipal): Promise<SessionSummary[]> {
    return this.sessions.listActiveForUser(principal.userId, principal.sessionId);
  }

  @Delete('sessions/:id')
  @ApiCookieAuth()
  @RequirePermissions(Permission.SESSION_REVOKE_SELF)
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary: 'Revoke one of your own sessions',
    description:
      'Returns 404 for a session belonging to another user — the same response as a session ' +
      'that does not exist, so this cannot be used to probe for valid session identifiers.',
  })
  @ApiResponse({ status: 204, description: 'Session revoked.' })
  @ApiResponse({ status: 404, description: 'NOT_FOUND' })
  async revokeSession(
    @Param() params: SessionIdParamDto,
    @CurrentUser() principal: RequestPrincipal,
    @Req() request: AuthenticatedRequest,
    @Res({ passthrough: true }) response: Response,
  ): Promise<void> {
    const revoked = await this.sessions.revokeOwnedBy(principal.userId, params.id, 'USER_REVOKED');
    if (!revoked) {
      throw new AppError(PalCertErrorCode.NOT_FOUND, { message: 'Session not found.' });
    }

    await this.events.record({
      type: SecurityEventType.SESSION_REVOKED,
      userId: principal.userId,
      metadata: { self: params.id === principal.sessionId },
      ...buildContext(request),
    });

    if (params.id === principal.sessionId) {
      this.cookies.clearSessionCookies(response);
    }
  }

  // ---------------------------------------------------------------------------
  // Password
  // ---------------------------------------------------------------------------

  @Post('password/forgot')
  @Public()
  @HttpCode(HttpStatus.ACCEPTED)
  @ApiOperation({
    summary: 'Request a password reset link',
    description: 'Always acknowledges, whether or not the address has an account.',
  })
  @ApiResponse({ status: 202, type: GenericAcknowledgementDto })
  async forgotPassword(
    @Body() dto: EmailOnlyDto,
    @Req() request: AuthenticatedRequest,
  ): Promise<GenericAcknowledgementDto> {
    await this.auth.requestPasswordReset(dto.email, buildContext(request));
    return { acknowledged: true };
  }

  @Post('password/reset')
  @Public()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Set a new password using a reset token',
    description: 'Consumes the token and revokes every existing session for the account.',
  })
  @ApiResponse({ status: 200, type: GenericAcknowledgementDto })
  @ApiResponse({ status: 400, description: 'PASSWORD_RESET_TOKEN_INVALID (includes replay)' })
  @ApiResponse({ status: 410, description: 'PASSWORD_RESET_TOKEN_EXPIRED' })
  async resetPassword(
    @Body() dto: ResetPasswordDto,
    @Req() request: AuthenticatedRequest,
  ): Promise<GenericAcknowledgementDto> {
    await this.auth.resetPassword({
      token: dto.token,
      newPassword: dto.newPassword,
      context: buildContext(request),
    });
    return { acknowledged: true };
  }

  @Post('password/change')
  @ApiCookieAuth()
  @RequirePermissions(Permission.PASSWORD_CHANGE_SELF)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Change your password',
    description:
      'Requires the current password. Rotates this session and revokes all others, so a ' +
      'stolen session identifier stops working immediately.',
  })
  @ApiResponse({ status: 200, type: GenericAcknowledgementDto })
  @ApiResponse({ status: 401, description: 'AUTHENTICATION_FAILED' })
  async changePassword(
    @Body() dto: ChangePasswordDto,
    @CurrentUser() principal: RequestPrincipal,
    @Req() request: AuthenticatedRequest,
    @Res({ passthrough: true }) response: Response,
  ): Promise<GenericAcknowledgementDto> {
    const established = await this.auth.changePassword({
      userId: principal.userId,
      sessionId: principal.sessionId,
      currentPassword: dto.currentPassword,
      newPassword: dto.newPassword,
      privileged: principal.privileged,
      context: buildContext(request),
    });
    this.applySession(response, established);
    return { acknowledged: true };
  }

  // ---------------------------------------------------------------------------
  // Multi-factor authentication
  // ---------------------------------------------------------------------------

  @Post('mfa/enroll')
  @ApiCookieAuth()
  @AllowsPendingMfa()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Begin MFA enrollment',
    description:
      'Returns provisioning data. MFA is NOT active until /auth/mfa/confirm succeeds. ' +
      'Reachable from a pre-authentication session so a privileged user who must enroll can.',
  })
  @ApiResponse({ status: 200, type: MfaEnrollmentResponseDto })
  @ApiResponse({ status: 409, description: 'MFA_ALREADY_ENROLLED' })
  async enrollMfa(@Req() request: AuthenticatedRequest): Promise<MfaEnrollmentResponseDto> {
    const identity = requireAnyPrincipal(request);
    const enrollment = await this.mfa.beginEnrollment(identity.userId, identity.email);
    await this.events.record({
      type: SecurityEventType.MFA_ENROLLMENT_STARTED,
      userId: identity.userId,
      ...buildContext(request),
    });
    return enrollment;
  }

  @Post('mfa/confirm')
  @ApiCookieAuth()
  @AllowsPendingMfa()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Confirm MFA enrollment with a code',
    description:
      'Activates MFA and returns single-use recovery codes, shown only once. When called from ' +
      'a pre-authentication session (a privileged user enrolling during sign-in) this also ' +
      'completes the login: proving possession of the factor is what elevates the session, so ' +
      'the user is not made to wait for a fresh code purely to satisfy replay protection.',
  })
  @ApiResponse({ status: 200, type: MfaConfirmationResponseDto })
  @ApiResponse({ status: 401, description: 'MFA_INVALID' })
  async confirmMfa(
    @Body() dto: MfaCodeDto,
    @Req() request: AuthenticatedRequest,
    @Res({ passthrough: true }) response: Response,
  ): Promise<MfaConfirmationResponseDto> {
    const identity = requireAnyPrincipal(request);
    const recoveryCodes = await this.mfa.confirmEnrollment(identity.userId, dto.code);

    await this.events.record({
      type: SecurityEventType.MFA_ENROLLED,
      userId: identity.userId,
      ...buildContext(request),
    });

    const pending = request.pendingMfaPrincipal;
    if (pending !== undefined) {
      const established = await this.auth.elevatePendingSession({
        sessionId: pending.sessionId,
        userId: pending.userId,
        context: buildContext(request),
      });
      this.applySession(response, established);
    }

    return { recoveryCodes };
  }

  @Post('mfa/challenge')
  @ApiCookieAuth()
  @AllowsPendingMfa()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Answer the MFA challenge',
    description:
      'Exchanges the pre-authentication session for a fully authenticated one. The session ' +
      'identifier changes, so the pre-authentication token cannot be reused.',
  })
  @ApiResponse({ status: 200, type: LoginResponseDto })
  @ApiResponse({ status: 401, description: 'MFA_INVALID' })
  @ApiResponse({ status: 429, description: 'RATE_LIMITED' })
  async challengeMfa(
    @Body() dto: MfaChallengeDto,
    @Req() request: AuthenticatedRequest,
    @Res({ passthrough: true }) response: Response,
  ): Promise<LoginResponseDto> {
    const pending = request.pendingMfaPrincipal;
    if (pending === undefined) {
      throw new AppError(PalCertErrorCode.MFA_REQUIRED, {
        message: 'Sign in with your password first.',
      });
    }

    const established = await this.auth.completeMfaChallenge({
      sessionId: pending.sessionId,
      userId: pending.userId,
      code: dto.code,
      useRecoveryCode: dto.useRecoveryCode === true,
      context: buildContext(request),
    });

    this.applySession(response, established);
    return { status: LoginResultStatus.AUTHENTICATED };
  }

  @Delete('mfa')
  @ApiCookieAuth()
  @RequirePermissions(Permission.MFA_MANAGE_SELF)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Disable MFA',
    description:
      'Requires the current password AND a valid current code, so neither a stolen session ' +
      'nor a stolen password alone is enough to remove the second factor.',
  })
  @ApiBody({ type: MfaDisableDto })
  @ApiResponse({ status: 200, type: GenericAcknowledgementDto })
  @ApiResponse({ status: 401, description: 'AUTHENTICATION_FAILED / MFA_INVALID' })
  @ApiResponse({ status: 403, description: 'PERMISSION_DENIED — privileged roles may not disable' })
  async disableMfa(
    @Body() dto: MfaDisableDto,
    @CurrentUser() principal: RequestPrincipal,
    @Req() request: AuthenticatedRequest,
  ): Promise<GenericAcknowledgementDto> {
    // A privileged account may not drop below policy. Removing the role comes
    // first; otherwise an administrator could simply opt out of MFA.
    if (principal.privileged) {
      throw new AppError(PalCertErrorCode.PERMISSION_DENIED, {
        message: 'Multi-factor authentication is required for this account and cannot be disabled.',
      });
    }

    const user = await this.prisma.user.findUnique({ where: { id: principal.userId } });
    if (user === null || !(await this.passwords.verify(user.passwordHash, dto.password))) {
      throw new AppError(PalCertErrorCode.AUTHENTICATION_FAILED, {
        message: 'Your password is not correct.',
      });
    }

    if (!(await this.mfa.verifyTotp(principal.userId, dto.code))) {
      throw new AppError(PalCertErrorCode.MFA_INVALID, { message: 'That code is not valid.' });
    }

    await this.mfa.disable(principal.userId);
    await this.events.record({
      type: SecurityEventType.MFA_DISABLED,
      userId: principal.userId,
      ...buildContext(request),
    });
    return { acknowledged: true };
  }

  private applySession(
    response: Response,
    established: {
      rawSessionToken: string;
      rawCsrfToken: string;
      session: { absoluteExpiresAt: Date };
    },
  ): void {
    this.cookies.setSessionCookies(response, {
      sessionToken: established.rawSessionToken,
      csrfToken: established.rawCsrfToken,
      expiresAt: established.session.absoluteExpiresAt,
    });
  }
}

/** Accepts either a fully authenticated or a pending-MFA identity. */
function requireAnyPrincipal(request: AuthenticatedRequest): { userId: string; email: string } {
  const identity = request.principal ?? request.pendingMfaPrincipal;
  if (identity === undefined) {
    throw new AppError(PalCertErrorCode.UNAUTHENTICATED, {
      message: 'Authentication is required.',
    });
  }
  return { userId: identity.userId, email: identity.email };
}

export function buildContext(request: AuthenticatedRequest, locale?: string): RequestContext {
  return {
    ipAddress: request.ip ?? null,
    userAgent: request.get('user-agent') ?? null,
    requestId: requestIdOf(request),
    locale: locale ?? request.principal?.preferredLocale ?? 'en',
  };
}
