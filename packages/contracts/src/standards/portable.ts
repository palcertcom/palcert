import { sha256Hex } from '../checks/report.js';
import { STANDARD_CANONICALIZATION_VERSION, serializeCanonical } from './canonical.js';
import { DOCUMENT_SYSTEM_CATEGORIES, type DocumentSystemCategory } from './document-type.js';
import {
  RULE_SCHEMA_VERSION,
  isSupportedRuleSchemaVersion,
  type RuleDefinition,
} from './rule-schema.js';
import {
  containsControlCharacters,
  containsMarkup,
  validateRuleDefinition,
  type RuleValidationIssue,
} from './rule-validation.js';
import {
  STANDARD_VERSION_STATUSES,
  VERSION_LABEL_MAX_LENGTH,
  isValidStandardCode,
  type StandardVersionStatus,
} from './standard.js';

/**
 * The portable standard package (`PALCERT_STANDARD`, format version 1).
 *
 * ## What it is, and what it is not
 *
 * A package carries one standard version's *content* from one PalCert
 * organization to another: the standard's names, its document type category,
 * the version label and window, and every rule's complete semantic definition.
 * The receiving organization imports it as a new DRAFT and adopts it only by
 * publishing that draft through its own lifecycle.
 *
 * It is not a backup and not the published snapshot:
 *
 *  - no database identifier of any kind (organization, standard, version,
 *    rule, document type, user, check, certificate, extraction run, source);
 *  - no users, memberships, credentials, checks, submissions, certificates,
 *    balances, audit rows, webhooks, AI prompts or output, source documents,
 *    storage keys, URLs or secrets;
 *  - `source` is provenance a person can read, never an address PalCert
 *    resolves.
 *
 * The published snapshot remains the immutable proof of what one organization
 * published. A package may come from a draft, and proves only that its bytes
 * were not changed after export.
 *
 * ## Integrity, not endorsement
 *
 * `contentHash` is SHA-256 over the canonical form of everything except
 * `exportedAt`, `contentHash` and `signatures`. It detects a file changed after
 * export. It does not prove the named source organization produced the file:
 * anyone can recompute it. That is what `signatures` is reserved for.
 *
 * ## Forward compatibility
 *
 * `signatures` is reserved in format version 1. Version 1 readers accept it,
 * never interpret it, and report how many were present, so a later PalCert can
 * sign packages without making them unreadable here. Because the hash excludes
 * `signatures`, a signature can cover `contentHash` itself.
 *
 * Any other change to the shape is a new `formatVersion`, which older readers
 * refuse rather than guess at.
 */
export const PORTABLE_STANDARD_FORMAT = 'PALCERT_STANDARD';
export const PORTABLE_STANDARD_FORMAT_VERSION = 1;
export const PORTABLE_STANDARD_FILE_SUFFIX = '.palcert.json';
export const PORTABLE_STANDARD_MEDIA_TYPE = 'application/json';

/**
 * Limits applied before anything in a package is trusted. The byte limit is
 * checked on the text as uploaded; the others while it is read.
 */
export const PORTABLE_STANDARD_LIMITS = {
  maxBytes: 5 * 1024 * 1024,
  maxRules: 5_000,
  /** Deepest legitimate nesting is five (root › rules › rule › expected › values). */
  maxDepth: 12,
  /** Longer than any field PalCert accepts, so real content never meets it. */
  maxStringLength: 20_000,
  // Above maxRules, so a long rule list is reported as such rather than as malformed.
  maxArrayItems: 10_000,
  maxSignatures: 16,
} as const;

export interface PortableStandardSource {
  readonly organizationName: string;
  readonly standardCode: string;
  readonly standardNameEn: string;
  readonly standardNameAr: string;
  readonly versionLabel: string;
  /** Informational only. An import always creates a DRAFT. */
  readonly versionStatus: StandardVersionStatus;
}

export interface PortableStandardSchema {
  readonly ruleSchemaVersion: number;
  readonly canonicalizationVersion: number;
}

export interface PortableStandardIdentity {
  readonly code: string;
  readonly nameEn: string;
  readonly nameAr: string;
  readonly descriptionEn: string | null;
  readonly descriptionAr: string | null;
}

export interface PortableStandardDocumentType {
  readonly systemCategory: DocumentSystemCategory;
  readonly name: string;
}

export interface PortableStandardVersion {
  readonly versionLabel: string;
  readonly effectiveFrom: string | null;
  readonly effectiveUntil: string | null;
}

/** A rule exactly as PalCert defines one; the same vocabulary as the rule API. */
export type PortableStandardRule = RuleDefinition;

/** Reserved for a later version; never interpreted by format version 1. */
export interface PortableStandardSignature {
  readonly algorithm: string;
  readonly keyId: string;
  readonly value: string;
}

export interface PortableStandardPackage {
  readonly format: typeof PORTABLE_STANDARD_FORMAT;
  readonly formatVersion: number;
  readonly exportedAt: string;
  readonly contentHash: string;
  readonly source: PortableStandardSource;
  readonly schema: PortableStandardSchema;
  readonly standard: PortableStandardIdentity;
  readonly documentType: PortableStandardDocumentType;
  readonly version: PortableStandardVersion;
  readonly rules: readonly PortableStandardRule[];
  readonly signatures?: readonly PortableStandardSignature[];
}

