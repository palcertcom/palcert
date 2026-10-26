'use client';

import type {
  ManualPaymentMethodSnapshot,
  ManualPaymentMethodView,
  ManualTopUpEventView,
  ManualTopUpStatus,
} from '@palcert/contracts/finance/manual-topups';
import { useState } from 'react';
import { StatusBadge } from '@/components/ui/status-badge';
import type { Locale } from '@/i18n/locales';
import { getManualTopUpMessages, type ManualTopUpMessages } from '@/i18n/manual-topup-messages';
import { ApiError, type MoneyResponse } from '@/lib/api-client';
import { formatMoney } from '@/lib/money';

/** What a failed call should say, and whether the way out is to sign in again. */
export function describeTopUpError(
  messages: ManualTopUpMessages,
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

export function TopUpStatusBadge({
  status,
  locale,
  audience = 'customer',
}: {
  readonly status: ManualTopUpStatus;
  readonly locale: Locale;
  /** Finance pages name the state for staff; the customer wording says "your balance". */
  readonly audience?: 'customer' | 'staff';
}) {
  const messages = getManualTopUpMessages(locale);
  const labels = audience === 'staff' ? messages.staffStatuses : messages.statuses;
  return (
    <StatusBadge
      label={labels[status] ?? status}
      status={status === 'DRAFT' ? 'DRAFT' : status}
      title={audience === 'staff' ? undefined : messages.statusHints[status]}
    />
  );
}

export function TopUpAmount({ amount, locale }: { amount: MoneyResponse; locale: Locale }) {
  return (
    <span className="pc-ltr" data-minor-units={amount.minorUnits} data-currency={amount.currency}>
      {formatMoney(amount, locale)}
    </span>
  );
}

type Named = Pick<ManualPaymentMethodView, 'nameEn' | 'nameAr'>;

export function methodName(method: Named, locale: Locale): string {
  return locale === 'ar' ? method.nameAr : method.nameEn;
}

/** A method's logo, or its initials when it has none (or it has not been scanned yet). */
export function MethodMark({
  method,
  locale,
  size = 40,
}: {
  readonly method: Named & { readonly logoUrl?: string | null };
  readonly locale: Locale;
  readonly size?: number;
}) {
  const name = methodName(method, locale);
  if (method.logoUrl) {
    return (
      // A short-lived signed URL to a scanned raster image; not a Next asset.
      <img
        className="pc-topup-mark"
        src={method.logoUrl}
        alt=""
        width={size}
        height={size}
        decoding="async"
        draggable={false}
      />
    );
  }
  const initials = name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((word) => [...word][0])
    .join('');
  return (
    <span
      className="pc-topup-mark pc-topup-mark-initials"
      aria-hidden="true"
      style={{ width: size, height: size }}
    >
      {initials}
    </span>
  );
}

function CopyButton({ value, label, locale }: { value: string; label: string; locale: Locale }) {
  const messages = getManualTopUpMessages(locale);
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      className="pc-btn pc-btn-secondary pc-btn-sm pc-topup-copy"
      aria-label={messages.destination.copyLabel(label)}
      onClick={() => {
        void navigator.clipboard
          ?.writeText(value)
          .then(() => {
            setCopied(true);
            window.setTimeout(() => setCopied(false), 2000);
          })
          .catch(() => setCopied(false));
      }}
    >
      {copied ? messages.destination.copied : messages.destination.copy}
      <span className="pc-visually-hidden" role="status" aria-live="polite">
        {copied ? messages.destination.copied : ''}
      </span>
    </button>
  );
}

type Destination = Pick<
  ManualPaymentMethodSnapshot,
  | 'type'
  | 'currency'
  | 'recipientName'
  | 'mobileNumber'
  | 'iban'
  | 'bankName'
  | 'accountNumber'
  | 'branchName'
  | 'instructionsEn'
  | 'instructionsAr'
>;

/**
 * Where to send the money, with a copy button beside everything a person
 * would otherwise retype. Numbers and IBANs are always laid out left to right,
 * in either locale, because that is how a bank app shows them.
 */
export function DestinationDetails({
  destination,
  locale,
  copyable = true,
  limits,
}: {
  readonly destination: Destination;
  readonly locale: Locale;
  readonly copyable?: boolean;
  readonly limits?: { min: MoneyResponse; max: MoneyResponse };
}) {
  const messages = getManualTopUpMessages(locale);
  const d = messages.destination;
  const rows: Array<{ key: string; label: string; value: string | null; ltr: boolean }> = [
    { key: 'recipient', label: d.recipientName, value: destination.recipientName, ltr: false },
    { key: 'mobile', label: d.mobileNumber, value: destination.mobileNumber, ltr: true },
    { key: 'bank', label: d.bankName, value: destination.bankName, ltr: false },
    { key: 'iban', label: d.iban, value: destination.iban, ltr: true },
    { key: 'account', label: d.accountNumber, value: destination.accountNumber, ltr: true },
    { key: 'branch', label: d.branchName, value: destination.branchName, ltr: false },
    { key: 'currency', label: d.currency, value: destination.currency, ltr: true },
  ];
  const instructions = locale === 'ar' ? destination.instructionsAr : destination.instructionsEn;
  return (
    <div className="pc-topup-destination">
      <dl className="pc-topup-fields">
        {rows
          .filter((row) => row.value !== null && row.value !== '')
          .map((row) => (
            <div key={row.key} className="pc-topup-field">
              <dt>{row.label}</dt>
              <dd>
                <span
                  className={row.ltr ? 'pc-ltr pc-topup-value' : 'pc-topup-value'}
                  dir={row.ltr ? 'ltr' : undefined}
                >
                  {row.value}
                </span>
                {copyable && row.key !== 'currency' ? (
                  <CopyButton value={row.value!} label={row.label} locale={locale} />
                ) : null}
              </dd>
            </div>
          ))}
      </dl>
      {limits === undefined ? null : (
        <p className="pc-hint">
          {d.limits(formatMoney(limits.min, locale), formatMoney(limits.max, locale))}
        </p>
      )}
      {instructions === null || instructions === '' ? null : (
        <div className="pc-topup-instructions">
          <h3>{d.instructions}</h3>
          <p>{instructions}</p>
        </div>
      )}
    </div>
  );
}

export function TopUpTimeline({
  events,
  locale,
}: {
  readonly events: readonly (ManualTopUpEventView & { actorDisplayName?: string | null })[];
  readonly locale: Locale;
}) {
  const messages = getManualTopUpMessages(locale);
  return (
    <ol className="pc-topup-timeline">
      {events.map((event) => (
        <li key={event.id} data-event={event.eventType}>
          <span className="pc-topup-timeline-label">
            {messages.events[event.eventType] ?? event.eventType}
            {event.actorDisplayName ? (
              <span className="pc-hint"> · {event.actorDisplayName}</span>
            ) : null}
          </span>
          <time className="pc-hint" dateTime={event.createdAt}>
            {new Date(event.createdAt).toLocaleString(locale)}
          </time>
        </li>
      ))}
    </ol>
  );
}
