/* eslint-disable */
/**
 * GENERATED FILE — DO NOT EDIT.
 *
 * Source: contracts/schemas/ai-assessment.schema.json
 * Regenerate: pnpm --filter @palcert/contracts run generate:evaluation
 *
 * Editing this by hand would reintroduce exactly the drift the generation step
 * exists to prevent.
 */
/**
 * This interface was referenced by `PalCertAIAssessmentOutput`'s JSON-Schema
 * via the `definition` "NodeId".
 */
export type NodeId = string;
/**
 * INSUFFICIENT_EVIDENCE is a first-class, encouraged answer. A model pressed to guess produces a confident sentence about a document it could not see, which is the most damaging thing it could do here.
 *
 * This interface was referenced by `PalCertAIAssessmentOutput`'s JSON-Schema
 * via the `definition` "Assessment".
 */
export type Assessment = 'SATISFIED' | 'NOT_SATISFIED' | 'INSUFFICIENT_EVIDENCE';
/**
 * Whether the supplied context could support a conclusion at all. Deliberately two-valued: a numeric confidence would be read as a calibrated probability, which it is not.
 *
 * This interface was referenced by `PalCertAIAssessmentOutput`'s JSON-Schema
 * via the `definition` "EvidenceSufficiency".
 */
export type EvidenceSufficiency = 'SUFFICIENT' | 'INSUFFICIENT';
/**
 * A closed vocabulary, so the UI never renders model prose as a status.
 *
 * This interface was referenced by `PalCertAIAssessmentOutput`'s JSON-Schema
 * via the `definition` "AssessmentReasonCode".
 */
export type AssessmentReasonCode =
  | 'REQUIREMENT_MET'
  | 'REQUIREMENT_NOT_MET'
  | 'REQUIREMENT_PARTIALLY_MET'
  | 'EVIDENCE_NOT_PRESENT'
  | 'EVIDENCE_AMBIGUOUS'
  | 'CONTEXT_TRUNCATED'
  | 'RULE_NOT_APPLICABLE'
  | 'PROVIDER_DECLINED';
/**
 * This interface was referenced by `PalCertAIAssessmentOutput`'s JSON-Schema
 * via the `definition` "UncertaintyReason".
 */
export type UncertaintyReason =
  | 'SECTION_NOT_FOUND'
  | 'STATEMENT_AMBIGUOUS'
  | 'LANGUAGE_UNCLEAR'
  | 'CONTEXT_INCOMPLETE'
  | 'CONFLICTING_STATEMENTS'
  | 'REQUIRES_DOMAIN_JUDGEMENT';

/**
 * What an AI provider is permitted to return.
 *
 * This schema is both the provider's structured-output constraint and PalCert's own independent validation. Those are deliberately the same document and deliberately applied twice: a provider honouring a schema is a convenience, not a guarantee, and nothing derived from an unvalidated payload is ever persisted.
 *
 * The vocabulary is separate from the deterministic one on purpose. A machine rule PASSES or FAILS; an AI rule *appears* satisfied or not, on the evidence it was shown. Reusing PASS/FAIL here would erase in the data model the distinction the whole phase exists to preserve.
 */
export interface PalCertAIAssessmentOutput {
  [k: string]: unknown;
}
/**
 * This interface was referenced by `PalCertAIAssessmentOutput`'s JSON-Schema
 * via the `definition` "AIRuleAssessment".
 */
