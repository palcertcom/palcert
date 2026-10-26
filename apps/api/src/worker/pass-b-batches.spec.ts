import type { PalCertRuleProposalOutput } from '@palcert/contracts';
import { namespacedProposals } from './rule-extraction-job.handler';

type Proposal = PalCertRuleProposalOutput['proposals'][number];

function proposal(proposalKey: string, related?: string[]): Proposal {
  return {
    proposalKey,
    kind: 'CONFLICTING_REQUIREMENT',
    evidenceIds: ['ev-1'],
    interpretationEn: 'x',
    interpretationAr: 'س',
    requiresClarification: true,
    ...(related === undefined ? {} : { relatedProposalKeys: related }),
  } as Proposal;
}

describe('merging Pass B batches', () => {
  it('renames keys by batch and answer order, and relations with them', () => {
    const merged = namespacedProposals(
      [proposal('margin', ['spacing']), proposal('spacing', ['margin', 'elsewhere'])],
      2,
    );
    expect(merged.map((entry) => entry.proposalKey)).toEqual(['b2-1', 'b2-2']);
    expect(merged[0]!.relatedProposalKeys).toEqual(['b2-2']);
    // A key the same answer never defined relates to nothing and is dropped.
    expect(merged[1]!.relatedProposalKeys).toEqual(['b2-1']);
  });

  it('drops an empty relation list rather than keeping []', () => {
    const [only] = namespacedProposals([proposal('a', ['ghost'])], 1);
    expect(only!.proposalKey).toBe('b1-1');
    expect('relatedProposalKeys' in only!).toBe(false);
  });

  it('is deterministic', () => {
    const input = [proposal('x', ['y']), proposal('y')];
    expect(namespacedProposals(input, 3)).toEqual(namespacedProposals(input, 3));
  });
});
