import type { StandardCheckAvailability } from '../checks/check.js';
import type { DocumentSystemCategory } from './document-type.js';
import type { StandardImportProvenanceView } from './portable.js';

/**
 * Standards and standard versions.
 *
 * ## Why identity and content are separate rows
 *
 * A `Standard` is the *stable identity* of a set of requirements — "IUG
 * Master's Thesis Formatting". A `StandardVersion` is one concrete, dated
 * expression of it. Submissions, findings and certificates always reference a
 * version, never the standard, because a certificate that says "complies with
 * IUG Thesis Formatting" is worthless a year later when the requirements have
 * changed. The standard is what people talk about; the version is what was
 * actually checked.
 *
 * `versionLabel` ("1.0", "2026 revision") is therefore a *label*, not an
 * identity: it is unique within its standard so humans can refer to it, but the
 * system never resolves anything by it.
 */
export const StandardStatus = {
  ACTIVE: 'ACTIVE',
  ARCHIVED: 'ARCHIVED',
} as const;

export type StandardStatus = (typeof StandardStatus)[keyof typeof StandardStatus];

export const STANDARD_STATUSES: readonly StandardStatus[] = Object.values(StandardStatus);

export function canTransitionStandardStatus(from: StandardStatus, to: StandardStatus): boolean {
  return from !== to;
}

/**
 * Version lifecycle.
 *
 *     DRAFT ──publish──> PUBLISHED ──publish a successor──> SUPERSEDED
 *       │                    │
 *       │                    └──archive──> ARCHIVED
 *       └───────archive──────────────────> ARCHIVED
 *
 * Four states, and exactly one of them in force:
 *
 *  - **DRAFT** — editable, never used to judge a document.
 *  - **PUBLISHED** — the single version currently in force. The database holds
 *    at most one per standard.
 *  - **SUPERSEDED** — was in force, and was replaced when a newer version was
 *    published. Publishing the successor supersedes it in the same
 *    transaction, so a standard never has two versions in force and never
 *    passes through having none. It is history, not a mistake: checks,
 *    reports and certificates that captured it keep resolving to it, its
 *    snapshot and hash are unchanged, and it can still be cloned.
 *  - **ARCHIVED** — deliberately retired by an administrator.
 *
 * Deliberate absences:
 *
 *  - **No PUBLISHED → DRAFT.** A published version has been used to judge real
 *    documents. Editing it in place would silently change what a past result
 *    meant. The supported route is clone → edit the new draft → publish.
 *  - **No SUPERSEDED → PUBLISHED.** Going back to an old version is done by
 *    cloning it into a new draft and publishing that, so the audit trail shows
 *    a new decision rather than a resurrected snapshot.
 *  - **No SUPERSEDED → ARCHIVED, and no ARCHIVED → anything.** Both are
 *    terminal; reviving or relabelling history would make "which version was
 *    in force on that date?" unanswerable.
 *  - **No deletion of a published version at all**, at either layer.
 */
export const StandardVersionStatus = {
  DRAFT: 'DRAFT',
  PUBLISHED: 'PUBLISHED',
  SUPERSEDED: 'SUPERSEDED',
  ARCHIVED: 'ARCHIVED',
} as const;

export type StandardVersionStatus =
  (typeof StandardVersionStatus)[keyof typeof StandardVersionStatus];

export const STANDARD_VERSION_STATUSES: readonly StandardVersionStatus[] =
  Object.values(StandardVersionStatus);

const VERSION_TRANSITIONS: Readonly<
  Record<StandardVersionStatus, readonly StandardVersionStatus[]>
> = {
  DRAFT: [StandardVersionStatus.PUBLISHED, StandardVersionStatus.ARCHIVED],
  // SUPERSEDED is reached only by publishing a successor, never by request.
  PUBLISHED: [StandardVersionStatus.SUPERSEDED, StandardVersionStatus.ARCHIVED],
  SUPERSEDED: [],
  ARCHIVED: [],
};

export function canTransitionStandardVersionStatus(
  from: StandardVersionStatus,
  to: StandardVersionStatus,
): boolean {
  return VERSION_TRANSITIONS[from]?.includes(to) ?? false;
}

