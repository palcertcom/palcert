"""Font identity, subset names and the refusal to guess (§121, §125)."""

from __future__ import annotations

import hashlib

from app.pdf.analyzer import analyze
from app.pdf.fonts import build_identity, derived_bold, derived_italic, strip_subset_prefix
from tests.pdf.builder import document, embedded_font, font, page, serialize, text


def _analyze(data: bytes) -> dict:
    return analyze(data, expected_sha256=hashlib.sha256(data).hexdigest(), document_id="d")


def test_subset_prefix_follows_the_standard_rule_only():
    # ISO 32000-2 9.6.4: six uppercase letters then '+'. Nothing else.
    assert strip_subset_prefix("ABCDEF+Minion") == ("Minion", True)
    assert strip_subset_prefix("ABCDE+Minion") == ("ABCDE+Minion", False)
    assert strip_subset_prefix("abcdef+Minion") == ("abcdef+Minion", False)
    assert strip_subset_prefix("Minion") == ("Minion", False)


def test_raw_and_normalised_names_are_both_kept():
    identity = build_identity(raw_name="ABCDEF+TimesNewRomanPSMT", embedded=True)
    assert identity.raw_name == "ABCDEF+TimesNewRomanPSMT"
    # Emphatically not "Times New Roman": no fuzzy cleanup (§40).
    assert identity.base_name == "TimesNewRomanPSMT"
    assert identity.subset is True


def test_bold_comes_from_the_descriptor_never_the_name():
    # The mandatory refusal: a font CALLED bold proves nothing (§45, §125).
    named_only = build_identity(raw_name="Arial-BoldMT", embedded=True)
    assert derived_bold(named_only) is None

    declared = build_identity(raw_name="Whatever", embedded=True, weight=700)
    assert derived_bold(declared) is True

    light = build_identity(raw_name="Arial-BoldMT", embedded=True, weight=300)
    assert derived_bold(light) is False


def test_italic_comes_from_the_descriptor_never_the_name():
    named_only = build_identity(raw_name="Georgia-Italic", embedded=True)
    assert derived_italic(named_only) is None
    assert derived_italic(build_identity(raw_name="X", embedded=True, italic_angle=-12)) is True
    assert derived_italic(build_identity(raw_name="X", embedded=True, italic_angle=0)) is False


def test_unembedded_font_is_marked_substitutable():
    # The renderer's choice belongs to the machine, not to the document (§41).
    identity = build_identity(raw_name="Helvetica", embedded=False)
    assert identity.substitution_possible is True
    assert build_identity(raw_name="X", embedded=True).substitution_possible is False


def test_declared_font_reaches_the_facts():
    pdf = document()
    helvetica = font(pdf)
    pdf.pages.append(
        page(
            pdf,
            text("A line of text long enough to be a real text layer here"),
            fonts={"F1": helvetica},
        )
    )
    art = _analyze(serialize(pdf))
    families = {
        f["value"]["text"]
        for f in art["factSet"]["facts"]
        if f["scope"].get("property") == "fontFamily"
    }
    assert families == {"Helvetica"}


def test_font_size_facts_are_exact_decimals():
    pdf = document()
    helvetica = font(pdf)
    pdf.pages.append(
        page(
            pdf,
            text("Sixteen point body text that runs on for a while here", size=16),
            fonts={"F1": helvetica},
        )
    )
    art = _analyze(serialize(pdf))
    sizes = {
        f["value"]["number"]
        for f in art["factSet"]["facts"]
        if f["scope"].get("property") == "fontSize"
    }
    assert sizes == {"16"}


def test_embedded_font_descriptor_is_read():
    pdf = document()
    embedded = embedded_font(pdf, weight=700)
    pdf.pages.append(
        page(
            pdf,
            text("Embedded font sample text that is long enough to count"),
            fonts={"F1": embedded},
        )
    )
    art = _analyze(serialize(pdf))
    fonts = art["structuralModel"]["fonts"]
    assert fonts, "the model records the fonts it saw"
    assert any(f["subset"] for f in fonts), "the subset prefix is recognised"
