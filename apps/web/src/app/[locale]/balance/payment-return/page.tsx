'use client';

import Link from 'next/link';
import { useParams } from 'next/navigation';
import { PaymentReturnPanel } from '@/components/balance-panels';
import { getBalanceMessages } from '@/i18n/balance-messages';
import { resolveLocale } from '@/i18n/locales';

/**
 * Where the payment provider sends the browser back to (§40, §91).
 *
 * This page has no authority over anything. It cannot credit a balance, and
 * it does not claim one was credited: it asks the server what the top-up's
 * status is and reports that. Credit is added by a verified provider event,
 * whether or not the customer's browser ever comes back here.
 */
export default function PaymentReturnPage() {
  const locale = resolveLocale(useParams().locale);
  const messages = getBalanceMessages(locale);

  return (
    <main className="pc-page">
      <PaymentReturnPanel locale={locale} />
      <p className="pc-back-link">
        <Link href={`/${locale}/balance`}>{messages.returnBackToBalance}</Link>
      </p>
    </main>
  );
}