// ---------------------------------------------------------------------------
// Building and hashing
// ---------------------------------------------------------------------------

export type PortableStandardContent = Omit<
  PortableStandardPackage,
  'exportedAt' | 'contentHash' | 'signatures'
>;

/** A–Z order by code, then by canonical form: a total order even with duplicates. */
function orderRules(rules: readonly PortableStandardRule[]): PortableStandardRule[] {
  const keyed = rules.map((rule) => ({ rule, key: serializeCanonical(rule) }));
  keyed.sort((a, b) => {
    // Plain code-unit comparison: locale-aware collation differs between
    // runtimes, and a hash must not.
    const left = String(a.rule.ruleCode);
    const right = String(b.rule.ruleCode);
    if (left !== right) return left < right ? -1 : 1;
    return a.key < b.key ? -1 : a.key > b.key ? 1 : 0;
  });
  return keyed.map((entry) => entry.rule);
}

/**
 * The exact string the content hash is computed over.
 *
 * The standard canonical form (sorted keys, NFC strings, nulls omitted, fixed
 * number serialization), with rules ordered by code so that reordering the
 * array in a text editor does not change the hash — `displayOrder` is carried
 * as a field, and that is what fixes report order.
 */
export function portableStandardHashInput(content: PortableStandardContent): string {
  return serializeCanonical({
    format: content.format,
    formatVersion: content.formatVersion,
    source: content.source,
    schema: content.schema,
    standard: content.standard,
    documentType: content.documentType,
    version: content.version,
    rules: orderRules(content.rules),
  });
}

export function computePortableStandardHash(content: PortableStandardContent): string {
  return `sha256:${sha256Hex(portableStandardHashInput(content))}`;
}

/** Assemble a package from content, stamping the hash and the export time. */
export function buildPortableStandardPackage(
  content: Omit<PortableStandardContent, 'format' | 'formatVersion'>,
  exportedAt: Date,
): PortableStandardPackage {
  const full: PortableStandardContent = {
    format: PORTABLE_STANDARD_FORMAT,
    formatVersion: PORTABLE_STANDARD_FORMAT_VERSION,
    ...content,
    rules: orderRules(content.rules),
  };
  return {
    format: full.format,
    formatVersion: full.formatVersion,
    exportedAt: exportedAt.toISOString(),
    contentHash: computePortableStandardHash(full),
    source: full.source,
    schema: full.schema,
    standard: full.standard,
    documentType: full.documentType,
    version: full.version,
    rules: full.rules,
  };
}

/** Pretty-printed for people; the hash never depends on this layout. */
export function serializePortableStandardPackage(pkg: PortableStandardPackage): string {
  return `${JSON.stringify(pkg, null, 2)}\n`;
}

/** `IUG-PHD-1.4.palcert.json` — only characters every file system accepts. */
export function portableStandardFileName(code: string, versionLabel: string): string {
  const safe = (value: string): string =>
    value
      .normalize('NFKD')
      .replace(/[^A-Za-z0-9._-]+/g, '_')
      .replace(/_+/g, '_')
      .replace(/^[_.]+|[_.]+$/g, '')
      .slice(0, 80) || 'standard';
  return `${safe(code)}-${safe(versionLabel)}${PORTABLE_STANDARD_FILE_SUFFIX}`;
}

// ---------------------------------------------------------------------------
// Reading an untrusted package
// ---------------------------------------------------------------------------

export const PortablePackageErrorCode = {
  /** Not JSON, or JSON that breaks a structural limit. */
  MALFORMED: 'MALFORMED',
  TOO_LARGE: 'TOO_LARGE',
  /** JSON, but not a PalCert standard package at all. */
  UNKNOWN_FORMAT: 'UNKNOWN_FORMAT',
  /** Written by a newer PalCert format than this installation reads. */
  UNSUPPORTED_FORMAT_VERSION: 'UNSUPPORTED_FORMAT_VERSION',
  UNSUPPORTED_RULE_SCHEMA: 'UNSUPPORTED_RULE_SCHEMA',
  UNSUPPORTED_CANONICALIZATION: 'UNSUPPORTED_CANONICALIZATION',
  /** A PalCert package whose shape or values are wrong. */
  INVALID: 'INVALID',
  TOO_MANY_RULES: 'TOO_MANY_RULES',
  /** The contents do not hash to `contentHash`. */
  INTEGRITY_FAILED: 'INTEGRITY_FAILED',
} as const;

export type PortablePackageErrorCode =
  (typeof PortablePackageErrorCode)[keyof typeof PortablePackageErrorCode];

export interface PortablePackageError {
  readonly code: PortablePackageErrorCode;
  readonly message: string;
  /** A dotted path into the package, never a value from it. */
  readonly path: string | null;
}

export interface PortableRuleResult {
  /** Position in the package's `rules` array. */
  readonly index: number;
  /** Present only when the rule passed every check. */
  readonly definition: PortableStandardRule | null;
  readonly issues: readonly RuleValidationIssue[];
  /** A safe, flat echo of what the file said, for the preview table. */
  readonly display: PortableRuleDisplay;
}

