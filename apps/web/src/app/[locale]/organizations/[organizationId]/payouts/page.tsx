'use client';

import type {
  OrganizationEarningsView,
  PayoutDestinationView,
  WithdrawalRequestView,
} from '@palcert/contracts/finance/withdrawals';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { OrganizationShell } from '@/components/organization-shell';
import {
  FundsTable,
  WithdrawalHistory,
  WithdrawalRequestForm,
  describeWithdrawalError,
} from '@/components/withdrawal';
import { PageHeader } from '@/components/ui/page-header';
import { ErrorState, LoadingState } from '@/components/ui/states';
import type { Locale } from '@/i18n/locales';
import { getOrganizationMessages } from '@/i18n/organization-messages';
import { getWithdrawalMessages } from '@/i18n/withdrawal-messages';
import { organizationPayoutsApi } from '@/lib/withdrawals-api';

/**
 * An organization's earnings and payouts (spec §30, D4, D6): settled net
 * share by currency, a payout request for those allowed to make one, and the
 * history. Never another organization's, never a cross-currency total.
 */
export default function OrganizationPayoutsPage() {
  return (
    <OrganizationShell>
      {({ organizationId, locale, permissions }) =>
        permissions.has('organization:withdrawal:read') ? (
          <Payouts
            organizationId={organizationId}
            locale={locale}
            canRequest={permissions.has('organization:withdrawal:request')}
            canSeeDestinations={permissions.has('organization:payout-destination:read')}
          />
        ) : (
          <>
            <PageHeader title={getWithdrawalMessages(locale).organization.title} />
            <ErrorState
              title={getOrganizationMessages(locale).errors['ORGANIZATION_ACCESS_DENIED'] ?? ''}
            />
          </>
        )
      }
    </OrganizationShell>
  );
}

function Payouts({
  organizationId,
  locale,
  canRequest,
  canSeeDestinations,
}: {
  organizationId: string;
  locale: Locale;
  canRequest: boolean;
  canSeeDestinations: boolean;
}) {
  const messages = getWithdrawalMessages(locale);
  const o = messages.organization;
  const router = useRouter();
  const api = useMemo(() => organizationPayoutsApi(organizationId), [organizationId]);
  const [earnings, setEarnings] = useState<OrganizationEarningsView | null>(null);
  const [history, setHistory] = useState<WithdrawalRequestView[] | null>(null);
  const [destinations, setDestinations] = useState<PayoutDestinationView[]>([]);
  const [currency, setCurrency] = useState<string | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const base = `/${locale}/organizations/${organizationId}/payouts`;

  const load = useCallback(async () => {
    try {
      const [view, page] = await Promise.all([api.earnings(), api.list({ limit: 25 })]);
      setEarnings(view);
      setHistory(page.items);
      setCurrency((current) => current ?? view.rows[0]?.currency ?? null);
      if (canRequest || canSeeDestinations) setDestinations(await api.destinations());
    } catch (caught) {
      setFailure(describeWithdrawalError(messages, caught).message);
    }
  }, [api, canRequest, canSeeDestinations, messages]);

  useEffect(() => {
    void load();
  }, [load]);

  const row = earnings?.rows.find((entry) => entry.currency === currency) ?? null;

  return (
    <>
      <PageHeader
        title={o.title}
        description={o.intro}
        actions={
          canSeeDestinations ? (
            <Link className="pc-btn pc-btn-secondary" href={`${base}/destinations`}>
              {messages.nav.destinations}
            </Link>
          ) : undefined
        }
      />
      {failure === null ? null : (
        <p className="pc-error" role="alert">
          {failure}
        </p>
      )}
      {earnings === null ? (
        failure === null ? (
          <LoadingState label={messages.loading} />
        ) : null
      ) : (
        <>
          <section className="pc-card" aria-labelledby="earnings">
            <h2 id="earnings">{o.earningsTitle}</h2>
            <p className="pc-hint">{o.netShareOnly}</p>
            <p className="pc-hint">{o.clearingDays(String(earnings.clearingDays))}</p>
            {earnings.rows.length === 0 ? (
              <p className="pc-hint">{o.empty}</p>
            ) : (
              <FundsTable rows={earnings.rows} locale={locale} caption={o.earningsCaption} />
            )}
          </section>

          {!canRequest ? (
            <p className="pc-hint">{o.noPermission}</p>
          ) : row === null ? null : (
            <>
              {earnings.rows.length > 1 ? (
                <div className="pc-field pc-field-inline">
                  <label htmlFor="payout-currency">{messages.form.currency}</label>
                  <select
                    id="payout-currency"
                    value={currency ?? ''}
                    onChange={(event) => setCurrency(event.target.value)}
                  >
                    {earnings.rows.map((entry) => (
                      <option key={entry.currency} value={entry.currency}>
                        {entry.currency}
                      </option>
                    ))}
                  </select>
                </div>
              ) : null}
              <WithdrawalRequestForm
                api={api}
                locale={locale}
                currency={row.currency}
                available={row.available}
                minimum={row.minimum}
                maximum={row.maximum}
                destinations={destinations}
                {...(canSeeDestinations ? { destinationsHref: `${base}/destinations` } : {})}
                onSubmitted={(request) => router.push(`${base}/${request.id}`)}
              />
            </>
          )}

          <section className="pc-card" aria-labelledby="payout-history">
            <h2 id="payout-history">{messages.history.organizationTitle}</h2>
            <WithdrawalHistory
              items={history ?? []}
              locale={locale}
              caption={messages.history.organizationTitle}
              hrefFor={(item) => `${base}/${item.id}`}
            />
          </section>
        </>
      )}
    </>
  );
}
