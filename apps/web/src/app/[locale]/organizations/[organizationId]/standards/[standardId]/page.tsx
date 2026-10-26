'use client';

import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';
import { FormError, FormSuccess } from '@/components/auth-form';
import { DataTable, type DataColumn } from '@/components/ui/data-table';
import { PageHeader } from '@/components/ui/page-header';
import { LoadingState } from '@/components/ui/states';
import { StatusBadge } from '@/components/ui/status-badge';
import { versionTone } from '@/lib/status-tone';
import { OrganizationShell, type OrganizationShellState } from '@/components/organization-shell';
import { StandardManagement } from '@/components/standards-manage';
import { VersionHistoryNote } from '@/components/version-lifecycle';
import { getAuthMessages } from '@/i18n/auth-messages';
import { getStandardsMessages } from '@/i18n/standards-messages';
import {
  ApiError,
  standardsApi,
  type StandardResponse,
  type StandardVersionResponse,
} from '@/lib/api-client';

function StandardDetail({ organizationId, permissions, locale }: OrganizationShellState) {
  const params = useParams();
  const standardId = typeof params.standardId === 'string' ? params.standardId : '';
  const messages = getStandardsMessages(locale);
  const auth = getAuthMessages(locale);

  const [standard, setStandard] = useState<StandardResponse | null>(null);
  const [versions, setVersions] = useState<StandardVersionResponse[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [versionLabel, setVersionLabel] = useState('');

  const canCreateVersion = permissions.has('standard:version:create');

  const describe = useCallback(
    (caught: unknown): string =>
      caught instanceof ApiError
        ? (messages.errors[caught.code] ?? caught.message ?? auth.genericError)
        : auth.genericError,
    [auth, messages],
  );

  const load = useCallback(async (): Promise<void> => {
    try {
      const [detail, page] = await Promise.all([
        standardsApi.standard(organizationId, standardId),
        standardsApi.versions(organizationId, standardId),
      ]);
      setStandard(detail);
      setVersions(page.items);
    } catch (caught) {
      setError(describe(caught));
    }
  }, [describe, organizationId, standardId]);

  useEffect(() => {
    void load();
  }, [load]);

  async function act(action: () => Promise<unknown>): Promise<void> {
    setError(null);
    setNotice(null);
    try {
      await action();
      setNotice(messages.saved);
      await load();
    } catch (caught) {
      setError(describe(caught));
    }
  }

  if (standard === null) {
    return error !== null ? <FormError message={error} /> : <LoadingState label={auth.sending} />;
  }

  const versionBase = `/${locale}/organizations/${organizationId}/standards/${standardId}/versions`;
  const columns: DataColumn<(typeof versions)[number]>[] = [
    {
      key: 'label',
      header: messages.versionLabel,
      primary: true,
      cell: (version) => (
        <Link href={`${versionBase}/${version.id}`}>
          <bdi>{version.versionLabel}</bdi>
        </Link>
      ),
    },
    {
      key: 'status',
      header: messages.statusColumn,
      cell: (version) => (
        <StatusBadge
          status={version.status}
          tone={versionTone(version.status)}
          label={messages.versionStatuses[version.status] ?? version.status}
        />
      ),
    },
    {
      key: 'history',
      header: messages.lifecycle.historyColumn,
      cell: (version) => <VersionHistoryNote version={version} locale={locale} />,
    },
    { key: 'rules', header: messages.rules, align: 'end', cell: (version) => version.ruleCount },
    {
      key: 'hash',
      header: messages.contentHash,
      cell: (version) =>
        version.contentHash === null ? (
          '—'
        ) : (
          // Truncated for the table; the full value is on the version page,
          // where it can be copied.
          <code title={version.contentHash}>{version.contentHash.slice(0, 19)}…</code>
        ),
    },
  ];

  return (
    <>
      <p className="pc-back-link">
        <Link href={`/${locale}/organizations/${organizationId}/standards`}>
          {messages.standardsTitle}
        </Link>
      </p>
      <PageHeader
        title={
          <>
            <code className="pc-title-code">{standard.code}</code> <bdi>{standard.nameEn}</bdi>
          </>
        }
        description={
          <span dir="rtl" lang="ar">
            {standard.nameAr}
          </span>
        }
      />

      {error !== null && <FormError message={error} />}
      {notice !== null && <FormSuccess message={notice} />}

      <div className="pc-detail-grid">
        <section className="pc-detail-main" aria-labelledby="versions-heading">
          <h2 id="versions-heading">{messages.versions}</h2>
          <DataTable
            caption={messages.versions}
            columns={columns}
            rows={versions}
            rowKey={(version) => version.id}
          />
        </section>

        <div className="pc-detail-side">
          <section className="pc-card" aria-labelledby="standard-facts-heading">
            <h2 id="standard-facts-heading" className="pc-card-title">
              {messages.inForce}
            </h2>
            <p>
              {standard.publishedVersionLabel === null ? (
                <StatusBadge tone="neutral" label={messages.notPublished} />
              ) : (
                <StatusBadge tone="success" label={standard.publishedVersionLabel} />
              )}
            </p>
            <dl className="pc-summary">
              <dt>{messages.documentType}</dt>
              <dd>
                <bdi>{standard.documentTypeName}</bdi>
              </dd>
            </dl>
          </section>

          <StandardManagement
            locale={locale}
            organizationId={organizationId}
            standard={standard}
            permissions={permissions}
            onChanged={async (message) => {
              setError(null);
              setNotice(message);
              await load();
            }}
          />

          {canCreateVersion && standard.status !== 'ARCHIVED' && (
            <section className="pc-card" aria-labelledby="new-version-heading">
              <h2 id="new-version-heading" className="pc-card-title">
                {messages.newVersion}
              </h2>
              <form
                className="pc-form"
                onSubmit={(event) => {
                  event.preventDefault();
                  void act(() =>
                    standardsApi.createVersion(organizationId, standardId, versionLabel),
                  ).then(() => setVersionLabel(''));
                }}
              >
                <div className="pc-field">
                  <label htmlFor="versionLabel">{messages.versionLabel}</label>
                  <input
                    id="versionLabel"
                    value={versionLabel}
                    onChange={(event) => setVersionLabel(event.target.value)}
                    required
                  />
                </div>
                <button type="submit">{messages.newVersion}</button>
              </form>
            </section>
          )}
        </div>
      </div>
    </>
  );
}

export default function StandardDetailPage() {
  return <OrganizationShell>{(state) => <StandardDetail {...state} />}</OrganizationShell>;
}
