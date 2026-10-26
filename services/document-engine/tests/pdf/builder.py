"""Building PDFs from raw objects, so a golden corpus has known provenance (§118).

Every fixture in this corpus is constructed here, object by object, rather than
produced by a word processor and checked in as an opaque blob. Three reasons:

* **The expected value is derivable.** A test can assert a page is exactly
  595 x 842 because this file put 595 x 842 in the MediaBox, not because
  somebody measured a PDF once and wrote the number down.
* **A failure localises.** When an assertion breaks, the fixture is forty lines
  of readable dictionaries a few inches above it.
* **Nothing arrives unexamined.** A binary from the internet may carry anything;
  these carry exactly what is written here.

``deterministic_id=True`` on save means the same construction produces the same
bytes, which is what lets the corpus assert reproducibility (§97).
"""

from __future__ import annotations

import io
import zlib
from typing import Any

import pikepdf

A4 = (0, 0, 595, 842)
LETTER = (0, 0, 612, 792)


def _stream(pdf: pikepdf.Pdf, data: bytes) -> Any:
    return pdf.make_stream(data)


def font(pdf: pikepdf.Pdf, base: str = "Helvetica", subtype: str = "Type1") -> Any:
    """One of the 14 standard fonts: present in every reader, embedded in none."""
    return pdf.make_indirect(
        pikepdf.Dictionary(
            Type=pikepdf.Name.Font,
            Subtype=pikepdf.Name(f"/{subtype}"),
            BaseFont=pikepdf.Name(f"/{base}"),
        )
    )


def embedded_font(
    pdf: pikepdf.Pdf,
    base: str = "ABCDEF+PalCertSans",
    *,
    weight: int | None = None,
    italic_angle: float | None = None,
    flags: int = 32,
) -> Any:
    """A font with a descriptor and an embedded program.

    The program is not a real typeface - PDFium never rasterises it in these
    tests - but the descriptor is what font identity is read from, so the
    fixture carries a genuine one.
    """
    descriptor = pikepdf.Dictionary(
        Type=pikepdf.Name.FontDescriptor,
        FontName=pikepdf.Name(f"/{base}"),
        Flags=flags,
        ItalicAngle=italic_angle if italic_angle is not None else 0,
        Ascent=750,
        Descent=-250,
        CapHeight=700,
        StemV=80,
        FontBBox=[-200, -250, 1000, 900],
    )
    if weight is not None:
        descriptor.FontWeight = weight
    descriptor.FontFile2 = pdf.make_stream(zlib.compress(b"\x00" * 256))
    return pdf.make_indirect(
        pikepdf.Dictionary(
            Type=pikepdf.Name.Font,
            Subtype=pikepdf.Name.TrueType,
            BaseFont=pikepdf.Name(f"/{base}"),
            FirstChar=32,
            LastChar=255,
            Widths=[500] * 224,
            FontDescriptor=pdf.make_indirect(descriptor),
        )
    )


def image_xobject(pdf: pikepdf.Pdf, width: int = 8, height: int = 8) -> Any:
    """A tiny grayscale image. Size on the page comes from the content matrix."""
    # A real stream with real samples, not a dictionary that describes one: a
    # renderer is entitled to ignore an image object it cannot decode, and an
    # image the renderer ignores is not evidence of anything.
    samples = bytes((x * 31 + y * 7) % 256 for y in range(height) for x in range(width))
    stream = pdf.make_stream(samples)
    stream.Type = pikepdf.Name.XObject
    stream.Subtype = pikepdf.Name.Image
    stream.Width = width
    stream.Height = height
    stream.ColorSpace = pikepdf.Name.DeviceGray
    stream.BitsPerComponent = 8
    return pdf.make_indirect(stream)


def text(content: str, *, font_ref: str = "F1", size: int = 12, x: int = 72, y: int = 700) -> bytes:
    """A text-showing operator sequence at an absolute position."""
    escaped = content.replace("\\", r"\\").replace("(", r"\(").replace(")", r"\)")
    return f"BT /{font_ref} {size} Tf {x} {y} Td ({escaped}) Tj ET\n".encode("latin-1", "replace")


def text_matrix(
    content: str,
    matrix: tuple[float, float, float, float, float, float],
    *,
    font_ref: str = "F1",
    size: int = 10,
) -> bytes:
    """Text placed by an explicit text matrix, for scale and rotation fixtures (§44)."""
    a, b, c, d, e, f = matrix
    escaped = content.replace("(", r"\(").replace(")", r"\)")
    return (f"BT {a} {b} {c} {d} {e} {f} Tm /{font_ref} {size} Tf ({escaped}) Tj ET\n").encode(
        "latin-1", "replace"
    )


def unicode_text(
    content: str, *, font_ref: str = "F1", size: int = 12, x: int = 72, y: int = 700
) -> bytes:
    """Text written as a hex string, for content outside Latin-1 (§119)."""
    hexed = content.encode("utf-16-be").hex()
    return f"BT /{font_ref} {size} Tf {x} {y} Td <{hexed}> Tj ET\n".encode("ascii")


def marked(tag: str, mcid: int, content: bytes) -> bytes:
    """Wrap content in a marked-content sequence carrying an MCID.

    This is what actually makes a PDF tagged: the structure element names an
    integer, and the content stream stamps the same integer on the run it
    describes (ISO 32000-2 14.7.4.2). A fixture with a structure tree and no
    marks in the content is a document that claims structure it cannot point
    at, and the corpus carries both cases deliberately.
    """
    return f"/{tag.lstrip('/')} <</MCID {mcid}>> BDC\n".encode("ascii") + content + b"EMC\n"


def draw_image(name: str, *, x: int, y: int, width: int, height: int) -> bytes:
    return f"q {width} 0 0 {height} {x} {y} cm /{name} Do Q\n".encode("ascii")


