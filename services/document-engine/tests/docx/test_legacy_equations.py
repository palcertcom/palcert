"""Equations in a thesis: Office Math and legacy equation objects.

A MathType (``Equation.DSMT4``) or Equation 3.0 object is an equation, not a
picture: it is counted with the OMML ones, keeps its place and its printed
number, and says plainly that its mathematics was not read. The embedded
binary itself is never opened — these fixtures put a hostile blob behind the
relationship to prove it.
"""

from __future__ import annotations

import hashlib
import json
from typing import Any

from app.docx.analyzer import AnalysisRequest, analyze
from tests.docx.builder import DocxBuilder, style, styles_part

NORMAL = '<w:rFonts w:ascii="Calibri" w:hAnsi="Calibri"/><w:sz w:val="24"/>'
STYLES = styles_part(style("Normal", name="Normal", default=True, run_properties=NORMAL))
O_NS = "urn:schemas-microsoft-com:office:office"

#: Not an OLE container at all. If anything tried to open or run it, the
#: analysis would fail or change; it must not.
HOSTILE_BLOB = b"MZ\x90\x00" + b"\x00" * 60 + b"this is not an equation"


def _text(value: str) -> str:
    return f'<w:p><w:r><w:t xml:space="preserve">{value}</w:t></w:r></w:p>'


def _legacy(
    index: int, prog_id: str = "Equation.DSMT4", number: str | None = "3.1", preview: bool = True
) -> str:
    image = f'<v:imagedata r:id="rIdImg{index}" o:title=""/>' if preview else ""
    trailing = f"<w:r><w:tab/><w:t>({number})</w:t></w:r>" if number is not None else ""
    return (
        "<w:p><w:r><w:tab/></w:r><w:r>"
        f'<w:object xmlns:o="{O_NS}" w:dxaOrig="1200" w:dyaOrig="360">'
        f'<v:shape id="_x0000_i10{index}" type="#_x0000_t75" style="width:60pt;height:18pt">{image}</v:shape>'
        f'<o:OLEObject Type="Embed" ProgID="{prog_id}" ShapeID="_x0000_i10{index}" '
        f'DrawAspect="Content" ObjectID="_17000{index}" r:id="rIdOle{index}"/>'
        "</w:object></w:r>"
        f"{trailing}</w:p>"
    )


OMML = "<w:p><m:oMathPara><m:oMath><m:r><m:t>E=mc</m:t></m:r></m:oMath></m:oMathPara><w:r><w:tab/><w:t>(3.2)</w:t></w:r></w:p>"


def _analyze(body: str, objects: int = 1) -> dict[str, Any]:
    builder = DocxBuilder(body=body, styles=STYLES)
    for index in range(1, objects + 1):
        builder.extra_relationships[f"rIdOle{index}"] = (
            "oleObject",
            f"embeddings/oleObject{index}.bin",
        )
        builder.extra_relationships[f"rIdImg{index}"] = ("image", f"media/image{index}.wmf")
        builder.raw_parts[f"word/embeddings/oleObject{index}.bin"] = HOSTILE_BLOB
        builder.raw_parts[f"word/media/image{index}.wmf"] = b"\xd7\xcd\xc6\x9a\x00\x00"
    content = builder.build()
    outcome = analyze(
        AnalysisRequest(
            document_id="thesis",
            content=content,
            expected_sha256=hashlib.sha256(content).hexdigest(),
        )
    )
    envelope = json.loads(outcome.artifact.content)
    assert isinstance(envelope, dict)
    return envelope


def _count(envelope: dict[str, Any], name: str) -> Any:
    for fact in envelope["factSet"]["facts"]:
        scope = fact["scope"]
        if scope["kind"] == "DOCUMENT" and scope.get("property") == name:
            return fact["value"].get("number")
    return None


def _warnings(envelope: dict[str, Any]) -> set[str]:
    return {warning["code"] for warning in envelope["warnings"]}


def test_a_mathtype_equation_is_an_equation_with_its_number_and_place() -> None:
    envelope = _analyze(
        _text("Chapter 3 Methodology")
        + _text("Energy is given by")
        + _legacy(1)
        + _text("as (3.1) shows.")
    )
    equations = envelope["structuralModel"]["equations"]
    assert len(equations) == 1
    equation = equations[0]
    assert equation["sourceFormat"] == "legacy-ole"
    assert equation["legacyClass"] == "Equation.DSMT4"
    assert equation["previewAvailable"] is True
    assert equation["semanticsAvailable"] is False
    assert equation["number"] == "3.1"
    assert equation["order"] == 1
    # It sits in the third paragraph, after the text that introduces it.
    paragraphs = [
        paragraph["locator"]["nodeId"] for paragraph in envelope["structuralModel"]["paragraphs"]
    ]
    assert equation["paragraphNodeId"] == paragraphs[2]
    assert equation["locator"]["nodeId"].startswith(equation["paragraphNodeId"] + "/")

    assert _count(envelope, "equationCount") == "1"
    # Not a figure: counting it as one was the version-4 behaviour.
    assert _count(envelope, "figureCount") in (None, "0")
    assert "LEGACY_EQUATION_SEMANTICS_UNAVAILABLE" in _warnings(envelope)


