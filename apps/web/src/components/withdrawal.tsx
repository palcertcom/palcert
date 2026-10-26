'use client';

import {
  PAYOUT_DESTINATION_TYPES,
  withdrawalAmountToMinor,
  type PayoutDestinationInput,
  type PayoutDestinationSummary,
  type PayoutDestinationType,
  type PayoutDestinationView,
  type PayoutFundsRowView,
  type UserWithdrawableView,
  type WithdrawalEventView,
  type WithdrawalRequestView,
  type WithdrawalStatus,
} from '@palcert/contracts/finance/withdrawals';
import Link from 'next/link';
import { useEffect, useId, useState, type ReactNode } from 'react';
import { ConfirmAction } from '@/components/ui/confirm-action';
import { DataTable } from '@/components/ui/data-table';
import { EmptyState, LoadingState } from '@/components/ui/states';
import { StatusBadge } from '@/components/ui/status-badge';
import type { StatusTone } from '@/lib/status-tone';
import type { Locale } from '@/i18n/locales';
import { getWithdrawalMessages, type WithdrawalMessages } from '@/i18n/withdrawal-messages';
import { ApiError, type MoneyResponse } from '@/lib/api-client';
import { formatMoney, toDecimalString } from '@/lib/money';
import { useIdempotencyKey } from '@/lib/use-idempotency-key';
import { userWithdrawalsApi, type PayoutScopeApi } from '@/lib/withdrawals-api';

/** What a failed call should say, and whether the way out is to sign in again. */
export function describeWithdrawalError(
  messages: WithdrawalMessages,
  caught: unknown,
): { message: string; reauth: boolean } {
  if (caught instanceof ApiError) {
    return {
      message: messages.errors[caught.code] ?? messages.genericError,
      reauth: caught.code === 'REAUTHENTICATION_REQUIRED',
    };
  }
  return { message: messages.genericError, reauth: false };
}

const TONES: Readonly<Record<WithdrawalStatus, StatusTone>> = {
  DRAFT: 'neutral',
  PENDING_REVIEW: 'warning',
  APPROVED: 'success',
  PROCESSING: 'warning',
  PAID: 'success',
  REJECTED: 'danger',
  CANCELLED: 'neutral',
  FAILED: 'danger',
};

export function WithdrawalStatusBadge({
  status,
  locale,
}: {
  readonly status: WithdrawalStatus;
  readonly locale: Locale;
}) {
  const messages = getWithdrawalMessages(locale);
  return (
    <StatusBadge
      label={messages.statuses[status] ?? status}
      status={status}
      tone={TONES[status]}
      title={messages.statusHints[status]}
    />
  );
}

export function Amount({ amount, locale }: { amount: MoneyResponse; locale: Locale }) {
  return (
    <span className="pc-ltr" data-minor-units={amount.minorUnits} data-currency={amount.currency}>
      {formatMoney(amount, locale)}
    </span>
  );
}

/** One line naming a destination, masked: "Bank of Palestine •••• 5432". */
export function destinationLine(summary: PayoutDestinationSummary, locale: Locale): string {
  return `${summary.label} — ${destinationDetail(summary, locale)}`;
}

/** Where the money goes, without the destination's own name: bank or type, then the mask. */
export function destinationDetail(summary: PayoutDestinationSummary, locale: Locale): string {
  const messages = getWithdrawalMessages(locale);
  const masked = summary.ibanMasked ?? summary.accountNumberMasked ?? summary.mobileNumberMasked;
  const kind = summary.bankName ?? messages.destinationTypes[summary.type] ?? summary.type;
  return masked === null ? kind : `${kind} ${masked}`;
}

