import { Injectable } from '@nestjs/common';
import {
  AutomationSupport,
  ProposalConflictStatus,
  ProposalValidationStatus,
  RuleProposalKind,
  proposalRequiresRuleDefinition,
  validateRuleDefinition,
  type ProposalValidationIssueView,
  type RuleDefinition,
  type RuleScope,
} from '@palcert/contracts';

/**
 * PalCert's own verdict on what the model proposed (§50, §51, §52, §58, §59).
 *
 * The provider's structured output constrains the *shape*. This is where
 * PalCert decides whether the content is a rule it would have accepted from a
 * human — using the same validator, at the same schema version, with no
 * allowance made for the fact that a model wrote it. AI gets no validation
 * bypass, and the one place a bypass could hide is here.
 *
 * Three separate judgements, kept separate because they answer different
 * questions and a reviewer needs all three:
 *
 *   - **Is it a valid rule?** The Phase 3 validator decides.
 *   - **Can PalCert measure it?** The analyzer's catalogue decides, and the
 *     answer may be "no" for a requirement that is nonetheless real (§53).
 *   - **Does it collide with something?** The draft's existing rules decide.
 */

export interface PropertySupport {
  readonly name: string;
  readonly scopes: readonly string[];
  readonly exactness: 'EXACT' | 'DERIVED';
}

export interface ExistingRule {
  readonly id: string;
  readonly ruleCode: string;
  readonly scopeKey: string;
  readonly operator: string;
  readonly expectedValue: unknown;
}

export interface ProposalValidationResult {
  readonly status: ProposalValidationStatus;
  readonly issues: readonly ProposalValidationIssueView[];
  /** The definition as validated, when it validated. */
  readonly definition: RuleDefinition | null;
}

export interface ConflictResult {
  readonly status: ProposalConflictStatus;
  readonly existingRuleId: string | null;
  readonly existingRuleCode: string | null;
  readonly detail: string | null;
}

@Injectable()
export class ProposalValidationService {
  /**
   * Validate a proposed rule against the target draft's own schema version.
   *
   * Judged by the version of the draft it would be added to, not by whatever
   * this release ships — exactly as a hand-written rule is (Phase 3). A rule
   * that fails is recorded as an INVALID_PROPOSAL with its issues, never
   * silently dropped and never quietly corrected: the reviewer is the one who
   * gets to decide what to do about a proposal PalCert cannot accept (§59).
   */
  validate(
    kind: RuleProposalKind,
    suggested: unknown,
    ruleSchemaVersion: number,
  ): ProposalValidationResult {
    if (!proposalRequiresRuleDefinition(kind)) {
      // An ambiguous, conflicting or unrepresentable proposal carries no rule
      // by design. Its absence is correct, not a validation failure.
      return { status: ProposalValidationStatus.NOT_APPLICABLE, issues: [], definition: null };
    }
    if (suggested === null || typeof suggested !== 'object') {
      return {
        status: ProposalValidationStatus.INVALID,
        issues: [{ path: '/suggestedRule', message: 'no rule definition was proposed' }],
        definition: null,
      };
    }

    // displayOrder is PalCert's, not the model's: where a rule sits in a report
    // is an editorial decision about the standard as a whole.
    const candidate = { ...(suggested as Record<string, unknown>), displayOrder: 0 };
    const result = validateRuleDefinition(candidate, { schemaVersion: ruleSchemaVersion });
    if (!result.valid) {
      return {
        status: ProposalValidationStatus.INVALID,
        issues: result.issues.map((issue) => ({ path: issue.path, message: issue.message })),
        definition: null,
      };
    }
    // Valid by the same validator a hand-written rule passes, at the same
    // version. The candidate is the definition; the validator proved it.
    return {
      status: ProposalValidationStatus.VALID,
      issues: [],
      definition: candidate as unknown as RuleDefinition,
    };
  }

  /**
   * Whether PalCert can measure this rule today (§52, §53).
   *
   * Derived from the analyzer's own catalogue, never from the model's opinion
   * of its own proposal. A requirement PalCert cannot check is still a
   * requirement, and saying so plainly is more useful than dropping it.
   */
  automationSupport(
    definition: RuleDefinition | null,
    catalogue: readonly PropertySupport[],
  ): AutomationSupport {
    if (definition === null) return AutomationSupport.NOT_APPLICABLE;
    if (definition.evaluationMode !== 'DETERMINISTIC') {
      // An AI-assisted or manual rule is not measured by the analyzer at all,
      // so its property coverage is not the question being asked.
      return AutomationSupport.NOT_APPLICABLE;
    }

    const property = propertyOf(definition.scope);
    if (property === null) return AutomationSupport.NOT_CURRENTLY_MEASURABLE;

    const entry = catalogue.find((item) => item.name === property);
    if (entry === undefined) return AutomationSupport.NOT_CURRENTLY_MEASURABLE;
    if (!entry.scopes.includes(definition.scope.kind)) {
      // The analyzer emits this property, but not for this kind of scope: a
      // partial answer, and saying "supported" would be a lie by omission.
      return AutomationSupport.PARTIAL_DOCX;
    }
    // A derived value is computed under a documented definition rather than
    // read straight from OOXML, which is a weaker claim and is labelled as one.
    return entry.exactness === 'EXACT'
      ? AutomationSupport.SUPPORTED_DOCX
      : AutomationSupport.PARTIAL_DOCX;
  }

