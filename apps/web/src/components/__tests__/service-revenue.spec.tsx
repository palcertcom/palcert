import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ServiceRevenue } from '../service-revenue';
import { revenueSharingApi } from '@/lib/revenue-sharing-api';
vi.mock('@/lib/revenue-sharing-api', () => ({ revenueSharingApi: { revenue: vi.fn() } }));
const m = (minorUnits: string) => ({ currency: 'USD', minorUnits });
describe('institution service revenue', () => {
  it('shows both $5 shares and follows server pagination without merging currencies', async () => {
    vi.mocked(revenueSharingApi.revenue)
      .mockResolvedValueOnce({
        totals: [
          {
            serviceCode: 'DOCUMENT_CHECK',
            currency: 'USD',
            gross: m('1000'),
            institution: m('500'),
            platform: m('500'),
          },
        ],
        entries: [
          {
            id: 'entry',
            referenceId: 'purchase',
            serviceCode: 'DOCUMENT_CHECK',
            currency: 'USD',
            gross: m('1000'),
            institution: m('500'),
            platform: m('500'),
            isRefund: false,
            createdAt: '2026-10-24T12:00:00Z',
          },
        ],
        nextCursor: '50',
      })
      .mockResolvedValueOnce({ totals: [], entries: [], nextCursor: null });
    render(<ServiceRevenue organizationId="university" locale="en" admin />);
    await screen.findByText('Formatting check');
    expect(screen.getAllByText(/5\.00/).length).toBeGreaterThanOrEqual(2);
    fireEvent.click(screen.getByRole('button', { name: 'Next' }));
    await waitFor(() =>
      expect(revenueSharingApi.revenue).toHaveBeenLastCalledWith('university', true, '50'),
    );
    await screen.findByText('No entries yet.');
  });
  it('handles an institution report access failure without rendering financial rows', async () => {
    vi.mocked(revenueSharingApi.revenue).mockRejectedValueOnce(new Error('forbidden'));
    render(<ServiceRevenue organizationId="other" locale="ar" />);
    await screen.findByText('تعذّر تحميل البيانات.');
    expect(screen.queryByRole('table')).toBeNull();
  });
});
