import type {
  CitationAnalysis,
  CitationOccurrence,
  CitationReferenceLink,
  ReferenceEntry,
} from './generated.js';

/**
 * The citation evidence invariants JSON Schema cannot express (Phase 18).
 *
 * The schema bounds every field and closes every vocabulary, but it cannot say
 * that a link points at a citation that exists, or that a reference is not its
 * own duplicate. Those are properties of the *graph*, and a graph that lies
 * about itself is worse than one that is merely incomplete: an evidence panel
 * would render a link to nothing, and a later phase reading the artifact would
 * have to guess which half to believe.
 *
 * So this runs beside the schema, in both runtimes, over the same fixtures —
 * and, since the hardening pass, as part of the ordinary artifact contract
 * rather than as a second call every caller has to remember. It fails closed
 * and it never repairs: a malformed artifact is a failed analysis, not a
 * stored record of one that was quietly tidied up.
 */

export interface CitationIntegrityIssue {
  /** Stable code, so a caller never parses the message. */
  readonly code: CitationIntegrityCode;
  /** Where in the artifact, as a JSON pointer-ish path. */
  readonly path: string;
  readonly message: string;
}

export const CitationIntegrityCode = {
  DUPLICATE_CITATION_ID: 'DUPLICATE_CITATION_ID',
  DUPLICATE_REFERENCE_ID: 'DUPLICATE_REFERENCE_ID',
  DUPLICATE_SOURCE_ID: 'DUPLICATE_SOURCE_ID',
  CONFIDENCE_NOT_ALLOWED: 'CONFIDENCE_NOT_ALLOWED',
  LINK_CITATION_UNKNOWN: 'LINK_CITATION_UNKNOWN',
  LINK_TARGET_UNKNOWN: 'LINK_TARGET_UNKNOWN',
  LINK_TARGET_MISSING: 'LINK_TARGET_MISSING',
  LINK_TARGET_NOT_ALLOWED: 'LINK_TARGET_NOT_ALLOWED',
  LINK_CANDIDATE_UNKNOWN: 'LINK_CANDIDATE_UNKNOWN',
  LINK_CANDIDATE_COUNT_MISMATCH: 'LINK_CANDIDATE_COUNT_MISMATCH',
  LINK_CANDIDATE_REPEATED: 'LINK_CANDIDATE_REPEATED',
  LINK_CANDIDATES_NOT_ALLOWED: 'LINK_CANDIDATES_NOT_ALLOWED',
  LINK_CANDIDATES_INSUFFICIENT: 'LINK_CANDIDATES_INSUFFICIENT',
  CITATION_TARGET_COUNT_MISMATCH: 'CITATION_TARGET_COUNT_MISMATCH',
  CITATION_RESOLUTION_STATUS_MISMATCH: 'CITATION_RESOLUTION_STATUS_MISMATCH',
  DUPLICATE_OF_UNKNOWN: 'DUPLICATE_OF_UNKNOWN',
  DUPLICATE_OF_SELF: 'DUPLICATE_OF_SELF',
  DUPLICATE_OF_WITHOUT_STATUS: 'DUPLICATE_OF_WITHOUT_STATUS',
  DUPLICATE_OF_MISSING: 'DUPLICATE_OF_MISSING',
  COVERAGE_DOMAIN_REPEATED: 'COVERAGE_DOMAIN_REPEATED',
  DOI_LINK_WITHOUT_SHARED_IDENTITY: 'DOI_LINK_WITHOUT_SHARED_IDENTITY',
} as const;

export type CitationIntegrityCode =
  (typeof CitationIntegrityCode)[keyof typeof CitationIntegrityCode];

export interface CitationIntegrityResult {
  readonly valid: boolean;
  readonly issues: readonly CitationIntegrityIssue[];
}

function issue(code: CitationIntegrityCode, path: string, message: string): CitationIntegrityIssue {
  return { code, path, message };
}

