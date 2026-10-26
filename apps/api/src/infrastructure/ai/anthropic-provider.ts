import { Injectable, Logger } from '@nestjs/common';
import {
  AIContract,
  AI_FORMATTING_OUTPUT_SCHEMA,
  parseAIFormattingProposal,
  type AIFormattingRequest,
  AIFailureKind,
  AIProviderError,
  AIProviderPort,
  AI_ASSESSMENT_JSON_SCHEMA,
  validateAIContract,
  type DiscoveredCitation,
  type EvidenceDiscoveryProviderResponse,
  type EvidenceDiscoveryRequest,
  type PalCertRuleProposalOutput,
  type RuleProposalProviderResponse,
  type RuleProposalRequest,
  type ExtractionDocument,
  type AIProviderCapabilities,
  type AIReportSupplementProviderResponse,
  type AIReportSupplementRequest,
  type AIReportSupplementResponse,
  type AIRuleAssessmentProviderResponse,
  type AIRuleAssessmentRequest,
  type AIRuleAssessmentResponse,
  type AITokenCountRequest,
  type AITokenCountResult,
} from '@palcert/contracts';
import Anthropic from '@anthropic-ai/sdk';
import { ApiConfigService } from '../../config/api-config.service';
import {
  ANTHROPIC_PROPOSAL_SCHEMA,
  ProposalConversionError,
  toCanonicalProposals,
} from './anthropic-proposal-dto';
import { providerOutputFormat } from './provider-output-schema';

/** The provider's own name, as persisted with every review (§11, §47). */
export const ANTHROPIC_PROVIDER = 'anthropic';

/**
 * The Anthropic adapter (§5, §21, §22, §53).
 *
 * Everything specific to one vendor lives behind this class: the SDK, the
 * error taxonomy, the structured-output mechanism, the credential. Nothing
 * above it knows Anthropic exists.
 *
 * Four deliberate omissions, each of which is the point rather than an
 * oversight:
 *
 * **No tools, ever.** Not web search, not fetch, not code execution, not MCP.
 * A model given a document full of untrusted text and also given the ability
 * to act on the world is a much larger problem than one asked to return
 * structured analysis. Phase 8 sends context and receives JSON (§21).
 *
 * **No assistant prefill.** Output shape comes from `output_config.format`,
 * a schema the API enforces — not from putting words in the model's mouth and
 * hoping (§6). Prefill is rejected by current models anyway.
 *
 * **No sampling parameters.** `temperature`, `top_p` and `top_k` are not set:
 * current Claude generations reject them, and a control blindly applied to
 * every model is how an integration breaks on a model upgrade (§7). Effort is
 * sent only when configured and only when the model accepts it.
 *
 * **No free-form JSON parsing.** Nothing here looks for a fenced code block or
 * a substring after "Here is the JSON". The response is structured output,
 * and it is then validated again by PalCert before anything is believed (§34).
 */
@Injectable()
export class AnthropicAIProvider extends AIProviderPort {
  private readonly logger = new Logger(AnthropicAIProvider.name);
  private client: Anthropic | undefined;

  constructor(private readonly config: ApiConfigService) {
    super();
  }

  getCapabilities(): AIProviderCapabilities {
    const anthropic = this.config.anthropic;
    return {
      provider: ANTHROPIC_PROVIDER,
      configuredModel: anthropic.model,
      supportsTokenCounting: true,
      supportsStructuredOutput: true,
      // Effort is model-dependent, so it is a capability rather than an
      // assumption: PalCert sends it only when deployment configured one.
      supportsEffort: anthropic.effort !== undefined,
      maxInputTokens: this.config.ai.maxInputTokens,
      maxOutputTokens: anthropic.maxOutputTokens,
    };
  }

  async countTokens(request: AITokenCountRequest): Promise<AITokenCountResult> {
    const anthropic = this.config.anthropic;
    try {
      const counted = await this.sdk().messages.countTokens(
        {
          model: anthropic.model,
          system: request.systemPrompt,
          messages: [{ role: 'user', content: request.userPrompt }],
        },
        { signal: request.signal },
      );
      return { inputTokens: counted.input_tokens, exact: true };
    } catch (error) {
      throw this.classify(error);
    }
  }

