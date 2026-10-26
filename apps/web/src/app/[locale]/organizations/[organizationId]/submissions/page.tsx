'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { OrganizationShell } from '@/components/organization-shell';
import { DataTable, type DataColumn } from '@/components/ui/data-table';
import { PageHeader } from '@/components/ui/page-header';
import { EmptyState, LoadingState } from '@/components/ui/states';
import { StatusBadge } from '@/components/ui/status-badge';
import { getChecksMessages } from '@/i18n/checks-messages';
import { getShellMessages } from '@/i18n/shell-messages';
import { getSubmissionsMessages } from '@/i18n/submissions-messages';
import type { Locale } from '@/i18n/locales';
import { ApiError, submissionReviewApi, type SubmissionQueueEntryResponse } from '@/lib/api-client';

const FILTERS = [
  undefined,
  'SUBMITTED',
  'UNDER_REVIEW',
  'APPROVED',
  'REJECTED',
  'REVISION_REQUESTED',
] as const;

/**
 * The institution's review queue (§56).
 *
 * Each row carries what a reviewer needs to triage and nothing that would let
 * them reach past the submission: no document id, no check id, no report id,
 * no storage key. The way into the evidence is the submission's own page, and
 * there is no second way in.
 */
export default function SubmissionQueuePage() {
  return (
    <OrganizationShell>
      {({ organizationId, locale }) => <Queue locale={locale} organizationId={organizationId} />}
    </OrganizationShell>
  );
}

function Queue({ locale, organizationId }: { locale: Locale; organizationId: string }) {
  const messages = getSubmissionsMessages(locale);
  const [filter, setFilter] = useState<string | undefined>(undefined);
  const [entries, setEntries] = useState<SubmissionQueueEntryResponse[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const rows = await submissionReviewApi.queue(organizationId, filter);
        if (!cancelled) setEntries(rows);
      } catch (caught) {
        if (cancelled) return;
        setError(
          caught instanceof ApiError
            ? (messages.errors[caught.code] ?? messages.genericError)
            : messages.genericError,
        );
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [filter, messages, organizationId]);

  const when = new Intl.DateTimeFormat(locale, { dateStyle: 'medium' });
  const determinations = getChecksMessages(locale).determinations;
  type Entry = NonNullable<typeof entries>[number];

  const columns: DataColumn<Entry>[] = [
    {
      key: 'submitter',
      header: messages.queueSubmitter,
      primary: true,
      cell: (entry) => (
        <Link href={`/${locale}/organizations/${organizationId}/submissions/${entry.submissionId}`}>
          <bdi>{entry.submitter.displayName ?? entry.submitter.email}</bdi>
        </Link>
      ),
    },
    {
      key: 'standard',
      header: messages.queueStandard,
      cell: (entry) => (
        <bdi>
          <code>{entry.standardCode}</code> {entry.standardVersionLabel}
        </bdi>
      ),
    },
    {
      // PalCert's technical result and the institution's decision are
      // different things, decided by different parties; they sit in
      // separate columns and never share a badge.
      key: 'result',
      header: messages.queueResult,
      cell: (entry) => (
        <StatusBadge
          status={entry.technical.determination}
          label={determinations[entry.technical.determination] ?? entry.technical.determination}
        />
      ),
    },
    {
      key: 'decision',
      header: messages.queueStatus,
      cell: (entry) => (
        <StatusBadge
          status={entry.institutionDecisionStatus}
          label={
            messages.displayStatuses[entry.institutionDecisionStatus] ??
            entry.institutionDecisionStatus
          }
        />
      ),
    },
    {
      key: 'submitted',
      header: messages.submittedAt,
      cell: (entry) => (
        <time dateTime={entry.submittedAt}>{when.format(new Date(entry.submittedAt))}</time>
      ),
    },
  ];

  return (
    <>
      <PageHeader title={messages.queueTitle} description={messages.queueIntro} />
      {error === null ? null : <p role="alert">{error}</p>}

      <div className="pc-toolbar" role="group" aria-label={messages.queueStatus}>
        {FILTERS.map((status) => (
          <button
            key={status ?? 'ALL'}
            type="button"
            className="pc-chip"
            aria-pressed={filter === status}
            onClick={() => setFilter(status)}
          >
            {status === undefined
              ? messages.filterAll
              : (messages.displayStatuses[status] ?? status)}
          </button>
        ))}
      </div>

      {entries === null ? (
        <LoadingState label={getShellMessages(locale).loading} />
      ) : entries.length === 0 ? (
        <EmptyState icon="review" title={messages.queueEmpty} headingLevel={2} />
      ) : (
        <DataTable
          caption={messages.queueTitle}
          columns={columns}
          rows={entries}
          rowKey={(entry) => entry.revisionId}
        />
      )}
    </>
  );
}