  /**
   * Whether a proposal collides with the draft as it stands (§61).
   *
   * Deterministic checks only: a duplicate rule code and a same-scope rule with
   * a different expectation are both decidable by comparing structure, and a
   * structural answer is one a reviewer can verify.
   */
  conflictWithExisting(
    definition: RuleDefinition | null,
    existing: readonly ExistingRule[],
  ): ConflictResult {
    if (definition === null) return none();

    const byCode = existing.find((rule) => rule.ruleCode === definition.ruleCode);
    if (byCode !== undefined) {
      return {
        status: ProposalConflictStatus.EXISTING_RULE_CODE,
        existingRuleId: byCode.id,
        existingRuleCode: byCode.ruleCode,
        detail: 'A rule in this draft already uses that code.',
      };
    }

    const scope = scopeKeyOf(definition.scope);
    const sameScope = existing.find((rule) => rule.scopeKey === scope);
    if (sameScope === undefined) return none();

    const sameExpectation =
      sameScope.operator === definition.operator &&
      JSON.stringify(sameScope.expectedValue) === JSON.stringify(definition.expected);
    if (sameExpectation) {
      return {
        status: ProposalConflictStatus.EXISTING_RULE_CODE,
        existingRuleId: sameScope.id,
        existingRuleCode: sameScope.ruleCode,
        detail: 'A rule in this draft already measures the same thing the same way.',
      };
    }

    return {
      status: ProposalConflictStatus.EXISTING_RULE_EXPECTATION,
      existingRuleId: sameScope.id,
      existingRuleCode: sameScope.ruleCode,
      detail: 'A rule in this draft measures the same thing but expects something else.',
    };
  }

  /**
   * Cross-source disagreement between two proposals in the same run (§62, §63).
   *
   * PalCert does not choose. Newest upload does not win, PDF does not win, the
   * template does not win, and the first source does not win — because none of
   * those is a statement about which document the institution considers
   * authoritative. Both proposals are marked CONFLICTING and a person decides.
   */
  findCrossSourceConflicts(
    proposals: readonly {
      readonly key: string;
      readonly definition: RuleDefinition | null;
      readonly sourceAssetIds: readonly string[];
    }[],
  ): ReadonlyMap<string, readonly string[]> {
    const byScope = new Map<
      string,
      { key: string; definition: RuleDefinition; sources: readonly string[] }[]
    >();
    for (const proposal of proposals) {
      if (proposal.definition === null) continue;
      const scope = scopeKeyOf(proposal.definition.scope);
      const bucket = byScope.get(scope) ?? [];
      bucket.push({
        key: proposal.key,
        definition: proposal.definition,
        sources: proposal.sourceAssetIds,
      });
      byScope.set(scope, bucket);
    }

    const conflicts = new Map<string, string[]>();
    for (const bucket of byScope.values()) {
      if (bucket.length < 2) continue;
      for (const left of bucket) {
        for (const right of bucket) {
          if (left.key === right.key) continue;
          const sameExpectation =
            left.definition.operator === right.definition.operator &&
            JSON.stringify(left.definition.expected) === JSON.stringify(right.definition.expected);
          // Two sources agreeing is not a conflict; it is corroboration, and
          // useful provenance (§91).
          if (sameExpectation) continue;
          // A document disagreeing with itself is a defect in that document,
          // not a conflict between authorities — but it is still a conflict a
          // person must resolve, so it is reported either way.
          const related = conflicts.get(left.key) ?? [];
          if (!related.includes(right.key)) related.push(right.key);
          conflicts.set(left.key, related);
        }
      }
    }
    return conflicts;
  }
}

/**
 * A rule's canonical scope key.
 *
 * Structural, never parsed from a rule code: `BODY.FONT.SIZE` is a label a
 * human chose and two institutions will spell it differently (ADR-0026).
 */
export function scopeKeyOf(scope: RuleScope): string {
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

function propertyOf(scope: RuleScope): string | null {
  if (scope.kind === 'METADATA') return scope.field;
  if ('property' in scope) return scope.property;
  return null;
}

function none(): ConflictResult {
  return {
    status: ProposalConflictStatus.NONE,
    existingRuleId: null,
    existingRuleCode: null,
    detail: null,
  };
}
