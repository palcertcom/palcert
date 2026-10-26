/* eslint-disable */
/**
 * GENERATED FILE — DO NOT EDIT.
 *
 * Source: contracts/schemas/analysis-artifact.schema.json
 * Regenerate: pnpm --filter @palcert/contracts run generate:evaluation
 *
 * Editing this by hand would reintroduce exactly the drift the generation step
 * exists to prevent.
 */
/**
 * This interface was referenced by `PalCertAnalysisArtifact`'s JSON-Schema
 * via the `definition` "Sha256Hex".
 */
export type Sha256Hex = string;
/**
 * Closed set. Downstream code must never parse warning prose, because there is none to parse.
 *
 * Phase 13 adds the PDF_* codes. Extending the enum is additive and deliberately not a schema version bump: every artifact written before Phase 13 contains only codes this set still holds, so historical DOCX artifacts stay valid and their hashes stay correct.
 *
 * This interface was referenced by `PalCertAnalysisArtifact`'s JSON-Schema
 * via the `definition` "AnalysisWarningCode".
 */
export type AnalysisWarningCode =
  | 'STYLE_PARENT_MISSING'
  | 'STYLE_CYCLE'
  | 'STYLE_CHAIN_TOO_DEEP'
  | 'THEME_MISSING'
  | 'THEME_REFERENCE_UNRESOLVED'
  | 'NUMBERING_REFERENCE_MISSING'
  | 'NUMBERING_PART_MISSING'
  | 'RELATIONSHIP_TARGET_MISSING'
  | 'UNSUPPORTED_MARKUP'
  | 'ALTERNATE_CONTENT_FALLBACK_USED'
  | 'ALTERNATE_CONTENT_BRANCH_SELECTED'
  | 'TABLE_STYLE_PARTIAL'
  | 'TABLE_STYLE_CONDITIONAL_IGNORED'
  | 'LAYOUT_NOT_RENDERED'
  | 'APPLICATION_DEFAULT_UNRESOLVED'
  | 'MIRRORED_MARGINS_PAGE_SIDE_UNKNOWN'
  | 'PART_UNREADABLE'
  | 'NODE_ID_TRUNCATED'
  | 'FIELD_INSTRUCTION_UNPARSED'
  | 'CAPTION_DETECTION_PARTIAL'
  | 'REVISION_MARKUP_PARTIAL'
  | 'METADATA_PART_MISSING'
  | 'LEGACY_EQUATION_SEMANTICS_UNAVAILABLE'
  | 'PDF_TEXT_MAPPING_INCOMPLETE'
  | 'PDF_UNTAGGED'
  | 'PDF_PAGE_BOX_INVALID'
  | 'PDF_FONT_IDENTITY_UNRESOLVED'
  | 'PDF_FONT_SUBSTITUTION_POSSIBLE'
  | 'PDF_READING_ORDER_DERIVED'
  | 'PDF_LAYOUT_PARTIAL'
  | 'PDF_IMAGE_ONLY_PAGE'
  | 'PDF_HYBRID_TEXT_LAYER'
  | 'PDF_ACTIVE_CONTENT_PRESENT'
  | 'PDF_ATTACHMENT_PRESENT'
  | 'PDF_XFA_PRESENT'
  | 'PDF_SIGNATURE_PRESENT'
  | 'PDF_UNSUPPORTED_OBJECT'
  | 'PDF_RENDER_LIMIT_REACHED'
  | 'PDF_ENCRYPTED_DOCUMENT'
  | 'PDF_METADATA_CONFLICT'
  | 'PDF_FORM_DEPTH_LIMIT_REACHED'
  | 'PDF_OBJECT_LIMIT_REACHED';
/**
 * The WordprocessingML story the evidence came from. Absent for PDF evidence, which has pages rather than stories.
 */
export type CitationEvidenceStory =
  'MAIN_DOCUMENT' | 'HEADER' | 'FOOTER' | 'FOOTNOTE' | 'ENDNOTE' | 'TEXTBOX';