export interface PortableRuleDisplay {
  readonly ruleCode: string | null;
  readonly category: string | null;
  readonly evaluationMode: string | null;
  readonly operator: string | null;
  readonly unit: string | null;
  readonly tolerance: number | null;
  readonly severity: string | null;
  readonly blocking: boolean | null;
  readonly titleEn: string | null;
  readonly titleAr: string | null;
  readonly displayOrder: number | null;
  readonly scope: Readonly<Record<string, string | number>> | null;
  readonly expected: Readonly<Record<string, unknown>> | null;
}

export type PortablePackageReadResult =
  | {
      readonly ok: true;
      readonly package: PortableStandardPackage;
      readonly packageHash: string;
      /** The rule schema version the draft will be written under. */
      readonly importRuleSchemaVersion: number;
      readonly rules: readonly PortableRuleResult[];
      readonly signatureCount: number;
    }
  | { readonly ok: false; readonly error: PortablePackageError };

const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

class PackageReadError extends Error {
  constructor(
    readonly code: PortablePackageErrorCode,
    message: string,
    readonly path: string | null = null,
  ) {
    super(message);
  }
}

/**
 * Nesting depth measured on the text, before `JSON.parse` sees it, so a file of
 * a million opening brackets costs one linear scan and never a recursion.
 */
function maxNestingDepth(text: string): number {
  let depth = 0;
  let max = 0;
  let inString = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text.charCodeAt(index);
    if (inString) {
      if (char === 0x5c) index += 1;
      else if (char === 0x22) inString = false;
      continue;
    }
    if (char === 0x22) inString = true;
    else if (char === 0x7b || char === 0x5b) {
      depth += 1;
      if (depth > max) max = depth;
    } else if (char === 0x7d || char === 0x5d) depth -= 1;
  }
  return max;
}

/**
 * Strict JSON: no forbidden property names anywhere, no oversized strings or
 * arrays. `JSON.parse` already defines `__proto__` as an ordinary own property
 * rather than touching a prototype, but a later spread or merge would not be so
 * careful, so such a key refuses the whole file.
 */
function parseStrictJson(text: string): unknown {
  if (maxNestingDepth(text) > PORTABLE_STANDARD_LIMITS.maxDepth) {
    throw new PackageReadError(
      PortablePackageErrorCode.MALFORMED,
      `The file nests deeper than ${PORTABLE_STANDARD_LIMITS.maxDepth} levels.`,
    );
  }
  let value: unknown;
  try {
    value = JSON.parse(text, function reviver(key: string, current: unknown) {
      if (FORBIDDEN_KEYS.has(key)) {
        throw new PackageReadError(
          PortablePackageErrorCode.MALFORMED,
          'The file contains a property name PalCert does not accept.',
        );
      }
      if (
        typeof current === 'string' &&
        current.length > PORTABLE_STANDARD_LIMITS.maxStringLength
      ) {
        throw new PackageReadError(
          PortablePackageErrorCode.MALFORMED,
          'The file contains a text value that is too long.',
        );
      }
      if (Array.isArray(current) && current.length > PORTABLE_STANDARD_LIMITS.maxArrayItems) {
        throw new PackageReadError(
          PortablePackageErrorCode.MALFORMED,
          'The file contains a list that is too long.',
        );
      }
      return current;
    });
  } catch (error) {
    if (error instanceof PackageReadError) throw error;
    throw new PackageReadError(PortablePackageErrorCode.MALFORMED, 'The file is not valid JSON.');
  }
  return value;
}

type Json = Record<string, unknown>;

function isPlainObject(value: unknown): value is Json {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function object(value: unknown, path: string): Json {
  if (!isPlainObject(value)) {
    throw new PackageReadError(
      PortablePackageErrorCode.INVALID,
      `${path} must be an object.`,
      path,
    );
  }
  return value;
}

/** Exactly these keys: every required one present, nothing unknown. */
function exactKeys(
  record: Json,
  path: string,
  required: readonly string[],
  optional: readonly string[] = [],
): void {
  const allowed = new Set([...required, ...optional]);
  for (const key of Object.keys(record)) {
    if (!allowed.has(key)) {
      throw new PackageReadError(
        PortablePackageErrorCode.INVALID,
        `${path} has an unknown field "${safeKey(key)}".`,
        path,
      );
    }
  }
  for (const key of required) {
    if (!(key in record)) {
      throw new PackageReadError(
        PortablePackageErrorCode.INVALID,
        `${path}.${key} is missing.`,
        `${path}.${key}`,
      );
    }
  }
}

/** A key echoed in a message, shortened and stripped of anything unprintable. */
function safeKey(key: string): string {
  return key.replace(/[^A-Za-z0-9_.-]/g, '?').slice(0, 40);
}

function text(
  record: Json,
  key: string,
  path: string,
  options: { max: number; nullable?: boolean; plain?: boolean },
): string | null {
  const value = record[key];
  if (value === null && options.nullable === true) return null;
  if (typeof value !== 'string' || value.trim() === '') {
    throw new PackageReadError(
      PortablePackageErrorCode.INVALID,
      `${path}.${key} must be ${options.nullable === true ? 'null or ' : ''}non-empty text.`,
      `${path}.${key}`,
    );
  }
  if (value.length > options.max) {
    throw new PackageReadError(
      PortablePackageErrorCode.INVALID,
      `${path}.${key} is longer than ${options.max} characters.`,
      `${path}.${key}`,
    );
  }
  if (options.plain !== false && (containsMarkup(value) || containsControlCharacters(value))) {
    throw new PackageReadError(
      PortablePackageErrorCode.INVALID,
      `${path}.${key} must be plain text.`,
      `${path}.${key}`,
    );
  }
  return value;
}

function instant(record: Json, key: string, path: string): string | null {
  const value = record[key];
  if (value === null) return null;
  if (typeof value !== 'string' || value.length > 40 || Number.isNaN(Date.parse(value))) {
    throw new PackageReadError(
      PortablePackageErrorCode.INVALID,
      `${path}.${key} must be null or an ISO-8601 date.`,
      `${path}.${key}`,
    );
  }
  return new Date(value).toISOString() === value ? value : new Date(value).toISOString();
}

function integer(record: Json, key: string, path: string): number {
  const value = record[key];
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    throw new PackageReadError(
      PortablePackageErrorCode.INVALID,
      `${path}.${key} must be a whole number.`,
      `${path}.${key}`,
    );
  }
  return value;
}

