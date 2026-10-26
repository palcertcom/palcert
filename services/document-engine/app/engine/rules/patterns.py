"""The named pattern registry.

Phase 3 deliberately stores only *named* PalCert patterns, never a
caller-supplied regular expression. That design continues here, and this module
is the reason it matters: these are the implementations, and they are the only
matching code the engine will run.

A user-supplied regex would be two separate problems at once — arbitrary
executable input, and a denial-of-service vector through catastrophic
backtracking. Every pattern below is instead a bounded, hand-written predicate.
Where a regular expression is used at all it is a fixed literal with no nested
quantifier, so its running time is linear in the input length.
"""

from __future__ import annotations

import re
import unicodedata
from collections.abc import Callable
from enum import StrEnum

#: Refuse to match beyond this length. A pattern is a formatting check, not a
#: text-processing pipeline; anything longer is a malformed fact.
MAX_PATTERN_INPUT_LENGTH = 10000


class PatternName(StrEnum):
    """The Phase 3 ``RulePatternName`` vocabulary, unchanged."""

    STARTS_WITH = "STARTS_WITH"
    ENDS_WITH = "ENDS_WITH"
    DIGITS_ONLY = "DIGITS_ONLY"
    LETTERS_ONLY = "LETTERS_ONLY"
    NO_LEADING_WHITESPACE = "NO_LEADING_WHITESPACE"
    NO_TRAILING_WHITESPACE = "NO_TRAILING_WHITESPACE"
    SENTENCE_CASE = "SENTENCE_CASE"
    TITLE_CASE = "TITLE_CASE"
    UPPERCASE = "UPPERCASE"
    ARABIC_SCRIPT = "ARABIC_SCRIPT"
    LATIN_SCRIPT = "LATIN_SCRIPT"
    DOI = "DOI"
    ISSN = "ISSN"
    ISBN = "ISBN"
    EMAIL = "EMAIL"
    URL = "URL"


PATTERNS_REQUIRING_ARGUMENT: frozenset[PatternName] = frozenset(
    {PatternName.STARTS_WITH, PatternName.ENDS_WITH}
)


class PatternInputTooLongError(ValueError):
    """The value handed to a pattern exceeded the engine's bound."""


# --- individual patterns ----------------------------------------------------
#
# Each is linear in the input. None contains a nested quantifier, so none can
# backtrack catastrophically.

_DOI = re.compile(r"^10\.[0-9]{4,9}/[!-~]{1,200}$")
_ISSN = re.compile(r"^[0-9]{4}-[0-9]{3}[0-9xX]$")
_ISBN10 = re.compile(r"^[0-9]{9}[0-9xX]$")
_ISBN13 = re.compile(r"^97[89][0-9]{10}$")
_EMAIL = re.compile(r"^[^@\s]{1,64}@[^@\s.]{1,63}(\.[^@\s.]{1,63}){1,8}$")
_URL = re.compile(r"^https?://[^\s/?#]{1,253}([/?#][^\s]{0,2000})?$")


def _digits_only(value: str, _argument: str | None) -> bool:
    return value != "" and all(character.isdigit() for character in value)


def _letters_only(value: str, _argument: str | None) -> bool:
    return value != "" and all(character.isalpha() for character in value)


def _no_leading_whitespace(value: str, _argument: str | None) -> bool:
    return value == value.lstrip()


def _no_trailing_whitespace(value: str, _argument: str | None) -> bool:
    return value == value.rstrip()


def _sentence_case(value: str, _argument: str | None) -> bool:
    """First cased character is upper, the rest of the first word is not.

    Only the opening word is judged. A sentence legitimately contains proper
    nouns, and flagging "Study of Palestinian Water Rights" as not sentence case
    because of a capital P would be wrong.
    """
    stripped = value.strip()
    if stripped == "":
        return False

    first = next((character for character in stripped if character.isalpha()), None)
    if first is None:
        return False
    if not first.isupper():
        return False

    first_word = stripped.split()[0]
    letters = [character for character in first_word if character.isalpha()]
    return all(not character.isupper() for character in letters[1:])


