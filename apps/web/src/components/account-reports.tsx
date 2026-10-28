'use client';
import { useEffect, useState, useRef } from 'react';
import { createPortal } from 'react-dom';
import type { AccountReportView, ReportTable } from '@palcert/contracts';
import type { Locale } from '@/i18n/locales';
import { reportsMessages, reportStatusOptions } from '@/i18n/reports-messages';
import { revenueMessages } from '@/i18n/revenue-sharing-messages';
import { reportsApi, reportDateRange, type ReportFilters } from '@/lib/reports-api';
import { ApiError } from '@/lib/api-client';
import { PageHeader } from '@/components/ui/page-header';

function dateInput(date: Date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}
function Table({ table }: { table: ReportTable }) {
  return (
    <section>
      <h3>{table.title}</h3>
      <div className="report-table-scroll">
        <table className="report-table">
          <thead>
            <tr>
              {table.columns.map((text, i) => (
                <th key={i} scope="col">
                  {text}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {table.rows.map((row, i) => (
              <tr key={i}>
                {row.map((value, j) => (
                  <td key={j}>
                    <bdi>{value}</bdi>
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
function Body({ report }: { report: AccountReportView }) {
  const m = reportsMessages(report.locale);
  return (
    <article
      className="account-report"
      dir={report.locale === 'ar' ? 'rtl' : 'ltr'}
      lang={report.locale}
    >
      <h2>
        {report.title} — {report.subject}
      </h2>
      <p>{report.period}</p>
      <p>{report.filters}</p>
      <p>
        {m.generated}: <bdi>{new Date(report.generatedAt).toLocaleString(report.locale)}</bdi> ·{' '}
        {m.rows}: {report.total}
      </p>
      {report.notes.map((note) => (
        <p className="pc-hint" key={note}>
          {note}
        </p>
      ))}
      {report.summaries.map((table, i) => (
        <Table table={table} key={i} />
      ))}
      <Table table={report.detail} />
      {!report.total && <p>{m.empty}</p>}
    </article>
  );
}
export function AccountReports({
  locale,
  base,
  scope,
}: {
  locale: Locale;
  base: string;
  scope: 'user' | 'organization' | 'platform';
}) {
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const m = reportsMessages(locale);
  const services = revenueMessages(locale).services;
  const [kind, setKind] = useState<'financial' | 'services'>('financial');
  const [from, setFrom] = useState(() => {
    const d = new Date();
    d.setDate(1);
    return dateInput(d);
  });
  const [through, setThrough] = useState(() => dateInput(new Date()));
  const [currency, setCurrency] = useState('');
  const [service, setService] = useState('');
  const [status, setStatus] = useState('');
  const [filters, setFilters] = useState<ReportFilters | null>(null);
  const [view, setView] = useState<AccountReportView | null>(null);
  const [printView, setPrintView] = useState<AccountReportView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  useEffect(() => {
    const start = new Date();
    start.setDate(1);
    setFilters({
      kind: 'financial',
      ...reportDateRange(dateInput(start), dateInput(new Date())),
      locale,
      timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    });
  }, [base, locale]);
  function failure(caught: unknown) {
    return caught instanceof ApiError && caught.details?.reportReason === 'EXPORT_TOO_LARGE'
      ? m.large
      : m.error;
  }
  useEffect(() => {
    if (!filters) return;
    let active = true;
    setView(null);
    setError(null);
    void reportsApi
      .read(base, filters)
      .then((value) => {
        if (active) setView(value);
      })
      .catch((caught) => {
        if (active) setError(failure(caught));
      });
    return () => {
      active = false;
    };
    // Locale-dependent error text and query are captured together.
  }, [base, filters]);
  useEffect(() => {
    if (!printView) return;
    let active = true;
    const cleanup = () => {
      setPrintView(null);
      setBusy(false);
    };
    window.addEventListener('afterprint', cleanup, { once: true });
    void document.fonts.ready.then(() =>
      requestAnimationFrame(() => {
        if (active) {
          window.print();
        }
      }),
    );
    return () => {
      active = false;
      window.removeEventListener('afterprint', cleanup);
    };
  }, [printView]);
  function apply() {
    try {
      setFilters({
        kind,
        ...reportDateRange(from, through),
        locale,
        timeZone: zone,
        ...(currency ? { currency } : {}),
        ...(kind === 'services' && service ? { service } : {}),
        ...(kind === 'services' && status ? { status } : {}),
      });
    } catch {
      setError(m.dates);
    }
  }
  async function exportReport(format: 'pdf' | 'print') {
    if (!filters) return;
    setBusy(true);
    setError(null);
    try {
      if (format === 'print') {
        const full = await reportsApi.read(base, filters, true);
        if (mounted.current) setPrintView(full);
        return;
      }
      const blob = await reportsApi.pdf(base, filters);
      if (!mounted.current) return;
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = `palcert-${scope}-${filters.kind}.pdf`;
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 30000);
    } catch (caught) {
      setError(failure(caught));
    }
    setBusy(false);
  }
  return (
    <>
      <PageHeader title={m.title} description={`${m.scope}: ${m[scope]}`} />
      <section className="pc-card">
        <form
          onSubmit={(event) => {
            event.preventDefault();
            apply();
          }}
          className="reports-filters"
        >
          <label>
            {m.title}
            <select
              value={kind}
              onChange={(e) => setKind(e.target.value as 'financial' | 'services')}
            >
              <option value="financial">{m.financial}</option>
              <option value="services">{m.services}</option>
            </select>
          </label>
          <label>
            {m.from}
            <input required type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
          </label>
          <label>
            {m.through}
            <input
              required
              type="date"
              value={through}
              onChange={(e) => setThrough(e.target.value)}
            />
          </label>
          <label>
            {m.currency}
            <select value={currency} onChange={(e) => setCurrency(e.target.value)}>
              <option value="">{m.all}</option>
              {['USD', 'ILS', 'EUR', 'JOD', 'JPY'].map((c) => (
                <option key={c}>{c}</option>
              ))}
            </select>
          </label>
          {kind === 'services' && (
            <>
              <label>
                {m.service}
                <select value={service} onChange={(e) => setService(e.target.value)}>
                  <option value="">{m.all}</option>
                  {Object.entries(services).map(([code, label]) => (
                    <option key={code} value={code}>
                      {label}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                {m.status}
                <select value={status} onChange={(e) => setStatus(e.target.value)}>
                  <option value="">{m.all}</option>
                  {reportStatusOptions(locale).map(([code, label]) => (
                    <option key={code} value={code}>
                      {label}
                    </option>
                  ))}
                </select>
              </label>
            </>
          )}
          <button className="pc-btn pc-btn-primary" disabled={busy}>
            {m.apply}
          </button>
        </form>
        <p className="pc-hint">
          {m.zone}: <bdi>{zone}</bdi>
        </p>
      </section>
      {error && (
        <p role="alert" className="pc-error">
          {error}
        </p>
      )}
      {!view && !error && <p role="status">{m.loading}</p>}
      {view && (
        <section className="pc-card">
          <div className="reports-actions">
            <button
              className="pc-btn pc-btn-secondary"
              disabled={busy}
              onClick={() => void exportReport('pdf')}
            >
              {m.pdf}
            </button>
            <button
              className="pc-btn pc-btn-secondary"
              disabled={busy}
              onClick={() => void exportReport('print')}
            >
              {m.print}
            </button>
            {busy && <span role="status">{m.loading}</span>}
          </div>
          <Body report={view} />
          <div className="reports-actions">
            <button
              className="pc-btn pc-btn-secondary"
              disabled={busy || view.offset === 0}
              onClick={() =>
                setFilters((f) => (f ? { ...f, offset: Math.max(0, view.offset - 50) } : f))
              }
            >
              {m.previous}
            </button>
            <span>
              {view.total ? view.offset + 1 : 0}–{view.offset + view.detail.rows.length} /{' '}
              {view.total}
            </span>
            <button
              className="pc-btn pc-btn-secondary"
              disabled={busy || view.nextOffset === null}
              onClick={() =>
                setFilters((f) =>
                  f && view.nextOffset !== null ? { ...f, offset: view.nextOffset } : f,
                )
              }
            >
              {m.next}
            </button>
          </div>
        </section>
      )}
      <style>{`.reports-filters,.reports-actions{display:flex;flex-wrap:wrap;gap:1rem;align-items:end}.reports-filters label{display:grid;gap:.4rem}.reports-filters input,.reports-filters select{padding:.55rem;border:1px solid #a9b6c8;border-radius:6px;min-height:42px}.report-table-scroll{overflow-x:auto}.report-table{width:100%;border-collapse:collapse;font-size:.85rem}.report-table th,.report-table td{border:1px solid #cdd5df;padding:.65rem;text-align:start;overflow-wrap:anywhere}.report-table th{background:#eef2f8}.report-table td{min-width:5rem}.account-report section{margin-block:1.5rem}.report-print-root{display:none}@media print{@page{size:A4 landscape;margin:12mm}body:has(>.report-print-root)>*:not(.report-print-root){display:none!important}body>.report-print-root{display:block!important;color:#111;background:white}.report-print-root .report-table-scroll{overflow:visible}.report-print-root table{font-size:8pt;table-layout:fixed}.report-print-root th,.report-print-root td{padding:4px;min-width:0}.report-print-root tr{break-inside:avoid}.report-print-root thead{display:table-header-group}.report-print-root h2,.report-print-root h3{break-after:avoid}.report-print-root .pc-hint{color:#333}}`}</style>
      {printView &&
        createPortal(
          <div className="report-print-root">
            <Body report={printView} />
          </div>,
          document.body,
        )}
    </>
  );
}
