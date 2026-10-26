"""Building DOCX packages from raw OOXML, in code (§99, §100).

A committed binary ``.docx`` is an opaque blob: nobody reviewing a pull
request can see what it exercises, and nobody can regenerate it after a defect
is found. Every PalCert fixture is therefore *built here*, from the exact
OOXML it is meant to test, so the fixture and its explanation are the same
artifact.

Packages are written with fixed ZIP timestamps so a fixture's bytes are
identical on every machine — which is what lets determinism tests compare
analysis output across runs without the container changing underneath them.
"""

from __future__ import annotations

import io
import zipfile
from dataclasses import dataclass, field

W = "http://schemas.openxmlformats.org/wordprocessingml/2006/main"
R = "http://schemas.openxmlformats.org/officeDocument/2006/relationships"
A = "http://schemas.openxmlformats.org/drawingml/2006/main"
WP = "http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing"
MC = "http://schemas.openxmlformats.org/markup-compatibility/2006"
M = "http://schemas.openxmlformats.org/officeDocument/2006/math"
V = "urn:schemas-microsoft-com:vml"

W_STRICT = "http://purl.oclc.org/ooxml/wordprocessingml/main"
R_STRICT = "http://purl.oclc.org/ooxml/officeDocument/relationships"

#: Every namespace a fixture might use, declared on the document root so the
#: fixture bodies stay readable.
DOCUMENT_NAMESPACES = (
    f'xmlns:w="{W}" xmlns:r="{R}" xmlns:a="{A}" xmlns:wp="{WP}" '
    f'xmlns:mc="{MC}" xmlns:m="{M}" xmlns:v="{V}"'
)

_FIXED_TIMESTAMP = (2026, 1, 1, 0, 0, 0)

CONTENT_TYPES = """<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Default Extension="png" ContentType="image/png"/>
  <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
{overrides}
</Types>"""

PACKAGE_RELS = """<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rIdDoc" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
{extra}
</Relationships>"""


@dataclass(slots=True)
class DocxBuilder:
    """Assemble one package part by part."""

    body: str = "<w:p/>"
    styles: str | None = None
    numbering: str | None = None
    theme: str | None = None
    settings: str | None = None
    footnotes: str | None = None
    endnotes: str | None = None
    comments: str | None = None
    core_properties: str | None = None
    extended_properties: str | None = None
    headers: dict[str, str] = field(default_factory=dict)
    footers: dict[str, str] = field(default_factory=dict)
    #: Extra document relationships as {id: (type segment, target)}.
    extra_relationships: dict[str, tuple[str, str]] = field(default_factory=dict)
    #: Raw parts written verbatim, for malformed-package fixtures.
    raw_parts: dict[str, bytes] = field(default_factory=dict)
    strict_profile: bool = False
    omit_document_part: bool = False
    omit_office_document_relationship: bool = False

    def document_xml(self) -> str:
        if self.strict_profile:
            namespaces = f'xmlns:w="{W_STRICT}" xmlns:r="{R_STRICT}"'
        else:
            namespaces = DOCUMENT_NAMESPACES
        return (
            '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'
            f"<w:document {namespaces}><w:body>{self.body}</w:body></w:document>"
        )

    def build(self) -> bytes:
        parts: dict[str, bytes] = {}
        overrides: list[str] = []
        document_relationships: list[str] = []

        def add(part_name: str, content: str, content_type: str | None = None) -> None:
            parts[part_name] = content.encode("utf-8")
            if content_type:
                overrides.append(
                    f'  <Override PartName="/{part_name}" ContentType="{content_type}"/>'
                )

        def relate(relationship_id: str, kind: str, target: str) -> None:
            document_relationships.append(
                f'  <Relationship Id="{relationship_id}" '
                f'Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/{kind}" '
                f'Target="{target}"/>'
            )

        if not self.omit_document_part:
            add("word/document.xml", self.document_xml())

        named = (
            (
                "styles",
                self.styles,
                "word/styles.xml",
                "application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml",
            ),
            (
                "numbering",
                self.numbering,
                "word/numbering.xml",
                "application/vnd.openxmlformats-officedocument.wordprocessingml.numbering+xml",
            ),
            (
                "theme",
                self.theme,
                "word/theme/theme1.xml",
                "application/vnd.openxmlformats-officedocument.theme+xml",
            ),
            (
                "settings",
                self.settings,
                "word/settings.xml",
                "application/vnd.openxmlformats-officedocument.wordprocessingml.settings+xml",
            ),
            (
                "footnotes",
                self.footnotes,
                "word/footnotes.xml",
                "application/vnd.openxmlformats-officedocument.wordprocessingml.footnotes+xml",
            ),
            (
                "endnotes",
                self.endnotes,
                "word/endnotes.xml",
                "application/vnd.openxmlformats-officedocument.wordprocessingml.endnotes+xml",
            ),
            (
                "comments",
                self.comments,
                "word/comments.xml",
                "application/vnd.openxmlformats-officedocument.wordprocessingml.comments+xml",
            ),
        )
        for kind, content, part_name, content_type in named:
            if content is None:
                continue
            add(part_name, content, content_type)
            relate(f"rId{kind.capitalize()}", kind, part_name.removeprefix("word/"))

        for reference_type, content in sorted(self.headers.items()):
            part_name = f"word/header_{reference_type}.xml"
            add(
                part_name,
                content,
                "application/vnd.openxmlformats-officedocument.wordprocessingml.header+xml",
            )
            relate(f"rIdHeader{reference_type}", "header", part_name.removeprefix("word/"))

        for reference_type, content in sorted(self.footers.items()):
            part_name = f"word/footer_{reference_type}.xml"
            add(
                part_name,
                content,
                "application/vnd.openxmlformats-officedocument.wordprocessingml.footer+xml",
            )
            relate(f"rIdFooter{reference_type}", "footer", part_name.removeprefix("word/"))

        for relationship_id, (kind, target) in sorted(self.extra_relationships.items()):
            relate(relationship_id, kind, target)

        package_extra: list[str] = []
        if self.core_properties is not None:
            add(
                "docProps/core.xml",
                self.core_properties,
                "application/vnd.openxmlformats-package.core-properties+xml",
            )
            package_extra.append(
                '  <Relationship Id="rIdCore" '
                'Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" '
                'Target="docProps/core.xml"/>'
            )
        if self.extended_properties is not None:
            add(
                "docProps/app.xml",
                self.extended_properties,
                "application/vnd.openxmlformats-officedocument.extended-properties+xml",
            )
            package_extra.append(
                '  <Relationship Id="rIdApp" '
                'Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" '
                'Target="docProps/app.xml"/>'
            )

        parts["[Content_Types].xml"] = CONTENT_TYPES.format(overrides="\n".join(overrides)).encode(
            "utf-8"
        )
        parts["_rels/.rels"] = PACKAGE_RELS.format(extra="\n".join(package_extra)).encode("utf-8")
        if self.omit_office_document_relationship:
            parts["_rels/.rels"] = (
                b'<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
                b'<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"/>'
            )

        parts["word/_rels/document.xml.rels"] = (
            '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'
            '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">\n'
            + "\n".join(document_relationships)
            + "\n</Relationships>"
        ).encode("utf-8")

        parts.update(self.raw_parts)

        buffer = io.BytesIO()
        with zipfile.ZipFile(buffer, "w", zipfile.ZIP_DEFLATED) as archive:
            for name in sorted(parts):
                info = zipfile.ZipInfo(name, date_time=_FIXED_TIMESTAMP)
                info.compress_type = zipfile.ZIP_DEFLATED
                archive.writestr(info, parts[name])
        return buffer.getvalue()


