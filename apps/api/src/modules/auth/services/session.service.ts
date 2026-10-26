import { Injectable } from '@nestjs/common';
import {
  AppError,
  AssuranceLevel,
  PalCertErrorCode,
  SessionState,
  type SessionRevocationReason,
  type SessionSummary,
} from '@palcert/contracts';
import type { Session } from '@palcert/database';
import { generateSecretToken, hashSecretToken } from '../../../common/crypto/secret-token';
import { ApiConfigService } from '../../../config/api-config.service';
import { PrismaService } from '../../../infrastructure/prisma/prisma.service';
import { ClockPort } from '../ports/clock.port';

/**
 * Translate why a session ended into what the user is told.
 *
 * Without this mapping the answer would depend on which code path noticed
 * first — a suspended user might see "session revoked" from one request and
 * "account suspended" from the next. The revocation reason is the single
 * source of truth for the explanation.
 *
 * Nothing here discloses more than the login endpoint already does to someone
 * who holds valid credentials.
 */
export function errorForRevocation(reason: SessionRevocationReason | null): AppError {
  switch (reason) {
    case 'EXPIRED':
      return new AppError(PalCertErrorCode.SESSION_EXPIRED, {
        message: 'Your session has expired. Please sign in again.',
      });
    case 'ACCOUNT_SUSPENDED':
      return new AppError(PalCertErrorCode.ACCOUNT_SUSPENDED, {
        message: 'This account is suspended. Please contact support.',
      });
    case 'ACCOUNT_DISABLED':
      return new AppError(PalCertErrorCode.ACCOUNT_DISABLED, {
        message: 'This account is no longer available.',
      });
    case 'PASSWORD_CHANGED':
    case 'PASSWORD_RESET':
      return new AppError(PalCertErrorCode.SESSION_REVOKED, {
        message: 'Your password changed, so this session ended. Please sign in again.',
      });
    default:
      return new AppError(PalCertErrorCode.SESSION_REVOKED, {
        message: 'This session is no longer valid. Please sign in again.',
      });
  }
}

export interface SessionClientMetadata {
  readonly ipAddress: string | null;
  readonly userAgent: string | null;
}

export interface EstablishedSession {
  readonly session: Session;
  /** Raw values for the cookies. Returned once and never stored. */
  readonly rawSessionToken: string;
  readonly rawCsrfToken: string;
}

export interface ResolvedSession {
  readonly session: Session;
  readonly rawCsrfTokenHash: string;
}

/**
 * Server-side opaque session management (ADR-0011).
 *
 * PostgreSQL is the single source of truth. The raw token never touches the
 * database — only its SHA-256 digest — so a database leak yields no directly
 * replayable session.
 */
