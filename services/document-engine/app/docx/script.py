"""Unicode script classification and run segmentation (§38, §39).

WordprocessingML does not store "the font of this run". It stores up to four
fonts — ``w:rFonts/@w:ascii``, ``@w:hAnsi``, ``@w:eastAsia`` and ``@w:cs`` —
and the one that applies depends on the *character*. A run holding
"مرحبا Hello" is rendered in two different typefaces with two different sizes
(``w:sz`` for the Latin half, ``w:szCs`` for the Arabic), and claiming a
single effective font for it would be false for at least half the text.

PalCert is Arabic and English from day one, so this is not an edge case: it is
the common case, and §39 requires a documented classifier rather than an
ASCII-range guess.

**The documented mapping.** Every character is assigned to exactly one channel
by its Unicode code point:

* ``COMPLEX_SCRIPT`` — Arabic, Hebrew, Syriac, Thaana, Nko and their
  presentation forms; the scripts OOXML calls "complex" and routes to
  ``@w:cs`` with ``w:szCs``, ``w:bCs``, ``w:iCs``.
* ``EAST_ASIAN`` — CJK ideographs, kana, Hangul, and the CJK compatibility
  and fullwidth blocks; routed to ``@w:eastAsia``.
* ``LATIN`` — everything else with a defined typeface channel, split between
  ``@w:ascii`` (U+0000-U+007F) and ``@w:hAnsi`` (the rest).
* ``NEUTRAL`` — whitespace and characters that carry no script of their own.
  These never start a segment; they extend whichever segment precedes them,
  so " Hello مرحبا" is two segments, not four.
"""

from __future__ import annotations

from dataclasses import dataclass
from enum import StrEnum


class ScriptChannel(StrEnum):
    LATIN = "LATIN"
    COMPLEX_SCRIPT = "COMPLEX_SCRIPT"
    EAST_ASIAN = "EAST_ASIAN"
    #: Carries no script; joins the neighbouring segment.
    NEUTRAL = "NEUTRAL"


class FontSlot(StrEnum):
    """The ``w:rFonts`` attribute a channel reads."""

    ASCII = "ascii"
    HIGH_ANSI = "hAnsi"
    EAST_ASIA = "eastAsia"
    COMPLEX_SCRIPT = "cs"


#: (start, end) inclusive code-point ranges per channel, in ascending order.
_COMPLEX_SCRIPT_RANGES: tuple[tuple[int, int], ...] = (
    (0x0590, 0x05FF),  # Hebrew
    (0x0600, 0x06FF),  # Arabic
    (0x0700, 0x074F),  # Syriac
    (0x0750, 0x077F),  # Arabic Supplement
    (0x0780, 0x07BF),  # Thaana
    (0x07C0, 0x07FF),  # Nko
    (0x0800, 0x083F),  # Samaritan
    (0x0840, 0x085F),  # Mandaic
    (0x0860, 0x086F),  # Syriac Supplement
    (0x0870, 0x089F),  # Arabic Extended-B
    (0x08A0, 0x08FF),  # Arabic Extended-A
    (0xFB1D, 0xFB4F),  # Hebrew presentation forms
    (0xFB50, 0xFDFF),  # Arabic presentation forms A
    (0xFE70, 0xFEFF),  # Arabic presentation forms B
    (0x10800, 0x10FFF),  # Ancient/RTL supplementary planes
    (0x1E800, 0x1EFFF),  # Adlam, Arabic mathematical forms
)

_EAST_ASIAN_RANGES: tuple[tuple[int, int], ...] = (
    (0x1100, 0x11FF),  # Hangul Jamo
    (0x2E80, 0x2EFF),  # CJK radicals
    (0x3000, 0x303F),  # CJK symbols and punctuation
    (0x3040, 0x309F),  # Hiragana
    (0x30A0, 0x30FF),  # Katakana
    (0x3100, 0x312F),  # Bopomofo
    (0x3130, 0x318F),  # Hangul compatibility Jamo
    (0x3190, 0x319F),  # Kanbun
    (0x31F0, 0x31FF),  # Katakana phonetic extensions
    (0x3400, 0x4DBF),  # CJK extension A
    (0x4E00, 0x9FFF),  # CJK unified ideographs
    (0xA960, 0xA97F),  # Hangul Jamo extended-A
    (0xAC00, 0xD7AF),  # Hangul syllables
    (0xF900, 0xFAFF),  # CJK compatibility ideographs
    (0xFE30, 0xFE4F),  # CJK compatibility forms
    (0xFF00, 0xFF60),  # Fullwidth forms
    (0xFFE0, 0xFFE6),  # Fullwidth signs
    (0x20000, 0x2FA1F),  # CJK extensions B onwards
)

