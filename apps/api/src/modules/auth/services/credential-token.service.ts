import { Injectable } from '@nestjs/common';
import { AppError, PalCertErrorCode } from '@palcert/contracts';
import { PrismaService } from '../../../infrastructure/prisma/prisma.service';
import { generateSecretToken, hashSecretToken } from '../../../common/crypto/secret-token';
import { ApiConfigService } from '../../../config/api-config.service';
import { ClockPort } from '../ports/clock.port';

export interface IssuedCredentialToken {
  /** Delivered to the user by mail. Never persisted. */
  readonly raw: string;
  readonly expiresAt: Date;
}

/**
 * Single-use, expiring credential tokens for email verification and password
 * reset.
 *
 * Both flows share identical security requirements, so they share an
 * implementation: random 256-bit token, digest-only persistence, atomic
 * single-use consumption, and distinct error codes for invalid versus expired.
 */
@Injectable()
export class CredentialTokenService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ApiConfigService,
    private readonly clock: ClockPort,
  ) {}

  async issueEmailVerification(userId: string): Promise<IssuedCredentialToken> {
    const { raw, hash } = generateSecretToken();
    const expiresAt = this.clock.plusMinutes(this.config.tokenTtl.emailVerificationMinutes);

    // Outstanding tokens are invalidated so a re-send cannot leave two live
    // links, and so a leaked older link stops working.
    await this.prisma.$transaction([
      this.prisma.emailVerificationToken.updateMany({
        where: { userId, consumedAt: null },
        data: { consumedAt: this.clock.now() },
      }),
      this.prisma.emailVerificationToken.create({
        data: { userId, tokenHash: hash, expiresAt },
      }),
    ]);

    return { raw, expiresAt };
  }

  async issuePasswordReset(userId: string): Promise<IssuedCredentialToken> {
    const { raw, hash } = generateSecretToken();
    const expiresAt = this.clock.plusMinutes(this.config.tokenTtl.passwordResetMinutes);

    await this.prisma.$transaction([
      this.prisma.passwordResetToken.updateMany({
        where: { userId, consumedAt: null },
        data: { consumedAt: this.clock.now() },
      }),
      this.prisma.passwordResetToken.create({
        data: { userId, tokenHash: hash, expiresAt },
      }),
    ]);

    return { raw, expiresAt };
  }

  /**
   * Atomically consume an email-verification token.
   *
   * The update is conditional on `consumedAt` still being null, so two
   * concurrent requests with the same token cannot both succeed — replay is
   * prevented by the database, not by a read-then-write race.
   */
  async consumeEmailVerification(rawToken: string): Promise<string> {
    return this.consume(rawToken, 'emailVerification');
  }

  async consumePasswordReset(rawToken: string): Promise<string> {
    return this.consume(rawToken, 'passwordReset');
  }

  private async consume(
    rawToken: string,
    kind: 'emailVerification' | 'passwordReset',
  ): Promise<string> {
    const invalidCode =
      kind === 'emailVerification'
        ? PalCertErrorCode.VERIFICATION_TOKEN_INVALID
        : PalCertErrorCode.PASSWORD_RESET_TOKEN_INVALID;
    const expiredCode =
      kind === 'emailVerification'
        ? PalCertErrorCode.VERIFICATION_TOKEN_EXPIRED
        : PalCertErrorCode.PASSWORD_RESET_TOKEN_EXPIRED;

    const tokenHash = hashSecretToken(rawToken);
    const now = this.clock.now();

    const record =
      kind === 'emailVerification'
        ? await this.prisma.emailVerificationToken.findUnique({ where: { tokenHash } })
        : await this.prisma.passwordResetToken.findUnique({ where: { tokenHash } });

    // An already-consumed token is reported as invalid, not as "expired" or
    // "already used": telling an attacker they found a real token is a gift.
    if (record === null || record.consumedAt !== null) {
      throw new AppError(invalidCode, { message: 'This link is no longer valid.' });
    }

    if (record.expiresAt.getTime() <= now.getTime()) {
      throw new AppError(expiredCode, { message: 'This link has expired.' });
    }

    const consumed =
      kind === 'emailVerification'
        ? await this.prisma.emailVerificationToken.updateMany({
            where: { id: record.id, consumedAt: null },
            data: { consumedAt: now },
          })
        : await this.prisma.passwordResetToken.updateMany({
            where: { id: record.id, consumedAt: null },
            data: { consumedAt: now },
          });

    // Lost the race against a concurrent consumer.
    if (consumed.count !== 1) {
      throw new AppError(invalidCode, { message: 'This link is no longer valid.' });
    }

    return record.userId;
  }
}