// --- rules ------------------------------------------------------------------

const RULE_KEYS = [
  'ruleCode',
  'category',
  'evaluationMode',
  'scope',
  'operator',
  'expected',
  'unit',
  'tolerance',
  'severity',
  'blocking',
  'autofix',
  'origin',
  'originReference',
  'titleEn',
  'titleAr',
  'descriptionEn',
  'descriptionAr',
  'guidanceEn',
  'guidanceAr',
  'displayOrder',
] as const;

/** The fields each scope kind may carry, and no others. */
const SCOPE_KEYS: Readonly<
  Record<string, { required: readonly string[]; optional: readonly string[] }>
> = {
  DOCUMENT: { required: ['kind', 'property'], optional: [] },
  SECTION: { required: ['kind', 'sectionKey', 'property'], optional: [] },
  ELEMENT: { required: ['kind', 'elementType', 'property'], optional: ['level'] },
  METADATA: { required: ['kind', 'field'], optional: [] },
  PAGE: { required: ['kind', 'pages', 'property'], optional: [] },
};

/** The fields each expected-value type may carry, and no others. */
const EXPECTED_KEYS: Readonly<
  Record<string, { required: readonly string[]; optional: readonly string[] }>
> = {
  NUMBER: { required: ['type', 'number'], optional: [] },
  STRING: { required: ['type', 'text'], optional: [] },
  BOOLEAN: { required: ['type', 'boolean'], optional: [] },
  NUMBER_RANGE: { required: ['type', 'min', 'max'], optional: [] },
  STRING_LIST: { required: ['type', 'values'], optional: [] },
  NUMBER_LIST: { required: ['type', 'values'], optional: [] },
  PATTERN: { required: ['type', 'pattern'], optional: ['argument'] },
  NONE: { required: ['type'], optional: [] },
};

/** Tolerance is stored as DECIMAL(12,4); anything finer would be rounded, silently. */
const TOLERANCE_MAX = 99_999_999.9999;
function toleranceFitsStorage(value: number): boolean {
  if (Math.abs(value) > TOLERANCE_MAX) return false;
  const scaled = value * 10_000;
  return Math.abs(scaled - Math.round(scaled)) < 1e-6;
}

function structuralIssues(raw: unknown): RuleValidationIssue[] {
  const issues: RuleValidationIssue[] = [];
  const push = (path: string, message: string): void => {
    issues.push({ path, code: 'INVALID', message });
  };
  if (!isPlainObject(raw)) {
    push('', 'A rule must be an object.');
    return issues;
  }
  for (const key of Object.keys(raw)) {
    if (!(RULE_KEYS as readonly string[]).includes(key))
      push(safeKey(key), 'This field is not part of a PalCert rule.');
  }
  for (const key of RULE_KEYS) {
    if (!(key in raw)) push(key, 'This field is missing. Nullable fields must be present as null.');
  }
  const checkShape = (
    value: unknown,
    path: string,
    discriminant: string,
    table: typeof SCOPE_KEYS,
  ): void => {
    if (!isPlainObject(value)) return; // the rule validator explains a non-object
    const kind = value[discriminant];
    const shape = typeof kind === 'string' ? table[kind] : undefined;
    if (shape === undefined) return; // likewise for an unknown kind
    for (const key of Object.keys(value)) {
      if (!shape.required.includes(key) && !shape.optional.includes(key)) {
        push(`${path}.${safeKey(key)}`, `This field is not part of a ${String(kind)} ${path}.`);
      }
    }
  };
  checkShape(raw['scope'], 'scope', 'kind', SCOPE_KEYS);
  checkShape(raw['expected'], 'expected', 'type', EXPECTED_KEYS);

  const tolerance = raw['tolerance'];
  if (
    typeof tolerance === 'number' &&
    Number.isFinite(tolerance) &&
    !toleranceFitsStorage(tolerance)
  ) {
    push('tolerance', 'A tolerance may have at most 4 decimal places.');
  }
  const order = raw['displayOrder'];
  if (typeof order !== 'number' || !Number.isInteger(order) || order < 0 || order > 100_000) {
    push('displayOrder', 'displayOrder must be a whole number from 0 to 100000.');
  }
  const blocking = raw['blocking'];
  if (typeof blocking !== 'boolean') push('blocking', 'blocking must be true or false.');
  return issues;
}

