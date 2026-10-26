"""PalCert deterministic rule engine.

A pure library. It has no HTTP server, no database, no cache and no object
storage, which is what makes thousands of deterministic tests cheap enough to
be worth writing.

Layout mirrors the pipeline it implements:

    contracts/  the shared wire contracts and their validation
    units/      the unit registry and exact conversion
    facts/      the normalized fact set, indexing and selection
    rules/      operator evaluators and the pattern registry
    evaluation/ orchestration, outcomes and results
"""
