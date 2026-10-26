import { Injectable } from '@nestjs/common';
import {
  AI_CONTEXT_BUILDER_VERSION,
  AI_CONTEXT_SCHEMA_VERSION,
  type AIContextBundle,
  type ContextNode,
  type ContextRule,
  type DeterministicFinding,
  type OutlineEntry,
} from '@palcert/contracts';
import { ApiConfigService } from '../../../config/api-config.service';

/**
 * Building the bounded context one AI task may see (§15, §16, §17, §86).
 *
 * This class is the privacy boundary of Phase 8. Everything a provider ever
 * learns about a user's document passes through it, and its job is to send as
 * little as the task genuinely needs.
 *
 * The easy implementation — serialize the document and let the model sort it
 * out — is the one thing that must not happen. A PalCert user is uploading
 * unpublished research months before submission; shipping all of it to a third
 * party because that was less code would be a betrayal of the reason they
 * trusted the platform with it.
 *
 * So selection is driven by the *rule*. An ethics-declaration rule gets the
 * declaration candidates; an anonymization rule gets author metadata and the
 * front matter where names leak; a conflict-of-interest rule gets the headings
 * and paragraphs that plausibly hold one. Nothing gets the whole manuscript,
 * and nothing gets OOXML internals.
 *
 * Its version is persisted with every review. Changing what this class selects
 * changes what the model sees and therefore what it may conclude, so an old
 * review is only explicable if PalCert recorded which selection produced it
 * (§18).
 */

export interface StructuralParagraph {
  readonly locator?: { readonly nodeId?: string; readonly story?: string };
  readonly text?: string;
  readonly headingLevel?: number;
  readonly sectionKey?: string;
  readonly story?: string;
}

export interface BuildContextInput {
  readonly purpose: 'RULE_ASSESSMENT' | 'REPORT_SUPPLEMENT';
  /** The Phase 6 artifact, already verified against its recorded digest. */
  readonly artifact: {
    readonly structuralModel?: { readonly paragraphs?: readonly StructuralParagraph[] };
  };
  readonly rules: readonly ContextRule[];
  readonly deterministicFindings: readonly DeterministicFinding[];
  readonly metadata?: AIContextBundle['metadata'];
}

/**
 * Keyword sets that decide which paragraphs a semantic rule plausibly needs.
 *
 * Deliberately bilingual and deliberately generous within a small budget: a
 * declaration PalCert fails to select is a rule the model must answer
 * INSUFFICIENT_EVIDENCE for, which is the correct failure mode — far better
 * than widening selection to "send everything" so nothing is ever missed.
 */
const RULE_KEYWORDS: ReadonlyArray<{
  readonly match: RegExp;
  readonly terms: readonly string[];
}> = [
  {
    match: /ETHIC|IRB|APPROVAL/i,
    terms: [
      'ethic',
      'ethics',
      'irb',
      'institutional review',
      'consent',
      'approval',
      'أخلاق',
      'إقرار',
      'موافقة',
    ],
  },
  {
    match: /CONFLICT|COI|INTEREST/i,
    terms: [
      'conflict of interest',
      'competing interest',
      'conflicts',
      'disclosure',
      'تضارب',
      'المصالح',
      'إفصاح',
    ],
  },
  {
    match: /DATA.?AVAIL|AVAILABILITY/i,
    terms: [
      'data availability',
      'data are available',
      'dataset',
      'repository',
      'إتاحة',
      'البيانات',
    ],
  },
  {
    match: /ANONYM|BLIND|IDENTIF/i,
    terms: [
      'author',
      'affiliation',
      'university',
      'department',
      'email',
      'correspond',
      'مؤلف',
      'الجامعة',
      'القسم',
    ],
  },
  {
    match: /FUND|GRANT|ACKNOWLEDG/i,
    terms: ['funding', 'grant', 'funded', 'acknowledg', 'تمويل', 'منحة', 'شكر'],
  },
  {
    match: /ABSTRACT|KEYWORD/i,
    terms: ['abstract', 'keywords', 'ملخص', 'كلمات مفتاحية'],
  },
  {
    match: /REFERENC|CITATION|BIBLIO/i,
    terms: ['references', 'bibliography', 'cited', 'مراجع', 'المصادر'],
  },
];

@Injectable()
export class AIContextBuilder {
  constructor(private readonly config: ApiConfigService) {}

  readonly version = AI_CONTEXT_BUILDER_VERSION;