def page(
    pdf: pikepdf.Pdf,
    content: bytes,
    *,
    media_box: tuple[int, int, int, int] = A4,
    crop_box: tuple[int, int, int, int] | None = None,
    rotate: int | None = None,
    fonts: dict[str, Any] | None = None,
    xobjects: dict[str, Any] | None = None,
    annotations: list[Any] | None = None,
    extra: dict[str, Any] | None = None,
) -> pikepdf.Page:
    resources = pikepdf.Dictionary()
    if fonts:
        resources.Font = pikepdf.Dictionary(**fonts)
    if xobjects:
        resources.XObject = pikepdf.Dictionary(**xobjects)
    node = pikepdf.Dictionary(
        Type=pikepdf.Name.Page,
        MediaBox=list(media_box),
        Resources=resources,
        Contents=_stream(pdf, content),
    )
    if crop_box is not None:
        node.CropBox = list(crop_box)
    if rotate is not None:
        node.Rotate = rotate
    if annotations:
        node.Annots = pdf.make_indirect(pikepdf.Array(annotations))
    if extra:
        for key, value in extra.items():
            setattr(node, key, value)
    return pikepdf.Page(pdf.make_indirect(node))


def document(pages: list[pikepdf.Page] | None = None) -> pikepdf.Pdf:
    pdf = pikepdf.Pdf.new()
    for item in pages or []:
        pdf.pages.append(item)
    return pdf


def serialize(pdf: pikepdf.Pdf, **kwargs: Any) -> bytes:
    """The same construction always yields the same bytes."""
    buffer = io.BytesIO()
    pdf.save(buffer, deterministic_id=True, **kwargs)
    return buffer.getvalue()


def simple_text_pdf(
    *,
    lines: tuple[str, ...] = ("The quick brown fox jumps over the lazy dog and keeps going",),
    size: int = 12,
    media_box: tuple[int, int, int, int] = A4,
    pages_count: int = 1,
) -> bytes:
    """The corpus baseline: native text, one standard font, nothing unusual."""
    pdf = document()
    helvetica = font(pdf)
    for _ in range(pages_count):
        content = b""
        y = 700
        for line in lines:
            content += text(line, size=size, y=y)
            y -= size + 4
        pdf.pages.append(page(pdf, content, media_box=media_box, fonts={"F1": helvetica}))
    return serialize(pdf)


def tagged_pdf(roles: tuple[str, ...] = ("/H1", "/P"), *, marks: bool = True) -> bytes:
    """A document whose structure tree declares real semantic roles (§34).

    The visual result is identical to an untagged fixture with the same text,
    which is the point: the only difference is the declaration, and only the
    declaration may produce semantic facts.

    ``marks=False`` keeps the structure tree and drops the marked content, so a
    test can prove PalCert refuses to attach a role it cannot bind.
    """
    pdf = document()
    helvetica = font(pdf)
    bodies = [
        text("Chapter One", size=18, y=700),
        text("Body text beneath the heading", size=12, y=660),
    ]
    content = b""
    for index in range(len(roles)):
        body = bodies[index] if index < len(bodies) else text(f"Run {index}", y=620 - 40 * index)
        content += marked(roles[index], index, body) if marks else body
    target = page(pdf, content, fonts={"F1": helvetica}, extra={"StructParents": 0})
    pdf.pages.append(target)
    page_ref = pdf.pages[0].obj

    kids = [
        pdf.make_indirect(
            pikepdf.Dictionary(
                Type=pikepdf.Name.StructElem, S=pikepdf.Name(role), Pg=page_ref, K=index
            )
        )
        for index, role in enumerate(roles)
    ]
    struct_root = pdf.make_indirect(
        pikepdf.Dictionary(
            Type=pikepdf.Name.StructTreeRoot,
            K=pikepdf.Array(kids),
            ParentTree=pdf.make_indirect(
                pikepdf.Dictionary(Nums=pikepdf.Array([0, pikepdf.Array(kids)]))
            ),
            ParentTreeNextKey=1,
        )
    )
    pdf.Root.StructTreeRoot = struct_root
    pdf.Root.MarkInfo = pikepdf.Dictionary(Marked=True)
    return serialize(pdf)


def scanned_pdf(*, pages_count: int = 1, with_text_page: bool = False) -> bytes:
    """A page that is one big image, i.e. a scan (§50, §51)."""
    pdf = document()
    helvetica = font(pdf)
    for _ in range(pages_count):
        image = image_xobject(pdf)
        pdf.pages.append(
            page(
                pdf,
                draw_image("Im1", x=0, y=0, width=595, height=842),
                xobjects={"Im1": image},
                fonts={"F1": helvetica},
            )
        )
    if with_text_page:
        pdf.pages.append(
            page(
                pdf,
                text("A page of genuine native text following the scanned pages here"),
                fonts={"F1": helvetica},
            )
        )
    return serialize(pdf)


def metadata_pdf(
    *, xmp: dict[str, str] | None = None, doc_info: dict[str, str] | None = None
) -> bytes:
    """A document carrying XMP, DocumentInfo, or both in disagreement (§72)."""
    pdf = document()
    helvetica = font(pdf)
    pdf.pages.append(page(pdf, text("Metadata fixture"), fonts={"F1": helvetica}))
    if xmp:
        with pdf.open_metadata(set_pikepdf_as_editor=False, update_docinfo=False) as meta:
            for key, value in xmp.items():
                meta[key] = [value] if key == "dc:creator" else value
    if doc_info:
        # Keyword names carry no slash: pikepdf adds it, and passing "/Title"
        # here produces "//Title", which is a different key that nothing reads.
        pdf.trailer["/Info"] = pdf.make_indirect(
            pikepdf.Dictionary(**{k.lstrip("/"): pikepdf.String(v) for k, v in doc_info.items()})
        )
    return serialize(pdf)


