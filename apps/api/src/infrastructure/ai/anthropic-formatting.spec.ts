import { createServer, type Server } from 'node:http';
import { AnthropicAIProvider } from './anthropic-provider';
import type { ApiConfigService } from '../../config/api-config.service';
import { unsupportedKeywords } from './provider-output-schema';

jest.mock('../../config/api-config.service', () => ({ ApiConfigService: class {} }));

describe('Anthropic formatting structured-output transport', () => {
  let server: Server;
  let provider: AnthropicAIProvider;
  let sent: Record<string, unknown>;
  let output: unknown;
  beforeAll(async () => {
    server = createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on('data', (chunk: Buffer) => chunks.push(chunk));
      request.on('end', () => {
        sent = JSON.parse(Buffer.concat(chunks).toString()) as Record<string, unknown>;
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(
          JSON.stringify({
            id: 'test',
            type: 'message',
            role: 'assistant',
            model: 'configured-model',
            stop_reason: 'end_turn',
            content: [{ type: 'text', text: JSON.stringify(output) }],
            usage: { input_tokens: 123, output_tokens: 45 },
          }),
        );
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    const port = address && typeof address !== 'string' ? address.port : 0;
    provider = new AnthropicAIProvider({
      ai: { maxInputTokens: 60_000, maxOutputTokens: 8_000 },
      anthropic: {
        apiKey: 'test-not-a-credential',
        model: 'configured-model',
        maxOutputTokens: 16_000,
        timeoutMs: 5_000,
        baseUrl: `http://127.0.0.1:${port}`,
      },
    } as ApiConfigService);
  });
  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('uses the configured provider, constrained schema, bounded output and no executable tools', async () => {
    output = { targets: [{ ruleCode: 'ANY.FONT', kind: 'STRING', value: 'Arial' }] };
    const result = await provider.proposeFormatting({
      systemPrompt: 'Format only.',
      userPrompt: '{}',
    });
    expect(result.output).toEqual(output);
    expect(result.usage.inputTokens).toBe(123);
    expect(sent.model).toBe('configured-model');
    expect(sent.max_tokens).toBe(8_000);
    expect(sent.tools).toBeUndefined();
    expect(sent.tool_choice).toBeUndefined();
    const format = (sent.output_config as { format: { schema: Record<string, unknown> } }).format;
    expect(unsupportedKeywords(format.schema)).toEqual([]);
  });
  it('revalidates against the full contract after provider schema conversion', async () => {
    output = { targets: [{ ruleCode: 'ANY.FONT', kind: 'STRING', value: 'x'.repeat(257) }] };
    await expect(
      provider.proposeFormatting({ systemPrompt: 'Format only.', userPrompt: '{}' }),
    ).rejects.toMatchObject({ kind: 'OUTPUT_INVALID' });
  });
});
