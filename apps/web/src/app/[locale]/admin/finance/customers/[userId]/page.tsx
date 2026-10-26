'use client';

import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useEffect, useId, useState, type FormEvent } from 'react';
import {
  AdminGate,
  ConfirmAction,
  describeAdminError,
  Figure,
  ReauthNotice,
  useAdminLocale,
  type AdminFailure,
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
  adminApi,
  balanceApi,
  financeAdminApi,
  type AdminBalanceResponse,
  type AdminServicePurchaseResponse,
  type BalanceTopUpResponse,
} from '@/lib/api-client';
import { formatMoney, toMinorUnits, toDecimalString } from '@/lib/money';
import { useIdempotencyKey } from '@/lib/use-idempotency-key';

/** The reasons a person records for a manual adjustment; the rest are the system's own. */
const ADJUSTMENT_REASONS = [
  'CUSTOMER_REQUEST',
  'GOODWILL',
  'PROMOTION',
  'BILLING_CORRECTION',
] as const;
const REFUND_REASONS = [
  'REQUESTED_BY_CUSTOMER',
  'DUPLICATE',
  'FRAUDULENT',
  'SERVICE_NOT_DELIVERED',
  'GOODWILL',
] as const;

/**
 * One customer's money, for PalCert finance staff.
 *
 * Four separate authorities, four separate sections: reading the balance
 * (ledger), reading payments, reading purchases, and the two ways money can
 * move — a provider refund and a reasoned adjustment. Each appears only for
 * the permission behind it; the API checks every one again.
 */
export default function CustomerFinancePage() {
  return (
    <AdminGate allowed={(can) => FINANCE_READ.some((permission) => can.has(permission))}>
      <Customer />
    </AdminGate>
  );
}

function Customer() {
  const locale = useAdminLocale();
  const userId = String(useParams().userId);
  const messages = getAdminMessages(locale);
  const can = useShell().globalPermissions;
  const [who, setWho] = useState<string | null>(null);
  const [currencies, setCurrencies] = useState<readonly string[]>([]);
  const [revision, setRevision] = useState(0);
  const [done, setDone] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    if (can.has('admin:user:read')) {
      adminApi
        .user(userId)
        .then((user) => {
          if (!cancelled) setWho(user.displayName ?? user.email);
        })
        .catch(() => undefined);
    }
    balanceApi
      .currencies()
      .then((codes) => {
        if (!cancelled) setCurrencies(codes);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [can, userId]);

  /** After money moves, read everything again rather than adjust figures locally. */
  function moved(message: string): void {
    setDone(message);
    setRevision((current) => current + 1);
  }

  return (
    <main className="pc-page">
      <PageHeader
        title={who === null ? messages.customer.title : `${messages.customer.title}: ${who}`}
        description={messages.customer.intro}
        actions={
          can.has('admin:user:read') ? (
            <Link className="pc-btn pc-btn-secondary" href={`/${locale}/admin/users/${userId}`}>
              {messages.customer.backToUser}
            </Link>
          ) : undefined
        }
      />
      <FormSuccess message={done} />
      {can.has('finance:ledger:read') ? (
        <Balance userId={userId} currencies={currencies} revision={revision} />
      ) : null}
      {can.has('finance:adjustment:create') && currencies.length > 0 ? (
        <Adjust
          userId={userId}
          currencies={currencies}
          onAdjusted={() => moved(messages.customer.adjusted)}
        />
      ) : null}
      {can.has('finance:payment:read') ? (
        <Payments
          userId={userId}
          revision={revision}
          canRefund={can.has('finance:refund:create')}
          onRefunded={() => moved(messages.customer.refundCreated)}
        />
      ) : null}
      {can.has('finance:purchase:read') ? <Purchases userId={userId} revision={revision} /> : null}
    </main>
  );
}

function Balance({
  userId,
  currencies,
  revision,
}: {
  userId: string;
  currencies: readonly string[];
  revision: number;
}) {
  const locale = useAdminLocale();
  const messages = getAdminMessages(locale);
  const id = useId();
  const [currency, setCurrency] = useState<string | undefined>(undefined);
  const [balance, setBalance] = useState<AdminBalanceResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setBalance(null);
    financeAdminApi
      .balance(userId, currency)
      .then((result) => {
        if (!cancelled) {
          setBalance(result);
          setError(null);
        }
      })
      .catch((caught: unknown) => {
        if (!cancelled) setError(describeAdminError(messages, caught).message);
      });
    return () => {
      cancelled = true;
    };
  }, [currency, messages, revision, userId]);

  return (
    <section className="pc-card" aria-labelledby="customer-balance-heading">
      <h2 id="customer-balance-heading" className="pc-card-title">
        {messages.customer.balance}
      </h2>
      {currencies.length > 1 ? (
        <div className="pc-field pc-field-inline">
          <label htmlFor={`${id}-currency`}>{messages.finance.currency}</label>
          <select
            id={`${id}-currency`}
            value={currency ?? balance?.currency ?? ''}
            onChange={(event) => setCurrency(event.target.value)}
          >
            {currencies.map((code) => (
              <option key={code} value={code}>
                {code}
              </option>
            ))}
          </select>
        </div>
      ) : null}
      {error !== null ? (
        <ErrorState title={error} />
      ) : balance === null ? (
        <LoadingState label={messages.common.loading} />
      ) : (
        <div className="pc-admin-figures">
          <Figure
            label={messages.customer.available}
            value={<bdi>{formatMoney(balance.available, locale)}</bdi>}
          />
          <Figure
            label={messages.customer.reserved}
            value={<bdi>{formatMoney(balance.reserved, locale)}</bdi>}
          />
          <Figure
            label={messages.customer.cash}
            value={<bdi>{formatMoney(balance.cash, locale)}</bdi>}
          />
          <Figure
            label={messages.customer.promotional}
            value={<bdi>{formatMoney(balance.promotional, locale)}</bdi>}
          />
        </div>
      )}
    </section>
  );
}

