"""The named pattern registry and text normalization."""

from __future__ import annotations

import time

import pytest

from app.engine.rules.patterns import (
    MAX_PATTERN_INPUT_LENGTH,
    PATTERNS_REQUIRING_ARGUMENT,
    PatternInputTooLongError,
    PatternName,
    is_supported,
    match_pattern,
)
from app.engine.rules.text import (
    TextComparison,
    comparison_for_property,
    contains,
    equals,
    normalize,
)


class TestPatternRegistry:
    def test_every_named_pattern_is_implemented(self) -> None:
        # "Never silently ignore" applies to patterns as much as operators.
        for pattern in PatternName:
            assert match_pattern(pattern, "sample", "sample") in (True, False)

    def test_only_the_prefix_patterns_take_an_argument(self) -> None:
        assert {PatternName.STARTS_WITH, PatternName.ENDS_WITH} == PATTERNS_REQUIRING_ARGUMENT

    def test_an_unknown_pattern_name_is_not_supported(self) -> None:
        assert not is_supported("EVAL")
        assert is_supported("DOI")


class TestPatternBehaviour:
    @pytest.mark.parametrize(
        ("pattern", "value", "argument", "expected"),
        [
            (PatternName.STARTS_WITH, "Figure 1: Water", "Figure", True),
            (PatternName.STARTS_WITH, "Fig. 1", "Figure", False),
            (PatternName.ENDS_WITH, "chapter.docx", ".docx", True),
            (PatternName.DIGITS_ONLY, "20260913", None, True),
            (PatternName.DIGITS_ONLY, "2026-09", None, False),
            (PatternName.DIGITS_ONLY, "", None, False),
            (PatternName.LETTERS_ONLY, "Methodology", None, True),
            (PatternName.LETTERS_ONLY, "Chapter 3", None, False),
            (PatternName.NO_LEADING_WHITESPACE, "Abstract", None, True),
            (PatternName.NO_LEADING_WHITESPACE, "  Abstract", None, False),
            (PatternName.NO_TRAILING_WHITESPACE, "Abstract ", None, False),
            (PatternName.UPPERCASE, "ABSTRACT", None, True),
            (PatternName.UPPERCASE, "Abstract", None, False),
            (PatternName.UPPERCASE, "1234", None, False),
        ],
    )
    def test_simple_patterns(
        self, pattern: PatternName, value: str, argument: str | None, expected: bool
    ) -> None:
        assert match_pattern(pattern, value, argument) is expected

    @pytest.mark.parametrize(
        ("value", "expected"),
        [
            ("A study of water rights", True),
            ("A Study", True),
            # A proper noun after the first word is fine; only the opening word
            # is judged, or every legitimate title would be rejected.
            ("A study of Palestinian water", True),
            ("a study of water rights", False),
            ("AN OPENING SHOUT", False),
            ("", False),
        ],
    )
    def test_sentence_case(self, value: str, expected: bool) -> None:
        assert match_pattern(PatternName.SENTENCE_CASE, value) is expected

    @pytest.mark.parametrize(
        ("value", "expected"),
        [
            ("A Study of Water Rights", True),
            # Short words are exempt, as English title case requires.
            ("The Law and the Land", True),
            ("A study of Water Rights", False),
        ],
    )
    def test_title_case(self, value: str, expected: bool) -> None:
        assert match_pattern(PatternName.TITLE_CASE, value) is expected

    @pytest.mark.parametrize(
        ("value", "expected"),
        [("الجامعة الإسلامية", True), ("Islamic University", False), ("جامعة University", False)],
    )
    def test_arabic_script(self, value: str, expected: bool) -> None:
        assert match_pattern(PatternName.ARABIC_SCRIPT, value) is expected

    @pytest.mark.parametrize(
        ("value", "expected"),
        [("Islamic University", True), ("الجامعة", False)],
    )
    def test_latin_script(self, value: str, expected: bool) -> None:
        assert match_pattern(PatternName.LATIN_SCRIPT, value) is expected

    @pytest.mark.parametrize(
        ("value", "expected"),
        [
            ("10.1234/abc.def", True),
            ("10.1234/x", True),
            ("doi:10.1234/abc", False),
            ("11.1234/abc", False),
            ("10.12/abc", False),
        ],
    )
    def test_doi(self, value: str, expected: bool) -> None:
        assert match_pattern(PatternName.DOI, value) is expected

    @pytest.mark.parametrize(
        ("value", "expected"),
        [("2049-3630", True), ("2049-363X", True), ("20493630", False)],
    )
    def test_issn(self, value: str, expected: bool) -> None:
        assert match_pattern(PatternName.ISSN, value) is expected

    @pytest.mark.parametrize(
        ("value", "expected"),
        [
            ("978-3-16-148410-0", True),
            ("9783161484100", True),
            ("0-306-40615-2", True),
            ("12345", False),
        ],
    )
    def test_isbn(self, value: str, expected: bool) -> None:
        assert match_pattern(PatternName.ISBN, value) is expected

    @pytest.mark.parametrize(
        ("value", "expected"),
        [("author@iug.edu.ps", True), ("not an email", False), ("a@b", False)],
    )
    def test_email(self, value: str, expected: bool) -> None:
        assert match_pattern(PatternName.EMAIL, value) is expected

    @pytest.mark.parametrize(
        ("value", "expected"),
        [("https://palcert.com/x", True), ("http://example.test", True), ("ftp://x", False)],
    )
    def test_url(self, value: str, expected: bool) -> None:
        assert match_pattern(PatternName.URL, value) is expected


