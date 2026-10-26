import { describe, expect, it } from 'vitest';
import { RULE_OPERATORS, RuleOperator, RuleScopeKind } from '../standards/rule-schema.js';
import {
  AMBIGUOUS_TARGET_OPERATORS,
  CAPABILITY_REGISTRY_VERSION,
  CONTENT_CHANGE_OPERATORS,
  DETERMINISTIC_TARGET_OPERATORS,
  FORBIDDEN_ELEMENT_TYPE_REASON,
  FORBIDDEN_FIX_ELEMENT_TYPES,
  SMARTFIX_ENGINE_VERSION,
  SMARTFIX_REASON_CODES,
  SMARTFIX_REFUSAL_CODES,
  SmartFixReasonCode,
} from './constants.js';
import {
  FIX_CAPABILITIES,
  REFUSED_PROPERTY_REASONS,
  REGISTRY_VERSION,
  elementTypeIsFixable,
  fixCapabilityFor,
  operatorHasDeterministicTarget,
  operatorRequiresContentChange,
  refusalReasonFor,
} from './capability.js';
import { SMARTFIX_JSON_SCHEMA } from './schema.generated.js';
import { SMARTFIX_CAPABILITY_REGISTRY } from './registry.generated.js';

/**
 * The SmartFix registry, checked against the schema and the Phase 3 rule
 * vocabulary it has to answer for.
 *
 * The registry decides what PalCert will do to somebody's document. These
 * tests are the guard rail around it: every operator classified exactly once,
 * every action type in the registry known to the schema, and no capability
 * that would edit content rather than formatting.
 */

const schemaEnum = (name: string): readonly string[] =>
  (SMARTFIX_JSON_SCHEMA.$defs as unknown as Record<string, { enum: readonly string[] }>)[name].enum;

describe('operator policy', () => {
  it('classifies every rule operator exactly once', () => {
    const classified = [
      ...DETERMINISTIC_TARGET_OPERATORS,
      ...AMBIGUOUS_TARGET_OPERATORS,
      ...CONTENT_CHANGE_OPERATORS,
    ];
    expect([...classified].sort()).toEqual([...RULE_OPERATORS].sort());
    expect(new Set(classified).size).toBe(classified.length);
  });

  it('treats EXISTS and NOT_EXISTS as content changes, never as fixable', () => {
    // Satisfying EXISTS means writing something the author did not write, and
    // satisfying NOT_EXISTS means deleting something they did.
    expect(operatorRequiresContentChange(RuleOperator.EXISTS)).toBe(true);
    expect(operatorRequiresContentChange(RuleOperator.NOT_EXISTS)).toBe(true);
    expect(operatorHasDeterministicTarget(RuleOperator.EXISTS)).toBe(false);
    expect(operatorHasDeterministicTarget(RuleOperator.NOT_EXISTS)).toBe(false);
  });

  it('refuses to pick a member of a set or a match for a pattern', () => {
    for (const operator of [
      RuleOperator.IN,
      RuleOperator.NOT_IN,
      RuleOperator.CONTAINS,
      RuleOperator.NOT_CONTAINS,
      RuleOperator.MATCHES_PATTERN,
      RuleOperator.NOT_EQUALS,
    ]) {
      expect(operatorHasDeterministicTarget(operator)).toBe(false);
    }
  });

  it('excludes the strict inequalities, whose nearest value nobody declared', () => {
    expect(operatorHasDeterministicTarget(RuleOperator.GREATER_THAN)).toBe(false);
    expect(operatorHasDeterministicTarget(RuleOperator.LESS_THAN)).toBe(false);
    expect(operatorHasDeterministicTarget(RuleOperator.GREATER_THAN_OR_EQUAL)).toBe(true);
    expect(operatorHasDeterministicTarget(RuleOperator.LESS_THAN_OR_EQUAL)).toBe(true);
    expect(operatorHasDeterministicTarget(RuleOperator.BETWEEN)).toBe(true);
  });
});

