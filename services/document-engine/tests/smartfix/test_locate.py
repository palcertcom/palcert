"""Resolving a node id back to the element it names.

The index is built by the Phase 6 walker rather than by a second walker
written to the same rules, and these tests hold that guarantee in place: the
ids the analyzer publishes are exactly the ids the mutator can resolve, and
the sections it numbers are exactly the ``w:sectPr`` elements it would edit.
"""

from __future__ import annotations

import io

from app.docx.limits import AnalyzerLimits
from app.docx.warnings import WarningCollector
from app.smartfix.locate import build_index, collect_section_properties
from tests.docx.builder import DocxBuilder, section_properties
from tests.smartfix.support import header_part

LIMITS = AnalyzerLimits.default()

BODY = (
    '<w:p><w:r><w:t xml:space="preserve">One</w:t></w:r>'
    '<w:r><w:t xml:space="preserve">Two</w:t></w:r></w:p>'
    '<w:tbl><w:tr><w:tc><w:p><w:r><w:t xml:space="preserve">Cell</w:t></w:r></w:p></w:tc></w:tr></w:tbl>'
    '<w:p><w:r><w:t xml:space="preserve">Three</w:t></w:r></w:p>'
) + section_properties()


def _index(content: bytes):
    return build_index(io.BytesIO(content), LIMITS, WarningCollector())


def test_every_paragraph_and_run_the_analyzer_named_can_be_found() -> None:
    content = DocxBuilder(body=BODY).build()
    index, package = _index(content)
    try:
        for paragraph in index.model.paragraphs:
            assert index.element_for(paragraph.locator.node_id) is not None, (
                paragraph.locator.node_id
            )
            for run in paragraph.runs:
                assert index.element_for(run.locator.node_id) is not None, run.locator.node_id
    finally:
        package.close()


def test_a_node_id_resolves_to_the_element_that_bears_its_text() -> None:
    content = DocxBuilder(body=BODY).build()
    index, package = _index(content)
    try:
        located = index.element_for("main/body/p:1/r:2")
        assert located is not None
        part, element = located
        assert part == "word/document.xml"
        assert "".join(node.text or "" for node in element.iter()) == "Two"
    finally:
        package.close()


def test_a_table_cell_paragraph_keeps_its_own_address() -> None:
    content = DocxBuilder(body=BODY).build()
    index, package = _index(content)
    try:
        assert index.element_for("main/body/tbl:1/tr:1/tc:1/p:1") is not None
        # The paragraph after the table is the second body paragraph, not the
        # third: ordinals are counted per element kind within a parent.
        located = index.element_for("main/body/p:2")
        assert located is not None
        assert "".join(node.text or "" for node in located[1].iter()) == "Three"
    finally:
        package.close()


def test_a_header_resolves_to_its_own_part() -> None:
    content = DocxBuilder(
        body='<w:p><w:r><w:t xml:space="preserve">Body</w:t></w:r></w:p>'
        + section_properties(extra='<w:headerReference w:type="default" r:id="rIdHeaderdefault"/>'),
        headers={
            "default": header_part(
                '<w:p><w:r><w:t xml:space="preserve">Running head</w:t></w:r></w:p>'
            )
        },
    ).build()
    index, package = _index(content)
    try:
        located = index.element_for("header:default:1/p:1")
        assert located is not None
        assert located[0] != index.main_part
    finally:
        package.close()


def test_sections_line_up_with_the_ones_the_analyzer_numbers() -> None:
    content = DocxBuilder(
        body="<w:p><w:pPr>" + section_properties(left=1000) + "</w:pPr></w:p>"
        '<w:p><w:r><w:t xml:space="preserve">Body</w:t></w:r></w:p>' + section_properties(left=2000)
    ).build()
    index, package = _index(content)
    try:
        assert len(index.sections) == len(index.model.sections) == 2
        # An off-by-one here would move the wrong section's margins.
        for declared, target in zip(index.model.sections, index.sections, strict=True):
            assert declared.index == target.index
        assert index.section_for(0) is not None
        assert index.section_for(5) is None
    finally:
        package.close()


def test_collect_section_properties_reads_the_body_level_one_last() -> None:
    content = DocxBuilder(
        body="<w:p><w:pPr>"
        + section_properties(left=1000)
        + "</w:pPr></w:p>"
        + section_properties(left=2000)
    ).build()
    index, package = _index(content)
    try:
        root = index.roots[index.main_part]
        body = root.find(index.namespaces.qn("w:body"))
        assert body is not None
        found = collect_section_properties(body, index.namespaces)
        assert len(found) == 2
        left = index.namespaces.qn("w:left")
        margins = [entry.find(index.namespaces.qn("w:pgMar")) for entry in found]
        assert [margin.get(left) for margin in margins if margin is not None] == ["1000", "2000"]
    finally:
        package.close()


def test_the_index_is_off_by_default_during_ordinary_analysis() -> None:
    """Analysis must not pay for something only correction needs.

    The element index keeps an entire XML tree alive; leaving it on would make
    every check hold one for no reason.
    """
    from app.docx.document import read_document
    from app.docx.package import DocxPackage

    content = DocxBuilder(body=BODY).build()
    warnings = WarningCollector()
    package = DocxPackage.open(io.BytesIO(content), LIMITS, warnings)
    try:
        assert read_document(package, LIMITS, warnings).context.elements is None
    finally:
        package.close()