function displayOf(raw: unknown): PortableRuleDisplay {
  const record = isPlainObject(raw) ? raw : {};
  const str = (key: string): string | null => {
    const value = record[key];
    return typeof value === 'string' ? value.slice(0, 200) : null;
  };
  const num = (key: string): number | null => {
    const value = record[key];
    return typeof value === 'number' && Number.isFinite(value) ? value : null;
  };
  const flat = (value: unknown): Record<string, string | number> | null => {
    if (!isPlainObject(value)) return null;
    const out: Record<string, string | number> = {};
    for (const [key, item] of Object.entries(value).slice(0, 8)) {
      if (typeof item === 'string') out[safeKey(key)] = item.slice(0, 120);
      else if (typeof item === 'number' && Number.isFinite(item)) out[safeKey(key)] = item;
    }
    return out;
  };
  const expected = (value: unknown): Record<string, unknown> | null => {
    if (!isPlainObject(value)) return null;
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value).slice(0, 8)) {
      if (typeof item === 'string') out[safeKey(key)] = item.slice(0, 120);
      else if (typeof item === 'number' && Number.isFinite(item)) out[safeKey(key)] = item;
      else if (typeof item === 'boolean') out[safeKey(key)] = item;
      else if (Array.isArray(item)) {
        out[safeKey(key)] = item
          .slice(0, 20)
          .filter(
            (entry) =>
              typeof entry === 'string' || (typeof entry === 'number' && Number.isFinite(entry)),
          )
          .map((entry) => (typeof entry === 'string' ? entry.slice(0, 60) : entry));
      }
    }
    return out;
  };
  return {
    ruleCode: str('ruleCode'),
    category: str('category'),
    evaluationMode: str('evaluationMode'),
    operator: str('operator'),
    unit: str('unit'),
    tolerance: num('tolerance'),
    severity: str('severity'),
    blocking: typeof record['blocking'] === 'boolean' ? (record['blocking'] as boolean) : null,
    titleEn: str('titleEn'),
    titleAr: str('titleAr'),
    displayOrder: num('displayOrder'),
    scope: flat(record['scope']),
    expected: expected(record['expected']),
  };
}

/**
 * Judge one rule exactly as a hand-written rule is judged — the same
 * `validateRuleDefinition` the rule API runs — plus the structural checks a
 * file needs and a form does not: no unknown fields anywhere, every nullable
 * field present, and a tolerance the database can hold without rounding.
 *
 * A rule written under an older supported schema must satisfy that schema, and
 * the current one it will be stored under. Nothing is normalized: a value that
 * is not already right is reported, never repaired.
 */
export function validatePortableRule(
  raw: unknown,
  index: number,
  sourceSchemaVersion: number,
): PortableRuleResult {
  const issues = structuralIssues(raw);
  if (isPlainObject(raw)) {
    const seen = new Set(issues.map((issue) => `${issue.path}:${issue.message}`));
    for (const version of new Set([sourceSchemaVersion, RULE_SCHEMA_VERSION])) {
      for (const issue of validateRuleDefinition(raw as Partial<RuleDefinition>, {
        schemaVersion: version,
      }).issues) {
        const key = `${issue.path}:${issue.message}`;
        if (!seen.has(key)) {
          seen.add(key);
          issues.push(issue);
        }
      }
    }
  }
  return {
    index,
    definition: issues.length === 0 ? (pickRule(raw as Json) as PortableStandardRule) : null,
    issues,
    display: displayOf(raw),
  };
}

/** Only the rule's own fields, in a fresh object: nothing else rides along. */
function pickRule(raw: Json): Json {
  const out: Json = {};
  for (const key of RULE_KEYS) out[key] = raw[key];
  return out;
}

/**
 * Read a package from untrusted text.
 *
 * Order matters: size and structure before anything else; format and version
 * before shape, because a future version's shape is not ours to judge; the
 * integrity hash before any rule is looked at, so a changed file is reported as
 * changed rather than as whatever its changes happen to break.
 */
export function readPortableStandardPackage(input: string): PortablePackageReadResult {
  try {
    return readOrThrow(input);
  } catch (error) {
    if (error instanceof PackageReadError) {
      return { ok: false, error: { code: error.code, message: error.message, path: error.path } };
    }
    return {
      ok: false,
      error: {
        code: PortablePackageErrorCode.MALFORMED,
        message: 'The file could not be read.',
        path: null,
      },
    };
  }
}

function utf8Length(value: string): number {
  let bytes = 0;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code < 0x80) bytes += 1;
    else if (code < 0x800) bytes += 2;
    else if (code >= 0xd800 && code <= 0xdbff) {
      bytes += 4;
      index += 1;
    } else bytes += 3;
  }
  return bytes;
}

