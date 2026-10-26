import { jsonSchemaOutputFormat } from '@anthropic-ai/sdk/helpers/json-schema';
import { AIFailureKind, AIProviderError } from '@palcert/contracts';

export type JsonSchema = Record<string, unknown>;

/**
 * Keywords Anthropic's structured-output grammar does not accept.
 *
 * PalCert's own schemas use several of them on purpose: they are part of
 * PalCert's contract and PalCert enforces them after every response. They
 * must simply never reach the provider, which answers a schema containing one
 * with `400 invalid_request_error`. `minItems` is accepted only as 0 or 1.
 */
export const PROVIDER_UNSUPPORTED_KEYWORDS: readonly string[] = [
  'minimum',
  'maximum',
  'exclusiveMinimum',
  'exclusiveMaximum',
  'multipleOf',
  'minLength',
  'maxLength',
  'pattern',
  'maxItems',
  'uniqueItems',
  'minProperties',
  'maxProperties',
  'patternProperties',
  'not',
  'if',
  'then',
  'else',
];

/** Keys whose value is a map of *names* to schemas, not a schema itself. */
const SCHEMA_MAPS = ['properties', '$defs', 'definitions'];
/** Keys whose value is a schema, or a list of schemas. */
const SCHEMA_CHILDREN = ['items', 'anyOf', 'oneOf', 'allOf'];

const prepared = new WeakMap<JsonSchema, { type: 'json_schema'; schema: JsonSchema }>();
const preparedAsIs = new WeakMap<JsonSchema, { type: 'json_schema'; schema: JsonSchema }>();

/**
 * The `output_config.format` for a PalCert schema, in the form the provider
 * accepts.
 *
 * Built by the Anthropic SDK's own `jsonSchemaOutputFormat`, which removes the
 * constraints the API does not support and folds them into descriptions, and
 * adds `additionalProperties: false` to every object. PalCert does not keep a
 * hand-written copy of that list.
 *
 * Two things are done first, because the helper cannot take PalCert's schemas
 * as they are. Neither changes what a valid answer is:
 *
 * - A closed vocabulary written as a bare `enum` or `const` gets the `type`
 *   its values already imply. The helper refuses a node without a `type`, and
 *   `RuleSeverity`, `RuleCategory` and others are exactly that.
 * - The root's `$schema` and `$id` are dropped. They identify the document;
 *   they constrain nothing.
 *
 * The result is checked once more before use. If a later SDK version stopped
 * stripping a keyword, the request would fail here, with a clear reason,
 * instead of reaching the provider and coming back as an opaque 400.
 *
 * The response is still validated against the original, unmodified schema
 * (see `structuredCall`): this changes what is *sent*, never what is
 * *accepted*.
 */
export function providerOutputFormat(
  schema: JsonSchema,
  options: {
    /**
     * `false` for a schema written to be provider-compatible already (the
     * Pass B wire DTO): the helper then sends it unchanged, so its `enum`s
     * stay grammar constraints instead of being folded into descriptions.
     * The unsupported-keyword check below runs either way.
     */
    transform?: boolean;
  } = {},
): {
  type: 'json_schema';
  schema: JsonSchema;
} {
  const transform = options.transform ?? true;
  const cache = transform ? prepared : preparedAsIs;
  const cached = cache.get(schema);
  if (cached !== undefined) return cached;

  const normalized = withImpliedTypes(structuredClone(schema));
  delete normalized.$schema;
  delete normalized.$id;

  let format: { type: 'json_schema'; schema: JsonSchema };
  try {
    const built = jsonSchemaOutputFormat(
      normalized as Parameters<typeof jsonSchemaOutputFormat>[0],
      { transform },
    ) as unknown as { type: 'json_schema'; schema: JsonSchema };
    // Only the wire shape. The helper's `parse` is not used: PalCert parses
    // and validates the response itself, against the full schema.
    format = { type: built.type, schema: built.schema };
  } catch {
    throw new AIProviderError(
      AIFailureKind.INVALID_REQUEST,
      'the output schema could not be prepared for the provider',
    );
  }

  if (unsupportedKeywords(format.schema).length > 0) {
    throw new AIProviderError(
      AIFailureKind.INVALID_REQUEST,
      'the output schema still carries constraints the provider rejects',
    );
  }

  cache.set(schema, format);
  return format;
}

/**
 * Every place in a schema that uses a keyword the provider rejects, as a path.
 *
 * Walks the schema structurally: a property that happens to be *named*
 * `pattern` (PalCert's rule scopes have one) is a name, not a keyword.
 */
export function unsupportedKeywords(schema: unknown, path = '$'): string[] {
  if (schema === null || typeof schema !== 'object' || Array.isArray(schema)) return [];
  const node = schema as JsonSchema;
  const found: string[] = [];

  for (const keyword of PROVIDER_UNSUPPORTED_KEYWORDS) {
    if (keyword in node) found.push(`${path}.${keyword}`);
  }
  if (typeof node.minItems === 'number' && node.minItems > 1) found.push(`${path}.minItems`);
  if (
    (node.type === 'object' || node.properties !== undefined) &&
    node.additionalProperties !== false
  ) {
    found.push(`${path}.additionalProperties`);
  }

  for (const key of SCHEMA_MAPS) {
    const map = node[key];
    if (map !== null && typeof map === 'object') {
      for (const [name, child] of Object.entries(map as JsonSchema)) {
        found.push(...unsupportedKeywords(child, `${path}.${key}.${name}`));
      }
    }
  }
  for (const key of SCHEMA_CHILDREN) {
    const child = node[key];
    if (Array.isArray(child)) {
      child.forEach((entry, index) =>
        found.push(...unsupportedKeywords(entry, `${path}.${key}[${index}]`)),
      );
    } else if (child !== undefined) {
      found.push(...unsupportedKeywords(child, `${path}.${key}`));
    }
  }
  return found;
}

/** Give each type-less `enum`/`const` node the type its values imply. */
function withImpliedTypes(node: JsonSchema): JsonSchema {
  const composite = ['$ref', 'anyOf', 'oneOf', 'allOf'].some((key) => key in node);
  if (node.type === undefined && !composite) {
    const values =
      node.enum !== undefined ? (node.enum as unknown[]) : 'const' in node ? [node.const] : null;
    const implied = values === null ? null : impliedType(values);
    if (implied !== null) node.type = implied;
  }

  for (const key of SCHEMA_MAPS) {
    const map = node[key];
    if (map !== null && typeof map === 'object') {
      for (const child of Object.values(map as JsonSchema)) {
        if (child !== null && typeof child === 'object') withImpliedTypes(child as JsonSchema);
      }
    }
  }
  for (const key of SCHEMA_CHILDREN) {
    const child = node[key];
    const children = Array.isArray(child) ? child : child === undefined ? [] : [child];
    for (const entry of children) {
      if (entry !== null && typeof entry === 'object') withImpliedTypes(entry as JsonSchema);
    }
  }
  return node;
}

function impliedType(values: readonly unknown[]): string | string[] | null {
  const types = new Set<string>();
  for (const value of values) {
    if (value === null) types.add('null');
    else if (typeof value === 'string') types.add('string');
    else if (typeof value === 'boolean') types.add('boolean');
    else if (typeof value === 'number') types.add(Number.isInteger(value) ? 'integer' : 'number');
    else return null; // objects and arrays in an enum are not something to guess about
  }
  if (types.has('number')) types.delete('integer');
  const list = [...types];
  if (list.length === 0) return null;
  return list.length === 1 ? list[0]! : list;
}