  async proposeFormatting(request: AIFormattingRequest) {
    return this.structuredCall({
      ...request,
      maxOutputTokens: Math.min(this.config.ai.maxOutputTokens ?? 8_000, 8_000),
      schema: AI_FORMATTING_OUTPUT_SCHEMA,
      parse: (value) => {
        try {
          return parseAIFormattingProposal(value);
        } catch {
          throw new AIProviderError(AIFailureKind.OUTPUT_INVALID, 'Invalid formatting proposal');
        }
      },
    });
  }

  async assessRules(request: AIRuleAssessmentRequest): Promise<AIRuleAssessmentProviderResponse> {
    const { output, usage } = await this.structuredCall<AIRuleAssessmentResponse>({
      systemPrompt: request.systemPrompt,
      userPrompt: request.userPrompt,
      schema: assessmentSchemaFor('AIRuleAssessmentResponse'),
      parse: (value) =>
        accepted<AIRuleAssessmentResponse>(
          value,
          validateAIContract(AIContract.RULE_ASSESSMENT_RESPONSE, value).valid,
        ),
    });
    return { output, usage };
  }

  async generateReportSupplement(
    request: AIReportSupplementRequest,
  ): Promise<AIReportSupplementProviderResponse> {
    const { output, usage } = await this.structuredCall<AIReportSupplementResponse>({
      systemPrompt: request.systemPrompt,
      userPrompt: request.userPrompt,
      schema: assessmentSchemaFor('AIReportSupplementResponse'),
      parse: (value) =>
        accepted<AIReportSupplementResponse>(
          value,
          validateAIContract(AIContract.REPORT_SUPPLEMENT_RESPONSE, value).valid,
        ),
    });
    return { output, usage };
  }

  /**
   * Pass A — evidence discovery, with citations (§24, §85).
   *
   * Deliberately without `output_config.format`: the current API rejects a
   * request that asks for citations *and* structured output, and the two are
   * wanted for different reasons. Citations ground a quotation in a real page
   * or block; structured output constrains a shape. Pass B supplies the shape.
   *
   * The model's prose is not the extraction. Only the provider's own citation
   * blocks are read, because they are the part of the response that can be
   * checked against the document PalCert sent (§25, §86).
   */
  async discoverGuidelineEvidence(
    request: EvidenceDiscoveryRequest,
  ): Promise<EvidenceDiscoveryProviderResponse> {
    const anthropic = this.config.anthropic;
    const startedAt = Date.now();

    // Document order is the index space the provider cites into, so it is
    // captured here rather than assumed later.
    const documentOrder = request.documents.map((document) => document.sourceAssetId);

    let response: Anthropic.Message;
    try {
      response = await this.sdk().messages.create({
        model: anthropic.model,
        max_tokens: anthropic.maxOutputTokens,
        system: request.systemPrompt,
        messages: [
          {
            role: 'user',
            content: [
              ...request.documents.map(documentBlock),
              { type: 'text' as const, text: request.instruction },
            ],
          },
        ],
        ...(anthropic.effort !== undefined ? { output_config: { effort: anthropic.effort } } : {}),
        // No tools, no structured output, no prefill, no sampling parameters.
      });
    } catch (error) {
      throw this.classify(error);
    }

    if (response.stop_reason === 'refusal') {
      throw new AIProviderError(
        AIFailureKind.PROVIDER_REFUSAL,
        'the provider declined to read this source',
      );
    }

    const citations: DiscoveredCitation[] = [];
    let ungroundedBlockCount = 0;
    for (const block of response.content) {
      if (block.type !== 'text') continue;
      const blockCitations = block.citations ?? [];
      if (blockCitations.length === 0) {
        // Counted, never kept: ungrounded model text is not evidence, and
        // storing it would be storing an invented quotation (§56).
        ungroundedBlockCount += 1;
        continue;
      }
      for (const citation of blockCitations) {
        const normalized = normalizeCitation(citation, documentOrder);
        if (normalized !== null) citations.push(normalized);
      }
    }

    return {
      citations,
      ungroundedBlockCount,
      usage: {
        providerRequestId: response.id,
        providerReturnedModel: response.model,
        inputTokens: response.usage.input_tokens,
        outputTokens: response.usage.output_tokens,
        cacheReadTokens: response.usage.cache_read_input_tokens ?? null,
        cacheWriteTokens: response.usage.cache_creation_input_tokens ?? null,
        latencyMs: Date.now() - startedAt,
      },
    };
  }

