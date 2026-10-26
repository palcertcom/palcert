'use client';

import { useCallback, useEffect, useState } from 'react';
import { getBillingMessages } from '@/i18n/billing-messages';
import type { Locale } from '@/i18n/locales';
import { getSmartFixMessages } from '@/i18n/smartfix-messages';
import {
  ApiError,
  balanceApi,
  smartFixApi,
  type MoneyResponse,
  type PriceQuoteResponse,
  type SmartFixManifestResponse,
  type SmartFixPlanResponse,
  type SmartFixRequestResponse,
} from '@/lib/api-client';
import { formatMoney } from '@/lib/money';

/** The slice of the client these components use, so a test can supply its own. */
export type SmartFixApi = {
  readonly plan: typeof smartFixApi.plan;
  readonly start: typeof smartFixApi.start;
  readonly cancel: typeof smartFixApi.cancel;
  readonly quote: typeof balanceApi.quote;
  readonly balance: typeof balanceApi.balance;
};

const DEFAULT_API: SmartFixApi = {
  plan: smartFixApi.plan,
  start: smartFixApi.start,
  cancel: smartFixApi.cancel,
  quote: balanceApi.quote,
  balance: balanceApi.balance,
};

const IN_FLIGHT = ['RESERVED', 'PROCESSING', 'RECHECKING', 'VALIDATING'];

function describe(caught: unknown, locale: Locale): string {
  const messages = getSmartFixMessages(locale);
  return caught instanceof ApiError
    ? (messages.errors[caught.code] ?? caught.message)
    : 'Something went wrong. Please try again.';
}

function atLeast(money: MoneyResponse, other: MoneyResponse): boolean {
  return BigInt(money.minorUnits) >= BigInt(other.minorUnits);
}

/**
 * The correction plan, shown before anything is bought (Phase 12 §113, §185).
 *
 * Every rule the plan would correct **and** every rule it would not, each with
 * the reason. Showing only the first list would let somebody buy a correction
 * believing it addresses their whole report.
 */