/**
 * How the observation was obtained. OOXML is read from markup; PDF_TEXT and PDF_LAYOUT are the Phase 13 extraction and grouping layers; HEURISTIC is PalCert classifying rather than reading, and is the value that keeps such evidence out of the deterministic projector.
 *
 * This interface was referenced by `PalCertAnalysisArtifact`'s JSON-Schema
 * via the `definition` "CitationSourceKind".
 */
export type CitationSourceKind = 'OOXML' | 'PDF_TEXT' | 'PDF_LAYOUT' | 'HEURISTIC';
/**
 * This interface was referenced by `PalCertAnalysisArtifact`'s JSON-Schema
 * via the `definition` "CitationParseStatus".
 */
export type CitationParseStatus = 'PARSED' | 'PARTIAL' | 'UNPARSED';
/**
 * A graded answer from a heuristic, as a decimal string between 0 and 1.
 *
 * Optional everywhere and forbidden for exact extraction: inventing 1.0 for an OOXML field read would make a meaningless number look like a measured one, which is the same rule `FactProvenance.confidence` states in evaluation.schema.json.
 *
 * Enforced, not merely stated: the semantic integrity pass rejects a confidence on any observation whose `sourceKind` is not HEURISTIC. It lives there rather than in a schema conditional so that a malformed artifact is reported by code alongside the other graph defects, in one place, in both runtimes.
 *
 * This interface was referenced by `PalCertAnalysisArtifact`'s JSON-Schema
 * via the `definition` "CitationConfidence".
 */
export type CitationConfidence = string;
/**
 * This interface was referenced by `PalCertAnalysisArtifact`'s JSON-Schema
 * via the `definition` "CitationIdentifierScheme".
 */
export type CitationIdentifierScheme = 'DOI' | 'ISBN' | 'ISSN' | 'URL';
/**
 * What marked the span as this identifier class. NONE is never projected and exists so a bare candidate can still be recorded as evidence.
 */
export type CitationIdentifierIntent = 'LABEL_PREFIX' | 'RESOLVER_HOST' | 'URL_SCHEME' | 'NONE';
export type CitationIdentifierBoundaryStatus = 'UNAMBIGUOUS' | 'AMBIGUOUS';
export type CitationIdentifierSyntaxStatus = 'VALID' | 'INVALID' | 'AMBIGUOUS' | 'NOT_CHECKED';
export type CitationKind =
  'WORD_NATIVE_FIELD' | 'NUMERIC_LABEL' | 'AUTHOR_DATE' | 'NOTE_MARKER' | 'UNKNOWN';
export type CitationParseMethod =
  'FIELD_INSTRUCTION' | 'LABEL_PATTERN' | 'AUTHOR_DATE_PATTERN' | 'NONE';
export type CitationResolutionStatus = 'LINKED' | 'AMBIGUOUS' | 'UNRESOLVED' | 'NOT_ATTEMPTED';
/**
 * Present only when `sourceKind` is HEURISTIC.
 */
export type CitationConfidence1 = string;
export type ReferenceParseMethod =
  | 'WORD_BIBLIOGRAPHY_FIELD'
  | 'WORD_BIBLIOGRAPHY_STYLE'
  | 'REGION_MEMBERSHIP'
  | 'LAYOUT_BLOCK'
  | 'NONE';
/**
 * Present only when `sourceKind` is HEURISTIC.
 */
export type CitationConfidence2 = string;
/**
 * DUPLICATE_CONFIRMED requires exact identity — an equal normalized DOI or ISBN, identical conservatively-normalized rendered text, or one exact Word source — and must name the `duplicateOf` it was confirmed against. POSSIBLE_DUPLICATE is advisory, never becomes a fact, and deliberately need not name one: it may stand for several plausible candidates, and choosing between them is exactly what PalCert declines to do.
 */
export type ReferenceDuplicateStatus = 'NONE' | 'POSSIBLE_DUPLICATE' | 'DUPLICATE_CONFIRMED';
/**
 * What the entries look like. NUMBERED is `[1] Smith, J.`; VANCOUVER is `1. Smith J, Jones A.`; AUTHOR_YEAR is `Smith, J. (2020).` The family is recorded rather than scored: a confidence says how much evidence there was, not what kind.
 */
