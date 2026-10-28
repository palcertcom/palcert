/** Display-ready, consistently scoped data shared by screen, print and PDF. */
export interface ReportTable {
  readonly title: string;
  readonly columns: readonly string[];
  readonly rows: readonly (readonly string[])[];
}
export interface AccountReportView {
  readonly kind: 'financial' | 'services';
  readonly locale: 'ar' | 'en';
  readonly title: string;
  readonly subject: string;
  readonly scope: 'user' | 'organization' | 'platform';
  readonly generatedAt: string;
  readonly period: string;
  readonly filters: string;
  readonly notes: readonly string[];
  readonly summaries: readonly ReportTable[];
  readonly detail: ReportTable;
  readonly total: number;
  readonly offset: number;
  readonly nextOffset: number | null;
}
