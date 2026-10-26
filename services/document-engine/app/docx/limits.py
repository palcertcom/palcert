"""Resource limits for DOCX analysis (Master Prompt Phase 6 §80, §82).

Phase 5 bounded the *package*: entry count, entry size, total uncompressed
size, compression ratio. Those limits stop a ZIP bomb, and they say nothing
about what the XML inside can cost. A 2 MB ``document.xml`` that is entirely
nested elements, or that declares two hundred thousand runs, passes every
Phase 5 check and can still exhaust a worker.

So the analyzer carries its own budget, and every limit is a named constant
here rather than a number buried in a parser (§80, and the Phase 5 rule
against scattered constants).
"""

from __future__ import annotations

from dataclasses import dataclass


@dataclass(frozen=True, slots=True)
class AnalyzerLimits:
    """Every bound the analyzer enforces. All are inclusive maxima."""

    #: Largest single XML part the analyzer will read, in bytes.
    max_part_bytes: int = 64 * 1024 * 1024
    #: Largest total of all XML parts read for one analysis.
    max_total_xml_bytes: int = 256 * 1024 * 1024
    #: Deepest element nesting accepted in any part.
    max_xml_depth: int = 200
    #: Elements in one part.
    max_xml_elements: int = 3_000_000

    max_paragraphs: int = 200_000
    max_runs: int = 1_000_000
    max_tables: int = 20_000
    max_table_cells: int = 500_000
    max_styles: int = 10_000
    max_numbering_definitions: int = 10_000
    max_relationships: int = 20_000
    max_sections: int = 2_000
    max_notes: int = 50_000
    max_drawings: int = 50_000

    #: Style ``basedOn`` chain length before the chain is declared pathological.
    max_style_chain_depth: int = 50

    #: Facts one analysis may emit. The shared schema caps a fact set at
    #: 100 000; staying below it means an over-large document is refused by a
    #: named limit rather than by a schema violation at the last moment.
    max_facts: int = 90_000
    #: Warnings recorded before the collector stops adding (§78 "bounded").
    max_warnings: int = 500
    #: Serialized analysis artifact size.
    max_artifact_bytes: int = 128 * 1024 * 1024

    #: Text retained per paragraph in the structural model (§72 minimization).
    max_retained_text_chars: int = 4_000

    @staticmethod
    def default() -> AnalyzerLimits:
        return AnalyzerLimits()


class ResourceLimitExceededError(Exception):
    """A documented limit was hit. Always fatal: partial output would be a lie
    about a document we stopped reading."""

    def __init__(self, limit_name: str, limit_value: int) -> None:
        super().__init__(f"analyzer limit {limit_name} ({limit_value}) exceeded")
        self.limit_name = limit_name
        self.limit_value = limit_value