export type ReferenceRegionFamily = 'NUMBERED' | 'VANCOUVER' | 'AUTHOR_YEAR';
/**
 * Present only when `sourceKind` is HEURISTIC.
 */
export type CitationConfidence3 = string;
export type CitationLinkStatus = 'LINKED' | 'AMBIGUOUS' | 'UNRESOLVED';
/**
 * The exact identity that established, or was attempted for, this link. Every value names a real attempt: there is no NONE, because a link row exists only when linking was attempted. A citation nobody tried to link has no link row at all and carries `resolutionStatus: NOT_ATTEMPTED`; an attempt that found nothing keeps the method it tried and reports `UNRESOLVED`, which is what makes 'we looked and found nothing' distinguishable from 'we never looked'.
 *
 * INTERNAL_DESTINATION means an explicit document-native link whose internal destination resolves to a *declared* reference entry — a PDF `/Link` annotation bound to its citation through the structure tree, whose `/GoTo` destination resolves to one entry the author tagged. It does not mean that a document contains a destination somewhere near some text: a destination that lands on no declared entry is UNRESOLVED, and one that lands on several is AMBIGUOUS. The other five values are unchanged and mean exactly what they meant before.
 */
export type CitationLinkMethod =
  | 'NATIVE_TAG'
  | 'DOI_IDENTITY'
  | 'NUMERIC_LABEL'
  | 'AUTHOR_YEAR_UNIQUE'
  | 'STRUCTURED_TUPLE'
  | 'INTERNAL_DESTINATION';
export type CitationCoverageDomain =
  | 'NATIVE_CITATIONS'
  | 'NATIVE_BIBLIOGRAPHY_SOURCES'
  | 'NATIVE_SOURCE_RESOLUTION'
  | 'SEMANTIC_CITATIONS'
  | 'SEMANTIC_REFERENCE_ENTRIES'
  | 'REFERENCE_REGION';
/**
 * Why a domain is not complete. Closed set: an evidence panel translates these, so there is no prose to translate.
 */
export type CitationCoverageReasonCode =
  | 'SEMANTIC_CLASSIFICATION_NOT_EXHAUSTIVE'
  | 'FORMAT_HAS_NO_NATIVE_CITATIONS'
  | 'SOURCE_STORE_UNREADABLE'
  | 'SOURCE_STORE_ABSENT'
  | 'STORY_PART_UNREADABLE'
  | 'MARKUP_ALTERNATIVE_SELECTED'
  | 'LIMIT_TRUNCATED'
  | 'DUPLICATE_SOURCE_TAGS'
  | 'NO_TEXT_LAYER'
  | 'NOT_IMPLEMENTED';
export type CitationTruncationFlag =
  'CITATIONS' | 'REFERENCES' | 'BIBLIOGRAPHY_SOURCES' | 'LINKS' | 'REFERENCE_REGION';
/**
 * One analysis, serialized. Consumers read `factSet`; `structuralModel` exists for SmartFix and support and is not interpreted by the rule engine.
 *
 * This interface was referenced by `PalCertAnalysisArtifact`'s JSON-Schema
 * via the `definition` "AnalysisArtifact".
 */
export type AnalysisArtifact = {
  [k: string]: unknown;
};

/**
 * The envelope a DOCX analysis produces (Phase 6) and a check consumes (Phase 7).
 *
 * Phase 6 left this shape defined only in Python, which meant Node had to parse whatever dictionaries it happened to receive. That is exactly the drift the single-schema strategy exists to prevent, so the envelope is now a shared contract validated by both runtimes against the same fixtures.
 *
 * The structural model is deliberately loose here: it is rich, analyzer-specific and for SmartFix and debugging, and pinning every field of it in a cross-language contract would make every analyzer improvement a contract change. What *is* pinned is everything a consumer depends on — the versions, the source identity, the fact set and the warnings.
 */
