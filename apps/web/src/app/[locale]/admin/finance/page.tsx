'use client';

import Link from 'next/link';
import { useCallback, useEffect, useId, useState, type FormEvent } from 'react';
import {
  AdminGate,
  ConfirmAction,
  describeAdminError,
  Figure,
  useAdminLocale,
} from '@/components/admin/admin-kit';
import { FormError, FormSuccess } from '@/components/auth-form';
import { useShell } from '@/components/shell/shell-context';
import { DataTable, type DataColumn } from '@/components/ui/data-table';
import { PageHeader } from '@/components/ui/page-header';
import { EmptyState, ErrorState, LoadingState } from '@/components/ui/states';
import { StatusBadge } from '@/components/ui/status-badge';
import { getAdminMessages } from '@/i18n/admin-messages';
import { getBalanceMessages } from '@/i18n/balance-messages';
import { getBillingMessages } from '@/i18n/billing-messages';
import { FINANCE_READ } from '@/lib/shell-navigation';
import {
  balanceApi,
  financeAdminApi,
  type AdminPurchaseReportRowResponse,
  type LedgerVerificationResponse,
  type PurchaseReportFilter,
  type PurchaseSummaryRowResponse,
  type PaymentRefundResponse,
  type PriceVersionResponse,
} from '@/lib/api-client';
import { formatMoney, toMinorUnits } from '@/lib/money';

/** Document services, priced and sold since Phase 11. */
const DOCUMENT_PRODUCTS = ['DOCUMENT_CHECK', 'SMARTFIX', 'EXPERTFIX'] as const;
/** Customer-initiated AI services: always paid, by whoever starts them (ADR-0149). */
const AI_PRODUCTS = ['AI_REVIEW', 'AI_RULE_EXTRACTION'] as const;
const PRODUCTS = [...DOCUMENT_PRODUCTS, ...AI_PRODUCTS] as const;
const AI_PRODUCT_SET: ReadonlySet<string> = new Set(AI_PRODUCTS);
const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The finance console: prices, the ledger check, and a refund lookup. A
 * customer's own money is on their page (reached from Users), because every
 * figure there is about one person.
 *
 * Each section appears only for the permission that reads it, and each
 * action only for the permission that performs it; the API checks both again.
 */
export default function AdminFinancePage() {
  return (
    <AdminGate allowed={(can) => FINANCE_READ.some((permission) => can.has(permission))}>
      <Finance />
    </AdminGate>
  );
}

function Finance() {
  const locale = useAdminLocale();
  const messages = getAdminMessages(locale);
  const can = useShell().globalPermissions;

  return (
    <main className="pc-page">
      <PageHeader title={messages.finance.title} description={messages.finance.intro} />
      {can.has('pricing:price:read') ? <Prices /> : null}
      {can.has('finance:purchase:read') ? <PurchasesByProduct /> : null}
      <div className="pc-admin-cards">
        {can.has('finance:ledger:read') ? <LedgerCheck /> : null}
        {can.has('finance:payment:read') ? <RefundLookup /> : null}
        {can.has('admin:user:read') ? (
          <section className="pc-card" aria-labelledby="finance-customers-heading">
            <h2 id="finance-customers-heading" className="pc-card-title">
              {messages.finance.customers}
            </h2>
            <p>{messages.finance.customersIntro}</p>
            <Link className="pc-btn pc-btn-secondary" href={`/${locale}/admin/users`}>
              {messages.finance.findCustomer}
            </Link>
          </section>
        ) : null}
      </div>
    </main>
  );
}

