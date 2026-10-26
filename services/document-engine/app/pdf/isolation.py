"""Running an analysis in its own process, and surviving whatever happens (§6, §7, §129, §130).

The parent's contract with the child is deliberately narrow: bytes in on a
pipe, one JSON document out, a wall-clock deadline, and no shared state of any
kind. That is what makes a PDFium crash a failed analysis rather than a failed
service, and it is why PDFium handles never cross a thread boundary - each
analysis owns its own process and everything in it (§6).

Three outcomes are possible and all three are ordinary:

* the child returns an artifact;
* the child returns an error with a stable code, having failed cleanly;
* the child dies or overruns, and the parent turns that into
  PDF_ANALYZER_CRASHED or PDF_ANALYSIS_TIMEOUT.

A paid check treats all three the same way: no report, no charge, reservation
released (§79, §86).
"""

from __future__ import annotations

import json
import subprocess
import sys
from typing import Any

from app.pdf.errors import PdfAnalysisError, PdfFailure
from app.pdf.limits import PdfLimits


def run_isolated(
    data: bytes,
    *,
    expected_sha256: str,
    document_id: str,
    limits: PdfLimits | None = None,
) -> dict[str, Any]:
    """Analyze a PDF in a child process and return its artifact."""
    limits = limits or PdfLimits.default()
    # The limits travel with the request. The child enforces them on itself
    # (address space, CPU) and passes them to the analyzer; the parent enforces
    # only the wall clock, because a hung child cannot time itself out.
    request = json.dumps(
        {
            "sha256": expected_sha256,
            "documentId": document_id,
            "limits": limits.as_json(),
        }
    ).encode("utf-8")
    payload = len(request).to_bytes(8, "big") + request + data

    try:
        completed = subprocess.run(
            [sys.executable, "-m", "app.pdf.worker"],
            input=payload,
            capture_output=True,
            timeout=limits.timeout_ms / 1000,
            check=False,
        )
    except subprocess.TimeoutExpired as error:
        # subprocess.run has already killed the child and reaped it, so there
        # is no zombie to clean up (§130).
        raise PdfAnalysisError(
            PdfFailure.ANALYSIS_TIMEOUT, "the analysis exceeded its time budget"
        ) from error

    if completed.returncode != 0 or not completed.stdout:
        raise PdfAnalysisError(
            PdfFailure.ANALYZER_CRASHED,
            f"the analyzer exited with code {completed.returncode}",
        )

    try:
        result: dict[str, Any] = json.loads(completed.stdout.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise PdfAnalysisError(
            PdfFailure.ANALYZER_CRASHED, "the analyzer produced no usable result"
        ) from error

    if "error" in result:
        failure = result["error"]
        raise PdfAnalysisError(PdfFailure(failure["code"]), str(failure.get("detail", "")))
    artifact: dict[str, Any] = result["artifact"]
    return artifact