function Payments({
  userId,
  revision,
  canRefund,
  onRefunded,
}: {
  userId: string;
  revision: number;
  canRefund: boolean;
  onRefunded: () => void;
}) {
  const locale = useAdminLocale();
  const messages = getAdminMessages(locale);
  const balance = getBalanceMessages(locale);
  const [rows, setRows] = useState<BalanceTopUpResponse[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    financeAdminApi
      .payments(userId)
      .then((result) => {
        if (!cancelled) setRows([...result]);
      })
      .catch((caught: unknown) => {
        if (!cancelled) setError(describeAdminError(messages, caught).message);
      });
    return () => {
      cancelled = true;
    };
  }, [messages, revision, userId]);

  const when = new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short' });
  const columns: DataColumn<BalanceTopUpResponse>[] = [
    {
      key: 'amount',
      header: messages.customer.paymentAmount,
      primary: true,
      cell: (row) => <bdi className="pc-money">{formatMoney(row.amount, locale)}</bdi>,
    },
    {
      key: 'status',
      header: messages.customer.paymentStatus,
      cell: (row) => (
        <StatusBadge status={row.status} label={balance.topUpStatuses[row.status] ?? row.status} />
      ),
    },
    {
      key: 'created',
      header: messages.customer.paymentCreated,
      cell: (row) => <time dateTime={row.createdAt}>{when.format(new Date(row.createdAt))}</time>,
    },
    {
      key: 'refund',
      header: messages.customer.refund,
      cell: (row) =>
        canRefund && row.status === 'SUCCEEDED' ? (
          <RefundAction payment={row} onRefunded={onRefunded} />
        ) : null,
    },
  ];

  return (
    <section className="pc-card" aria-labelledby="customer-payments-heading">
      <h2 id="customer-payments-heading" className="pc-card-title">
        {messages.customer.payments}
      </h2>
      {error !== null ? (
        <ErrorState title={error} />
      ) : rows === null ? (
        <LoadingState label={messages.common.loading} />
      ) : rows.length === 0 ? (
        <EmptyState icon="balance" title={messages.customer.noPayments} headingLevel={3} />
      ) : (
        <DataTable
          caption={messages.customer.payments}
          columns={columns}
          rows={rows}
          rowKey={(row) => row.id}
        />
      )}
    </section>
  );
}