export interface PalCertAnalysisArtifact {
  [k: string]: unknown;
}
/**
 * Which analyzer produced this. The version is semantic and deliberately not a git commit: a stored artifact is interpreted through it for ever.
 *
 * This interface was referenced by `PalCertAnalysisArtifact`'s JSON-Schema
 * via the `definition` "AnalyzerInfo".
 */
export interface AnalyzerInfo {
  name: string;
  version: string;
}
/**
 * What was analyzed. `sha256` is the digest the analyzer verified the bytes against before believing anything.
 *
 * This interface was referenced by `PalCertAnalysisArtifact`'s JSON-Schema
 * via the `definition` "AnalysisSource".
 */
export interface AnalysisSource {
  documentId: string;
  sha256: Sha256Hex;
}
/**
 * A coded condition that reduced what the analyzer could see. `detail` carries identifiers — style ids, part names, counts — and never document text.
 *
 * This interface was referenced by `PalCertAnalysisArtifact`'s JSON-Schema
 * via the `definition` "AnalysisWarning".
 */
export interface AnalysisWarning {
  code: AnalysisWarningCode;
  detail: {
    [k: string]: string;
  };
}
/**
 * Where one piece of citation evidence was observed.
 *
 * The same shape as the Phase 4 fact location, narrowed to what citation evidence can honestly carry. `nodeId` is the only required locator, as there. `page` is present only when the extractor genuinely knew it — structural DOCX analysis never does, and inventing one would make a PDF-shaped promise about a DOCX. `story` says which WordprocessingML story the evidence came from, because a citation in a footnote is not a citation in the body and a rule that conflated them would be answering a different question.
 *
 * No XPath, no caller-supplied selector: `path` is the analyzer's own bounded node path, exactly as in `evaluation.schema.json`.
 *
 * This interface was referenced by `PalCertAnalysisArtifact`'s JSON-Schema
 * via the `definition` "CitationEvidenceLocation".
 */
export interface CitationEvidenceLocation {
  locationSchemaVersion: number;
  nodeId: string;
  /**
   * @maxItems 32
   */
  path?: string[];
  page?: number;
  ordinal?: number;
  story?: CitationEvidenceStory;
}
/**
 * One identifier observed in a reference entry or a Word source.
 *
 * `raw` is what was written, kept verbatim so a normalization decision is always auditable. `normalized` is the identity value — for a DOI written as a resolver URL, `raw` is `https://doi.org/10.1234/abc` and `normalized` is the DOI core `10.1234/abc`, because the Phase 4 DOI matcher expects the core and would reject the URL.
 *
 * `intentEvidence` is what made PalCert treat the span as this identifier class at all: a `doi:` label, a `doi.org` host, an `ISBN` prefix, a URL scheme. Without it a permissive pattern match is a guess, and a guess is not an identifier.
 *
 * `boundaryStatus` records whether the end of the value was determinable. A DOI suffix may legitimately contain and end with `.`, `,`, `;`, `)` or `]`, so a candidate ending in one of those is AMBIGUOUS: PalCert cannot tell content from sentence punctuation and does not guess. `syntaxStatus` is an offline syntax check only — no resolver, no network, and never a statement that the identifier exists.
 *
 * This interface was referenced by `PalCertAnalysisArtifact`'s JSON-Schema
 * via the `definition` "CitationIdentifier".
 */
export interface CitationIdentifier {
  scheme: CitationIdentifierScheme;
  raw: string;
  normalized?: string;
  intentEvidence: CitationIdentifierIntent;
  boundaryStatus: CitationIdentifierBoundaryStatus;
  syntaxStatus: CitationIdentifierSyntaxStatus;
}
/**
 * One author as observed. `raw` is what the document says; `normalizedFamily` is the identity token used for exact author-year linking, with particles kept attached — splitting `van Dijk` into `Dijk` is how a match is lost. `corporate` marks an organisational author, which has no family/given split to make.
 *
 * This interface was referenced by `PalCertAnalysisArtifact`'s JSON-Schema
 * via the `definition` "CitationAuthorToken".
 */
