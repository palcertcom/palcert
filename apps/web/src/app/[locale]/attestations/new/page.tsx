'use client';

import Link from 'next/link';
import { useParams, useRouter, useSearchParams } from 'next/navigation';
import { Suspense } from 'react';
import { AttestationWizard } from '@/components/attestation-wizard';
import { PageHeader } from '@/components/ui/page-header';
import { LoadingState } from '@/components/ui/states';
import { getAttestationsMessages } from '@/i18n/attestations-messages';
import { resolveLocale } from '@/i18n/locales';

/** Start, resume or renew an attestation request. */
export default function NewAttestationPage() {
  const params = useParams();
  const locale = resolveLocale(params.locale);
  const messages = getAttestationsMessages(locale);

  return (
    <main className="pc-page">
      <Link className="pc-back-link" href={`/${locale}/attestations`}>
        {messages.details.backToList}
      </Link>
      <PageHeader title={messages.wizard.title} description={messages.wizard.intro} />
      <Suspense fallback={<LoadingState label={messages.loading} />}>
        <Wizard />
      </Suspense>
    </main>
  );
}

/** The part that reads the query string: a draft to resume, or a request to renew. */
function Wizard() {
  const params = useParams();
  const locale = resolveLocale(params.locale);
  const messages = getAttestationsMessages(locale);
  const router = useRouter();
  const search = useSearchParams();
  return (
    <AttestationWizard
      locale={locale}
      messages={messages}
      draftId={search.get('draft')}
      renewFromRequestId={search.get('renew')}
      onSubmitted={(requestId) => router.push(`/${locale}/attestations/${requestId}`)}
    />
  );
}
