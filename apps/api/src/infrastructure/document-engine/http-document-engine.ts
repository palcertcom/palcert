import { Injectable } from '@nestjs/common';
import {
  EvaluationContract,
  REQUEST_ID_HEADER,
  validateEvaluationContract,
  type EvaluationResponse,
} from '@palcert/contracts';
import { createHash } from 'node:crypto';
import { ApiConfigService } from '../../config/api-config.service';
import {
  DocumentEngineError,
  DocumentEnginePort,
  type AnalyzeDocumentRequest,
  type AnalyzeDocumentResult,
  type DocumentEngineFailureKind,
  type EvaluateRulesRequest,
  type EvaluateRulesResult,
  SmartFixEngineError,
  type ApplySmartFixRequest,
  type ApplySmartFixResult,
  type DocxPropertyDescriptor,
  type PlanSmartFixRequest,
  type PlanSmartFixResult,
} from './document-engine.port';
import { decodeFrame, encodeFrame } from './smartfix-framing';

/** The analyzer's catalogue changes only when the analyzer is deployed. */
const CATALOGUE_TTL_MS = 5 * 60 * 1000;

/**
 * HTTP adapter for the Python analyzer.
 *
 * Two things it insists on.
 *
 * **The artifact is never re-encoded.** The response body is kept as the exact
 * bytes the analyzer produced and its digest is verified here. Parsing and
 * re-serializing would produce a different byte string with a different hash,
 * silently destroying the integrity property the hash exists for (§87).
 *
 * **Failures are classified, not merely reported.** The analyzer separates
 * "this document cannot be analyzed" from "the analyzer could not run", and
 * that distinction decides whether the job retries or stops (§91). Losing it
 * would mean either retrying a malformed file for ever or giving up on a
 * transient outage.
 */
@Injectable()
export class HttpDocumentEngine extends DocumentEnginePort {
  constructor(private readonly config: ApiConfigService) {
    super();
  }

