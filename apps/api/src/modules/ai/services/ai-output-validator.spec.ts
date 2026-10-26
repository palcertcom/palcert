import { AIProviderError, type AIContextBundle } from '@palcert/contracts';
import { AIOutputValidator } from './ai-output-validator.service';

/**
 * Rejecting AI output that cannot be trusted as evidence (§34, §74).
 *
 * Each case here is something a language model demonstrably does: cite a
 * locator it was never given, answer a question nobody asked, skip one it was
 * asked, repeat itself, or return a value outside the vocabulary. None of them
 * may reach storage, and none is partially accepted — a response containing a
 * fabricated citation came from a model willing to fabricate, and the rest of
 * it has not earned more trust.
 */

const validator = new AIOutputValidator();

function context(): AIContextBundle {
  return {
    contextSchemaVersion: 1,
    contextBuilderVersion: '1',
    purpose: 'RULE_ASSESSMENT',
    outline: [{ nodeId: 'main/body/p:1', level: 1, text: 'Declarations' }],
    nodes: [
      { nodeId: 'main/body/p:2', text: 'The authors declare no conflict of interest.' },
      { nodeId: 'main/body/p:3', text: 'Ethics approval was obtained.' },
    ],
    metadata: {},
    deterministicFindings: [],
    rules: [
      { ruleCode: 'COI.DECLARATION', severity: 'MAJOR', blocking: true },
      { ruleCode: 'ETHICS.STATEMENT', severity: 'MAJOR', blocking: true },
    ],
    truncation: { truncated: false, reason: 'NONE' },
  };
}

function assessment(overrides: Record<string, unknown> = {}) {
  return {
    ruleCode: 'COI.DECLARATION',
    assessment: 'SATISFIED',
    reasonCode: 'REQUIREMENT_MET',
    evidenceSufficiency: 'SUFFICIENT',
    evidenceNodeIds: ['main/body/p:2'],
    explanationEn: 'A conflict-of-interest declaration is present.',
    explanationAr: 'يوجد إقرار بتضارب المصالح.',
    ...overrides,
  };
}

function validate(assessments: unknown[], requested = ['COI.DECLARATION', 'ETHICS.STATEMENT']) {
  return validator.validateAssessments({
    response: { schemaVersion: 1, assessments },
    requestedRuleCodes: requested,
    context: context(),
  });
}

describe('AIOutputValidator', () => {
  it('accepts a well-formed response covering exactly the requested rules', () => {
    const result = validate([
      assessment(),
      assessment({ ruleCode: 'ETHICS.STATEMENT', evidenceNodeIds: ['main/body/p:3'] }),
    ]);
    expect(result.assessments).toHaveLength(2);
  });

  it('rejects a rule nobody asked about', () => {
    // The classic injection payload: the document asked for an extra rule and
    // the model obliged. An unsolicited finding is a different feature with
    // different consent (§35).
    expect(() =>
      validate([
        assessment(),
        assessment({ ruleCode: 'ETHICS.STATEMENT', evidenceNodeIds: ['main/body/p:3'] }),
        assessment({ ruleCode: 'ADMIN.BYPASS' }),
      ]),
    ).toThrow(AIProviderError);
  });

  it('rejects a response that omitted a requested rule', () => {
    // A silently missing rule would leave a requirement looking unexamined
    // when it was in fact requested.
    expect(() => validate([assessment()])).toThrow(/omitted 1 requested rule/);
  });

  it('rejects the same rule assessed twice', () => {
    expect(() => validate([assessment(), assessment()], ['COI.DECLARATION'])).toThrow(
      /more than once/,
    );
  });

  it('rejects evidence PalCert never supplied', () => {
    // A fabricated locator is worse than none: it sends someone to a part of
    // their document that has nothing to do with the finding (§29).
    expect(() =>
      validate([assessment({ evidenceNodeIds: ['fake-secret-node'] })], ['COI.DECLARATION']),
    ).toThrow(/never supplied/);
  });

  it('accepts an outline node id as evidence, because it was supplied', () => {
    const result = validate(
      [assessment({ evidenceNodeIds: ['main/body/p:1'] })],
      ['COI.DECLARATION'],
    );
    expect(result.assessments[0]!.evidenceNodeIds).toEqual(['main/body/p:1']);
  });

  it('rejects a conclusion reached with no evidence at all', () => {
    // INSUFFICIENT_EVIDENCE is the honest answer in that situation (§32).
    expect(() => validate([assessment({ evidenceNodeIds: [] })], ['COI.DECLARATION'])).toThrow(
      /without citing any evidence/,
    );
  });

  it('allows INSUFFICIENT_EVIDENCE to cite nothing', () => {
    const result = validate(
      [
        assessment({
          assessment: 'INSUFFICIENT_EVIDENCE',
          reasonCode: 'EVIDENCE_NOT_PRESENT',
          evidenceSufficiency: 'INSUFFICIENT',
          evidenceNodeIds: [],
        }),
      ],
      ['COI.DECLARATION'],
    );
    expect(result.assessments[0]!.assessment).toBe('INSUFFICIENT_EVIDENCE');
  });

  it('rejects a value outside the assessment vocabulary', () => {
    expect(() => validate([assessment({ assessment: 'PASS' })], ['COI.DECLARATION'])).toThrow(
      AIProviderError,
    );
  });

  it('rejects an unexpected field', () => {
    // Closed schemas: a field PalCert does not understand is a signal that
    // something built the response from a shape it does not know.
    expect(() => validate([assessment({ confidence: 0.93 })], ['COI.DECLARATION'])).toThrow(
      AIProviderError,
    );
  });

  it('rejects an oversized explanation', () => {
    expect(() =>
      validate([assessment({ explanationEn: 'x'.repeat(1201) })], ['COI.DECLARATION']),
    ).toThrow(AIProviderError);
  });

  it('rejects a missing bilingual explanation', () => {
    expect(() => validate([assessment({ explanationAr: '' })], ['COI.DECLARATION'])).toThrow(
      AIProviderError,
    );
  });

  it('carries no model text in the rejection message', () => {
    // An error body would otherwise be a route by which unvalidated model
    // output reached a log or a user (§55, §81).
    try {
      validate([assessment({ evidenceNodeIds: ['fake-secret-node'] })], ['COI.DECLARATION']);
      throw new Error('expected a rejection');
    } catch (error) {
      expect((error as Error).message).not.toContain('fake-secret-node');
      expect((error as Error).message).not.toContain('conflict-of-interest declaration');
    }
  });

  it('rejects a supplement that does not satisfy the contract', () => {
    expect(() => validator.validateSupplement({ schemaVersion: 1 })).toThrow(AIProviderError);
  });

  it('accepts a well-formed supplement', () => {
    expect(() =>
      validator.validateSupplement({
        schemaVersion: 1,
        summaryEn: 'The check found some formatting issues.',
        summaryAr: 'وجد الفحص بعض مشكلات التنسيق.',
        priorityRecommendations: [
          {
            priority: 'HIGH',
            relatedRuleCodes: ['COI.DECLARATION'],
            textEn: 'Add a conflict-of-interest declaration.',
            textAr: 'أضف إقراراً بتضارب المصالح.',
          },
        ],
      }),
    ).not.toThrow();
  });
});
