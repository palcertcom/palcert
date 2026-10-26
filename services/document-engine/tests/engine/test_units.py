"""The unit registry: exactness, dimensions and refusals."""

from __future__ import annotations

from decimal import Decimal
from fractions import Fraction

import pytest

from app.engine.units.registry import (
    Dimension,
    IncompatibleUnitsError,
    Unit,
    are_compatible,
    convert,
    convert_to_common,
    dimension_of,
    format_exact,
    to_fraction,
)


class TestDimensions:
    def test_every_unit_has_a_dimension(self) -> None:
        for unit in Unit:
            assert isinstance(dimension_of(unit), Dimension)

    def test_the_four_length_units_share_a_dimension(self) -> None:
        lengths = {Unit.MILLIMETRE, Unit.CENTIMETRE, Unit.INCH, Unit.POINT}
        assert {dimension_of(unit) for unit in lengths} == {Dimension.LENGTH}

    @pytest.mark.parametrize(
        ("left", "right"),
        [
            (Unit.WORDS, Unit.PAGES),
            (Unit.WORDS, Unit.CHARACTERS),
            (Unit.PAGES, Unit.LINES),
            (Unit.COUNT, Unit.WORDS),
        ],
    )
    def test_count_like_units_are_not_interchangeable(self, left: Unit, right: Unit) -> None:
        # Words are not pages. Treating every count as the same dimension would
        # let "at least 300 words" be satisfied by 300 pages.
        assert not are_compatible(left, right)

    def test_pixels_are_not_a_length(self) -> None:
        # A pixel has no physical size without a resolution, and the fact model
        # carries no DPI context.
        assert not are_compatible(Unit.PIXEL, Unit.MILLIMETRE)


class TestExactConversion:
    def test_an_inch_is_exactly_25_point_4_millimetres(self) -> None:
        assert convert(to_fraction("1"), Unit.INCH, Unit.MILLIMETRE) == to_fraction("25.4")

    def test_seventy_two_points_are_exactly_one_inch(self) -> None:
        assert convert(to_fraction("72"), Unit.POINT, Unit.INCH) == Fraction(1)

    def test_ten_millimetres_are_exactly_one_centimetre(self) -> None:
        assert convert(to_fraction("10"), Unit.MILLIMETRE, Unit.CENTIMETRE) == Fraction(1)

    def test_millimetres_round_trip_through_points_exactly(self) -> None:
        # The reason this module uses Fraction rather than Decimal. With
        # Decimal at 28 digits this round trip yields
        # 30.00000000000000000000000001, because a point is 25.4/72 mm and has
        # no terminating decimal expansion.
        original = to_fraction("30")
        points = convert(original, Unit.MILLIMETRE, Unit.POINT)
        assert convert(points, Unit.POINT, Unit.MILLIMETRE) == original

    @pytest.mark.parametrize("unit", [Unit.MILLIMETRE, Unit.CENTIMETRE, Unit.INCH, Unit.POINT])
    def test_every_length_round_trips_through_every_other(self, unit: Unit) -> None:
        original = to_fraction("12.7")
        for target in (Unit.MILLIMETRE, Unit.CENTIMETRE, Unit.INCH, Unit.POINT):
            there = convert(original, unit, target)
            assert convert(there, target, unit) == original

    def test_equivalent_physical_lengths_compare_equal(self) -> None:
        one_inch_as_mm = convert(to_fraction("1"), Unit.INCH, Unit.MILLIMETRE)
        seventy_two_pt_as_mm = convert(to_fraction("72"), Unit.POINT, Unit.MILLIMETRE)
        assert one_inch_as_mm == seventy_two_pt_as_mm == to_fraction("25.4")

    def test_converting_to_the_same_unit_is_the_identity(self) -> None:
        value = to_fraction("3.14159")
        assert convert(value, Unit.POINT, Unit.POINT) is value


class TestRefusals:
    def test_converting_across_dimensions_raises(self) -> None:
        with pytest.raises(IncompatibleUnitsError):
            convert(to_fraction("10"), Unit.WORDS, Unit.MILLIMETRE)

    def test_pixel_to_millimetre_raises(self) -> None:
        with pytest.raises(IncompatibleUnitsError) as caught:
            convert(to_fraction("300"), Unit.PIXEL, Unit.MILLIMETRE)
        assert "PIXEL" in str(caught.value)

    def test_the_error_names_both_dimensions(self) -> None:
        with pytest.raises(IncompatibleUnitsError) as caught:
            convert(to_fraction("1"), Unit.PAGES, Unit.WORDS)
        assert "PAGES" in str(caught.value)
        assert "WORDS" in str(caught.value)


class TestCommonUnit:
    def test_the_left_unit_wins(self) -> None:
        # So a violation reports the document's own unit, not one the engine
        # picked.
        left, right, unit = convert_to_common(
            to_fraction("3.05"), Unit.CENTIMETRE, to_fraction("30"), Unit.MILLIMETRE
        )
        assert unit is Unit.CENTIMETRE
        assert left == to_fraction("3.05")
        assert right == to_fraction("3")

    def test_two_unitless_values_compare_directly(self) -> None:
        left, right, unit = convert_to_common(to_fraction("5"), None, to_fraction("5"), None)
        assert (left, right, unit) == (Fraction(5), Fraction(5), None)

    def test_a_unit_on_one_side_only_is_refused(self) -> None:
        # Assuming the bare number shares the other side's unit is exactly the
        # guess that produces a confidently wrong measurement.
        with pytest.raises(IncompatibleUnitsError):
            convert_to_common(to_fraction("30"), Unit.MILLIMETRE, to_fraction("30"), None)


class TestValueParsing:
    def test_decimal_strings_convert_without_a_float(self) -> None:
        assert to_fraction("0.1") + to_fraction("0.2") == to_fraction("0.3")

    def test_decimals_convert_losslessly(self) -> None:
        assert to_fraction(Decimal("1.005")) == Fraction(201, 200)

    def test_integers_convert(self) -> None:
        assert to_fraction(7) == Fraction(7)

    def test_a_fraction_passes_through(self) -> None:
        value = Fraction(1, 3)
        assert to_fraction(value) is value


class TestFormatting:
    @pytest.mark.parametrize(
        ("value", "expected"),
        [("30", "30"), ("25.4", "25.4"), ("0.5", "0.5"), ("100", "100"), ("10.50", "10.5")],
    )
    def test_exact_values_render_plainly(self, value: str, expected: str) -> None:
        assert format_exact(to_fraction(value)) == expected

    def test_a_non_terminating_value_renders_at_documented_precision(self) -> None:
        # One point in millimetres is 25.4/72, which never terminates. This is
        # presentation only: the comparison that decided the verdict used the
        # exact rational.
        rendered = format_exact(convert(to_fraction("1"), Unit.POINT, Unit.MILLIMETRE))
        assert rendered.startswith("0.35277777")

    def test_a_whole_number_never_renders_in_exponent_form(self) -> None:
        assert format_exact(Fraction(10)) == "10"
        assert format_exact(Fraction(100)) == "100"
