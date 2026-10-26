import Anthropic from '@anthropic-ai/sdk';
import { AnthropicAIProvider } from '../src/infrastructure/ai/anthropic-provider';
import { ANTHROPIC_PROPOSAL_SCHEMA } from '../src/infrastructure/ai/anthropic-proposal-dto';
import { providerOutputFormat } from '../src/infrastructure/ai/provider-output-schema';
import {
  buildEvidenceDiscoveryInstruction,
  buildRuleStructuringPrompt,
} from '../src/infrastructure/ai/extraction-prompt-builder';
import { PromptId, promptTemplate } from '../src/infrastructure/ai/prompt-registry';
import type { ApiConfigService } from '../src/config/api-config.service';
import { minimalPdf } from './support/fixtures';

/**
 * The optional live extraction smoke test (§149).
 *
 * Skipped unless `PALCERT_LIVE_AI_TEST=1` **and** a real key is present, so
 * normal CI never needs a credential and never spends money. When it does run
 * it sends a three-sentence synthetic guideline PDF invented for this file: no
 * repository content, no institution's real guidelines, no customer document.
 *
 * What it proves is the two-pass architecture against the real API — that
 * citations come back from a document block, that structured output comes back
 * from the second call, and crucially that PalCert never combines the two in
 * one request, which the current API rejects (§138).
 *
 * It deliberately asserts nothing about the model's prose or about how many
 * requirements it finds. A live test that pinned either would fail on every
 * model revision for reasons that say nothing about the integration.
 */

const LIVE =
  process.env['PALCERT_LIVE_AI_TEST'] === '1' && process.env['ANTHROPIC_API_KEY'] !== undefined;
const describeLive = LIVE ? describe : describe.skip;

/** Three invented sentences. Nothing here belongs to anyone. */
const SYNTHETIC_GUIDELINE = [
  'Thesis formatting guidelines, 2026 edition.',
  'The left margin must be 30 mm on every page.',
  'Body text must be set in 12 pt Times New Roman.',
  'Use appropriate spacing throughout the document.',
].join(' ');