/** Ids that appeared more than once, in first-seen order. */
function repeated(ids: readonly string[]): string[] {
  const seen = new Set<string>();
  const twice = new Set<string>();
  for (const id of ids) {
    if (seen.has(id)) twice.add(id);
    seen.add(id);
  }
  return [...twice];
}

/**
 * What a citation's own links say its resolution status must be.
 *
 * `resolutionStatus` is a summary of the link rows, so it is redundant
 * evidence — and redundant evidence that can disagree with what it summarises
 * is worse than none, because a reader has no way to tell which half is the
 * mistake. The precedence is fixed here, before any extractor exists to
 * choose its own.
 */
function expectedResolution(links: readonly CitationReferenceLink[]): string {
  if (links.length === 0) return 'NOT_ATTEMPTED';
  if (links.some((link) => link.linkStatus === 'UNRESOLVED')) return 'UNRESOLVED';
  if (links.some((link) => link.linkStatus === 'AMBIGUOUS')) return 'AMBIGUOUS';
  return 'LINKED';
}

export function validateCitationIntegrity(analysis: CitationAnalysis): CitationIntegrityResult {
  const issues: CitationIntegrityIssue[] = [];

  const citations: readonly CitationOccurrence[] = analysis.citations;
  const references: readonly ReferenceEntry[] = analysis.references;
  const sources = analysis.bibliographySources;
  const links: readonly CitationReferenceLink[] = analysis.links;

  // --- identity ----------------------------------------------------------
  for (const id of repeated(citations.map((c) => c.id))) {
    issues.push(issue(CitationIntegrityCode.DUPLICATE_CITATION_ID, '/citations', `${id} twice`));
  }
  for (const id of repeated(references.map((r) => r.id))) {
    issues.push(issue(CitationIntegrityCode.DUPLICATE_REFERENCE_ID, '/references', `${id} twice`));
  }
  for (const id of repeated(sources.map((s) => s.id))) {
    issues.push(
      issue(CitationIntegrityCode.DUPLICATE_SOURCE_ID, '/bibliographySources', `${id} twice`),
    );
  }

  const citationIds = new Set(citations.map((c) => c.id));
  const referenceIds = new Set(references.map((r) => r.id));
  const sourceIds = new Set(sources.map((s) => s.id));
  const targetIds = new Set([...referenceIds, ...sourceIds]);

  // --- confidence is heuristic-only --------------------------------------
  // A confidence beside an exact read is a number with nothing behind it. It
  // would be rendered as a measurement and, worse, invite a later phase to
  // treat exact evidence as graded — so it is rejected rather than ignored.
  const graded = [
    ...citations.map((citation, index) => ({ at: `/citations/${index}`, observation: citation })),
    ...references.map((reference, index) => ({
      at: `/references/${index}`,
      observation: reference,
    })),
  ];
  for (const { at, observation } of graded) {
    if (observation.confidence !== undefined && observation.sourceKind !== 'HEURISTIC') {
      issues.push(
        issue(
          CitationIntegrityCode.CONFIDENCE_NOT_ALLOWED,
          at,
          `confidence is only meaningful for HEURISTIC evidence, not ${observation.sourceKind}`,
        ),
      );
    }
  }

  // --- links -------------------------------------------------------------
  // --- DOI identity, indexed for the link pass --------------------------
  //
  // `DOI_IDENTITY` is the one method whose evidence is written down on both
  // sides, so it is the one method whose rows can be checked rather than
  // trusted. A row claiming it must be backed by the same normalized DOI on
  // the citation and on every entry it names.
  //
  // Only `normalized` counts. The extractor withholds it whenever a value's
  // end could not be determined or its shape was malformed, so a
  // boundary-ambiguous or invalid DOI has no identity to share.
  const doiIdentities = (observation: {
    readonly identifiers?: readonly { readonly scheme: string; readonly normalized?: string }[];
  }): Set<string> =>
    new Set(
      (observation.identifiers ?? [])
        .filter((identifier) => identifier.scheme === 'DOI' && identifier.normalized !== undefined)
        .map((identifier) => identifier.normalized as string),
    );

  const citationIdentities = new Map(
    citations.map((citation) => [citation.id, doiIdentities(citation)] as const),
  );
  const targetIdentities = new Map<string, Set<string>>([
    ...references.map((entry) => [entry.id, doiIdentities(entry)] as const),
    ...sources.map((entry) => [entry.id, new Set<string>()] as const),
  ]);

  const linksByCitation = new Map<string, CitationReferenceLink[]>();
  links.forEach((link, index) => {
    const at = `/links/${index}`;

    if (!citationIds.has(link.citationId)) {
      issues.push(
        issue(
          CitationIntegrityCode.LINK_CITATION_UNKNOWN,
          at,
          `${link.citationId} is not a citation in this artifact`,
        ),
      );
    }
    const forCitation = linksByCitation.get(link.citationId) ?? [];
    forCitation.push(link);
    linksByCitation.set(link.citationId, forCitation);

    if (link.linkStatus === 'LINKED') {
      if (link.targetId === undefined) {
        issues.push(
          issue(CitationIntegrityCode.LINK_TARGET_MISSING, at, 'a LINKED link names no target'),
        );
      } else if (!targetIds.has(link.targetId)) {
        issues.push(
          issue(
            CitationIntegrityCode.LINK_TARGET_UNKNOWN,
            at,
            `${link.targetId} is not a reference or source in this artifact`,
          ),
        );
      }
    } else if (link.targetId !== undefined) {
      // An AMBIGUOUS or UNRESOLVED link claiming a target is the one shape
      // that would let "PalCert could not decide" be read as a decision.
      issues.push(
        issue(
          CitationIntegrityCode.LINK_TARGET_NOT_ALLOWED,
          at,
          `a ${link.linkStatus} link must not name a target`,
        ),
      );
    }

    if (link.linkMethod === 'DOI_IDENTITY') {
      const shared = citationIdentities.get(link.citationId) ?? new Set<string>();
      if (shared.size === 0) {
        // A DOI row on a citation that states no usable identity is a claim
        // with nothing behind it. `normalized` is absent whenever a value's
        // end could not be determined or its shape was malformed, so this
        // also rejects a link resting on one.
        issues.push(
          issue(
            CitationIntegrityCode.DOI_LINK_WITHOUT_SHARED_IDENTITY,
            at,
            `${link.citationId} states no usable DOI identity`,
          ),
        );
      } else if (link.targetId !== undefined) {
        // A *resolved* DOI link names one entry, and that entry must state
        // the same identity. Candidates are deliberately not checked: when
        // two methods disagree the frozen rule makes every row AMBIGUOUS
        // over the *union* of what they found, so a candidate may be there
        // on another method's evidence. Narrowing that union here would
        // silently prioritize one method.
        const theirs = targetIdentities.get(link.targetId) ?? new Set<string>();
        if (![...shared].some((identity) => theirs.has(identity))) {
          issues.push(
            issue(
              CitationIntegrityCode.DOI_LINK_WITHOUT_SHARED_IDENTITY,
              at,
              `${link.targetId} does not share a normalized DOI with ${link.citationId}`,
            ),
          );
        }
      }
    }

    const candidates = link.candidateIds ?? [];
    for (const candidate of candidates) {
      if (!targetIds.has(candidate)) {
        issues.push(
          issue(
            CitationIntegrityCode.LINK_CANDIDATE_UNKNOWN,
            at,
            `candidate ${candidate} does not exist`,
          ),
        );
      }
    }
    for (const candidate of repeated(candidates)) {
      // Never deduplicated on the reader's behalf: a candidate list that
      // names the same entry twice is a counting bug in whatever produced it,
      // and silently collapsing it would hide the bug and the real count.
      issues.push(
        issue(
          CitationIntegrityCode.LINK_CANDIDATE_REPEATED,
          at,
          `candidate ${candidate} is named twice`,
        ),
      );
    }
    if (link.candidateCount !== candidates.length) {
      issues.push(
        issue(
          CitationIntegrityCode.LINK_CANDIDATE_COUNT_MISMATCH,
          at,
          `candidateCount ${link.candidateCount} but ${candidates.length} candidates`,
        ),
      );
    }

    if (link.linkStatus === 'AMBIGUOUS') {
      // Ambiguity means PalCert had more than one answer. One candidate is a
      // decision it declined to record; none is not ambiguity at all.
      const distinct = new Set(candidates.filter((candidate) => targetIds.has(candidate)));
      if (distinct.size < 2) {
        issues.push(
          issue(
            CitationIntegrityCode.LINK_CANDIDATES_INSUFFICIENT,
            at,
            `an AMBIGUOUS link needs at least two distinct existing candidates, not ${distinct.size}`,
          ),
        );
      }
    } else if (candidates.length > 0 || link.candidateCount !== 0) {
      issues.push(
        issue(
          CitationIntegrityCode.LINK_CANDIDATES_NOT_ALLOWED,
          at,
          `a ${link.linkStatus} link must name no candidates`,
        ),
      );
    }
  });

  // --- citations ---------------------------------------------------------
  citations.forEach((citation, index) => {
    const at = `/citations/${index}`;
    const own = linksByCitation.get(citation.id) ?? [];
    if (citation.targetCount !== own.length) {
      issues.push(
        issue(
          CitationIntegrityCode.CITATION_TARGET_COUNT_MISMATCH,
          at,
          `targetCount ${citation.targetCount} but ${own.length} links`,
        ),
      );
    }
    const expected = expectedResolution(own);
    if (citation.resolutionStatus !== expected) {
      issues.push(
        issue(
          CitationIntegrityCode.CITATION_RESOLUTION_STATUS_MISMATCH,
          at,
          `resolutionStatus ${citation.resolutionStatus} but its links say ${expected}`,
        ),
      );
    }
  });

  // --- duplicates --------------------------------------------------------
  references.forEach((reference, index) => {
    const at = `/references/${index}`;
    if (
      reference.duplicateStatus === 'DUPLICATE_CONFIRMED' &&
      reference.duplicateOf === undefined
    ) {
      // Confirmed against what? A confirmation with nothing named is a claim
      // of exact identity that cannot be checked or shown.
      issues.push(
        issue(
          CitationIntegrityCode.DUPLICATE_OF_MISSING,
          at,
          'DUPLICATE_CONFIRMED must name the reference it duplicates',
        ),
      );
    }
    if (reference.duplicateOf === undefined) return;
    if (reference.duplicateOf === reference.id) {
      issues.push(
        issue(CitationIntegrityCode.DUPLICATE_OF_SELF, at, 'a reference cannot duplicate itself'),
      );
    } else if (!referenceIds.has(reference.duplicateOf)) {
      issues.push(
        issue(
          CitationIntegrityCode.DUPLICATE_OF_UNKNOWN,
          at,
          `${reference.duplicateOf} is not a reference in this artifact`,
        ),
      );
    }
    if (reference.duplicateStatus === 'NONE') {
      issues.push(
        issue(
          CitationIntegrityCode.DUPLICATE_OF_WITHOUT_STATUS,
          at,
          'duplicateOf is set while duplicateStatus says NONE',
        ),
      );
    }
  });

  // --- coverage ----------------------------------------------------------
  for (const domain of repeated(analysis.coverage.map((entry) => entry.domain))) {
    issues.push(
      issue(
        CitationIntegrityCode.COVERAGE_DOMAIN_REPEATED,
        '/coverage',
        `${domain} is answered twice`,
      ),
    );
  }

  return { valid: issues.length === 0, issues };
}

/** Validate, or throw with every problem listed. */
export function assertCitationIntegrity(analysis: CitationAnalysis): void {
  const result = validateCitationIntegrity(analysis);
  if (result.valid) return;
  const detail = result.issues.map((entry) => `${entry.path}: ${entry.message}`).join('; ');
  throw new Error(`citation analysis is not internally consistent — ${detail}`);
}
