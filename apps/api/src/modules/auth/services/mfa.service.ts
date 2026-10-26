import { Injectable } from '@nestjs/common';
import { AppError, PalCertErrorCode } from '@palcert/contracts';
import { Secret, TOTP } from 'otpauth';
import * as QRCode from 'qrcode';
import { randomBytes } from 'node:crypto';
import { openSecret, sealSecret } from '../../../common/crypto/secret-box';
import {
  generateRecoveryCode,
  hashSecretToken,
  normalizeRecoveryCode,
} from '../../../common/crypto/secret-token';
import { ApiConfigService } from '../../../config/api-config.service';
import { PrismaService } from '../../../infrastructure/prisma/prisma.service';
import { ClockPort } from '../ports/clock.port';

const TOTP_PERIOD_SECONDS = 30;
const TOTP_DIGITS = 6;
/**
 * Accept the adjacent step in each direction to tolerate clock skew, as
 * recommended by RFC 6238. A wider window materially increases the chance of a
 * blind guess succeeding.
 */
const TOTP_WINDOW = 1;

export interface MfaEnrollment {
  /** otpauth:// URI for manual entry into an authenticator app. */
  readonly provisioningUri: string;
  /** PNG data URL of the same URI, for scanning. */
  readonly qrCodeDataUrl: string;
  /** Shown once so a user without a camera can type it in. */
  readonly secret: string;
}

/**
 * TOTP multi-factor authentication (ADR-0013).
 *
 * TOTP is the Phase 1 factor because it works offline, everywhere, with no
 * carrier dependency. SMS is deliberately not offered: it is vulnerable to SIM
 * swap and interception, and NIST SP 800-63B has restricted it since 2017.
 * WebAuthn/passkeys are the intended next factor — the authenticator table is
 * typed so adding one is an additive change.
 */