  async analyzeDocument(request: AnalyzeDocumentRequest): Promise<AnalyzeDocumentResult> {
    const engine = this.config.documentEngine;
    // One route per analyzer. The format comes from the version's detected
    // format, so a caller cannot reach the PDF analyzer with a DOCX by asking
    // nicely (§83).
    const url = `${engine.baseUrl}${request.format === 'PDF' ? '/analysis/pdf' : '/analysis/docx'}`;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), engine.analysisTimeoutMs);

    let response: Response;
    try {
      response = await fetch(url, {
        method: 'POST',
        body: new Uint8Array(request.content),
        signal: controller.signal,
        headers: {
          'content-type': 'application/octet-stream',
          'x-palcert-document-id': request.documentId,
          'x-palcert-expected-sha256': request.expectedSha256,
          ...(request.requestId ? { [REQUEST_ID_HEADER]: request.requestId } : {}),
        },
      });
    } catch (error) {
      // Aborted, refused, DNS, TLS: the engine did not answer. Transient.
      throw new DocumentEngineError('ENGINE', null, describe(error));
    } finally {
      clearTimeout(timer);
    }

    if (!response.ok) {
      throw await this.failureFor(response);
    }

    const artifact = Buffer.from(await response.arrayBuffer());
    const declared = response.headers.get('x-palcert-artifact-sha256') ?? '';
    const actual = createHash('sha256').update(artifact).digest('hex');
    if (declared !== actual) {
      // The bytes did not survive the hop. Transient: the next attempt may.
      throw new DocumentEngineError('ENGINE', null, 'artifact digest mismatch in transit');
    }

    return {
      artifact,
      artifactSha256: actual,
      analyzerName: header(response, 'x-palcert-analyzer-name'),
      analyzerVersion: header(response, 'x-palcert-analyzer-version'),
      factSchemaVersion: headerNumber(response, 'x-palcert-fact-schema-version'),
      analysisSchemaVersion: headerNumber(response, 'x-palcert-analysis-schema-version'),
      factCount: headerNumber(response, 'x-palcert-fact-count'),
      warningCount: headerNumber(response, 'x-palcert-warning-count'),
      warningCodes: (response.headers.get('x-palcert-warning-codes') ?? '')
        .split(',')
        .map((code) => code.trim())
        .filter((code) => code.length > 0),
      summary: parseSummary(response.headers.get('x-palcert-summary')),
      durationMs: headerNumber(response, 'x-palcert-duration-ms'),
    };
  }

  /**
   * Evaluate published rules against a fact set.
   *
   * Unlike the analysis hop, the response body is parsed rather than kept as
   * bytes: the orchestrator builds its own canonical report from these results
   * and hashes that, so the engine's incidental JSON formatting is not
   * something PalCert needs to preserve. What it *does* insist on is that the
   * payload satisfies the shared contract before anything derived from it is
   * stored as evidence — a malformed response from PalCert's own service is
   * still malformed (§35).
   */
  async evaluateRules(request: EvaluateRulesRequest): Promise<EvaluateRulesResult> {
    const engine = this.config.documentEngine;
    const url = `${engine.baseUrl}/evaluation`;
    const startedAt = Date.now();

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), engine.evaluationTimeoutMs);

    let response: Response;
    try {
      response = await fetch(url, {
        method: 'POST',
        body: JSON.stringify({ factSet: request.factSet, rules: request.rules }),
        signal: controller.signal,
        headers: {
          'content-type': 'application/json',
          'x-palcert-document-id': request.documentId,
          ...(request.requestId ? { [REQUEST_ID_HEADER]: request.requestId } : {}),
        },
      });
    } catch (error) {
      throw new DocumentEngineError('ENGINE', null, describe(error));
    } finally {
      clearTimeout(timer);
    }

    if (!response.ok) {
      throw await this.failureFor(response);
    }

    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      throw new DocumentEngineError('ENGINE', null, 'the engine response is not JSON');
    }

    const validation = validateEvaluationContract(EvaluationContract.EVALUATION_RESPONSE, payload);
    if (!validation.valid) {
      // Fail closed. Storing an unvalidated shape would put whatever the
      // engine happened to emit into an immutable report (§35).
      throw new DocumentEngineError(
        'ENGINE',
        null,
        `the engine response failed its own contract: ${validation.issues[0]?.message ?? 'unknown'}`,
      );
    }

    return { response: payload as EvaluationResponse, durationMs: Date.now() - startedAt };
  }

  /**
   * The analyzer's property catalogue, cached in process.
   *
   * Cached because it changes only when the analyzer is deployed, and an
   * extraction asking for it on every proposal would add a round trip per rule
   * for an answer that cannot have moved.
   */
  private catalogue: { fetchedAt: number; properties: readonly DocxPropertyDescriptor[] } | null =
    null;

  async describeDocxProperties(): Promise<readonly DocxPropertyDescriptor[]> {
    const engine = this.config.documentEngine;
    if (this.catalogue !== null && Date.now() - this.catalogue.fetchedAt < CATALOGUE_TTL_MS) {
      return this.catalogue.properties;
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), engine.readinessTimeoutMs);
    try {
      // The DOCX router is mounted under /analysis (app/docx/api.py), next to
      // POST /analysis/docx. Without the prefix this was a 404, and every
      // rule extraction failed before reading a single source.
      const response = await fetch(`${engine.baseUrl}/analysis/docx/capabilities`, {
        signal: controller.signal,
      });
      if (!response.ok) {
        throw new DocumentEngineError(
          'ENGINE',
          null,
          `the analyzer returned ${response.status} for its capabilities`,
        );
      }
      const payload = (await response.json()) as {
        properties?: {
          name?: string;
          scopes?: string[];
          unit?: string | null;
          exactness?: string;
        }[];
      };
      const properties = (payload.properties ?? []).map((property) => ({
        name: String(property.name ?? ''),
        scopes: property.scopes ?? [],
        unit: property.unit ?? null,
        exactness: property.exactness === 'DERIVED' ? ('DERIVED' as const) : ('EXACT' as const),
      }));
      this.catalogue = { fetchedAt: Date.now(), properties };
      return properties;
    } catch (error) {
      if (error instanceof DocumentEngineError) throw error;
      // Transient by classification: PalCert cannot honestly say what it
      // supports without this, so it says nothing and the run is retried
      // rather than labelling every property "not measurable" (§53).
      throw new DocumentEngineError('ENGINE', null, 'the analyzer capabilities were unreachable');
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Ask the engine what it would change (Phase 12 §72).
   *
   * The plan body is kept as bytes for the same reason the analysis artifact
   * is: the plan hash is over these exact bytes, and re-serializing would
   * produce a different string with a different hash — destroying the property
   * that lets PalCert prove it executed the plan the user approved.
   */
  async planSmartFix(request: PlanSmartFixRequest): Promise<PlanSmartFixResult> {
    const engine = this.config.documentEngine;
    const started = Date.now();

    const response = await this.post(
      `${engine.baseUrl}/smartfix/plan`,
      encodeFrame(
        {
          rules: request.rules,
          source: request.source,
          ...(request.aiTargets ? { aiTargets: request.aiTargets } : {}),
          ...(request.includeAIContext ? { includeAIContext: true } : {}),
        },
        request.content,
      ),
      engine.analysisTimeoutMs,
      {
        'x-palcert-document-id': request.documentId,
        ...(request.requestId ? { [REQUEST_ID_HEADER]: request.requestId } : {}),
      },
      request.signal,
    );

    const responseBytes = Buffer.from(await response.arrayBuffer());
    const frame = request.includeAIContext ? decodeFrame(responseBytes) : null;
    const planBytes = frame?.document ?? responseBytes;
    const declared = response.headers.get('x-palcert-plan-sha256') ?? '';
    const actual = createHash('sha256').update(planBytes).digest('hex');
    if (declared !== actual) {
      throw new DocumentEngineError('ENGINE', null, 'plan digest mismatch in transit');
    }

    let plan: Record<string, unknown>;
    try {
      plan = JSON.parse(planBytes.toString('utf8')) as Record<string, unknown>;
    } catch {
      throw new DocumentEngineError('ENGINE', null, 'the plan was not valid JSON');
    }

    return {
      plan,
      ...(frame
        ? { aiContext: frame.payload as unknown as import('@palcert/contracts').SmartFixAIContext }
        : {}),
      planBytes,
      planSha256: actual,
      ruleCount: headerNumber(response, 'x-palcert-rule-count'),
      actionCount: headerNumber(response, 'x-palcert-action-count'),
      refusal: header(response, 'x-palcert-refusal') || null,
      fixEngineName: header(response, 'x-palcert-fix-engine-name'),
      fixEngineVersion: header(response, 'x-palcert-fix-engine-version'),
      capabilityRegistryVersion: headerNumber(response, 'x-palcert-capability-registry-version'),
      durationMs: Date.now() - started,
    };
  }

  /**
   * Apply one approved plan (Phase 12 §57).
   *
   * The corrected bytes come back framed alongside the manifest, and both
   * digests are verified here. A correction whose bytes did not survive the
   * hop is a transient failure, not a document PalCert delivers.
   */
  async applySmartFix(request: ApplySmartFixRequest): Promise<ApplySmartFixResult> {
    const engine = this.config.documentEngine;
    const started = Date.now();

    const response = await this.post(
      `${engine.baseUrl}/smartfix/apply`,
      encodeFrame(
        {
          plan: request.plan,
          planHash: request.planHash,
          expectedSourceSha256: request.expectedSourceSha256,
        },
        request.content,
      ),
      engine.analysisTimeoutMs,
      request.requestId ? { [REQUEST_ID_HEADER]: request.requestId } : {},
    );

    const body = Buffer.from(await response.arrayBuffer());
    let frame: { payload: Record<string, unknown>; document: Buffer };
    try {
      frame = decodeFrame(body);
    } catch {
      throw new DocumentEngineError('ENGINE', null, 'the correction response was not framed');
    }

    const outputSha256 = createHash('sha256').update(frame.document).digest('hex');
    if (outputSha256 !== (response.headers.get('x-palcert-output-sha256') ?? '')) {
      throw new DocumentEngineError(
        'ENGINE',
        null,
        'corrected document digest mismatch in transit',
      );
    }

    return {
      content: frame.document,
      outputSha256,
      manifest: frame.payload,
      manifestSha256: header(response, 'x-palcert-manifest-sha256'),
      entryCount: headerNumber(response, 'x-palcert-entry-count'),
      durationMs: Date.now() - started,
    };
  }

  /** One POST with the engine's timeout and its failure classification. */
  private async post(
    url: string,
    body: Buffer,
    timeoutMs: number,
    headers: Record<string, string>,
    signal?: AbortSignal,
  ): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let response: Response;
    try {
      response = await fetch(url, {
        method: 'POST',
        body: new Uint8Array(body),
        signal: signal ? AbortSignal.any([signal, controller.signal]) : controller.signal,
        headers: { 'content-type': 'application/octet-stream', ...headers },
      });
    } catch (error) {
      throw new DocumentEngineError('ENGINE', null, describe(error));
    } finally {
      clearTimeout(timer);
    }
    if (!response.ok) throw await this.fixFailureFor(response);
    return response;
  }

  /**
   * Map a refusal onto the retry policy and the user's message.
   *
   * A refusal about the *document* or the *plan* will fail identically for
   * ever, so it must not be retried: retrying a plan that does not match its
   * document would burn the user's reservation for nothing.
   */
  private async fixFailureFor(response: Response): Promise<DocumentEngineError> {
    let fixError: string | null = null;
    try {
      const body = (await response.json()) as {
        error?: { details?: { fixError?: string; analysisError?: string } };
      };
      fixError = body.error?.details?.fixError ?? body.error?.details?.analysisError ?? null;
    } catch {
      fixError = null;
    }
    const kind: DocumentEngineFailureKind =
      response.status >= 400 && response.status < 500 && response.status !== 429
        ? 'DOCUMENT'
        : 'ENGINE';
    return new SmartFixEngineError(kind, fixError, `the fix engine responded ${response.status}`);
  }

  async checkReadiness(): Promise<{ ok: boolean; message?: string }> {
    const engine = this.config.documentEngine;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), engine.readinessTimeoutMs);
    try {
      const response = await fetch(`${engine.baseUrl}/health/ready`, {
        signal: controller.signal,
      });
      return response.ok ? { ok: true } : { ok: false, message: 'not ready' };
    } catch {
      // No endpoint, no reason: the readiness body is public (§116).
      return { ok: false, message: 'unreachable' };
    } finally {
      clearTimeout(timer);
    }
  }

  private async failureFor(response: Response): Promise<DocumentEngineError> {
    let analysisError: string | null = null;
    try {
      const body = (await response.json()) as {
        error?: { details?: { analysisError?: string } };
      };
      analysisError = body.error?.details?.analysisError ?? null;
    } catch {
      analysisError = null;
    }

    // 4xx other than 429 means the analyzer read the document and refused it;
    // 5xx, 429 and anything unrecognized means the analyzer itself is unwell.
    const kind: DocumentEngineFailureKind =
      response.status >= 400 && response.status < 500 && response.status !== 429
        ? 'DOCUMENT'
        : 'ENGINE';
    return new DocumentEngineError(kind, analysisError, `analyzer responded ${response.status}`);
  }
}