export interface CitationAuthorToken {
  raw: string;
  normalizedFamily?: string;
  corporate: boolean;
}
/**
 * One citation as it appears in the document.
 *
 * Artifact evidence. Being here does not make it deterministic rule evidence: only the projector allow-list decides that, and in Phase 18 v1 no field of this object is projected.
 *
 * This interface was referenced by `PalCertAnalysisArtifact`'s JSON-Schema
 * via the `definition` "CitationOccurrence".
 */
export interface CitationOccurrence {
  /**
   * Artifact-local identity, namespaced so a link can never point at the wrong collection.
   */
  id: string;
  ordinal: number;
  sourceKind: CitationSourceKind;
  citationKind: CitationKind;
  parseMethod: CitationParseMethod;
  parseStatus: CitationParseStatus;
  location: CitationEvidenceLocation;
  rawText: string;
  normalizedText?: string;
  /**
   * The Word citation tag, kept only here: it is user content and never reaches a fact, a report or a log.
   */
  nativeTag?: string;
  /**
   * Identifiers the citation's **own text** states, most often a DOI in a footnote-style reference.
   *
   * The same `CitationIdentifier` a reference entry carries, deliberately: a DOI is a DOI wherever it is written, and a second representation for the citation side would give the same value two shapes and two normalizations. `DOI_IDENTITY` compares the `normalized` field of one of these against the `normalized` field of a reference entry's, which is only possible because they are the same object.
   *
   * Read from the occurrence's own `rawText` and nowhere else. A DOI in the surrounding paragraph belongs to the paragraph; assigning it to the nearest citation would be proximity standing in for evidence, which is the guess this whole section exists to refuse.
   *
   * Optional and absent by default, so every artifact written before it existed stays valid.
   *
   * @maxItems 6
   */
  identifiers?:
    | []
    | [CitationIdentifier]
    | [CitationIdentifier, CitationIdentifier]
    | [CitationIdentifier, CitationIdentifier, CitationIdentifier]
    | [CitationIdentifier, CitationIdentifier, CitationIdentifier, CitationIdentifier]
    | [
        CitationIdentifier,
        CitationIdentifier,
        CitationIdentifier,
        CitationIdentifier,
        CitationIdentifier,
      ]
    | [
        CitationIdentifier,
        CitationIdentifier,
        CitationIdentifier,
        CitationIdentifier,
        CitationIdentifier,
        CitationIdentifier,
      ];
  /**
   * @maxItems 50
   */
  numericLabels?: number[];
  numericLabelsRaw?: string;
  /**
   * @maxItems 8
   */
  authorTokens?:
    | []
    | [string]
    | [string, string]
    | [string, string, string]
    | [string, string, string, string]
    | [string, string, string, string, string]
    | [string, string, string, string, string, string]
    | [string, string, string, string, string, string, string]
    | [string, string, string, string, string, string, string, string];
  yearToken?: string;
  locatorPresent?: boolean;
  targetCount: number;
  resolutionStatus: CitationResolutionStatus;
  confidence?: CitationConfidence1;
  truncated: boolean;
}
/**
 * One *rendered* reference entry, as observed in the document.
 *
 * Deliberately not a `BibliographySource`: a Word source is a record in a data store, and this is text somebody can read on a page. A source may be uncited, unrendered, or rendered differently, and a rendered entry may have no source at all. Conflating the two would make both meaningless.
 *
 * Artifact evidence, never deterministic rule evidence in Phase 18 v1: the element identity of a rendered entry is established by classification, and coverage cannot repair a wrong element identity.
 *
 * This interface was referenced by `PalCertAnalysisArtifact`'s JSON-Schema
 * via the `definition` "ReferenceEntry".
 */
