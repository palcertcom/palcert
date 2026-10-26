import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CheckFindings } from '../check-findings';
import { DeterminationBadge } from '../determination-badge';
import { CHECKS_MESSAGES } from '@/i18n/checks-messages';
import type * as ApiClient from '@/lib/api-client';

type ApiClientModule = typeof ApiClient;

const results = vi.hoisted(() => vi.fn());
vi.mock('@/lib/api-client', async () => {
  const actual = await vi.importActual<ApiClientModule>('@/lib/api-client');
  return { ...actual, checksApi: { ...actual.checksApi, results } };
});

function ruleResult(overrides: Record<string, unknown> = {}) {
  return {
    id: 'r1',
    ruleCode: 'MARGIN.TOP.MIN',
    category: 'MARGINS',
    severity: 'MAJOR',
    blocking: true,
    evaluationMode: 'DETERMINISTIC',
    outcome: 'FAIL',
    reasonCode: 'BELOW_MINIMUM',
    requiresReview: false,
    displayOrder: 1,
    titleEn: 'Top margin at least 25 mm',
    titleAr: 'الهامش العلوي 25 مم على الأقل',
    guidanceEn: 'Set the top margin to at least 25 mm.',
    guidanceAr: 'اضبط الهامش العلوي إلى 25 مم على الأقل.',
    matchedFactCount: 1,
    evaluatedFactCount: 1,
    passedFactCount: 0,
    failedFactCount: 1,
    indeterminateFactCount: 0,
    totalViolationCount: 1,
    returnedViolationCount: 1,
    violationsTruncated: false,
    violations: [
      {
        id: 'v1',
        reasonCode: 'BELOW_MINIMUM',
        nodeId: 'n-1',
        path: [],
        elementType: 'PARAGRAPH',
        sectionKey: null,
        ordinal: 1,
        page: null,
        expectedValue: '25',
        expectedUnit: 'MILLIMETRE',
        actualValue: '20',
        actualUnit: 'MILLIMETRE',
        tolerance: null,
      },
    ],
    ...overrides,
  };
}

describe('DeterminationBadge', () => {
  it.each(['COMPLIANT', 'NON_COMPLIANT', 'REVIEW_REQUIRED', 'INDETERMINATE'] as const)(
    'renders %s in words, not as an enum',
    (determination) => {
      render(<DeterminationBadge determination={determination} locale="en" />);
      const label = CHECKS_MESSAGES.en.determinations[determination]!;
      expect(screen.getByText(label)).toBeInTheDocument();
      expect(screen.queryByText(determination)).not.toBeInTheDocument();
    },
  );

  it('announces the verdict to assistive technology', () => {
    // Colour alone must never carry the result (§80).
    render(<DeterminationBadge determination="NON_COMPLIANT" locale="en" />);
    expect(screen.getByRole('status')).toHaveTextContent(
      CHECKS_MESSAGES.en.determinations.NON_COMPLIANT!,
    );
  });

  it('explains that INDETERMINATE is not a failure of the document', () => {
    render(<DeterminationBadge determination="INDETERMINATE" locale="en" hint />);
    expect(screen.getByText(/not a failure of your work/i)).toBeInTheDocument();
  });

  it('renders Arabic labels in Arabic', () => {
    render(<DeterminationBadge determination="COMPLIANT" locale="ar" />);
    expect(screen.getByText(CHECKS_MESSAGES.ar.determinations.COMPLIANT!)).toBeInTheDocument();
  });
});

describe('CheckFindings', () => {
  beforeEach(() => {
    results.mockReset();
    results.mockResolvedValue({ items: [ruleResult()], nextCursor: null });
  });

  it('shows the rule’s own title and guidance, in the reader’s language', async () => {
    render(<CheckFindings checkId="c1" locale="en" />);
    expect(await screen.findByText('Top margin at least 25 mm')).toBeInTheDocument();
    expect(screen.getByText(/Set the top margin/)).toBeInTheDocument();
  });

  it('renders the Arabic title and guidance for an Arabic reader', async () => {
    render(<CheckFindings checkId="c1" locale="ar" />);
    expect(await screen.findByText('الهامش العلوي 25 مم على الأقل')).toBeInTheDocument();
    expect(screen.getByText(/اضبط الهامش العلوي/)).toBeInTheDocument();
  });

  it('states the outcome in words alongside any colour', async () => {
    render(<CheckFindings checkId="c1" locale="en" />);
    expect(await screen.findByText(CHECKS_MESSAGES.en.outcomes.FAIL!)).toBeInTheDocument();
    expect(screen.getByText(CHECKS_MESSAGES.en.severities.MAJOR!)).toBeInTheDocument();
    expect(screen.getByText(CHECKS_MESSAGES.en.blocking)).toBeInTheDocument();
  });

  it('shows what was required and what was found', async () => {
    render(<CheckFindings checkId="c1" locale="en" />);
    expect(await screen.findByText(/Required: 25 MILLIMETRE/)).toBeInTheDocument();
    expect(screen.getByText(/Found: 20 MILLIMETRE/)).toBeInTheDocument();
  });

  it('never invents a page number when the extractor did not know one', async () => {
    // Structural DOCX analysis does not paginate (§52, ADR-0043).
    render(<CheckFindings checkId="c1" locale="en" />);
    await screen.findByText('Top margin at least 25 mm');
    expect(screen.queryByText(/—\s*\d+$/)).not.toBeInTheDocument();
  });

  it('says so when the violation list is a sample, not the whole story', async () => {
    results.mockResolvedValue({
      items: [ruleResult({ totalViolationCount: 412, violationsTruncated: true })],
      nextCursor: null,
    });
    render(<CheckFindings checkId="c1" locale="en" />);
    expect(await screen.findByText(/Showing 1 of 412 places/)).toBeInTheDocument();
    expect(screen.getByText(CHECKS_MESSAGES.en.truncatedNote)).toBeInTheDocument();
  });

  it('marks a rule only a person can judge, rather than guessing', async () => {
    results.mockResolvedValue({
      items: [
        ruleResult({
          outcome: 'INDETERMINATE',
          requiresReview: true,
          evaluationMode: 'MANUAL',
          totalViolationCount: 0,
          violations: [],
        }),
      ],
      nextCursor: null,
    });
    render(<CheckFindings checkId="c1" locale="en" />);
    expect(await screen.findByText(/Needs review/)).toBeInTheDocument();
  });

  it('filters to unmet rules without recomputing anything locally', async () => {
    render(<CheckFindings checkId="c1" locale="en" />);
    await screen.findByText('Top margin at least 25 mm');

    fireEvent.click(screen.getByRole('button', { name: CHECKS_MESSAGES.en.showFailed }));

    // The filter is a server query: the page never re-derives compliance (§91).
    await waitFor(() => {
      expect(results).toHaveBeenLastCalledWith('c1', expect.objectContaining({ outcome: 'FAIL' }));
    });
  });

  it('requests a bounded page rather than every finding at once', async () => {
    render(<CheckFindings checkId="c1" locale="en" />);
    await waitFor(() => {
      expect(results).toHaveBeenCalledWith('c1', expect.objectContaining({ limit: 25 }));
    });
  });
});