  /**
   * Pass B — structured rule proposals, without citations (§41, §84).
   *
   * Receives only the evidence Pass A grounded and the observations PalCert
   * measured. The source document is deliberately not sent again: re-reading
   * it here would buy nothing and would double what leaves PalCert (§103).
   *
   * The provider answers in a flat wire shape (`anthropic-proposal-dto`): the
   * canonical schema, with its scope and value `oneOf` trees, compiles to a
   * grammar the provider refuses as too large. PalCert converts the answer
   * and validates the canonical result against the full canonical schema;
   * only that result leaves this method.
   */
  async extractRuleProposals(request: RuleProposalRequest): Promise<RuleProposalProviderResponse> {
    const maxProposals = request.maxProposals ?? DEFAULT_PROPOSALS_PER_CALL;
    const { output, usage } = await this.structuredCall<PalCertRuleProposalOutput>({
      systemPrompt: request.systemPrompt,
      userPrompt: request.userPrompt,
      schema: ANTHROPIC_PROPOSAL_SCHEMA,
      transformSchema: false,
      parse: (value) => {
        try {
          return toCanonicalProposals(value, { maxProposals }, (rewrites) =>
            // Counts only: never the code the model wrote.
            this.logger.log(
              `provider rule codes rewritten normalized=${rewrites.normalized} ` +
                `fallback=${rewrites.fallback} deduplicated=${rewrites.deduplicated}`,
            ),
          );
        } catch (error) {
          if (!(error instanceof ProposalConversionError)) throw error;
          // The reason and where — a code and a path of field names, never a
          // value the model wrote (§150).
          // For a canonical failure, the rule that failed too ("must match
          // pattern"), for at most MAX_REPORTED_ISSUES paths.
          const issues = error.issues
            .map(
              (entry, index) => `${index === 0 ? '' : ' also='}${entry.path} issue=${entry.issue}`,
            )
            .join('');
          this.logger.warn(
            error.issues.length === 0
              ? `provider proposal output rejected reason=${error.reason} at=${error.at}`
              : `provider proposal output rejected reason=${error.reason} at=${issues}`,
          );
          throw new AIProviderError(
            AIFailureKind.OUTPUT_INVALID,
            'the provider response failed PalCert validation',
          );
        }
      },
    });
    return { output, usage };
  }

  async checkAvailability(): Promise<{ ok: boolean; message?: string }> {
    if (!this.config.ai.enabled) return { ok: false, message: 'disabled' };
    try {
      // The cheapest possible proof that the credential works and the service
      // answers: counting tokens runs no inference and returns no content.
      await this.sdk().messages.countTokens({
        model: this.config.anthropic.model,
        messages: [{ role: 'user', content: 'ping' }],
      });
      return { ok: true };
    } catch {
      // No reason given: this surface is operational, and the readiness body
      // says nothing about credentials or vendors (§55, §57).
      return { ok: false, message: 'unavailable' };
    }
  }

