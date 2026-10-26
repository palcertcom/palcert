"""Selecting the facts a rule applies to.

**One mechanism, one place.** Scope matching lives here and nowhere else. If
each operator did its own matching, "which elements does this rule cover?"
would have as many answers as there are operators, and the discrepancies would
only surface as wrong verdicts on real documents.

The index exists for complexity, not micro-optimisation: without it, evaluating
R rules against F facts is O(R x F), so 200 rules over 10,000 facts is two
million scope comparisons. Bucketing facts by (kind, element type, property)
makes selection proportional to the number of facts a rule actually addresses.
See ``docs/architecture/rule-engine.md``.
"""

from __future__ import annotations

from collections import defaultdict

from app.engine.facts.model import DocumentFact, DocumentFactSet, FactScope


class FactIndex:
    """Facts bucketed by their coarse scope key.

    Built once per fact set and reused across every rule in the evaluation.
    """

    __slots__ = ("_buckets", "_total")

    def __init__(self, fact_set: DocumentFactSet) -> None:
        buckets: dict[tuple[str, str, str], list[DocumentFact]] = defaultdict(list)
        for fact in fact_set.facts:
            buckets[fact.scope.selector_key()].append(fact)

        # Sorted once, here, so every selection is already in canonical order
        # and no downstream step has to remember to sort. Evaluation must not
        # depend on the order the extractor happened to emit facts in.
        self._buckets: dict[tuple[str, str, str], tuple[DocumentFact, ...]] = {
            key: tuple(sorted(facts, key=DocumentFact.sort_key)) for key, facts in buckets.items()
        }
        self._total = len(fact_set.facts)

    @property
    def total_facts(self) -> int:
        return self._total

    def select(self, scope: FactScope) -> tuple[DocumentFact, ...]:
        """Every fact this rule scope addresses, in canonical order.

        Matching is structural. The one asymmetry is deliberate: a selector the
        *rule* leaves out means "any". A rule about headings with no level
        covers every heading; a rule naming level 2 covers only level-2
        headings. The reverse is not true — a rule naming a level never matches
        a fact that has none, because the fact simply does not claim to be at
        that level.
        """
        candidates = self._buckets.get(scope.selector_key(), ())
        if not candidates:
            return ()

        return tuple(fact for fact in candidates if _matches(scope, fact.scope))


def _matches(rule_scope: FactScope, fact_scope: FactScope) -> bool:
    if rule_scope.kind is not fact_scope.kind:
        return False

    # The coarse key already agreed on element type and property/field, so only
    # the finer selectors remain.
    if rule_scope.section_key is not None and rule_scope.section_key != fact_scope.section_key:
        return False
    if rule_scope.level is not None and rule_scope.level != fact_scope.level:
        return False
    return not (rule_scope.pages is not None and rule_scope.pages is not fact_scope.pages)