@Injectable()
export class SessionService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ApiConfigService,
    private readonly clock: ClockPort,
  ) {}

  /**
   * Create a brand-new session.
   *
   * Always issues a fresh identifier — a session is never "upgraded" in place.
   * That is what makes session fixation impossible: a token an attacker planted
   * before authentication is not the token that ends up authenticated.
   */
  async create(params: {
    userId: string;
    state: SessionState;
    assuranceLevel: AssuranceLevel;
    privileged: boolean;
    client: SessionClientMetadata;
  }): Promise<EstablishedSession> {
    const now = this.clock.now();
    const sessionToken = generateSecretToken();
    const csrfToken = generateSecretToken();

    const { idleMinutes, absoluteMinutes } = this.lifetimeFor(params.state, params.privileged);
    const absoluteExpiresAt = new Date(now.getTime() + absoluteMinutes * 60_000);
    const idleExpiresAt = new Date(
      Math.min(now.getTime() + idleMinutes * 60_000, absoluteExpiresAt.getTime()),
    );

    const session = await this.prisma.session.create({
      data: {
        userId: params.userId,
        tokenHash: sessionToken.hash,
        csrfTokenHash: csrfToken.hash,
        state: params.state,
        assuranceLevel: params.assuranceLevel,
        mfaCompletedAt: params.assuranceLevel === AssuranceLevel.AAL2 ? now : null,
        createdAt: now,
        lastActivityAt: now,
        absoluteExpiresAt,
        idleExpiresAt,
        ipAddress: params.client.ipAddress,
        userAgent: params.client.userAgent?.slice(0, 512) ?? null,
      },
    });

    return { session, rawSessionToken: sessionToken.raw, rawCsrfToken: csrfToken.raw };
  }

  /**
   * Replace a session with a new one carrying the same (or elevated) identity.
   *
   * Used after MFA completion and after a password change: the old identifier
   * is revoked in the same transaction that creates the replacement, so there
   * is never a window in which both are valid.
   */
  async rotate(params: {
    currentSessionId: string;
    userId: string;
    state: SessionState;
    assuranceLevel: AssuranceLevel;
    privileged: boolean;
    client: SessionClientMetadata;
    reason: SessionRevocationReason;
  }): Promise<EstablishedSession> {
    const established = await this.create({
      userId: params.userId,
      state: params.state,
      assuranceLevel: params.assuranceLevel,
      privileged: params.privileged,
      client: params.client,
    });

    await this.revokeById(params.currentSessionId, params.reason);
    return established;
  }

  /**
   * Look up a session by its raw token and enforce every liveness rule.
   *
   * Returns null for "no usable session" in all the ways that should be
   * indistinguishable to a caller; throws only for states the user can act on
   * (expired vs revoked), which the guard translates into a response.
   */
  async resolve(rawToken: string): Promise<Session | null> {
    const session = await this.prisma.session.findUnique({
      where: { tokenHash: hashSecretToken(rawToken) },
    });
    if (session === null) return null;

    const now = this.clock.now();

    if (session.revokedAt !== null || session.state === SessionState.REVOKED) {
      throw errorForRevocation(session.revocationReason as SessionRevocationReason | null);
    }

    if (
      session.absoluteExpiresAt.getTime() <= now.getTime() ||
      session.idleExpiresAt.getTime() <= now.getTime()
    ) {
      // Expired sessions are revoked on discovery so the row cannot be revived
      // and so `GET /auth/sessions` never lists a dead session.
      await this.revokeById(session.id, 'EXPIRED');
      throw new AppError(PalCertErrorCode.SESSION_EXPIRED, {
        message: 'Your session has expired. Please sign in again.',
      });
    }

    return session;
  }

  /**
   * Slide the idle window forward, bounded by the absolute expiry.
   *
   * Written as a conditional update so a request arriving after revocation
   * cannot resurrect a dead session.
   */
  async touch(session: Session, privileged: boolean): Promise<void> {
    const now = this.clock.now();
    const { idleMinutes } = this.lifetimeFor(session.state as SessionState, privileged);
    const idleExpiresAt = new Date(
      Math.min(now.getTime() + idleMinutes * 60_000, session.absoluteExpiresAt.getTime()),
    );

    await this.prisma.session.updateMany({
      where: { id: session.id, revokedAt: null },
      data: { lastActivityAt: now, idleExpiresAt },
    });
  }

  async revokeById(sessionId: string, reason: SessionRevocationReason): Promise<void> {
    await this.prisma.session.updateMany({
      where: { id: sessionId, revokedAt: null },
      data: { revokedAt: this.clock.now(), revocationReason: reason, state: SessionState.REVOKED },
    });
  }

  /** Revoke every live session for a user, optionally sparing one. */
  async revokeAllForUser(
    userId: string,
    reason: SessionRevocationReason,
    exceptSessionId?: string,
  ): Promise<number> {
    const result = await this.prisma.session.updateMany({
      where: {
        userId,
        revokedAt: null,
        ...(exceptSessionId ? { id: { not: exceptSessionId } } : {}),
      },
      data: { revokedAt: this.clock.now(), revocationReason: reason, state: SessionState.REVOKED },
    });
    return result.count;
  }

  /** Revoke one session, but only if it belongs to the given user. */
  async revokeOwnedBy(
    userId: string,
    sessionId: string,
    reason: SessionRevocationReason,
  ): Promise<boolean> {
    const result = await this.prisma.session.updateMany({
      where: { id: sessionId, userId, revokedAt: null },
      data: { revokedAt: this.clock.now(), revocationReason: reason, state: SessionState.REVOKED },
    });
    return result.count === 1;
  }

  async listActiveForUser(userId: string, currentSessionId: string): Promise<SessionSummary[]> {
    const now = this.clock.now();
    const sessions = await this.prisma.session.findMany({
      where: {
        userId,
        revokedAt: null,
        state: SessionState.ACTIVE,
        absoluteExpiresAt: { gt: now },
        idleExpiresAt: { gt: now },
      },
      orderBy: { lastActivityAt: 'desc' },
    });

    return sessions.map((session) => ({
      id: session.id,
      createdAt: session.createdAt.toISOString(),
      lastActivityAt: session.lastActivityAt.toISOString(),
      absoluteExpiresAt: session.absoluteExpiresAt.toISOString(),
      idleExpiresAt: session.idleExpiresAt.toISOString(),
      assuranceLevel: session.assuranceLevel as AssuranceLevel,
      ipAddress: session.ipAddress,
      userAgent: session.userAgent,
      current: session.id === currentSessionId,
    }));
  }

  /** Verify a CSRF token against the one bound to this session. */
  matchesCsrfToken(session: Session, presentedToken: string): boolean {
    return hashSecretToken(presentedToken) === session.csrfTokenHash;
  }

  /**
   * True when the session authenticated recently enough for a sensitive action.
   * Measured from session creation (or MFA completion), not from last activity:
   * merely keeping a tab open must not count as re-authenticating.
   */
  isRecentlyAuthenticated(session: Session): boolean {
    const reference = session.mfaCompletedAt ?? session.createdAt;
    const ageMinutes = (this.clock.now().getTime() - reference.getTime()) / 60_000;
    return ageMinutes <= this.config.sessionPolicy.reauthWindowMinutes;
  }

  private lifetimeFor(
    state: SessionState,
    privileged: boolean,
  ): { idleMinutes: number; absoluteMinutes: number } {
    const policy = this.config.sessionPolicy;

    // The pre-MFA session is deliberately short: it exists only long enough to
    // answer a challenge.
    if (state === SessionState.PENDING_MFA) {
      return { idleMinutes: policy.pendingMfaMinutes, absoluteMinutes: policy.pendingMfaMinutes };
    }

    return privileged
      ? {
          idleMinutes: policy.privilegedIdleMinutes,
          absoluteMinutes: policy.privilegedAbsoluteMinutes,
        }
      : { idleMinutes: policy.idleMinutes, absoluteMinutes: policy.absoluteMinutes };
  }
}