/** A UTF-8 byte-order mark some editors add is not content; nothing else is dropped. */
function stripByteOrderMark(value: string): string {
  return value.charCodeAt(0) === 0xfeff ? value.slice(1) : value;
}

function readOrThrow(input: string): PortablePackageReadResult {
  if (typeof input !== 'string' || input.length === 0) {
    throw new PackageReadError(PortablePackageErrorCode.MALFORMED, 'The file is empty.');
  }
  if (utf8Length(input) > PORTABLE_STANDARD_LIMITS.maxBytes) {
    throw new PackageReadError(
      PortablePackageErrorCode.TOO_LARGE,
      `The file is larger than ${PORTABLE_STANDARD_LIMITS.maxBytes / (1024 * 1024)} MB.`,
    );
  }
  const root = object(parseStrictJson(stripByteOrderMark(input)), 'package');

  if (root['format'] !== PORTABLE_STANDARD_FORMAT) {
    throw new PackageReadError(
      PortablePackageErrorCode.UNKNOWN_FORMAT,
      'This file is not a PalCert standard package.',
      'format',
    );
  }
  const formatVersion = root['formatVersion'];
  if (typeof formatVersion !== 'number' || !Number.isInteger(formatVersion) || formatVersion < 1) {
    throw new PackageReadError(
      PortablePackageErrorCode.INVALID,
      'formatVersion must be a positive whole number.',
      'formatVersion',
    );
  }
  if (formatVersion > PORTABLE_STANDARD_FORMAT_VERSION) {
    throw new PackageReadError(
      PortablePackageErrorCode.UNSUPPORTED_FORMAT_VERSION,
      'This standard was created by a newer PalCert format that this installation does not support.',
      'formatVersion',
    );
  }

  exactKeys(
    root,
    'package',
    [
      'format',
      'formatVersion',
      'exportedAt',
      'contentHash',
      'source',
      'schema',
      'standard',
      'documentType',
      'version',
      'rules',
    ],
    ['signatures'],
  );

  const schemaRaw = object(root['schema'], 'schema');
  exactKeys(schemaRaw, 'schema', ['ruleSchemaVersion', 'canonicalizationVersion']);
  const ruleSchemaVersion = integer(schemaRaw, 'ruleSchemaVersion', 'schema');
  const canonicalizationVersion = integer(schemaRaw, 'canonicalizationVersion', 'schema');
  if (ruleSchemaVersion > RULE_SCHEMA_VERSION) {
    throw new PackageReadError(
      PortablePackageErrorCode.UNSUPPORTED_RULE_SCHEMA,
      `This standard uses rule schema version ${ruleSchemaVersion}, which is newer than this installation supports.`,
      'schema.ruleSchemaVersion',
    );
  }
  if (!isSupportedRuleSchemaVersion(ruleSchemaVersion)) {
    throw new PackageReadError(
      PortablePackageErrorCode.INVALID,
      `Rule schema version ${ruleSchemaVersion} is not a PalCert rule schema.`,
      'schema.ruleSchemaVersion',
    );
  }
  if (canonicalizationVersion > STANDARD_CANONICALIZATION_VERSION || canonicalizationVersion < 1) {
    throw new PackageReadError(
      PortablePackageErrorCode.UNSUPPORTED_CANONICALIZATION,
      `This standard uses canonicalization version ${canonicalizationVersion}, which this installation does not support.`,
      'schema.canonicalizationVersion',
    );
  }

  const exportedAt = root['exportedAt'];
  if (
    typeof exportedAt !== 'string' ||
    exportedAt.length > 40 ||
    Number.isNaN(Date.parse(exportedAt))
  ) {
    throw new PackageReadError(
      PortablePackageErrorCode.INVALID,
      'exportedAt must be an ISO-8601 date.',
      'exportedAt',
    );
  }
  const contentHash = root['contentHash'];
  if (typeof contentHash !== 'string' || !/^sha256:[0-9a-f]{64}$/.test(contentHash)) {
    throw new PackageReadError(
      PortablePackageErrorCode.INVALID,
      'contentHash must be sha256: followed by 64 lowercase hex digits.',
      'contentHash',
    );
  }

  const sourceRaw = object(root['source'], 'source');
  exactKeys(sourceRaw, 'source', [
    'organizationName',
    'standardCode',
    'standardNameEn',
    'standardNameAr',
    'versionLabel',
    'versionStatus',
  ]);
  const versionStatus = sourceRaw['versionStatus'];
  if (
    typeof versionStatus !== 'string' ||
    !(STANDARD_VERSION_STATUSES as readonly string[]).includes(versionStatus)
  ) {
    throw new PackageReadError(
      PortablePackageErrorCode.INVALID,
      'source.versionStatus is not a PalCert version status.',
      'source.versionStatus',
    );
  }
  const source: PortableStandardSource = {
    organizationName: text(sourceRaw, 'organizationName', 'source', { max: 200 })!,
    standardCode: text(sourceRaw, 'standardCode', 'source', { max: 64 })!,
    standardNameEn: text(sourceRaw, 'standardNameEn', 'source', { max: 200 })!,
    standardNameAr: text(sourceRaw, 'standardNameAr', 'source', { max: 200 })!,
    versionLabel: text(sourceRaw, 'versionLabel', 'source', { max: VERSION_LABEL_MAX_LENGTH })!,
    versionStatus: versionStatus as StandardVersionStatus,
  };

  const standardRaw = object(root['standard'], 'standard');
  exactKeys(standardRaw, 'standard', [
    'code',
    'nameEn',
    'nameAr',
    'descriptionEn',
    'descriptionAr',
  ]);
  const code = text(standardRaw, 'code', 'standard', { max: 64 })!;
  if (!isValidStandardCode(code)) {
    throw new PackageReadError(
      PortablePackageErrorCode.INVALID,
      'standard.code is not a valid PalCert standard code.',
      'standard.code',
    );
  }
  const standard: PortableStandardIdentity = {
    code,
    nameEn: text(standardRaw, 'nameEn', 'standard', { max: 200 })!,
    nameAr: text(standardRaw, 'nameAr', 'standard', { max: 200 })!,
    descriptionEn: text(standardRaw, 'descriptionEn', 'standard', { max: 2000, nullable: true }),
    descriptionAr: text(standardRaw, 'descriptionAr', 'standard', { max: 2000, nullable: true }),
  };

  const typeRaw = object(root['documentType'], 'documentType');
  exactKeys(typeRaw, 'documentType', ['systemCategory', 'name']);
  const category = typeRaw['systemCategory'];
  if (
    typeof category !== 'string' ||
    !(DOCUMENT_SYSTEM_CATEGORIES as readonly string[]).includes(category)
  ) {
    throw new PackageReadError(
      PortablePackageErrorCode.INVALID,
      'documentType.systemCategory is not a PalCert document category.',
      'documentType.systemCategory',
    );
  }
  const documentType: PortableStandardDocumentType = {
    systemCategory: category as DocumentSystemCategory,
    name: text(typeRaw, 'name', 'documentType', { max: 120 })!,
  };

  const versionRaw = object(root['version'], 'version');
  exactKeys(versionRaw, 'version', ['versionLabel', 'effectiveFrom', 'effectiveUntil']);
  const version: PortableStandardVersion = {
    versionLabel: text(versionRaw, 'versionLabel', 'version', { max: VERSION_LABEL_MAX_LENGTH })!,
    effectiveFrom: instant(versionRaw, 'effectiveFrom', 'version'),
    effectiveUntil: instant(versionRaw, 'effectiveUntil', 'version'),
  };
  if (
    versionRaw['effectiveFrom'] !== version.effectiveFrom ||
    versionRaw['effectiveUntil'] !== version.effectiveUntil
  ) {
    throw new PackageReadError(
      PortablePackageErrorCode.INVALID,
      'version dates must be ISO-8601 instants in UTC, e.g. 2027-09-01T00:00:00.000Z.',
      'version',
    );
  }

  const rulesRaw = root['rules'];
  if (!Array.isArray(rulesRaw)) {
    throw new PackageReadError(PortablePackageErrorCode.INVALID, 'rules must be a list.', 'rules');
  }
  if (rulesRaw.length > PORTABLE_STANDARD_LIMITS.maxRules) {
    throw new PackageReadError(
      PortablePackageErrorCode.TOO_MANY_RULES,
      `The package has ${rulesRaw.length} rules; at most ${PORTABLE_STANDARD_LIMITS.maxRules} are accepted.`,
      'rules',
    );
  }
  if (rulesRaw.length === 0) {
    throw new PackageReadError(
      PortablePackageErrorCode.INVALID,
      'The package contains no rules.',
      'rules',
    );
  }

  let signatureCount = 0;
  if ('signatures' in root) {
    const signatures = root['signatures'];
    if (!Array.isArray(signatures) || signatures.length > PORTABLE_STANDARD_LIMITS.maxSignatures) {
      throw new PackageReadError(
        PortablePackageErrorCode.INVALID,
        'signatures must be a short list.',
        'signatures',
      );
    }
    signatures.forEach((entry, position) => {
      const path = `signatures.${position}`;
      const signature = object(entry, path);
      exactKeys(signature, path, ['algorithm', 'keyId', 'value']);
      text(signature, 'algorithm', path, { max: 64 });
      text(signature, 'keyId', path, { max: 256 });
      text(signature, 'value', path, { max: 8192 });
    });
    signatureCount = signatures.length;
  }

  // Integrity before any rule is judged. The hash is recomputed over what the
  // file actually contains — every rule as written, valid or not.
  const content: PortableStandardContent = {
    format: PORTABLE_STANDARD_FORMAT,
    formatVersion,
    source,
    schema: { ruleSchemaVersion, canonicalizationVersion },
    standard,
    documentType,
    version,
    rules: rulesRaw as PortableStandardRule[],
  };
  let calculated: string;
  try {
    calculated = computePortableStandardHash(content);
  } catch {
    // A non-finite number cannot be canonicalized; JSON cannot carry one, so
    // this is a file that was not produced by PalCert.
    throw new PackageReadError(
      PortablePackageErrorCode.INVALID,
      'The package contains a value PalCert cannot represent.',
    );
  }
  if (calculated !== contentHash) {
    throw new PackageReadError(
      PortablePackageErrorCode.INTEGRITY_FAILED,
      "The file's integrity check failed. The contents may have been changed after export.",
      'contentHash',
    );
  }

  const rules = rulesRaw.map((raw, index) => validatePortableRule(raw, index, ruleSchemaVersion));

  // Duplicate codes are a fact about the set, reported on every rule involved.
  const byCode = new Map<string, number[]>();
  rules.forEach((rule) => {
    const code = rule.display.ruleCode;
    if (code !== null) byCode.set(code, [...(byCode.get(code) ?? []), rule.index]);
  });
  const withDuplicates = rules.map((rule) => {
    const code = rule.display.ruleCode;
    const clash = code === null ? undefined : byCode.get(code);
    if (clash === undefined || clash.length < 2) return rule;
    const issue: RuleValidationIssue = {
      path: 'ruleCode',
      code: 'DUPLICATE',
      message: `${clash.length} rules in this package use the code ${code}.`,
    };
    return { ...rule, definition: null, issues: [...rule.issues, issue] };
  });

  const pkg: PortableStandardPackage = {
    format: PORTABLE_STANDARD_FORMAT,
    formatVersion,
    exportedAt,
    contentHash,
    source,
    schema: { ruleSchemaVersion, canonicalizationVersion },
    standard,
    documentType,
    version,
    rules: rulesRaw as PortableStandardRule[],
  };

  return {
    ok: true,
    package: pkg,
    packageHash: contentHash,
    importRuleSchemaVersion: RULE_SCHEMA_VERSION,
    rules: withDuplicates,
    signatureCount,
  };
}