export interface AIRuleAssessment {
  ruleCode: string;
  assessment: Assessment;
  reasonCode: AssessmentReasonCode;
  evidenceSufficiency: EvidenceSufficiency;
  /**
   * Every id must be one PalCert supplied for this task. An id PalCert never sent is a fabricated citation, and the whole response is rejected rather than stored as evidence.
   *
   * @maxItems 20
   */
  evidenceNodeIds:
    | []
    | [NodeId]
    | [NodeId, NodeId]
    | [NodeId, NodeId, NodeId]
    | [NodeId, NodeId, NodeId, NodeId]
    | [NodeId, NodeId, NodeId, NodeId, NodeId]
    | [NodeId, NodeId, NodeId, NodeId, NodeId, NodeId]
    | [NodeId, NodeId, NodeId, NodeId, NodeId, NodeId, NodeId]
    | [NodeId, NodeId, NodeId, NodeId, NodeId, NodeId, NodeId, NodeId]
    | [NodeId, NodeId, NodeId, NodeId, NodeId, NodeId, NodeId, NodeId, NodeId]
    | [NodeId, NodeId, NodeId, NodeId, NodeId, NodeId, NodeId, NodeId, NodeId, NodeId]
    | [NodeId, NodeId, NodeId, NodeId, NodeId, NodeId, NodeId, NodeId, NodeId, NodeId, NodeId]
    | [
        NodeId,
        NodeId,
        NodeId,
        NodeId,
        NodeId,
        NodeId,
        NodeId,
        NodeId,
        NodeId,
        NodeId,
        NodeId,
        NodeId,
      ]
    | [
        NodeId,
        NodeId,
        NodeId,
        NodeId,
        NodeId,
        NodeId,
        NodeId,
        NodeId,
        NodeId,
        NodeId,
        NodeId,
        NodeId,
        NodeId,
      ]
    | [
        NodeId,
        NodeId,
        NodeId,
        NodeId,
        NodeId,
        NodeId,
        NodeId,
        NodeId,
        NodeId,
        NodeId,
        NodeId,
        NodeId,
        NodeId,
        NodeId,
      ]
    | [
        NodeId,
        NodeId,
        NodeId,
        NodeId,
        NodeId,
        NodeId,
        NodeId,
        NodeId,
        NodeId,
        NodeId,
        NodeId,
        NodeId,
        NodeId,
        NodeId,
        NodeId,
      ]
    | [
        NodeId,
        NodeId,
        NodeId,
        NodeId,
        NodeId,
        NodeId,
        NodeId,
        NodeId,
        NodeId,
        NodeId,
        NodeId,
        NodeId,
        NodeId,
        NodeId,
        NodeId,
        NodeId,
      ]
    | [
        NodeId,
        NodeId,
        NodeId,
        NodeId,
        NodeId,
        NodeId,
        NodeId,
        NodeId,
        NodeId,
        NodeId,
        NodeId,
        NodeId,
        NodeId,
        NodeId,
        NodeId,
        NodeId,
        NodeId,
      ]
    | [
        NodeId,
        NodeId,
        NodeId,
        NodeId,
        NodeId,
        NodeId,
        NodeId,
        NodeId,
        NodeId,
        NodeId,
        NodeId,
        NodeId,
        NodeId,
        NodeId,
        NodeId,
        NodeId,
        NodeId,
        NodeId,
      ]
    | [
        NodeId,
        NodeId,
        NodeId,
        NodeId,
        NodeId,
        NodeId,
        NodeId,
        NodeId,
        NodeId,
        NodeId,
        NodeId,
        NodeId,
        NodeId,
        NodeId,
        NodeId,
        NodeId,
        NodeId,
        NodeId,
        NodeId,
      ]
    | [
        NodeId,
        NodeId,
        NodeId,
        NodeId,
        NodeId,
        NodeId,
        NodeId,
        NodeId,
        NodeId,
        NodeId,
        NodeId,
        NodeId,
        NodeId,
        NodeId,
        NodeId,
        NodeId,
        NodeId,
        NodeId,
        NodeId,
        NodeId,
      ];
  /**
   * @maxItems 6
   */
  uncertaintyReasons?:
    | []
    | [UncertaintyReason]
    | [UncertaintyReason, UncertaintyReason]
    | [UncertaintyReason, UncertaintyReason, UncertaintyReason]
    | [UncertaintyReason, UncertaintyReason, UncertaintyReason, UncertaintyReason]
    | [
        UncertaintyReason,
        UncertaintyReason,
        UncertaintyReason,
        UncertaintyReason,
        UncertaintyReason,
      ]
    | [
        UncertaintyReason,
        UncertaintyReason,
        UncertaintyReason,
        UncertaintyReason,
        UncertaintyReason,
        UncertaintyReason,
      ];
  explanationEn: string;
  explanationAr: string;
}
/**
 * This interface was referenced by `PalCertAIAssessmentOutput`'s JSON-Schema
 * via the `definition` "AIRuleAssessmentResponse".
 */
export interface AIRuleAssessmentResponse {
  schemaVersion: number;
  /**
   * Exactly the rules that were requested — no more, no fewer, no duplicates. A rule the model added because it noticed something else is an unsolicited finding, which is a different feature with different consent.
   *
   * @minItems 1
   * @maxItems 100
   */
  assessments: [AIRuleAssessment, ...AIRuleAssessment[]];
}
/**
 * Something the author could do next. Phrased as advice, never as a report of work PalCert has already performed — nothing in Phase 8 changes a document.
 *
 * This interface was referenced by `PalCertAIAssessmentOutput`'s JSON-Schema
 * via the `definition` "PriorityRecommendation".
 */
