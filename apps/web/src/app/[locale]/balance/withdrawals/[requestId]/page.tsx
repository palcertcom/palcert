'use client';

import type { WithdrawalRequestView } from '@palcert/contracts/finance/withdrawals';
import { useParams } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';
import { RequesterDetail, describeWithdrawalError } from '@/components/withdrawal';
import { PageHeader } from '@/components/ui/page-header';
import { LoadingState } from '@/components/ui/states';
import { resolveLocale } from '@/i18n/locales';
import { getWithdrawalMessages } from '@/i18n/withdrawal-messages';
import { userWithdrawalsApi } from '@/lib/withdrawals-api';

/** One of my withdrawals: what it is, where it goes, and what happened. */
export default function WithdrawalPage() {
  const params = useParams();
  const locale = resolveLocale(params.locale);
  const requestId = String(params.requestId);
  const messages = getWithdrawalMessages(locale);
  const [request, setRequest] = useState<WithdrawalRequestView | null>(null);
  const [failure, setFailure] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setRequest(await userWithdrawalsApi.get(requestId));
    } catch (caught) {
      setFailure(describeWithdrawalError(messages, caught).message);
    }
  }, [messages, requestId]);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <main className="pc-page">
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
          backHref={`/${locale}/balance/withdrawals`}
          onCancel={async () =>
            setRequest(await userWithdrawalsApi.cancel(request.id, request.version))
          }
          onViewProof={async () => {
            try {
              const grant = await userWithdrawalsApi.proof(request.id);
              window.open(grant.url, '_blank', 'noopener,noreferrer');
            } catch (caught) {
              setFailure(describeWithdrawalError(messages, caught).message);
            }
          }}
        />
      )}
    </main>
  );
}