function Prices() {
  const locale = useAdminLocale();
  const messages = getAdminMessages(locale);
  const can = useShell().globalPermissions;
  const [prices, setPrices] = useState<PriceVersionResponse[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setPrices(await financeAdminApi.prices());
      setError(null);
    } catch (caught) {
      setError(describeAdminError(messages, caught).message);
    }
  }, [messages]);

  useEffect(() => {
    void load();
  }, [load]);

  async function after(message: string): Promise<void> {
    setDone(message);
    await load();
  }

  const when = new Intl.DateTimeFormat(locale, { dateStyle: 'medium' });
  const columns: DataColumn<PriceVersionResponse>[] = [
    {
      key: 'product',
      header: messages.finance.product,
      primary: true,
      cell: (row) => <ProductName code={row.productCode} />,
    },
    {
      key: 'market',
      header: messages.finance.market,
      cell: (row) => <code dir="ltr">{row.marketCode}</code>,
    },
    {
      key: 'amount',
      header: messages.finance.amount,
      align: 'end',
      cell: (row) => <bdi className="pc-money">{formatMoney(row.amount, locale)}</bdi>,
    },
    {
      key: 'status',
      header: messages.finance.status,
      cell: (row) => (
        <StatusBadge status={row.status} label={messages.priceStatuses[row.status] ?? row.status} />
      ),
    },
    {
      key: 'from',
      header: messages.finance.effectiveFrom,
      cell: (row) =>
        row.effectiveFrom === null ? (
          '—'
        ) : (
          <time dateTime={row.effectiveFrom}>{when.format(new Date(row.effectiveFrom))}</time>
        ),
    },
    {
      key: 'actions',
      header: '',
      cell: (row) =>
        can.has('pricing:price:activate') && row.status !== 'RETIRED' ? (
          row.status === 'DRAFT' ? (
            <ConfirmAction
              locale={locale}
              label={messages.finance.activate}
              title={`${messages.finance.activate}: ${messages.products[row.productCode] ?? row.productCode} ${formatMoney(row.amount, locale)}`}
              intro={messages.finance.activateIntro}
              buttonClassName="pc-btn pc-btn-secondary pc-btn-sm"
              onConfirm={async () => {
                await financeAdminApi.activatePrice(row.id);
                await after(messages.finance.activated);
              }}
            />
          ) : (
            <ConfirmAction
              locale={locale}
              label={messages.finance.retire}
              title={`${messages.finance.retire}: ${messages.products[row.productCode] ?? row.productCode} ${formatMoney(row.amount, locale)}`}
              intro={messages.finance.retireIntro}
              danger
              buttonClassName="pc-btn pc-btn-secondary pc-btn-sm"
              onConfirm={async () => {
                await financeAdminApi.retirePrice(row.id);
                await after(messages.finance.retired);
              }}
            />
          )
        ) : null,
    },
  ];

  return (
    <section className="pc-card" aria-labelledby="finance-prices-heading">
      <h2 id="finance-prices-heading" className="pc-card-title">
        {messages.finance.prices}
      </h2>
      <p className="pc-hint">{messages.finance.pricesIntro}</p>
      <FormSuccess message={done} />
      {error !== null ? (
        <ErrorState title={error} />
      ) : prices === null ? (
        <LoadingState label={messages.common.loading} />
      ) : prices.length === 0 ? (
        <EmptyState icon="balance" title={messages.finance.noPrices} headingLevel={3} />
      ) : (
        <DataTable
          caption={messages.finance.prices}
          columns={columns}
          rows={prices}
          rowKey={(row) => row.id}
        />
      )}
      {can.has('pricing:price:create') ? (
        <DraftPrice onDrafted={() => after(messages.finance.drafted)} />
      ) : null}
    </section>
  );
}

