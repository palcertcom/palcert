"""Turning a PDF engine's binary floats into canonical decimal evidence (§23).

PDFium answers in C doubles. A double is the right thing to compute with and
the wrong thing to *store as an identity*: 595.2755905511812 and
595.2755905511811 are the same page to every human and to every rule, and
persisting either one makes the artifact depend on the last bit of a
floating-point unit rather than on the document.

So every number that leaves the analyzer is quantised to a fixed number of
decimal places, half-even, and written as a plain decimal string — the same
representation the evaluation contract already uses for measured values. Two
runs on the same bytes therefore produce byte-identical evidence, and two
geometries are compared as decimals rather than by uncontrolled float equality.

``GEOMETRY_PLACES`` is three: a thousandth of a point is roughly 0.35 microns,
far below anything a page can express, and it leaves 1/72 inch reproducible.
"""

from __future__ import annotations

from decimal import ROUND_HALF_EVEN, Decimal, localcontext
from fractions import Fraction

#: Decimal places kept for page and object geometry, in points.
GEOMETRY_PLACES = 3
#: Decimal places kept for font sizes, in points.
FONT_SIZE_PLACES = 3

_QUANTA = {places: Decimal(1).scaleb(-places) for places in (0, 1, 2, 3, 4, 6)}


def quantise(value: float | int | Decimal | Fraction, places: int = GEOMETRY_PLACES) -> Decimal:
    """One engine number as a canonical Decimal.

    Half-even rather than half-up: a measurement that lands exactly on a tie is
    as likely to be rounding noise in one direction as the other, and half-up
    would bias every such value upward across a whole document.
    """
    if isinstance(value, Fraction):
        candidate = Decimal(value.numerator) / Decimal(value.denominator)
    elif isinstance(value, Decimal):
        candidate = value
    else:
        candidate = Decimal(repr(float(value)))
    with localcontext() as ctx:
        ctx.prec = 28
        return candidate.quantize(_QUANTA[places], rounding=ROUND_HALF_EVEN)


def plain(value: Decimal) -> str:
    """A Decimal as the contract's exact string form, never a JSON number."""
    text = format(value.normalize(), "f")
    if "." in text:
        text = text.rstrip("0").rstrip(".")
    return text or "0"


def decimal_string(value: float | int | Decimal | Fraction, places: int = GEOMETRY_PLACES) -> str:
    """The canonical string for one engine number."""
    return plain(quantise(value, places))