function RefundAction({
  payment,
  onRefunded,
}: {
  payment: BalanceTopUpResponse;
  onRefunded: () => void;
}) {
  const locale = useAdminLocale();
  const messages = getAdminMessages(locale);
  const currency = payment.amount.currency;
  return (
    <ConfirmAction
      locale={locale}
      label={messages.customer.refund}
      title={`${messages.customer.refund}: ${formatMoney(payment.amount, locale)}`}
      intro={messages.customer.refundIntro}
      danger
      buttonClassName="pc-btn pc-btn-secondary pc-btn-sm"
      fields={[
        {
          name: 'amount',
          label: `${messages.customer.refundAmount} (${currency})`,
          hint: `${messages.finance.amountHint} ≤ ${toDecimalString(payment.amount.minorUnits, currency)}`,
          maxLength: 24,
          required: true,
          inputMode: 'decimal',
          ltr: true,
          validate: (value) => {
            const minor = toMinorUnits(value, currency);
            return minor === null || minor === '0' ? messages.finance.invalidAmount : null;
          },
        },
        {
          name: 'reason',
          label: messages.customer.refundReason,
          maxLength: 64,
          options: REFUND_REASONS.map((code) => ({
            value: code,
            label: messages.refundReasons[code] ?? code,
          })),
        },
      ]}
      onConfirm={async (values) => {
        await financeAdminApi.refund({
          topUpId: payment.id,
          amountMinorUnits: toMinorUnits(values['amount'] ?? '', currency) ?? '0',
          reason: values['reason'] ?? 'REQUESTED_BY_CUSTOMER',
        });
        onRefunded();
      }}
    />
  );
}

function Purchases({ userId, revision }: { userId: string; revision: number }) {
  const locale = useAdminLocale();
  const messages = getAdminMessages(locale);
  const billing = getBillingMessages(locale);
  const [rows, setRows] = useState<AdminServicePurchaseResponse[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    financeAdminApi
      .purchases(userId)
      .then((result) => {
        if (!cancelled) setRows([...result]);
      })
      .catch((caught: unknown) => {
        if (!cancelled) setError(describeAdminError(messages, caught).message);
      });
    return () => {
      cancelled = true;
    };
  }, [messages, revision, userId]);

  const when = new Intl.DateTimeFormat(locale, { dateStyle: 'medium' });
  const columns: DataColumn<AdminServicePurchaseResponse>[] = [
    {
      key: 'product',
      header: messages.finance.product,
      primary: true,
      cell: (row) => messages.products[row.productCode] ?? row.productCode,
    },
    {
      key: 'amount',
      header: messages.customer.purchaseAmount,
      align: 'end',
      cell: (row) => <bdi className="pc-money">{formatMoney(row.amount, locale)}</bdi>,
    },
    {
      key: 'charged',
      header: messages.customer.purchaseCharged,
      align: 'end',
      cell: (row) => <bdi className="pc-money">{formatMoney(row.charged, locale)}</bdi>,
    },
    {
      key: 'status',
      header: messages.customer.purchaseStatus,
      cell: (row) => (
        <StatusBadge status={row.status} label={billing.statuses[row.status] ?? row.status} />
      ),
    },
    {
      key: 'allocations',
      header: messages.customer.allocations,
      cell: (row) =>
        row.allocations.length === 0 ? (
          '—'
        ) : (
          <span className="pc-cell-stack">
            {row.allocations.map((allocation, index) => (
              <span key={index}>
                {messages.creditClasses[allocation.creditClass] ?? allocation.creditClass}:{' '}
                <bdi>{formatMoney(allocation.amount, locale)}</bdi>
              </span>
            ))}
          </span>
        ),
    },
    {
      key: 'created',
      header: messages.finance.created,
      cell: (row) => <time dateTime={row.createdAt}>{when.format(new Date(row.createdAt))}</time>,
    },
  ];

  return (
    <section className="pc-card" aria-labelledby="customer-purchases-heading">
      <h2 id="customer-purchases-heading" className="pc-card-title">
        {messages.customer.purchases}
      </h2>
      {error !== null ? (
        <ErrorState title={error} />
      ) : rows === null ? (
        <LoadingState label={messages.common.loading} />
      ) : rows.length === 0 ? (
        <EmptyState icon="check" title={messages.customer.noPurchases} headingLevel={3} />
      ) : (
        <DataTable
          caption={messages.customer.purchases}
          columns={columns}
          rows={rows}
          rowKey={(row) => row.purchaseId}
        />
      )}
    </section>
  );
}

