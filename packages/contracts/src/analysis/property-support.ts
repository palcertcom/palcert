import { DOCUMENT_PROPERTY_SUPPORT_REGISTRY } from './property-support.generated.js';
import type { DocumentFormat } from '../documents/document.js';

/**
 * What each PalCert document property can mean in each source format (§61, §62).
 *
 * The registry file is the single source of truth; this module is the only way
 * the rest of the TypeScript codebase reads it. The point is that PDF
 * compatibility is never described in three places — analyzer, API and UI —
 * that can quietly disagree.
 *
 * The three levels are not a quality score:
 *
 * - `EXACT` — the format stores the property and PalCert reads it.
 * - `DERIVED` — PalCert computes it from the format under a documented
 *   definition, and the evidence is labelled derived so a reader knows it was
 *   measured rather than declared.
 * - `ADVISORY` — PalCert *recognized* it. The population is a lower bound
 *   rather than a total, the facts carry `sourceKind: HEURISTIC`, and the
 *   evaluator returns INDETERMINATE on them: an advisory property can be
 *   reported and can never pass or fail a document (Phase 18, Checkpoint 15).
 * - `UNSUPPORTED` — the format cannot answer. A rule about it is
 *   INDETERMINATE, never PASS (§69).
 *
 * `ADVISORY` is not a weaker `EXACT` and not a variant of `DERIVED`. Both of
 * those are computations over what the format stores, exhaustive and
 * repeatable; this one is a belief about what the document contains.
 */
export type PropertySupport = 'EXACT' | 'DERIVED' | 'ADVISORY' | 'UNSUPPORTED';

/**
 * Can a rule about this property ever produce an authoritative verdict?
 *
 * The one question a caller should ask rather than comparing strings: a new
 * non-authoritative level added later is then handled everywhere at once.
 */
export function isAuthoritativeSupport(support: PropertySupport): boolean {
  return support === 'EXACT' || support === 'DERIVED';
}

export interface PropertySupportEntry {
  readonly name: string;
  readonly scopes: readonly string[];
  /**
   * The element types an ELEMENT-scoped property is emitted for (registry v2).
   *
   * Absent means the row does not say, which is how every Phase 13 row is
   * written. Present, it is closed: a rule naming an element type outside it
   * is asking for a fact no analyzer produces.
   */
  readonly elementTypes?: readonly string[];
  readonly valueKind: string;
  readonly unit: string | null;
  readonly docx: { readonly support: PropertySupport; readonly note: string };
  readonly pdf: { readonly support: PropertySupport; readonly note: string };
}

export const PROPERTY_SUPPORT_REGISTRY_VERSION = DOCUMENT_PROPERTY_SUPPORT_REGISTRY.registryVersion;

export const PROPERTY_SUPPORT: readonly PropertySupportEntry[] =
  DOCUMENT_PROPERTY_SUPPORT_REGISTRY.properties as readonly PropertySupportEntry[];

const BY_NAME = new Map(PROPERTY_SUPPORT.map((entry) => [entry.name, entry]));

export function propertySupportEntry(name: string): PropertySupportEntry | null {
  return BY_NAME.get(name) ?? null;
}

/**
 * How well `format` can answer `property`.
 *
 * An unknown property is `UNSUPPORTED` rather than an exception: a standard may
 * legitimately reference a property no analyzer implements yet, and the honest
 * answer is "this format cannot tell you", not a crash (§97 of Phase 6).
 */
export function supportFor(format: DocumentFormat, property: string): PropertySupport {
  const entry = BY_NAME.get(property);
  if (entry === undefined) return 'UNSUPPORTED';
  return format === 'PDF' ? entry.pdf.support : entry.docx.support;
}

export function supportNoteFor(format: DocumentFormat, property: string): string | null {
  const entry = BY_NAME.get(property);
  if (entry === undefined) return null;
  return format === 'PDF' ? entry.pdf.note : entry.docx.note;
}

/**
 * Pairs that measure something similar and mean something different.
 *
 * Kept in the registry rather than in a comment because the temptation to
 * satisfy a margin rule with an ink measurement is exactly the kind of thing
 * that looks like a coverage improvement in a review (§62).
 */
export const DISTINCT_SEMANTICS = DOCUMENT_PROPERTY_SUPPORT_REGISTRY.distinctSemantics;

/**
 * Whether `property` is emitted for `elementType`.
 *
 * A row that declares no element types answers `true` for any of them: it is
 * not claiming to know, and Phase 13 wrote every row that way. A row that does
 * declare them answers only for those — which is what keeps a citation
 * property from reading as though it also applied to a reference entry, an
 * element type that carries no properties at all.
 */
export function propertySupportsElementType(property: string, elementType: string): boolean {
  const entry = BY_NAME.get(property);
  if (entry === undefined) return false;
  if (!entry.scopes.includes('ELEMENT')) return false;
  return entry.elementTypes === undefined || entry.elementTypes.includes(elementType);
}