export interface PriorityRecommendation {
  priority: 'HIGH' | 'MEDIUM' | 'LOW';
  /**
   * @maxItems 20
   */
  relatedRuleCodes:
    | []
    | [string]
    | [string, string]
    | [string, string, string]
    | [string, string, string, string]
    | [string, string, string, string, string]
    | [string, string, string, string, string, string]
    | [string, string, string, string, string, string, string]
    | [string, string, string, string, string, string, string, string]
    | [string, string, string, string, string, string, string, string, string]
    | [string, string, string, string, string, string, string, string, string, string]
    | [string, string, string, string, string, string, string, string, string, string, string]
    | [
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
      ]
    | [
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
      ]
    | [
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
      ]
    | [
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
      ]
    | [
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
      ]
    | [
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
      ]
    | [
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
      ]
    | [
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
      ]
    | [
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
        string,
      ];
  textEn: string;
  textAr: string;
}
/**
 * The user-facing narrative. It explains the deterministic report; it never restates a score, issues a determination, or says anything about approval, acceptance or certification.
 *
 * This interface was referenced by `PalCertAIAssessmentOutput`'s JSON-Schema
 * via the `definition` "AIReportSupplementResponse".
 */
export interface AIReportSupplementResponse {
  schemaVersion: number;
  summaryEn: string;
  summaryAr: string;
  /**
   * @maxItems 12
   */
  priorityRecommendations:
    | []
    | [PriorityRecommendation]
    | [PriorityRecommendation, PriorityRecommendation]
    | [PriorityRecommendation, PriorityRecommendation, PriorityRecommendation]
    | [
        PriorityRecommendation,
        PriorityRecommendation,
        PriorityRecommendation,
        PriorityRecommendation,
      ]
    | [
        PriorityRecommendation,
        PriorityRecommendation,
        PriorityRecommendation,
        PriorityRecommendation,
        PriorityRecommendation,
      ]
    | [
        PriorityRecommendation,
        PriorityRecommendation,
        PriorityRecommendation,
        PriorityRecommendation,
        PriorityRecommendation,
        PriorityRecommendation,
      ]
    | [
        PriorityRecommendation,
        PriorityRecommendation,
        PriorityRecommendation,
        PriorityRecommendation,
        PriorityRecommendation,
        PriorityRecommendation,
        PriorityRecommendation,
      ]
    | [
        PriorityRecommendation,
        PriorityRecommendation,
        PriorityRecommendation,
        PriorityRecommendation,
        PriorityRecommendation,
        PriorityRecommendation,
        PriorityRecommendation,
        PriorityRecommendation,
      ]
    | [
        PriorityRecommendation,
        PriorityRecommendation,
        PriorityRecommendation,
        PriorityRecommendation,
        PriorityRecommendation,
        PriorityRecommendation,
        PriorityRecommendation,
        PriorityRecommendation,
        PriorityRecommendation,
      ]
    | [
        PriorityRecommendation,
        PriorityRecommendation,
        PriorityRecommendation,
        PriorityRecommendation,
        PriorityRecommendation,
        PriorityRecommendation,
        PriorityRecommendation,
        PriorityRecommendation,
        PriorityRecommendation,
        PriorityRecommendation,
      ]
    | [
        PriorityRecommendation,
        PriorityRecommendation,
        PriorityRecommendation,
        PriorityRecommendation,
        PriorityRecommendation,
        PriorityRecommendation,
        PriorityRecommendation,
        PriorityRecommendation,
        PriorityRecommendation,
        PriorityRecommendation,
        PriorityRecommendation,
      ]
    | [
        PriorityRecommendation,
        PriorityRecommendation,
        PriorityRecommendation,
        PriorityRecommendation,
        PriorityRecommendation,
        PriorityRecommendation,
        PriorityRecommendation,
        PriorityRecommendation,
        PriorityRecommendation,
        PriorityRecommendation,
        PriorityRecommendation,
        PriorityRecommendation,
      ];
}
/**
 * The canonical object an `aiReviewHash` is computed over. Separate from the Phase 7 report hash in every way — different schema, different canonicalization version, different field — because conflating them would let AI output borrow the authority of a machine measurement.
 *
 * This interface was referenced by `PalCertAIAssessmentOutput`'s JSON-Schema
 * via the `definition` "AIReviewDigest".
 */
