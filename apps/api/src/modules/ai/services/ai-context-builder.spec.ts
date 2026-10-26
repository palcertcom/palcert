import { AIContextBuilder, type StructuralParagraph } from './ai-context-builder.service';
import type { ApiConfigService } from '../../../config/api-config.service';
import type { ContextRule } from '@palcert/contracts';

/**
 * Data minimization (§15, §16, §17, §50, §88).
 *
 * The builder's job is to send less. These tests assert the properties that
 * make that real: that selection is driven by the rule rather than by "all of
 * it", that budgets are enforced per node and per request, and — most
 * importantly — that whatever is left out is declared rather than silently
 * dropped.
 */

function config(overrides: Partial<ReturnType<() => ApiConfigService['ai']>> = {}) {
  return {
    ai: {
      enabled: true,
      provider: 'fake' as const,
      model: 'fake-model-1',
      maxInputTokens: 60_000,
      maxOutputTokens: 8_000,
      maxRulesPerRequest: 10,
      maxContextChars: 10_000,
      maxNodeChars: 200,
      maxContextNodes: 10,
      maxAttempts: 3,
      retryBaseMs: 1,
      retryMaxMs: 2,
      retentionPolicy: 'PROVIDER_STANDARD',
      policyUrl: undefined,
      ...overrides,
    },
  } as unknown as ApiConfigService;
}

function paragraph(nodeId: string, text: string, headingLevel?: number): StructuralParagraph {
  return {
    locator: { nodeId },
    text,
    ...(headingLevel === undefined ? {} : { headingLevel }),
  };
}

const COI_RULE: ContextRule = {
  ruleCode: 'COI.DECLARATION',
  category: 'DECLARATIONS',
  severity: 'MAJOR',
  blocking: true,
  titleEn: 'Conflict of interest declared',
};

function build(
  paragraphs: StructuralParagraph[],
  rules: ContextRule[] = [COI_RULE],
  overrides = {},
) {
  return new AIContextBuilder(config(overrides)).build({
    purpose: 'RULE_ASSESSMENT',
    artifact: { structuralModel: { paragraphs } },
    rules,
    deterministicFindings: [],
  });
}

describe('AIContextBuilder', () => {
  it('selects the paragraphs a rule needs, not the whole document', () => {
    const bundle = build([
      paragraph('main/body/p:1', 'Chapter 1: a long discussion of methodology.'),
      paragraph('main/body/p:2', 'The authors declare no conflict of interest.'),
      paragraph('main/body/p:3', 'Further unrelated discussion of results.'),
    ]);

    const ids = bundle.nodes.map((node) => node.nodeId);
    expect(ids).toContain('main/body/p:2');
    expect(ids).not.toContain('main/body/p:3');
  });

  it('finds an Arabic declaration as readily as an English one', () => {
    const bundle = build([
      paragraph('main/body/p:1', 'مقدمة الدراسة ومنهجيتها.'),
      paragraph('main/body/p:2', 'يقر المؤلفون بعدم وجود تضارب في المصالح.'),
    ]);
    expect(bundle.nodes.map((node) => node.nodeId)).toContain('main/body/p:2');
  });

  it('builds an outline from headings alone', () => {
    const bundle = build([
      paragraph('main/body/p:1', 'Introduction', 1),
      paragraph('main/body/p:2', 'Body text that is not a heading.'),
      paragraph('main/body/p:3', 'Declarations', 2),
    ]);

    expect(bundle.outline).toEqual([
      { nodeId: 'main/body/p:1', level: 1, text: 'Introduction' },
      { nodeId: 'main/body/p:3', level: 2, text: 'Declarations' },
    ]);
  });

  it('caps one enormous paragraph rather than letting it eat the budget', () => {
    // A reference list or a pasted table must not consume the whole request
    // and crowd out the declaration the rule actually needs (§88).
    const bundle = build([paragraph('main/body/p:1', `conflict of interest ${'x'.repeat(5_000)}`)]);

    expect(bundle.nodes[0]!.text.length).toBe(200);
    expect(bundle.nodes[0]!.truncated).toBe(true);
    expect(bundle.truncation.truncated).toBe(true);
  });

  it('declares truncation rather than silently dropping context', () => {
    // The property that matters most: a model told it has the whole document
    // when it has a fraction will conclude confidently about evidence nobody
    // sent it (§50).
    const many = Array.from({ length: 30 }, (_, index) =>
      paragraph(`main/body/p:${index + 1}`, 'conflict of interest disclosure statement'),
    );
    const bundle = build(many);

    expect(bundle.nodes).toHaveLength(10);
    expect(bundle.truncation.truncated).toBe(true);
    expect(bundle.truncation.droppedNodeCount).toBe(20);
    expect(bundle.truncation.reason).toBe('NODE_BUDGET');
  });

  it('enforces the per-request character budget', () => {
    const bundle = build(
      Array.from({ length: 10 }, (_, index) =>
        paragraph(`main/body/p:${index + 1}`, `conflict of interest ${'y'.repeat(150)}`),
      ),
      [COI_RULE],
      { maxContextChars: 400, maxNodeChars: 200 },
    );

    const total = bundle.nodes.reduce((sum, node) => sum + node.text.length, 0);
    expect(total).toBeLessThanOrEqual(400);
    expect(bundle.truncation.truncated).toBe(true);
  });

  it('never includes OOXML internals or run-level structure', () => {
    const bundle = build([paragraph('main/body/p:1', 'conflict of interest')]);
    const serialized = JSON.stringify(bundle);
    expect(serialized).not.toMatch(/styleId|runs|effective|docDefaults|w:|rPr/);
  });

  it('is deterministic, so the same input hashes the same way', () => {
    const paragraphs = [
      paragraph('main/body/p:1', 'Introduction', 1),
      paragraph('main/body/p:2', 'The authors declare no conflict of interest.'),
    ];
    expect(JSON.stringify(build(paragraphs))).toBe(JSON.stringify(build(paragraphs)));
  });

  it('records the builder version, so an old review stays explicable', () => {
    // Changing what this class selects changes what the model sees, and
    // therefore what it may conclude (§18).
    expect(build([]).contextBuilderVersion).toBe('1');
    expect(build([]).contextSchemaVersion).toBe(1);
  });

  it('falls back to bounded front matter when no keyword matches', () => {
    // Declarations and identifying material live at the beginning far more
    // often than not; sending the first pages is a bounded guess, where
    // sending everything is not.
    const bundle = build(
      Array.from({ length: 100 }, (_, index) =>
        paragraph(`main/body/p:${index + 1}`, `ordinary prose ${index}`),
      ),
      [{ ruleCode: 'SOMETHING.UNMAPPED', severity: 'MINOR', blocking: false }],
    );
    expect(bundle.nodes.length).toBeLessThanOrEqual(10);
    expect(bundle.nodes[0]!.nodeId).toBe('main/body/p:1');
  });
});
