/**
 * Document types (§Phase 3).
 *
 * A document type answers "what kind of document is this?" — a thesis, a
 * journal article, a grant proposal. It is deliberately split in two:
 *
 *  - `systemCategory` is a closed PalCert enum. Pipelines, extraction hints and
 *    reporting key off it, so it must be a value the platform understands.
 *  - `name` is whatever the organization calls it. One university's
 *    "Master's Dissertation" and another's "رسالة ماجستير" are both
 *    `THESIS` to the platform and both correct to their owner.
 *
 * Collapsing the two into a single free-text field would make every downstream
 * feature string-match on user input; collapsing them into a single enum would
 * force organizations to adopt PalCert's vocabulary.
 */
export const DocumentSystemCategory = {
  THESIS: 'THESIS',
  DISSERTATION: 'DISSERTATION',
  JOURNAL_ARTICLE: 'JOURNAL_ARTICLE',
  CONFERENCE_PAPER: 'CONFERENCE_PAPER',
  BOOK: 'BOOK',
  BOOK_CHAPTER: 'BOOK_CHAPTER',
  TECHNICAL_REPORT: 'TECHNICAL_REPORT',
  GRANT_PROPOSAL: 'GRANT_PROPOSAL',
  RESEARCH_PROPOSAL: 'RESEARCH_PROPOSAL',
  GRADUATION_PROJECT: 'GRADUATION_PROJECT',
  COURSE_ASSIGNMENT: 'COURSE_ASSIGNMENT',
  ADMINISTRATIVE_DOCUMENT: 'ADMINISTRATIVE_DOCUMENT',
  OTHER: 'OTHER',
} as const;

export type DocumentSystemCategory =
  (typeof DocumentSystemCategory)[keyof typeof DocumentSystemCategory];

export const DOCUMENT_SYSTEM_CATEGORIES: readonly DocumentSystemCategory[] =
  Object.values(DocumentSystemCategory);

/**
 * Lifecycle.
 *
 * Archiving rather than deleting: standards already reference the type, and
 * published standards must stay readable forever. `ARCHIVED` removes it from
 * pickers without breaking anything that points at it.
 */
export const DocumentTypeStatus = {
  ACTIVE: 'ACTIVE',
  ARCHIVED: 'ARCHIVED',
} as const;

export type DocumentTypeStatus = (typeof DocumentTypeStatus)[keyof typeof DocumentTypeStatus];

export const DOCUMENT_TYPE_STATUSES: readonly DocumentTypeStatus[] =
  Object.values(DocumentTypeStatus);

export function canTransitionDocumentTypeStatus(
  from: DocumentTypeStatus,
  to: DocumentTypeStatus,
): boolean {
  if (from === to) return false;
  // Both directions are permitted: archiving is a reversible tidying action,
  // not a destructive one.
  return true;
}

export interface DocumentTypeView {
  readonly id: string;
  readonly systemCategory: DocumentSystemCategory;
  readonly name: string;
  readonly nameAr: string | null;
  readonly description: string | null;
  readonly descriptionAr: string | null;
  readonly status: DocumentTypeStatus;
  readonly standardCount: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}
