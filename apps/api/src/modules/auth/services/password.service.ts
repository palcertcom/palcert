import { Injectable } from '@nestjs/common';
import { Algorithm, hash, verify } from '@node-rs/argon2';
import { AppError, PalCertErrorCode } from '@palcert/contracts';
import { ApiConfigService } from '../../../config/api-config.service';
import { BreachedPasswordPort } from '../ports/breached-password.port';

/** Recorded on the user row so a policy change can trigger transparent rehash. */
export const PASSWORD_ALGORITHM = 'argon2id' as const;

@Injectable()
export class PasswordService {
  constructor(
    private readonly config: ApiConfigService,
    private readonly breachedPasswords: BreachedPasswordPort,
  ) {}

  /**
   * Validate a candidate password against policy.
   *
   * Follows NIST SP 800-63B: length is the requirement, composition rules
   * ("one uppercase, one digit, one symbol") are not. They push users toward
   * predictable substitutions without materially raising entropy.
   */
  async assertMeetsPolicy(password: string): Promise<void> {
    const { minLength, maxLength, breachedCheckEnabled } = this.config.passwordPolicy;

    // Count Unicode code points, not UTF-16 units, so an emoji or an Arabic
    // passphrase is measured the way a user perceives it.
    const length = [...password].length;

    if (length < minLength) {
      throw new AppError(PalCertErrorCode.PASSWORD_POLICY_VIOLATION, {
        message: `Password must be at least ${minLength} characters.`,
        details: { minLength },
      });
    }

    // Reject rather than silently truncate: truncation would make a long
    // password weaker than the user believes it to be.
    if (length > maxLength) {
      throw new AppError(PalCertErrorCode.PASSWORD_POLICY_VIOLATION, {
        message: `Password must be at most ${maxLength} characters.`,
        details: { maxLength },
      });
    }

    // Whitespace is permitted inside a passphrase and is never stripped, but a
    // password consisting only of whitespace is a mistake.
    if (password.trim().length === 0) {
      throw new AppError(PalCertErrorCode.PASSWORD_POLICY_VIOLATION, {
        message: 'Password must not consist only of whitespace.',
      });
    }

    if (breachedCheckEnabled && (await this.breachedPasswords.isBreached(password))) {
      throw new AppError(PalCertErrorCode.PASSWORD_POLICY_VIOLATION, {
        message: 'This password has appeared in a known data breach. Please choose another.',
        details: { reason: 'BREACHED' },
      });
    }
  }

  async hash(password: string): Promise<string> {
    const { memoryCost, timeCost, parallelism } = this.config.argon2Options;
    return hash(this.prepare(password), {
      algorithm: Algorithm.Argon2id,
      memoryCost,
      timeCost,
      parallelism,
    });
  }

  /**
   * Verify a password.
   *
   * Returns false rather than throwing on a malformed stored hash so a corrupt
   * row cannot be distinguished from a wrong password by an attacker.
   */
  async verify(storedHash: string, password: string): Promise<boolean> {
    try {
      return await verify(storedHash, this.prepare(password));
    } catch {
      return false;
    }
  }

  /**
   * True when the stored hash was produced with weaker parameters than current
   * policy, so it should be transparently upgraded on the next successful
   * login (§9).
   *
   * The parameters are read from the PHC string the hash itself carries, which
   * is why raising AUTH_ARGON2_* values silently strengthens existing accounts
   * over time instead of requiring a password reset.
   */
  needsRehash(storedHash: string): boolean {
    const parsed = parsePhcHash(storedHash);
    if (parsed === null) {
      // Unparseable or foreign format: replace it at the next opportunity.
      return true;
    }

    const { memoryCost, timeCost, parallelism } = this.config.argon2Options;
    return (
      parsed.algorithm !== 'argon2id' ||
      parsed.memoryCost < memoryCost ||
      parsed.timeCost < timeCost ||
      parsed.parallelism < parallelism
    );
  }

  /**
   * Normalize before hashing so the same passphrase typed on different
   * platforms (which may emit NFC or NFD) verifies consistently. Nothing is
   * trimmed or truncated.
   */
  private prepare(password: string): string {
    return password.normalize('NFKC');
  }
}

interface ParsedPhcHash {
  readonly algorithm: string;
  readonly memoryCost: number;
  readonly timeCost: number;
  readonly parallelism: number;
}

/**
 * Parse a PHC-format Argon2 string, e.g.
 * `$argon2id$v=19$m=19456,t=2,p=1$<salt>$<digest>`.
 *
 * Exported for test: the rehash decision is a security control and deserves
 * direct coverage rather than being inferred through hashing round-trips.
 */
export function parsePhcHash(value: string): ParsedPhcHash | null {
  const match = /^\$(argon2(?:id|i|d))\$v=\d+\$m=(\d+),t=(\d+),p=(\d+)\$/.exec(value);
  if (match === null) return null;

  return {
    algorithm: match[1]!,
    memoryCost: Number.parseInt(match[2]!, 10),
    timeCost: Number.parseInt(match[3]!, 10),
    parallelism: Number.parseInt(match[4]!, 10),
  };
}
