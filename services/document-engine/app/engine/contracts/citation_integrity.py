"""The citation evidence invariants JSON Schema cannot express (Phase 18).

The schema bounds every field and closes every vocabulary, but it cannot say
that a link points at a citation that exists, or that a reference is not its
own duplicate. Those are properties of the *graph*, and a graph that lies about
itself is worse than one that is merely incomplete: an evidence panel would
render a link to nothing, and a later phase reading the artifact would have to
guess which half to believe.

So this runs beside the schema, and the TypeScript package runs the same checks
over the same fixtures — and, since the hardening pass, as part of the ordinary
artifact contract rather than as a second call every caller has to remember. It
fails closed and it never repairs: a malformed artifact is a failed analysis,
not a stored record of one that was quietly tidied up.
"""

from __future__ import annotations

from collections import Counter
from dataclasses import dataclass
from enum import StrEnum
from typing import Any


class CitationIntegrityCode(StrEnum):
    DUPLICATE_CITATION_ID = "DUPLICATE_CITATION_ID"
    DUPLICATE_REFERENCE_ID = "DUPLICATE_REFERENCE_ID"
    DUPLICATE_SOURCE_ID = "DUPLICATE_SOURCE_ID"
    CONFIDENCE_NOT_ALLOWED = "CONFIDENCE_NOT_ALLOWED"
    LINK_CITATION_UNKNOWN = "LINK_CITATION_UNKNOWN"
    LINK_TARGET_UNKNOWN = "LINK_TARGET_UNKNOWN"
    LINK_TARGET_MISSING = "LINK_TARGET_MISSING"
    LINK_TARGET_NOT_ALLOWED = "LINK_TARGET_NOT_ALLOWED"
    LINK_CANDIDATE_UNKNOWN = "LINK_CANDIDATE_UNKNOWN"
    LINK_CANDIDATE_COUNT_MISMATCH = "LINK_CANDIDATE_COUNT_MISMATCH"
    LINK_CANDIDATE_REPEATED = "LINK_CANDIDATE_REPEATED"
    LINK_CANDIDATES_NOT_ALLOWED = "LINK_CANDIDATES_NOT_ALLOWED"
    LINK_CANDIDATES_INSUFFICIENT = "LINK_CANDIDATES_INSUFFICIENT"
    CITATION_TARGET_COUNT_MISMATCH = "CITATION_TARGET_COUNT_MISMATCH"
    CITATION_RESOLUTION_STATUS_MISMATCH = "CITATION_RESOLUTION_STATUS_MISMATCH"
    DUPLICATE_OF_UNKNOWN = "DUPLICATE_OF_UNKNOWN"
    DUPLICATE_OF_SELF = "DUPLICATE_OF_SELF"
    DUPLICATE_OF_WITHOUT_STATUS = "DUPLICATE_OF_WITHOUT_STATUS"
    DUPLICATE_OF_MISSING = "DUPLICATE_OF_MISSING"
    COVERAGE_DOMAIN_REPEATED = "COVERAGE_DOMAIN_REPEATED"
    DOI_LINK_WITHOUT_SHARED_IDENTITY = "DOI_LINK_WITHOUT_SHARED_IDENTITY"


@dataclass(frozen=True, slots=True)
class CitationIntegrityIssue:
    #: Stable code, so a caller never parses the message.
    code: CitationIntegrityCode
    path: str
    message: str


@dataclass(frozen=True, slots=True)
class CitationIntegrityResult:
    valid: bool
    issues: tuple[CitationIntegrityIssue, ...]


def _repeated(values: list[str]) -> list[str]:
    """Values that appeared more than once, in first-seen order."""
    counts = Counter(values)
    seen: list[str] = []
    for value in values:
        if counts[value] > 1 and value not in seen:
            seen.append(value)
    return seen


def _expected_resolution(links: list[dict[str, Any]]) -> str:
    """What a citation's own links say its resolution status must be.

    ``resolutionStatus`` is a summary of the link rows, so it is redundant
    evidence — and redundant evidence that can disagree with what it summarises
    is worse than none, because a reader has no way to tell which half is the
    mistake. The precedence is fixed here, before any extractor exists to
    choose its own.
    """
    if not links:
        return "NOT_ATTEMPTED"
    statuses = {link["linkStatus"] for link in links}
    if "UNRESOLVED" in statuses:
        return "UNRESOLVED"
    if "AMBIGUOUS" in statuses:
        return "AMBIGUOUS"
    return "LINKED"