def test_several_legacy_equations_keep_their_order_and_numbers() -> None:
    body = _text("Chapter 3") + "".join(_legacy(i, number=f"3.{i}") for i in (1, 2, 3))
    equations = _analyze(body, objects=3)["structuralModel"]["equations"]
    assert [equation["order"] for equation in equations] == [1, 2, 3]
    assert [equation["number"] for equation in equations] == ["3.1", "3.2", "3.3"]


def test_omml_and_legacy_equations_together() -> None:
    envelope = _analyze(_text("Chapter 3") + _legacy(1) + OMML)
    equations = envelope["structuralModel"]["equations"]
    assert [equation["sourceFormat"] for equation in equations] == ["legacy-ole", "omml"]
    assert [equation["number"] for equation in equations] == ["3.1", "3.2"]
    assert equations[1]["semanticsAvailable"] is True
    assert "legacyClass" not in equations[1]
    assert _count(envelope, "equationCount") == "2"


def test_omml_alone_raises_no_legacy_warning() -> None:
    envelope = _analyze(_text("Chapter 3") + OMML, objects=0)
    assert _count(envelope, "equationCount") == "1"
    assert "LEGACY_EQUATION_SEMANTICS_UNAVAILABLE" not in _warnings(envelope)


def test_a_legacy_equation_without_a_preview_or_a_number() -> None:
    equation = _analyze(_legacy(1, number=None, preview=False))["structuralModel"]["equations"][0]
    assert equation["previewAvailable"] is False
    assert "number" not in equation


def test_an_object_of_any_other_class_is_not_treated_as_an_equation() -> None:
    envelope = _analyze(_legacy(1, prog_id="Package"))
    assert envelope["structuralModel"]["equations"] == []
    assert "LEGACY_EQUATION_SEMANTICS_UNAVAILABLE" not in _warnings(envelope)


def test_the_embedded_binary_is_never_read(monkeypatch: Any) -> None:
    """Every part the analyzer opens goes through the ZIP reader; the embedding never does."""
    import zipfile

    requested: list[str] = []
    original = zipfile.ZipFile.open

    def spy(self: zipfile.ZipFile, name: Any, *args: Any, **kwargs: Any) -> Any:
        mode = args[0] if args else kwargs.get("mode", "r")
        if mode == "r":  # the fixture builder writing the package is not a read
            requested.append(name if isinstance(name, str) else name.filename)
        return original(self, name, *args, **kwargs)

    monkeypatch.setattr(zipfile.ZipFile, "open", spy)
    envelope = _analyze(_text("Chapter 3") + _legacy(1))
    assert envelope["structuralModel"]["equations"][0]["legacyClass"] == "Equation.DSMT4"
    assert "word/document.xml" in requested  # the spy is really in the path
    assert not any(name.startswith("word/embeddings/") for name in requested)


def test_the_real_phd_template_equation_verbatim() -> None:
    """PhD_Template_00.docx: the paragraph holding (3.1), byte for byte.

    The real root declares its own namespaces (w14, o, v …), so the fixture
    document is written with it rather than with the builder's defaults.
    """
    from tests.docx.real_phd_template import REAL_DOCUMENT_ROOT, REAL_EQUATION_PARAGRAPH

    class RealRoot(DocxBuilder):
        def document_xml(self) -> str:
            return (
                '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'
                f"{REAL_DOCUMENT_ROOT}<w:body>{self.body}</w:body></w:document>"
            )

    builder = RealRoot(body=_text("3.3 Equations:") + REAL_EQUATION_PARAGRAPH, styles=STYLES)
    builder.extra_relationships["rId15"] = ("oleObject", "embeddings/oleObject1.bin")
    builder.extra_relationships["rId14"] = ("image", "media/image5.wmf")
    builder.raw_parts["word/embeddings/oleObject1.bin"] = HOSTILE_BLOB
    builder.raw_parts["word/media/image5.wmf"] = b"\xd7\xcd\xc6\x9a\x00\x00"
    content = builder.build()
    envelope = json.loads(
        analyze(
            AnalysisRequest(
                document_id="phd",
                content=content,
                expected_sha256=hashlib.sha256(content).hexdigest(),
            )
        ).artifact.content
    )
    [equation] = envelope["structuralModel"]["equations"]
    assert equation["sourceFormat"] == "legacy-ole"
    assert equation["legacyClass"] == "Equation.DSMT4"
    assert equation["previewAvailable"] is True
    assert equation["semanticsAvailable"] is False
    assert equation["number"] == "3.1"
    assert _count(envelope, "equationCount") == "1"
    assert "LEGACY_EQUATION_SEMANTICS_UNAVAILABLE" in _warnings(envelope)