function DraftPrice({ onDrafted }: { onDrafted: () => Promise<void> }) {
  const locale = useAdminLocale();
  const messages = getAdminMessages(locale);
  const id = useId();
  const [product, setProduct] = useState<string>(PRODUCTS[0]);
  const [currencies, setCurrencies] = useState<readonly string[]>([]);
  const [currency, setCurrency] = useState<string>('');
  const [amount, setAmount] = useState('');
  const [market, setMarket] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    // The currencies PalCert transacts, from the server's own registry.
    balanceApi
      .currencies()
      .then((codes) => {
        if (cancelled) return;
        setCurrencies(codes);
        setCurrency((current) => (current === '' ? (codes[0] ?? '') : current));
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);

  async function submit(event: FormEvent): Promise<void> {
    event.preventDefault();
    if (pending || currency === '') return;
    const minor = toMinorUnits(amount, currency);
    if (minor === null || minor === '0') {
      setError(messages.finance.invalidAmount);
      return;
    }
    setError(null);
    setPending(true);
    try {
      await financeAdminApi.createPrice({
        productCode: product,
        currency,
        amountMinorUnits: minor,
        ...(market.trim() === '' ? {} : { marketCode: market.trim().toUpperCase() }),
      });
      setAmount('');
      setMarket('');
      await onDrafted();
    } catch (caught) {
      setError(describeAdminError(messages, caught).message);
    } finally {
      setPending(false);
    }
  }

  return (
    <form className="pc-form pc-inline-form" onSubmit={submit} noValidate>
      <h3 className="pc-subheading">{messages.finance.draftPrice}</h3>
      <p className="pc-hint">{messages.finance.draftIntro}</p>
      <FormError message={error} />
      <div className="pc-form-row">
        <div className="pc-field">
          <label htmlFor={`${id}-product`}>{messages.finance.product}</label>
          <select id={`${id}-product`} value={product} onChange={(e) => setProduct(e.target.value)}>
            <ProductOptions />
          </select>
        </div>
        <div className="pc-field">
          <label htmlFor={`${id}-currency`}>{messages.finance.currency}</label>
          <select
            id={`${id}-currency`}
            value={currency}
            onChange={(e) => setCurrency(e.target.value)}
          >
            {currencies.map((code) => (
              <option key={code} value={code}>
                {code}
              </option>
            ))}
          </select>
        </div>
        <div className="pc-field">
          <label htmlFor={`${id}-amount`}>{messages.finance.amount}</label>
          <input
            id={`${id}-amount`}
            inputMode="decimal"
            dir="ltr"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            aria-describedby={`${id}-amount-hint`}
          />
          <p id={`${id}-amount-hint`} className="pc-hint">
            {messages.finance.amountHint}
          </p>
        </div>
        <div className="pc-field">
          <label htmlFor={`${id}-market`}>
            {messages.finance.marketLabel}{' '}
            <span className="pc-hint">({messages.common.optional})</span>
          </label>
          <input
            id={`${id}-market`}
            dir="ltr"
            maxLength={16}
            value={market}
            onChange={(e) => setMarket(e.target.value)}
            aria-describedby={`${id}-market-hint`}
          />
          <p id={`${id}-market-hint`} className="pc-hint">
            {messages.finance.marketHint}
          </p>
        </div>
      </div>
      <button type="submit" className="secondary" disabled={pending} aria-busy={pending}>
        {pending ? messages.common.loading : messages.finance.createDraft}
      </button>
    </form>
  );
}

function LedgerCheck() {
  const locale = useAdminLocale();
  const messages = getAdminMessages(locale);
  const [result, setResult] = useState<LedgerVerificationResponse | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const number = new Intl.NumberFormat(locale);

  async function run(): Promise<void> {
    setPending(true);
    setError(null);
    try {
      setResult(await financeAdminApi.verifyLedger());
    } catch (caught) {
      setError(describeAdminError(messages, caught).message);
    } finally {
      setPending(false);
    }
  }

  return (
    <section className="pc-card" aria-labelledby="finance-ledger-heading">
      <h2 id="finance-ledger-heading" className="pc-card-title">
        {messages.finance.ledger}
      </h2>
      <p className="pc-hint">{messages.finance.ledgerIntro}</p>
      <button
        type="button"
        className="pc-btn pc-btn-secondary"
        disabled={pending}
        aria-busy={pending}
        onClick={() => void run()}
      >
        {pending ? messages.finance.checking : messages.finance.runCheck}
      </button>
      <FormError message={error} />
      <div role="status" aria-live="polite">
        {result === null ? null : (
          <div className="pc-ledger-result">
            <StatusBadge
              tone={result.consistent ? 'success' : 'danger'}
              label={
                result.consistent ? messages.finance.consistent : messages.finance.inconsistent
              }
            />
            <div className="pc-admin-figures">
              <Figure
                label={messages.finance.accountsChecked}
                value={number.format(result.accountsChecked)}
              />
              <Figure
                label={messages.finance.entriesChecked}
                value={number.format(result.entriesChecked)}
              />
            </div>
            {result.findings.length === 0 ? null : (
              <>
                <h3 className="pc-subheading">{messages.finance.findings}</h3>
                <ul className="pc-finding-list">
                  {result.findings.map((finding) => (
                    <li key={`${finding.code}-${finding.subjectId}`}>
                      <code dir="ltr">{finding.code}</code> <span dir="ltr">{finding.detail}</span>{' '}
                      <code dir="ltr">{finding.subjectId}</code>
                    </li>
                  ))}
                </ul>
              </>
            )}
          </div>
        )}
      </div>
    </section>
  );
}

function RefundLookup() {
  const locale = useAdminLocale();
  const messages = getAdminMessages(locale);
  const balance = getBalanceMessages(locale);
  const id = useId();
  const [refundId, setRefundId] = useState('');
  const [refund, setRefund] = useState<PaymentRefundResponse | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(event: FormEvent): Promise<void> {
    event.preventDefault();
    const value = refundId.trim();
    if (!UUID.test(value)) {
      setError(messages.finance.invalidId);
      setRefund(null);
      return;
    }
    setPending(true);
    setError(null);
    try {
      setRefund(await financeAdminApi.refundById(value));
    } catch (caught) {
      setRefund(null);
      setError(describeAdminError(messages, caught).message);
    } finally {
      setPending(false);
    }
  }

  const when = new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short' });

  return (
    <section className="pc-card" aria-labelledby="finance-refund-heading">
      <h2 id="finance-refund-heading" className="pc-card-title">
        {messages.finance.refundLookup}
      </h2>
      <p className="pc-hint">{messages.finance.refundLookupIntro}</p>
      <form className="pc-form" onSubmit={submit} noValidate>
        <div className="pc-field">
          <label htmlFor={`${id}-refund`}>{messages.finance.refundId}</label>
          <input
            id={`${id}-refund`}
            dir="ltr"
            value={refundId}
            maxLength={36}
            onChange={(e) => setRefundId(e.target.value)}
          />
        </div>
        <FormError message={error} />
        <button type="submit" className="secondary" disabled={pending} aria-busy={pending}>
          {pending ? messages.common.loading : messages.finance.lookup}
        </button>
      </form>
      {refund === null ? null : (
        <dl className="pc-summary">
          <dt>{messages.customer.paymentStatus}</dt>
          <dd>
            <StatusBadge
              status={refund.status}
              label={balance.refundStatuses[refund.status] ?? refund.status}
            />
          </dd>
          <dt>{messages.customer.paymentAmount}</dt>
          <dd>
            <bdi>{formatMoney(refund.amount, locale)}</bdi>
          </dd>
          <dt>{messages.customer.refundReason}</dt>
          <dd>
            {refund.reason === null
              ? '—'
              : (messages.refundReasons[refund.reason] ?? refund.reason)}
          </dd>
          <dt>{messages.customer.paymentCreated}</dt>
          <dd>
            <time dateTime={refund.createdAt}>{when.format(new Date(refund.createdAt))}</time>
          </dd>
        </dl>
      )}
    </section>
  );
}

/** Products in two groups, so an AI price is never drafted by mistake for a document service. */
function ProductOptions() {
  const messages = getAdminMessages(useAdminLocale());
  return (
    <>
      <optgroup label={messages.finance.standardServices}>
        {DOCUMENT_PRODUCTS.map((code) => (
          <option key={code} value={code}>
            {messages.products[code] ?? code}
          </option>
        ))}
      </optgroup>
      <optgroup label={messages.finance.aiServices}>
        {AI_PRODUCTS.map((code) => (
          <option key={code} value={code}>
            {messages.products[code] ?? code}
          </option>
        ))}
      </optgroup>
    </>
  );
}

function ProductName({ code }: { code: string }) {
  const messages = getAdminMessages(useAdminLocale());
  return (
    <span className="pc-product-name">
      {messages.products[code] ?? code}
      {AI_PRODUCT_SET.has(code) ? (
        <StatusBadge tone="neutral" label={messages.finance.aiTag} />
      ) : null}
    </span>
  );
}

/**
 * Purchases and captured revenue per product and currency (ADR-0149).
 *
 * Read from the purchases themselves: there is no second revenue record to
 * drift from them. Each currency is its own row, because adding dollars to
 * shekels would produce a number that means nothing.
 */
function PurchasesByProduct() {
  const locale = useAdminLocale();
  const messages = getAdminMessages(locale);
  const billing = getBillingMessages(locale);
  const id = useId();
  const [product, setProduct] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [filter, setFilter] = useState<PurchaseReportFilter>({});
  const [summary, setSummary] = useState<PurchaseSummaryRowResponse[] | null>(null);
  const [report, setReport] = useState<AdminPurchaseReportRowResponse[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [rangeError, setRangeError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setSummary(null);
    setReport(null);
    Promise.all([
      financeAdminApi.purchaseSummary(filter),
      financeAdminApi.purchaseReport({ ...filter, limit: 50 }),
    ])
      .then(([summaryView, rows]) => {
        if (cancelled) return;
        setSummary(summaryView.rows);
        setReport(rows);
        setError(null);
      })
      .catch((caught: unknown) => {
        if (!cancelled) setError(describeAdminError(messages, caught).message);
      });
    return () => {
      cancelled = true;
    };
  }, [filter, messages]);

  function apply(event: FormEvent): void {
    event.preventDefault();
    if ((from !== '' && !ISO_DAY.test(from)) || (to !== '' && !ISO_DAY.test(to))) {
      setRangeError(messages.finance.invalidRange);
      return;
    }
    if (from !== '' && to !== '' && from > to) {
      setRangeError(messages.finance.invalidRange);
      return;
    }
    setRangeError(null);
    setFilter({
      ...(product === '' ? {} : { productCode: product }),
      ...(from === '' ? {} : { from }),
      ...(to === '' ? {} : { to }),
    });
  }

  const number = new Intl.NumberFormat(locale);
  const when = new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short' });
  const summaryColumns: DataColumn<PurchaseSummaryRowResponse>[] = [
    {
      key: 'product',
      header: messages.finance.product,
      primary: true,
      cell: (row) => <ProductName code={row.productCode} />,
    },
    {
      key: 'currency',
      header: messages.finance.currency,
      cell: (row) => <code dir="ltr">{row.currency}</code>,
    },
    {
      key: 'count',
      header: messages.finance.purchaseCount,
      align: 'end',
      cell: (row) => number.format(row.purchaseCount),
    },
    {
      key: 'reserved',
      header: messages.finance.reservedCol,
      align: 'end',
      cell: (row) => (
        <span className="pc-cell-stack">
          <span>{number.format(row.reservedCount)}</span>
          <bdi className="pc-money pc-hint">{formatMoney(row.reservedAmount, locale)}</bdi>
        </span>
      ),
    },
    {
      key: 'captured',
      header: messages.finance.capturedCol,
      align: 'end',
      cell: (row) => number.format(row.capturedCount),
    },
    {
      key: 'released',
      header: messages.finance.releasedCol,
      align: 'end',
      cell: (row) => number.format(row.releasedCount),
    },
    {
      key: 'refunded',
      header: messages.finance.refundedCol,
      align: 'end',
      cell: (row) =>
        row.refundedCount === 0 ? (
          '0'
        ) : (
          <span className="pc-cell-stack">
            <span>{number.format(row.refundedCount)}</span>
            <bdi className="pc-money pc-hint">{formatMoney(row.refundedAmount, locale)}</bdi>
          </span>
        ),
    },
    {
      key: 'revenue',
      header: messages.finance.revenue,
      align: 'end',
      cell: (row) => (
        <bdi className="pc-money" data-testid="purchase-revenue">
          {formatMoney(row.capturedAmount, locale)}
        </bdi>
      ),
    },
  ];

  const reportColumns: DataColumn<AdminPurchaseReportRowResponse>[] = [
    {
      key: 'product',
      header: messages.finance.product,
      primary: true,
      cell: (row) => <ProductName code={row.productCode} />,
    },
    {
      key: 'payer',
      header: messages.finance.payer,
      cell: (row) => (
        <span className="pc-cell-stack">
          <span>{row.payer.displayName ?? row.payer.email}</span>
          {row.payer.displayName === null ? null : (
            <span className="pc-hint" dir="ltr">
              {row.payer.email}
            </span>
          )}
        </span>
      ),
    },
    {
      key: 'organization',
      header: messages.finance.organization,
      cell: (row) =>
        row.organization === null ? (
          <span className="pc-hint">{messages.finance.personalUse}</span>
        ) : (
          row.organization.name
        ),
    },
    {
      key: 'amount',
      header: messages.finance.amount,
      align: 'end',
      cell: (row) => <bdi className="pc-money">{formatMoney(row.amount, locale)}</bdi>,
    },
    {
      key: 'status',
      header: messages.finance.status,
      cell: (row) => (
        <StatusBadge status={row.status} label={billing.statuses[row.status] ?? row.status} />
      ),
    },
    {
      key: 'created',
      header: messages.finance.createdCol,
      cell: (row) => <time dateTime={row.createdAt}>{when.format(new Date(row.createdAt))}</time>,
    },
    {
      key: 'completed',
      header: messages.finance.completedCol,
      cell: (row) =>
        row.deliveredAt === null ? (
          '—'
        ) : (
          <time dateTime={row.deliveredAt}>{when.format(new Date(row.deliveredAt))}</time>
        ),
    },
  ];

  return (
    <section className="pc-card" aria-labelledby="finance-purchases-heading">
      <h2 id="finance-purchases-heading" className="pc-card-title">
        {messages.finance.purchases}
      </h2>
      <p className="pc-hint">{messages.finance.purchasesIntro}</p>
      <form className="pc-form pc-inline-form" onSubmit={apply} noValidate>
        <div className="pc-form-row">
          <div className="pc-field">
            <label htmlFor={`${id}-product`}>{messages.finance.product}</label>
            <select
              id={`${id}-product`}
              value={product}
              onChange={(e) => setProduct(e.target.value)}
            >
              <option value="">{messages.finance.allProducts}</option>
              <ProductOptions />
            </select>
          </div>
          <div className="pc-field">
            <label htmlFor={`${id}-from`}>{messages.finance.from}</label>
            <input
              id={`${id}-from`}
              type="date"
              dir="ltr"
              value={from}
              onChange={(e) => setFrom(e.target.value)}
            />
          </div>
          <div className="pc-field">
            <label htmlFor={`${id}-to`}>{messages.finance.to}</label>
            <input
              id={`${id}-to`}
              type="date"
              dir="ltr"
              value={to}
              onChange={(e) => setTo(e.target.value)}
            />
          </div>
        </div>
        <FormError message={rangeError} />
        <button type="submit" className="secondary">
          {messages.finance.applyFilters}
        </button>
      </form>
      <p className="pc-hint">{messages.finance.currencyNote}</p>
      {error !== null ? (
        <ErrorState title={error} />
      ) : summary === null || report === null ? (
        <LoadingState label={messages.common.loading} />
      ) : summary.length === 0 ? (
        <EmptyState icon="balance" title={messages.finance.noPurchases} headingLevel={3} />
      ) : (
        <>
          <DataTable
            caption={messages.finance.purchases}
            columns={summaryColumns}
            rows={summary}
            rowKey={(row) => `${row.productCode}-${row.currency}`}
            scrollable
          />
          <h3 className="pc-subheading">{messages.finance.recentPurchases}</h3>
          <p className="pc-hint">{messages.finance.recentPurchasesIntro}</p>
          <DataTable
            caption={messages.finance.recentPurchases}
            columns={reportColumns}
            rows={report}
            rowKey={(row) => row.purchaseId}
            scrollable
          />
        </>
      )}
    </section>
  );
}
