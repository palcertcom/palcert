import { Injectable } from '@nestjs/common';
import {
  CONTENT_HASH_PREFIX,
  STANDARD_CANONICALIZATION_VERSION,
  buildCanonicalSnapshot,
  serializeCanonical,
  type CanonicalStandardInput,
} from '@palcert/contracts';
import { createHash } from 'node:crypto';

export interface CanonicalSnapshotResult {
  /** The exact object stored in `standard_version_snapshots.canonical`. */
  readonly canonical: unknown;
  /** The byte-exact serialization the hash was taken over. */
  readonly serialized: string;
  /** `sha256:<64 lowercase hex>`. */
  readonly contentHash: string;
  readonly canonicalizationVersion: number;
  readonly ruleCount: number;
}

/**
 * Turns a standard version into its canonical snapshot and content hash.
 *
 * The canonicalization itself lives in `@palcert/contracts`, deliberately:
 * it is pure, it is the part that must never drift, and keeping it there means
 * the browser and any future verifier run the *same* code rather than a
 * reimplementation. This service is the thin layer that adds the one thing
 * canonicalization cannot be: a Node hash.
 *
 * Nothing here reads the database. It is given the semantic content and returns
 * a hash — which is what makes it trivially testable and what makes the golden
 * fixtures meaningful.
 */
@Injectable()
export class StandardHasherService {
  /**
   * Compute the snapshot and hash for a version's content.
   *
   * Throws if the content cannot be canonicalized (duplicate rule codes, a
   * non-finite number). That is deliberate: a hash that cannot be reproduced is
   * worse than no hash, so publication fails loudly rather than storing one.
   */
  build(input: CanonicalStandardInput): CanonicalSnapshotResult {
    const canonical = buildCanonicalSnapshot(input);
    const serialized = serializeCanonical(canonical);

    return {
      canonical,
      serialized,
      contentHash: `${CONTENT_HASH_PREFIX}${this.sha256Hex(serialized)}`,
      canonicalizationVersion: STANDARD_CANONICALIZATION_VERSION,
      ruleCount: input.rules.length,
    };
  }

  /**
   * Recompute the hash of a stored snapshot.
   *
   * This is how a snapshot is *verified* rather than trusted: re-serialize the
   * stored object and confirm it still hashes to the recorded value. It reads
   * only the snapshot, never the live tables, so it stays valid even after the
   * standard has been superseded.
   */
  verify(canonical: unknown, expectedHash: string): boolean {
    const actual = `${CONTENT_HASH_PREFIX}${this.sha256Hex(serializeCanonical(canonical))}`;
    return actual === expectedHash;
  }

  private sha256Hex(value: string): string {
    return createHash('sha256').update(value, 'utf8').digest('hex');
  }
}