/** True when the version's rules and metadata may still be edited. */
export function standardVersionIsEditable(status: StandardVersionStatus): boolean {
  return status === StandardVersionStatus.DRAFT;
}

/**
 * True when the version may be chosen for a *new* check. Only the version in
 * force qualifies; a superseded or archived version stays readable for the
 * checks that already captured it, but is never picked again.
 */
export function standardVersionIsUsable(status: StandardVersionStatus): boolean {
  return status === StandardVersionStatus.PUBLISHED;
}

/**
 * True when the version was published at some point and therefore carries an
 * immutable snapshot and hash: the version in force, or history.
 */
export function standardVersionWasPublished(
  status: StandardVersionStatus,
  publishedAt: string | null,
): boolean {
  return (
    status === StandardVersionStatus.PUBLISHED ||
    status === StandardVersionStatus.SUPERSEDED ||
    (status === StandardVersionStatus.ARCHIVED && publishedAt !== null)
  );
}

export const STANDARD_CODE_PATTERN = /^[A-Z][A-Z0-9]*(?:[._-][A-Z0-9]+)*$/;
export const STANDARD_CODE_MAX_LENGTH = 64;

export function isValidStandardCode(value: string): boolean {
  return value.length <= STANDARD_CODE_MAX_LENGTH && STANDARD_CODE_PATTERN.test(value);
}

/**
 * A version label is free-form because organizations number things in ways no
 * pattern predicts ("1.0", "2026-A", "Third edition"). It is constrained only
 * in length and in being plain text.
 */
export const VERSION_LABEL_MAX_LENGTH = 40;

export interface StandardView {
  readonly id: string;
  readonly documentTypeId: string;
  readonly documentTypeName: string;
  readonly documentTypeCategory: DocumentSystemCategory;
  readonly code: string;
  readonly nameEn: string;
  readonly nameAr: string;
  readonly descriptionEn: string | null;
  readonly descriptionAr: string | null;
  readonly status: StandardStatus;
  /**
   * Whether anyone outside the organization may check a document against this
   * standard. PRIVATE by default, and never changed by a migration (§16).
   */
  readonly checkAvailability: StandardCheckAvailability;
  readonly versionCount: number;
  /** The most recently published version, or null when none exists yet. */
  readonly publishedVersionId: string | null;
  readonly publishedVersionLabel: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface StandardVersionView {
  readonly id: string;
  readonly standardId: string;
  readonly versionLabel: string;
  readonly status: StandardVersionStatus;
  readonly effectiveFrom: string | null;
  readonly effectiveUntil: string | null;
  readonly ruleCount: number;
  /** `sha256:<hex>` over the canonical snapshot. Null until published. */
  readonly contentHash: string | null;
  readonly canonicalizationVersion: number | null;
  readonly ruleSchemaVersion: number;
  /**
   * Optimistic-concurrency token. Returned as the `ETag` of every version read
   * and required as `If-Match` on every edit.
   */
  readonly revision: number;
  readonly publishedAt: string | null;
  readonly publishedByUserId: string | null;
  readonly archivedAt: string | null;
  /** When publishing a newer version replaced this one. Null unless SUPERSEDED. */
  readonly supersededAt: string | null;
  /** The version that replaced this one. Null unless SUPERSEDED. */
  readonly supersededByVersionId: string | null;
  readonly supersededByVersionLabel: string | null;
  readonly clonedFromVersionId: string | null;
  /** Where this version was imported from, when it came from a portable package. */
  readonly importProvenance: StandardImportProvenanceView | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/**
 * What an organization can see that relies on a version: submissions made to
 * it and the certificates it issued. Individual checks belong to the people
 * who ran them and are never counted here.
 */
export interface StandardVersionUsageView {
  readonly standardVersionId: string;
  /** Submission revisions, handed over for review, that were checked against it. */
  readonly submissionCount: number;
  /** Certificates issued on those submissions, revoked ones included. */
  readonly certificateCount: number;
}

/** Result of validating a whole draft, as returned by the dry-run endpoint. */
export interface StandardVersionValidationView {
  readonly valid: boolean;
  readonly ruleCount: number;
  readonly issues: readonly {
    readonly ruleCode: string | null;
    readonly path: string;
    readonly code: string;
    readonly message: string;
  }[];
}
