"""Whether this document may be edited at all.

Three conditions stop SmartFix before any rule is considered, and each is a
property of the *document* rather than of any one rule — so the plan records
one refusal and carries no actions.

**Tracked changes.** A document under revision marks is a conversation between
an author and a supervisor. Writing formatting into it either joins that
conversation under PalCert's name or silently bypasses it, and there is no
third option that leaves the review intact. PalCert refuses and says so.

**Document protection.** The author asked Word to forbid editing. Honouring
that is not a technical limitation; it is the only defensible reading of the
request.

**A digital signature.** Any edit invalidates it, which is the signature
working exactly as intended. Producing a corrected copy with a broken
signature would hand the user a document that looks certified and is not.
"""

from __future__ import annotations

from app.docx.model import StructuralModel
from app.docx.namespaces import Namespaces
from app.docx.package import REL_SETTINGS, DocxPackage
from app.smartfix.capability import RefusalCode

#: Parts a signed package carries. Matched by prefix because the origin
#: relationship names vary between Word versions while the location does not.
_SIGNATURE_PREFIXES = ("_xmlsignatures/", "_xmlsignatures\\")


def assess(
    package: DocxPackage, model: StructuralModel, namespaces: Namespaces
) -> RefusalCode | None:
    """The reason this document cannot be corrected, or ``None``."""
    if _is_signed(package):
        return RefusalCode.SIGNED
    if _is_protected(package, namespaces):
        return RefusalCode.PROTECTED
    revisions = model.revisions
    if revisions.insertions or revisions.deletions or revisions.moves:
        return RefusalCode.TRACKED_CHANGES
    if revisions.formatting_changes:
        # A ``w:rPrChange`` records what the formatting *used* to be. Editing
        # the current formatting without touching that record would make the
        # document claim a change that never happened, and rewriting the
        # record would falsify somebody's review history.
        return RefusalCode.TRACKED_CHANGES
    return None


def _is_signed(package: DocxPackage) -> bool:
    if any(
        name.lower().startswith(prefix)
        for name in package.part_names()
        for prefix in _SIGNATURE_PREFIXES
    ):
        return True
    return any(
        "digital-signature" in content_type for content_type in package.content_types().values()
    )


def _is_protected(package: DocxPackage, namespaces: Namespaces) -> bool:
    relationship = package.relationships_of(package.main_document_part()).first_of_kind(
        REL_SETTINGS
    )
    if relationship is None:
        return False
    root = package.parse_optional_part(relationship.part_name)
    if root is None:
        return False
    for tag in ("w:documentProtection", "w:writeProtection"):
        element = root.find(namespaces.qn(tag))
        if element is None:
            continue
        if tag == "w:writeProtection":
            return True
        edit = element.get(namespaces.qn("w:edit"))
        enforced = (element.get(namespaces.qn("w:enforcement")) or "").strip().lower()
        if enforced in {"0", "false", "off"}:
            # Declared but not enforced: Word ignores it, and so does PalCert.
            continue
        if edit is None or edit.strip().lower() != "none":
            return True
    return False
