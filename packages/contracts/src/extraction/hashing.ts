import { canonicalizeJson, sha256Hex } from '../checks/report.js';
import { EXTRACTION_CANONICALIZATION_VERSION } from './run.js';

/**
 * Identity hashes for extraction (Phase 9, §40, §57, §120, §121, §162).
 *
 * Four questions, four hashes, and deliberately none of them mixed with
 * `StandardVersion.contentHash`. That hash means "these are the published rules
 * an institution stands behind"; nothing an extraction produced may borrow that
 * meaning, and an unaccepted proposal must never move it (§122).
 *
 * - `sourceSetHash` identifies **which documents** a run read. Built from the
 *   sources' own digests, so two runs over the same bytes agree and a run over
 *   a replaced guideline does not.
 * - `excerptHash` identifies **one piece of evidence**, so a proposal can later
 *   be shown to have rested on the text it claimed.
 * - `observationHash` does the same for a deterministic template measurement.
 * - `extractionRunHash` identifies **the finished run** — its evidence and its
 *   proposals, at their semantic content only.
 *
 * All reuse the Phase 7 RFC 8785 canonicalization, so two implementations
 * serializing the same structure get the same bytes.
 */

/** One source's contribution to the set's identity. */
export interface SourceSetEntry {
  readonly sourceAssetId: string;
  readonly sourceKind: string;
  readonly sha256: string;
}

/**
 * The hash of the exact source set a run was bound to (§36, §40).
 *
 * Sorted by the source's own digest and id rather than by upload order or row
 * order: which documents were read is meaning, and the order a query returned
 * them in is not (§161).
 */
export function computeSourceSetHash(entries: readonly SourceSetEntry[]): string {
  const canonical = [...entries]
    .map((entry) => ({
      sha256: entry.sha256,
      sourceAssetId: entry.sourceAssetId,
      sourceKind: entry.sourceKind,
    }))
    .sort((left, right) =>
      compare(`${left.sha256}:${left.sourceAssetId}`, `${right.sha256}:${right.sourceAssetId}`),
    );
  return sha256Hex(canonicalizeJson(canonical));
}

/**
 * The hash of one evidence excerpt, bound to where it came from.
 *
 * The locator is included, not just the text: the same sentence appearing on
 * two pages is two pieces of evidence, and collapsing them would lose exactly
 * the provenance this exists to preserve (§91).
 */
export function computeExcerptHash(input: {
  readonly sourceAssetId: string;
  readonly sourceSha256: string;
  readonly locatorType: string;
  readonly locator: unknown;
  readonly excerpt: string;
}): string {
  return sha256Hex(
    canonicalizeJson({
      excerpt: input.excerpt,
      locator: input.locator,
      locatorType: input.locatorType,
      sourceAssetId: input.sourceAssetId,
      sourceSha256: input.sourceSha256,
    }),
  );
}

/** The hash of one deterministic template measurement (§57). */
export function computeObservationHash(input: {
  readonly sourceAssetId: string;
  readonly sourceSha256: string;
  readonly scopeKey: string;
  readonly modalValue: string | null;
  readonly unit: string | null;
  readonly occurrenceCount: number;
  readonly matchingCount: number;
  readonly distinctValueCount: number;
}): string {
  return sha256Hex(
    canonicalizeJson({
      distinctValueCount: input.distinctValueCount,
      matchingCount: input.matchingCount,
      modalValue: input.modalValue,
      occurrenceCount: input.occurrenceCount,
      scopeKey: input.scopeKey,
      sourceAssetId: input.sourceAssetId,
      sourceSha256: input.sourceSha256,
      unit: input.unit,
    }),
  );
}

/** The semantic digest of a finished extraction run (§121, §162). */
export interface ExtractionRunDigest {
  readonly extractionCanonicalizationVersion: number;
  readonly proposalSchemaVersion: number;
  readonly standardVersionId: string;
  readonly sourceSetHash: string;
  readonly provider: string;
  readonly configuredModel: string;
  readonly promptVersion: string;
  readonly promptHash: string;
  readonly contextBuilderVersion: string;
  readonly evidence: readonly {
    readonly excerptHash: string;
    readonly evidenceKind: string;
    readonly locatorType: string;
  }[];
  readonly observations: readonly { readonly observationHash: string }[];
  readonly proposals: readonly {
    readonly proposalKey: string;
    readonly kind: string;
    readonly suggestedRuleCode: string | null;
    readonly validationStatus: string;
    readonly evidenceHashes: readonly string[];
  }[];
}

/**
 * The hash of a completed run.
 *
 * Transient facts are excluded by construction — no timestamps, no latency, no
 * provider request id — because a hash that changed when nothing meaningful did
 * could never be used to compare two runs (§162).
 */
export function computeExtractionRunHash(digest: ExtractionRunDigest): {
  hash: string;
  canonical: string;
} {
  if (digest.extractionCanonicalizationVersion !== EXTRACTION_CANONICALIZATION_VERSION) {
    throw new Error(
      `cannot hash an extraction canonicalized at version ${digest.extractionCanonicalizationVersion}`,
    );
  }
  const canonical = canonicalizeJson({
    ...digest,
    evidence: [...digest.evidence].sort((left, right) =>
      compare(left.excerptHash, right.excerptHash),
    ),
    observations: [...digest.observations].sort((left, right) =>
      compare(left.observationHash, right.observationHash),
    ),
    proposals: [...digest.proposals]
      .map((proposal) => ({
        ...proposal,
        evidenceHashes: [...proposal.evidenceHashes].sort(compare),
      }))
      .sort((left, right) => compare(left.proposalKey, right.proposalKey)),
  });
  return { hash: sha256Hex(canonical), canonical };
}

function compare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
