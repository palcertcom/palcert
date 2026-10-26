'use client';

import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { FormError, FormSuccess } from '@/components/auth-form';
import { DataTable, type DataColumn } from '@/components/ui/data-table';
import { PageHeader } from '@/components/ui/page-header';
import { EmptyState } from '@/components/ui/states';
import { StatusBadge } from '@/components/ui/status-badge';
import { OrganizationShell, type OrganizationShellState } from '@/components/organization-shell';
import { getAuthMessages } from '@/i18n/auth-messages';
import { getStandardsMessages } from '@/i18n/standards-messages';
import { getStandardTransferMessages } from '@/i18n/standard-transfer-messages';
import {
  ApiError,
  standardsApi,
  type DocumentTypeResponse,
  type StandardResponse,
} from '@/lib/api-client';

function StandardsSection({ organizationId, permissions, locale }: OrganizationShellState) {
  const messages = getStandardsMessages(locale);
  const auth = getAuthMessages(locale);

  const [standards, setStandards] = useState<StandardResponse[]>([]);
  const [documentTypes, setDocumentTypes] = useState<DocumentTypeResponse[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const [creating, setCreating] = useState(false);
  const [code, setCode] = useState('');
  const [nameEn, setNameEn] = useState('');
  const [nameAr, setNameAr] = useState('');
  const [documentTypeId, setDocumentTypeId] = useState('');

  const canCreate = permissions.has('standard:definition:create');
  const canImport =
    permissions.has('standard:version:create') && permissions.has('standard:rule:write');
  const transfer = getStandardTransferMessages(locale);

  const describe = useCallback(
    (caught: unknown): string =>
      caught instanceof ApiError
        ? (messages.errors[caught.code] ?? caught.message ?? auth.genericError)
        : auth.genericError,
    [auth, messages],
  );

  const load = useCallback(
    async (cursor?: string): Promise<void> => {
      try {
        const page = await standardsApi.standards(organizationId, {
          ...(cursor === undefined ? {} : { cursor }),
          ...(search === '' ? {} : { search }),
        });
        setStandards((current) =>
          cursor === undefined ? page.items : [...current, ...page.items],
        );
        setNextCursor(page.nextCursor);
      } catch (caught) {
        setError(describe(caught));
      }
    },
    [describe, organizationId, search],
  );

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (!canCreate) return;
    void standardsApi
      .documentTypes(organizationId)
      .then((page) => {
        const active = page.items.filter((item) => item.status === 'ACTIVE');
        setDocumentTypes(active);
        setDocumentTypeId((current) => (current === '' ? (active[0]?.id ?? '') : current));
      })
      .catch(() => undefined);
  }, [canCreate, organizationId]);

  async function create(): Promise<void> {
    setError(null);
    setNotice(null);
    try {
      await standardsApi.createStandard(organizationId, { documentTypeId, code, nameEn, nameAr });
      setNotice(messages.saved);
      setCreating(false);
      setCode('');
      setNameEn('');
      setNameAr('');
      await load();
    } catch (caught) {
      setError(describe(caught));
    }
  }

  const base = `/${locale}/organizations/${organizationId}/standards`;
  const columns: DataColumn<(typeof standards)[number]>[] = [
    {
      key: 'code',
      header: messages.standardCode,
      primary: true,
      cell: (standard) => (
        <Link href={`${base}/${standard.id}`}>
          <code>{standard.code}</code>
        </Link>
      ),
    },
    {
      key: 'name',
      header: messages.nameEn,
      cell: (standard) => (
        <span className="pc-cell-stack">
          <bdi>{standard.nameEn}</bdi>
          <span className="pc-hint" dir="rtl" lang="ar">
            {standard.nameAr}
          </span>
        </span>
      ),
    },
    {
      key: 'type',
      header: messages.documentType,
      cell: (standard) => <bdi>{standard.documentTypeName}</bdi>,
    },
    {
      key: 'versions',
      header: messages.versions,
      align: 'end',
      cell: (standard) => standard.versionCount,
    },
    {
      key: 'inForce',
      header: messages.inForce,
      cell: (standard) =>
        standard.publishedVersionLabel === null ? (
          <StatusBadge tone="neutral" label={messages.notPublished} />
        ) : (
          <StatusBadge tone="success" label={standard.publishedVersionLabel} />
        ),
    },
  ];

  return (
    <>
      <PageHeader
        title={messages.standardsTitle}
        description={messages.standardsSubtitle}
        actions={
          canCreate && !creating ? (
            <>
              <button type="button" onClick={() => setCreating(true)}>
                + {messages.newStandard}
              </button>
              {canImport && (
                <Link
                  className="pc-btn pc-btn-secondary"
                  href={`/${locale}/organizations/${organizationId}/standards/import`}
                >
                  {transfer.importStandard}
                </Link>
              )}
            </>
          ) : canImport && !creating ? (
            <Link
              className="pc-btn pc-btn-secondary"
              href={`/${locale}/organizations/${organizationId}/standards/import`}
            >
              {transfer.importStandard}
            </Link>
          ) : undefined
        }
      />

      {error !== null && <FormError message={error} />}
      {notice !== null && <FormSuccess message={notice} />}

      {canCreate && creating && (
        <section className="pc-card pc-form-card" aria-labelledby="new-standard-heading">
          <h2 id="new-standard-heading" className="pc-card-title">
            {messages.newStandard}
          </h2>
          <form
            className="pc-form"
            onSubmit={(event) => {
              event.preventDefault();
              void create();
            }}
          >
            <div className="pc-field">
              <label htmlFor="documentTypeId">{messages.documentType}</label>
              <select
                id="documentTypeId"
                value={documentTypeId}
                onChange={(event) => setDocumentTypeId(event.target.value)}
                required
              >
                {documentTypes.map((type) => (
                  <option key={type.id} value={type.id}>
                    {type.name}
                  </option>
                ))}
              </select>
            </div>
            <div className="pc-field">
              <label htmlFor="standardCode">{messages.standardCode}</label>
              <input
                id="standardCode"
                className="pc-input-ltr"
                value={code}
                onChange={(event) => setCode(event.target.value.toUpperCase())}
                required
                minLength={2}
              />
              <p className="pc-hint">{messages.standardCodeHint}</p>
            </div>
            <div className="pc-field">
              <label htmlFor="standardNameEn">{messages.nameEn}</label>
              <input
                id="standardNameEn"
                dir="ltr"
                lang="en"
                value={nameEn}
                onChange={(event) => setNameEn(event.target.value)}
                required
                minLength={2}
              />
            </div>
            <div className="pc-field">
              <label htmlFor="standardNameAr">{messages.nameAr}</label>
              <input
                id="standardNameAr"
                dir="rtl"
                lang="ar"
                value={nameAr}
                onChange={(event) => setNameAr(event.target.value)}
                required
                minLength={2}
              />
            </div>
            <div className="pc-actions">
              <button type="submit">{messages.create}</button>
              <button type="button" className="secondary" onClick={() => setCreating(false)}>
                {messages.cancel}
              </button>
            </div>
          </form>
        </section>
      )}

      <form
        className="pc-search-bar"
        role="search"
        onSubmit={(event) => {
          event.preventDefault();
          void load();
        }}
      >
        <div className="pc-field">
          <label htmlFor="standardSearch">{messages.searchStandards}</label>
          <input
            id="standardSearch"
            type="search"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
          />
        </div>
        <button type="submit" className="secondary">
          {messages.searchStandards}
        </button>
      </form>

      {standards.length === 0 ? (
        <EmptyState icon="standard" title={messages.noStandards} headingLevel={2} />
      ) : (
        <DataTable
          caption={messages.standardsTitle}
          columns={columns}
          rows={standards}
          rowKey={(standard) => standard.id}
        />
      )}

      {nextCursor !== null && (
        <div className="pc-list-footer">
          <button type="button" className="secondary" onClick={() => void load(nextCursor)}>
            {messages.loadMore}
          </button>
        </div>
      )}
    </>
  );
}

export default function StandardsPage() {
  return <OrganizationShell>{(state) => <StandardsSection {...state} />}</OrganizationShell>;
}
