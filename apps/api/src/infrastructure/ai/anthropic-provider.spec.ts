import { createServer, type Server } from 'node:http';
import { Logger } from '@nestjs/common';
import {
  AIFailureKind,
  AIProviderError,
  ExtractionContract,
  RULE_PROPOSAL_JSON_SCHEMA,
  validateExtractionContract,
} from '@palcert/contracts';
import { ANTHROPIC_PROPOSAL_SCHEMA } from './anthropic-proposal-dto';
import { answerWithRule, wireProposal, wireRule } from './anthropic-proposal-dto.fixtures';
import { unsupportedKeywords } from './provider-output-schema';
import { AnthropicAIProvider } from './anthropic-provider';
import type { ApiConfigService } from '../../config/api-config.service';

/**
 * The Anthropic adapter, against a controlled HTTP server (§92).
 *
 * Mocking the provider *interface* would prove nothing about this class: its
 * entire job is to speak HTTP to a real API and translate what comes back.
 * So these tests stand up a server that answers the way Anthropic does — with
 * a 429, a 529, a refusal, a truncation, a malformed body — and assert the
 * mapping, the absence of tools and sampling parameters, and that no vendor
 * detail leaks out the other side.
 */

interface Recorded {
  path: string;
  body: Record<string, unknown>;
  headers: Record<string, string | string[] | undefined>;
}

