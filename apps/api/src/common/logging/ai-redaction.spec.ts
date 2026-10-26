import pino from 'pino';
import { LOG_REDACT_PATHS } from './logger.config';

/**
 * Nothing about an AI call reaches a log (§8, §81, §115).
 *
 * Three different kinds of secret are at stake and all three are fatal:
 * the provider credential, which is a server secret; the prompt and response,
 * which carry a user's unpublished research; and the context bundle, which is
 * the document in normalized form. The sentinels below are values no log line
 * could contain by coincidence — if one appears, something is leaking.
 */

const API_KEY = 'REDACTION-SENTINEL-0000-DO-NOT-LOG';
const DOCUMENT_TEXT = 'CONFIDENTIAL-THESIS-9f3a7c-DO-NOT-LOG';
const AUTHOR = 'SENTINEL-AUTHOR-NAME-DO-NOT-LOG';

function captured(payload: Record<string, unknown>): string {
  const lines: string[] = [];
  const logger = pino(
    { redact: { paths: LOG_REDACT_PATHS, censor: '[REDACTED]' } },
    { write: (line: string) => lines.push(line) },
  );
  logger.info(payload, 'ai event');
  return lines.join('');
}

describe('AI log redaction', () => {
  it('redacts the provider credential', () => {
    const line = captured({ apiKey: API_KEY });
    expect(line).not.toContain(API_KEY);
    expect(line).toContain('[REDACTED]');
  });

  it('redacts the credential under its environment-variable name', () => {
    expect(captured({ ANTHROPIC_API_KEY: API_KEY })).not.toContain(API_KEY);
    expect(captured({ config: { ANTHROPIC_API_KEY: API_KEY } })).not.toContain(API_KEY);
  });

  it('redacts the prompts', () => {
    expect(captured({ systemPrompt: DOCUMENT_TEXT })).not.toContain(DOCUMENT_TEXT);
    expect(captured({ userPrompt: DOCUMENT_TEXT })).not.toContain(DOCUMENT_TEXT);
    expect(captured({ request: { prompt: DOCUMENT_TEXT } })).not.toContain(DOCUMENT_TEXT);
  });

  it('redacts the context bundle', () => {
    expect(captured({ context: { nodes: [{ text: DOCUMENT_TEXT }] } })).not.toContain(
      DOCUMENT_TEXT,
    );
    expect(captured({ review: { contextBundle: { author: AUTHOR } } })).not.toContain(AUTHOR);
  });

  it('redacts the provider response and model prose', () => {
    expect(captured({ providerResponse: DOCUMENT_TEXT })).not.toContain(DOCUMENT_TEXT);
    expect(captured({ result: { rawResponse: DOCUMENT_TEXT } })).not.toContain(DOCUMENT_TEXT);
    expect(captured({ assessment: { explanationEn: DOCUMENT_TEXT } })).not.toContain(DOCUMENT_TEXT);
    expect(captured({ assessment: { explanationAr: DOCUMENT_TEXT } })).not.toContain(DOCUMENT_TEXT);
    expect(captured({ supplement: { summaryEn: DOCUMENT_TEXT } })).not.toContain(DOCUMENT_TEXT);
    expect(captured({ supplement: { summaryAr: DOCUMENT_TEXT } })).not.toContain(DOCUMENT_TEXT);
  });

  it('still logs the safe identifiers an operator needs', () => {
    // Redaction that swallowed the correlation fields would make the ledger
    // useless; codes, counters and ids are exactly what may be logged (§80).
    const line = captured({
      reviewId: '3f1c2b4a-5d6e-4f70-8912-a3b4c5d6e7f8',
      provider: 'anthropic',
      failureKind: 'RATE_LIMITED',
      inputTokens: 1200,
    });
    expect(line).toContain('3f1c2b4a-5d6e-4f70-8912-a3b4c5d6e7f8');
    expect(line).toContain('anthropic');
    expect(line).toContain('RATE_LIMITED');
    expect(line).toContain('1200');
  });
});
