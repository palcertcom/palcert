'use client';
import type { AccountReportView } from '@palcert/contracts';
import { apiRequest, apiUrl, ApiError } from './api-client';
export interface ReportFilters {
  kind: 'financial' | 'services';
  from: string;
  to: string;
  locale: 'ar' | 'en';
  timeZone: string;
  currency?: string;
  service?: string;
  status?: string;
  offset?: number;
}
export function reportQuery(filters: ReportFilters): string {
  return new URLSearchParams(
    Object.entries(filters)
      .filter(([, v]) => v !== undefined && v !== '')
      .map(([k, v]) => [k, String(v)]),
  ).toString();
}
export const reportsApi = {
  read: (base: string, filters: ReportFilters, full = false) =>
    apiRequest<AccountReportView>(`${base}${full ? '/print' : ''}?${reportQuery(filters)}`),
  pdf: async (base: string, filters: ReportFilters): Promise<Blob> => {
    const response = await fetch(apiUrl(`${base}/pdf?${reportQuery(filters)}`), {
      credentials: 'include',
      cache: 'no-store',
    });
    if (!response.ok) {
      const body = (await response.json().catch(() => null)) as {
        error?: { code?: string; message?: string; details?: Record<string, unknown> };
      } | null;
      throw new ApiError(
        body?.error?.code ?? 'INTERNAL_ERROR',
        body?.error?.message ?? 'Report failed',
        response.status,
        body?.error?.details,
      );
    }
    return response.blob();
  },
};
/** Calendar-day filters use local midnights, so DST days need not be 24 hours. */
export function reportDateRange(from: string, through: string): { from: string; to: string } {
  function parse(value: string) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new Error('Invalid date');
    const [y, m, d] = value.split('-').map(Number) as [number, number, number];
    const date = new Date(y, m - 1, d);
    if (date.getFullYear() !== y || date.getMonth() !== m - 1 || date.getDate() !== d)
      throw new Error('Invalid date');
    return date;
  }
  const start = parse(from);
  const end = parse(through);
  end.setDate(end.getDate() + 1);
  if (end <= start || end.getTime() - start.getTime() > 366 * 86400000)
    throw new Error('Invalid period');
  return { from: start.toISOString(), to: end.toISOString() };
}