  build(input: BuildContextInput): AIContextBundle {
    const limits = this.config.ai;
    const paragraphs = input.artifact.structuralModel?.paragraphs ?? [];

    const outline = this.buildOutline(paragraphs);
    const terms = this.termsFor(input.rules);
    const selection = this.selectNodes(paragraphs, terms);
    const selected = selection.selected;

    // Paragraphs dropped while *selecting* count as truncation too. Reporting
    // only what the write loop discarded would understate how much of the
    // document the model never saw, which is exactly the silence §50 forbids.
    let droppedNodeCount = selection.dropped;
    let hitNodeBudget = selection.dropped > 0;
    let truncatedNodeCount = 0;
    let usedChars = 0;
    const nodes: ContextNode[] = [];

    for (const paragraph of selected) {
      if (nodes.length >= limits.maxContextNodes) {
        droppedNodeCount += 1;
        hitNodeBudget = true;
        continue;
      }
      const nodeId = paragraph.locator?.nodeId;
      const raw = (paragraph.text ?? '').trim();
      if (nodeId === undefined || raw === '') continue;

      // Per-node cap first, so one enormous paragraph — a reference list, a
      // pasted table — cannot consume the whole request budget (§88).
      const bounded = raw.length > limits.maxNodeChars ? raw.slice(0, limits.maxNodeChars) : raw;
      if (usedChars + bounded.length > limits.maxContextChars) {
        droppedNodeCount += 1;
        continue;
      }
      usedChars += bounded.length;
      if (bounded.length < raw.length) truncatedNodeCount += 1;

      nodes.push({
        nodeId,
        text: bounded,
        ...(bounded.length < raw.length ? { truncated: true } : {}),
        ...(paragraph.story !== undefined
          ? { story: paragraph.story as ContextNode['story'] }
          : {}),
        ...(paragraph.sectionKey !== undefined ? { sectionKey: paragraph.sectionKey } : {}),
        ...(paragraph.headingLevel !== undefined ? { headingLevel: paragraph.headingLevel } : {}),
      });
    }

    const droppedOutlineCount = Math.max(0, outline.total - outline.entries.length);
    const truncated = droppedNodeCount > 0 || truncatedNodeCount > 0 || droppedOutlineCount > 0;

    return {
      contextSchemaVersion: AI_CONTEXT_SCHEMA_VERSION,
      contextBuilderVersion: this.version,
      purpose: input.purpose,
      outline: outline.entries,
      nodes,
      metadata: input.metadata ?? {},
      deterministicFindings: [...input.deterministicFindings],
      rules: [...input.rules],
      truncation: {
        truncated,
        droppedNodeCount,
        truncatedNodeCount,
        droppedOutlineCount,
        reason: !truncated ? 'NONE' : hitNodeBudget ? 'NODE_BUDGET' : 'CHARACTER_BUDGET',
      },
    };
  }

  /**
   * The document's shape, from headings alone.
   *
   * An outline is how a model learns where a declaration would live without
   * being shown the body of the work.
   */
  private buildOutline(paragraphs: readonly StructuralParagraph[]): {
    entries: OutlineEntry[];
    total: number;
  } {
    const headings = paragraphs.filter(
      (paragraph) =>
        paragraph.headingLevel !== undefined &&
        paragraph.locator?.nodeId !== undefined &&
        (paragraph.text ?? '').trim() !== '',
    );
    const entries = headings.slice(0, 400).map<OutlineEntry>((paragraph) => ({
      nodeId: paragraph.locator!.nodeId!,
      level: Math.min(Math.max(paragraph.headingLevel!, 1), 9),
      text: (paragraph.text ?? '').trim().slice(0, 300),
    }));
    return { entries, total: headings.length };
  }

  /** Which keywords this batch of rules makes relevant. */
  private termsFor(rules: readonly ContextRule[]): readonly string[] {
    const terms = new Set<string>();
    for (const rule of rules) {
      const haystack = [rule.ruleCode, rule.category ?? '', rule.titleEn ?? ''].join(' ');
      for (const entry of RULE_KEYWORDS) {
        if (entry.match.test(haystack)) {
          for (const term of entry.terms) terms.add(term.toLowerCase());
        }
      }
    }
    return [...terms];
  }

  /**
   * Select the paragraphs a rule batch plausibly needs.
   *
   * Scored rather than filtered, so the most relevant material survives the
   * budget rather than whatever happened to come first in the document. When
   * no keyword matches at all, the front matter is used: declarations and
   * identifying material live at the beginning far more often than not, and
   * sending the first pages is a bounded guess where sending everything is not.
   */
  private selectNodes(
    paragraphs: readonly StructuralParagraph[],
    terms: readonly string[],
  ): { selected: readonly StructuralParagraph[]; dropped: number } {
    const budget = this.config.ai.maxContextNodes;

    if (terms.length === 0) {
      return {
        selected: paragraphs.slice(0, budget),
        dropped: Math.max(0, paragraphs.length - budget),
      };
    }

    const scored: Array<{ paragraph: StructuralParagraph; score: number; index: number }> = [];
    paragraphs.forEach((paragraph, index) => {
      const text = (paragraph.text ?? '').toLowerCase();
      if (text.trim() === '') return;
      let score = 0;
      for (const term of terms) {
        if (text.includes(term)) score += paragraph.headingLevel === undefined ? 2 : 3;
      }
      // A paragraph immediately under a matching *heading* is usually the
      // declaration itself, so proximity earns a little weight. Restricted to
      // headings deliberately: crediting any paragraph that follows a match
      // would drag in whatever happened to come after a declaration.
      if (score === 0 && index > 0) {
        const previous = paragraphs[index - 1];
        const previousText = (previous?.text ?? '').toLowerCase();
        if (
          previous?.headingLevel !== undefined &&
          terms.some((term) => previousText.includes(term))
        ) {
          score += 1;
        }
      }
      if (score > 0) scored.push({ paragraph, score, index });
    });

    if (scored.length === 0) {
      const fallback = Math.min(40, budget);
      return {
        selected: paragraphs.slice(0, fallback),
        dropped: Math.max(0, paragraphs.length - fallback),
      };
    }

    const selected = scored
      // Highest score first; document order breaks ties, so the selection is
      // deterministic and the context hash is reproducible.
      .sort((left, right) => right.score - left.score || left.index - right.index)
      .slice(0, budget)
      .sort((left, right) => left.index - right.index)
      .map((entry) => entry.paragraph);

    return { selected, dropped: Math.max(0, scored.length - selected.length) };
  }
}