/** The masked destination, as finance was told to pay it. Never a full number. */
export function DestinationSummaryView({
  summary,
  locale,
}: {
  readonly summary: PayoutDestinationSummary;
  readonly locale: Locale;
}) {
  const f = getWithdrawalMessages(locale).destinations.fields;
  const t = getWithdrawalMessages(locale).destinationTypes;
  const rows: Array<[string, ReactNode]> = [
    [f.type, t[summary.type] ?? summary.type],
    [f.beneficiaryName, <span dir="auto">{summary.beneficiaryName}</span>],
  ];
  if (summary.bankName !== null)
    rows.push([f.bankName, <span dir="auto">{summary.bankName}</span>]);
  if (summary.ibanMasked !== null)
    rows.push([f.iban, <span className="pc-ltr">{summary.ibanMasked}</span>]);
  if (summary.accountNumberMasked !== null) {
    rows.push([f.accountNumber, <span className="pc-ltr">{summary.accountNumberMasked}</span>]);
  }
  if (summary.mobileNumberMasked !== null) {
    rows.push([f.mobileNumber, <span className="pc-ltr">{summary.mobileNumberMasked}</span>]);
  }
  if (summary.currency !== null)
    rows.push([f.currency, <span className="pc-ltr">{summary.currency}</span>]);
  return (
    <dl className="pc-topup-summary">
      {rows.map(([label, value]) => (
        <div key={label}>
          <dt>{label}</dt>
          <dd>{value}</dd>
        </div>
      ))}
    </dl>
  );
}

export function WithdrawalTimeline({
  events,
  locale,
}: {
  readonly events: readonly WithdrawalEventView[];
  readonly locale: Locale;
}) {
  const messages = getWithdrawalMessages(locale);
  return (
    <ol className="pc-topup-timeline pc-withdrawal-timeline">
      {events.map((event) => (
        <li key={event.id} data-event={event.eventType}>
          <span className="pc-topup-timeline-label">
            {messages.events[event.eventType] ?? event.eventType}
            {event.actorDisplayName ? (
              <span className="pc-hint" dir="auto">
                {' '}
                · {event.actorDisplayName}
              </span>
            ) : null}
          </span>
          {event.note === null ? null : (
            <span className="pc-hint" dir="auto">
              {event.note}
            </span>
          )}
          <time className="pc-hint" dateTime={event.createdAt}>
            {new Date(event.createdAt).toLocaleString(locale)}
          </time>
        </li>
      ))}
    </ol>
  );
}

/**
 * Why the balance and the withdrawable amount differ, in plain terms
 * (policy 5). Every figure is one the API computed; nothing is summed here.
 */
export function WithdrawableBreakdown({
  view,
  locale,
}: {
  readonly view: UserWithdrawableView;
  readonly locale: Locale;
}) {
  const b = getWithdrawalMessages(locale).breakdown;
  const line = (label: string, amount: MoneyResponse, hint?: string, strong = false) => (
    <div className={strong ? 'pc-withdrawal-breakdown-total' : undefined}>
      <dt>
        {label}
        {hint === undefined ? null : <span className="pc-hint">{hint}</span>}
      </dt>
      <dd>
        <Amount amount={amount} locale={locale} />
      </dd>
    </div>
  );
  return (
    <section className="pc-card" aria-labelledby="withdrawable-breakdown">
      <h2 id="withdrawable-breakdown">{b.title}</h2>
      <p className="pc-hint">{b.intro}</p>
      <dl className="pc-withdrawal-breakdown" data-testid="withdrawable-breakdown">
        {line(b.cash, view.cashBalance)}
        {line(b.promotional, view.promotionalBalance, b.promotionalHint)}
        {line(b.reserved, view.reserved)}
        {line(b.reservedForWithdrawal, view.reservedForWithdrawal)}
        {line(b.clearing(String(view.clearingDays)), view.clearing)}
        {line(b.notWithdrawable, view.notWithdrawable, b.notWithdrawableHint)}
        {line(b.withdrawable, view.withdrawable, undefined, true)}
      </dl>
    </section>
  );
}