@Injectable()
export class MfaService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ApiConfigService,
    private readonly clock: ClockPort,
  ) {}

  /**
   * Begin enrollment: generate and store a secret, unconfirmed.
   *
   * An unconfirmed authenticator never satisfies a challenge — possession must
   * be proven first (§22).
   */
  async beginEnrollment(userId: string, accountLabel: string): Promise<MfaEnrollment> {
    const existing = await this.findConfirmedAuthenticator(userId);
    if (existing !== null) {
      throw new AppError(PalCertErrorCode.MFA_ALREADY_ENROLLED, {
        message: 'Multi-factor authentication is already enabled for this account.',
      });
    }

    const secret = Secret.fromHex(randomBytes(20).toString('hex'));
    const sealed = sealSecret(secret.base32, this.config.mfaPolicy.secretKey);

    // Replace any previous unconfirmed attempt rather than accumulating rows.
    await this.prisma.mfaAuthenticator.deleteMany({ where: { userId, confirmedAt: null } });
    await this.prisma.mfaAuthenticator.create({
      data: {
        userId,
        type: 'TOTP',
        secretCiphertext: sealed.ciphertext,
        secretIv: sealed.iv,
        secretAuthTag: sealed.authTag,
      },
    });

    const totp = this.buildTotp(secret.base32, accountLabel);
    const provisioningUri = totp.toString();

    return {
      provisioningUri,
      qrCodeDataUrl: await QRCode.toDataURL(provisioningUri, { margin: 1, width: 240 }),
      secret: secret.base32,
    };
  }

  /**
   * Complete enrollment by verifying a code, then issue recovery codes.
   * Returns the raw recovery codes — the only time they exist in plaintext.
   */
  async confirmEnrollment(userId: string, code: string): Promise<string[]> {
    const authenticator = await this.prisma.mfaAuthenticator.findFirst({
      where: { userId, confirmedAt: null },
      orderBy: { createdAt: 'desc' },
    });

    if (authenticator === null) {
      throw new AppError(PalCertErrorCode.MFA_ENROLLMENT_REQUIRED, {
        message: 'Start multi-factor enrollment before confirming it.',
      });
    }

    const secret = this.unseal(authenticator);
    const delta = this.validateCode(secret, code);
    if (delta === null) {
      throw new AppError(PalCertErrorCode.MFA_INVALID, { message: 'That code is not valid.' });
    }

    const now = this.clock.now();
    await this.prisma.mfaAuthenticator.update({
      where: { id: authenticator.id },
      data: {
        confirmedAt: now,
        lastUsedAt: now,
        lastAcceptedCounter: BigInt(this.counterFor(now, delta)),
      },
    });

    return this.regenerateRecoveryCodes(userId);
  }

  /**
   * Verify a TOTP code for an enrolled user.
   *
   * Rejects any counter at or below the last accepted one, so a code captured
   * by a shoulder-surfer or a proxy cannot be replayed inside its 30-second
   * validity window.
   */
  async verifyTotp(userId: string, code: string): Promise<boolean> {
    const authenticator = await this.findConfirmedAuthenticator(userId);
    if (authenticator === null) return false;

    const delta = this.validateCode(this.unseal(authenticator), code);
    if (delta === null) return false;

    const now = this.clock.now();
    const counter = BigInt(this.counterFor(now, delta));
    if (
      authenticator.lastAcceptedCounter !== null &&
      counter <= authenticator.lastAcceptedCounter
    ) {
      return false;
    }

    await this.prisma.mfaAuthenticator.update({
      where: { id: authenticator.id },
      data: { lastUsedAt: now, lastAcceptedCounter: counter },
    });
    return true;
  }

  /** Consume a recovery code. Single-use, enforced by a conditional update. */
  async consumeRecoveryCode(userId: string, code: string): Promise<boolean> {
    const codeHash = hashSecretToken(normalizeRecoveryCode(code));
    const result = await this.prisma.mfaRecoveryCode.updateMany({
      where: { userId, codeHash, consumedAt: null },
      data: { consumedAt: this.clock.now() },
    });
    return result.count === 1;
  }

  async regenerateRecoveryCodes(userId: string): Promise<string[]> {
    const count = this.config.mfaPolicy.recoveryCodeCount;
    const generated = Array.from({ length: count }, () => generateRecoveryCode());

    await this.prisma.$transaction([
      this.prisma.mfaRecoveryCode.deleteMany({ where: { userId } }),
      this.prisma.mfaRecoveryCode.createMany({
        data: generated.map((codeEntry) => ({ userId, codeHash: codeEntry.hash })),
      }),
    ]);

    return generated.map((codeEntry) => codeEntry.raw);
  }

  async isEnrolled(userId: string): Promise<boolean> {
    return (await this.findConfirmedAuthenticator(userId)) !== null;
  }

  async disable(userId: string): Promise<void> {
    await this.prisma.$transaction([
      this.prisma.mfaAuthenticator.deleteMany({ where: { userId } }),
      this.prisma.mfaRecoveryCode.deleteMany({ where: { userId } }),
    ]);
  }

  async remainingRecoveryCodes(userId: string): Promise<number> {
    return this.prisma.mfaRecoveryCode.count({ where: { userId, consumedAt: null } });
  }

  private async findConfirmedAuthenticator(userId: string) {
    return this.prisma.mfaAuthenticator.findFirst({
      where: { userId, confirmedAt: { not: null } },
      orderBy: { confirmedAt: 'desc' },
    });
  }

  private unseal(authenticator: {
    secretCiphertext: string;
    secretIv: string;
    secretAuthTag: string;
  }): string {
    return openSecret(
      {
        ciphertext: authenticator.secretCiphertext,
        iv: authenticator.secretIv,
        authTag: authenticator.secretAuthTag,
      },
      this.config.mfaPolicy.secretKey,
    );
  }

  /** Returns the matching time-step offset, or null when the code is wrong. */
  private validateCode(secretBase32: string, code: string): number | null {
    const normalized = code.replace(/\s/g, '');
    if (!/^\d{6}$/.test(normalized)) return null;

    return this.buildTotp(secretBase32, 'validate').validate({
      token: normalized,
      window: TOTP_WINDOW,
      timestamp: this.clock.now().getTime(),
    });
  }

  private counterFor(now: Date, delta: number): number {
    return Math.floor(now.getTime() / 1000 / TOTP_PERIOD_SECONDS) + delta;
  }

  private buildTotp(secretBase32: string, label: string): TOTP {
    return new TOTP({
      issuer: this.config.mfaPolicy.issuer,
      label,
      algorithm: 'SHA1',
      digits: TOTP_DIGITS,
      period: TOTP_PERIOD_SECONDS,
      secret: Secret.fromBase32(secretBase32),
    });
  }
}