def active_content_pdf() -> bytes:
    """JavaScript, a Launch action and a URI action. None of them is ever run (§126)."""
    pdf = document()
    helvetica = font(pdf)
    launch = pdf.make_indirect(
        pikepdf.Dictionary(
            Type=pikepdf.Name.Annot,
            Subtype=pikepdf.Name.Link,
            Rect=[0, 0, 10, 10],
            A=pikepdf.Dictionary(S=pikepdf.Name.Launch, F=pikepdf.String("/bin/sh")),
        )
    )
    uri = pdf.make_indirect(
        pikepdf.Dictionary(
            Type=pikepdf.Name.Annot,
            Subtype=pikepdf.Name.Link,
            Rect=[0, 0, 10, 10],
            A=pikepdf.Dictionary(
                S=pikepdf.Name.URI, URI=pikepdf.String("https://example.invalid/x")
            ),
        )
    )
    pdf.pages.append(
        page(
            pdf, text("Active content fixture"), fonts={"F1": helvetica}, annotations=[launch, uri]
        )
    )
    script = pdf.make_stream(b"app.alert('this must never run');")
    pdf.Root.Names = pikepdf.Dictionary(
        JavaScript=pikepdf.Dictionary(
            Names=pikepdf.Array(
                [
                    pikepdf.String("evil"),
                    pdf.make_indirect(pikepdf.Dictionary(S=pikepdf.Name.JavaScript, JS=script)),
                ]
            )
        )
    )
    return serialize(pdf)


def encrypted_pdf(*, owner: str = "owner-secret", user: str = "user-secret") -> bytes:
    """A document that needs a password. PalCert never collects one (§19, §128)."""
    pdf = document()
    helvetica = font(pdf)
    pdf.pages.append(page(pdf, text("Locked"), fonts={"F1": helvetica}))
    buffer = io.BytesIO()
    # No deterministic id here: qpdf refuses one for an encrypted file, because
    # the id is part of what the encryption key is derived from. The fixture is
    # reproducible in the way that matters - it always needs a password.
    pdf.save(buffer, encryption=pikepdf.Encryption(owner=owner, user=user, R=6))
    return buffer.getvalue()


def _tounicode_cmap(mapping: dict[int, str]) -> bytes:
    """A ToUnicode CMap mapping glyph ids to Unicode (ISO 32000-2 9.10.3).

    Without one, a composite font's glyph ids extract as nothing usable - which
    is exactly the ``missing ToUnicode`` case the corpus also needs, so this is
    built explicitly rather than assumed.
    """
    entries = "".join(
        f"<{gid:04X}> <{''.join(f'{ord(c):04X}' for c in char)}>\n"
        for gid, char in sorted(mapping.items())
    )
    return (
        "/CIDInit /ProcSet findresource begin\n"
        "12 dict begin\nbegincmap\n"
        "/CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def\n"
        "/CMapName /Adobe-Identity-UCS def\n/CMapType 2 def\n"
        "1 begincodespacerange\n<0000> <FFFF>\nendcodespacerange\n"
        f"{len(mapping)} beginbfchar\n{entries}endbfchar\n"
        "endcmap\nCMapName currentdict /CMap defineresource pop\nend\nend\n"
    ).encode("ascii")


def composite_font(
    pdf: pikepdf.Pdf,
    text_content: str,
    *,
    base: str = "ABCDEF+PalCertArabic",
    with_tounicode: bool = True,
) -> tuple[Any, dict[str, int]]:
    """A Type0/Identity-H font covering ``text_content``, plus its glyph map.

    Returns the font and a character-to-glyph-id map, so a caller can write the
    matching hex string. Glyph ids are assigned in sorted character order, so
    the same text always produces the same font and the same bytes.
    """
    characters = sorted(set(text_content) - {" "})
    glyphs = {char: index + 1 for index, char in enumerate(characters)}

    descriptor = pdf.make_indirect(
        pikepdf.Dictionary(
            Type=pikepdf.Name.FontDescriptor,
            FontName=pikepdf.Name(f"/{base}"),
            Flags=4,
            ItalicAngle=0,
            Ascent=750,
            Descent=-250,
            CapHeight=700,
            StemV=80,
            FontBBox=[-200, -250, 1000, 900],
            FontFile2=pdf.make_stream(zlib.compress(b"\x00" * 256)),
        )
    )
    descendant = pdf.make_indirect(
        pikepdf.Dictionary(
            Type=pikepdf.Name.Font,
            Subtype=pikepdf.Name.CIDFontType2,
            BaseFont=pikepdf.Name(f"/{base}"),
            CIDSystemInfo=pikepdf.Dictionary(
                Registry=pikepdf.String("Adobe"), Ordering=pikepdf.String("Identity"), Supplement=0
            ),
            FontDescriptor=descriptor,
            DW=1000,
            CIDToGIDMap=pikepdf.Name.Identity,
        )
    )
    node = pikepdf.Dictionary(
        Type=pikepdf.Name.Font,
        Subtype=pikepdf.Name.Type0,
        BaseFont=pikepdf.Name(f"/{base}"),
        Encoding=pikepdf.Name("/Identity-H"),
        DescendantFonts=pikepdf.Array([descendant]),
    )
    if with_tounicode:
        node.ToUnicode = pdf.make_stream(
            _tounicode_cmap({gid: char for char, gid in glyphs.items()})
        )
    return pdf.make_indirect(node), glyphs


def composite_text(
    content: str,
    glyphs: dict[str, int],
    *,
    font_ref: str = "F1",
    size: int = 14,
    x: int = 72,
    y: int = 700,
) -> bytes:
    """Show ``content`` through a composite font, as glyph ids in a hex string."""
    hexed = "".join(f"{glyphs.get(char, 0):04X}" for char in content if char != " ")
    return f"BT /{font_ref} {size} Tf {x} {y} Td <{hexed}> Tj ET\n".encode("ascii")