/** Funds per currency for an organization or PalCert. Never one cross-currency total. */
export function FundsTable({
  rows,
  locale,
  caption,
}: {
  readonly rows: readonly PayoutFundsRowView[];
  readonly locale: Locale;
  readonly caption: string;
}) {
  const c = getWithdrawalMessages(locale).organization.columns;
  return (
    <DataTable<PayoutFundsRowView>
      caption={caption}
      rows={rows}
      rowKey={(row) => row.currency}
      columns={[
        {
          key: 'currency',
          header: c.currency,
          primary: true,
          cell: (row) => <span className="pc-ltr">{row.currency}</span>,
        },
        {
          key: 'realized',
          header: c.realized,
          align: 'end',
          cell: (row) => <Amount amount={row.realized} locale={locale} />,
        },
        {
          key: 'clearing',
          header: c.clearing,
          align: 'end',
          cell: (row) => <Amount amount={row.clearing} locale={locale} />,
        },
        {
          key: 'reserved',
          header: c.reserved,
          align: 'end',
          cell: (row) => <Amount amount={row.reserved} locale={locale} />,
        },
        {
          key: 'paidOut',
          header: c.paidOut,
          align: 'end',
          cell: (row) => <Amount amount={row.paidOut} locale={locale} />,
        },
        {
          key: 'available',
          header: c.available,
          align: 'end',
          cell: (row) => (
            <strong>
              <Amount amount={row.available} locale={locale} />
            </strong>
          ),
        },
      ]}
    />
  );
}

/** A history of withdrawals, newest first, each linking to its own page. */
export function WithdrawalHistory({
  items,
  locale,
  hrefFor,
  caption,
}: {
  readonly items: readonly WithdrawalRequestView[];
  readonly locale: Locale;
  readonly hrefFor: (item: WithdrawalRequestView) => string;
  readonly caption: string;
}) {
  const h = getWithdrawalMessages(locale).history;
  if (items.length === 0) return <EmptyState icon="balance" title={h.empty} />;
  return (
    <DataTable<WithdrawalRequestView>
      caption={caption}
      rows={items}
      rowKey={(row) => row.id}
      columns={[
        {
          key: 'reference',
          header: h.columns.reference,
          primary: true,
          cell: (row) => (
            <Link className="pc-ltr" href={hrefFor(row)}>
              {row.reference}
            </Link>
          ),
        },
        {
          key: 'amount',
          header: h.columns.amount,
          align: 'end',
          cell: (row) => <Amount amount={row.amount} locale={locale} />,
        },
        {
          key: 'destination',
          header: h.columns.destination,
          cell: (row) => <span dir="auto">{destinationLine(row.destination, locale)}</span>,
        },
        {
          key: 'status',
          header: h.columns.status,
          cell: (row) => <WithdrawalStatusBadge status={row.status} locale={locale} />,
        },
        {
          key: 'requested',
          header: h.columns.requested,
          cell: (row) =>
            row.submittedAt === null ? (
              '—'
            ) : (
              <time dateTime={row.submittedAt}>
                {new Date(row.submittedAt).toLocaleDateString(locale)}
              </time>
            ),
        },
        {
          key: 'paid',
          header: h.columns.paid,
          cell: (row) =>
            row.executedAt === null ? (
              '—'
            ) : (
              <time dateTime={row.executedAt}>
                {new Date(row.executedAt).toLocaleDateString(locale)}
              </time>
            ),
        },
        {
          key: 'transfer',
          header: h.columns.transferReference,
          cell: (row) => <span className="pc-ltr">{row.externalTransferReference ?? '—'}</span>,
        },
      ]}
    />
  );
}

// ---------------------------------------------------------------------------
// Destinations
// ---------------------------------------------------------------------------

const EMPTY_INPUT: PayoutDestinationInput = {
  type: 'BANK_ACCOUNT',
  label: '',
  beneficiaryName: '',
  currency: null,
  bankName: null,
  iban: null,
  accountNumber: null,
  branch: null,
  mobileNumber: null,
  instructions: null,
};

/**
 * The form for one destination. Fields appear by type, so a mobile payment
 * app never asks for an IBAN; values are sent only to the API, which seals
 * them before anything is stored.
 */
