'use client';

import Link from 'next/link';
import { useParams } from 'next/navigation';
import { getBalanceMessages } from '@/i18n/balance-messages';
import { resolveLocale } from '@/i18n/locales';

/** The customer backed out on the provider's page. Nothing happened (§91). */
export default function PaymentCancelledPage() {
  const locale = resolveLocale(useParams().locale);
  const messages = getBalanceMessages(locale);

  return (
    <main className="pc-page">
      <section className="pc-card pc-payment-result">
        <h1 className="pc-title">{messages.cancelledTitle}</h1>
        <p role="status">{messages.cancelledBody}</p>
      </section>
      <p className="pc-back-link">
        <Link href={`/${locale}/balance`}>{messages.returnBackToBalance}</Link>
      </p>
    </main>
  );
}