def arabic_pdf(
    *,
    content: str = "هذه أطروحة جامعية مقدمة إلى كلية الدراسات العليا في الجامعة الإسلامية بغزة",
    with_tounicode: bool = True,
    with_latin: bool = False,
) -> bytes:
    """Arabic native text, optionally alongside Latin on the same page (§119).

    The characters are stored in logical order, which is how PDF stores Arabic
    and how PalCert must keep it: reversing anything here would corrupt the
    text, and the display order is a rendering concern.
    """
    pdf = document()
    arabic, glyphs = composite_font(pdf, content, with_tounicode=with_tounicode)
    fonts: dict[str, Any] = {"F1": arabic}
    body = composite_text(content, glyphs, y=700)
    if with_latin:
        fonts["F2"] = font(pdf)
        body += text("English alongside Arabic on one page", font_ref="F2", size=12, y=660)
    pdf.pages.append(page(pdf, body, fonts=fonts))
    return serialize(pdf)


def user_unit_pdf(user_unit: float = 2.0) -> bytes:
    """A page whose user space is scaled by /UserUnit (ISO 32000-2 7.7.3.3, §24).

    A reader that ignores UserUnit reports the same numbers as for a plain A4
    page, which is the mistake the fixture exists to catch.
    """
    pdf = document()
    helvetica = font(pdf)
    pdf.pages.append(
        page(
            pdf,
            text("Large format sheet"),
            fonts={"F1": helvetica},
            extra={"UserUnit": user_unit},
        )
    )
    return serialize(pdf)


def form_xobject_pdf(*, depth: int = 1) -> bytes:
    """Text drawn inside nested form XObjects rather than on the page (§28).

    Content reached only through a form is still the document's content; a
    walker that stops at the page surface reports a blank page.
    """
    pdf = document()
    helvetica = font(pdf)
    resources = pikepdf.Dictionary(Font=pikepdf.Dictionary(F1=helvetica))

    inner = pdf.make_stream(text("Text living inside a nested form xobject", y=700))
    inner.Type = pikepdf.Name.XObject
    inner.Subtype = pikepdf.Name.Form
    inner.BBox = [0, 0, 595, 842]
    inner.Resources = resources
    current = pdf.make_indirect(inner)

    for _ in range(depth - 1):
        wrapper = pdf.make_stream(b"q /Inner Do Q\n")
        wrapper.Type = pikepdf.Name.XObject
        wrapper.Subtype = pikepdf.Name.Form
        wrapper.BBox = [0, 0, 595, 842]
        wrapper.Resources = pikepdf.Dictionary(XObject=pikepdf.Dictionary(Inner=current))
        current = pdf.make_indirect(wrapper)

    pdf.pages.append(
        page(pdf, b"q /Fx1 Do Q\n", fonts={"F1": helvetica}, xobjects={"Fx1": current})
    )
    return serialize(pdf)


def outline_pdf(titles: tuple[str, ...] = ("Introduction", "Method", "Results")) -> bytes:
    """A document with bookmarks. Counted; never followed (§15)."""
    pdf = document()
    helvetica = font(pdf)
    pdf.pages.append(page(pdf, text("Outlined document"), fonts={"F1": helvetica}))
    page_ref = pdf.pages[0].obj
    root = pdf.make_indirect(pikepdf.Dictionary(Type=pikepdf.Name.Outlines))
    items = [
        pdf.make_indirect(
            pikepdf.Dictionary(
                Title=pikepdf.String(title),
                Parent=root,
                Dest=pikepdf.Array([page_ref, pikepdf.Name.Fit]),
            )
        )
        for title in titles
    ]
    for index, item in enumerate(items):
        if index > 0:
            item.Prev = items[index - 1]
        if index < len(items) - 1:
            item.Next = items[index + 1]
    root.First = items[0]
    root.Last = items[-1]
    root.Count = len(items)
    pdf.Root.Outlines = root
    return serialize(pdf)


def acroform_pdf(*, fields: int = 2, xfa: bool = False, signature: bool = False) -> bytes:
    """An interactive form, optionally XFA, optionally with a signature field.

    A signature field is a *field*, not a verdict: the corpus carries one so a
    test can prove PalCert reports its presence and never its validity (§16).
    """
    pdf = document()
    helvetica = font(pdf)
    pdf.pages.append(page(pdf, text("Form fixture"), fonts={"F1": helvetica}))
    entries = [
        pdf.make_indirect(
            pikepdf.Dictionary(
                FT=pikepdf.Name.Tx,
                T=pikepdf.String(f"field{index}"),
                Type=pikepdf.Name.Annot,
                Subtype=pikepdf.Name.Widget,
                Rect=[0, 0, 100, 20],
            )
        )
        for index in range(fields)
    ]
    if signature:
        entries.append(
            pdf.make_indirect(
                pikepdf.Dictionary(
                    FT=pikepdf.Name.Sig,
                    T=pikepdf.String("signature"),
                    Type=pikepdf.Name.Annot,
                    Subtype=pikepdf.Name.Widget,
                    Rect=[0, 0, 100, 20],
                )
            )
        )
    acro = pikepdf.Dictionary(Fields=pikepdf.Array(entries))
    if xfa:
        acro.XFA = pdf.make_stream(b"<xdp:xdp xmlns:xdp='http://ns.adobe.com/xdp/'></xdp:xdp>")
    pdf.Root.AcroForm = pdf.make_indirect(acro)
    return serialize(pdf)


def attachment_pdf(*, name: str = "raw-data-confidential.csv") -> bytes:
    """An embedded file. Counted; never opened, and its name never logged (§127)."""
    pdf = document()
    helvetica = font(pdf)
    pdf.pages.append(page(pdf, text("Document with an attachment"), fonts={"F1": helvetica}))
    payload = pdf.make_stream(b"id,value\n1,secret\n")
    payload.Type = pikepdf.Name.EmbeddedFile
    spec = pdf.make_indirect(
        pikepdf.Dictionary(
            Type=pikepdf.Name.Filespec,
            F=pikepdf.String(name),
            UF=pikepdf.String(name),
            EF=pikepdf.Dictionary(F=pdf.make_indirect(payload)),
        )
    )
    pdf.Root.Names = pikepdf.Dictionary(
        EmbeddedFiles=pikepdf.Dictionary(Names=pikepdf.Array([pikepdf.String(name), spec]))
    )
    return serialize(pdf)


