"""Exact conversion from OOXML measurement units (§28, §66, §104).

WordprocessingML measures in integers of several different sizes, and every
one of them converts to a canonical PalCert unit by an exact rational factor.
Doing that in binary floating point is how a 25.4 mm margin becomes
25.399999999999999 and a rule with a 0 mm tolerance starts failing documents
that are correct. ADR-0027 settled this for the rule engine; the analyzer must
not undo it at the source.

The units:

* **twip** — one twentieth of a point, so 1440 to the inch. Page geometry,
  margins, indentation and spacing.
* **half-point** — ``w:sz`` and ``w:szCs``. 24 means 12 pt.
* **eighth-point** — border widths.
* **EMU** — English Metric Unit, 914400 to the inch. DrawingML extents.
* **240ths of a line** — ``w:spacing/@w:line`` when ``w:lineRule`` is ``auto``.
"""

from __future__ import annotations

from fractions import Fraction

from app.engine.units.registry import Unit, convert

TWIPS_PER_INCH = 1440
EMU_PER_INCH = 914400
HALF_POINTS_PER_POINT = 2
EIGHTH_POINTS_PER_POINT = 8
#: ``w:line`` with ``lineRule="auto"`` is in 240ths of a line.
AUTO_LINE_UNITS_PER_LINE = 240


def twips_to(value: int, unit: Unit) -> Fraction:
    """Twips as an exact value in a canonical length unit."""
    inches = Fraction(value, TWIPS_PER_INCH)
    return convert(inches, Unit.INCH, unit)


def twips_to_points(value: int) -> Fraction:
    return twips_to(value, Unit.POINT)


def twips_to_millimetres(value: int) -> Fraction:
    return twips_to(value, Unit.MILLIMETRE)


def half_points_to_points(value: int) -> Fraction:
    """``w:sz`` is in half-points: 24 is 12 pt, exactly."""
    return Fraction(value, HALF_POINTS_PER_POINT)


def eighth_points_to_points(value: int) -> Fraction:
    return Fraction(value, EIGHTH_POINTS_PER_POINT)


def emu_to(value: int, unit: Unit) -> Fraction:
    """DrawingML extents as an exact value in a canonical length unit."""
    inches = Fraction(value, EMU_PER_INCH)
    return convert(inches, Unit.INCH, unit)


def auto_line_to_lines(value: int) -> Fraction:
    """``w:line`` under ``lineRule="auto"`` as a multiple of one line.

    240 is single spacing, 360 is 1.5, 480 is double — exactly, with no
    rounding, which is what lets a "line spacing must be 1.5" rule compare
    equal rather than nearly equal.
    """
    return Fraction(value, AUTO_LINE_UNITS_PER_LINE)


def parse_int(value: str | None) -> int | None:
    """An OOXML integer attribute, or None when absent or malformed.

    Malformed is *not* zero. A margin attribute of "abc" means the document
    did not say what its margin is, and inventing zero would be a fabricated
    measurement of the exact kind Phase 6 forbids.
    """
    if value is None:
        return None
    text = value.strip()
    if not text:
        return None
    try:
        return int(text, 10)
    except ValueError:
        return None