export function SmartFixPlanPanel({
  checkId,
  locale,
  api = DEFAULT_API,
  onPlanned,
}: {
  checkId: string;
  locale: Locale;
  api?: SmartFixApi;
  onPlanned?: (plan: SmartFixPlanResponse) => void;
}): React.JSX.Element {
  const messages = getSmartFixMessages(locale);
  const [plan, setPlan] = useState<SmartFixPlanResponse | null>(null);
  const [planning, setPlanning] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const makePlan = useCallback(async () => {
    setPlanning(true);
    setError(null);
    try {
      const created = await api.plan(checkId);
      setPlan(created);
      onPlanned?.(created);
    } catch (caught) {
      setError(describe(caught, locale));
    } finally {
      setPlanning(false);
    }
  }, [api, checkId, locale, onPlanned]);

  if (plan === null) {
    return (
      <section aria-label={messages.title}>
        <h2>{messages.title}</h2>
        <p>{messages.intro}</p>
        <p>{messages.originalSafe}</p>
        {error !== null && <p role="alert">{error}</p>}
        <button type="button" onClick={() => void makePlan()} disabled={planning}>
          {planning ? messages.planning : messages.planTitle}
        </button>
        <p>{messages.planFree}</p>
      </section>
    );
  }

  if (plan.refusalCode !== null) {
    // A refused document is the one case where the user can act immediately,
    // so the message says how rather than merely saying no.
    return (
      <section aria-label={messages.title}>
        <h2>{messages.title}</h2>
        <p role="status">
          {messages.refusals[plan.refusalCode] ?? messages.errors.SMARTFIX_NOT_AVAILABLE}
        </p>
        <p>{messages.originalSafe}</p>
      </section>
    );
  }

  const fixable = plan.rules.filter(
    (rule) => rule.fixability === 'FIXABLE' || rule.fixability === 'PARTIALLY_FIXABLE',
  );
  const manual = plan.rules.filter((rule) => !fixable.includes(rule));

  return (
    <section aria-label={messages.planTitle}>
      <h2>{messages.planTitle}</h2>
      <p>{messages.planIntro}</p>
      <p>{messages.originalSafe}</p>
      <p>
        {messages.planExpires} <time dateTime={plan.expiresAt}>{plan.expiresAt}</time>
      </p>

      {plan.actionCount === 0 ? (
        <p role="status">{messages.nothingToCorrect}</p>
      ) : (
        <p>
          {messages.willFix(fixable.length)} · {messages.changeCount(plan.actionCount)}
        </p>
      )}

      {fixable.length > 0 && (
        <ul aria-label={messages.willFix(fixable.length)}>
          {fixable.map((rule) => (
            <li key={rule.ruleCode}>
              <span>{rule.ruleCode}</span>
              <span>{messages.fixability[rule.fixability] ?? rule.fixability}</span>
              <span>{messages.changeCount(rule.fixableTargetCount)}</span>
            </li>
          ))}
        </ul>
      )}

      {manual.length > 0 && (
        <>
          <h3>{messages.willNotFix(manual.length)}</h3>
          <ul aria-label={messages.willNotFix(manual.length)}>
            {manual.map((rule) => (
              <li key={rule.ruleCode}>
                <span>{rule.ruleCode}</span>
                <span>{messages.fixability[rule.fixability] ?? rule.fixability}</span>
                {rule.reasonCode !== null && <span>{messages.reasons[rule.reasonCode] ?? ''}</span>}
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
}

/**
 * The price confirmation before a correction is bought (§114).
 *
 * The same three sentences the check screen insists on — what is reserved,
 * that a charge happens only on delivery, that a failure releases it — because
 * a customer should not have to learn two different billing vocabularies for
 * two PalCert services.
 */
export function SmartFixPurchasePanel({
  plan,
  locale,
  api = DEFAULT_API,
  onStarted,
}: {
  plan: SmartFixPlanResponse;
  locale: Locale;
  api?: SmartFixApi;
  onStarted?: (request: SmartFixRequestResponse) => void;
}): React.JSX.Element {
  const messages = getSmartFixMessages(locale);
  const billing = getBillingMessages(locale);
  const [quote, setQuote] = useState<PriceQuoteResponse | null>(null);
  const [available, setAvailable] = useState<MoneyResponse | null>(null);
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const priced = await api.quote('SMARTFIX');
        if (cancelled) return;
        setQuote(priced);
        const balance = await api.balance(priced.amount.currency);
        if (!cancelled) setAvailable(balance.available);
      } catch (caught) {
        if (!cancelled) setError(describe(caught, locale));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [api, locale]);

  const start = useCallback(async () => {
    if (quote === null) return;
    setStarting(true);
    setError(null);
    try {
      const created = await api.start(plan.id, quote.id);
      onStarted?.(created);
    } catch (caught) {
      setError(describe(caught, locale));
    } finally {
      setStarting(false);
    }
  }, [api, locale, onStarted, plan.id, quote]);

  if (quote === null) {
    return (
      <section aria-label={messages.startTitle}>
        {error !== null && <p role="alert">{error}</p>}
      </section>
    );
  }

  const price = formatMoney(quote.amount, locale);
  const short = available !== null && !atLeast(available, quote.amount);

  return (
    <section aria-label={messages.startTitle}>
      <h3>{messages.startTitle}</h3>
      <p>
        {billing.price}: {price}
      </p>
      <p>{billing.willReserve(price)}</p>
      <p>{billing.chargedOnDelivery}</p>
      <p>{billing.releasedIfIncomplete}</p>
      <p>{messages.startHint}</p>

      {short && (
        <p role="alert">
          {messages.errors.INSUFFICIENT_BALANCE} {billing.required}: {price} · {billing.available}:{' '}
          {available === null ? '' : formatMoney(available, locale)}
        </p>
      )}
      {error !== null && <p role="alert">{error}</p>}

      <button type="button" onClick={() => void start()} disabled={starting || short}>
        {starting ? messages.starting : messages.start}
      </button>
    </section>
  );
}

/**
 * A correction in flight, and what happened to it (§115, §189).
 *
 * The status never says "Corrected" until it is delivered, and the delivered
 * view never claims the document now complies — only that the listed
 * formatting was corrected.
 */
export function SmartFixStatusPanel({
  request,
  locale,
  api = DEFAULT_API,
  onCancelled,
}: {
  request: SmartFixRequestResponse;
  locale: Locale;
  api?: SmartFixApi;
  onCancelled?: (request: SmartFixRequestResponse) => void;
}): React.JSX.Element {
  const messages = getSmartFixMessages(locale);
  const [cancelling, setCancelling] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const cancel = useCallback(async () => {
    setCancelling(true);
    setError(null);
    try {
      // Called on its own line, never inside `onCancelled?.(…)`: optional
      // chaining does not evaluate its argument when the callback is absent,
      // so the cancellation would silently not happen for any caller that
      // does not pass one.
      const cancelled = await api.cancel(request.id);
      onCancelled?.(cancelled);
    } catch (caught) {
      setError(describe(caught, locale));
    } finally {
      setCancelling(false);
    }
  }, [api, locale, onCancelled, request.id]);

  const inFlight = IN_FLIGHT.includes(request.status);
  const cancellable = ['RESERVED', 'PROCESSING', 'RECHECKING'].includes(request.status);

  return (
    <section aria-label={messages.title}>
      <p role="status">{messages.statuses[request.status] ?? request.status}</p>
      <p>{messages.statusHints[request.status] ?? ''}</p>

      {request.failureCode !== null && (
        <p role="alert">{messages.failureCodes[request.failureCode] ?? request.failureCode}</p>
      )}

      {request.status === 'DELIVERED' && (
        <>
          <h3>{messages.deliveredTitle}</h3>
          <p>{messages.deliveredHint}</p>
          {/* Never "your document now complies": SmartFix corrected the
              formatting it listed, and the rest of the report still stands. */}
          <p>{messages.stillFailing}</p>
          {request.correctedDocumentVersionId !== null && (
            <a href={`/documents/versions/${request.correctedDocumentVersionId}`}>
              {messages.openCorrected}
            </a>
          )}
          {request.recheckCheckId !== null && (
            <a href={`/checks/${request.recheckCheckId}`}>{messages.openRecheck}</a>
          )}
        </>
      )}

      {error !== null && <p role="alert">{error}</p>}

      {inFlight && cancellable && (
        <>
          <button type="button" onClick={() => void cancel()} disabled={cancelling}>
            {cancelling ? messages.cancelling : messages.cancel}
          </button>
          <p>{messages.cancelHint}</p>
        </>
      )}
    </section>
  );
}

/**
 * What the correction actually changed, and what it did not (§111, §116).
 *
 * The four integrity proofs are shown as the one question a person has —
 * "did you touch my writing?" — rather than as eight digests.
 */
export function SmartFixManifestPanel({
  manifest,
  locale,
}: {
  manifest: SmartFixManifestResponse;
  locale: Locale;
}): React.JSX.Element {
  const messages = getSmartFixMessages(locale);
  const proofs = [
    [messages.proofText, manifest.textUnchanged],
    [messages.proofMedia, manifest.mediaUnchanged],
    [messages.proofFields, manifest.fieldsUnchanged],
    [messages.proofRelationships, manifest.relationshipsUnchanged],
  ] as const;

  return (
    <section aria-label={messages.manifestTitle}>
      <h3>{messages.manifestTitle}</h3>
      <p>{messages.manifestIntro}</p>

      {manifest.entries.length === 0 ? (
        <p role="status">{messages.manifestEmpty}</p>
      ) : (
        <table>
          <thead>
            <tr>
              <th scope="col">{messages.columnRule}</th>
              <th scope="col">{messages.columnWhere}</th>
              <th scope="col">{messages.columnBefore}</th>
              <th scope="col">{messages.columnAfter}</th>
            </tr>
          </thead>
          <tbody>
            {manifest.entries.map((entry) => (
              <tr key={entry.actionId}>
                <td>{entry.ruleCode}</td>
                <td>{entry.nodeId}</td>
                <td>{renderValue(entry.before, messages.notSet)}</td>
                <td>{renderValue(entry.after, messages.notSet)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <h3>{messages.proofTitle}</h3>
      <ul aria-label={messages.proofTitle}>
        {proofs.map(([label, held]) => (
          <li key={label}>
            <span>{label}</span>
            <span>{held ? messages.proofHeld : messages.proofBroken}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}

function renderValue(
  value:
    { kind: string; number?: string; text?: string; flag?: boolean; unit?: string } | undefined,
  notSet: string,
): string {
  if (value === undefined) return notSet;
  if (value.kind === 'NUMBER') {
    return value.unit === undefined ? (value.number ?? notSet) : `${value.number} ${value.unit}`;
  }
  if (value.kind === 'BOOLEAN') return value.flag === true ? 'on' : 'off';
  return value.text ?? notSet;
}

/**
 * SmartFix, from the check report (§112).
 *
 * One section that walks the whole decision: plan for free, read the complete
 * list, buy it, watch it, and see what changed. It is deliberately placed
 * *after* the findings — a correction is something a person decides on once
 * they have read what is wrong, not a button that pre-empts reading.
 */
export function SmartFixSection({
  checkId,
  locale,
  api = DEFAULT_API,
  manifestFor = smartFixApi.manifest,
  requestsFor = smartFixApi.forCheck,
}: {
  checkId: string;
  locale: Locale;
  api?: SmartFixApi;
  manifestFor?: typeof smartFixApi.manifest;
  requestsFor?: typeof smartFixApi.forCheck;
}): React.JSX.Element {
  const [plan, setPlan] = useState<SmartFixPlanResponse | null>(null);
  const [request, setRequest] = useState<SmartFixRequestResponse | null>(null);
  const [manifest, setManifest] = useState<SmartFixManifestResponse | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const existing = await requestsFor(checkId);
        if (!cancelled && existing.length > 0) setRequest(existing[0]!);
      } catch {
        // A correction nobody has started yet is the ordinary case, and a
        // failure to look is not something to put in front of the reader.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [checkId, requestsFor]);

  useEffect(() => {
    if (request === null || request.status !== 'DELIVERED') return;
    let cancelled = false;
    void (async () => {
      try {
        const found = await manifestFor(request.id);
        if (!cancelled) setManifest(found);
      } catch {
        // The correction is delivered either way; the manifest is extra
        // evidence, not a precondition for telling the user it worked.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [manifestFor, request]);

  if (request !== null) {
    return (
      <>
        <SmartFixStatusPanel request={request} locale={locale} api={api} onCancelled={setRequest} />
        {manifest !== null && <SmartFixManifestPanel manifest={manifest} locale={locale} />}
      </>
    );
  }

  if (plan === null) {
    return <SmartFixPlanPanel checkId={checkId} locale={locale} api={api} onPlanned={setPlan} />;
  }

  return (
    <>
      <SmartFixPlanPanel checkId={checkId} locale={locale} api={api} onPlanned={setPlan} />
      {plan.refusalCode === null && plan.actionCount > 0 && (
        <SmartFixPurchasePanel plan={plan} locale={locale} api={api} onStarted={setRequest} />
      )}
    </>
  );
}