// ---------------------------------------------------------------------------
// API views
// ---------------------------------------------------------------------------

export const StandardImportMode = {
  NEW_STANDARD: 'NEW_STANDARD',
  EXISTING_STANDARD: 'EXISTING_STANDARD',
} as const;
export type StandardImportMode = (typeof StandardImportMode)[keyof typeof StandardImportMode];

export interface StandardImportPreviewRuleView extends PortableRuleDisplay {
  readonly index: number;
  readonly valid: boolean;
  readonly issues: readonly RuleValidationIssue[];
}

export interface StandardImportWarningView {
  readonly code: string;
  readonly message: string;
}

/** What the receiving organization is shown before anything is created. */
export interface StandardImportPreviewView {
  readonly packageHash: string;
  readonly formatVersion: number;
  readonly exportedAt: string;
  readonly integrity: 'VERIFIED';
  /** Signatures present in the file. Version 1 never verifies them. */
  readonly signatureCount: number;
  readonly source: PortableStandardSource;
  readonly standard: PortableStandardIdentity;
  readonly documentType: PortableStandardDocumentType;
  readonly version: PortableStandardVersion;
  readonly schema: {
    readonly sourceRuleSchemaVersion: number;
    readonly importRuleSchemaVersion: number;
    readonly upgraded: boolean;
    readonly canonicalizationVersion: number;
  };
  readonly ruleCount: number;
  readonly validRuleCount: number;
  readonly invalidRuleCount: number;
  readonly rules: readonly StandardImportPreviewRuleView[];
  readonly destination: {
    /** A standard in this organization already uses the package's code. */
    readonly existingStandardWithCode: StandardImportTargetView | null;
    readonly documentTypes: readonly {
      readonly id: string;
      readonly name: string;
      readonly systemCategory: DocumentSystemCategory;
      /** Same system category as the package. */
      readonly matchesCategory: boolean;
    }[];
    /** Standards a new draft version could be added to. */
    readonly standards: readonly StandardImportTargetView[];
  };
  readonly previousImports: readonly {
    readonly importedAt: string;
    readonly standardId: string;
    readonly standardCode: string;
    readonly versionId: string;
    readonly versionLabel: string;
  }[];
  readonly warnings: readonly StandardImportWarningView[];
  /** False while any rule is invalid: nothing may be imported until it is fixed at the source. */
  readonly canImport: boolean;
}

