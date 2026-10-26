"""PalCert's word count (§59, §60).

There is no universal word count. Microsoft Word's own number depends on
version, on which stories are included, and on rules Microsoft has never
published. Claiming parity with it would be a claim PalCert cannot defend, so
Phase 6 defines its **own** count, states it exactly, and versions it with the
analyzer: changing this algorithm changes analyzer behaviour and therefore
requires an analyzer-version decision (§106).

**The definition.**

* Counted from the FINAL revision view: inserted and moved-in text counts,
  deleted and moved-out text does not (§55).
* Hidden text (effective ``w:vanish`` or ``w:webHidden``) does not count (§58).
* Counts are reported per story: body, footnotes, endnotes, headers and
  footers, text boxes. ``bodyWordCount`` is the main document story alone —
  never a silent mixture (§53).
* A **word** is a maximal run of word characters. A word character is any
  Unicode letter or digit, plus the joiners that occur *inside* words:
  ``'`` ``’`` ``-`` ``‐`` ``_`` and the Arabic tatweel ``ـ``, but only when
  they sit between two word characters. So "state-of-the-art" is one word,
  "don't" is one word, and a dash used as punctuation is not part of one.
* Arabic is counted the same way. Arabic letters are Unicode letters, so
  whitespace-delimited Arabic words count naturally; Arabic diacritics are
  combining marks and never split a word.
* A number is a word: "2026" counts as one, and "3.5" counts as one because
  the period sits between digits.
* CJK is **not** counted per character. Each whitespace-delimited CJK run
  counts as one word, which is the documented behaviour rather than an
  attempt at segmentation PalCert cannot do deterministically.

Character counts cover the body story only, with and without whitespace.
"""

from __future__ import annotations

import unicodedata

#: Characters that join two word characters into one word.
_INTRA_WORD_JOINERS = frozenset({"'", "’", "-", "‐", "_", "ـ"})
#: Characters that join only two *digits*: "3.5" and "1,000" are one word
#: each, while "end. Start" is two.
_NUMERIC_JOINERS = frozenset({".", ",", "٫", "٬"})
#: Marks that attach to a letter and never break a word (Arabic diacritics,
#: combining accents, zero-width joiners used in Arabic shaping).
_COMBINING_CATEGORIES = frozenset({"Mn", "Mc", "Me"})
_ZERO_WIDTH = frozenset({"‌", "‍"})


def _is_word_character(character: str) -> bool:
    if character.isalnum():
        return True
    if character in _ZERO_WIDTH:
        return True
    return unicodedata.category(character) in _COMBINING_CATEGORIES


def count_words(text: str) -> int:
    """Words in one stretch of visible text, by the definition above."""
    count = 0
    in_word = False
    index = 0
    length = len(text)

    while index < length:
        character = text[index]
        if _is_word_character(character):
            if not in_word:
                count += 1
                in_word = True
            index += 1
            continue

        if in_word and index + 1 < length:
            following = text[index + 1]
            joins_words = character in _INTRA_WORD_JOINERS and _is_word_character(following)
            joins_digits = (
                character in _NUMERIC_JOINERS and following.isdigit() and text[index - 1].isdigit()
            )
            if joins_words or joins_digits:
                # A joiner between two word characters keeps the word open.
                index += 1
                continue

        in_word = False
        index += 1

    return count


def count_characters(text: str, *, include_whitespace: bool) -> int:
    if include_whitespace:
        return len(text)
    return sum(1 for character in text if not character.isspace())