def malformed_pdf() -> bytes:
    """Bytes that claim to be a PDF and are not (§129)."""
    return b"%PDF-1.7\n1 0 obj\n<< /Type /Catalog /Pages 9 9 R >>\nendobj\ntrailer\n%%EOF\n"


def truncated_pdf() -> bytes:
    """A real PDF cut in half: valid header, no cross-reference table."""
    return simple_text_pdf()[:180]


def many_pages_pdf(pages_count: int) -> bytes:
    """A page count chosen to cross a configured limit (§104)."""
    return simple_text_pdf(pages_count=pages_count)


def _struct_elem(pdf: pikepdf.Pdf, role: str, page_ref: Any, kids: Any) -> Any:
    return pdf.make_indirect(
        pikepdf.Dictionary(Type=pikepdf.Name.StructElem, S=pikepdf.Name(role), Pg=page_ref, K=kids)
    )


def tagged_citation_pdf(
    *,
    citations: tuple[str, ...] = ("[1]",),
    entries: tuple[tuple[str, str], ...] = (("[1]", "Smith, J. (2020). Water rights."),),
    label_citations: bool = False,
    tagged: bool = True,
    marks: bool = True,
    heading: str | None = None,
    untagged_citations: tuple[str, ...] = (),
    untagged_entries: tuple[str, ...] = (),
    cited_text: str = "see",
) -> bytes:
    """A document whose structure tree declares citations and bibliography entries.

    ``/Reference`` and ``/BibEntry`` are the standard structure types for "a
    citation to content elsewhere" and "a reference identifying an external
    source" (ISO 32000-2 14.8.4.3). Each entry is tagged the conventional way
    for a numbered list — an ``/LI`` holding a ``/Lbl`` and the entry — so the
    label a citation matches against is the author's, not PalCert's.

    ``label_citations`` wraps each citation marker in its own ``/Lbl`` as well,
    and ``cited_text`` is what the ``/Reference`` itself then contains — which
    is where a footnote-style citation writes its DOI.
    ``tagged=False`` keeps the identical page and drops the structure tree, so
    a test can prove PalCert reports nothing without the declaration.
    ``marks=False`` keeps the tree and drops the marked content, so a test can
    prove a declaration PalCert cannot point at is not evidence.

    ``heading``, ``untagged_citations`` and ``untagged_entries`` build the
    mixed document Checkpoint 10 needs: part of the reference list declared and
    part of it merely typed, on one page. Every default is empty, so a call
    that does not ask for them produces the identical bytes it always did.
    """
    pdf = document()
    helvetica = font(pdf)

    content = b""
    mcid = 0
    citation_mcids: list[tuple[int, int | None]] = []
    entry_mcids: list[tuple[int, int]] = []
    y = 720

    for marker in citations:
        body = text("A contested claim ", y=y)
        content += marked("/P", mcid, body) if marks else body
        mcid += 1
        label_mcid: int | None = None
        if label_citations:
            marker_bytes = text(marker, x=260, y=y)
            content += marked("/Lbl", mcid, marker_bytes) if marks else marker_bytes
            label_mcid = mcid
            mcid += 1
            citation_mcids.append((mcid, label_mcid))
            # The /Reference carries its own content and the label is its
            # sibling under the /LI, which is the shape a numbered citation
            # list is conventionally tagged in. An element with no content of
            # its own would bind to no span and be dropped.
            cited = text(cited_text, x=285, y=y)
            content += marked("/Reference", mcid, cited) if marks else cited
            mcid += 1
        else:
            marker_bytes = text(marker, x=260, y=y)
            content += marked("/Reference", mcid, marker_bytes) if marks else marker_bytes
            citation_mcids.append((mcid, None))
            mcid += 1
        y -= 40

    for marker in untagged_citations:
        # Plain text, no structure element and no marked content: exactly what
        # a word processor emits, and what only the heuristic layer can see.
        content += text(f"and also {marker}", y=y)
        y -= 40

    y -= 40
    if heading is not None:
        content += text(heading, y=y)
        y -= 30

    for label, entry_text in entries:
        label_bytes = text(label, x=72, y=y)
        content += marked("/Lbl", mcid, label_bytes) if marks else label_bytes
        label_index = mcid
        mcid += 1
        entry_bytes = text(entry_text, x=110, y=y)
        content += marked("/BibEntry", mcid, entry_bytes) if marks else entry_bytes
        entry_mcids.append((mcid, label_index))
        mcid += 1
        y -= 30

    for entry_text in untagged_entries:
        content += text(entry_text, x=72, y=y)
        y -= 30

    target = page(pdf, content, fonts={"F1": helvetica}, extra={"StructParents": 0})
    pdf.pages.append(target)
    if not tagged:
        return serialize(pdf)

    page_ref = pdf.pages[0].obj
    kids: list[Any] = []
    for reference_mcid, label_mcid in citation_mcids:
        if label_mcid is None:
            kids.append(_struct_elem(pdf, "/Reference", page_ref, reference_mcid))
        else:
            label = _struct_elem(pdf, "/Lbl", page_ref, label_mcid)
            reference = _struct_elem(pdf, "/Reference", page_ref, reference_mcid)
            kids.append(_struct_elem(pdf, "/LI", page_ref, pikepdf.Array([label, reference])))
    for entry_mcid, label_mcid in entry_mcids:
        label = _struct_elem(pdf, "/Lbl", page_ref, label_mcid)
        entry = _struct_elem(pdf, "/BibEntry", page_ref, entry_mcid)
        kids.append(_struct_elem(pdf, "/LI", page_ref, pikepdf.Array([label, entry])))

    struct_root = pdf.make_indirect(
        pikepdf.Dictionary(
            Type=pikepdf.Name.StructTreeRoot,
            K=pikepdf.Array(kids),
            ParentTree=pdf.make_indirect(
                pikepdf.Dictionary(Nums=pikepdf.Array([0, pikepdf.Array(kids)]))
            ),
            ParentTreeNextKey=1,
        )
    )
    pdf.Root.StructTreeRoot = struct_root
    pdf.Root.MarkInfo = pikepdf.Dictionary(Marked=True)
    return serialize(pdf)