export interface StandardImportTargetView {
  readonly id: string;
  readonly code: string;
  readonly nameEn: string;
  readonly nameAr: string;
  readonly documentTypeCategory: DocumentSystemCategory;
  readonly status: string;
  /** Same document category as the package; only then may a version be added. */
  readonly compatible: boolean;
  readonly versionLabels: readonly string[];
  readonly draftCount: number;
}

/** Where an imported version came from, as recorded when it was imported. */
export interface StandardImportProvenanceView {
  readonly importId: string;
  readonly importedAt: string;
  readonly importedByUserId: string | null;
  readonly packageHash: string;
  readonly formatVersion: number;
  readonly sourceOrganizationName: string;
  readonly sourceStandardCode: string;
  readonly sourceStandardNameEn: string;
  readonly sourceStandardNameAr: string;
  readonly sourceVersionLabel: string;
  readonly sourceVersionStatus: StandardVersionStatus;
  readonly sourceRuleSchemaVersion: number;
  readonly importRuleSchemaVersion: number;
  readonly ruleCount: number;
  readonly createdStandard: boolean;
}

export interface StandardImportResultView {
  readonly standardId: string;
  readonly versionId: string;
  readonly versionLabel: string;
  readonly createdStandard: boolean;
  readonly ruleCount: number;
  readonly provenance: StandardImportProvenanceView;
}
