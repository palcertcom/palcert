/**
 * GENERATED FILE — DO NOT EDIT.
 *
 * Source: contracts/registries/citation-projection.json
 * Regenerate: pnpm --filter @palcert/contracts run generate:evaluation
 *
 * Editing this by hand would reintroduce exactly the drift the generation step
 * exists to prevent.
 */

/** The citation projection registry, embedded verbatim from the source of truth. */
export const CITATION_PROJECTION_REGISTRY = {
  $comment:
    "The Phase 18 deterministic projector allow-list. One table, read by the Python projector and generated into TypeScript for the API, so neither side can decide on its own what citation evidence is allowed to assert.\n\nThe rule this table exists to enforce: the deterministic engine's precedence is FAIL, then INDETERMINATE, then the coverage demotion, then PASS. PARTIAL coverage therefore prevents a false pass and does NOT prevent a false failure — a fact whose value is wrong fails the rule whatever coverage says. So a property may be projected only when BOTH the semantic element identity and the value are deterministically established. Coverage cannot repair a wrong element identity: PARTIAL says 'we did not see everything', never 'what we did see might not be what we called it'.\n\nEverything else Phase 18 observes stays in the citationAnalysis artifact section and is advisory. That is why this list is a handful of rows and not twenty: heuristic reference counts, inferred bibliographic completeness and anything about a rendered reference entry are all excluded, because a rendered entry's identity is established by classification rather than by structure.\n\nVersion 2 records that `referenceRegionPresent` is projectable from PDF as well. It is the only one of the four that is defined without reference to Word's storage — 'a reference region demonstrably exists, proven by structure' — and a PDF proves it with a declared /BibEntry under the identical positive-only rules. The other three are defined in Word-native terms (a CITATION field, a Word source record, a Word citation's tag matched against a source set) and stay DOCX-only: a PDF has none of those things, and projecting a confident zero for a count of them would fail a compliant document for lacking something it cannot have.\n\nVersion 3 adds `citationTargetResolved`, which asks a different question from `nativeSourceResolved` and is deliberately not an alias for it. `nativeSourceResolved` asks whether a Word citation's tag matched a record in a Word source store; this asks whether a declared citation resolves to exactly one declared reference entry in the analyzed document. The two are answerable by different formats for exactly that reason: a DOCX citation graph resolves a CITATION field to a bibliography *source record* and never to a rendered entry, so DOCX answers the first and not the second; a PDF citation graph resolves a declared citation to a declared entry and nothing else, so PDF answers the second and not the first.\n\nVersion 4 opens a second, deliberately separate path: advisory projection. Checkpoints 10 to 14 built heuristic discovery and projected none of it, because the rule above could not be satisfied — a recognized citation's element identity is established by classification, not by structure. That has not changed and these rows do not pretend otherwise. What changed is that the evaluator now refuses to decide on a fact whose provenance is HEURISTIC, so an advisory row can be emitted without the value ever becoming a PASS or a FAIL. An ADVISORY_* row therefore asserts something weaker than any EXACT_* row: 'the detector PalCert has today recognized N of these', a lower bound over the styles it knows, carried to the verdict labelled as such. The two kinds must never be confused, which is why they are different projection kinds and different property names rather than the same row with a flag.",
  registryVersion: 4,
  projectionKinds: {
    $comment:
      'How a row earns the right to produce a verdict. The two ADVISORY_* kinds earn no verdict at all: they carry an observation whose evaluation is always INDETERMINATE, and they exist so a reader can see what PalCert found without the report implying it was proven.',
    values: [
      'EXACT_COUNT',
      'EXACT_ELEMENT_VALUE',
      'EXACT_POSITIVE_MARKER',
      'ADVISORY_COUNT',
      'ADVISORY_POSITIVE_MARKER',
    ],
  },
  coveragePolicies: {
    $comment:
      "Which coverage statuses a row may be emitted under. COMPLETE_OR_UNAVAILABLE is mandatory for a count: a partial count is not a missing value, it is a wrong one — a lower bound wearing the name of an exact number — and a rule such as 'at least twenty references' would fail a compliant document on it. UNAVAILABLE is caught before aggregation and yields INDETERMINATE, which is the honest answer. POSITIVE_ONLY_PARTIAL_OR_UNAVAILABLE marks a fact that is emitted only when true and read with EXISTS: present is a sound PASS, absent under incomplete coverage is INDETERMINATE, and it can never fail on absence. ADVISORY_PARTIAL_ONLY is the only policy an advisory row may carry, and PARTIAL is the only status it may be emitted under. A heuristic population is a lower bound by construction — the detector knows some styles and not others — so COMPLETE would be a claim of exhaustiveness the contract cannot prove, and UNAVAILABLE would be wrong about a scan that was read successfully and simply had nothing recognizable in it.",
    values: [
      'COMPLETE_OR_UNAVAILABLE',
      'COMPLETE_PARTIAL_OR_UNAVAILABLE',
      'POSITIVE_ONLY_PARTIAL_OR_UNAVAILABLE',
      'ADVISORY_PARTIAL_ONLY',
    ],
  },
  units: {
    $comment:
      'The unit a projected value is counted in, stated rather than inferred. A projector must not read COUNT out of a property name: `nativeCitationCount` is a name, and a name is not a contract.',
    values: ['COUNT'],
  },
  properties: [
    {
      $comment:
        'Every Word CITATION field in the defined native story domain. Exhaustively enumerable from markup, so the count is exact rather than a lower bound — which is what lets it carry COMPLETE coverage and answer an ordinary comparison safely.',
      scopeKind: 'DOCUMENT',
      property: 'nativeCitationCount',
      valueKind: 'NUMBER',
      unit: 'COUNT',
      projectionKind: 'EXACT_COUNT',
      coveragePolicy: 'COMPLETE_OR_UNAVAILABLE',
      formats: ['DOCX'],
      evidenceClass: 'EXACT',
    },
    {
      $comment:
        'Word-managed bibliography source records. Exact when every customXml relationship was resolved and classified; a proven-absent source store is a true zero, and a store that could not be read is UNAVAILABLE rather than zero.',
      scopeKind: 'DOCUMENT',
      property: 'nativeBibliographySourceCount',
      valueKind: 'NUMBER',
      unit: 'COUNT',
      projectionKind: 'EXACT_COUNT',
      coveragePolicy: 'COMPLETE_OR_UNAVAILABLE',
      formats: ['DOCX'],
      evidenceClass: 'EXACT',
    },
    {
      $comment:
        "Whether one Word citation's tag matches a record in an exact source set. The element identity is structural — a CITATION field is a citation — and the value is exact string identity, so both directions are sound. Emitted only when the source set itself is exact: if a source store may have been missed, no value is emitted at all rather than a false 'unresolved'.",
      scopeKind: 'ELEMENT',
      elementType: 'CITATION',
      property: 'nativeSourceResolved',
      valueKind: 'BOOLEAN',
      projectionKind: 'EXACT_ELEMENT_VALUE',
      coveragePolicy: 'COMPLETE_PARTIAL_OR_UNAVAILABLE',
      formats: ['DOCX'],
      evidenceClass: 'EXACT',
    },
    {
      $comment:
        'That a reference region demonstrably exists, proven by structure. Emitted only when true and never as false: absence of exact evidence is not evidence of absence, and a manually typed reference list is invisible to this proof. Read with EXISTS it passes on proof and returns INDETERMINATE otherwise, so it can never fail a document for a region PalCert merely did not find. A PDF proves the same thing with a tagged /BibEntry the author declared, so the row carries both formats: the proof differs, the claim is identical, and so is the refusal to emit false.',
      scopeKind: 'DOCUMENT',
      property: 'referenceRegionPresent',
      valueKind: 'BOOLEAN',
      projectionKind: 'EXACT_POSITIVE_MARKER',
      coveragePolicy: 'POSITIVE_ONLY_PARTIAL_OR_UNAVAILABLE',
      formats: ['DOCX', 'PDF'],
      evidenceClass: 'EXACT',
    },
    {
      $comment:
        "Whether one declared citation resolves to exactly one declared reference entry in the same analyzed document. Stated without naming any mechanism: a tag match, a numeric label, an internal destination and a DOI identity are evidence that establishes the relationship, not the relationship itself, and a rule written against this property should not have to know which of them the document happened to provide.\n\nThe value comes from the citation's own resolution, which the producer and the integrity pass have already settled — including when two exact methods disagreed and the citation became AMBIGUOUS. A projector that re-read the link rows would be a second resolution algorithm able to disagree with the first.\n\nAMBIGUOUS and NOT_ATTEMPTED emit nothing: neither is a value, and a citation PalCert could not resolve is not a citation that failed to resolve. Because those emit nothing, the element coverage is COMPLETE only when every citation in scope received a value — otherwise a rule reading the facts that exist would pass a document on the citations PalCert was sure about.",
      scopeKind: 'ELEMENT',
      elementType: 'CITATION',
      property: 'citationTargetResolved',
      valueKind: 'BOOLEAN',
      projectionKind: 'EXACT_ELEMENT_VALUE',
      coveragePolicy: 'COMPLETE_PARTIAL_OR_UNAVAILABLE',
      formats: ['PDF'],
      evidenceClass: 'EXACT',
    },
    {
      $comment:
        'How many in-text citations the current heuristic detector recognized. Counted over HEURISTIC citation objects only, never over the union with declared ones: a number mixing both could not carry a single honest provenance, and the declared ones are already answered exactly by nativeCitationCount. The analyzer has already suppressed any heuristic object overlapping a span the author declared, so the two populations are disjoint and nothing is counted twice.',
      scopeKind: 'DOCUMENT',
      property: 'observedCitationCount',
      valueKind: 'NUMBER',
      unit: 'COUNT',
      projectionKind: 'ADVISORY_COUNT',
      coveragePolicy: 'ADVISORY_PARTIAL_ONLY',
      evidenceClass: 'HEURISTIC',
      formats: ['PDF'],
    },
    {
      $comment:
        'How many reference entries the heuristic segmenter produced, over every region it accepted. Counted the same way and for the same reason as the citation count. Multiple regions contribute their entries to one document-level total, which is a sum of populations rather than a claim that the document has one bibliography — the regions themselves stay in the artifact and are not flattened into a fact.',
      scopeKind: 'DOCUMENT',
      property: 'observedReferenceCount',
      valueKind: 'NUMBER',
      unit: 'COUNT',
      projectionKind: 'ADVISORY_COUNT',
      coveragePolicy: 'ADVISORY_PARTIAL_ONLY',
      evidenceClass: 'HEURISTIC',
      formats: ['PDF'],
    },
    {
      $comment:
        "That PalCert recognized a reference list the author did not declare. Emitted only when true, exactly as the exact marker is and for the identical reason: a list written in a style the detector does not know is invisible to it, so absence of the fact is not evidence of absence of the list. Deliberately a different property from referenceRegionPresent rather than a heuristic value of it — that one means 'proven by structure' and renaming it would make a recognition look like a proof.",
      scopeKind: 'DOCUMENT',
      property: 'observedReferenceRegionPresent',
      valueKind: 'BOOLEAN',
      projectionKind: 'ADVISORY_POSITIVE_MARKER',
      coveragePolicy: 'ADVISORY_PARTIAL_ONLY',
      evidenceClass: 'HEURISTIC',
      formats: ['PDF'],
    },
  ],
  evidenceClasses: {
    $comment:
      'Which evidence a row is allowed to read. EXACT rows read objects the author declared and nothing else; ADVISORY rows read heuristic objects and nothing else. Stated rather than inferred from the projection kind, so a future row cannot quietly mix the two populations into one number — a fact counting both could not honestly carry either provenance.',
    values: ['EXACT', 'HEURISTIC'],
  },
} as const;