describeLive('Anthropic live extraction smoke test', () => {
  function provider(): AnthropicAIProvider {
    const config = {
      ai: { enabled: true, maxInputTokens: 20_000 },
      anthropic: {
        apiKey: process.env['ANTHROPIC_API_KEY'],
        model: process.env['ANTHROPIC_MODEL'] ?? 'claude-opus-5',
        maxOutputTokens: 4_096,
        timeoutMs: 120_000,
        effort: undefined,
        baseUrl: undefined,
      },
    } as unknown as ApiConfigService;
    return new AnthropicAIProvider(config);
  }

  /**
   * Does the provider compile the Pass B wire schema at all? The live failure
   * on 8443 was a 400 "The compiled grammar is too large", before any
   * output. A tiny request with the real schema answers that directly and
   * costs a few tokens.
   *
   * If it does not compile, this measures rather than guesses: it retries
   * with each enum field relaxed to a plain string, one at a time, and reports
   * which relaxations compile. Nothing is changed in the product by this test.
   */
  it('compiles the Pass B wire schema (grammar size)', async () => {
    const client = new Anthropic({ apiKey: process.env['ANTHROPIC_API_KEY'], maxRetries: 0 });
    const model = process.env['ANTHROPIC_MODEL'] ?? 'claude-opus-5';
    const compiles = async (schema: Record<string, unknown>): Promise<string> => {
      try {
        await client.messages.create({
          model,
          max_tokens: 64,
          messages: [{ role: 'user', content: 'Return an object with an empty proposals list.' }],
          output_config: { format: providerOutputFormat(schema, { transform: false }) },
        });
        return 'compiles';
      } catch (error) {
        if (error instanceof Anthropic.BadRequestError) {
          const body = error.error as { error?: { message?: string } } | undefined;
          return `400: ${(body?.error?.message ?? '').slice(0, 160)}`;
        }
        throw error;
      }
    };

    const verdict = await compiles(ANTHROPIC_PROPOSAL_SCHEMA);
    if (verdict !== 'compiles') {
      const report: string[] = [`full schema: ${verdict}`];
      const rule = (
        (
          (
            (ANTHROPIC_PROPOSAL_SCHEMA.properties as Record<string, Record<string, unknown>>)
              .proposals!.items as Record<string, unknown>
          ).properties as Record<string, Record<string, unknown>>
        ).suggestedRule!.items as Record<string, unknown>
      ).properties as Record<string, Record<string, unknown>>;
      for (const [field, definition] of Object.entries(rule)) {
        if (!Array.isArray(definition.enum)) continue;
        const relaxed = structuredClone(ANTHROPIC_PROPOSAL_SCHEMA);
        const target = (
          (
            (
              (relaxed.properties as Record<string, Record<string, unknown>>).proposals!
                .items as Record<string, unknown>
            ).properties as Record<string, Record<string, unknown>>
          ).suggestedRule!.items as Record<string, unknown>
        ).properties as Record<string, Record<string, unknown>>;
        delete target[field]!.enum;
        report.push(
          `without ${field} enum (${definition.enum.length} values): ${await compiles(relaxed)}`,
        );
      }
      throw new Error(`the Pass B schema does not compile:\n${report.join('\n')}`);
    }
    expect(verdict).toBe('compiles');
  }, 600_000);

  it('grounds evidence in real page citations (Pass A)', async () => {
    const template = promptTemplate(PromptId.GUIDELINE_EVIDENCE_DISCOVERY);
    const response = await provider().discoverGuidelineEvidence({
      extractionRunId: 'live-smoke',
      systemPrompt: template.system,
      instruction: buildEvidenceDiscoveryInstruction({
        sourceLabels: ['synthetic-guidelines.pdf'],
        truncated: false,
      }),
      documents: [
        {
          kind: 'PDF',
          sourceAssetId: 'live-source',
          title: 'synthetic-guidelines.pdf',
          bytes: minimalPdf(SYNTHETIC_GUIDELINE),
        },
      ],
    });

    // Contract properties only: something was cited, it came from the document
    // PalCert sent, and it carries a page.
    expect(response.citations.length).toBeGreaterThan(0);
    for (const citation of response.citations) {
      expect(citation.sourceAssetId).toBe('live-source');
      expect(citation.citedText.length).toBeGreaterThan(0);
      if (citation.kind === 'PDF_PAGE') {
        expect(citation.startPage).toBeGreaterThanOrEqual(1);
        expect(citation.endPage).toBeGreaterThanOrEqual(citation.startPage);
      }
    }
    expect(response.usage.inputTokens).toBeGreaterThan(0);
    expect(response.usage.providerReturnedModel).toBeTruthy();
  }, 180_000);

  it('returns schema-constrained proposals from verified evidence (Pass B)', async () => {
    const template = promptTemplate(PromptId.GUIDELINE_RULE_STRUCTURING);
    const response = await provider().extractRuleProposals({
      extractionRunId: 'live-smoke',
      systemPrompt: template.system,
      userPrompt: buildRuleStructuringPrompt({
        vocabulary: {
          ruleSchemaVersion: 2,
          categories: ['MARGINS', 'TYPOGRAPHY', 'SPACING'],
          operators: [{ operator: 'EQUALS', valueTypes: ['NUMBER', 'STRING'] }],
          units: ['MILLIMETRE', 'POINT'],
          patterns: ['TITLE_CASE'],
          elementTypes: ['PARAGRAPH'],
          origins: ['ORGANIZATION_POLICY'],
          severities: ['MAJOR'],
        },
        properties: [
          { name: 'marginLeft', scopes: ['PAGE'], unit: 'MILLIMETRE', support: 'SUPPORTED_DOCX' },
          { name: 'fontSize', scopes: ['ELEMENT'], unit: 'POINT', support: 'SUPPORTED_DOCX' },
        ],
        evidence: [
          {
            evidenceId: 'ev-1',
            sourceLabel: 'synthetic-guidelines.pdf',
            sourceKind: 'GUIDELINE_PDF',
            evidenceKind: 'EXPLICIT_TEXT',
            locatorType: 'PDF_PAGE',
            locatorLabel: 'page 1',
            excerpt: 'The left margin must be 30 mm on every page.',
          },
          {
            evidenceId: 'ev-2',
            sourceLabel: 'synthetic-guidelines.pdf',
            sourceKind: 'GUIDELINE_PDF',
            evidenceKind: 'EXPLICIT_TEXT',
            locatorType: 'PDF_PAGE',
            locatorLabel: 'page 1',
            excerpt: 'Use appropriate spacing throughout the document.',
          },
        ],
        observations: [],
        existingRules: [],
        maxProposals: 10,
      }),
      suppliedEvidenceIds: ['ev-1', 'ev-2'],
    });

    expect(Array.isArray(response.output.proposals)).toBe(true);
    for (const proposal of response.output.proposals) {
      // Only evidence PalCert supplied. A live model inventing an id is the
      // exact failure the validator exists to catch (§55).
      for (const evidenceId of proposal.evidenceIds) {
        expect(['ev-1', 'ev-2']).toContain(evidenceId);
      }
    }
    expect(response.usage.outputTokens).toBeGreaterThan(0);
  }, 180_000);

  it('never asks the API for citations and structured output together', async () => {
    // The architectural invariant behind the whole two-pass design (§138). It
    // is asserted here against the live API because that is where a violation
    // would actually show up — as a 400.
    const template = promptTemplate(PromptId.GUIDELINE_EVIDENCE_DISCOVERY);
    const discovery = await provider().discoverGuidelineEvidence({
      extractionRunId: 'live-smoke',
      systemPrompt: template.system,
      instruction: 'Quote any requirement you find.',
      documents: [
        {
          kind: 'BLOCKS',
          sourceAssetId: 'live-source',
          title: 'synthetic-instructions',
          blocks: ['The left margin must be 30 mm.', 'Body text is 12 pt.'],
          nodeIds: ['main/body/p:1', 'main/body/p:2'],
        },
      ],
    });

    // A custom-content citation maps back to a PalCert node index.
    for (const citation of discovery.citations) {
      if (citation.kind !== 'DOCX_BLOCK') continue;
      expect(citation.startBlockIndex).toBeGreaterThanOrEqual(0);
      expect(citation.endBlockIndex).toBeGreaterThan(citation.startBlockIndex);
      expect(citation.endBlockIndex).toBeLessThanOrEqual(2);
    }
  }, 180_000);
});