class TestPatternSafety:
    def test_an_oversized_input_is_refused(self) -> None:
        with pytest.raises(PatternInputTooLongError):
            match_pattern(PatternName.DOI, "1" * (MAX_PATTERN_INPUT_LENGTH + 1))

    def test_a_value_at_the_limit_is_accepted(self) -> None:
        assert match_pattern(PatternName.DIGITS_ONLY, "1" * MAX_PATTERN_INPUT_LENGTH) is True

    @pytest.mark.parametrize(
        "hostile",
        [
            "a" * 5000 + "!",
            "10." + "1" * 4000,
            "@" * 3000,
            "https://" + "a" * 4000,
            " " * 5000,
        ],
    )
    def test_pathological_input_stays_fast(self, hostile: str) -> None:
        # No pattern contains a nested quantifier, so none can backtrack
        # catastrophically. A caller-supplied regex could; this is why one is
        # never accepted.
        started = time.perf_counter()
        for pattern in PatternName:
            match_pattern(pattern, hostile, "x")
        assert time.perf_counter() - started < 1.0


class TestTextComparisonModes:
    def test_the_default_is_exact(self) -> None:
        # The mode that cannot silently accept something the author did not
        # write.
        assert comparison_for_property("someUnknownProperty") is TextComparison.EXACT
        assert comparison_for_property(None) is TextComparison.EXACT

    def test_a_font_family_compares_loosely(self) -> None:
        assert comparison_for_property("fontFamily") is TextComparison.NORMALIZED

    def test_a_font_family_ignores_case_and_internal_spacing(self) -> None:
        assert equals("  times   NEW roman ", "Times New Roman", TextComparison.NORMALIZED)

    def test_exact_mode_does_not_ignore_case(self) -> None:
        # A required declaration must compare strictly.
        assert not equals("we declare no conflict", "We declare no conflict", TextComparison.EXACT)

    def test_exact_mode_does_not_trim(self) -> None:
        assert not equals(" Abstract", "Abstract", TextComparison.EXACT)

    def test_trimmed_mode_trims_but_keeps_case(self) -> None:
        assert equals("  Abstract  ", "Abstract", TextComparison.TRIMMED)
        assert not equals("abstract", "Abstract", TextComparison.TRIMMED)

    def test_case_insensitive_keeps_internal_spacing(self) -> None:
        assert equals("Times New Roman", "times new roman", TextComparison.CASE_INSENSITIVE)
        assert not equals("Times  New Roman", "Times New Roman", TextComparison.CASE_INSENSITIVE)


class TestUnicodeNormalization:
    def test_every_mode_normalizes_to_nfc(self) -> None:
        # Two byte sequences that render identically are the same text to a
        # reader. Treating them as different would make a rule impossible to
        # satisfy for reasons invisible on screen.
        decomposed = "الملخص".encode().decode()
        for mode in TextComparison:
            assert equals(decomposed, decomposed.encode().decode(), mode)

    def test_a_precomposed_and_decomposed_character_compare_equal(self) -> None:
        precomposed = "é"
        decomposed = "é"
        assert precomposed != decomposed
        assert equals(precomposed, decomposed, TextComparison.EXACT)

    def test_normalization_is_idempotent(self) -> None:
        for mode in TextComparison:
            once = normalize("  Times   New Roman  ", mode)
            assert normalize(once, mode) == once


class TestContainment:
    def test_containment_respects_the_mode(self) -> None:
        assert contains("A Study of Water", "study", TextComparison.NORMALIZED)
        assert not contains("A Study of Water", "study", TextComparison.EXACT)