describe('capability registry', () => {
  it('uses only action types the schema knows', () => {
    const known = new Set(schemaEnum('FixActionType'));
    for (const capability of FIX_CAPABILITIES) {
      expect(known.has(capability.actionType)).toBe(true);
    }
  });

  it('uses only target scopes and script channels the schema knows', () => {
    const scopes = new Set(schemaEnum('FixTargetScope'));
    const channels = new Set(schemaEnum('ScriptChannel'));
    for (const capability of FIX_CAPABILITIES) {
      expect(scopes.has(capability.targetScope)).toBe(true);
      if (capability.scriptChannel !== undefined) {
        expect(channels.has(capability.scriptChannel)).toBe(true);
      }
    }
  });

  it('gives every run-level capability a script channel', () => {
    // Without one the mutator would have to guess between w:sz and w:szCs,
    // and guessing wrong means an Arabic thesis is reported as corrected
    // while nothing on the page changed.
    for (const capability of FIX_CAPABILITIES) {
      if (capability.targetScope === 'RUN_PROPERTIES') {
        expect(capability.scriptChannel).toBeDefined();
      } else {
        expect(capability.scriptChannel).toBeUndefined();
      }
    }
  });

  it('keeps the complex-script properties on their own channel', () => {
    expect(fixCapabilityFor(RuleScopeKind.ELEMENT, 'fontSize', 'PARAGRAPH')?.scriptChannel).toBe(
      'LATIN',
    );
    expect(
      fixCapabilityFor(RuleScopeKind.ELEMENT, 'fontSizeComplexScript', 'PARAGRAPH')?.scriptChannel,
    ).toBe('COMPLEX_SCRIPT');
    expect(
      fixCapabilityFor(RuleScopeKind.ELEMENT, 'boldComplexScript', 'PARAGRAPH')?.scriptChannel,
    ).toBe('COMPLEX_SCRIPT');
  });

  it('names each property under exactly one scope kind', () => {
    const keys = FIX_CAPABILITIES.flatMap((capability) =>
      capability.scopes.map((scope) => `${scope}:${capability.property}`),
    );
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('gives every numeric capability a unit', () => {
    for (const capability of FIX_CAPABILITIES) {
      if (capability.valueKind === 'NUMBER') expect(capability.unit).toBeDefined();
      else expect(capability.unit).toBeUndefined();
    }
  });

  it('contains nothing that would create or delete document content', () => {
    // The vocabulary is closed at the schema, but the registry is where a
    // well-meaning addition would land first.
    for (const capability of FIX_CAPABILITIES) {
      expect(capability.actionType.startsWith('SET_')).toBe(true);
    }
  });
});

describe('refused properties', () => {
  it('never refuses a property it also claims to support', () => {
    for (const capability of FIX_CAPABILITIES) {
      expect(REFUSED_PROPERTY_REASONS[capability.property]).toBeUndefined();
    }
  });

  it('refuses counts and pagination with the reason, not a shrug', () => {
    expect(refusalReasonFor(RuleScopeKind.DOCUMENT, 'wordCount')).toBe(
      SmartFixReasonCode.COUNT_NOT_EDITABLE,
    );
    expect(refusalReasonFor(RuleScopeKind.DOCUMENT, 'sectionCount')).toBe(
      SmartFixReasonCode.PAGINATION_NOT_EDITABLE,
    );
    expect(refusalReasonFor(RuleScopeKind.ELEMENT, 'pageBreakBefore', 'PARAGRAPH')).toBe(
      SmartFixReasonCode.PAGINATION_NOT_EDITABLE,
    );
  });

  it('refuses all metadata, including fields nobody listed', () => {
    expect(refusalReasonFor(RuleScopeKind.METADATA, 'title')).toBe(
      SmartFixReasonCode.METADATA_NOT_SUPPORTED,
    );
    expect(refusalReasonFor(RuleScopeKind.METADATA, 'somethingNew')).toBe(
      SmartFixReasonCode.METADATA_NOT_SUPPORTED,
    );
  });

  it('falls back to PROPERTY_NOT_SUPPORTED for a property it has never met', () => {
    expect(refusalReasonFor(RuleScopeKind.ELEMENT, 'invented', 'PARAGRAPH')).toBe(
      SmartFixReasonCode.PROPERTY_NOT_SUPPORTED,
    );
  });

  it('declares exactly the vocabulary the registry publishes', () => {
    // The named constants and the registry list are two readings of one
    // vocabulary. If they diverge, the planner can emit a code the UI has no
    // translation for, and the user is shown a machine string about their
    // thesis.
    expect([...Object.values(SmartFixReasonCode)].sort()).toEqual(
      [...SMARTFIX_REASON_CODES].sort(),
    );
  });

  it('uses only reason codes the vocabulary declares', () => {
    for (const code of Object.values(REFUSED_PROPERTY_REASONS)) {
      expect(SMARTFIX_REASON_CODES).toContain(code);
    }
  });
});

/**
 * The element-type guard (Phase 18 Checkpoint 1).
 *
 * Capability matching is `(scope kind, property)` and is blind to element
 * type, so nothing in the capability table stops a formatting fix being
 * applied to a citation once Phase 18 starts emitting ELEMENT/CITATION and
 * ELEMENT/REFERENCE_ENTRY facts. This axis is what stops it, and these tests
 * pin it in the TypeScript reading so the API cannot show a user a plan the
 * Python planner will refuse.
 */
describe('element-type policy', () => {
  it('forbids exactly the citation and reference element types', () => {
    expect([...FORBIDDEN_FIX_ELEMENT_TYPES].sort()).toEqual(['CITATION', 'REFERENCE_ENTRY']);
  });

  it('declares a reason code the vocabulary knows', () => {
    expect(SMARTFIX_REASON_CODES).toContain(FORBIDDEN_ELEMENT_TYPE_REASON);
    expect(FORBIDDEN_ELEMENT_TYPE_REASON).toBe(SmartFixReasonCode.ELEMENT_TYPE_NOT_EDITABLE);
  });

  it('refuses a forbidden element type', () => {
    expect(elementTypeIsFixable('CITATION')).toBe(false);
    expect(elementTypeIsFixable('REFERENCE_ENTRY')).toBe(false);
  });

  it('refuses an absent element type, rather than assuming a paragraph', () => {
    // An unnamed element type is not a permission. Falling through to a
    // generic capability would be the same hole with no name on it.
    expect(elementTypeIsFixable(undefined)).toBe(false);
  });

  it('leaves an ordinary element type alone', () => {
    expect(elementTypeIsFixable('PARAGRAPH')).toBe(true);
    expect(elementTypeIsFixable('HEADING')).toBe(true);
  });

  it('yields no capability for a forbidden element type, whatever the property', () => {
    for (const elementType of FORBIDDEN_FIX_ELEMENT_TYPES) {
      for (const property of ['lineSpacing', 'fontSize', 'indentStart', 'hangingIndent']) {
        expect(fixCapabilityFor(RuleScopeKind.ELEMENT, property, elementType)).toBeUndefined();
      }
    }
  });

  it('yields no capability when the element type is missing', () => {
    expect(fixCapabilityFor(RuleScopeKind.ELEMENT, 'lineSpacing')).toBeUndefined();
  });

  it('still answers for an ordinary element type', () => {
    // The guard is about the rule's element identity, not about the property.
    expect(fixCapabilityFor(RuleScopeKind.ELEMENT, 'lineSpacing', 'PARAGRAPH')).toBeDefined();
  });

  it('does not disturb DOCUMENT-scope lookups', () => {
    expect(fixCapabilityFor(RuleScopeKind.DOCUMENT, 'marginTop')).toBeDefined();
  });

  it('explains a refusal by the element, not by the property', () => {
    // "SmartFix cannot change this setting" would be false: the setting is
    // supported, the element is not.
    expect(refusalReasonFor(RuleScopeKind.ELEMENT, 'lineSpacing', 'REFERENCE_ENTRY')).toBe(
      SmartFixReasonCode.ELEMENT_TYPE_NOT_EDITABLE,
    );
    expect(refusalReasonFor(RuleScopeKind.ELEMENT, 'lineSpacing')).toBe(
      SmartFixReasonCode.ELEMENT_TYPE_NOT_EDITABLE,
    );
    expect(refusalReasonFor(RuleScopeKind.ELEMENT, 'invented', 'PARAGRAPH')).toBe(
      SmartFixReasonCode.PROPERTY_NOT_SUPPORTED,
    );
  });

  it('never forbids an element type through a capability row instead', () => {
    // The two axes stay separate: a capability names properties and scopes,
    // never element types, so the guard cannot be bypassed by editing a row.
    for (const capability of FIX_CAPABILITIES) {
      expect(Object.keys(capability)).not.toContain('elementTypes');
    }
  });
});

describe('versions', () => {
  it('reads one registry version, not two', () => {
    expect(REGISTRY_VERSION).toBe(CAPABILITY_REGISTRY_VERSION);
  });

  it('is at registry version 2, which is what the element-type policy cost', () => {
    // The mutation path refuses a plan stamped with a different registry
    // version, so this number is the boundary between two capability
    // policies: version 1 could edit any element a rule named, version 2
    // cannot touch a citation or a reference entry. Python pins the same
    // number against the same file.
    expect(CAPABILITY_REGISTRY_VERSION).toBe(2);
    expect(SMARTFIX_CAPABILITY_REGISTRY.registryVersion).toBe(CAPABILITY_REGISTRY_VERSION);
  });

  it('left the engine, plan and manifest versions alone', () => {
    // Narrowing what SmartFix may touch changed no mutation byte and no plan
    // shape. Bumping these too would invalidate stored plans and manifests
    // for a change that does not affect them.
    expect(SMARTFIX_ENGINE_VERSION).toBe('1.0.0');
    expect(SMARTFIX_CAPABILITY_REGISTRY.planSchemaVersion).toBe(1);
    expect(SMARTFIX_CAPABILITY_REGISTRY.manifestSchemaVersion).toBe(1);
  });

  it('stamps a semantic engine version the schema accepts', () => {
    expect(SMARTFIX_ENGINE_VERSION).toMatch(/^[0-9]+\.[0-9]+\.[0-9]+$/);
  });

  it('declares every refusal code the schema allows', () => {
    const fromSchema = (
      SMARTFIX_JSON_SCHEMA.$defs.SmartFixPlan.properties.refusal.properties.code as {
        enum: readonly string[];
      }
    ).enum;
    expect([...SMARTFIX_REFUSAL_CODES].sort()).toEqual([...fromSchema].sort());
  });
});
