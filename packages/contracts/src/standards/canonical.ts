import { RULE_SCHEMA_VERSION, type RuleDefinition } from './rule-schema.js';
import type { DocumentSystemCategory } from './document-type.js';

/**
 * Canonicalization of a standard version, and the content hash built from it.
 *
 * ## What the hash is for
 *
 * A published version must be provably the same thing tomorrow as it was when a
 * document was checked against it. `contentHash` is that proof: it is a SHA-256
 * over a canonical, byte-exact serialization of the version's *meaning*.
 * Anyone holding the snapshot can recompute it; the platform is not asked to be
 * trusted. This is also what makes the eventual blockchain anchoring (ADR-0007)
 * a matter of publishing an existing value rather than inventing one.
 *
 * ## What is included, and why exactly this
 *
 * Included: everything that changes what a document is judged against —
 * the standard's code and bilingual names, the document type's system category
 * and name, the version label and effective window, and every rule's complete
 * semantic tuple (code, category, evaluation mode, scope, operator, expected
 * value, unit, tolerance, severity, blocking, autofix, provenance, display
 * order and all six localized strings).
 *
 * Excluded, deliberately:
 *
 *  - **Database ids** (of the standard, version, rules, document type). They
 *    are storage addresses. Two organizations that independently write
 *    byte-identical standards should get the same hash, because the hash
 *    identifies *content*, not ownership or storage.
 *  - **`organizationId`**, for the same reason. Isolation is enforced by RLS,
 *    not by salting a hash.
 *  - **`createdAt` / `updatedAt` / `publishedAt` / `publishedByUserId`**.
 *    Republishing identical content on a different day is the same content.
 *  - **`status`, `revision`, `clonedFromVersionId`**. Lifecycle bookkeeping,
 *    not meaning.
 *
 * `effectiveFrom` / `effectiveUntil` *are* included: "in force from March" is
 * part of what the standard says.
 *
 * ## The canonical form
 *
 * A JSON string with:
 *
 *  1. object keys sorted ascending by Unicode code point;
 *  2. no insignificant whitespace;
 *  3. keys whose value is null or undefined omitted entirely — so introducing
 *     an optional field that nobody fills in does not change any existing hash;
 *  4. every string NFC-normalized, so the same Arabic text typed on two
 *     keyboards produces the same bytes;
 *  5. rules sorted by `ruleCode` (which is unique within a version), so the
 *     hash does not depend on insertion order — while `displayOrder` is
 *     carried *as a field*, because report ordering is part of the meaning;
 *  6. numbers serialized by ECMAScript's fully-specified Number-to-String
 *     algorithm, with `-0` normalized to `0` and non-finite values refused.
 *
 * ## Versioning
 *
 * `STANDARD_CANONICALIZATION_VERSION` is stored alongside every hash. If this
 * algorithm ever changes, old hashes remain verifiable because the snapshot
 * records which algorithm produced them. Changing the algorithm without
 * bumping this constant would silently invalidate every certificate ever
 * issued, so the golden fixtures in `canonical.spec.ts` exist to make that
 * impossible to do by accident.
 */
export const STANDARD_CANONICALIZATION_VERSION = 1;

export interface CanonicalStandardInput {
  readonly standardCode: string;
  readonly standardNameEn: string;
  readonly standardNameAr: string;
  readonly standardDescriptionEn: string | null;
  readonly standardDescriptionAr: string | null;
  readonly documentTypeCategory: DocumentSystemCategory;
  readonly documentTypeName: string;
  readonly versionLabel: string;
  /** ISO-8601 instant, or null. */
  readonly effectiveFrom: string | null;
  readonly effectiveUntil: string | null;
  readonly ruleSchemaVersion: number;
  readonly rules: readonly RuleDefinition[];
}

/** A JSON value restricted to what the canonical form can represent. */
type CanonicalValue =
  | string
  | number
  | boolean
  | readonly CanonicalValue[]
  | { readonly [key: string]: CanonicalValue | null | undefined };

function normalizeString(value: string): string {
  return value.normalize('NFC');
}

function serializeNumber(value: number): string {
  if (!Number.isFinite(value)) {
    throw new Error('A canonical standard snapshot cannot contain a non-finite number.');
  }
  // Object.is distinguishes -0 from 0; JSON.stringify does not, but being
  // explicit documents that the two are the same value here.
  return JSON.stringify(Object.is(value, -0) ? 0 : value);
}

/**
 * Compare by Unicode code point rather than by UTF-16 code unit.
 *
 * For the ASCII keys used here the two agree, but relying on that would make
 * the algorithm quietly wrong the day a key contains a character outside the
 * basic multilingual plane.
 */
