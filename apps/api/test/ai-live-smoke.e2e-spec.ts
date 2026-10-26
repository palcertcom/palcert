import { AIProviderError } from '@palcert/contracts';
import { AnthropicAIProvider } from '../src/infrastructure/ai/anthropic-provider';
import type { ApiConfigService } from '../src/config/api-config.service';

/**
 * The optional live Anthropic smoke test (§93, §114).
 *
 * Skipped unless `PALCERT_LIVE_AI_TEST=1` **and** a real key is present, so
 * normal CI never needs a credential and never spends money (§94). When it
 * does run it sends a tiny synthetic prompt — three invented sentences, no
 * repository content, no customer document — and asserts only the contract
 * properties: that a structured response comes back, that the configured and
 * returned models are recorded, and that usage and a request id are captured.
 *
 * It deliberately asserts nothing about the model's prose. A live test that
 * pinned wording would fail on every model revision for reasons that say
 * nothing about whether the integration works.
 */

const LIVE =
  process.env['PALCERT_LIVE_AI_TEST'] === '1' && process.env['ANTHROPIC_API_KEY'] !== undefined;
const describeLive = LIVE ? describe : describe.skip;

describeLive('Anthropic live smoke test', () => {
  function provider(): AnthropicAIProvider {
    const config = {
      ai: { enabled: true, maxInputTokens: 10_000 },
      anthropic: {
        apiKey: process.env['ANTHROPIC_API_KEY'],
        model: process.env['ANTHROPIC_MODEL'] ?? 'claude-opus-5',
        // Deliberately small: this test proves the integration, not the model.
        maxOutputTokens: 1_024,
        timeoutMs: 60_000,
        effort: undefined,
        baseUrl: undefined,
      },
    } as unknown as ApiConfigService;
    return new AnthropicAIProvider(config);
  }

  /** Three invented sentences. Nothing from this repository, nothing real. */
  const context = {
    contextSchemaVersion: 1,
    contextBuilderVersion: '1',
    purpose: 'RULE_ASSESSMENT' as const,
    outline: [{ nodeId: 'main/body/p:1', level: 2, text: 'Declarations' }],
    nodes: [{ nodeId: 'main/body/p:2', text: 'The authors declare no competing interests.' }],
    metadata: {},
    deterministicFindings: [],
    rules: [{ ruleCode: 'COI.DECLARATION', severity: 'MAJOR' as const, blocking: false }],
    truncation: { truncated: false, reason: 'NONE' as const },
  };

  it('completes an authenticated, schema-constrained request', async () => {
    const { promptTemplate, PromptId } = await import('../src/infrastructure/ai/prompt-registry');
    const { buildRuleAssessmentPrompt } = await import('../src/infrastructure/ai/prompt-builder');
    const template = promptTemplate(PromptId.AI_RULE_ASSESSMENT);

    const response = await provider().assessRules({
      reviewId: 'live-smoke',
      context,
      systemPrompt: template.system,
      userPrompt: buildRuleAssessmentPrompt(context, ['COI.DECLARATION']),
      requestedRuleCodes: ['COI.DECLARATION'],
    });

    // Structured output accepted and independently validated.
    expect(response.output.schemaVersion).toBe(1);
    expect(response.output.assessments).toHaveLength(1);
    expect(response.output.assessments[0]!.ruleCode).toBe('COI.DECLARATION');
    expect(['SATISFIED', 'NOT_SATISFIED', 'INSUFFICIENT_EVIDENCE']).toContain(
      response.output.assessments[0]!.assessment,
    );

    // The identity and usage a review must persist (§47, §114).
    expect(response.usage.providerRequestId).toBeTruthy();
    expect(response.usage.providerReturnedModel).toBeTruthy();
    expect(response.usage.inputTokens).toBeGreaterThan(0);
    expect(response.usage.outputTokens).toBeGreaterThan(0);

    // Deliberately no assertion on the prose itself.
  }, 120_000);

  it('counts tokens before a request', async () => {
    const counted = await provider().countTokens({
      purpose: 'RULE_ASSESSMENT',
      systemPrompt: 'You are PalCert.',
      userPrompt: 'A short synthetic prompt.',
    });
    expect(counted.exact).toBe(true);
    expect(counted.inputTokens).toBeGreaterThan(0);
  }, 60_000);

  it('reports availability', async () => {
    await expect(provider().checkAvailability()).resolves.toEqual({ ok: true });
  }, 60_000);

  it('maps a bad credential onto AUTHENTICATION without leaking detail', async () => {
    const config = {
      ai: { enabled: true, maxInputTokens: 10_000 },
      anthropic: {
        apiKey: 'invalid-key-not-a-credential',
        model: process.env['ANTHROPIC_MODEL'] ?? 'claude-opus-5',
        maxOutputTokens: 256,
        timeoutMs: 30_000,
        effort: undefined,
        baseUrl: undefined,
      },
    } as unknown as ApiConfigService;

    try {
      await new AnthropicAIProvider(config).countTokens({
        purpose: 'RULE_ASSESSMENT',
        systemPrompt: 'x',
        userPrompt: 'y',
      });
      throw new Error('expected a rejection');
    } catch (error) {
      expect(error).toBeInstanceOf(AIProviderError);
      expect((error as AIProviderError).kind).toBe('AUTHENTICATION');
      expect((error as Error).message).not.toContain('sk-ant');
    }
  }, 60_000);
});
