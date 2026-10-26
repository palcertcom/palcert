"""Outcome, evidence and reason vocabularies.

Mirrors ``contracts/schemas/evaluation.schema.json``; the cross-language tests
assert the two agree, so a member added to one and not the other fails CI.
"""

from __future__ import annotations

from enum import StrEnum


class Outcome(StrEnum):
    """What the engine concluded.

    The two distinctions that matter most:

    * ``INDETERMINATE`` is never a disguised PASS. Missing evidence means we do
      not know, and reporting compliance for something never examined is the
      single worst failure mode this engine could have.
    * ``ERROR`` is never a disguised FAIL. An evaluator that crashed has said
      nothing about the document, and turning that into a violation would
      accuse an author of a defect the engine invented.
    """

    PASS = "PASS"  # noqa: S105 - an outcome name, not a secret
    FAIL = "FAIL"
    NOT_APPLICABLE = "NOT_APPLICABLE"
    INDETERMINATE = "INDETERMINATE"
    ERROR = "ERROR"


class EvidenceLevel(StrEnum):
    """What kind of evidence produced a result.

    Present from Phase 4 so that a later phase could add a non-authoritative
    evidence class without redesigning the result. Phase 18 is the phase that
    needed it.

    ``ADVISORY`` marks a rule whose facts PalCert *recognized* rather than
    *read*. Such a rule is always ``INDETERMINATE``: the observation is
    reported so a reader can see it, and it never becomes the PASS or FAIL an
    exact rule produces. ``DETERMINISTIC`` therefore keeps its original meaning
    exactly — every fact behind the verdict came out of the document's own
    markup or geometry — which is the property the certificate gate depends on.
    """

    NONE = "NONE"
    DETERMINISTIC = "DETERMINISTIC"
    ADVISORY = "ADVISORY"
    AI_PROVISIONAL = "AI_PROVISIONAL"
    HUMAN_CONFIRMED = "HUMAN_CONFIRMED"


class ReasonCode(StrEnum):
    """Why the engine concluded what it did.

    Stable and machine-readable. Downstream code must never parse English
    message text — the report and AI layers turn these into prose, and they
    need something they can switch on.
    """

    SATISFIED = "SATISFIED"

    VALUE_MISMATCH = "VALUE_MISMATCH"
    OUTSIDE_TOLERANCE = "OUTSIDE_TOLERANCE"
    BELOW_MINIMUM = "BELOW_MINIMUM"
    ABOVE_MAXIMUM = "ABOVE_MAXIMUM"
    OUTSIDE_RANGE = "OUTSIDE_RANGE"
    REQUIRED_VALUE_MISSING = "REQUIRED_VALUE_MISSING"
    FORBIDDEN_VALUE_PRESENT = "FORBIDDEN_VALUE_PRESENT"
    PATTERN_MISMATCH = "PATTERN_MISMATCH"
    NOT_IN_ALLOWED_SET = "NOT_IN_ALLOWED_SET"
    IN_FORBIDDEN_SET = "IN_FORBIDDEN_SET"

    NO_COMPLETE_EVIDENCE = "NO_COMPLETE_EVIDENCE"
    NO_MATCHING_FACTS = "NO_MATCHING_FACTS"
    SCOPE_NOT_PRESENT = "SCOPE_NOT_PRESENT"

    UNIT_INCOMPATIBLE = "UNIT_INCOMPATIBLE"
    UNIT_MISSING = "UNIT_MISSING"
    VALUE_TYPE_INCOMPATIBLE = "VALUE_TYPE_INCOMPATIBLE"

    EVALUATOR_NOT_SUPPORTED = "EVALUATOR_NOT_SUPPORTED"
    AI_REVIEW_REQUIRED = "AI_REVIEW_REQUIRED"
    MANUAL_REVIEW_REQUIRED = "MANUAL_REVIEW_REQUIRED"
    FACT_SCHEMA_UNSUPPORTED = "FACT_SCHEMA_UNSUPPORTED"
    RULE_SCHEMA_UNSUPPORTED = "RULE_SCHEMA_UNSUPPORTED"
    RESOURCE_LIMIT_EXCEEDED = "RESOURCE_LIMIT_EXCEEDED"
    #: The rule matched facts PalCert inferred rather than read. A statement
    #: about the evidence class and never about the document: it does not mean
    #: the document is wrong, and it does not mean the document is right.
    ADVISORY_EVIDENCE_ONLY = "ADVISORY_EVIDENCE_ONLY"
    INTERNAL_ERROR = "INTERNAL_ERROR"


class EvaluationMode(StrEnum):
    DETERMINISTIC = "DETERMINISTIC"
    AI_ASSISTED = "AI_ASSISTED"
    MANUAL = "MANUAL"


class Severity(StrEnum):
    INFO = "INFO"
    MINOR = "MINOR"
    MAJOR = "MAJOR"
    CRITICAL = "CRITICAL"