  /**
   * One schema-constrained call.
   *
   * The provider constrains the output *and* PalCert validates it afterwards.
   * That is not redundancy: the constraint is enforced by someone else's
   * service on a schema sent over the network, and an immutable AI review is
   * the wrong place to discover it was not honoured (§34).
   */
  private async structuredCall<T>(params: {
    signal?: AbortSignal;
    maxOutputTokens?: number;
    systemPrompt: string;
    userPrompt: string;
    /**
     * The JSON Schema the provider must satisfy, sent through
     * `providerOutputFormat`. `parse` decides what the answer is worth.
     */
    schema: Record<string, unknown>;
    /** `false` for a schema already written for the provider (Pass B). */
    transformSchema?: boolean;
    /**
     * PalCert's own check, run before anything is believed: returns the value
     * PalCert accepts, validated against PalCert's full schema, or throws.
     */
    parse: (value: unknown) => T;
  }): Promise<{ output: T; usage: AIRuleAssessmentProviderResponse['usage'] }> {
    const anthropic = this.config.anthropic;
    const startedAt = Date.now();

    let response: Anthropic.Message;
    try {
      response = await this.sdk().messages.create(
        {
          model: anthropic.model,
          max_tokens: Math.min(
            params.maxOutputTokens ?? anthropic.maxOutputTokens,
            anthropic.maxOutputTokens,
          ),
          // The system prompt holds instructions only. Document content, rule
          // titles and organization guidance never appear here (§20).
          system: params.systemPrompt,
          messages: [{ role: 'user', content: params.userPrompt }],
          output_config: {
            // PalCert's schema goes through the SDK's own helper, which removes
            // what the API cannot compile (`minLength`, `pattern`, numeric
            // bounds, `maxItems` …). Sending it raw was a 400 on every call.
            // Nothing is lost: the full schema is enforced below.
            format: providerOutputFormat(params.schema, {
              transform: params.transformSchema ?? true,
            }),
            ...(anthropic.effort !== undefined ? { effort: anthropic.effort } : {}),
          },
          // Deliberately absent: tools, tool_choice, temperature, top_p, top_k,
          // and any assistant prefill. See the class comment.
        },
        { signal: params.signal },
      );
    } catch (error) {
      throw this.classify(error);
    }

    // A policy decline is a fact about the request, never a finding about the
    // user's document, and it is not retried (§54).
    if (response.stop_reason === 'refusal') {
      throw new AIProviderError(
        AIFailureKind.PROVIDER_REFUSAL,
        'the provider declined to answer this request',
      );
    }
    if (response.stop_reason === 'max_tokens') {
      // Truncated JSON is invalid JSON. Treated as invalid output rather than
      // salvaged, because half an assessment is not an assessment.
      throw new AIProviderError(
        AIFailureKind.OUTPUT_INVALID,
        'the provider response was truncated by the output limit',
      );
    }

    const text = response.content
      .filter((block): block is Anthropic.TextBlock => block.type === 'text')
      .map((block) => block.text)
      .join('');

    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new AIProviderError(
        AIFailureKind.OUTPUT_INVALID,
        'the provider response was not the structured output it was constrained to',
      );
    }

    // Deliberately without the offending value or the validator's message:
    // an invalid response must not be able to smuggle model text into a log
    // or an error body (§150).
    const output = params.parse(parsed);

    return {
      output,
      usage: {
        providerRequestId: response.id,
        providerReturnedModel: response.model,
        inputTokens: response.usage.input_tokens,
        outputTokens: response.usage.output_tokens,
        cacheReadTokens: response.usage.cache_read_input_tokens ?? null,
        cacheWriteTokens: response.usage.cache_creation_input_tokens ?? null,
        latencyMs: Date.now() - startedAt,
      },
    };
  }

  private sdk(): Anthropic {
    if (this.client !== undefined) return this.client;
    const anthropic = this.config.anthropic;
    if (anthropic.apiKey === undefined) {
      throw new AIProviderError(
        AIFailureKind.AUTHENTICATION,
        'no provider credential is configured',
      );
    }
    this.client = new Anthropic({
      apiKey: anthropic.apiKey,
      timeout: anthropic.timeoutMs,
      // PalCert owns the retry policy: it has to record each attempt in the
      // invocation ledger and honour its own backoff, which an SDK retrying
      // silently underneath would make impossible (§47, §56).
      maxRetries: 0,
      ...(anthropic.baseUrl !== undefined ? { baseURL: anthropic.baseUrl } : {}),
    });
    return this.client;
  }

  /**
   * Map a provider failure onto PalCert's vocabulary (§55).
   *
   * Nothing vendor-shaped escapes: no SDK class, no status code, no response
   * body, no stack trace. The retry policy is written against these names.
   */
  private classify(error: unknown): AIProviderError {
    if (error instanceof AIProviderError) return error;

    if (error instanceof Anthropic.APIError && error.status !== undefined) {
      const diagnosis = diagnose(error);
      // Enough to tell a schema rejection from a spend limit from an
      // oversized request, and to quote the request id to the provider.
      // Never the request, the prompt, the document or the credential.
      this.logger.warn(
        `provider call rejected status=${error.status} category=${diagnosis.category} ` +
          `type=${diagnosis.type} requestId=${diagnosis.requestId} message="${diagnosis.message}"`,
      );
    }

    if (error instanceof Anthropic.APIError) {
      const retryAfter = retryAfterSeconds(error);
      switch (error.status) {
        case 400:
          return new AIProviderError(
            AIFailureKind.INVALID_REQUEST,
            REJECTION_REASON[diagnose(error).category],
          );
        case 401:
        case 403:
          return new AIProviderError(AIFailureKind.AUTHENTICATION, 'the credential was rejected');
        case 404:
          return new AIProviderError(
            AIFailureKind.MODEL_UNAVAILABLE,
            'the configured model is not available',
          );
        case 408:
          return new AIProviderError(AIFailureKind.TIMEOUT, 'the provider timed out', retryAfter);
        case 429:
          return new AIProviderError(AIFailureKind.RATE_LIMITED, 'rate limited', retryAfter);
        case 529:
          return new AIProviderError(
            AIFailureKind.OVERLOADED,
            'the provider is overloaded',
            retryAfter,
          );
        default:
          break;
      }
      if (error.status !== undefined && error.status >= 500) {
        return new AIProviderError(
          AIFailureKind.OVERLOADED,
          'the provider returned an error',
          retryAfter,
        );
      }
      return new AIProviderError(AIFailureKind.UNKNOWN_PROVIDER_ERROR, 'the provider call failed');
    }

    if (error instanceof Error && /abort|timeout/i.test(error.name + error.message)) {
      return new AIProviderError(AIFailureKind.TIMEOUT, 'the provider timed out');
    }
    if (error instanceof Anthropic.APIConnectionError) {
      return new AIProviderError(AIFailureKind.NETWORK, 'the provider was unreachable');
    }
    return new AIProviderError(AIFailureKind.UNKNOWN_PROVIDER_ERROR, 'the provider call failed');
  }
}