describe('AnthropicAIProvider', () => {
  let server: Server;
  let baseUrl: string;
  let respond: (recorded: Recorded) => {
    status: number;
    body: unknown;
    headers?: Record<string, string>;
  };
  const requests: Recorded[] = [];

  beforeAll(async () => {
    server = createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on('data', (chunk: Buffer) => chunks.push(chunk));
      request.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        const recorded: Recorded = {
          path: request.url ?? '',
          body: raw === '' ? {} : (JSON.parse(raw) as Record<string, unknown>),
          headers: request.headers,
        };
        requests.push(recorded);
        const result = respond(recorded);
        response.writeHead(result.status, {
          'content-type': 'application/json',
          ...(result.headers ?? {}),
        });
        response.end(JSON.stringify(result.body));
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    baseUrl = `http://127.0.0.1:${typeof address === 'object' && address !== null ? address.port : 0}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  beforeEach(() => {
    requests.length = 0;
    respond = () => ({ status: 200, body: success() });
  });

  function provider(overrides: Record<string, unknown> = {}): AnthropicAIProvider {
    const config = {
      ai: { enabled: true, maxInputTokens: 60_000 },
      anthropic: {
        apiKey: 'test-key-not-a-credential',
        model: 'claude-opus-5',
        maxOutputTokens: 4_000,
        timeoutMs: 5_000,
        effort: undefined,
        baseUrl,
        ...overrides,
      },
    } as unknown as ApiConfigService;
    return new AnthropicAIProvider(config);
  }

  function success(): Record<string, unknown> {
    return {
      id: 'msg_test_1',
      type: 'message',
      role: 'assistant',
      model: 'claude-opus-5-20260401',
      stop_reason: 'end_turn',
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            schemaVersion: 1,
            assessments: [
              {
                ruleCode: 'COI.DECLARATION',
                assessment: 'SATISFIED',
                reasonCode: 'REQUIREMENT_MET',
                evidenceSufficiency: 'SUFFICIENT',
                evidenceNodeIds: ['main/body/p:2'],
                explanationEn: 'A declaration is present.',
                explanationAr: 'يوجد إقرار.',
              },
            ],
          }),
        },
      ],
      usage: { input_tokens: 1200, output_tokens: 180, cache_read_input_tokens: 0 },
    };
  }

  function request() {
    return {
      reviewId: 'r1',
      context: {
        contextSchemaVersion: 1,
        contextBuilderVersion: '1',
        purpose: 'RULE_ASSESSMENT' as const,
        outline: [],
        nodes: [{ nodeId: 'main/body/p:2', text: 'declaration' }],
        metadata: {},
        deterministicFindings: [],
        rules: [],
        truncation: { truncated: false, reason: 'NONE' as const },
      },
      systemPrompt: 'You are PalCert.',
      userPrompt: '<rules></rules>',
      requestedRuleCodes: ['COI.DECLARATION'],
    };
  }

  describe('a successful call', () => {
    it('returns validated structured output and provider usage', async () => {
      const result = await provider().assessRules(request());

      expect(result.output.assessments[0]!.ruleCode).toBe('COI.DECLARATION');
      expect(result.usage.providerRequestId).toBe('msg_test_1');
      // The model the provider says it ran, which may differ from the one
      // configured — both are recorded (§4, §47).
      expect(result.usage.providerReturnedModel).toBe('claude-opus-5-20260401');
      expect(result.usage.inputTokens).toBe(1200);
      expect(result.usage.outputTokens).toBe(180);
    });

    it('constrains the output with a JSON schema rather than a prefill', async () => {
      await provider().assessRules(request());

      const body = requests[0]!.body as Record<string, Record<string, unknown>>;
      const format = body.output_config?.format as Record<string, unknown>;
      expect(format.type).toBe('json_schema');
      expect(format.schema).toBeDefined();

      // No assistant prefill anywhere: output shape comes from the schema
      // (§6), and current models reject a prefill in any case.
      const messages = body.messages as unknown as Array<{ role: string }>;
      expect(messages.every((message) => message.role === 'user')).toBe(true);
    });

    it('declares no tools of any kind', async () => {
      await provider().assessRules(request());

      const body = requests[0]!.body;
      // The strongest single limit on prompt-injection impact: a model with no
      // tools cannot act on anything a document tells it to do (§21).
      expect(body.tools).toBeUndefined();
      expect(body.tool_choice).toBeUndefined();
      expect(body.mcp_servers).toBeUndefined();
      expect(body.container).toBeUndefined();
    });

    it('sets no sampling parameters', async () => {
      await provider().assessRules(request());

      const body = requests[0]!.body;
      // Current Claude generations reject these, and a control applied blindly
      // to every model is how an integration breaks on a model upgrade (§7).
      expect(body.temperature).toBeUndefined();
      expect(body.top_p).toBeUndefined();
      expect(body.top_k).toBeUndefined();
    });

    it('sends effort only when a deployment configured one', async () => {
      await provider().assessRules(request());
      expect((requests[0]!.body.output_config as Record<string, unknown>).effort).toBeUndefined();

      requests.length = 0;
      await provider({ effort: 'high' }).assessRules(request());
      expect((requests[0]!.body.output_config as Record<string, unknown>).effort).toBe('high');
    });

    it('sends the configured model, not a hard-coded one', async () => {
      await provider({ model: 'claude-sonnet-5' }).assessRules(request());
      expect(requests[0]!.body.model).toBe('claude-sonnet-5');
    });

    it('counts tokens through the provider', async () => {
      respond = () => ({ status: 200, body: { input_tokens: 4321 } });
      const counted = await provider().countTokens({
        purpose: 'RULE_ASSESSMENT',
        systemPrompt: 'You are PalCert.',
        userPrompt: 'x',
      });
      expect(counted).toEqual({ inputTokens: 4321, exact: true });
      expect(requests[0]!.path).toContain('count_tokens');
    });
  });

  describe('provider failures', () => {
    it.each([
      [429, AIFailureKind.RATE_LIMITED],
      [529, AIFailureKind.OVERLOADED],
      [500, AIFailureKind.OVERLOADED],
      [504, AIFailureKind.OVERLOADED],
      [401, AIFailureKind.AUTHENTICATION],
      [403, AIFailureKind.AUTHENTICATION],
      [400, AIFailureKind.INVALID_REQUEST],
      [404, AIFailureKind.MODEL_UNAVAILABLE],
    ])('maps HTTP %s onto %s', async (status, kind) => {
      respond = () => ({ status, body: { type: 'error', error: { message: 'provider detail' } } });

      await expect(provider().assessRules(request())).rejects.toMatchObject({ kind });
    });

    it('honours Retry-After when the provider sends one', async () => {
      respond = () => ({
        status: 429,
        body: { type: 'error', error: { message: 'slow down' } },
        headers: { 'retry-after': '7' },
      });

      await expect(provider().assessRules(request())).rejects.toMatchObject({
        kind: AIFailureKind.RATE_LIMITED,
        retryAfterSeconds: 7,
      });
    });

    it('treats a refusal as a provider fact, never a document verdict', async () => {
      respond = () => ({
        status: 200,
        body: { ...success(), stop_reason: 'refusal', stop_details: { type: 'refusal' } },
      });

      await expect(provider().assessRules(request())).rejects.toMatchObject({
        kind: AIFailureKind.PROVIDER_REFUSAL,
      });
    });

    it('rejects truncated output rather than salvaging half an assessment', async () => {
      respond = () => ({ status: 200, body: { ...success(), stop_reason: 'max_tokens' } });

      await expect(provider().assessRules(request())).rejects.toMatchObject({
        kind: AIFailureKind.OUTPUT_INVALID,
      });
    });

    it('rejects a body that is not the structured output it asked for', async () => {
      respond = () => ({
        status: 200,
        body: { ...success(), content: [{ type: 'text', text: 'Here is the JSON: {...}' }] },
      });

      // No regex extraction, no fenced-block scraping, no JSON.parse on prose.
      await expect(provider().assessRules(request())).rejects.toMatchObject({
        kind: AIFailureKind.OUTPUT_INVALID,
      });
    });

    it('rejects structured output that fails PalCert validation', async () => {
      respond = () => ({
        status: 200,
        body: {
          ...success(),
          content: [{ type: 'text', text: JSON.stringify({ schemaVersion: 1, assessments: [] }) }],
        },
      });

      await expect(provider().assessRules(request())).rejects.toMatchObject({
        kind: AIFailureKind.OUTPUT_INVALID,
      });
    });

    it('refuses to call at all without a credential', async () => {
      const config = {
        ai: { enabled: true, maxInputTokens: 60_000 },
        anthropic: {
          apiKey: undefined,
          model: 'claude-opus-5',
          maxOutputTokens: 100,
          timeoutMs: 1_000,
          baseUrl,
        },
      } as unknown as ApiConfigService;

      await expect(new AnthropicAIProvider(config).assessRules(request())).rejects.toMatchObject({
        kind: AIFailureKind.AUTHENTICATION,
      });
      expect(requests).toHaveLength(0);
    });

    it('never leaks provider detail into the error it raises', async () => {
      respond = () => ({
        status: 500,
        body: { type: 'error', error: { message: 'internal stack trace at /opt/anthropic/x.py' } },
      });

      try {
        await provider().assessRules(request());
        throw new Error('expected a rejection');
      } catch (error) {
        expect(error).toBeInstanceOf(AIProviderError);
        // Stable, vendor-neutral wording only (§55).
        expect((error as Error).message).not.toContain('stack trace');
        expect((error as Error).message).not.toContain('anthropic');
      }
    });
  });

  describe('rule proposals (Pass B)', () => {
    const PROMPT_MARKER = 'CONFIDENTIAL-DOCUMENT-TEXT-7f3a';

    function proposalRequest(maxProposals?: number) {
      return {
        extractionRunId: 'run-1',
        systemPrompt: 'You are PalCert.',
        userPrompt: `<evidence id="ev-1">${PROMPT_MARKER}</evidence>`,
        suppliedEvidenceIds: ['ev-1'],
        ...(maxProposals === undefined ? {} : { maxProposals }),
      };
    }

    function answering(output: unknown) {
      respond = () => ({
        status: 200,
        body: { ...success(), content: [{ type: 'text', text: JSON.stringify(output) }] },
      });
    }

    it('sends the flat wire schema, not PalCert’s canonical one', async () => {
      answering({ proposals: [] });
      await provider().extractRuleProposals(proposalRequest());

      const body = requests[0]!.body as Record<string, Record<string, unknown>>;
      const format = body.output_config!.format as {
        type: string;
        schema: Record<string, unknown>;
      };
      expect(format.type).toBe('json_schema');
      expect(format.schema).toEqual(ANTHROPIC_PROPOSAL_SCHEMA);
      const text = JSON.stringify(format.schema);
      expect(text).not.toMatch(/"(oneOf|anyOf|allOf|\$ref)"/);
      expect(unsupportedKeywords(format.schema)).toEqual([]);
      // The canonical schema, with its unions, never goes over the wire.
      expect(unsupportedKeywords(RULE_PROPOSAL_JSON_SCHEMA).length).toBeGreaterThan(0);
      expect(text).toContain('"NOT_APPLICABLE"');
    });

    it('does not change the assessment schemas’ handling', async () => {
      await provider().assessRules(request());
      const body = requests[0]!.body as Record<string, Record<string, unknown>>;
      const format = body.output_config!.format as { schema: Record<string, unknown> };
      expect(unsupportedKeywords(format.schema)).toEqual([]);
    });

    it('returns the canonical output, validated against the original schema', async () => {
      answering({ proposals: [wireProposal()] });
      const result = await provider().extractRuleProposals(proposalRequest());

      expect(result.output.proposals).toHaveLength(1);
      expect(result.output.proposals[0]!.suggestedRule).toMatchObject({
        scope: { kind: 'PAGE', pages: 'ALL', property: 'marginLeft' },
        expected: { type: 'NUMBER', number: 30 },
      });
      expect(
        validateExtractionContract(ExtractionContract.PROPOSAL_OUTPUT, result.output).valid,
      ).toBe(true);
      expect(result.usage.providerRequestId).toBe('msg_test_1');
    });

    it.each([
      ['an inconsistent scope', answerWithRule({ sectionKey: 'ABSTRACT' })],
      ['an inconsistent expected value', answerWithRule({ expectedText: 'x' })],
      [
        'a canonical pattern violation',
        { proposals: [wireProposal({ proposalKey: 'has space' })] },
      ],
      [
        'a canonical maximum violation',
        answerWithRule({
          scopeKind: 'ELEMENT',
          elementType: 'HEADING',
          elementLevel: 10,
          pageSelector: 'NOT_APPLICABLE',
        }),
      ],
      ['a canonical minLength violation', { proposals: [wireProposal({ interpretationEn: '' })] }],
      [
        'the canonical shape itself',
        { proposals: [{ ...wireProposal(), suggestedRule: { scope: {} } }] },
      ],
    ])('refuses %s as invalid output', async (_name, answer) => {
      answering(answer);
      await expect(provider().extractRuleProposals(proposalRequest())).rejects.toMatchObject({
        kind: AIFailureKind.OUTPUT_INVALID,
        message: 'the provider response failed PalCert validation',
      });
    });

    it('refuses more proposals than the call allowed', async () => {
      answering({
        proposals: Array.from({ length: 4 }, (_, i) => wireProposal({ proposalKey: `p-${i}` })),
      });
      await expect(provider().extractRuleProposals(proposalRequest(3))).rejects.toMatchObject({
        kind: AIFailureKind.OUTPUT_INVALID,
      });
      await expect(provider().extractRuleProposals(proposalRequest(4))).resolves.toBeDefined();
    });

    it('logs a canonical failure with its path and rule, and nothing the model wrote', async () => {
      const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
      try {
        answering(
          answerWithRule({ ruleCode: `${PROMPT_MARKER}.under_score`, titleEn: 'x'.repeat(301) }),
        );
        await expect(provider().extractRuleProposals(proposalRequest())).rejects.toMatchObject({
          kind: AIFailureKind.OUTPUT_INVALID,
        });
        const logged = warn.mock.calls.map((call) => String(call[0])).join('\n');
        expect(logged).toContain('reason=CANONICAL_SCHEMA_FAILED');
        // The rule code was normalized, not refused; the title is what failed.
        expect(logged).toContain(
          'at=/proposals/0/suggestedRule/titleEn issue=must NOT have more than 300 characters',
        );
        expect(logged).not.toContain('ruleCode');
        expect(logged).not.toContain(PROMPT_MARKER);
        expect(logged).not.toContain('under_score');
        expect(logged).not.toContain('xxxxxxxx');
        expect(logged).not.toContain('^[A-Z]');
        expect(logged).not.toContain('test-key-not-a-credential');
        expect(logged).not.toContain('You are PalCert');
      } finally {
        warn.mockRestore();
      }
    });

    it('logs why an answer was refused — a code and a path, never what the model wrote', async () => {
      const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
      try {
        answering({
          proposals: [
            wireProposal(
              { interpretationEn: `${PROMPT_MARKER} model prose` },
              wireRule({ sectionKey: 'SECRET_SECTION' }),
            ),
          ],
        });
        await expect(provider().extractRuleProposals(proposalRequest())).rejects.toBeInstanceOf(
          AIProviderError,
        );
        const logged = warn.mock.calls.map((call) => String(call[0])).join('\n');
        expect(logged).toContain('reason=SCOPE_INCONSISTENT');
        expect(logged).toContain('at=$.proposals[0].suggestedRule[0].scope');
        expect(logged).not.toContain(PROMPT_MARKER);
        expect(logged).not.toContain('SECRET_SECTION');
        expect(logged).not.toContain('model prose');
        expect(logged).not.toContain('test-key-not-a-credential');
        expect(logged).not.toContain('You are PalCert');
      } finally {
        warn.mockRestore();
      }
    });
  });

  describe('diagnosing a rejected request', () => {
    let warn: jest.SpyInstance;
    beforeEach(() => {
      warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    });
    afterEach(() => warn.mockRestore());

    function rejecting(message: string, type = 'invalid_request_error') {
      respond = () => ({
        status: 400,
        body: { type: 'error', error: { type, message } },
        headers: { 'request-id': 'req_011CabcDEF123' },
      });
    }

    it.each([
      [
        'output_config.format.schema: keyword "minLength" is not supported',
        'OUTPUT_SCHEMA',
        'the request was rejected: output schema not accepted',
      ],
      [
        'Your credit balance is too low to access the Anthropic API.',
        'SPEND_LIMIT',
        'the request was rejected: provider credit or spend limit',
      ],
      [
        'You have reached your specified API usage limits.',
        'SPEND_LIMIT',
        'the request was rejected: provider credit or spend limit',
      ],
      [
        'prompt is too long: 1200000 tokens > 1000000 maximum',
        'REQUEST_TOO_LARGE',
        'the request was rejected: request too large',
      ],
      ['something else entirely', 'OTHER', 'the request was rejected'],
    ])('tells "%s" apart as %s', async (providerMessage, category, recorded) => {
      rejecting(providerMessage);
      await expect(
        provider().extractRuleProposals({
          extractionRunId: 'run-1',
          systemPrompt: 'You are PalCert.',
          userPrompt: 'CONFIDENTIAL-DOCUMENT-TEXT-7f3a',
          suppliedEvidenceIds: ['ev-1'],
        }),
      ).rejects.toMatchObject({ kind: AIFailureKind.INVALID_REQUEST, message: recorded });

      const logged = warn.mock.calls.map((call) => String(call[0])).join('\n');
      expect(logged).toContain('status=400');
      expect(logged).toContain(`category=${category}`);
      expect(logged).toContain('type=invalid_request_error');
      expect(logged).toContain('requestId=req_011CabcDEF123');
    });

    it('never logs the prompt, the credential, or a value the provider echoed back', async () => {
      rejecting(
        'messages.0.content: "CONFIDENTIAL-DOCUMENT-TEXT-7f3a" is invalid for key sk-ant-api03-abcdefghijklmnop',
      );
      await expect(provider().assessRules(request())).rejects.toBeInstanceOf(AIProviderError);

      const logged = warn.mock.calls.map((call) => String(call[0])).join('\n');
      expect(logged).toContain('requestId=req_011CabcDEF123');
      expect(logged).not.toContain('CONFIDENTIAL-DOCUMENT-TEXT-7f3a');
      expect(logged).not.toContain('sk-ant-api03');
      expect(logged).not.toContain('test-key-not-a-credential');
      expect(logged).not.toContain('You are PalCert');
    });

    it('never records the provider’s own words in the error PalCert stores', async () => {
      rejecting('output_config.format.schema: keyword "pattern" is not supported');
      try {
        await provider().assessRules(request());
        throw new Error('expected a rejection');
      } catch (error) {
        expect((error as Error).message).not.toContain('pattern');
        expect((error as Error).message).not.toContain('output_config');
      }
    });
  });

  describe('availability', () => {
    it('reports available when the provider answers', async () => {
      respond = () => ({ status: 200, body: { input_tokens: 1 } });
      await expect(provider().checkAvailability()).resolves.toEqual({ ok: true });
    });

    it('reports unavailable without a reason, and never throws', async () => {
      respond = () => ({ status: 500, body: { type: 'error', error: { message: 'x' } } });
      await expect(provider().checkAvailability()).resolves.toEqual({
        ok: false,
        message: 'unavailable',
      });
    });
  });
});
