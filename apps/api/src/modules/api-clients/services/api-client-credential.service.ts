import { Injectable } from '@nestjs/common';
import { Algorithm, hash, verify } from '@node-rs/argon2';
import {
  API_CLIENT_ID_PREFIX,
  API_CLIENT_SECRET_BYTES,
  API_CLIENT_SECRET_PREFIX,
} from '@palcert/contracts';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { ApiConfigService } from '../../../config/api-config.service';

export interface GeneratedCredential {
  /** `pcid_` + 32 hex characters. Public, loggable, shown in every list. */
  readonly clientId: string;
  /** `pcsk_` + 64 hex characters. Returned once and never stored. */
  readonly secret: string;
  /** Argon2id PHC string. The only representation that reaches the database. */
  readonly verifier: string;
  /** First eight hex characters of the secret's random part. */
  readonly hint: string;
}

/**
 * Minting and checking machine credentials (Phase 19).
 *
 * Two decisions shape this file.
 *
 * **Argon2id, not SHA-256.** A session token is a 256-bit value PalCert itself
 * generated, so a fast digest is sound: there is nothing to guess. An API
 * secret is generated the same way — but it is *long-lived*, it is pasted into
 * customer configuration, and it will end up in a CI variable, an environment
 * file and somebody's shell history. The realistic compromise is a database
 * copy, and against that a memory-hard verifier is the difference between a
 * dump being immediately usable and being useless. The cost is real (tens of
 * milliseconds per request) and it is paid deliberately; the throttle in front
 * of it is what stops that cost becoming a denial-of-service lever.
 *
 * **Nothing here can produce a secret from storage.** There is no decrypt, no
 * unseal and no recovery path, because the verifier is one-way. "Show it to me
 * again" is not a missing feature; it is the property that makes a database
 * dump survivable.
 */
@Injectable()
export class ApiClientCredentialService {
  constructor(private readonly config: ApiConfigService) {}

  /** A fresh client id. Random rather than derived: it names nothing. */
  generateClientId(): string {
    return `${API_CLIENT_ID_PREFIX}${randomBytes(16).toString('hex')}`;
  }

  async generate(): Promise<GeneratedCredential> {
    const material = randomBytes(API_CLIENT_SECRET_BYTES).toString('hex');
    const secret = `${API_CLIENT_SECRET_PREFIX}${material}`;
    return {
      clientId: this.generateClientId(),
      secret,
      verifier: await this.hashSecret(secret),
      hint: material.slice(0, 8),
    };
  }

  async hashSecret(secret: string): Promise<string> {
    const { memoryCost, timeCost, parallelism } = this.config.argon2Options;
    return hash(secret, { algorithm: Algorithm.Argon2id, memoryCost, timeCost, parallelism });
  }

  /**
   * Does this secret match this verifier?
   *
   * Never throws for a bad secret, a malformed verifier or a corrupt row: every
   * one of those is `false`. A verification that threw would be distinguishable
   * from one that returned false — by timing, by a log line, or by a 500 where
   * a 401 belonged — and that difference is exactly what an attacker probing
   * for which client ids exist is looking for.
   */
  async verifySecret(secret: string, verifier: string): Promise<boolean> {
    try {
      return await verify(verifier, secret);
    } catch {
      return false;
    }
  }

  /**
   * Is this string shaped like a PalCert API secret at all?
   *
   * Cheap, and checked before Argon2 runs. A caller sending arbitrary garbage
   * must not be able to make PalCert spend 50ms of memory-hard work per
   * request — that would turn the security property above into a cost
   * amplifier pointed at ourselves.
   *
   * It leaks nothing: the prefix and the length are published.
   */
  looksLikeSecret(candidate: string): boolean {
    return (
      candidate.startsWith(API_CLIENT_SECRET_PREFIX) &&
      candidate.length === API_CLIENT_SECRET_PREFIX.length + API_CLIENT_SECRET_BYTES * 2 &&
      /^[0-9a-f]+$/.test(candidate.slice(API_CLIENT_SECRET_PREFIX.length))
    );
  }

  looksLikeClientId(candidate: string): boolean {
    return new RegExp(`^${API_CLIENT_ID_PREFIX}[0-9a-f]{32}$`).test(candidate);
  }

  /** Constant-time comparison, for the two places a client id is compared. */
  sameClientId(a: string, b: string): boolean {
    const left = Buffer.from(a, 'utf8');
    const right = Buffer.from(b, 'utf8');
    if (left.length !== right.length) return false;
    return timingSafeEqual(left, right);
  }
}