export interface ReferenceEntry {
  id: string;
  ordinal: number;
  sourceKind: CitationSourceKind;
  location: CitationEvidenceLocation;
  rawText: string;
  normalizedText?: string;
  label?: number;
  labelRaw?: string;
  parseMethod: ReferenceParseMethod;
  parseStatus: CitationParseStatus;
  confidence?: CitationConfidence2;
  /**
   * @maxItems 6
   */
  identifiers:
    | []
    | [CitationIdentifier]
    | [CitationIdentifier, CitationIdentifier]
    | [CitationIdentifier, CitationIdentifier, CitationIdentifier]
    | [CitationIdentifier, CitationIdentifier, CitationIdentifier, CitationIdentifier]
    | [
        CitationIdentifier,
        CitationIdentifier,
        CitationIdentifier,
        CitationIdentifier,
        CitationIdentifier,
      ]
    | [
        CitationIdentifier,
        CitationIdentifier,
        CitationIdentifier,
        CitationIdentifier,
        CitationIdentifier,
        CitationIdentifier,
      ];
  /**
   * @maxItems 32
   */
  authors: CitationAuthorToken[];
  year?: string;
  title?: string;
  containerTitle?: string;
  volume?: string;
  issue?: string;
  pages?: string;
  articleNumber?: string;
  publisher?: string;
  duplicateOf?: string;
  duplicateStatus: ReferenceDuplicateStatus;
  citedByCount: number;
  /**
   * The `ReferenceRegion` this entry was segmented from, when one was. Absent on an entry the author declared, which belongs to a structure tree rather than to a discovered region. A reader uses it to see which population a numeric link chose from, which is the whole difference between a document with one bibliography and a document with several.
   */
  regionOrdinal?: number;
  truncated: boolean;
}
/**
 * One stretch of the document that was read as a reference list.
 *
 * A document may have several — per-chapter bibliographies, an appendix with its own sources, a collection of articles — and they are never merged: label `[1]` in chapter two names a different work than label `[1]` in chapter one, and a document-wide index would report both as confidently resolved to whichever entry came first.
 *
 * Evidence, never authority. A region discovered here never emits `referenceRegionPresent`; that property stays exact-only.
 *
 * This interface was referenced by `PalCertAnalysisArtifact`'s JSON-Schema
 * via the `definition` "ReferenceRegion".
 */
export interface ReferenceRegion {
  /**
   * Position in reading order, from 1. Stable across reruns of the same bytes.
   */
  ordinal: number;
  sourceKind: CitationSourceKind;
  family: ReferenceRegionFamily;
  headingLocation: CitationEvidenceLocation1;
  firstPage: number;
  lastPage: number;
  entryCount: number;
  /**
   * The named evidence that was present, sorted. The confidence is a function of exactly these, so a reader can recompute it.
   *
   * @maxItems 12
   */
  signals:
    | []
    | [string]
    | [string, string]
    | [string, string, string]
    | [string, string, string, string]
    | [string, string, string, string, string]
    | [string, string, string, string, string, string]
    | [string, string, string, string, string, string, string]
    | [string, string, string, string, string, string, string, string]
    | [string, string, string, string, string, string, string, string, string]
    | [string, string, string, string, string, string, string, string, string, string]
    | [string, string, string, string, string, string, string, string, string, string, string]
    | [
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
      ];
  confidence?: CitationConfidence3;
}
/**
 * Where one piece of citation evidence was observed.
 *
 * The same shape as the Phase 4 fact location, narrowed to what citation evidence can honestly carry. `nodeId` is the only required locator, as there. `page` is present only when the extractor genuinely knew it — structural DOCX analysis never does, and inventing one would make a PDF-shaped promise about a DOCX. `story` says which WordprocessingML story the evidence came from, because a citation in a footnote is not a citation in the body and a rule that conflated them would be answering a different question.
 *
 * No XPath, no caller-supplied selector: `path` is the analyzer's own bounded node path, exactly as in `evaluation.schema.json`.
 */
export interface CitationEvidenceLocation1 {
  locationSchemaVersion: number;
  nodeId: string;
  /**
   * @maxItems 32
   */
  path?: string[];
  page?: number;
  ordinal?: number;
  story?: CitationEvidenceStory;
}
/**
 * One Word-managed bibliography source record.
 *
 * Metadata from the document's own data store, never a rendered entry. No part name, no relationship id and no raw custom XML is carried: the provenance that matters is that it came from the bibliography source store, and the rest is package implementation detail that would only widen what an artifact discloses.
 *
 * This interface was referenced by `PalCertAnalysisArtifact`'s JSON-Schema
 * via the `definition` "BibliographySource".
 */
