'use client';

import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';
import { FormError } from '@/components/auth-form';
import { CheckBillingSummary } from '@/components/check-billing';
import { DataTable } from '@/components/ui/data-table';
import { Icon } from '@/components/ui/icon';
import { PageHeader } from '@/components/ui/page-header';
import { EmptyState, LoadingState } from '@/components/ui/states';
import { StatusBadge } from '@/components/ui/status-badge';
import { checkStageLabel, getChecksMessages } from '@/i18n/checks-messages';
import { resolveLocale } from '@/i18n/locales';
import { ApiError, checksApi, type CheckResponse } from '@/lib/api-client';

/** My checks (§72): the owner's own, newest first. */
export default function ChecksPage() {
  const locale = resolveLocale(useParams().locale);
  const messages = getChecksMessages(locale);
  const router = useRouter();

  const [checks, setChecks] = useState<CheckResponse[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);

  const describe = useCallback(
    (caught: unknown): string =>
      caught instanceof ApiError
        ? (messages.errors[caught.code] ?? messages.genericError)
        : messages.genericError,
    [messages],
  );

  const load = useCallback(async (): Promise<void> => {
    try {
      const page = await checksApi.list({ limit: 25 });
      setChecks(page.items);
      setNextCursor(page.nextCursor);
    } catch (caught) {
      if (caught instanceof ApiError && caught.status === 401) {
        router.push(`/${locale}/unauthorized`);
        return;
      }
      setError(describe(caught));
    } finally {
      setLoaded(true);
    }
  }, [describe, locale, router]);

  useEffect(() => {
    void load();
  }, [load]);

  async function loadMore(): Promise<void> {
    if (nextCursor === null) return;
    try {
      const page = await checksApi.list({ limit: 25, cursor: nextCursor });
      setChecks((current) => [...current, ...page.items]);
      setNextCursor(page.nextCursor);
    } catch (caught) {
      setError(describe(caught));
    }
  }

  return (
    <main className="pc-page">
      <PageHeader
        title={messages.myChecks}
        actions={
          <Link className="pc-btn" href={`/${locale}/checks/new`}>
            <Icon name="plus" size={18} />
            {messages.newCheck}
          </Link>
        }
      />

      <FormError message={error} />

      {!loaded ? (
        <LoadingState label={messages.loadingChecks} />
      ) : checks.length === 0 ? (
        <EmptyState
          icon="check"
          title={messages.noChecks}
          description={messages.noChecksHint}
          action={
            <Link className="pc-btn pc-btn-secondary" href={`/${locale}/checks/new`}>
              {messages.newCheck}
            </Link>
          }
        />
      ) : (
        <DataTable
          caption={messages.myChecks}
          rows={checks}
          rowKey={(check) => check.id}
          columns={[
            {
              key: 'document',
              header: messages.documentLabel,
              primary: true,
              cell: (check) => (
                <Link href={`/${locale}/checks/${check.id}`} dir="auto">
                  {check.documentName}
                </Link>
              ),
            },
            {
              key: 'standard',
              header: messages.standardLabel,
              cell: (check) => (
                <span className="pc-cell-stack">
                  <span>
                    <bdi>{check.standardName}</bdi> <bdi>{check.standardVersionLabel}</bdi>
                  </span>
                  <span className="pc-hint">
                    <bdi>{check.organizationName}</bdi>
                  </span>
                </span>
              ),
            },
            {
              // Two separate signals, never merged: a check that is still
              // running has a stage and no verdict, and a check that failed
              // has neither (§10).
              key: 'result',
              header: messages.resultLabel,
              cell: (check) =>
                check.determination === null ? (
                  <StatusBadge
                    status={check.status}
                    label={checkStageLabel(check.status, messages)}
                  />
                ) : (
                  <StatusBadge
                    status={check.determination}
                    label={messages.determinations[check.determination] ?? check.determination}
                  />
                ),
            },
            {
              // Billing is a third signal, kept apart from the compliance
              // result: a low score is not a financial problem, and a charge
              // is not a verdict (§62, §63).
              key: 'billing',
              header: messages.billingLabel,
              cell: (check) => <CheckBillingSummary check={check} locale={locale} />,
            },
          ]}
        />
      )}

      {nextCursor !== null && (
        <button type="button" className="secondary" onClick={() => void loadMore()}>
          {messages.loadMore}
        </button>
      )}
    </main>
  );
}
