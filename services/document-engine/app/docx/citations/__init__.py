"""Word-native citation evidence (Phase 18, Checkpoint 3).

The producer side of the Checkpoint-2 contracts. It reads what Word actually
stores — ``CITATION`` fields, the bibliography source store, a
``BIBLIOGRAPHY`` field's rendered result — and nothing else: there is no
pattern matching over prose here, no classifier, and no network.

What it produces is the artifact's ``citationAnalysis`` section, which is
**advisory**. Nothing in it is read by the rule engine. Evidence becomes
authority only by being projected into a fact through the Phase 18 projector
allow-list, and no projector exists yet.
"""
