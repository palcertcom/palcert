'use client';

import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useEffect, useState } from 'react';
import { FormError } from '@/components/auth-form';
import { resolveLocale } from '@/i18n/locales';
import { DataTable } from '@/components/ui/data-table';
import { PageHeader } from '@/components/ui/page-header';
import { EmptyState, LoadingState } from '@/components/ui/states';
import { StatusBadge } from '@/components/ui/status-badge';
import { getShellMessages } from '@/i18n/shell-messages';
import { getSubmissionsMessages } from '@/i18n/submissions-messages';
import { ApiError, submissionsApi, type OfficialSubmissionResponse } from '@/lib/api-client';

/**
 * Everything this person has handed to an institution (§88).
 *
 * The status shown is the institution's, in the institution's own vocabulary.
 * A case whose only revision is still being copied reads "Not submitted",
 * because from the university's side nothing has arrived.
 */
export default function SubmissionsPage() {
  const params = useParams();
  const locale = resolveLocale(params.locale);
  const messages = getSubmissionsMessages(locale);

  const [submissions, setSubmissions] = useState<OfficialSubmissionResponse[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const rows = await submissionsApi.list();
        if (!cancelled) setSubmissions(rows);
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
  }, [messages]);

  const when = new Intl.DateTimeFormat(locale, { dateStyle: 'medium' });

  return (
    <main className="pc-page">
      <PageHeader title={messages.title} description={messages.intro} />
      {error === null ? null : <FormError message={error} />}

      {submissions === null ? (
        error === null ? (
          <LoadingState label={messages.loading} />
        ) : null
      ) : submissions.length === 0 ? (
        <EmptyState
          icon="submission"
          title={messages.empty}
          description={getShellMessages(locale).dashboardPage.noSubmissionsHint}
        />
      ) : (
        <DataTable
          caption={messages.title}
          rows={submissions}
          rowKey={(submission) => submission.id}
          columns={[
            {
              key: 'document',
              header: messages.columnDocument,
              primary: true,
              cell: (submission) => (
                <Link href={`/${locale}/submissions/${submission.id}`} dir="auto">
                  {submission.documentName}
                </Link>
              ),
            },
            {
              key: 'institution',
              header: messages.columnInstitution,
              cell: (submission) => (
                <span className="pc-cell-stack">
                  <bdi>{submission.organizationName}</bdi>
                  <span className="pc-hint">
                    <bdi>{submission.documentTypeName}</bdi>
                  </span>
                </span>
              ),
            },
            {
              key: 'status',
              header: messages.queueStatus,
              cell: (submission) => (
                <span className="pc-cell-stack">
                  <StatusBadge
                    status={submission.displayStatus}
                    label={
                      messages.displayStatuses[submission.displayStatus] ?? submission.displayStatus
                    }
                  />
                  <span className="pc-hint">
                    {messages.revisionCount(submission.revisionCount)}
                  </span>
                </span>
              ),
            },
            {
              key: 'updated',
              header: messages.columnUpdated,
              cell: (submission) => (
                <time dateTime={submission.updatedAt}>
                  {when.format(new Date(submission.updatedAt))}
                </time>
              ),
            },
          ]}
        />
      )}
    </main>
  );
}
