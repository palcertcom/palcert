import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { AuthController } from './auth.controller';
import { CsrfGuard } from './guards/csrf.guard';
import { PermissionsGuard } from './guards/permissions.guard';
import { SessionGuard } from './guards/session.guard';
import { BreachedPasswordPort, NoopBreachedPasswordChecker } from './ports/breached-password.port';
import { ClockPort, SystemClock } from './ports/clock.port';
import { OutboundEmailModule } from '../../infrastructure/email/outbound-email.module';
import { ManagedMailDelivery } from './mail/managed-mail-delivery';
import { LoggingMailDelivery, MailDeliveryPort } from './ports/mail.port';
import { AuthService } from './services/auth.service';
import { AuthThrottleService } from './services/auth-throttle.service';
import { CredentialTokenService } from './services/credential-token.service';
import { MfaService } from './services/mfa.service';
import { PasswordService } from './services/password.service';
import { SecurityEventService } from './services/security-event.service';
import { SessionCookieService } from './services/session-cookie.service';
import { SessionService } from './services/session.service';

/**
 * Authentication module.
 *
 * Guard order matters and is set here deliberately:
 *   1. CsrfGuard      — reject forged cross-site writes before any lookup.
 *   2. SessionGuard   — establish identity.
 *   3. PermissionsGuard — authorize the established identity.
 *
 * All three are global, so a new controller is protected by default and must
 * opt out explicitly with `@Public()`. Forgetting a decorator produces a locked
 * endpoint, never an open one.
 */
@Module({
  imports: [OutboundEmailModule],
  controllers: [AuthController],
  providers: [
    AuthService,
    AuthThrottleService,
    CredentialTokenService,
    MfaService,
    PasswordService,
    SecurityEventService,
    SessionCookieService,
    SessionService,
    { provide: ClockPort, useClass: SystemClock },
    // The admin-managed provider when an administrator has enabled it;
    // otherwise the logging adapter, exactly as before (ADR-0146).
    LoggingMailDelivery,
    ManagedMailDelivery,
    { provide: MailDeliveryPort, useExisting: ManagedMailDelivery },
    { provide: BreachedPasswordPort, useClass: NoopBreachedPasswordChecker },
    { provide: APP_GUARD, useClass: CsrfGuard },
    { provide: APP_GUARD, useClass: SessionGuard },
    { provide: APP_GUARD, useClass: PermissionsGuard },
  ],
  exports: [
    AuthService,
    // §22: the public verification route throttles by client the same way
    // sign-in does, and reaches the same counter rather than a parallel one.
    AuthThrottleService,
    SessionService,
    SessionCookieService,
    MfaService,
    PasswordService,
    SecurityEventService,
    ClockPort,
    MailDeliveryPort,
  ],
})
export class AuthModule {}