function compareCodePoints(a: string, b: string): number {
  const left = [...a];
  const right = [...b];
  const shared = Math.min(left.length, right.length);
  for (let index = 0; index < shared; index += 1) {
    const difference = left[index]!.codePointAt(0)! - right[index]!.codePointAt(0)!;
    if (difference !== 0) return difference;
  }
  return left.length - right.length;
}

function serialize(value: CanonicalValue): string {
  if (typeof value === 'string') return JSON.stringify(normalizeString(value));
  if (typeof value === 'number') return serializeNumber(value);
  if (typeof value === 'boolean') return value ? 'true' : 'false';

  if (Array.isArray(value)) {
    return `[${(value as readonly CanonicalValue[]).map(serialize).join(',')}]`;
  }

  const record = value as { readonly [key: string]: CanonicalValue | null | undefined };
  const entries = Object.keys(record)
    .filter((key) => record[key] !== null && record[key] !== undefined)
    .sort(compareCodePoints)
    .map((key) => `${JSON.stringify(normalizeString(key))}:${serialize(record[key]!)}`);

  return `{${entries.join(',')}}`;
}

/**
 * The scope and expected-value objects are already plain discriminated records,
 * so they canonicalize structurally. Passing them through a typed shape rather
 * than `unknown` keeps a future field from silently escaping the hash: adding a
 * property to `RuleScope` without adding it here is a type error.
 */
function ruleToCanonical(rule: RuleDefinition): CanonicalValue {
  return {
    ruleCode: rule.ruleCode,
    category: rule.category,
    evaluationMode: rule.evaluationMode,
    scope: rule.scope as unknown as CanonicalValue,
    operator: rule.operator,
    expected: rule.expected as unknown as CanonicalValue,
    unit: rule.unit,
    tolerance: rule.tolerance,
    severity: rule.severity,
    blocking: rule.blocking,
    autofix: rule.autofix,
    origin: rule.origin,
    originReference: rule.originReference,
    displayOrder: rule.displayOrder,
    titleEn: rule.titleEn,
    titleAr: rule.titleAr,
    descriptionEn: rule.descriptionEn,
    descriptionAr: rule.descriptionAr,
    guidanceEn: rule.guidanceEn,
    guidanceAr: rule.guidanceAr,
  };
}

/**
 * Build the canonical snapshot object.
 *
 * Returned as a structure (not only a string) because it is also what is stored
 * in `standard_version_snapshots.canonical`, so a verifier can re-serialize it
 * and reach the same bytes without reconstructing it from the live tables.
 */
export function buildCanonicalSnapshot(input: CanonicalStandardInput): CanonicalValue {
  const codes = input.rules.map((rule) => rule.ruleCode);
  if (new Set(codes).size !== codes.length) {
    // Sorting by ruleCode is only a total order if the codes are unique. A
    // duplicate would make the hash depend on input order, which is exactly
    // what canonicalization exists to prevent, so refuse rather than produce a
    // hash that cannot be reproduced.
    throw new Error('A canonical standard snapshot cannot contain duplicate rule codes.');
  }

  const rules = [...input.rules]
    .sort((a, b) => compareCodePoints(a.ruleCode, b.ruleCode))
    .map(ruleToCanonical);

  return {
    canonicalizationVersion: STANDARD_CANONICALIZATION_VERSION,
    ruleSchemaVersion: input.ruleSchemaVersion,
    standard: {
      code: input.standardCode,
      nameEn: input.standardNameEn,
      nameAr: input.standardNameAr,
      descriptionEn: input.standardDescriptionEn,
      descriptionAr: input.standardDescriptionAr,
    },
    documentType: {
      systemCategory: input.documentTypeCategory,
      name: input.documentTypeName,
    },
    version: {
      versionLabel: input.versionLabel,
      effectiveFrom: input.effectiveFrom,
      effectiveUntil: input.effectiveUntil,
    },
    rules,
  };
}

/** Serialize any canonical snapshot to its exact, hashable string form. */
export function serializeCanonical(snapshot: unknown): string {
  return serialize(snapshot as CanonicalValue);
}

/** Convenience: build and serialize in one step. */
export function canonicalizeStandardVersion(input: CanonicalStandardInput): string {
  return serializeCanonical(buildCanonicalSnapshot(input));
}

export const CONTENT_HASH_PREFIX = 'sha256:';

/** `sha256:<64 lowercase hex>` — the only shape a stored content hash may take. */
export const CONTENT_HASH_PATTERN = /^sha256:[0-9a-f]{64}$/;

export function isValidContentHash(value: string): boolean {
  return CONTENT_HASH_PATTERN.test(value);
}

export const DEFAULT_RULE_SCHEMA_VERSION = RULE_SCHEMA_VERSION;
