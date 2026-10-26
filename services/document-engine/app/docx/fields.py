"""Word field instructions (§61, §62, §63, §64).

A field is a stored instruction plus a **cached result** from whenever Word
last updated it. Both matter, and they matter differently:

* the *instruction* is deterministic evidence — a ``TOC`` field means the
  document has a table of contents field, and a ``SEQ Figure`` field is real
  caption evidence;
* the *result* is a snapshot that may be years stale. ``PAGE`` showing "7"
  is not proof that anything is on page 7 (§62).

Instructions are parsed, never executed (§61). They are data: a string with a
keyword and arguments, read for its first token and nothing more.
"""

from __future__ import annotations

from app.docx.model import FieldType

#: Keywords PalCert recognizes, mapped to their field type.
_KEYWORDS: dict[str, FieldType] = {
    "PAGE": FieldType.PAGE,
    "NUMPAGES": FieldType.NUMPAGES,
    "SECTIONPAGES": FieldType.NUMPAGES,
    "TOC": FieldType.TOC,
    "SEQ": FieldType.SEQ,
    "CITATION": FieldType.CITATION,
    "REF": FieldType.REF,
    "STYLEREF": FieldType.STYLEREF,
    "HYPERLINK": FieldType.HYPERLINK,
}


def parse_instruction(instruction: str) -> tuple[FieldType, str, str | None]:
    """``(type, keyword, sequence name)`` for one field instruction.

    Splitting is on whitespace with quoted arguments respected, because a
    ``SEQ "Figure 1"`` must not be read as the sequence ``"Figure``. Nothing
    beyond the keyword and, for SEQ, its first argument is retained: a
    ``CITATION`` instruction carries a bibliography key, and a ``REF`` carries
    a bookmark name, neither of which PalCert needs and both of which are user
    content.
    """
    tokens = _tokenize(instruction)
    if not tokens:
        return FieldType.OTHER, "", None

    keyword = tokens[0].upper()
    field_type = _KEYWORDS.get(keyword, FieldType.OTHER)
    sequence_name = tokens[1] if field_type is FieldType.SEQ and len(tokens) > 1 else None
    return field_type, keyword, sequence_name


def citation_tag(instruction: str) -> str | None:
    """The bibliography key a ``CITATION`` instruction names, or None.

    Phase 18 is the first thing that needs it. ``parse_instruction`` deliberately
    drops it, because the structural model is rendered into the artifact whole
    and the key is user content; citation analysis reads it here instead, uses
    it for exact tag matching, and lets it reach the artifact only inside
    ``citationAnalysis``, where the contract bounds its length.

    Switches are skipped: ``CITATION Smi01 \\l 1033`` names ``Smi01``, and a
    field whose first argument is a switch names nothing rather than ``\\l``.
    """
    tokens = _tokenize(instruction)
    if len(tokens) < 2 or tokens[0].upper() != "CITATION":
        return None
    argument = tokens[1]
    return None if argument.startswith("\\") else argument


def _tokenize(instruction: str) -> list[str]:
    tokens: list[str] = []
    current = ""
    quoted = False
    for character in instruction.strip():
        if character == '"':
            quoted = not quoted
            continue
        if character.isspace() and not quoted:
            if current:
                tokens.append(current)
                current = ""
            continue
        current += character
    if current:
        tokens.append(current)
    return tokens


#: Sequence names that identify a caption when they appear in a SEQ field.
#: Matched case-insensitively; a document using a localized sequence name is
#: reported as partial caption coverage rather than guessed at (§64).
CAPTION_SEQUENCE_NAMES: frozenset[str] = frozenset({"figure", "table", "equation"})


def caption_kind(sequence_name: str | None) -> str | None:
    """ "FIGURE", "TABLE", "EQUATION" — or None when it is some other sequence."""
    if not sequence_name:
        return None
    normalized = sequence_name.strip().lower()
    return normalized.upper() if normalized in CAPTION_SEQUENCE_NAMES else None