export interface AIReviewDigest {
  aiReviewSchemaVersion: number;
  aiReviewCanonicalizationVersion: number;
  provider: string;
  configuredModel: string;
  providerReturnedModel?: string;
  promptVersion: string;
  promptHash: string;
  contextBuilderVersion: string;
  contextHash: string;
  rulesHash: string;
  boundReportHash: string;
  boundEvaluationHash: string;
  /**
   * @maxItems 100
   */
  assessments: {
    ruleCode: string;
    assessment: Assessment;
    reasonCode: AssessmentReasonCode;
    evidenceSufficiency: EvidenceSufficiency;
    /**
     * @maxItems 20
     */
    evidenceNodeIds:
      | []
      | [NodeId]
      | [NodeId, NodeId]
      | [NodeId, NodeId, NodeId]
      | [NodeId, NodeId, NodeId, NodeId]
      | [NodeId, NodeId, NodeId, NodeId, NodeId]
      | [NodeId, NodeId, NodeId, NodeId, NodeId, NodeId]
      | [NodeId, NodeId, NodeId, NodeId, NodeId, NodeId, NodeId]
      | [NodeId, NodeId, NodeId, NodeId, NodeId, NodeId, NodeId, NodeId]
      | [NodeId, NodeId, NodeId, NodeId, NodeId, NodeId, NodeId, NodeId, NodeId]
      | [NodeId, NodeId, NodeId, NodeId, NodeId, NodeId, NodeId, NodeId, NodeId, NodeId]
      | [NodeId, NodeId, NodeId, NodeId, NodeId, NodeId, NodeId, NodeId, NodeId, NodeId, NodeId]
      | [
          NodeId,
          NodeId,
          NodeId,
          NodeId,
          NodeId,
          NodeId,
          NodeId,
          NodeId,
          NodeId,
          NodeId,
          NodeId,
          NodeId,
        ]
      | [
          NodeId,
          NodeId,
          NodeId,
          NodeId,
          NodeId,
          NodeId,
          NodeId,
          NodeId,
          NodeId,
          NodeId,
          NodeId,
          NodeId,
          NodeId,
        ]
      | [
          NodeId,
          NodeId,
          NodeId,
          NodeId,
          NodeId,
          NodeId,
          NodeId,
          NodeId,
          NodeId,
          NodeId,
          NodeId,
          NodeId,
          NodeId,
          NodeId,
        ]
      | [
          NodeId,
          NodeId,
          NodeId,
          NodeId,
          NodeId,
          NodeId,
          NodeId,
          NodeId,
          NodeId,
          NodeId,
          NodeId,
          NodeId,
          NodeId,
          NodeId,
          NodeId,
        ]
      | [
          NodeId,
          NodeId,
          NodeId,
          NodeId,
          NodeId,
          NodeId,
          NodeId,
          NodeId,
          NodeId,
          NodeId,
          NodeId,
          NodeId,
          NodeId,
          NodeId,
          NodeId,
          NodeId,
        ]
      | [
          NodeId,
          NodeId,
          NodeId,
          NodeId,
          NodeId,
          NodeId,
          NodeId,
          NodeId,
          NodeId,
          NodeId,
          NodeId,
          NodeId,
          NodeId,
          NodeId,
          NodeId,
          NodeId,
          NodeId,
        ]
      | [
          NodeId,
          NodeId,
          NodeId,
          NodeId,
          NodeId,
          NodeId,
          NodeId,
          NodeId,
          NodeId,
          NodeId,
          NodeId,
          NodeId,
          NodeId,
          NodeId,
          NodeId,
          NodeId,
          NodeId,
          NodeId,
        ]
      | [
          NodeId,
          NodeId,
          NodeId,
          NodeId,
          NodeId,
          NodeId,
          NodeId,
          NodeId,
          NodeId,
          NodeId,
          NodeId,
          NodeId,
          NodeId,
          NodeId,
          NodeId,
          NodeId,
          NodeId,
          NodeId,
          NodeId,
        ]
      | [
          NodeId,
          NodeId,
          NodeId,
          NodeId,
          NodeId,
          NodeId,
          NodeId,
          NodeId,
          NodeId,
          NodeId,
          NodeId,
          NodeId,
          NodeId,
          NodeId,
          NodeId,
          NodeId,
          NodeId,
          NodeId,
          NodeId,
          NodeId,
        ];
    requiresHumanReview: boolean;
  }[];
  supplement?: AIReportSupplementResponse;
}
