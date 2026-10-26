import { Injectable } from '@nestjs/common';
import {
  AIContract,
  AIFailureKind,
  AIProviderError,
  validateAIContract,
  type AIContextBundle,
  type AIRuleAssessment,
  type AIRuleAssessmentResponse,
} from '@palcert/contracts';

/**
 * PalCert's independent validation of provider output (§29, §34, §35, §74).
 *
 * The provider constrained the shape; this class decides whether the content
 * is admissible as evidence. Those are different questions, and only the
 * second one protects the user.
 *
 * Three things are checked that no schema can express:
 *
 * **The rule set is exactly what was asked.** Not a superset: a model that
 * noticed something else about the document and added a finding for it has
 * produced an unsolicited assessment, which is a different feature with
 * different consent (§35). Not a subset either — a silently missing rule would
 * leave a requirement looking unexamined when it was requested.
 *
 * **Every cited node id was supplied.** A model can produce a plausible-looking
 * locator it was never given, and a fabricated citation is worse than no
 * citation: it sends someone to a part of their document that has nothing to
 * do with the finding, and it makes the whole review untrustworthy (§29).
 *
 * **No duplicates.** One assessment per rule, so a UI cannot show two verdicts
 * for the same requirement.
 *
 * Anything that fails is rejected in full. There is no partial acceptance: a
 * response containing one fabricated citation is a response from a model that
 * was willing to fabricate, and the rest of it has not earned more trust.
 */
@Injectable()
export class AIOutputValidator {
  /**
   * Validate a rule-assessment response against what was actually requested.
   *
   * @throws AIProviderError with `OUTPUT_INVALID` — never a partial result.
   */
  validateAssessments(params: {
    readonly response: unknown;
    readonly requestedRuleCodes: readonly string[];
    readonly context: AIContextBundle;
  }): AIRuleAssessmentResponse {
    const contract = validateAIContract(AIContract.RULE_ASSESSMENT_RESPONSE, params.response);
    if (!contract.valid) {
      throw this.reject(
        `the response does not satisfy the AI contract: ${contract.issues[0]?.path ?? '/'} ${contract.issues[0]?.message ?? ''}`.trim(),
      );
    }

    const response = params.response as AIRuleAssessmentResponse;
    const requested = new Set(params.requestedRuleCodes);
    const seen = new Set<string>();

    for (const assessment of response.assessments) {
      if (!requested.has(assessment.ruleCode)) {
        // The model assessed something nobody asked about.
        throw this.reject(`the response assessed a rule that was not requested`);
      }
      if (seen.has(assessment.ruleCode)) {
        throw this.reject('the response assessed the same rule more than once');
      }
      seen.add(assessment.ruleCode);
      this.validateEvidence(assessment, params.context);
    }

    if (seen.size !== requested.size) {
      const missing = [...requested].filter((code) => !seen.has(code));
      throw this.reject(`the response omitted ${missing.length} requested rule(s)`);
    }

    return response;
  }

  /** Validate a supplement response against the shared contract (§39). */
  validateSupplement(response: unknown): void {
    const contract = validateAIContract(AIContract.REPORT_SUPPLEMENT_RESPONSE, response);
    if (!contract.valid) {
      throw this.reject(
        `the supplement does not satisfy the AI contract: ${contract.issues[0]?.message ?? 'unknown'}`,
      );
    }
  }

  /**
   * Every cited id must be one PalCert supplied for this task (§29).
   *
   * The allowed set is the evidence nodes and the outline entries — the things
   * the model was actually shown. An id that appeared *inside* document text
   * is not in that set, which is what stops a document from nominating its own
   * evidence.
   */
  private validateEvidence(assessment: AIRuleAssessment, context: AIContextBundle): void {
    const supplied = new Set<string>([
      ...context.nodes.map((node) => node.nodeId),
      ...context.outline.map((entry) => entry.nodeId),
    ]);

    for (const nodeId of assessment.evidenceNodeIds) {
      if (!supplied.has(nodeId)) {
        throw this.reject('the response cited evidence that was never supplied');
      }
    }

    // A SATISFIED or NOT_SATISFIED verdict with no evidence at all is a
    // conclusion with nothing behind it. INSUFFICIENT_EVIDENCE is the honest
    // answer in that situation, and the model is told so (§32).
    if (
      assessment.assessment !== 'INSUFFICIENT_EVIDENCE' &&
      assessment.evidenceNodeIds.length === 0
    ) {
      throw this.reject('the response reached a conclusion without citing any evidence');
    }
  }

  /**
   * Reject, carrying no provider text.
   *
   * The message names what PalCert objected to, never what the model said: an
   * error body is a place model output could otherwise escape validation and
   * reach a log or a user (§55, §81).
   */
  private reject(reason: string): AIProviderError {
    return new AIProviderError(AIFailureKind.OUTPUT_INVALID, reason);
  }
}