export interface BibliographySource {
  id: string;
  tag: string;
  sourceType?: string;
  /**
   * @maxItems 32
   */
  authors: CitationAuthorToken[];
  year?: string;
  title?: string;
  containerTitle?: string;
  publisher?: string;
  /**
   * @maxItems 6
   */
  identifiers:
    | []
    | [CitationIdentifier]
    | [CitationIdentifier, CitationIdentifier]
    | [CitationIdentifier, CitationIdentifier, CitationIdentifier]
    | [CitationIdentifier, CitationIdentifier, CitationIdentifier, CitationIdentifier]
    | [
        CitationIdentifier,
        CitationIdentifier,
        CitationIdentifier,
        CitationIdentifier,
        CitationIdentifier,
      ]
    | [
        CitationIdentifier,
        CitationIdentifier,
        CitationIdentifier,
        CitationIdentifier,
        CitationIdentifier,
        CitationIdentifier,
      ];
  citedByCount: number;
}
/**
 * One citation's relationship to one target, established by exact identity or not at all.
 *
 * There is deliberately no fuzzy, semantic or AI link method. When more than one target is plausible the link is AMBIGUOUS and names every candidate; when none is supported it is UNRESOLVED. PalCert never selects the best-looking reference.
 *
 * The shape of each status is fixed and checked by the semantic integrity pass: LINKED names a target and no candidates, AMBIGUOUS names at least two distinct existing candidates and no target, UNRESOLVED names neither.
 *
 * This interface was referenced by `PalCertAnalysisArtifact`'s JSON-Schema
 * via the `definition` "CitationReferenceLink".
 */
export interface CitationReferenceLink {
  citationId: string;
  linkStatus: CitationLinkStatus;
  linkMethod: CitationLinkMethod;
  /**
   * The rendered entry or Word source this citation resolves to. Present only when linkStatus is LINKED.
   */
  targetId?: string;
  /**
   * @maxItems 10
   */
  candidateIds?:
    | []
    | [string]
    | [string, string]
    | [string, string, string]
    | [string, string, string, string]
    | [string, string, string, string, string]
    | [string, string, string, string, string, string]
    | [string, string, string, string, string, string, string]
    | [string, string, string, string, string, string, string, string]
    | [string, string, string, string, string, string, string, string, string]
    | [string, string, string, string, string, string, string, string, string, string];
  candidateCount: number;
}
/**
 * What PalCert could see of one citation evidence domain.
 *
 * This explains the *artifact*, for an evidence panel to render honestly. It is **not** a substitute for `DocumentFactSet` coverage, which remains the only authority the rule engine consults: an advisory coverage value must never decide a verdict.
 *
 * This interface was referenced by `PalCertAnalysisArtifact`'s JSON-Schema
 * via the `definition` "CitationCoverageEntry".
 */
export interface CitationCoverageEntry {
  domain: CitationCoverageDomain;
  status: 'COMPLETE' | 'PARTIAL' | 'UNAVAILABLE';
  reasonCode?: CitationCoverageReasonCode;
}
/**
 * Counters and statuses only — no text of any kind.
 *
 * The `observed*` names are deliberate: those are lower bounds from incomplete discovery, not exact counts, and a name that read as exact would invite a rule to be written against it. Only `nativeCitationCount` and `bibliographySourceCount` are exhaustive, and only for DOCX.
 *
 * This interface was referenced by `PalCertAnalysisArtifact`'s JSON-Schema
 * via the `definition` "CitationSummary".
 */
