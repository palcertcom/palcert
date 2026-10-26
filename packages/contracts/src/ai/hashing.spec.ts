import { describe, expect, it } from 'vitest';
import {
  computeAIReviewHash,
  computeContextHash,
  computePromptHash,
  computeRulesHash,
} from './hashing.js';
import type { AIContextBundle } from './context.generated.js';
import type { AIReviewDigest } from './assessment.generated.js';

function bundle(overrides: Partial<AIContextBundle> = {}): AIContextBundle {
  return {
    contextSchemaVersion: 1,
    contextBuilderVersion: '1',
    purpose: 'RULE_ASSESSMENT',
    outline: [{ nodeId: 'main/body/p:1', level: 1, text: 'Introduction' }],
    nodes: [{ nodeId: 'main/body/p:2', text: 'The authors declare no conflict of interest.' }],
    metadata: { paragraphCount: 2 },
    deterministicFindings: [],
    rules: [
      { ruleCode: 'ETHICS.STATEMENT', severity: 'MAJOR', blocking: true, titleEn: 'Ethics' },
      { ruleCode: 'COI.DECLARATION', severity: 'MINOR', blocking: false, titleEn: 'COI' },
    ],
    truncation: { truncated: false, reason: 'NONE' },
    ...overrides,
  };
}

function digest(overrides: Partial<AIReviewDigest> = {}): AIReviewDigest {
  return {
    aiReviewSchemaVersion: 1,
    aiReviewCanonicalizationVersion: 1,
    provider: 'anthropic',
    configuredModel: 'claude-opus-5',
    promptVersion: '1',
    promptHash: 'a'.repeat(64),
    contextBuilderVersion: '1',
    contextHash: 'b'.repeat(64),
    rulesHash: 'c'.repeat(64),
    boundReportHash: 'd'.repeat(64),
    boundEvaluationHash: 'e'.repeat(64),
    assessments: [
      {
        ruleCode: 'B.RULE',
        assessment: 'SATISFIED',
        reasonCode: 'REQUIREMENT_MET',
        evidenceSufficiency: 'SUFFICIENT',
        evidenceNodeIds: ['main/body/p:2'],
        requiresHumanReview: true,
      },
      {
        ruleCode: 'A.RULE',
        assessment: 'INSUFFICIENT_EVIDENCE',
        reasonCode: 'EVIDENCE_NOT_PRESENT',
        evidenceSufficiency: 'INSUFFICIENT',
        evidenceNodeIds: [],
        requiresHumanReview: false,
      },
    ],
    ...overrides,
  };
}

describe('computePromptHash', () => {
  it('identifies the template and nothing else', () => {
    // The question this answers is "which prompt version ran". A hash that
    // also covered document content could never answer it (§37).
    expect(computePromptHash('You are PalCert.')).toMatch(/^[0-9a-f]{64}$/);
    expect(computePromptHash('You are PalCert.')).toBe(computePromptHash('You are PalCert.'));
    expect(computePromptHash('You are PalCert!')).not.toBe(computePromptHash('You are PalCert.'));
  });
});

describe('computeContextHash', () => {
  it('proves what was supplied, without storing it', () => {
    expect(computeContextHash(bundle())).toMatch(/^[0-9a-f]{64}$/);
  });

  it('changes when the supplied evidence changes', () => {
    const other = bundle({
      nodes: [{ nodeId: 'main/body/p:2', text: 'The authors declare a conflict of interest.' }],
    });
    expect(computeContextHash(other)).not.toBe(computeContextHash(bundle()));
  });

  it('does not depend on the order keys were built in', () => {
    const rebuilt = JSON.parse(JSON.stringify(bundle())) as AIContextBundle;
    expect(computeContextHash(rebuilt)).toBe(computeContextHash(bundle()));
  });
});

describe('computeRulesHash', () => {
  it('does not depend on the order a batch happened to take', () => {
    const forwards = computeRulesHash(bundle().rules);
    const backwards = computeRulesHash([...bundle().rules].reverse());
    expect(backwards).toBe(forwards);
  });

  it('changes when a rule’s guidance changes', () => {
    const changed = bundle({
      rules: [
        { ruleCode: 'ETHICS.STATEMENT', severity: 'MAJOR', blocking: true, guidanceEn: 'new' },
        { ruleCode: 'COI.DECLARATION', severity: 'MINOR', blocking: false, titleEn: 'COI' },
      ],
    });
    expect(computeRulesHash(changed.rules)).not.toBe(computeRulesHash(bundle().rules));
  });

  it('is distinct from the context hash', () => {
    // Two questions, two fields. The same context is often assessed against
    // different rule sets (§77).
    expect(computeRulesHash(bundle().rules)).not.toBe(computeContextHash(bundle()));
  });
});

describe('computeAIReviewHash', () => {
  it('does not depend on the order the provider answered in', () => {
    const reversed = digest({ assessments: [...digest().assessments].reverse() });
    expect(computeAIReviewHash(reversed).hash).toBe(computeAIReviewHash(digest()).hash);
  });

  it('changes when an assessment changes', () => {
    const changed = digest({
      assessments: [
        { ...digest().assessments[0]!, assessment: 'NOT_SATISFIED' },
        digest().assessments[1]!,
      ],
    });
    expect(computeAIReviewHash(changed).hash).not.toBe(computeAIReviewHash(digest()).hash);
  });

  it('changes when the model changes', () => {
    // A different model reaching the same conclusion is different evidence,
    // and the hash has to say so (§11, §95).
    expect(computeAIReviewHash(digest({ configuredModel: 'other' })).hash).not.toBe(
      computeAIReviewHash(digest()).hash,
    );
  });

  it('changes when the prompt version changes', () => {
    expect(computeAIReviewHash(digest({ promptVersion: '2' })).hash).not.toBe(
      computeAIReviewHash(digest()).hash,
    );
  });

  it('refuses to hash at an unknown canonicalization version', () => {
    expect(() => computeAIReviewHash(digest({ aiReviewCanonicalizationVersion: 99 }))).toThrow(
      /canonicalized at version 99/,
    );
  });

  it('binds to the deterministic report without reproducing it', () => {
    // The digest cites the report's hash so a reader can tell which report the
    // advice was formed against — and carries no score, no determination and
    // no rule outcome of its own (§46).
    const { canonical } = computeAIReviewHash(digest());
    expect(canonical).toContain('boundReportHash');
    expect(canonical).not.toMatch(/deterministicScore|determination|reportHash":"sha256/);
  });
});
