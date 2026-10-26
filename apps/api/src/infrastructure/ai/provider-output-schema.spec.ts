import { AI_ASSESSMENT_JSON_SCHEMA, RULE_PROPOSAL_JSON_SCHEMA } from '@palcert/contracts';
import {
  providerOutputFormat,
  unsupportedKeywords,
  type JsonSchema,
} from './provider-output-schema';

/**
 * What PalCert sends as `output_config.format` (the real `400 INVALID_REQUEST`).
 *
 * PalCert's rule-proposal schema is its contract and deliberately carries
 * `minLength`, `pattern`, numeric bounds and `maxItems`. Anthropic's
 * structured-output grammar rejects every one of them, so sending the schema
 * raw failed every extraction before the model read a word.
 */

const RAW = RULE_PROPOSAL_JSON_SCHEMA as unknown as JsonSchema;

/** Every node in a schema, walked structurally. */
function nodes(schema: unknown, visit: (node: JsonSchema, path: string) => void, path = '$'): void {
  if (schema === null || typeof schema !== 'object' || Array.isArray(schema)) return;
  const node = schema as JsonSchema;
  visit(node, path);
  for (const key of ['properties', '$defs']) {
    const map = node[key] as JsonSchema | undefined;
    if (map !== undefined) {
      for (const [name, child] of Object.entries(map))
        nodes(child, visit, `${path}.${key}.${name}`);
    }
  }
  for (const key of ['items', 'anyOf', 'oneOf', 'allOf']) {
    const child = node[key];
    if (Array.isArray(child))
      child.forEach((entry, i) => nodes(entry, visit, `${path}.${key}[${i}]`));
    else if (child !== undefined) nodes(child, visit, `${path}.${key}`);
  }
}

describe('the rule-proposal schema, as PalCert defines it', () => {
  it('carries constraints the provider cannot compile', () => {
    const found = unsupportedKeywords(RAW);
    const keywords = new Set(found.map((path) => path.split('.').pop()));
    for (const keyword of ['minLength', 'maxLength', 'pattern', 'minimum', 'maximum', 'maxItems']) {
      expect(keywords).toContain(keyword);
    }
    // e.g. a proposal key's shape and a heading level's range.
    expect(found).toContain('$.$defs.ProposalKey.pattern');
    expect(found).toContain('$.$defs.Prose.minLength');
  });

  it('writes its closed vocabularies as type-less enums, which the SDK helper refuses', () => {
    expect((RAW.$defs as Record<string, JsonSchema>).RuleSeverity).toEqual({
      enum: ['CRITICAL', 'MAJOR', 'MINOR', 'INFO'],
    });
  });

  it('names a property "pattern", which is a name and not the keyword', () => {
    // The structural walk must not mistake it for a regular expression.
    expect(unsupportedKeywords(RAW).some((path) => path.endsWith('.properties.pattern'))).toBe(
      false,
    );
  });
});

describe('the schema PalCert sends to the provider', () => {
  const sent = providerOutputFormat(RAW);

  it('is a json_schema format built by the SDK helper', () => {
    expect(sent.type).toBe('json_schema');
    expect(sent.schema.type).toBe('object');
  });

  it('contains no constraint the provider rejects, anywhere', () => {
    expect(unsupportedKeywords(sent.schema)).toEqual([]);
  });

  it('gives every object additionalProperties: false and every node a type', () => {
    nodes(sent.schema, (node, path) => {
      if (node.type === 'object') expect([path, node.additionalProperties]).toEqual([path, false]);
      const composite = ['$ref', 'anyOf', 'allOf'].some((key) => key in node);
      if (!composite && path !== '$') expect([path, node.type !== undefined]).toEqual([path, true]);
    });
  });

  it('drops only the document identifiers from the root', () => {
    expect(sent.schema.$schema).toBeUndefined();
    expect(sent.schema.$id).toBeUndefined();
    expect(sent.schema.required).toEqual(['proposals']);
  });

  it('still tells the model the whole vocabulary', () => {
    const text = JSON.stringify(sent.schema);
    const defs = RAW.$defs as Record<string, JsonSchema>;
    for (const name of ['RuleSeverity', 'RuleCategory', 'RuleOperator', 'RuleUnit']) {
      for (const value of defs[name]!.enum as string[]) expect(text).toContain(value);
    }
  });

  it('leaves PalCert’s own schema untouched', () => {
    const before = JSON.stringify(RAW);
    providerOutputFormat(RAW);
    expect(JSON.stringify(RAW)).toBe(before);
    expect(unsupportedKeywords(RAW).length).toBeGreaterThan(0);
  });

  it('is prepared once and identical every time, so the provider’s schema cache holds', () => {
    expect(providerOutputFormat(RAW)).toBe(sent);
    expect(JSON.stringify(providerOutputFormat(structuredClone(RAW)))).toBe(JSON.stringify(sent));
  });

  it('works for every assessment definition too', () => {
    const bundle = AI_ASSESSMENT_JSON_SCHEMA as unknown as { $defs: Record<string, JsonSchema> };
    for (const name of ['AIRuleAssessmentResponse', 'AIReportSupplementResponse']) {
      const format = providerOutputFormat({ ...bundle.$defs[name]!, $defs: bundle.$defs });
      expect([name, unsupportedKeywords(format.schema)]).toEqual([name, []]);
    }
  });

  it('refuses, locally and clearly, a schema it cannot prepare', () => {
    expect(() => providerOutputFormat({ type: 'object', properties: { x: {} } })).toThrow(
      'the output schema could not be prepared for the provider',
    );
  });
});
