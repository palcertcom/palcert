"""Bounded formatting edits for styles, list starts and inline drawings."""

from __future__ import annotations

from copy import deepcopy
from xml.etree.ElementTree import Element

from app.docx.namespaces import local_name
from app.docx.styles import StyleType
from app.smartfix.capability import ActionType
from app.smartfix.locate import DocumentIndex
from app.smartfix.model import FixAction
from app.smartfix.observe import NodeLookup
from app.smartfix.ooxml import (
    PARAGRAPH_PROPERTY_ORDER,
    UnwritableValueError,
    ensure_child,
    ensure_paragraph_properties,
)

WP14 = "http://schemas.microsoft.com/office/word/2010/wordprocessingDrawing"


def validate_extended_action(
    action: FixAction, target: Element, index: DocumentIndex, lookup: NodeLookup
) -> None:
    """Validate every target before the mutator makes its first change."""
    if action.action_type is ActionType.SET_PARAGRAPH_STYLE:
        style = index.styles.get(action.after.text)
        if style is None or style.style_type is not StyleType.PARAGRAPH:
            raise UnwritableValueError("the target paragraph style does not exist")
    elif action.action_type is ActionType.SET_LIST_START:
        paragraph = lookup.paragraphs.get(action.node_id)
        number = action.after.number
        if (
            paragraph is None
            or paragraph.numbering is None
            or index.numbering_part not in index.roots
            or number is None
            or number != number.to_integral_value()
            or not 0 <= number <= 2147483647
        ):
            raise UnwritableValueError("a list start requires an existing numbering instance")
    elif action.action_type is ActionType.SET_DRAWING_PLACEMENT:
        if action.after.text != "INLINE":
            raise UnwritableValueError("only conversion to inline placement is supported")
        ns = index.namespaces
        placements = [c for c in target if c.tag in {ns.qn("wp:anchor"), ns.qn("wp:inline")}]
        if len(placements) != 1:
            raise UnwritableValueError("the drawing does not have a unique placement")
        known_attributes = {
            "distT",
            "distB",
            "distL",
            "distR",
            "simplePos",
            "relativeHeight",
            "behindDoc",
            "locked",
            "layoutInCell",
            "allowOverlap",
            "hidden",
            f"{{{WP14}}}anchorId",
            f"{{{WP14}}}editId",
        }
        if any(k not in known_attributes for k in placements[0].attrib) or placements[0].get(
            "hidden", "false"
        ) not in {"false", "0"}:
            raise UnwritableValueError("the drawing has unsupported visibility or attributes")
        names = [local_name(c.tag) for c in placements[0]]
        if any(names.count(name) != 1 for name in ("extent", "docPr", "graphic")):
            raise UnwritableValueError("the drawing lacks complete inline geometry")
        allowed = {
            ns.qn("wp:" + name)
            for name in (
                "simplePos",
                "positionH",
                "positionV",
                "extent",
                "effectExtent",
                "wrapNone",
                "wrapSquare",
                "wrapTight",
                "wrapThrough",
                "wrapTopAndBottom",
                "docPr",
                "cNvGraphicFramePr",
            )
        } | {ns.qn("a:graphic")}
        for child in placements[0]:
            if child.tag in allowed:
                continue
            percentage = {
                f"{{{WP14}}}sizeRelH": f"{{{WP14}}}pctWidth",
                f"{{{WP14}}}sizeRelV": f"{{{WP14}}}pctHeight",
            }.get(child.tag)
            # Conversion uses the explicit wp:extent. Nonzero relative sizing
            # needs a layout calculation and cannot be silently discarded.
            if (
                percentage is None
                or len(child) != 1
                or child[0].tag != percentage
                or (child[0].text or "").strip() != "0"
            ):
                raise UnwritableValueError(
                    "the drawing contains unsupported positioning extensions"
                )
        if len(names) != len(set(names)):
            raise UnwritableValueError("the drawing contains duplicate geometry")


def apply_inline_drawing(drawing: Element) -> None:
    """Keep the graphic, dimensions and metadata; remove floating positioning."""
    placement = next(c for c in drawing if local_name(c.tag) in {"anchor", "inline"})
    placement.tag = placement.tag.rpartition("}")[0] + "}inline"
    placement.attrib = {
        k: v
        for k, v in placement.attrib.items()
        if k in {"distT", "distB", "distL", "distR", f"{{{WP14}}}anchorId"}
    }
    order = ("extent", "effectExtent", "docPr", "cNvGraphicFramePr", "graphic")
    children = [c for c in placement if local_name(c.tag) in order]
    placement[:] = sorted(children, key=lambda c: order.index(local_name(c.tag)))


def apply_list_starts(
    actions: tuple[FixAction, ...], index: DocumentIndex, lookup: NodeLookup
) -> set[str]:
    """Clone numbering per requested start; unselected lists retain their instance.

    Paragraphs from the same old instance and requested start share one clone,
    so a multi-paragraph list is not accidentally restarted on every item.
    """
    selected = [a for a in actions if a.action_type is ActionType.SET_LIST_START]
    if not selected:
        return set()
    part = index.numbering_part
    if part is None:
        raise UnwritableValueError("the numbering part is missing")
    root, ns = index.roots[part], index.namespaces
    instances = {int(e.get(ns.qn("w:numId"), "-1")): e for e in root.findall(ns.qn("w:num"))}
    next_id = max(instances, default=0) + 1
    clones: dict[tuple[int, int], tuple[int, Element]] = {}
    changed = {part}
    for action in selected:
        paragraph = lookup.paragraphs[action.node_id]
        numbering = paragraph.numbering
        if numbering is None or action.after.number is None:
            raise UnwritableValueError("the list target is unresolved")
        key = (numbering.numbering_id, int(action.after.number))
        if key not in clones:
            original = instances.get(numbering.numbering_id)
            if original is None or next_id > 2147483647:
                raise UnwritableValueError("the numbering instance cannot be cloned")
            clone = deepcopy(original)
            clone.set(ns.qn("w:numId"), str(next_id))
            clones[key] = (next_id, clone)
            next_id += 1
            insertion = next(
                (i for i, e in enumerate(root) if local_name(e.tag) == "numIdMacAtCleanup"),
                len(root),
            )
            root.insert(insertion, clone)
        new_id, clone = clones[key]
        override = next(
            (
                e
                for e in clone.findall(ns.qn("w:lvlOverride"))
                if e.get(ns.qn("w:ilvl")) == str(numbering.level)
            ),
            None,
        )
        if override is None:
            override = Element(ns.qn("w:lvlOverride"), {ns.qn("w:ilvl"): str(numbering.level)})
            clone.append(override)
        start = ensure_child(override, "startOverride", ns, ("startOverride", "lvl"))
        start.set(ns.qn("w:val"), str(key[1]))
        located = index.element_for(action.node_id)
        if located is None:
            raise UnwritableValueError("the list paragraph cannot be located")
        paragraph_part, target = located
        ppr = ensure_paragraph_properties(target, ns)
        numpr = ensure_child(ppr, "numPr", ns, PARAGRAPH_PROPERTY_ORDER)
        for tag, value in (("ilvl", numbering.level), ("numId", new_id)):
            child = ensure_child(numpr, tag, ns, ("ilvl", "numId", "numberingChange", "ins"))
            child.set(ns.qn("w:val"), str(value))
        changed.add(paragraph_part)
    return changed
