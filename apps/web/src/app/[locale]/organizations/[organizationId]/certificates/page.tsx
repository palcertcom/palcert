'use client';

import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { OrganizationShell } from '@/components/organization-shell';
import { DataTable, type DataColumn } from '@/components/ui/data-table';
import { PageHeader } from '@/components/ui/page-header';
import { EmptyState, ErrorState, LoadingState } from '@/components/ui/states';
import { StatusBadge } from '@/components/ui/status-badge';
import { getCertificatesMessages } from '@/i18n/certificates-messages';
import type { Locale } from '@/i18n/locales';
import { getOrganizationMessages } from '@/i18n/organization-messages';
import { getShellMessages } from '@/i18n/shell-messages';
import {
  ApiError,
  certificateReviewApi,
  type OrganizationCertificateFilter,
  type OrganizationCertificateListEntryResponse,
} from '@/lib/api-client';

const FILTERS: readonly (OrganizationCertificateFilter | undefined)[] = [
  undefined,
  'ISSUED',
  'REVOKED',
  'IN_PREPARATION',
  'FAILED',
];

const PAGE_SIZE = 25;

/**
 * The organization's certificate register (§119).
 *
 * Read-only by design, apart from downloading an issued PDF. There is no
 * "issue" button — a certificate follows from approving a compliant
 * submission — and revoking is done on the certificate's own page, where its
 * consequences are spelled out. Each row
 * carries the number and the holder; the verification code and link stay on
 * that page too.
 */
export default function OrganizationCertificatesPage() {
  return (
    <OrganizationShell>
      {({ organizationId, locale, permissions }) =>
        permissions.has('certificate:record:read') ? (
          <Register locale={locale} organizationId={organizationId} />
        ) : (
          <>
            <PageHeader title={getCertificatesMessages(locale).register.title} />
            <ErrorState
              title={getOrganizationMessages(locale).errors['ORGANIZATION_ACCESS_DENIED'] ?? ''}
            />
          </>
        )
      }
    </OrganizationShell>
  );
}

