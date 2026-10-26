'use client';

import type { WithdrawalRequestView } from '@palcert/contracts/finance/withdrawals';
import { useParams } from 'next/navigation';
import { useEffect, useMemo, useState } from 'react';
import { OrganizationShell } from '@/components/organization-shell';
import { RequesterDetail, describeWithdrawalError } from '@/components/withdrawal';
import { PageHeader } from '@/components/ui/page-header';
import { LoadingState } from '@/components/ui/states';
import type { Locale } from '@/i18n/locales';
import { getWithdrawalMessages } from '@/i18n/withdrawal-messages';
import { organizationPayoutsApi } from '@/lib/withdrawals-api';

/** One organization payout, with its timeline. */
export default function OrganizationPayoutPage() {
  const requestId = String(useParams().requestId);
  return (
    <OrganizationShell>
      {({ organizationId, locale }) => (
        <Payout organizationId={organizationId} locale={locale} requestId={requestId} />
      )}
    </OrganizationShell>
  );
}

function Payout({
  organizationId,
  locale,
  requestId,
}: {
  organizationId: string;
  locale: Locale;
  requestId: string;
}) {
  const messages = getWithdrawalMessages(locale);
  const api = useMemo(() => organizationPayoutsApi(organizationId), [organizationId]);
  const [request, setRequest] = useState<WithdrawalRequestView | null>(null);
  const [failure, setFailure] = useState<string | null>(null);

  useEffect(() => {
    api
      .get(requestId)
      .then(setRequest)
      .catch((caught: unknown) => setFailure(describeWithdrawalError(messages, caught).message));
  }, [api, messages, requestId]);

  return (
    <>
      <PageHeader title={messages.detail.title(request?.reference ?? '')} />
      {failure === null ? null : (
        <p className="pc-error" role="alert">
          {failure}
        </p>
      )}
      {request === null ? (
        failure === null ? (
          <LoadingState label={messages.loading} />
        ) : null
      ) : (
        <RequesterDetail
          request={request}
          locale={locale}
          backHref={`/${locale}/organizations/${organizationId}/payouts`}
          onCancel={async () => setRequest(await api.cancel(request.id, request.version))}
          onViewProof={async () => {
            try {
              const grant = await api.proof(request.id);
              window.open(grant.url, '_blank', 'noopener,noreferrer');
            } catch (caught) {
              setFailure(describeWithdrawalError(messages, caught).message);
            }
          }}
        />
      )}
    </>
  );
}
