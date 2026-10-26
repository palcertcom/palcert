"""Bounds on what one PDF analysis may consume (§103, §104).

A PDF is untrusted input handed to native code, and every one of these numbers
exists because some real file will otherwise ask for more than the machine has.
Reaching a limit is not a crash: the analysis records a warning, degrades the
coverage of whatever it could not finish, and keeps the evidence it did gather.
Only the document-level limits that make analysis meaningless are fatal.

Defaults are chosen for an academic document — a 300-page thesis with figures
is comfortably inside every one of them — rather than for the largest PDF that
exists.
"""

from __future__ import annotations

import dataclasses
from dataclasses import dataclass


@dataclass(frozen=True, slots=True)
class PdfLimits:
    #: Refuse a source larger than this outright; nothing is parsed.
    max_bytes: int = 200 * 1024 * 1024
    #: Pages beyond this are not analyzed. Fatal: a partial page set would
    #: silently answer "how many pages" wrongly, and that is evidence.
    max_pages: int = 2_000
    #: Page objects walked per page before the page is marked partial.
    max_objects_per_page: int = 50_000
    #: Characters extracted per document.
    max_text_chars: int = 8_000_000
    #: Image objects recorded per document.
    max_images: int = 20_000
    #: Form XObject recursion depth (§28). Deeper nesting is a bomb, not a document.
    max_form_depth: int = 12
    #: Pixels one rendered page may occupy, when rendering is used at all.
    max_render_pixels: int = 4_000_000
    #: Wall-clock budget for one analysis, enforced by the parent process.
    timeout_ms: int = 120_000
    #: Serialized artifact ceiling; a model larger than this is truncated to
    #: facts and warnings rather than stored whole.
    max_artifact_bytes: int = 32 * 1024 * 1024

    @classmethod
    def default(cls) -> PdfLimits:
        return cls()

    def as_json(self) -> dict[str, int]:
        return dataclasses.asdict(self)

    @classmethod
    def from_json(cls, values: dict[str, object] | None) -> PdfLimits:
        """Rebuild limits sent across the process boundary.

        Unknown keys are dropped rather than raising: the parent and the child
        are the same code today, and a limit this version does not know about
        is not a reason to refuse an analysis.
        """
        if not values:
            return cls()
        known = {f.name for f in dataclasses.fields(cls)}
        parsed: dict[str, int] = {}
        for key, value in values.items():
            if key in known and isinstance(value, int | float | str):
                parsed[key] = int(value)
        return cls(**parsed)