function header(response: Response, name: string): string {
  return response.headers.get(name) ?? '';
}

function headerNumber(response: Response, name: string): number {
  const value = Number.parseInt(response.headers.get(name) ?? '', 10);
  return Number.isFinite(value) ? value : 0;
}

/** How long a summary string may be before it stops being a classification. */
const MAX_SUMMARY_STRING = 64;

/**
 * The analyzer's summary, narrowed to what a summary is allowed to be.
 *
 * Counters, flags and short classifications — nothing nested, nothing long.
 * This value is stored, returned to the browser and logged, so the filter is
 * the thing standing between a header and a document's title (§71, §107). A
 * value that does not fit is dropped rather than truncated: half a title is
 * still a title.
 */
function parseSummary(raw: string | null): Record<string, number | string | boolean> {
  if (raw === null) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) return {};
    const summary: Record<string, number | string | boolean> = {};
    for (const [key, value] of Object.entries(parsed)) {
      if (typeof value === 'number' && Number.isFinite(value)) summary[key] = value;
      else if (typeof value === 'boolean') summary[key] = value;
      else if (typeof value === 'string' && value.length <= MAX_SUMMARY_STRING) {
        summary[key] = value;
      }
    }
    return summary;
  } catch {
    return {};
  }
}

function describe(error: unknown): string {
  if (error instanceof Error) {
    return error.name === 'AbortError' ? 'analyzer timed out' : error.message.slice(0, 200);
  }
  return 'analyzer unreachable';
}
