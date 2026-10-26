# ADR-0130: The bibliography source store is found by its root element

- **Status:** Accepted
- **Date:** 2026-09-19
- **Phase:** 18

## Context

Word keeps the sources an author entered in its source manager as a **custom
XML part** inside the package. Two things about that are easy to get wrong, and
both produce an analyzer that is confidently wrong rather than obviously
broken.

First, there is no bibliography relationship type. The part arrives under an
ordinary `customXml` relationship — the same kind any other custom XML in the
document arrives under. Speaking of "the bibliography relationship" invites a
lookup that cannot exist, and an implementation written to that phrase will
either invent a relationship type no producer writes or silently fall through
to a path.

Second, `customXml/item1.xml` is a convention Word happens to follow. It is not
part of OPC, other producers do not follow it, and Word itself writes
`item2.xml` the moment a document already carries custom XML from somewhere
else. A hard-coded path finds nothing in a perfectly ordinary document and
reports zero sources with complete coverage — a number that is wrong, under a
coverage value that says it is not.

A document may also carry several custom XML parts, of which none, one or more
than one is a source store, and any of them may fail to parse.

## Decision

**Every `customXml` relationship of the main document is resolved, and each
resolved part's root element is read. A part whose root is `Sources` in
`http://schemas.microsoft.com/office/word/2004/10/bibliography` is the
bibliography source store. Nothing else identifies it.**

Not the relationship type, which is `customXml` and says nothing. Not the part
name, which is the producer's choice. Not the content type, which is generic
XML. The element says what it is, and the element is what is believed.

The discovery outcome is then reported as coverage rather than resolved by
preference:

| What discovery found | Source count | Coverage |
| --- | --- | --- |
| Exactly one store, read completely | the records in it | `COMPLETE` |
| No custom XML part is a store | zero | `COMPLETE` — proven absent is a true zero |
| More than one store | none | `UNAVAILABLE` |
| A part that would not parse | none | `UNAVAILABLE` |

Two stores are not summed and not ranked. There is no answer to "which store do
this document's citations resolve against", so the honest report is that there
is no count — and native source resolution is not attempted at all, because a
citation checked against half a source set produces a false "unresolved".

## Consequences

The analyzer reads one extra part per custom XML relationship, bounded by the
same limits as every other part, and classifies it by a single tag comparison.

A document whose source store is at an unconventional path is read correctly.
A document carrying unrelated custom XML — a content-type control, a form data
store, a third-party add-in's data — is unaffected: its parts are peeked at and
left alone.

The failure modes that remain are all visible in coverage. None of them
produces a number that looks exact and is not, which is the property that
matters: the native source count is one of the four values Phase 18 permits to
become a deterministic fact, and a fact whose value is wrong fails a rule
whatever its coverage says.