# --- small builders for readable fixture bodies ----------------------------


def paragraph(
    text: str = "",
    *,
    style: str | None = None,
    properties: str = "",
    run_properties: str = "",
) -> str:
    ppr = ""
    if style or properties:
        style_xml = f'<w:pStyle w:val="{style}"/>' if style else ""
        ppr = f"<w:pPr>{style_xml}{properties}</w:pPr>"
    body = run(text, run_properties) if text else ""
    return f"<w:p>{ppr}{body}</w:p>"


def run(text: str, properties: str = "") -> str:
    rpr = f"<w:rPr>{properties}</w:rPr>" if properties else ""
    return f'<w:r>{rpr}<w:t xml:space="preserve">{text}</w:t></w:r>'


def styles_part(body: str, doc_defaults: str = "") -> str:
    defaults = f"<w:docDefaults>{doc_defaults}</w:docDefaults>" if doc_defaults else ""
    return (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        f'<w:styles xmlns:w="{W}">{defaults}{body}</w:styles>'
    )


def style(
    style_id: str,
    *,
    style_type: str = "paragraph",
    name: str | None = None,
    based_on: str | None = None,
    default: bool = False,
    paragraph_properties: str = "",
    run_properties: str = "",
    extra: str = "",
) -> str:
    attributes = f'w:type="{style_type}" w:styleId="{style_id}"'
    if default:
        attributes += ' w:default="1"'
    parts = []
    if name:
        parts.append(f'<w:name w:val="{name}"/>')
    if based_on:
        parts.append(f'<w:basedOn w:val="{based_on}"/>')
    if paragraph_properties:
        parts.append(f"<w:pPr>{paragraph_properties}</w:pPr>")
    if run_properties:
        parts.append(f"<w:rPr>{run_properties}</w:rPr>")
    parts.append(extra)
    return f"<w:style {attributes}>{''.join(parts)}</w:style>"


def theme_part(
    major_latin: str = "Calibri Light",
    minor_latin: str = "Calibri",
    major_cs: str = "Times New Roman",
    minor_cs: str = "Arial",
) -> str:
    return (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        f'<a:theme xmlns:a="{A}" name="Office"><a:themeElements><a:fontScheme name="Office">'
        f'<a:majorFont><a:latin typeface="{major_latin}"/><a:ea typeface=""/>'
        f'<a:cs typeface="{major_cs}"/></a:majorFont>'
        f'<a:minorFont><a:latin typeface="{minor_latin}"/><a:ea typeface=""/>'
        f'<a:cs typeface="{minor_cs}"/></a:minorFont>'
        "</a:fontScheme></a:themeElements></a:theme>"
    )


def settings_part(body: str = "") -> str:
    return (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        f'<w:settings xmlns:w="{W}">{body}</w:settings>'
    )


def section_properties(
    *,
    width: int = 11906,
    height: int = 16838,
    orientation: str | None = None,
    top: int = 1440,
    bottom: int = 1440,
    left: int = 1440,
    right: int = 1440,
    header_distance: int = 720,
    footer_distance: int = 720,
    gutter: int = 0,
    extra: str = "",
) -> str:
    orient = f' w:orient="{orientation}"' if orientation else ""
    return (
        f"<w:sectPr>{extra}"
        f'<w:pgSz w:w="{width}" w:h="{height}"{orient}/>'
        f'<w:pgMar w:top="{top}" w:right="{right}" w:bottom="{bottom}" w:left="{left}" '
        f'w:header="{header_distance}" w:footer="{footer_distance}" w:gutter="{gutter}"/>'
        "</w:sectPr>"
    )
