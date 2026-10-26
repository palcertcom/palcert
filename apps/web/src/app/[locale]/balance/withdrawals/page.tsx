'use client';

import type { WithdrawalRequestView } from '@palcert/contracts/finance/withdrawals';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useEffect, useState } from 'react';
import { WithdrawalHistory, describeWithdrawalError } from '@/components/withdrawal';
import { PageHeader } from '@/components/ui/page-header';
import { LoadingState } from '@/components/ui/states';
import { resolveLocale } from '@/i18n/locales';
import { getWithdrawalMessages } from '@/i18n/withdrawal-messages';
import { userWithdrawalsApi } from '@/lib/withdrawals-api';

/** My withdrawals, newest first (spec §36). */
export default function WithdrawalsPage() {
  const locale = resolveLocale(useParams().locale);
  const messages = getWithdrawalMessages(locale);
  const [items, setItems] = useState<WithdrawalRequestView[] | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const [failure, setFailure] = useState<string | null>(null);

  async function load(after?: string): Promise<void> {
    try {
      const page = await userWithdrawalsApi.list({
        limit: 25,
        ...(after ? { cursor: after } : {}),
      });
      setItems((current) =>
        after === undefined ? page.items : [...(current ?? []), ...page.items],
      );
      setCursor(page.nextCursor);
    } catch (caught) {
      setFailure(describeWithdrawalError(messages, caught).message);
    }
  }

  useEffect(() => {
    void load();
  }, []);

  return (
    <main className="pc-page">
      <PageHeader
        title={messages.history.title}
        actions={
          <Link className="pc-btn pc-btn-primary" href={`/${locale}/balance/withdraw`}>
            {messages.balanceCard.action}
          </Link>
        }
      />
      {failure === null ? null : (
        <p className="pc-error" role="alert">
          {failure}
        </p>
      )}
      {items === null ? (
        failure === null ? (
          <LoadingState label={messages.loading} />
        ) : null
      ) : (
        <section className="pc-card">
          <WithdrawalHistory
            items={items}
            locale={locale}
            caption={messages.history.caption}
            hrefFor={(item) => `/${locale}/balance/withdrawals/${item.id}`}
          />
          {cursor === null ? null : (
            <button
              type="button"
              className="pc-btn pc-btn-secondary"
              onClick={() => void load(cursor)}
            >
              {messages.history.loadMore}
            </button>
          )}
        </section>
      )}
    </main>
  );
}
