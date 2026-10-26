"""Engine resource limits.

Facts and rules are untrusted structured data at a service boundary. A later
phase will accept them from a document-processing job whose input a user
supplied, so every unbounded dimension gets a ceiling here rather than a
comment saying it should.

Two different behaviours, deliberately:

* Exceeding an **input** limit raises :class:`ResourceLimitExceededError`. The
  request is refused; silently evaluating the first thousand of a million facts
  would produce a verdict about a document nobody submitted.
* Exceeding the **violation** limit truncates the returned list while keeping
  the count exact. A document with 40,000 identically wrong paragraphs has
  genuinely failed 40,000 times, and the report should say so — it just must
  not serialize 40,000 objects to do it.
"""

from __future__ import annotations

from dataclasses import dataclass


class ResourceLimitExceededError(Exception):
    """An input exceeded a configured engine limit.

    A typed error, not a truncation: the caller must decide what to do about a
    request too large to answer, and that decision does not belong to the
    evaluator.
    """

    def __init__(self, limit_name: str, limit: int, actual: int) -> None:
        self.limit_name = limit_name
        self.limit = limit
        self.actual = actual
        super().__init__(f"{limit_name} limit exceeded: {actual} exceeds the maximum of {limit}.")


@dataclass(frozen=True, slots=True)
class EvaluationLimits:
    """Ceilings for one evaluation.

    The defaults are generous for a real document — a 400-page thesis produces
    on the order of tens of thousands of facts — and small enough that a
    hostile payload cannot exhaust memory.
    """

    max_rules: int = 1000
    max_facts: int = 100_000
    max_coverage_entries: int = 500
    max_returned_violations_per_rule: int = 100
    max_returned_violations_total: int = 5000
    max_string_length: int = 10_000
    max_list_items: int = 1000

    def check_rule_count(self, count: int) -> None:
        if count > self.max_rules:
            raise ResourceLimitExceededError("rules", self.max_rules, count)

    def check_fact_count(self, count: int) -> None:
        if count > self.max_facts:
            raise ResourceLimitExceededError("facts", self.max_facts, count)

    def check_coverage_count(self, count: int) -> None:
        if count > self.max_coverage_entries:
            raise ResourceLimitExceededError("coverage entries", self.max_coverage_entries, count)

    def check_string_length(self, length: int) -> None:
        if length > self.max_string_length:
            raise ResourceLimitExceededError("string length", self.max_string_length, length)

    def check_list_length(self, length: int) -> None:
        if length > self.max_list_items:
            raise ResourceLimitExceededError("list items", self.max_list_items, length)
