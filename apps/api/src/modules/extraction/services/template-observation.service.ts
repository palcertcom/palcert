import { Injectable } from '@nestjs/common';
import {
  ObservationUniformity,
  classifyUniformity,
  computeObservationHash,
  type DocumentFact,
  type DocumentFactSet,
  type FactScope,
  type RuleScope,
} from '@palcert/contracts';

/**
 * Deterministic template observations (§31, §32, §33, §34).
 *
 * A template is a model document, not a statement of policy. PalCert already
 * knows exactly what a DOCX does — the Phase 6 analyzer measured it — so asking
 * a model "what formatting does this document use?" would replace an exact
 * answer with a guess, and pay for the privilege.
 *
 * So this engine reads the fact set and counts. Nothing here is an opinion:
 * "187 of 196 body paragraphs are 12 pt, 5 are 11 pt, 4 are 14 pt" is a
 * measurement, and it is deliberately reported as one. A reviewer reading that
 * can tell the difference between a template that has settled on a value and
 * one that has not — which is exactly the difference a confidence score would
 * have hidden (§34).
 *
 * The engine never decides that an observation is a requirement. That is the
 * institution's decision, and Phase 9's whole safety argument rests on not
 * making it for them (§4).
 */

export interface TemplateObservationInput {
  readonly factSet: DocumentFactSet;
  readonly sourceAssetId: string;
  readonly sourceSha256: string;
  readonly maxObservations: number;
  readonly maxDistributionEntries?: number;
}

export interface ObservedValue {
  readonly value: string;
  readonly count: number;
}

export interface TemplateObservation {
  readonly scopeKey: string;
  readonly scope: RuleScope;
  readonly property: string;
  readonly unit: string | null;
  readonly modalValue: string | null;
  readonly occurrenceCount: number;
  readonly matchingCount: number;
  readonly distinctValueCount: number;
  readonly uniformity: ObservationUniformity;
  readonly distribution: readonly ObservedValue[];
  readonly observationHash: string;
}

/** The top few values are enough to judge consistency; the tail is noise (§135). */
const DEFAULT_DISTRIBUTION_ENTRIES = 5;

@Injectable()
export class TemplateObservationEngine {
  /**
   * Every property the template is consistent enough to be worth discussing.
   *
   * Ordered by scope key so two runs over the same template produce the same
   * list in the same order — which is what makes the run hash reproducible and
   * the tests deterministic (§161).
   */
  observe(input: TemplateObservationInput): readonly TemplateObservation[] {
    const groups = new Map<
      string,
      { scope: FactScope; unit: string | null; values: Map<string, number> }
    >();

    for (const fact of input.factSet.facts) {
      const value = comparableValue(fact);
      if (value === null) continue;

      const key = scopeKey(fact.scope);
      const existing = groups.get(key);
      if (existing === undefined) {
        groups.set(key, {
          scope: fact.scope,
          unit: fact.unit ?? null,
          values: new Map([[value, 1]]),
        });
        continue;
      }
      // A property measured in two different units is not one distribution.
      // Recording it as one would average millimetres with points.
      if ((fact.unit ?? null) !== existing.unit) continue;
      existing.values.set(value, (existing.values.get(value) ?? 0) + 1);
    }

    const limit = input.maxDistributionEntries ?? DEFAULT_DISTRIBUTION_ENTRIES;
    const observations: TemplateObservation[] = [];

    for (const [key, group] of [...groups.entries()].sort((left, right) =>
      left[0] < right[0] ? -1 : left[0] > right[0] ? 1 : 0,
    )) {
      const distribution = [...group.values.entries()]
        .map(([value, count]) => ({ value, count }))
        // Count first, then value, so ties resolve the same way every time
        // rather than by whichever the analyzer emitted first.
        .sort((left, right) =>
          right.count !== left.count ? right.count - left.count : left.value < right.value ? -1 : 1,
        );

      const occurrenceCount = distribution.reduce((sum, entry) => sum + entry.count, 0);
      const modal = distribution[0] ?? null;
      const matchingCount = modal?.count ?? 0;
      const uniformity = classifyUniformity(occurrenceCount, matchingCount);

      const property = propertyOf(group.scope);
      if (property === null) continue;

      observations.push({
        scopeKey: key,
        scope: group.scope as unknown as RuleScope,
        property,
        unit: group.unit,
        modalValue: modal?.value ?? null,
        occurrenceCount,
        matchingCount,
        distinctValueCount: distribution.length,
        uniformity,
        distribution: distribution.slice(0, limit),
        observationHash: computeObservationHash({
          sourceAssetId: input.sourceAssetId,
          sourceSha256: input.sourceSha256,
          scopeKey: key,
          modalValue: modal?.value ?? null,
          unit: group.unit,
          occurrenceCount,
          matchingCount,
          distinctValueCount: distribution.length,
        }),
      });
    }

    // Consistent observations first: a template that has settled on a value is
    // the useful signal, and a MIXED one is mostly useful as an explanation of
    // why PalCert is not proposing anything (§33).
    return observations
      .sort((left, right) => rank(left.uniformity) - rank(right.uniformity))
      .slice(0, input.maxObservations);
  }
}

/**
 * The canonical grouping key for one measured property.
 *
 * Built from the scope's identifying fields rather than by parsing a rule code:
 * `BODY.FONT.SIZE` is a label a human chose, and matching on it would break the
 * first time someone named a rule differently (ADR-0026).
 */
export function scopeKey(scope: FactScope): string {
  switch (scope.kind) {
    case 'DOCUMENT':
      return `DOCUMENT::${scope.property}`;
    case 'SECTION':
      return `SECTION:${scope.sectionKey}:${scope.property}`;
    case 'ELEMENT':
      return `ELEMENT:${scope.elementType}${scope.level === undefined ? '' : `#${scope.level}`}:${scope.property}`;
    case 'METADATA':
      return `METADATA::${scope.field}`;
    case 'PAGE':
      return `PAGE:${scope.pages}:${scope.property}`;
    default:
      return 'UNKNOWN::unknown';
  }
}

function propertyOf(scope: FactScope): string | null {
  if (scope.kind === 'METADATA') return scope.field;
  if ('property' in scope) return scope.property;
  return null;
}

/**
 * One fact's value as an exact comparable string.
 *
 * Numbers stay decimal strings — they arrive as decimal strings precisely so
 * nothing ever compares them as binary floats (ADR-0027). Composite values are
 * skipped: no Phase 4 operator consumes them, so counting them would produce a
 * distribution nothing could act on.
 */
function comparableValue(fact: DocumentFact): string | null {
  const value = fact.value;
  switch (value.type) {
    case 'NUMBER':
      return value.number;
    case 'STRING':
      return value.text;
    case 'BOOLEAN':
      return value.boolean ? 'true' : 'false';
    case 'ENUM':
      return value.enumValue;
    default:
      return null;
  }
}

function rank(uniformity: ObservationUniformity): number {
  switch (uniformity) {
    case ObservationUniformity.UNIFORM:
      return 0;
    case ObservationUniformity.MOSTLY_UNIFORM:
      return 1;
    case ObservationUniformity.MIXED:
      return 2;
    default:
      return 3;
  }
}
