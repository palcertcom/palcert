import type { AIProviderUsage } from '../ai/provider.js';
import type { PalCertRuleProposalOutput } from './proposal.generated.js';

/**
 * The extraction half of the AI provider port (§18).
 *
 * Added to `AIProviderPort` rather than beside it: there is one boundary
 * between PalCert and a model vendor, and a second one would be a second place
 * to forget a guarantee. Everything here obeys the Phase 8 rules unchanged —
 * no tools, no credentials, no callbacks, validated output.
 *
 * Two shapes, because the current Anthropic API cannot serve one. Citations and
 * structured outputs are mutually exclusive in a single request, so evidence
 * discovery (which needs grounded quotations) and rule structuring (which needs
 * a constrained object) are separate calls with separate contracts (§23, §85).
 */

/**
 * One document as PalCert hands it to a provider for evidence discovery.
 *
 * `PDF` carries the bytes, because reading a PDF is the task. `BLOCKS` carries
 * PalCert-extracted text, one block per structural node, so a citation's block
 * index maps back to an exact PalCert node id without guessing (§29).
 */
export type ExtractionDocument =
  | {
      readonly kind: 'PDF';
      /** Correlation only. The provider never resolves it (§42). */
      readonly sourceAssetId: string;
      readonly title: string;
      readonly bytes: Buffer;
    }
  | {
      readonly kind: 'BLOCKS';
      readonly sourceAssetId: string;
      readonly title: string;
      /** Block *i* is PalCert's `nodeIds[i]`. The mapping is positional and exact. */
      readonly blocks: readonly string[];
      readonly nodeIds: readonly string[];
    };

/** Pass A: find candidate normative passages, grounded in citations (§24). */
export interface EvidenceDiscoveryRequest {
  /** Correlation only. */
  readonly extractionRunId: string;
  readonly systemPrompt: string;
  readonly instruction: string;
  readonly documents: readonly ExtractionDocument[];
}

/**
 * One grounded citation, normalized out of the provider's own citation blocks.
 *
 * PalCert never treats the model's prose as the extraction (§25). This is built
 * from the structured citation data the provider returns, which is the only
 * part of a Pass A response that can be checked against the document.
 */
export type DiscoveredCitation =
  | {
      readonly kind: 'PDF_PAGE';
      readonly sourceAssetId: string;
      readonly citedText: string;
      readonly startPage: number;
      readonly endPage: number;
    }
  | {
      readonly kind: 'DOCX_BLOCK';
      readonly sourceAssetId: string;
      readonly citedText: string;
      /** Inclusive start, exclusive end, in the blocks PalCert supplied. */
      readonly startBlockIndex: number;
      readonly endBlockIndex: number;
    }
  | {
      readonly kind: 'TEXT_CHAR';
      readonly sourceAssetId: string;
      readonly citedText: string;
      readonly startCharIndex: number;
      readonly endCharIndex: number;
    };

export interface EvidenceDiscoveryProviderResponse {
  readonly citations: readonly DiscoveredCitation[];
  /**
   * How many text blocks carried no citation at all.
   *
   * A count, never the prose itself: ungrounded model text is not evidence and
   * is deliberately not persisted (§25, §56).
   */
  readonly ungroundedBlockCount: number;
  readonly usage: AIProviderUsage;
}

/** Pass B: turn verified evidence into structured proposals (§41). */
export interface RuleProposalRequest {
  readonly extractionRunId: string;
  readonly systemPrompt: string;
  readonly userPrompt: string;
  /** Exactly the evidence ids PalCert supplied; anything else is fabricated (§55). */
  readonly suppliedEvidenceIds: readonly string[];
  /**
   * The most proposals this one call may return (the batch size). An answer
   * with more is refused, not truncated. Omitted, a provider uses its own
   * default batch size.
   */
  readonly maxProposals?: number;
}

export interface RuleProposalProviderResponse {
  readonly output: PalCertRuleProposalOutput;
  readonly usage: AIProviderUsage;
}
