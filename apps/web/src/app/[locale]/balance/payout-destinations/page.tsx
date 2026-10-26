'use client';

import { useParams } from 'next/navigation';
import { useEffect, useState } from 'react';
import { DestinationManager } from '@/components/withdrawal';
import { PageHeader } from '@/components/ui/page-header';
import { resolveLocale } from '@/i18n/locales';
import { getWithdrawalMessages } from '@/i18n/withdrawal-messages';
import { balanceApi } from '@/lib/api-client';
import { userWithdrawalsApi } from '@/lib/withdrawals-api';

/** My payout destinations: masked, sealed at rest, never edited under a sent request. */
export default function PayoutDestinationsPage() {
  const locale = resolveLocale(useParams().locale);
  const messages = getWithdrawalMessages(locale);
  const [currencies, setCurrencies] = useState<string[]>(['USD']);

  useEffect(() => {
    void balanceApi
      .currencies()
      .then(setCurrencies)
      .catch(() => undefined);
  }, []);

  return (
    <main className="pc-page">
      <PageHeader
        title={messages.destinations.title}
        description={messages.destinations.encryptedHint}
      />
      <DestinationManager
        api={userWithdrawalsApi}
        locale={locale}
        title={messages.destinations.title}
        canManage
        currencies={currencies}
      />
    </main>
  );
}
