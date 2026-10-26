"""The DOCX analyzer's entry point (§4, §5, §82).

One function, one contract: given the exact bytes of a READY DOCX and the
SHA-256 PalCert recorded for them, produce the analysis artifact or fail with
a stable code.

**Integrity is checked before anything is believed** (§5). The analyzer has to
read the bytes anyway, so it hashes them while reading and compares. A
mismatch means the object is not the document PalCert validated and scanned in
Phase 5 — a different file, a truncated download, a swapped object version —
and analyzing it would attach a fact set to the wrong document. That is a
fatal, non-retryable failure.

**Analysis is bounded** (§82). A syntactically valid document must not be able
to occupy a worker for ever, so a wall-clock deadline is enforced between
phases of the analysis in addition to the per-part resource limits.
"""

from __future__ import annotations

import hashlib
import io
import json
import time
from dataclasses import dataclass, field
from typing import Any

from app.docx.artifact import (
    ANALYZER_NAME,
    ANALYZER_VERSION,
    ENVELOPE_SCHEMA_VERSION,
    AnalysisArtifact,
    build_artifact,
)
from app.docx.citations.producer import CitationEvidenceInput, build_citation_analysis
from app.docx.citations.sources import discover_source_store
from app.docx.document import read_document
from app.docx.errors import DocxAnalysisError, DocxErrorCode
from app.docx.facts import build_fact_set
from app.docx.limits import AnalyzerLimits, ResourceLimitExceededError
from app.docx.package import DocxPackage
from app.docx.warnings import AnalysisWarning, WarningCode, WarningCollector
from app.engine.contracts.artifact_contract import (
    AnalysisArtifactContractError,
    assert_analysis_artifact,
)
from app.engine.contracts.validation import assert_contract
from app.engine.facts.model import FACT_SCHEMA_VERSION


@dataclass(frozen=True, slots=True)
class AnalysisRequest:
    """Everything the analyzer needs; nothing it does not.

    There is no object key, no bucket, no URL and no filesystem path here on
    purpose: the analyzer is a pure function of bytes, and storage access
    stays with the caller that already holds the credentials.
    """

    document_id: str
    content: bytes
    expected_sha256: str
    limits: AnalyzerLimits = field(default_factory=AnalyzerLimits.default)
    timeout_seconds: float = 300.0
    #: Retain paragraph text in the structural layer (§72). Off for callers
    #: that want facts only.
    retain_text: bool = True


@dataclass(frozen=True, slots=True)
class AnalysisOutcome:
    artifact: AnalysisArtifact
    warnings: tuple[AnalysisWarning, ...]
    analyzer_name: str
    analyzer_version: str
    fact_schema_version: int
    analysis_schema_version: int
    duration_ms: int


class _Deadline:
    """A wall-clock budget checked between phases."""

    __slots__ = ("_deadline", "_started")

    def __init__(self, seconds: float) -> None:
        self._started = time.monotonic()
        self._deadline = self._started + seconds

    def check(self, phase: str) -> None:
        if time.monotonic() > self._deadline:
            raise DocxAnalysisError(DocxErrorCode.ANALYSIS_TIMEOUT, phase)

    @property
    def elapsed_ms(self) -> int:
        return int((time.monotonic() - self._started) * 1000)


def verify_source_integrity(content: bytes, expected_sha256: str) -> str:
    """Hash the bytes and compare with what PalCert recorded (§5).

    Compared case-insensitively on the hex digest and nothing else. A
    mismatch is never "probably fine": it means these are not the bytes that
    were scanned.
    """
    digest = hashlib.sha256(content).hexdigest()
    if digest.lower() != expected_sha256.strip().lower():
        raise DocxAnalysisError(
            DocxErrorCode.SOURCE_INTEGRITY_FAILED,
            "the object does not match the recorded document digest",
        )
    return digest


def analyze(request: AnalysisRequest) -> AnalysisOutcome:
    """Analyze one DOCX into an immutable artifact."""
    deadline = _Deadline(request.timeout_seconds)
    warnings = WarningCollector(request.limits)

    digest = verify_source_integrity(request.content, request.expected_sha256)
    deadline.check("integrity")

    package = DocxPackage.open(io.BytesIO(request.content), request.limits, warnings)
    try:
        result = read_document(package, request.limits, warnings)
        deadline.check("structure")

        # Citation evidence first: Phase 18 projects a little of it into
        # facts, so the fact set cannot be built before it exists.
        #
        # Read *before* the source store is discovered, because discovery reads
        # custom XML parts and an unreadable one of those would otherwise be
        # counted as a story PalCert could not finish walking. It is not: the
        # citations were all read, and only the source set is in doubt — which
        # is a different domain, reported separately.
        stories_incomplete = warnings.has(WarningCode.PART_UNREADABLE)
        citation_analysis = build_citation_analysis(
            CitationEvidenceInput(
                citation_fields=tuple(result.context.citation_fields),
                bibliography_fields=tuple(result.context.bibliography_fields),
                reference_paragraphs=tuple(result.context.reference_paragraphs),
                store=discover_source_store(package, package.main_document_part()),
                stories_incomplete=stories_incomplete,
            )
        )
        deadline.check("citations")

        fact_set = build_fact_set(
            model=result.model,
            document_id=request.document_id,
            extractor_name=ANALYZER_NAME,
            extractor_version=ANALYZER_VERSION,
            fact_schema_version=FACT_SCHEMA_VERSION,
            limits=request.limits,
            warnings=warnings,
            citation_analysis=citation_analysis,
        )
        deadline.check("facts")

        # Invalid analyzer output is never persisted (§110). Validating here,
        # before an artifact exists, means a contract defect is a failed
        # analysis rather than a stored lie.
        assert_contract("DocumentFactSet", fact_set)

        artifact = build_artifact(
            model=result.model,
            fact_set=fact_set,
            warnings=warnings.all(),
            source_sha256=digest,
            document_id=request.document_id,
            limits=request.limits,
            citation_analysis=citation_analysis,
        )
        # The artifact is validated against the shared cross-language contract
        # before it can be stored (§33): an artifact Node would reject must
        # never become a stored record that a check later chokes on.
        assert_analysis_artifact(json.loads(artifact.content))
    except AnalysisArtifactContractError as error:
        raise DocxAnalysisError(DocxErrorCode.ARTIFACT_INVALID, str(error)[:200]) from error
    except ResourceLimitExceededError as error:
        raise DocxAnalysisError(DocxErrorCode.RESOURCE_LIMIT_EXCEEDED, error.limit_name) from error
    finally:
        package.close()

    return AnalysisOutcome(
        artifact=artifact,
        warnings=warnings.all(),
        analyzer_name=ANALYZER_NAME,
        analyzer_version=ANALYZER_VERSION,
        fact_schema_version=FACT_SCHEMA_VERSION,
        analysis_schema_version=ENVELOPE_SCHEMA_VERSION,
        duration_ms=deadline.elapsed_ms,
    )


def analyzer_identity() -> dict[str, Any]:
    """What produced an artifact, for the database row and for telemetry."""
    return {
        "analyzerName": ANALYZER_NAME,
        "analyzerVersion": ANALYZER_VERSION,
        "factSchemaVersion": FACT_SCHEMA_VERSION,
        "analysisSchemaVersion": ENVELOPE_SCHEMA_VERSION,
    }