def internal_destination_pdf(
    *,
    entries: tuple[tuple[str, str], ...] = (("[1]", "Smith, J. (2020). Water rights."),),
    citation_marker: str = "see",
    destination: str = "first-entry",
    overlapping_entries: bool = False,
    bind_annotation: bool = True,
) -> bytes:
    """A citation carrying a /Link annotation whose destination names an entry.

    Both ends are the author's declaration rather than PalCert's reading:

    * the annotation names its owning structure element through
      ``/StructParent`` and the parent tree, and that element is the
      ``/Reference``;
    * the ``/GoTo`` destination names a page and a point, or a structure
      element outright when ``destination="structure"``.

    ``destination`` selects the case: ``first-entry`` lands inside the first
    declared entry, ``second-entry`` inside the second, ``structure`` names the
    first entry as a structure destination, ``off-page`` lands where no entry
    is, ``whole-page`` uses ``/Fit`` which names no point at all, and ``none``
    omits the destination. ``bind_annotation=False`` drops ``/StructParent``,
    so a test can prove an unbound annotation is not consumed.
    """
    pdf = document()
    helvetica = font(pdf)

    entry_y = 600
    entry_rows: list[tuple[int, int, int]] = []  # (label mcid, entry mcid, y)
    content = marked("/Reference", 0, text(citation_marker, x=260, y=720))
    mcid = 1
    for index, (label, entry_text) in enumerate(entries):
        y = entry_y - index * (0 if overlapping_entries else 40)
        # Overlapping entries are typeset so their extents genuinely
        # intersect; a destination inside the intersection lands on two
        # declared entries, which is what ambiguity looks like in a real file.
        x = 110 + (index * 40 if overlapping_entries else 0)
        content += marked("/Lbl", mcid, text(label, x=72 + index * 10, y=y))
        label_mcid = mcid
        mcid += 1
        content += marked("/BibEntry", mcid, text(entry_text, x=x, y=y))
        entry_rows.append((label_mcid, mcid, y))
        mcid += 1

    target = page(pdf, content, fonts={"F1": helvetica}, extra={"StructParents": 0})
    pdf.pages.append(target)
    page_ref = pdf.pages[0].obj

    reference = _struct_elem(pdf, "/Reference", page_ref, 0)
    items = []
    entry_elements = []
    for label_mcid, entry_mcid, _ in entry_rows:
        label_element = _struct_elem(pdf, "/Lbl", page_ref, label_mcid)
        entry_element = _struct_elem(pdf, "/BibEntry", page_ref, entry_mcid)
        entry_elements.append(entry_element)
        items.append(
            _struct_elem(pdf, "/LI", page_ref, pikepdf.Array([label_element, entry_element]))
        )

    action: Any = None
    if destination == "structure":
        action = pikepdf.Dictionary(
            S=pikepdf.Name("/GoTo"),
            SD=entry_elements[0],
            D=pikepdf.Array([page_ref, pikepdf.Name("/Fit")]),
        )
    elif destination in {"first-entry", "second-entry", "off-page"}:
        index = 1 if destination == "second-entry" else 0
        y = entry_rows[min(index, len(entry_rows) - 1)][2]
        # With entries deliberately overlapping, the point is placed where
        # both of them cover it: a destination that genuinely lands on two
        # declared entries is what ambiguity looks like in a real file.
        point_x = 170 if overlapping_entries else 120
        if destination == "off-page":
            point_x = 20
        point_y = y + 3 if destination != "off-page" else 40
        action = pikepdf.Dictionary(
            S=pikepdf.Name("/GoTo"),
            D=pikepdf.Array([page_ref, pikepdf.Name("/XYZ"), point_x, point_y, 0]),
        )
    elif destination == "whole-page":
        action = pikepdf.Dictionary(
            S=pikepdf.Name("/GoTo"), D=pikepdf.Array([page_ref, pikepdf.Name("/Fit")])
        )

    annotation_fields: dict[str, Any] = {
        "Type": pikepdf.Name.Annot,
        "Subtype": pikepdf.Name.Link,
        "Rect": pikepdf.Array([258, 715, 300, 735]),
        "Border": pikepdf.Array([0, 0, 0]),
    }
    if action is not None:
        annotation_fields["A"] = action
    if bind_annotation:
        annotation_fields["StructParent"] = 1
    annotation = pdf.make_indirect(pikepdf.Dictionary(**annotation_fields))
    pdf.pages[0].obj.Annots = pdf.make_indirect(pikepdf.Array([annotation]))

    # The structure element that owns the annotation refers to it with an
    # /OBJR, and the parent tree maps the annotation's key back to it. That
    # pairing is what makes the source binding an identity (ISO 32000-2
    # 14.7.4.4) rather than a question of which citation is nearest.
    objr = pdf.make_indirect(
        pikepdf.Dictionary(Type=pikepdf.Name.OBJR, Pg=page_ref, Obj=annotation)
    )
    reference.K = pikepdf.Array([0, objr])

    kids = [reference, *items]
    struct_root = pdf.make_indirect(
        pikepdf.Dictionary(
            Type=pikepdf.Name.StructTreeRoot,
            K=pikepdf.Array(kids),
            ParentTree=pdf.make_indirect(
                pikepdf.Dictionary(Nums=pikepdf.Array([0, pikepdf.Array(kids), 1, reference]))
            ),
            ParentTreeNextKey=2,
        )
    )
    pdf.Root.StructTreeRoot = struct_root
    pdf.Root.MarkInfo = pikepdf.Dictionary(Marked=True)
    return serialize(pdf)