function Register({ locale, organizationId }: { locale: Locale; organizationId: string }) {
  const messages = getCertificatesMessages(locale);
  const register = messages.register;
  const organization = getOrganizationMessages(locale);

  const [filter, setFilter] = useState<OrganizationCertificateFilter | undefined>(undefined);
  const [draft, setDraft] = useState('');
  const [query, setQuery] = useState('');
  const [rows, setRows] = useState<OrganizationCertificateListEntryResponse[] | null>(null);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [downloading, setDownloading] = useState<string | null>(null);
  const [downloadError, setDownloadError] = useState<string | null>(null);

  const describe = useCallback(
    (caught: unknown) =>
      caught instanceof ApiError
        ? (messages.errors[caught.code] ??
          organization.errors[caught.code] ??
          messages.genericError)
        : messages.genericError,
    [messages, organization],
  );

  useEffect(() => {
    let cancelled = false;
    setRows(null);
    setError(null);
    void (async () => {
      try {
        const page = await certificateReviewApi.list(organizationId, {
          ...(filter === undefined ? {} : { status: filter }),
          ...(query.length === 0 ? {} : { q: query }),
          limit: PAGE_SIZE,
        });
        if (cancelled) return;
        setRows([...page.items]);
        setNextCursor(page.nextCursor);
      } catch (caught) {
        if (!cancelled) setError(describe(caught));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [describe, filter, organizationId, query]);

  async function loadMore(): Promise<void> {
    if (nextCursor === null || loadingMore) return;
    setLoadingMore(true);
    try {
      const page = await certificateReviewApi.list(organizationId, {
        ...(filter === undefined ? {} : { status: filter }),
        ...(query.length === 0 ? {} : { q: query }),
        cursor: nextCursor,
        limit: PAGE_SIZE,
      });
      setRows((current) => [...(current ?? []), ...page.items]);
      setNextCursor(page.nextCursor);
    } catch (caught) {
      setError(describe(caught));
    } finally {
      setLoadingMore(false);
    }
  }

  async function download(certificateId: string): Promise<void> {
    setDownloading(certificateId);
    setDownloadError(null);
    try {
      const grant = await certificateReviewApi.download(organizationId, certificateId);
      // The signed URL is used at once and never shown or stored.
      window.location.assign(grant.url);
    } catch (caught) {
      setDownloadError(describe(caught));
    } finally {
      setDownloading(null);
    }
  }

  const when = new Intl.DateTimeFormat(locale, { dateStyle: 'medium' });
  const base = `/${locale}/organizations/${organizationId}`;
  type Row = OrganizationCertificateListEntryResponse;

  const columns: DataColumn<Row>[] = [
    {
      key: 'number',
      header: messages.certificateNumber,
      primary: true,
      cell: (row) => (
        <Link href={`${base}/certificates/${row.id}`}>
          {row.certificateNumber === null ? (
            register.numberPending
          ) : (
            <code dir="ltr" className="pc-ltr">
              {row.certificateNumber}
            </code>
          )}
        </Link>
      ),
    },
    {
      key: 'holder',
      header: register.holder,
      cell: (row) =>
        row.holder === null ? (
          <span className="pc-hint">{register.holderUnknown}</span>
        ) : (
          <span className="pc-cell-stack">
            <bdi>{row.holder.displayName ?? row.holder.email}</bdi>
            {row.holder.displayName === null ? null : (
              <span className="pc-hint" dir="ltr">
                {row.holder.email}
              </span>
            )}
          </span>
        ),
    },
    {
      key: 'standard',
      header: messages.standard,
      cell: (row) => (
        <span className="pc-cell-stack">
          <bdi>{row.documentTypeName}</bdi>
          <span className="pc-hint">
            <bdi>
              <code>{row.standardCode}</code> {row.standardVersionLabel}
            </bdi>
          </span>
        </span>
      ),
    },
    {
      key: 'issued',
      header: messages.issued,
      cell: (row) =>
        row.issuedAt === null ? (
          '—'
        ) : (
          <time dateTime={row.issuedAt}>{when.format(new Date(row.issuedAt))}</time>
        ),
    },
    {
      key: 'status',
      header: messages.statusLabel,
      cell: (row) => {
        const state = row.revokedAt === null ? row.issuanceStatus : 'REVOKED';
        return <StatusBadge status={state} label={messages.issuanceStatuses[state] ?? state} />;
      },
    },
    {
      key: 'actions',
      header: register.submission,
      cell: (row) => (
        <div className="pc-row-actions">
          <Link href={`${base}/submissions/${row.submissionId}`}>{register.openSubmission}</Link>
          {row.issuanceStatus === 'ISSUED' && row.revokedAt === null ? (
            <button
              type="button"
              className="pc-btn pc-btn-secondary pc-btn-sm"
              disabled={downloading === row.id}
              aria-busy={downloading === row.id}
              aria-label={`${messages.download}: ${row.certificateNumber ?? row.id}`}
              onClick={() => void download(row.id)}
            >
              {messages.download}
            </button>
          ) : null}
        </div>
      ),
    },
  ];

  const searching = query.length > 0 || filter !== undefined;

  return (
    <>
      <PageHeader title={register.title} description={register.intro} />
      {downloadError === null ? null : (
        <p className="pc-alert pc-alert-error" role="alert">
          {downloadError}
        </p>
      )}

      <form
        className="pc-search-bar"
        role="search"
        onSubmit={(event) => {
          event.preventDefault();
          setQuery(draft.trim());
        }}
      >
        <div className="pc-field">
          <label htmlFor="certificateSearch">{register.searchLabel}</label>
          <input
            id="certificateSearch"
            type="search"
            value={draft}
            maxLength={128}
            aria-describedby="certificateSearchHint"
            onChange={(event) => setDraft(event.target.value)}
          />
          <p id="certificateSearchHint" className="pc-hint">
            {register.searchHint}
          </p>
        </div>
        <button type="submit" className="secondary">
          {register.search}
        </button>
        {query.length === 0 ? null : (
          <button
            type="button"
            className="secondary"
            onClick={() => {
              setDraft('');
              setQuery('');
            }}
          >
            {register.clearSearch}
          </button>
        )}
      </form>

      <div className="pc-toolbar" role="group" aria-label={register.filterLabel}>
        {FILTERS.map((status) => (
          <button
            key={status ?? 'ALL'}
            type="button"
            className="pc-chip"
            aria-pressed={filter === status}
            onClick={() => setFilter(status)}
          >
            {status === undefined ? register.filterAll : register.filters[status]}
          </button>
        ))}
      </div>

      {error !== null ? (
        <ErrorState title={error} />
      ) : rows === null ? (
        <LoadingState label={messages.loading} />
      ) : rows.length === 0 ? (
        searching ? (
          <EmptyState icon="certificate" title={register.noMatches} />
        ) : (
          <EmptyState
            icon="certificate"
            title={register.emptyTitle}
            description={register.emptyHint}
          />
        )
      ) : (
        <DataTable
          caption={register.title}
          columns={columns}
          rows={rows}
          rowKey={(row) => row.id}
        />
      )}

      {nextCursor !== null && rows !== null && error === null && (
        <div className="pc-list-footer">
          <button
            type="button"
            className="secondary"
            disabled={loadingMore}
            aria-busy={loadingMore}
            onClick={() => void loadMore()}
          >
            {loadingMore ? getShellMessages(locale).loading : register.loadMore}
          </button>
        </div>
      )}
    </>
  );
}