/**
 * The JSON Schema for one structured output, as a self-contained document.
 *
 * The shared schema file is a bundle of `$defs`, and a provider is sent the
 * single definition it must satisfy — with the bundle's `$defs` carried along
 * so internal `$ref`s still resolve.
 */
/** Proposals per Pass B call when the caller does not say (the batch size). */
const DEFAULT_PROPOSALS_PER_CALL = 10;

/** The value, if PalCert's validator accepted it; otherwise invalid output. */
function accepted<T>(value: unknown, valid: boolean): T {
  if (!valid) {
    throw new AIProviderError(
      AIFailureKind.OUTPUT_INVALID,
      'the provider response failed PalCert validation',
    );
  }
  return value as T;
}

const assessmentSchemas = new Map<string, Record<string, unknown>>();

function assessmentSchemaFor(name: string): Record<string, unknown> {
  // One object per name, so the provider form of it is prepared once.
  const cached = assessmentSchemas.get(name);
  if (cached !== undefined) return cached;
  const bundle = AI_ASSESSMENT_JSON_SCHEMA as unknown as {
    $defs: Record<string, Record<string, unknown>>;
  };
  const definition = bundle.$defs[name];
  if (definition === undefined) {
    throw new AIProviderError(
      AIFailureKind.INVALID_REQUEST,
      `no shared schema definition named ${name}`,
    );
  }
  const schema = { ...definition, $defs: bundle.$defs };
  assessmentSchemas.set(name, schema);
  return schema;
}

/**
 * What kind of rejection a provider error is, in PalCert's words.
 *
 * Only these categories reach the error PalCert records; the provider's own
 * message is logged (sanitized, below) and never stored.
 */
export type ProviderRejectionCategory =
  'SPEND_LIMIT' | 'OUTPUT_SCHEMA' | 'REQUEST_TOO_LARGE' | 'MODEL_PARAMETER' | 'OTHER';

const REJECTION_REASON: Record<ProviderRejectionCategory, string> = {
  SPEND_LIMIT: 'the request was rejected: provider credit or spend limit',
  OUTPUT_SCHEMA: 'the request was rejected: output schema not accepted',
  REQUEST_TOO_LARGE: 'the request was rejected: request too large',
  MODEL_PARAMETER: 'the request was rejected: a model parameter was not accepted',
  OTHER: 'the request was rejected',
};

/**
 * A provider error reduced to what an operator needs and nothing more.
 *
 * - `requestId`: the provider's own id, restricted to id characters.
 * - `type`: the provider's error type (`invalid_request_error` …).
 * - `category`: PalCert's classification of the message.
 * - `message`: the provider's message with every quoted span removed (that is
 *   where a provider echoes a value from the request), anything shaped like a
 *   credential masked, single line, at most 200 characters.
 */