function DestinationForm({
  locale,
  currencies,
  initial,
  submitLabel,
  onSubmit,
  onCancel,
}: {
  readonly locale: Locale;
  readonly currencies: readonly string[];
  readonly initial: PayoutDestinationInput;
  readonly submitLabel: string;
  readonly onSubmit: (input: PayoutDestinationInput) => Promise<void>;
  readonly onCancel: () => void;
}) {
  const messages = getWithdrawalMessages(locale);
  const d = messages.destinations;
  const prefix = useId();
  const [value, setValue] = useState<PayoutDestinationInput>(initial);
  const [failure, setFailure] = useState<string | null>(null);
  const [fieldIssues, setFieldIssues] = useState<Record<string, string>>({});
  const [pending, setPending] = useState(false);

  const set = (key: keyof PayoutDestinationInput, next: string) =>
    setValue((current) => ({ ...current, [key]: next === '' ? null : next }));

  const field = (
    key:
      | 'label'
      | 'beneficiaryName'
      | 'bankName'
      | 'iban'
      | 'accountNumber'
      | 'branch'
      | 'mobileNumber',
    maxLength: number,
    ltr = false,
  ) => (
    <div className="pc-field" key={key}>
      <label htmlFor={`${prefix}-${key}`}>{d.fields[key]}</label>
      <input
        id={`${prefix}-${key}`}
        name={key}
        autoComplete="off"
        maxLength={maxLength}
        dir={ltr ? 'ltr' : 'auto'}
        value={(value[key] as string | null) ?? ''}
        aria-invalid={fieldIssues[key] !== undefined}
        aria-describedby={fieldIssues[key] === undefined ? undefined : `${prefix}-${key}-issue`}
        onChange={(event) => set(key, event.target.value)}
      />
      {fieldIssues[key] === undefined ? null : (
        <span className="pc-field-error" id={`${prefix}-${key}-issue`}>
          {fieldIssues[key]}
        </span>
      )}
    </div>
  );

  return (
    <form
      className="pc-form pc-withdrawal-destination-form"
      onSubmit={(event) => {
        event.preventDefault();
        setPending(true);
        setFailure(null);
        setFieldIssues({});
        onSubmit(value)
          .catch((caught: unknown) => {
            setFailure(describeWithdrawalError(messages, caught).message);
            if (caught instanceof ApiError) {
              const issues = (
                caught.details as { issues?: Array<{ field: string; code: string }> } | undefined
              )?.issues;
              if (Array.isArray(issues)) {
                setFieldIssues(
                  Object.fromEntries(
                    issues.map((issue) => [issue.field, d.issues[issue.code] ?? issue.code]),
                  ),
                );
              }
            }
          })
          .finally(() => setPending(false));
      }}
    >
      <div className="pc-field">
        <label htmlFor={`${prefix}-type`}>{d.fields.type}</label>
        <select
          id={`${prefix}-type`}
          value={value.type}
          onChange={(event) =>
            setValue((current) => ({
              ...current,
              type: event.target.value as PayoutDestinationType,
            }))
          }
        >
          {PAYOUT_DESTINATION_TYPES.map((type) => (
            <option key={type} value={type}>
              {messages.destinationTypes[type] ?? type}
            </option>
          ))}
        </select>
        <span className="pc-hint">
          {value.type === 'BANK_ACCOUNT'
            ? d.fieldHints.bank
            : value.type === 'MOBILE_WALLET'
              ? d.fieldHints.mobile
              : d.fieldHints.other}
        </span>
      </div>
      {field('label', 80)}
      {field('beneficiaryName', 140)}
      {value.type === 'BANK_ACCOUNT' ? (
        <>
          {field('bankName', 120)}
          {field('iban', 64, true)}
          {field('accountNumber', 64, true)}
          {field('branch', 120)}
        </>
      ) : null}
      {value.type === 'MOBILE_WALLET' ? field('mobileNumber', 32, true) : null}
      <div className="pc-field">
        <label htmlFor={`${prefix}-currency`}>{d.fields.currency}</label>
        <select
          id={`${prefix}-currency`}
          value={value.currency ?? ''}
          onChange={(event) => set('currency', event.target.value)}
        >
          <option value="">{d.fields.anyCurrency}</option>
          {currencies.map((currency) => (
            <option key={currency} value={currency}>
              {currency}
            </option>
          ))}
        </select>
      </div>
      <div className="pc-field">
        <label htmlFor={`${prefix}-instructions`}>{d.fields.instructions}</label>
        <textarea
          id={`${prefix}-instructions`}
          rows={3}
          maxLength={500}
          dir="auto"
          value={value.instructions ?? ''}
          aria-invalid={fieldIssues['instructions'] !== undefined}
          onChange={(event) => set('instructions', event.target.value)}
        />
        {fieldIssues['instructions'] === undefined ? null : (
          <span className="pc-field-error">{fieldIssues['instructions']}</span>
        )}
      </div>
      <p className="pc-hint">{d.encryptedHint}</p>
      {failure === null ? null : (
        <p className="pc-error" role="alert">
          {failure}
        </p>
      )}
      <div className="pc-actions">
        <button type="submit" className="pc-btn pc-btn-primary" disabled={pending}>
          {pending ? messages.confirm.pending : submitLabel}
        </button>
        <button type="button" className="pc-btn pc-btn-secondary" onClick={onCancel}>
          {messages.confirm.cancel}
        </button>
      </div>
    </form>
  );
}

