import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import { beforeEach, describe, it, expect, vi } from 'vitest';
import type * as ReportsApiModule from '@/lib/reports-api';
import type { AccountReportView } from '@palcert/contracts';
import { AccountReports } from '../account-reports';
import { reportsApi, reportDateRange } from '@/lib/reports-api';
import { ApiError } from '@/lib/api-client';
vi.mock('@/lib/reports-api', async (importOriginal) => ({
  ...(await importOriginal<typeof ReportsApiModule>()),
  reportsApi: { read: vi.fn(), pdf: vi.fn() },
}));
const view: AccountReportView = {
  kind: 'financial',
  scope: 'user',
  locale: 'en',
  title: 'Financial report',
  subject: 'My account',
  generatedAt: '2026-10-24T19:00:00Z',
  period: 'October 2026',
  filters: 'USD',
  notes: [],
  summaries: [],
  detail: { title: 'Details', columns: ['Reference', 'Amount'], rows: [['transaction-1', '5.00']] },
  total: 51,
  offset: 0,
  nextOffset: 50,
};
beforeEach(() => {
  vi.clearAllMocks();
});
describe('account report exports', () => {
  it('uses the full filtered dataset for print, including records past the current page', async () => {
    vi.mocked(reportsApi.read)
      .mockResolvedValueOnce(view)
      .mockResolvedValueOnce({
        ...view,
        detail: { ...view.detail, rows: [['last-transaction', '10.00']] },
        nextOffset: null,
      });
    Object.defineProperty(document, 'fonts', {
      configurable: true,
      value: { ready: Promise.resolve() },
    });
    const print = vi.spyOn(window, 'print').mockImplementation(() => {});
    render(<AccountReports locale="en" scope="user" base="/reports" />);
    await screen.findByText('transaction-1');
    fireEvent.click(screen.getByRole('button', { name: 'Print full report' }));
    await waitFor(() =>
      expect(reportsApi.read).toHaveBeenLastCalledWith(
        '/reports',
        expect.objectContaining({ kind: 'financial' }),
        true,
      ),
    );
    await waitFor(() => expect(print).toHaveBeenCalled());
    expect(document.querySelector('.report-print-root')?.textContent).toContain('last-transaction');
    act(() => {
      window.dispatchEvent(new Event('afterprint'));
    });
  });
  it('reports export limits explicitly instead of downloading an incomplete report', async () => {
    vi.mocked(reportsApi.read).mockResolvedValue(view);
    vi.mocked(reportsApi.pdf).mockRejectedValue(
      new ApiError('VALIDATION_FAILED', 'large', 400, { reportReason: 'EXPORT_TOO_LARGE' }),
    );
    render(<AccountReports locale="en" scope="organization" base="/organizations/one/reports" />);
    await screen.findByText('transaction-1');
    fireEvent.click(screen.getByRole('button', { name: 'Download PDF' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('5,000');
  });
  it('rejects invalid calendar dates and includes the whole final day', () => {
    expect(() => reportDateRange('2026-02-30', '2026-03-01')).toThrow();
    expect(() => reportDateRange('2026-10-25', '2026-10-24')).toThrow();
    const result = reportDateRange('2026-10-24', '2026-10-24');
    expect(new Date(result.from).getDate()).toBe(24);
    expect(new Date(result.to).getDate()).toBe(25);
    expect(new Date(result.to).getHours()).toBe(0);
  });
});