export function diagnose(error: InstanceType<typeof Anthropic.APIError>): {
  requestId: string;
  type: string;
  category: ProviderRejectionCategory;
  message: string;
} {
  const body = error.error as { error?: { type?: unknown; message?: unknown } } | undefined;
  const rawMessage = typeof body?.error?.message === 'string' ? body.error.message : '';
  const rawType = error.type ?? body?.error?.type;
  const lower = rawMessage.toLowerCase();

  let category: ProviderRejectionCategory = 'OTHER';
  if (/credit balance|spend(ing)? limit|billing|usage limit|quota/.test(lower)) {
    category = 'SPEND_LIMIT';
  } else if (/output_config|output_format|json_schema|schema|grammar/.test(lower)) {
    category = 'OUTPUT_SCHEMA';
  } else if (/too long|too large|too many tokens|context window|exceeds/.test(lower)) {
    category = 'REQUEST_TOO_LARGE';
  } else if (/model|thinking|effort|temperature|max_tokens/.test(lower)) {
    category = 'MODEL_PARAMETER';
  }

  const message = rawMessage
    .replace(/"[^"]*"|'[^']*'|`[^`]*`/g, '"…"')
    .replace(/sk-[A-Za-z0-9_-]{8,}/g, '[credential]')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 200);

  const requestId =
    typeof error.requestID === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(error.requestID)
      ? error.requestID
      : 'none';
  const type = typeof rawType === 'string' && /^[a-z_]{1,64}$/.test(rawType) ? rawType : 'unknown';

  return { requestId, type, category, message };
}

/**
 * Honour the provider's own backoff hint when it gives one (§56).
 *
 * The SDK exposes response headers as a `Headers` instance rather than a plain
 * object, so both shapes are read: waiting the interval a rate limiter asked
 * for is far better behaved than guessing one.
 */
function retryAfterSeconds(error: InstanceType<typeof Anthropic.APIError>): number | null {
  const headers = (error as unknown as { headers?: Headers | Record<string, string> }).headers;
  if (headers === undefined) return null;

  const raw =
    typeof (headers as Headers).get === 'function'
      ? (headers as Headers).get('retry-after')
      : ((headers as Record<string, string>)['retry-after'] ?? null);
  if (raw === null || raw === undefined) return null;

  const seconds = Number.parseInt(raw, 10);
  return Number.isFinite(seconds) && seconds >= 0 ? seconds : null;
}

/**
 * One source, as a provider document block with citations enabled.
 *
 * A PDF goes as bytes because reading a PDF is the task. A DOCX does not:
 * there is no DOCX document block, and sending OOXML would be sending a ZIP to
 * a text model. PalCert's own analyzer has already produced the structure, so
 * the text goes as custom content — one block per node — and the provider's
 * block indices map straight back to PalCert node ids (§27, §28, §29).
 */
function documentBlock(document: ExtractionDocument): Anthropic.DocumentBlockParam {
  if (document.kind === 'PDF') {
    return {
      type: 'document',
      source: {
        type: 'base64',
        media_type: 'application/pdf',
        data: document.bytes.toString('base64'),
      },
      title: document.title,
      citations: { enabled: true },
    };
  }
  return {
    type: 'document',
    source: {
      type: 'content',
      content: document.blocks.map((text) => ({ type: 'text' as const, text })),
    },
    title: document.title,
    citations: { enabled: true },
  };
}

/**
 * Turn one provider citation into PalCert's own locator.
 *
 * `document_index` is the position in the content blocks PalCert sent, which is
 * why the adapter captured that order before the call rather than trusting the
 * response to identify the document. A citation naming a document PalCert did
 * not send is dropped: it locates nothing (§55).
 */
function normalizeCitation(
  citation: Anthropic.TextCitation,
  documentOrder: readonly string[],
): DiscoveredCitation | null {
  const sourceAssetId =
    documentOrder[(citation as { document_index?: number }).document_index ?? -1];
  if (sourceAssetId === undefined) return null;

  switch (citation.type) {
    case 'page_location':
      return {
        kind: 'PDF_PAGE',
        sourceAssetId,
        citedText: citation.cited_text,
        startPage: citation.start_page_number,
        endPage: citation.end_page_number,
      };
    case 'content_block_location':
      return {
        kind: 'DOCX_BLOCK',
        sourceAssetId,
        citedText: citation.cited_text,
        startBlockIndex: citation.start_block_index,
        endBlockIndex: citation.end_block_index,
      };
    case 'char_location':
      return {
        kind: 'TEXT_CHAR',
        sourceAssetId,
        citedText: citation.cited_text,
        startCharIndex: citation.start_char_index,
        endCharIndex: citation.end_char_index,
      };
    default:
      // Web-search and search-result citations cannot arise: PalCert declares
      // no tools. Anything else is not a location in a document PalCert sent.
      return null;
  }
}