function Adjust({
  userId,
  currencies,
  onAdjusted,
}: {
  userId: string;
  currencies: readonly string[];
  onAdjusted: () => void;
}) {
  const locale = useAdminLocale();
  const messages = getAdminMessages(locale);
  const balance = getBalanceMessages(locale);
  const id = useId();
  const idempotency = useIdempotencyKey();
  const [direction, setDirection] = useState<'credit' | 'debit'>('credit');
  const [currency, setCurrency] = useState(currencies[0] ?? '');
  const [creditClass, setCreditClass] = useState<'CASH' | 'PROMOTIONAL'>('CASH');
  const [amount, setAmount] = useState('');
  const [reason, setReason] = useState<(typeof ADJUSTMENT_REASONS)[number]>('CUSTOMER_REQUEST');
  const [note, setNote] = useState('');
  const [pending, setPending] = useState(false);
  const [failure, setFailure] = useState<AdminFailure | null>(null);

  async function submit(event: FormEvent): Promise<void> {
    event.preventDefault();
    if (pending) return;
    const minor = toMinorUnits(amount, currency);
    if (minor === null || minor === '0') {
      setFailure({ message: messages.finance.invalidAmount, reauth: false });
      return;
    }
    const signed = direction === 'debit' ? `-${minor}` : minor;
    const fingerprint = [userId, currency, creditClass, signed, reason, note.trim()].join('|');
    setFailure(null);
    setPending(true);
    try {
      await financeAdminApi.adjust({
        ownerUserId: userId,
        currency,
        creditClass,
        amountMinorUnits: signed,
        reasonCode: reason,
        // One key per intended adjustment: a retry of the same one cannot
        // move money twice, and a different one gets a different key.
        idempotencyKey: idempotency.keyFor(fingerprint),
        ...(note.trim() === '' ? {} : { note: note.trim() }),
      });
      idempotency.reset();
      setAmount('');
      setNote('');
      onAdjusted();
    } catch (caught) {
      setFailure(describeAdminError(messages, caught));
    } finally {
      setPending(false);
    }
  }

  return (
    <section className="pc-card" aria-labelledby="customer-adjust-heading">
      <h2 id="customer-adjust-heading" className="pc-card-title">
        {messages.customer.adjust}
      </h2>
      <p className="pc-hint">{messages.customer.adjustIntro}</p>
      <form className="pc-form" onSubmit={submit} noValidate>
        {failure === null ? null : failure.reauth ? (
          <ReauthNotice locale={locale} />
        ) : (
          <FormError message={failure.message} />
        )}
        <fieldset className="pc-fieldset">
          <legend>{messages.customer.direction}</legend>
          {(['credit', 'debit'] as const).map((value) => (
            <label key={value} className="pc-radio">
              <input
                type="radio"
                name={`${id}-direction`}
                value={value}
                checked={direction === value}
                onChange={() => setDirection(value)}
              />
              {value === 'credit' ? messages.customer.credit : messages.customer.debit}
            </label>
          ))}
        </fieldset>
        <div className="pc-form-row">
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
            <label htmlFor={`${id}-class`}>{messages.customer.creditClass}</label>
            <select
              id={`${id}-class`}
              value={creditClass}
              onChange={(e) => setCreditClass(e.target.value as 'CASH' | 'PROMOTIONAL')}
            >
              {(['CASH', 'PROMOTIONAL'] as const).map((code) => (
                <option key={code} value={code}>
                  {messages.creditClasses[code]}
                </option>
              ))}
            </select>
          </div>
          <div className="pc-field">
            <label htmlFor={`${id}-amount`}>{messages.finance.amount}</label>
            <input
              id={`${id}-amount`}
              dir="ltr"
              inputMode="decimal"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              aria-describedby={`${id}-amount-hint`}
            />
            <p id={`${id}-amount-hint`} className="pc-hint">
              {messages.finance.amountHint}
            </p>
          </div>
          <div className="pc-field">
            <label htmlFor={`${id}-reason`}>{messages.customer.reasonCode}</label>
            <select
              id={`${id}-reason`}
              value={reason}
              onChange={(e) => setReason(e.target.value as (typeof ADJUSTMENT_REASONS)[number])}
            >
              {ADJUSTMENT_REASONS.map((code) => (
                <option key={code} value={code}>
                  {balance.reasonCodes[code] ?? code}
                </option>
              ))}
            </select>
          </div>
        </div>
        <div className="pc-field">
          <label htmlFor={`${id}-note`}>
            {messages.customer.note} <span className="pc-hint">({messages.common.optional})</span>
          </label>
          <textarea
            id={`${id}-note`}
            rows={2}
            maxLength={500}
            value={note}
            onChange={(e) => setNote(e.target.value)}
          />
        </div>
        <button type="submit" disabled={pending} aria-busy={pending}>
          {pending ? messages.common.loading : messages.customer.adjust}
        </button>
      </form>
    </section>
  );
}
