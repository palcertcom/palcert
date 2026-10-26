/**
 * Standard source assets — the guidelines and templates an institution uploads
 * (Phase 9, §3, §5, §6, §7, §8).
 *
 * Two distinctions carry most of this phase's safety, and both live here.
 *
 * **A guideline is normative; a template is not.** A guideline *says* what is
 * required. A template merely *happens* to be formatted some way. Treating the
 * second as the first would let PalCert manufacture institutional policy out of
 * one stray caption, so the two never share a vocabulary at any layer.
 *
 * **A source belongs to an organization, not to a person.** Student documents
 * are user-private (ADR-0031); an institution's own guidelines are the
 * institution's. They are deliberately different authorization models and are
 * never mixed.
 */

/** What kind of document this is, and therefore how its content may be read. */
export const StandardSourceKind = {
  /** A normative PDF stating written requirements. */
  GUIDELINE_PDF: 'GUIDELINE_PDF',
  /** A normative Word document stating written requirements. */
  GUIDELINE_DOCX: 'GUIDELINE_DOCX',
  /**
   * A model document showing expected formatting.
   *
   * Not normative. Whatever it happens to do is an observation about one
   * document, never a statement of what the institution requires (§4).
   */
  TEMPLATE_DOCX: 'TEMPLATE_DOCX',
} as const;

export type StandardSourceKind = (typeof StandardSourceKind)[keyof typeof StandardSourceKind];

export const STANDARD_SOURCE_KINDS: readonly StandardSourceKind[] =
  Object.values(StandardSourceKind);

/** True when this kind states requirements rather than demonstrating them. */
export function isNormativeSourceKind(kind: StandardSourceKind): boolean {
  return kind === StandardSourceKind.GUIDELINE_PDF || kind === StandardSourceKind.GUIDELINE_DOCX;
}

/** The upload format each kind must actually be, checked against content (§9). */
export const SOURCE_KIND_FORMAT: Readonly<Record<StandardSourceKind, 'PDF' | 'DOCX'>> = {
  GUIDELINE_PDF: 'PDF',
  GUIDELINE_DOCX: 'DOCX',
  TEMPLATE_DOCX: 'DOCX',
};

/**
 * The lifecycle of one source.
 *
 * Identical in shape to a Phase 5 document version, because it is the same
 * secure ingestion pipeline: an organization upload must not be a weaker path
 * than a student upload (§9).
 */
export const StandardSourceStatus = {
  AWAITING_UPLOAD: 'AWAITING_UPLOAD',
  UPLOADED: 'UPLOADED',
  VALIDATING: 'VALIDATING',
  SCANNING: 'SCANNING',
  READY: 'READY',
  REJECTED: 'REJECTED',
  FAILED: 'FAILED',
  CANCELLED: 'CANCELLED',
  UPLOAD_EXPIRED: 'UPLOAD_EXPIRED',
} as const;

export type StandardSourceStatus = (typeof StandardSourceStatus)[keyof typeof StandardSourceStatus];

export const STANDARD_SOURCE_STATUSES: readonly StandardSourceStatus[] =
  Object.values(StandardSourceStatus);

export const STANDARD_SOURCE_TRANSITIONS: Readonly<
  Record<StandardSourceStatus, readonly StandardSourceStatus[]>
> = {
  AWAITING_UPLOAD: ['UPLOADED', 'CANCELLED', 'UPLOAD_EXPIRED', 'REJECTED'],
  UPLOADED: ['VALIDATING', 'SCANNING', 'READY', 'REJECTED', 'FAILED'],
  VALIDATING: ['VALIDATING', 'SCANNING', 'READY', 'REJECTED', 'FAILED'],
  SCANNING: ['SCANNING', 'READY', 'REJECTED', 'FAILED'],
  // Terminal. A replacement guideline is a new asset, never an overwrite (§8).
  READY: [],
  REJECTED: [],
  FAILED: [],
  CANCELLED: [],
  UPLOAD_EXPIRED: [],
};

export function canTransitionStandardSource(
  from: StandardSourceStatus,
  to: StandardSourceStatus,
): boolean {
  return STANDARD_SOURCE_TRANSITIONS[from].includes(to);
}

export const TERMINAL_STANDARD_SOURCE_STATUSES: readonly StandardSourceStatus[] = [
  StandardSourceStatus.READY,
  StandardSourceStatus.REJECTED,
  StandardSourceStatus.FAILED,
  StandardSourceStatus.CANCELLED,
  StandardSourceStatus.UPLOAD_EXPIRED,
];

export function isStandardSourceTerminal(status: StandardSourceStatus): boolean {
  return TERMINAL_STANDARD_SOURCE_STATUSES.includes(status);
}

/** Only a READY source may be read by anything downstream. */
export function isStandardSourceUsable(status: StandardSourceStatus): boolean {
  return status === StandardSourceStatus.READY;
}

/**
 * How much authority an institution assigns a source (§64).
 *
 * Never inferred — not from upload order, not from format, not from recency.
 * An unset priority means the institution has not said, and a conflict between
 * two sources is then a question for a person, which is the correct answer
 * (§63).
 */
export const StandardSourceAuthority = {
  PRIMARY: 'PRIMARY',
  SUPPLEMENTARY: 'SUPPLEMENTARY',
  REFERENCE: 'REFERENCE',
} as const;

export type StandardSourceAuthority =
  (typeof StandardSourceAuthority)[keyof typeof StandardSourceAuthority];

export const STANDARD_SOURCE_AUTHORITIES: readonly StandardSourceAuthority[] =
  Object.values(StandardSourceAuthority);

/**
 * The organization's agreement to external AI processing of its own documents.
 *
 * Deliberately *not* the Phase 8 personal consent: a student agreeing that
 * their thesis may be read by a provider says nothing about an institution's
 * guidelines, and an institution cannot agree on a student's behalf (§15).
 */
export const ORGANIZATION_AI_CONSENT_VERSION = '1';

export const OrganizationAIProviderCategory = {
  EXTERNAL_AI_PROVIDER: 'EXTERNAL_AI_PROVIDER',
} as const;

export type OrganizationAIProviderCategory =
  (typeof OrganizationAIProviderCategory)[keyof typeof OrganizationAIProviderCategory];
