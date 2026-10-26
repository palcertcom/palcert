/* eslint-disable */
/**
 * GENERATED FILE — DO NOT EDIT.
 *
 * Source: contracts/schemas/ai-context.schema.json
 * Regenerate: pnpm --filter @palcert/contracts run generate:evaluation
 *
 * Editing this by hand would reintroduce exactly the drift the generation step
 * exists to prevent.
 */
/**
 * A Phase 6 structural locator, e.g. `main/body/p:17`. Locators, never selectors: nothing evaluates them as a path expression, and nothing accepts one from a client.
 *
 * This interface was referenced by `PalCertAIContextBundle`'s JSON-Schema
 * via the `definition` "NodeId".
 */
export type NodeId = string;

/**
 * The bounded, sanitized representation of a document that PalCert sends to an AI provider.
 *
 * Its entire purpose is to be *less* than the document. A thesis is unpublished research, and the default must never be to ship the whole of it to a third party because that was the easiest thing to build. The bundle carries an outline, the specific nodes a task needs, safe metadata, and the deterministic findings already computed — and says explicitly, in `truncation`, whatever it had to leave out.
 *
 * Every text field here is UNTRUSTED. It is authored by whoever wrote the document or the standard, and it reaches the model only inside data delimiters, never as an instruction.
 */
export interface PalCertAIContextBundle {
  [k: string]: unknown;
}
/**
 * One heading. The outline is how a model learns a document's shape without reading it.
 *
 * This interface was referenced by `PalCertAIContextBundle`'s JSON-Schema
 * via the `definition` "OutlineEntry".
 */
export interface OutlineEntry {
  nodeId: NodeId;
  level: number;
  text: string;
}
/**
 * One selected paragraph. `text` is bounded per node and `truncated` says so when it was cut — a model told a paragraph ends where it does not will reason about a sentence nobody wrote.
 *
 * This interface was referenced by `PalCertAIContextBundle`'s JSON-Schema
 * via the `definition` "ContextNode".
 */
export interface ContextNode {
  nodeId: NodeId;
  story?: 'MAIN_DOCUMENT' | 'HEADER' | 'FOOTER' | 'FOOTNOTE' | 'ENDNOTE' | 'TEXTBOX' | 'COMMENT';
  sectionKey?: string;
  headingLevel?: number;
  text: string;
  truncated?: boolean;
}
/**
 * Document-level facts a semantic rule may genuinely need — an anonymization rule has to see the author metadata to say whether it leaks. Nothing else from the package is included.
 *
 * This interface was referenced by `PalCertAIContextBundle`'s JSON-Schema
 * via the `definition` "ContextMetadata".
 */
export interface ContextMetadata {
  paragraphCount?: number;
  wordCount?: number;
  sectionCount?: number;
  hasTrackedChanges?: boolean;
  declaredAuthor?: string;
  declaredTitle?: string;
  declaredCompany?: string;
}
/**
 * A Phase 7 machine result, supplied so the model can explain it rather than re-measure it. These values are authoritative; the model may restate them and must never contradict them.
 *
 * This interface was referenced by `PalCertAIContextBundle`'s JSON-Schema
 * via the `definition` "DeterministicFinding".
 */
export interface DeterministicFinding {
  ruleCode: string;
  outcome: 'PASS' | 'FAIL' | 'NOT_APPLICABLE' | 'INDETERMINATE' | 'ERROR';
  reasonCode?: string;
  severity: 'INFO' | 'MINOR' | 'MAJOR' | 'CRITICAL';
  blocking: boolean;
  titleEn?: string;
  titleAr?: string;
  expectedValue?: string;
  actualValue?: string;
  unit?: string;
  violationCount?: number;
}
/**
 * One AI-assisted rule, as the standard's author wrote it. Titles and guidance are organization-authored text and therefore untrusted in exactly the way document text is.
 *
 * This interface was referenced by `PalCertAIContextBundle`'s JSON-Schema
 * via the `definition` "ContextRule".
 */
export interface ContextRule {
  ruleCode: string;
  category?: string;
  severity: 'INFO' | 'MINOR' | 'MAJOR' | 'CRITICAL';
  blocking: boolean;
  titleEn?: string;
  titleAr?: string;
  guidanceEn?: string;
  guidanceAr?: string;
}
/**
 * What the builder left out. Never silent: an assessment made on a quarter of the evidence, presented as complete, is worse than no assessment.
 *
 * This interface was referenced by `PalCertAIContextBundle`'s JSON-Schema
 * via the `definition` "ContextTruncation".
 */
export interface ContextTruncation {
  truncated: boolean;
  droppedNodeCount?: number;
  truncatedNodeCount?: number;
  droppedOutlineCount?: number;
  reason?: 'NONE' | 'NODE_BUDGET' | 'CHARACTER_BUDGET' | 'TOKEN_BUDGET';
}
/**
 * Everything one provider request may see about the document. Hashed as `contextHash` so an invocation can prove what it supplied without storing the prompt.
 *
 * This interface was referenced by `PalCertAIContextBundle`'s JSON-Schema
 * via the `definition` "AIContextBundle".
 */
export interface AIContextBundle {
  contextSchemaVersion: number;
  contextBuilderVersion: string;
  purpose: 'RULE_ASSESSMENT' | 'REPORT_SUPPLEMENT';
  /**
   * @maxItems 400
   */
  outline: OutlineEntry[];
  /**
   * @maxItems 400
   */
  nodes: ContextNode[];
  metadata: ContextMetadata;
  /**
   * @maxItems 1000
   */
  deterministicFindings: DeterministicFinding[];
  /**
   * @maxItems 100
   */
  rules: ContextRule[];
  truncation: ContextTruncation;
}