export interface CitationSummary {
  observedCitationCount: number;
  nativeCitationCount: number;
  observedReferenceCount: number;
  bibliographySourceCount: number;
  linkedCitationCount: number;
  ambiguousCitationCount: number;
  unresolvedCitationCount: number;
  observedUncitedReferenceCount: number;
  observedDuplicateReferenceCount: number;
  referenceRegionObserved: boolean;
  /**
   * @maxItems 10
   */
  truncationFlags:
    | []
    | [CitationTruncationFlag]
    | [CitationTruncationFlag, CitationTruncationFlag]
    | [CitationTruncationFlag, CitationTruncationFlag, CitationTruncationFlag]
    | [
        CitationTruncationFlag,
        CitationTruncationFlag,
        CitationTruncationFlag,
        CitationTruncationFlag,
      ]
    | [
        CitationTruncationFlag,
        CitationTruncationFlag,
        CitationTruncationFlag,
        CitationTruncationFlag,
        CitationTruncationFlag,
      ]
    | [
        CitationTruncationFlag,
        CitationTruncationFlag,
        CitationTruncationFlag,
        CitationTruncationFlag,
        CitationTruncationFlag,
        CitationTruncationFlag,
      ]
    | [
        CitationTruncationFlag,
        CitationTruncationFlag,
        CitationTruncationFlag,
        CitationTruncationFlag,
        CitationTruncationFlag,
        CitationTruncationFlag,
        CitationTruncationFlag,
      ]
    | [
        CitationTruncationFlag,
        CitationTruncationFlag,
        CitationTruncationFlag,
        CitationTruncationFlag,
        CitationTruncationFlag,
        CitationTruncationFlag,
        CitationTruncationFlag,
        CitationTruncationFlag,
      ]
    | [
        CitationTruncationFlag,
        CitationTruncationFlag,
        CitationTruncationFlag,
        CitationTruncationFlag,
        CitationTruncationFlag,
        CitationTruncationFlag,
        CitationTruncationFlag,
        CitationTruncationFlag,
        CitationTruncationFlag,
      ]
    | [
        CitationTruncationFlag,
        CitationTruncationFlag,
        CitationTruncationFlag,
        CitationTruncationFlag,
        CitationTruncationFlag,
        CitationTruncationFlag,
        CitationTruncationFlag,
        CitationTruncationFlag,
        CitationTruncationFlag,
        CitationTruncationFlag,
      ];
}
/**
 * The citation and reference evidence of one analysis (Phase 18).
 *
 * Rich, bounded and **advisory**. Nothing here is a compliance verdict and nothing here is read by the rule engine: evidence becomes authority only by being projected into a `DocumentFactSet` fact through the Phase 18 projector allow-list, which in v1 holds four properties and none of this object's fields.
 *
 * Versioned independently of the artifact envelope so the evidence model can move without a new envelope version, and the other way round.
 *
 * This interface was referenced by `PalCertAnalysisArtifact`'s JSON-Schema
 * via the `definition` "CitationAnalysis".
 */
export interface CitationAnalysis {
  citationAnalysisSchemaVersion: 1;
  /**
   * @maxItems 6
   */
  coverage:
    | []
    | [CitationCoverageEntry]
    | [CitationCoverageEntry, CitationCoverageEntry]
    | [CitationCoverageEntry, CitationCoverageEntry, CitationCoverageEntry]
    | [CitationCoverageEntry, CitationCoverageEntry, CitationCoverageEntry, CitationCoverageEntry]
    | [
        CitationCoverageEntry,
        CitationCoverageEntry,
        CitationCoverageEntry,
        CitationCoverageEntry,
        CitationCoverageEntry,
      ]
    | [
        CitationCoverageEntry,
        CitationCoverageEntry,
        CitationCoverageEntry,
        CitationCoverageEntry,
        CitationCoverageEntry,
        CitationCoverageEntry,
      ];
  /**
   * @maxItems 20000
   */
  citations: CitationOccurrence[];
  /**
   * @maxItems 5000
   */
  references: ReferenceEntry[];
  /**
   * The reference lists this document was read as having, in reading order. Optional, so an artifact produced before regions were recorded stays valid, and empty when nothing was discovered.
   *
   * @maxItems 64
   */
  referenceRegions?: ReferenceRegion[];
  /**
   * @maxItems 5000
   */
  bibliographySources: BibliographySource[];
  /**
   * @maxItems 40000
   */
  links: CitationReferenceLink[];
  summary: CitationSummary;
}