def numbered_references_pdf(
    *,
    body: tuple[str, ...] = (
        "Water rights in the basin have been contested for decades [1].",
        "Later work disputes that reading [2], and a survey covers both [3].",
    ),
    heading: str = "References",
    entries: tuple[str, ...] = (
        "[1] Smith, J. (2020). Water rights. Journal of Policy.",
        "[2] Khatib, A. (2019). Contested basins. Regional Review.",
        "[3] Nasser, L. (2021). A survey of allocation. Water Studies.",
    ),
    tail: tuple[str, ...] = (),
    size: int = 11,
) -> bytes:
    """A readable PDF with a numbered reference list and **no** structure tree.

    The shape Checkpoint 10 exists for: a thesis exported from a word
    processor, where every citation is visible to a reader and none of it is
    declared to a machine. Nothing here is tagged, so an exact analyzer sees a
    page of prose.

    Body lines land on page one and the heading and entries on page two, which
    is also what puts the region in the latter part of the document.
    """
    pdf = document()
    helvetica = font(pdf)

    def rendered(lines: tuple[str, ...], start: int = 700) -> bytes:
        content = b""
        y = start
        for line in lines:
            content += text(line, size=size, y=y)
            y -= size + 6
        return content

    if body:
        pdf.pages.append(page(pdf, rendered(body), fonts={"F1": helvetica}))
    pdf.pages.append(page(pdf, rendered((heading, *entries, *tail)), fonts={"F1": helvetica}))
    return serialize(pdf)


def arabic_numbered_references_pdf(
    *,
    heading: str = "المراجع",
    entries: tuple[str, ...] | None = None,
    body: tuple[str, ...] | None = None,
    size: int = 14,
) -> bytes:
    """The same shape in Arabic, with Arabic-Indic labels.

    Written through the composite font the Phase 13 corpus already uses, so
    the text layer represents it the way a real Arabic PDF does — logical
    order, glyph ids, a ToUnicode CMap. The builder drops spaces, which is
    itself a useful pressure test: a detector that needed a space after `]`
    would find nothing here.
    """
    # Arabic-Indic digits are written as escapes: the literal glyphs are
    # visually indistinguishable from Latin letters in a source file, and a
    # label nobody can read in the fixture is a test nobody can trust.
    one, two, three = "\u0661", "\u0662", "\u0663"
    if entries is None:
        entries = (
            f"[{one}]الخطيبأحمدحقوقالمياه",
            f"[{two}]ناصرليلىتوزيعالحصص",
            f"[{three}]سميثجونسياساتالمياه",
        )
    if body is None:
        body = (f"تناقشهذهالأطروحةحقوقالمياه[{one}]وتوزيعالحصص[{two}]",)

    pdf = document()
    corpus = "".join((heading, *entries, *body))
    arabic, glyphs = composite_font(pdf, corpus)

    def rendered(lines: tuple[str, ...]) -> bytes:
        content = b""
        y = 700
        for line in lines:
            content += composite_text(line, glyphs, size=size, y=y)
            y -= size + 6
        return content

    pdf.pages.append(page(pdf, rendered(body), fonts={"F1": arabic}))
    pdf.pages.append(page(pdf, rendered((heading, *entries)), fonts={"F1": arabic}))
    return serialize(pdf)


def author_year_references_pdf(
    *,
    body: tuple[str, ...] = (
        "Water rights have been contested for decades (Smith, 2020).",
        "Later work disputes that reading (Khatib & Nasser, 2019), and",
        "Haddad et al. (2021) survey both positions.",
    ),
    heading: str = "References",
    entries: tuple[str, ...] = (
        "Haddad, M., Salem, R., & Odeh, T. (2021). A survey of allocation.",
        "Khatib, A., & Nasser, L. (2019). Contested basins. Regional Review.",
        "Smith, J. (2020). Water rights. Journal of Policy.",
    ),
    tail: tuple[str, ...] = (),
    size: int = 11,
) -> bytes:
    """A readable PDF whose reference list is author-year rather than numbered.

    The other half of what a real thesis looks like, and one an untagged
    numeric detector sees nothing in: no brackets anywhere, entries ordered
    alphabetically rather than by a label.
    """
    pdf = document()
    helvetica = font(pdf)

    def rendered(lines: tuple[str, ...]) -> bytes:
        content = b""
        y = 700
        for line in lines:
            content += text(line, size=size, y=y)
            y -= size + 6
        return content

    if body:
        pdf.pages.append(page(pdf, rendered(body), fonts={"F1": helvetica}))
    pdf.pages.append(page(pdf, rendered((heading, *entries, *tail)), fonts={"F1": helvetica}))
    return serialize(pdf)


def multi_region_pdf(
    *,
    chapters: tuple[tuple[tuple[str, ...], tuple[str, ...]], ...] = (
        (
            ("Chapter One cites [1] and [2].",),
            (
                "[1] Smith, J. Water rights.",
                "[2] Khatib, A. Contested basins.",
                "[3] Nasser, L. A survey.",
            ),
        ),
        (
            ("Chapter Two cites [1] as well.",),
            ("[1] Haddad, M. Allocation.", "[2] Salem, R. Reuse.", "[3] Odeh, T. Storage."),
        ),
    ),
    heading: str = "References",
    size: int = 11,
) -> bytes:
    """A document with one reference list per chapter, each on its own page.

    The shape Checkpoint 14 exists for: label `[1]` means a different work in
    chapter one than in chapter two, and a document-wide index would report
    both chapters' citations as confidently resolved to whichever entry came
    first.
    """
    pdf = document()
    helvetica = font(pdf)

    def rendered(lines: tuple[str, ...]) -> bytes:
        content = b""
        y = 700
        for line in lines:
            content += text(line, size=size, y=y)
            y -= size + 6
        return content

    for body, entries in chapters:
        pdf.pages.append(page(pdf, rendered(body), fonts={"F1": helvetica}))
        pdf.pages.append(page(pdf, rendered((heading, *entries)), fonts={"F1": helvetica}))
    return serialize(pdf)