def validate_citation_integrity(analysis: Any) -> CitationIntegrityResult:
    """Check one ``citationAnalysis`` object's internal consistency.

    Assumes the object already satisfies the JSON Schema: this answers the
    questions the schema cannot ask, not the ones it already answered.
    """
    issues: list[CitationIntegrityIssue] = []

    def add(code: CitationIntegrityCode, path: str, message: str) -> None:
        issues.append(CitationIntegrityIssue(code=code, path=path, message=message))

    citations: list[dict[str, Any]] = analysis["citations"]
    references: list[dict[str, Any]] = analysis["references"]
    sources: list[dict[str, Any]] = analysis["bibliographySources"]
    links: list[dict[str, Any]] = analysis["links"]

    # --- identity ---------------------------------------------------------
    for citation_id in _repeated([entry["id"] for entry in citations]):
        add(CitationIntegrityCode.DUPLICATE_CITATION_ID, "/citations", f"{citation_id} twice")
    for reference_id in _repeated([entry["id"] for entry in references]):
        add(CitationIntegrityCode.DUPLICATE_REFERENCE_ID, "/references", f"{reference_id} twice")
    for source_id in _repeated([entry["id"] for entry in sources]):
        add(
            CitationIntegrityCode.DUPLICATE_SOURCE_ID,
            "/bibliographySources",
            f"{source_id} twice",
        )

    citation_ids = {entry["id"] for entry in citations}
    reference_ids = {entry["id"] for entry in references}
    target_ids = reference_ids | {entry["id"] for entry in sources}

    # --- confidence is heuristic-only -------------------------------------
    # A confidence beside an exact read is a number with nothing behind it. It
    # would be rendered as a measurement and, worse, invite a later phase to
    # treat exact evidence as graded — so it is rejected rather than ignored.
    graded = [(f"/citations/{i}", entry) for i, entry in enumerate(citations)]
    graded += [(f"/references/{i}", entry) for i, entry in enumerate(references)]
    for at, observation in graded:
        if "confidence" in observation and observation["sourceKind"] != "HEURISTIC":
            add(
                CitationIntegrityCode.CONFIDENCE_NOT_ALLOWED,
                at,
                "confidence is only meaningful for HEURISTIC evidence, "
                f"not {observation['sourceKind']}",
            )

    # --- DOI identity, indexed for the link pass --------------------------
    # `DOI_IDENTITY` is the one method whose evidence is written down on both
    # sides, so it is the one method whose rows can be checked rather than
    # trusted. A row claiming it must be backed by the same normalized DOI on
    # the citation and on every entry it names.
    #
    # Only `normalized` counts. The extractor withholds it whenever a value's
    # end could not be determined or its shape was malformed, so a
    # boundary-ambiguous or invalid DOI has no identity to share — and a link
    # resting on one is rejected here rather than merely discouraged upstream.
    def _identities(observation: dict[str, Any]) -> set[str]:
        return {
            identifier["normalized"]
            for identifier in observation.get("identifiers", [])
            if identifier.get("scheme") == "DOI" and identifier.get("normalized") is not None
        }

    citation_identities = {entry["id"]: _identities(entry) for entry in citations}
    target_identities = {entry["id"]: _identities(entry) for entry in references}
    target_identities.update({entry["id"]: set() for entry in sources})

    # --- links ------------------------------------------------------------
    links_by_citation: dict[str, list[dict[str, Any]]] = {}
    for index, link in enumerate(links):
        at = f"/links/{index}"
        citation_id = link["citationId"]
        if citation_id not in citation_ids:
            add(
                CitationIntegrityCode.LINK_CITATION_UNKNOWN,
                at,
                f"{citation_id} is not a citation in this artifact",
            )
        links_by_citation.setdefault(citation_id, []).append(link)

        target_id = link.get("targetId")
        if link["linkStatus"] == "LINKED":
            if target_id is None:
                add(
                    CitationIntegrityCode.LINK_TARGET_MISSING,
                    at,
                    "a LINKED link names no target",
                )
            elif target_id not in target_ids:
                add(
                    CitationIntegrityCode.LINK_TARGET_UNKNOWN,
                    at,
                    f"{target_id} is not a reference or source in this artifact",
                )
        elif target_id is not None:
            # An AMBIGUOUS or UNRESOLVED link claiming a target is the one
            # shape that would let "PalCert could not decide" read as a
            # decision.
            add(
                CitationIntegrityCode.LINK_TARGET_NOT_ALLOWED,
                at,
                f"a {link['linkStatus']} link must not name a target",
            )

        if link["linkMethod"] == "DOI_IDENTITY":
            shared = citation_identities.get(citation_id, set())
            if not shared:
                # A DOI row on a citation that states no usable identity is a
                # claim with nothing behind it. `normalized` is absent
                # whenever a value's end could not be determined or its shape
                # was malformed, so this also rejects a link resting on one.
                add(
                    CitationIntegrityCode.DOI_LINK_WITHOUT_SHARED_IDENTITY,
                    at,
                    f"{citation_id} states no usable DOI identity",
                )
            elif target_id is not None and not (shared & target_identities.get(target_id, set())):
                # A *resolved* DOI link names one entry, and that entry must
                # state the same identity. Candidates are deliberately not
                # checked: when two methods disagree the frozen rule makes
                # every row AMBIGUOUS over the *union* of what they found, so
                # a candidate may be there on another method's evidence. That
                # union is the contract's way of saying "the document points
                # at either of these and PalCert will not choose", and
                # narrowing it here would silently prioritize one method.
                add(
                    CitationIntegrityCode.DOI_LINK_WITHOUT_SHARED_IDENTITY,
                    at,
                    f"{target_id} does not share a normalized DOI with {citation_id}",
                )

        candidates: list[str] = link.get("candidateIds", [])
        for candidate in candidates:
            if candidate not in target_ids:
                add(
                    CitationIntegrityCode.LINK_CANDIDATE_UNKNOWN,
                    at,
                    f"candidate {candidate} does not exist",
                )
        for candidate in _repeated(candidates):
            # Never deduplicated on the reader's behalf: a candidate list that
            # names the same entry twice is a counting bug in whatever produced
            # it, and silently collapsing it would hide the bug and the count.
            add(
                CitationIntegrityCode.LINK_CANDIDATE_REPEATED,
                at,
                f"candidate {candidate} is named twice",
            )
        if link["candidateCount"] != len(candidates):
            add(
                CitationIntegrityCode.LINK_CANDIDATE_COUNT_MISMATCH,
                at,
                f"candidateCount {link['candidateCount']} but {len(candidates)} candidates",
            )

        if link["linkStatus"] == "AMBIGUOUS":
            # Ambiguity means PalCert had more than one answer. One candidate
            # is a decision it declined to record; none is not ambiguity.
            distinct = {candidate for candidate in candidates if candidate in target_ids}
            if len(distinct) < 2:
                add(
                    CitationIntegrityCode.LINK_CANDIDATES_INSUFFICIENT,
                    at,
                    "an AMBIGUOUS link needs at least two distinct existing candidates, "
                    f"not {len(distinct)}",
                )
        elif candidates or link["candidateCount"] != 0:
            add(
                CitationIntegrityCode.LINK_CANDIDATES_NOT_ALLOWED,
                at,
                f"a {link['linkStatus']} link must name no candidates",
            )

    # --- citations --------------------------------------------------------
    for index, citation in enumerate(citations):
        at = f"/citations/{index}"
        own = links_by_citation.get(citation["id"], [])
        if citation["targetCount"] != len(own):
            add(
                CitationIntegrityCode.CITATION_TARGET_COUNT_MISMATCH,
                at,
                f"targetCount {citation['targetCount']} but {len(own)} links",
            )
        expected = _expected_resolution(own)
        if citation["resolutionStatus"] != expected:
            add(
                CitationIntegrityCode.CITATION_RESOLUTION_STATUS_MISMATCH,
                at,
                f"resolutionStatus {citation['resolutionStatus']} but its links say {expected}",
            )

    # --- duplicates -------------------------------------------------------
    for index, reference in enumerate(references):
        duplicate_of = reference.get("duplicateOf")
        at = f"/references/{index}"
        if reference["duplicateStatus"] == "DUPLICATE_CONFIRMED" and duplicate_of is None:
            # Confirmed against what? A confirmation with nothing named is a
            # claim of exact identity that cannot be checked or shown.
            add(
                CitationIntegrityCode.DUPLICATE_OF_MISSING,
                at,
                "DUPLICATE_CONFIRMED must name the reference it duplicates",
            )
        if duplicate_of is None:
            continue
        if duplicate_of == reference["id"]:
            add(
                CitationIntegrityCode.DUPLICATE_OF_SELF,
                at,
                "a reference cannot duplicate itself",
            )
        elif duplicate_of not in reference_ids:
            add(
                CitationIntegrityCode.DUPLICATE_OF_UNKNOWN,
                at,
                f"{duplicate_of} is not a reference in this artifact",
            )
        if reference["duplicateStatus"] == "NONE":
            add(
                CitationIntegrityCode.DUPLICATE_OF_WITHOUT_STATUS,
                at,
                "duplicateOf is set while duplicateStatus says NONE",
            )

    # --- coverage ---------------------------------------------------------
    for domain in _repeated([entry["domain"] for entry in analysis["coverage"]]):
        add(
            CitationIntegrityCode.COVERAGE_DOMAIN_REPEATED,
            "/coverage",
            f"{domain} is answered twice",
        )

    return CitationIntegrityResult(valid=not issues, issues=tuple(issues))


class CitationIntegrityError(Exception):
    """The citation evidence is not internally consistent."""


def assert_citation_integrity(analysis: Any) -> None:
    result = validate_citation_integrity(analysis)
    if result.valid:
        return
    detail = "; ".join(f"{issue.path}: {issue.message}" for issue in result.issues)
    raise CitationIntegrityError(f"citation analysis is not internally consistent — {detail}")
