export * from './source.js';
export * from './run.js';
export * from './hashing.js';
export * from './validator.js';
export * from './provider.js';
export * from './views.js';

/**
 * The generated proposal types, re-exported under names that say what they are.
 *
 * The schema's own `RuleProposal`, `RuleScope` and `RuleExpectedValue` are the
 * *proposal's* view of those things, and the Phase 3 types of the same name are
 * the real ones a published rule uses. Exporting both flat would leave every
 * import site guessing which it had, so the model's shapes are prefixed and the
 * rule schema keeps the plain names.
 */
export type {
  PalCertRuleProposalOutput,
  RuleProposal as ProposedRule,
  SuggestedRule as ProposedRuleDefinition,
} from './proposal.generated.js';
export { RULE_PROPOSAL_JSON_SCHEMA } from './proposal-schema.generated.js';
