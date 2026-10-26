import { createHash } from 'node:crypto';
import { canonicalizeJson, sha256Hex } from '../checks/report.js';
import type { AIContextBundle } from './context.generated.js';
import type { AIReviewDigest } from './assessment.generated.js';
import { AI_REVIEW_CANONICALIZATION_VERSION } from './review.js';

/**
 * Identity hashes for AI input and output (§37, §46, §77, §78).
 *
 * Four different hashes, because four different questions get asked, and
 * answering them with one field would make every answer useless:
 *
 * - `promptHash` identifies the **template**. Document content is deliberately
 *   excluded: the question it answers is "which prompt version ran", and a
 *   hash that changed per document could never answer it (§37).
 * - `contextHash` identifies the **normalized input** actually supplied, so an
 *   invocation can prove what the model saw without PalCert storing the prompt
 *   or the document text anywhere (§48, §77).
 * - `rulesHash` identifies the **rule bundle**, separately, because the same
 *   context is often assessed against different rule sets.
 * - `aiReviewHash` identifies the **completed review**.
 *
 * All four reuse the Phase 7 RFC 8785 canonicalization, so two parties
 * serializing the same structure get the same bytes. They are never mixed with
 * the deterministic report hash (§46): a report hash means a measurement was
 * taken, and nothing an AI produced may borrow that meaning.
 */

/** The hash of a prompt template. The template only — never the data (§37). */
export function computePromptHash(template: string): string {
  return createHash('sha256').update(template, 'utf8').digest('hex');
}

/** The hash of the exact normalized context a request supplied (§77). */
export function computeContextHash(bundle: AIContextBundle): string {
  return sha256Hex(canonicalizeJson(bundle));
}

/** The hash of the rule bundle a request was judged against (§77). */
export function computeRulesHash(rules: AIContextBundle['rules']): string {
  const canonical = [...rules]
    .map((rule) => ({
      blocking: rule.blocking,
      category: rule.category,
      guidanceAr: rule.guidanceAr,
      guidanceEn: rule.guidanceEn,
      ruleCode: rule.ruleCode,
      severity: rule.severity,
      titleAr: rule.titleAr,
      titleEn: rule.titleEn,
    }))
    // Sorted, so the hash cannot depend on the order a batch happened to take.
    .sort((left, right) =>
      left.ruleCode < right.ruleCode ? -1 : left.ruleCode > right.ruleCode ? 1 : 0,
    );
  return sha256Hex(canonicalizeJson(canonical));
}

/** The hash of a completed AI review (§46, §78). */
export function computeAIReviewHash(digest: AIReviewDigest): {
  hash: string;
  canonical: string;
} {
  if (digest.aiReviewCanonicalizationVersion !== AI_REVIEW_CANONICALIZATION_VERSION) {
    throw new Error(
      `cannot hash an AI review canonicalized at version ${digest.aiReviewCanonicalizationVersion}`,
    );
  }
  // Assessments are sorted by rule code for the same reason the deterministic
  // report sorts its results: the order a provider answered in is not meaning.
  const canonical = canonicalizeJson({
    ...digest,
    assessments: [...digest.assessments].sort((left, right) =>
      left.ruleCode < right.ruleCode ? -1 : left.ruleCode > right.ruleCode ? 1 : 0,
    ),
  });
  return { hash: sha256Hex(canonical), canonical };
}