def superscript_pdf(
    *,
    body: tuple[tuple[str, str, str], ...] = (
        ("Water rights are contested", "3", " across the basin."),
    ),
    heading: str = "References",
    entries: tuple[str, ...] = (
        "[1] Smith, J. Water rights.",
        "[2] Khatib, A. Contested basins.",
        "[3] Nasser, L. A survey of allocation.",
    ),
    size: int = 11,
    raised_size: int = 7,
    raise_by: int = 5,
) -> bytes:
    """Body text carrying raised numerals, over a numbered reference list.

    Each body row is ``(before, raised, after)``: the raised part is set
    smaller and lifted above the baseline, which is exactly how a Vancouver or
    Nature citation is typeset — and exactly how a mathematical exponent is,
    which is why geometry alone never decides.

    ``raise_by`` is negative for a subscript, so one builder covers both.
    """
    pdf = document()
    helvetica = font(pdf)

    content = b""
    y = 700
    for before, raised, after in body:
        x = 72
        if before:
            content += text(before, size=size, y=y, x=x)
            x += int(len(before) * size * 0.5) + 2
        content += text(raised, size=raised_size, y=y + raise_by, x=x)
        x += int(len(raised) * raised_size * 0.6) + 2
        if after:
            content += text(after, size=size, y=y, x=x)
        y -= size + 10
    pdf.pages.append(page(pdf, content, fonts={"F1": helvetica}))

    entry_content = b""
    y = 700
    for line in (heading, *entries):
        entry_content += text(line, size=size, y=y)
        y -= size + 6
    pdf.pages.append(page(pdf, entry_content, fonts={"F1": helvetica}))
    return serialize(pdf)


def arabic_superscript_pdf(
    *,
    body: tuple[tuple[str, str, str], ...] | None = None,
    heading: str = "\u0627\u0644\u0645\u0631\u0627\u062c\u0639",
    entries: tuple[str, ...] | None = None,
    size: int = 14,
    raised_size: int = 9,
    raise_by: int = 6,
) -> bytes:
    """The superscript shape in Arabic, through the composite font.

    Written the way `arabic_numbered_references_pdf` is, for the same reason:
    a Helvetica fixture cannot encode Arabic at all, so a test built on one
    would prove nothing about the text layer a real Arabic PDF exposes. The
    raised part is an Arabic-Indic digit set smaller and lifted, and whether
    PalCert reads it is exactly the question Checkpoint 14 asks.
    """
    one, two, three = "\u0661", "\u0662", "\u0663"
    if entries is None:
        entries = (
            f"[{one}]\u0627\u0644\u062e\u0637\u064a\u0628\u0623\u062d\u0645\u062f",
            f"[{two}]\u0646\u0627\u0635\u0631\u0644\u064a\u0644\u0649",
            f"[{three}]\u0633\u0645\u064a\u062b\u062c\u0648\u0646",
        )
    if body is None:
        body = (
            (
                "\u062d\u0642\u0648\u0642\u0627\u0644\u0645\u064a\u0627\u0647",
                three,
                "\u0645\u062a\u0646\u0627\u0632\u0639\u0639\u0644\u064a\u0647\u0627",
            ),
        )

    pdf = document()
    corpus = "".join((heading, *entries, *(part for row in body for part in row)))
    arabic, glyphs = composite_font(pdf, corpus)

    # The composite font carries no real glyph widths, so advance is taken
    # from a generous fixed column rather than measured: three runs that
    # overlapped horizontally would be extracted as one span and the raised
    # part would vanish before any detector saw it.
    content = b""
    y = 700
    for before, raised, after in body:
        if before:
            content += composite_text(before, glyphs, size=size, y=y, x=72)
        content += composite_text(raised, glyphs, size=raised_size, y=y + raise_by, x=320)
        if after:
            content += composite_text(after, glyphs, size=size, y=y, x=352)
        y -= size + 10
    pdf.pages.append(page(pdf, content, fonts={"F1": arabic}))

    entry_content = b""
    y = 700
    for line in (heading, *entries):
        entry_content += composite_text(line, glyphs, size=size, y=y)
        y -= size + 6
    pdf.pages.append(page(pdf, entry_content, fonts={"F1": arabic}))
    return serialize(pdf)


def vancouver_references_pdf(
    *,
    body: tuple[str, ...] = ("A claim [1] and another [2].",),
    heading: str = "References",
    entries: tuple[str, ...] = (
        "1. Smith J, Jones A. Water rights. J Policy. 2020;5:10-20.",
        "2. Khatib A. Contested basins. Reg Rev. 2019;3:4-9.",
        "3. Nasser L, Odeh T. A survey. Water Stud. 2021;7:1-15.",
    ),
    size: int = 11,
) -> bytes:
    """A numbered reference list written Vancouver style, without brackets.

    `1. Smith J, Jones A.` rather than `[1] Smith, J.` — a numbered list whose
    entries are recognizable as references only by the author shape that
    follows the number.
    """
    pdf = document()
    helvetica = font(pdf)

    def rendered(lines: tuple[str, ...]) -> bytes:
        content = b""
        y = 700
        for line in lines:
            content += text(line, size=size, y=y)
            y -= size + 6
        return content

    if body:
        pdf.pages.append(page(pdf, rendered(body), fonts={"F1": helvetica}))
    pdf.pages.append(page(pdf, rendered((heading, *entries)), fonts={"F1": helvetica}))
    return serialize(pdf)