#: Characters with no script of their own.
_NEUTRAL_CODE_POINTS = frozenset(ord(character) for character in " \t\r\n        ")


def _in_ranges(code_point: int, ranges: tuple[tuple[int, int], ...]) -> bool:
    for start, end in ranges:
        if code_point < start:
            return False
        if code_point <= end:
            return True
    return False


def classify(character: str) -> ScriptChannel:
    """The channel one character belongs to."""
    code_point = ord(character)
    if code_point in _NEUTRAL_CODE_POINTS:
        return ScriptChannel.NEUTRAL
    if _in_ranges(code_point, _COMPLEX_SCRIPT_RANGES):
        return ScriptChannel.COMPLEX_SCRIPT
    if _in_ranges(code_point, _EAST_ASIAN_RANGES):
        return ScriptChannel.EAST_ASIAN
    return ScriptChannel.LATIN


def font_slot(channel: ScriptChannel, character: str) -> FontSlot:
    """Which ``w:rFonts`` attribute supplies the typeface.

    The Latin channel is split the way OOXML splits it: ``@w:ascii`` for
    U+0000-U+007F and ``@w:hAnsi`` above it. Neutral characters follow the
    Latin rule, but they never form a segment of their own so the choice only
    matters for a run that is entirely whitespace.
    """
    if channel is ScriptChannel.COMPLEX_SCRIPT:
        return FontSlot.COMPLEX_SCRIPT
    if channel is ScriptChannel.EAST_ASIAN:
        return FontSlot.EAST_ASIA
    return FontSlot.ASCII if ord(character) <= 0x7F else FontSlot.HIGH_ANSI


@dataclass(frozen=True, slots=True)
class ScriptSegment:
    """A maximal stretch of text in one channel."""

    channel: ScriptChannel
    slot: FontSlot
    text: str
    #: Offset of the first character within the run's text.
    start: int

    @property
    def length(self) -> int:
        return len(self.text)


def segment(text: str) -> tuple[ScriptSegment, ...]:
    """Split run text into channel segments, in document order.

    Neutral characters extend the current segment rather than breaking it, so
    "Hello مرحبا" is two segments and not three. A leading neutral run of
    characters belongs to the segment that follows it, because the font that
    will render it is the one the following text selects.
    """
    if not text:
        return ()

    segments: list[ScriptSegment] = []
    pending_neutral = ""
    pending_start = 0
    current: ScriptChannel | None = None
    current_text = ""
    current_start = 0

    for index, character in enumerate(text):
        channel = classify(character)
        if channel is ScriptChannel.NEUTRAL:
            if current is None:
                if not pending_neutral:
                    pending_start = index
                pending_neutral += character
            else:
                current_text += character
            continue

        if current is None:
            current = channel
            current_text = pending_neutral + character
            current_start = pending_start if pending_neutral else index
            pending_neutral = ""
        elif channel is current:
            current_text += character
        else:
            segments.append(
                ScriptSegment(
                    channel=current,
                    slot=font_slot(current, _first_scripted(current_text, current)),
                    text=current_text,
                    start=current_start,
                )
            )
            current = channel
            current_text = character
            current_start = index

    if current is not None:
        segments.append(
            ScriptSegment(
                channel=current,
                slot=font_slot(current, _first_scripted(current_text, current)),
                text=current_text,
                start=current_start,
            )
        )
    elif pending_neutral:
        segments.append(
            ScriptSegment(
                channel=ScriptChannel.LATIN,
                slot=FontSlot.ASCII,
                text=pending_neutral,
                start=pending_start,
            )
        )
    return tuple(segments)


def _first_scripted(text: str, channel: ScriptChannel) -> str:
    """The first character that actually carries the channel's script.

    The segment may open with whitespace, and whitespace must not decide
    between ``@w:ascii`` and ``@w:hAnsi`` for a segment of accented Latin.
    """
    for character in text:
        if classify(character) is channel:
            return character
    return text[0]