def _title_case(value: str, _argument: str | None) -> bool:
    """Every word of four or more letters starts with a capital.

    Short words are exempt because English title case does not capitalise
    "of", "the", "and". A stricter reading would reject correctly formatted
    titles, which is worse than a slightly permissive one.
    """
    stripped = value.strip()
    if stripped == "":
        return False

    for word in stripped.split():
        letters = [character for character in word if character.isalpha()]
        if len(letters) >= 4 and not letters[0].isupper():
            return False
    return True


def _uppercase(value: str, _argument: str | None) -> bool:
    letters = [character for character in value if character.isalpha()]
    return len(letters) > 0 and all(character.isupper() for character in letters)


def _script(value: str, prefixes: tuple[str, ...]) -> bool:
    """Every letter belongs to the named Unicode script.

    Judged by Unicode character name rather than a code-point range, so it
    stays correct for the Arabic Presentation Forms and Supplement blocks
    without hard-coding three separate ranges.
    """
    letters = [character for character in value if character.isalpha()]
    if not letters:
        return False

    for character in letters:
        try:
            name = unicodedata.name(character)
        except ValueError:
            return False
        if not name.startswith(prefixes):
            return False
    return True


def _arabic_script(value: str, _argument: str | None) -> bool:
    return _script(value, ("ARABIC",))


def _latin_script(value: str, _argument: str | None) -> bool:
    return _script(value, ("LATIN",))


def _isbn(value: str, _argument: str | None) -> bool:
    compact = value.replace("-", "").replace(" ", "")
    return bool(_ISBN10.match(compact) or _ISBN13.match(compact))


_IMPLEMENTATIONS: dict[PatternName, Callable[[str, str | None], bool]] = {
    PatternName.STARTS_WITH: lambda value, argument: (
        argument is not None and value.startswith(argument)
    ),
    PatternName.ENDS_WITH: lambda value, argument: (
        argument is not None and value.endswith(argument)
    ),
    PatternName.DIGITS_ONLY: _digits_only,
    PatternName.LETTERS_ONLY: _letters_only,
    PatternName.NO_LEADING_WHITESPACE: _no_leading_whitespace,
    PatternName.NO_TRAILING_WHITESPACE: _no_trailing_whitespace,
    PatternName.SENTENCE_CASE: _sentence_case,
    PatternName.TITLE_CASE: _title_case,
    PatternName.UPPERCASE: _uppercase,
    PatternName.ARABIC_SCRIPT: _arabic_script,
    PatternName.LATIN_SCRIPT: _latin_script,
    PatternName.DOI: lambda value, _argument: bool(_DOI.match(value)),
    PatternName.ISSN: lambda value, _argument: bool(_ISSN.match(value)),
    PatternName.ISBN: _isbn,
    PatternName.EMAIL: lambda value, _argument: bool(_EMAIL.match(value)),
    PatternName.URL: lambda value, _argument: bool(_URL.match(value)),
}


def is_supported(name: str) -> bool:
    return name in {pattern.value for pattern in PatternName}


def match_pattern(name: PatternName, value: str, argument: str | None = None) -> bool:
    """Apply a named pattern.

    Raises :class:`PatternInputTooLongError` rather than matching an unbounded
    string, so a hostile fact cannot turn a formatting check into a workload.
    """
    if len(value) > MAX_PATTERN_INPUT_LENGTH:
        raise PatternInputTooLongError(
            f"Value of {len(value)} characters exceeds the {MAX_PATTERN_INPUT_LENGTH} "
            f"character limit for pattern {name.value}."
        )

    implementation = _IMPLEMENTATIONS.get(name)
    if implementation is None:  # pragma: no cover - the enum is exhaustive
        raise KeyError(f"No implementation for pattern {name.value}")

    return implementation(value, argument)
