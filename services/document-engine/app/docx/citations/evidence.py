"""What the story walk records for citation analysis.

Collected during the one structural walk rather than by a second pass, for two
reasons. The walk already knows which story it is in and already assigns the
node ids, so evidence gathered here carries the same addresses as every other
finding — a second walker written to the same rules would be a second chance
to get the rules subtly wrong. And the story *domain* is whatever the walk
decided it was: an even-page header the document never uses is not walked, so
a citation in it is not counted, without this module having to re-derive that
rule and drift from it.

These objects deliberately do not go into ``StructuralModel``. A citation tag
is user content — it is the key an author typed into Word's source manager —
and the structural model is rendered into the artifact wholesale. The tag is
carried here, used for exact linking, and reaches the artifact only inside
``citationAnalysis``, where the contract bounds it.
"""

from __future__ import annotations

from dataclasses import dataclass

from app.docx.model import RevisionState
from app.docx.nodes import NodeLocator

#: Field keywords citation analysis cares about, upper-cased.
CITATION_KEYWORD = "CITATION"
BIBLIOGRAPHY_KEYWORD = "BIBLIOGRAPHY"


@dataclass(frozen=True, slots=True)
class NativeCitationField:
    """One ``CITATION`` field, as it stands in the document."""

    locator: NodeLocator
    #: The bibliography key the field names, or None when it names none.
    tag: str | None
    revision: RevisionState

    @property
    def in_document(self) -> bool:
        """Whether this field is part of the document as it now reads.

        The analyzer's view is FINAL (§55): deleted and moved-out content is
        not in the document. A citation inside a ``w:del`` was removed by
        whoever last edited the file, and counting it would report a citation
        the reader will never see — which matters here more than elsewhere,
        because the native citation count is meant to be exact.
        """
        return self.revision not in {RevisionState.DELETED, RevisionState.MOVED_FROM}


@dataclass(frozen=True, slots=True)
class BibliographyFieldMarker:
    """One ``BIBLIOGRAPHY`` field: proof that a reference region exists."""

    locator: NodeLocator
    revision: RevisionState

    @property
    def in_document(self) -> bool:
        return self.revision not in {RevisionState.DELETED, RevisionState.MOVED_FROM}


@dataclass(frozen=True, slots=True)
class RenderedReferenceParagraph:
    """One paragraph of a ``BIBLIOGRAPHY`` field's rendered result.

    Word writes the formatted bibliography between the field's ``separate``
    and ``end`` characters, so these paragraphs are the field's output rather
    than PalCert's reading of the page. That is what makes them exact evidence
    of *where* the reference list is, and it is still not exact evidence of
    what each entry means: the text is whatever the citation style produced.
    """

    locator: NodeLocator
    text: str
    revision: RevisionState

    @property
    def in_document(self) -> bool:
        return self.revision not in {RevisionState.DELETED, RevisionState.MOVED_FROM}
