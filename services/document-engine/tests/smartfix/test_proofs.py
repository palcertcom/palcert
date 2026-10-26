"""The integrity projections.

Each of these is the evidence that lets a corrected document be delivered at
all, so each has a test that it notices the change it exists to notice.
"""

from __future__ import annotations

import io
import zipfile

from app.smartfix.proofs import project
from tests.docx.builder import DocxBuilder, section_properties

BODY = '<w:p><w:r><w:t xml:space="preserve">Hello</w:t></w:r></w:p>' + section_properties()


def _project(content: bytes) -> object:
    with zipfile.ZipFile(io.BytesIO(content)) as archive:
        return project(archive)


def test_the_same_package_projects_the_same_way() -> None:
    assert _project(DocxBuilder(body=BODY).build()) == _project(DocxBuilder(body=BODY).build())


def test_changed_text_changes_the_text_hash() -> None:
    left = _project(DocxBuilder(body=BODY).build())
    right = _project(
        DocxBuilder(
            body='<w:p><w:r><w:t xml:space="preserve">Goodbye</w:t></w:r></w:p>'
            + section_properties()
        ).build()
    )
    assert left.visible_text != right.visible_text  # type: ignore[attr-defined]


def test_formatting_alone_does_not_change_the_text_hash() -> None:
    left = _project(DocxBuilder(body=BODY).build())
    right = _project(
        DocxBuilder(
            body='<w:p><w:r><w:rPr><w:b/></w:rPr><w:t xml:space="preserve">Hello</w:t></w:r></w:p>'
            + section_properties()
        ).build()
    )
    assert left.visible_text == right.visible_text  # type: ignore[attr-defined]


def test_deleted_text_is_not_visible_text() -> None:
    # ``w:delText`` is not what a reader sees, so it is not part of the
    # invariant that protects what a reader sees.
    with_deletion = DocxBuilder(
        body='<w:p><w:r><w:t xml:space="preserve">Hello</w:t></w:r>'
        '<w:del w:id="1" w:author="A" w:date="2026-01-01T00:00:00Z">'
        "<w:r><w:delText>gone</w:delText></w:r></w:del></w:p>" + section_properties()
    ).build()
    assert (
        _project(with_deletion).visible_text
        == _project(  # type: ignore[attr-defined]
            DocxBuilder(body=BODY).build()
        ).visible_text
    )  # type: ignore[attr-defined]


def test_a_changed_field_instruction_is_caught() -> None:
    left = _project(
        DocxBuilder(
            body="<w:p><w:r><w:instrText>PAGE</w:instrText></w:r></w:p>" + section_properties()
        ).build()
    )
    right = _project(
        DocxBuilder(
            body="<w:p><w:r><w:instrText>NUMPAGES</w:instrText></w:r></w:p>" + section_properties()
        ).build()
    )
    assert left.field_instructions != right.field_instructions  # type: ignore[attr-defined]


def test_a_changed_image_is_caught() -> None:
    left = _project(DocxBuilder(body=BODY, raw_parts={"word/media/a.png": b"\x89PNG-1"}).build())
    right = _project(DocxBuilder(body=BODY, raw_parts={"word/media/a.png": b"\x89PNG-2"}).build())
    assert left.media_set != right.media_set  # type: ignore[attr-defined]


def test_a_dropped_relationship_is_caught() -> None:
    left = _project(
        DocxBuilder(body=BODY, extra_relationships={"rIdX": ("image", "media/a.png")}).build()
    )
    right = _project(DocxBuilder(body=BODY).build())
    assert left.relationships != right.relationships  # type: ignore[attr-defined]
