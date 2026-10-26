"""The unit registry and exact conversion.

Two decisions shape this module.

**Dimensions, not a flat list.** A unit belongs to a dimension, and conversion
is only defined *within* a dimension. Comparing WORDS with MILLIMETRE is not a
missing conversion factor; it is a category error, and the engine says so
(`UNIT_INCOMPATIBLE`) rather than guessing.

**Exact rational arithmetic.** Conversion factors are `Fraction`s, not floats
and not `Decimal`s. `1 pt = 1/72 in` and `1 in = 25.4 mm`, so a point is
25.4/72 mm — which has no terminating decimal representation. With `Decimal`,
30 mm converted to points and back is 30.00000000000000000000000001; with
`Fraction` it is exactly 30. Since a millimetre either satisfies a margin rule
or does not, "almost 30" is not good enough.

`Decimal` remains the *wire and storage* representation (canonical decimal
strings); `Fraction` is the *arithmetic* representation. See ADR-0027.
"""

from __future__ import annotations

from decimal import Decimal
from enum import StrEnum
from fractions import Fraction


class Dimension(StrEnum):
    """What a unit measures.

    Only units sharing a dimension are inter-convertible. Note that the
    count-like units are each their own dimension: words are not pages and
    pages are not lines, and no conversion between them exists.
    """

    LENGTH = "LENGTH"
    COUNT = "COUNT"
    WORDS = "WORDS"
    CHARACTERS = "CHARACTERS"
    PAGES = "PAGES"
    LINES = "LINES"
    RATIO = "RATIO"
    DIGITAL_SIZE = "DIGITAL_SIZE"
    RESOLUTION = "RESOLUTION"
    #: Pixels are deliberately their own dimension. A pixel is a physical
    #: length only once a resolution is known, and no DPI context exists at
    #: this layer, so PIXEL never converts to MILLIMETRE. See PIXEL_NOTE.
    PIXEL = "PIXEL"


class Unit(StrEnum):
    """The PalCert canonical units.

    Identical to the Phase 3 ``RuleUnit`` vocabulary, and asserted against it by
    the cross-language contract tests. A second, subtly different unit list is
    the fastest possible route to a wrong measurement.
    """

    COUNT = "COUNT"
    MILLIMETRE = "MILLIMETRE"
    CENTIMETRE = "CENTIMETRE"
    INCH = "INCH"
    POINT = "POINT"
    PIXEL = "PIXEL"
    PERCENT = "PERCENT"
    LINES = "LINES"
    WORDS = "WORDS"
    CHARACTERS = "CHARACTERS"
    PAGES = "PAGES"
    MEGABYTE = "MEGABYTE"
    DPI = "DPI"


PIXEL_NOTE = (
    "A pixel has no physical size without a resolution. PalCert does not carry "
    "DPI context in the fact model, so comparing PIXEL with a length unit is "
    "reported as UNIT_INCOMPATIBLE rather than converted on an assumed 96 DPI."
)

_DIMENSION_OF: dict[Unit, Dimension] = {
    Unit.MILLIMETRE: Dimension.LENGTH,
    Unit.CENTIMETRE: Dimension.LENGTH,
    Unit.INCH: Dimension.LENGTH,
    Unit.POINT: Dimension.LENGTH,
    Unit.PIXEL: Dimension.PIXEL,
    Unit.COUNT: Dimension.COUNT,
    Unit.WORDS: Dimension.WORDS,
    Unit.CHARACTERS: Dimension.CHARACTERS,
    Unit.PAGES: Dimension.PAGES,
    Unit.LINES: Dimension.LINES,
    Unit.PERCENT: Dimension.RATIO,
    Unit.MEGABYTE: Dimension.DIGITAL_SIZE,
    Unit.DPI: Dimension.RESOLUTION,
}