/** List, add, edit and archive one beneficiary's payout destinations. */
export function DestinationManager({
  api,
  locale,
  title,
  canManage,
  currencies,
  onChange,
}: {
  readonly api: PayoutScopeApi;
  readonly locale: Locale;
  readonly title: string;
  readonly canManage: boolean;
  readonly currencies: readonly string[];
  readonly onChange?: (destinations: PayoutDestinationView[]) => void;
}) {
  const messages = getWithdrawalMessages(locale);
  const d = messages.destinations;
  const [rows, setRows] = useState<PayoutDestinationView[] | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [editing, setEditing] = useState<'new' | PayoutDestinationView | null>(null);

  async function reload(): Promise<void> {
    try {
      const next = await api.destinations();
      setRows(next);
      onChange?.(next);
    } catch (caught) {
      setFailure(describeWithdrawalError(messages, caught).message);
    }
  }

  useEffect(() => {
    void reload();
  }, [api]);

  return (
    <section className="pc-card" aria-labelledby="payout-destinations">
      <div className="pc-section-heading">
        <h2 id="payout-destinations">{title}</h2>
        {canManage && editing === null ? (
          <button
            type="button"
            className="pc-btn pc-btn-secondary pc-btn-sm"
            onClick={() => setEditing('new')}
          >
            {d.add}
          </button>
        ) : null}
      </div>
      <p className="pc-hint">{d.intro}</p>
      <p className="pc-hint">{d.snapshotNote}</p>
      {failure === null ? null : (
        <p className="pc-error" role="alert">
          {failure}
        </p>
      )}
      {editing === null ? null : (
        <DestinationForm
          locale={locale}
          currencies={currencies}
          initial={
            editing === 'new'
              ? EMPTY_INPUT
              : {
                  // The saved details are never sent back to the browser;
                  // editing replaces them, starting from the visible names.
                  ...EMPTY_INPUT,
                  type: editing.type,
                  label: editing.label,
                  beneficiaryName: editing.beneficiaryName,
                  currency: editing.currency,
                  bankName: editing.bankName,
                }
          }
          submitLabel={editing === 'new' ? d.add : d.save}
          onCancel={() => setEditing(null)}
          onSubmit={async (input) => {
            if (editing === 'new') await api.createDestination(input);
            else await api.updateDestination(editing.id, input, editing.version);
            setEditing(null);
            await reload();
          }}
        />
      )}
      {rows === null ? (
        failure === null ? (
          <LoadingState label={messages.loading} />
        ) : null
      ) : rows.length === 0 ? (
        <p className="pc-hint">{d.empty}</p>
      ) : (
        <ul className="pc-withdrawal-destinations" role="list">
          {rows.map((row) => (
            <li key={row.id} className="pc-withdrawal-destination">
              <div>
                <strong dir="auto">{row.label}</strong>
                <div className="pc-hint" dir="auto">
                  {destinationDetail(row, locale)}
                </div>
                {row.archivedAt === null ? null : <span className="pc-hint"> · {d.archived}</span>}
              </div>
              {canManage && row.archivedAt === null ? (
                <div className="pc-actions">
                  <button
                    type="button"
                    className="pc-btn pc-btn-quiet pc-btn-sm"
                    onClick={() => setEditing(row)}
                  >
                    {d.edit}
                  </button>
                  <ConfirmAction
                    labels={messages.confirm}
                    describeError={(caught) => describeWithdrawalError(messages, caught)}
                    label={d.archive}
                    title={d.archiveTitle}
                    intro={d.archiveBody}
                    danger
                    buttonClassName="pc-btn pc-btn-quiet pc-btn-sm"
                    onConfirm={async () => {
                      await api.archiveDestination(row.id, row.version);
                      await reload();
                    }}
                  />
                </div>
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

// ---------------------------------------------------------------------------
// Requesting
// ---------------------------------------------------------------------------

/**
 * Amount, destination, note, then a confirmation that says exactly what
 * will be reserved and where it will go. The server recalculates and is the
 * only judge; the client check only spares an obviously refused request.
 */
export function WithdrawalRequestForm({
  api,
  locale,
  currency,
  available,
  minimum,
  maximum,
  destinations,
  destinationsHref,
  onSubmitted,
}: {
  readonly api: PayoutScopeApi;
  readonly locale: Locale;
  readonly currency: string;
  readonly available: MoneyResponse;
  readonly minimum: MoneyResponse | null;
  readonly maximum: MoneyResponse | null;
  readonly destinations: readonly PayoutDestinationView[];
  readonly destinationsHref?: string;
  readonly onSubmitted: (request: WithdrawalRequestView) => void;
}) {
  const messages = getWithdrawalMessages(locale);
  const f = messages.form;
  const prefix = useId();
  const usable = destinations.filter(
    (destination) =>
      destination.archivedAt === null &&
      (destination.currency === null || destination.currency === currency),
  );
  const [amount, setAmount] = useState('');
  const [destinationId, setDestinationId] = useState('');
  const [note, setNote] = useState('');
  const [issue, setIssue] = useState<string | null>(null);
  const idempotency = useIdempotencyKey();

  useEffect(() => {
    if (destinationId === '' && usable.length > 0) setDestinationId(usable[0]!.id);
  }, [usable, destinationId]);

  const minor = withdrawalAmountToMinor(amount, currency);
  const chosen = usable.find((destination) => destination.id === destinationId) ?? null;
  const limitText =
    minimum !== null && maximum !== null
      ? f.limits(formatMoney(minimum, locale), formatMoney(maximum, locale))
      : minimum !== null
        ? f.minimumOnly(formatMoney(minimum, locale))
        : maximum !== null
          ? f.maximumOnly(formatMoney(maximum, locale))
          : null;
  const nothing = BigInt(available.minorUnits) <= 0n;

  function check(): string | null {
    if (minor === null || minor <= 0n) return f.invalidAmount;
    if (minor > BigInt(available.minorUnits)) return f.aboveWithdrawable;
    return null;
  }

  return (
    <section className="pc-card" aria-labelledby="request-withdrawal">
      <h2 id="request-withdrawal">{f.title}</h2>
      <p className="pc-hint">{f.intro}</p>
      {nothing ? <p className="pc-alert pc-alert-info">{f.nothingToWithdraw}</p> : null}
      {usable.length === 0 ? (
        <p className="pc-alert pc-alert-warning">
          {f.noDestination}{' '}
          {destinationsHref === undefined ? null : (
            <Link href={destinationsHref}>{f.addDestination}</Link>
          )}
        </p>
      ) : null}
      <div className="pc-form">
        <div className="pc-field">
          <label htmlFor={`${prefix}-amount`}>
            {f.amount} <span className="pc-ltr">({currency})</span>
          </label>
          <input
            id={`${prefix}-amount`}
            inputMode="decimal"
            autoComplete="off"
            dir="ltr"
            value={amount}
            disabled={nothing}
            aria-invalid={issue !== null}
            aria-describedby={`${prefix}-amount-hint`}
            onChange={(event) => {
              setAmount(event.target.value);
              setIssue(null);
            }}
          />
          <span className="pc-hint" id={`${prefix}-amount-hint`}>
            {f.amountHint(formatMoney(available, locale))} {limitText ?? ''} {f.feeNone}
          </span>
          {issue === null ? null : (
            <span className="pc-field-error" role="alert">
              {issue}
            </span>
          )}
        </div>
        <div className="pc-field">
          <label htmlFor={`${prefix}-destination`}>{f.destination}</label>
          <select
            id={`${prefix}-destination`}
            value={destinationId}
            disabled={usable.length === 0}
            onChange={(event) => setDestinationId(event.target.value)}
          >
            {usable.length === 0 ? <option value="">{f.chooseDestination}</option> : null}
            {usable.map((destination) => (
              <option key={destination.id} value={destination.id}>
                {destinationLine(destination, locale)}
              </option>
            ))}
          </select>
          {destinationsHref === undefined ? null : (
            <Link className="pc-hint" href={destinationsHref}>
              {f.manageDestinations}
            </Link>
          )}
        </div>
        <div className="pc-field">
          <label htmlFor={`${prefix}-note`}>{f.note}</label>
          <textarea
            id={`${prefix}-note`}
            rows={2}
            maxLength={500}
            dir="auto"
            value={note}
            onChange={(event) => setNote(event.target.value)}
          />
          <span className="pc-hint">{f.noteHint}</span>
        </div>
        <div className="pc-actions">
          <ConfirmAction
            labels={messages.confirm}
            describeError={(caught) => describeWithdrawalError(messages, caught)}
            label={f.review}
            title={f.confirmTitle}
            intro={
              minor === null || chosen === null
                ? ''
                : f.confirmBody(
                    formatMoney({ currency, minorUnits: minor.toString() }, locale),
                    destinationLine(chosen, locale),
                  )
            }
            confirmLabel={f.submit}
            disabled={nothing || usable.length === 0}
            buttonClassName="pc-btn pc-btn-primary"
            onConfirm={async () => {
              const problem = check();
              if (problem !== null) {
                setIssue(problem);
                throw new Error(problem);
              }
              const body = {
                currency,
                amountMinorUnits: minor!.toString(),
                destinationId,
                ...(note.trim() === '' ? {} : { note: note.trim() }),
              };
              const created = await api.submit(
                body,
                idempotency.keyFor(`${currency}:${body.amountMinorUnits}:${destinationId}`),
              );
              idempotency.reset();
              setAmount('');
              setNote('');
              onSubmitted(created);
            }}
          />
        </div>
      </div>
    </section>
  );
}

/** "50.00" from minor units, for prefilling an amount field. */
export function decimalOf(amount: MoneyResponse): string {
  return toDecimalString(amount.minorUnits, amount.currency);
}

// ---------------------------------------------------------------------------
// One request, as its requester sees it
// ---------------------------------------------------------------------------

export function RequesterDetail({
  request,
  locale,
  backHref,
  onCancel,
  onViewProof,
}: {
  readonly request: WithdrawalRequestView;
  readonly locale: Locale;
  readonly backHref: string;
  readonly onCancel: () => Promise<void>;
  readonly onViewProof: () => Promise<void>;
}) {
  const messages = getWithdrawalMessages(locale);
  const d = messages.detail;
  const hint = d.hints[request.status];
  return (
    <div className="pc-detail-grid">
      <div className="pc-detail-main">
        <section className="pc-card" aria-labelledby="withdrawal-summary">
          <div className="pc-section-heading">
            <h2 id="withdrawal-summary">{d.summary}</h2>
            <WithdrawalStatusBadge status={request.status} locale={locale} />
          </div>
          {hint === undefined ? null : <p className="pc-hint">{hint}</p>}
          <dl className="pc-topup-summary">
            <div>
              <dt>{d.reference}</dt>
              <dd className="pc-ltr">{request.reference}</dd>
            </div>
            <div>
              <dt>{d.amount}</dt>
              <dd className="pc-topup-amount-strong">
                <Amount amount={request.amount} locale={locale} />
              </dd>
            </div>
            <div>
              <dt>{d.scope}</dt>
              <dd>
                {messages.scopes[request.scope]}
                {request.organizationName === null ? null : (
                  <span dir="auto"> — {request.organizationName}</span>
                )}
              </dd>
            </div>
            {request.submittedAt === null ? null : (
              <div>
                <dt>{d.requestedAt}</dt>
                <dd>
                  <time dateTime={request.submittedAt}>
                    {new Date(request.submittedAt).toLocaleString(locale)}
                  </time>
                </dd>
              </div>
            )}
            {request.executedAt === null ? null : (
              <div>
                <dt>{d.paidAt}</dt>
                <dd>
                  <time dateTime={request.executedAt}>
                    {new Date(request.executedAt).toLocaleString(locale)}
                  </time>
                </dd>
              </div>
            )}
            {request.externalTransferReference === null ? null : (
              <div>
                <dt>{d.transferReference}</dt>
                <dd className="pc-ltr">{request.externalTransferReference}</dd>
              </div>
            )}
            {request.requesterNote === null ? null : (
              <div>
                <dt>{d.note}</dt>
                <dd dir="auto">{request.requesterNote}</dd>
              </div>
            )}
          </dl>
          {request.status === 'REJECTED' && request.rejectionReason !== null ? (
            <div className="pc-alert pc-alert-warning">
              <strong>
                {d.rejection}: {messages.rejectionReasons[request.rejectionReason]}
              </strong>
              {request.rejectionNote === null ? null : <p dir="auto">{request.rejectionNote}</p>}
            </div>
          ) : null}
          <div className="pc-actions">
            {request.cancellable ? (
              <ConfirmAction
                labels={messages.confirm}
                describeError={(caught) => describeWithdrawalError(messages, caught)}
                label={d.cancel}
                title={d.cancelTitle}
                intro={d.cancelBody}
                confirmLabel={d.cancelConfirm}
                danger
                buttonClassName="pc-btn pc-btn-secondary"
                onConfirm={onCancel}
              />
            ) : null}
            {request.hasProof ? (
              <button
                type="button"
                className="pc-btn pc-btn-secondary"
                onClick={() => void onViewProof()}
              >
                {d.viewProof}
              </button>
            ) : null}
            <Link className="pc-btn pc-btn-quiet" href={backHref}>
              {d.back}
            </Link>
          </div>
        </section>
      </div>
      <aside className="pc-detail-side">
        <section className="pc-card" aria-labelledby="withdrawal-destination">
          <h2 id="withdrawal-destination">{d.destination}</h2>
          <p className="pc-hint">{d.snapshotHint}</p>
          <DestinationSummaryView summary={request.destination} locale={locale} />
        </section>
        <section className="pc-card" aria-labelledby="withdrawal-history">
          <h2 id="withdrawal-history">{d.timeline}</h2>
          <WithdrawalTimeline events={request.events} locale={locale} />
        </section>
      </aside>
    </div>
  );
}

/**
 * The balance page's withdrawal card (spec §29, policy 4): withdrawable and
 * reserved-for-withdrawal figures, the way in, and — beside it — why card
 * money is refunded rather than withdrawn.
 */
export function WithdrawCard({
  currency,
  locale,
}: {
  readonly currency: string;
  readonly locale: Locale;
}) {
  const messages = getWithdrawalMessages(locale);
  const c = messages.balanceCard;
  const [view, setView] = useState<UserWithdrawableView | null>(null);

  useEffect(() => {
    let live = true;
    userWithdrawalsApi
      .withdrawable(currency)
      .then((value) => {
        if (live) setView(value);
      })
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [currency]);

  return (
    <section className="pc-card" aria-labelledby="withdraw-card" data-testid="withdraw-card">
      <h2 id="withdraw-card">{c.title}</h2>
      {view === null ? null : (
        <dl className="pc-topup-summary">
          <div>
            <dt>{c.withdrawable}</dt>
            <dd className="pc-topup-amount-strong">
              <Amount amount={view.withdrawable} locale={locale} />
            </dd>
          </div>
          <div>
            <dt>{c.reservedForWithdrawal}</dt>
            <dd>
              <Amount amount={view.reservedForWithdrawal} locale={locale} />
            </dd>
          </div>
        </dl>
      )}
      <div className="pc-actions">
        <Link className="pc-btn pc-btn-primary pc-btn-sm" href={`/${locale}/balance/withdraw`}>
          {c.action}
        </Link>
        <Link className="pc-btn pc-btn-quiet pc-btn-sm" href={`/${locale}/balance/withdrawals`}>
          {c.history}
        </Link>
      </div>
      <h3>{c.refundTitle}</h3>
      <p className="pc-hint">{c.refundBody}</p>
    </section>
  );
}