#: Exact size of one unit in its dimension's base unit.
#:
#: LENGTH is based on the millimetre. ``Fraction(254, 10)`` is exactly 25.4, and
#: ``Fraction(254, 10) / 72`` is exactly one point — a value no decimal type can
#: hold.
_IN_BASE_UNITS: dict[Unit, Fraction] = {
    Unit.MILLIMETRE: Fraction(1),
    Unit.CENTIMETRE: Fraction(10),
    Unit.INCH: Fraction(254, 10),
    Unit.POINT: Fraction(254, 10) / 72,
    # Every other dimension is a singleton, so its base factor is 1.
    Unit.PIXEL: Fraction(1),
    Unit.COUNT: Fraction(1),
    Unit.WORDS: Fraction(1),
    Unit.CHARACTERS: Fraction(1),
    Unit.PAGES: Fraction(1),
    Unit.LINES: Fraction(1),
    Unit.PERCENT: Fraction(1),
    Unit.MEGABYTE: Fraction(1),
    Unit.DPI: Fraction(1),
}


class IncompatibleUnitsError(ValueError):
    """Raised when a conversion between different dimensions is attempted.

    A typed error rather than a sentinel value: the caller must decide what an
    incompatible comparison means for the verdict (it is INDETERMINATE, never
    FAIL), and a silently returned ``None`` invites that decision to be skipped.
    """

    def __init__(self, source: Unit, target: Unit) -> None:
        self.source = source
        self.target = target
        super().__init__(
            f"Cannot convert {source.value} to {target.value}: "
            f"{dimension_of(source).value} and {dimension_of(target).value} "
            f"are different dimensions."
        )


def dimension_of(unit: Unit) -> Dimension:
    return _DIMENSION_OF[unit]


def are_compatible(left: Unit, right: Unit) -> bool:
    """True when a value in ``left`` can be converted to ``right``."""
    return dimension_of(left) is dimension_of(right)


def to_fraction(value: Decimal | int | str | Fraction) -> Fraction:
    """Convert a wire or storage value into exact rational arithmetic.

    ``Fraction`` accepts ``Decimal`` losslessly, which is the point: a decimal
    string from the wire becomes an exact rational with no intermediate float.
    """
    if isinstance(value, Fraction):
        return value
    if isinstance(value, Decimal):
        return Fraction(value)
    if isinstance(value, int):
        return Fraction(value)
    return Fraction(Decimal(value))


def convert(value: Fraction, source: Unit, target: Unit) -> Fraction:
    """Convert an exact value between two units of the same dimension.

    Raises :class:`IncompatibleUnitsError` across dimensions — including
    PIXEL to any length, which has no answer without a resolution.
    """
    if source is target:
        return value
    if not are_compatible(source, target):
        raise IncompatibleUnitsError(source, target)

    return value * _IN_BASE_UNITS[source] / _IN_BASE_UNITS[target]


def convert_to_common(
    left: Fraction,
    left_unit: Unit | None,
    right: Fraction,
    right_unit: Unit | None,
) -> tuple[Fraction, Fraction, Unit | None]:
    """Bring two values into one unit so they can be compared.

    The *left* unit wins when both are present, so a violation reports the
    observed document's unit rather than one the engine chose. Two unitless
    values compare directly.

    A unit on one side and not the other is refused: silently treating a bare
    number as "the same unit as the other side" is exactly the assumption that
    produces a confidently wrong measurement.
    """
    if left_unit is None and right_unit is None:
        return left, right, None
    if left_unit is None or right_unit is None:
        raise IncompatibleUnitsError(
            left_unit or right_unit or Unit.COUNT,
            right_unit or left_unit or Unit.COUNT,
        )

    return left, convert(right, right_unit, left_unit), left_unit


def format_exact(value: Fraction) -> str:
    """Render an exact value as a canonical decimal string.

    Used for evidence in violations, never for comparison — comparison stays in
    ``Fraction``. A value with no finite decimal expansion (a converted point,
    say) is rendered to a documented, generous precision and normalized, which
    is a *presentation* choice and cannot affect a verdict.
    """
    if value.denominator == 1:
        return str(value.numerator)

    # 12 fractional digits comfortably exceeds any real typographic precision
    # while keeping the string readable.
    quantized = (Decimal(value.numerator) / Decimal(value.denominator)).quantize(
        Decimal("1.000000000000")
    )
    normalized = quantized.normalize()
    # normalize() renders small integers in exponent form (1E+1); expand them.
    if normalized == normalized.to_integral_value():
        return str(normalized.quantize(Decimal(1)))
    return format(normalized, "f")
