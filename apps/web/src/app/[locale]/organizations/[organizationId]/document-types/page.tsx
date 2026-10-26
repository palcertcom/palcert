'use client';

import { useCallback, useEffect, useState } from 'react';
import { FormError, FormSuccess } from '@/components/auth-form';
import { DataTable, type DataColumn } from '@/components/ui/data-table';
import { EditDocumentType } from '@/components/standards-manage';
import { PageHeader } from '@/components/ui/page-header';
import { StatusBadge } from '@/components/ui/status-badge';
import { OrganizationShell, type OrganizationShellState } from '@/components/organization-shell';
import { getAuthMessages } from '@/i18n/auth-messages';
import { getStandardsMessages } from '@/i18n/standards-messages';
import { ApiError, standardsApi, type DocumentTypeResponse } from '@/lib/api-client';

const SYSTEM_CATEGORIES = [
  'THESIS',
  'DISSERTATION',
  'JOURNAL_ARTICLE',
  'CONFERENCE_PAPER',
  'BOOK',
  'BOOK_CHAPTER',
  'TECHNICAL_REPORT',
  'GRANT_PROPOSAL',
  'RESEARCH_PROPOSAL',
  'GRADUATION_PROJECT',
  'COURSE_ASSIGNMENT',
  'ADMINISTRATIVE_DOCUMENT',
  'OTHER',
] as const;

function DocumentTypesSection({ organizationId, permissions, locale }: OrganizationShellState) {
  const messages = getStandardsMessages(locale);
  const auth = getAuthMessages(locale);

  const [types, setTypes] = useState<DocumentTypeResponse[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [nameAr, setNameAr] = useState('');
  const [category, setCategory] = useState<string>('THESIS');

  const canManage = permissions.has('standard:document-type:manage');

  const describe = useCallback(
    (caught: unknown): string =>
      caught instanceof ApiError
        ? (messages.errors[caught.code] ?? caught.message ?? auth.genericError)
        : auth.genericError,
    [auth, messages],
  );

  const load = useCallback(async (): Promise<void> => {
    try {
      const page = await standardsApi.documentTypes(organizationId);
      setTypes(page.items);
    } catch (caught) {
      setError(describe(caught));
    }
  }, [describe, organizationId]);

  useEffect(() => {
    void load();
  }, [load]);

  async function act(action: () => Promise<unknown>, success?: string): Promise<void> {
    setError(null);
    setNotice(null);
    try {
      await action();
      if (success !== undefined) setNotice(success);
      await load();
    } catch (caught) {
      setError(describe(caught));
    }
  }

  const columns: DataColumn<(typeof types)[number]>[] = [
    {
      key: 'name',
      header: messages.documentTypeName,
      primary: true,
      cell: (type) => (
        <span className="pc-cell-stack">
          <strong>
            <bdi>{type.name}</bdi>
          </strong>
          {type.nameAr !== null && (
            <span className="pc-hint" dir="rtl" lang="ar">
              {type.nameAr}
            </span>
          )}
        </span>
      ),
    },
    {
      key: 'category',
      header: messages.systemCategory,
      cell: (type) => messages.systemCategories[type.systemCategory] ?? type.systemCategory,
    },
    {
      key: 'standards',
      header: messages.standardsUsing,
      align: 'end',
      cell: (type) => type.standardCount,
    },
    {
      key: 'status',
      header: messages.statusColumn,
      cell: (type) => (
        <StatusBadge status={type.status} label={messages.statuses[type.status] ?? type.status} />
      ),
    },
  ];
  if (canManage) {
    columns.push({
      key: 'actions',
      header: messages.archive,
      align: 'end',
      cell: (type) =>
        type.status === 'ACTIVE' ? (
          <span className="pc-row-actions">
            <EditDocumentType
              locale={locale}
              organizationId={organizationId}
              documentType={type}
              onChanged={async (message) => {
                setNotice(message);
                await load();
              }}
            />
            <button
              type="button"
              className="pc-btn pc-btn-secondary pc-btn-sm"
              onClick={() =>
                void act(
                  () => standardsApi.archiveDocumentType(organizationId, type.id),
                  messages.saved,
                )
              }
            >
              {messages.archive}
            </button>
          </span>
        ) : (
          <button
            type="button"
            className="pc-btn pc-btn-secondary pc-btn-sm"
            onClick={() =>
              void act(
                () => standardsApi.restoreDocumentType(organizationId, type.id),
                messages.saved,
              )
            }
          >
            {messages.restore}
          </button>
        ),
    });
  }

  return (
    <>
      <PageHeader
        title={messages.documentTypesTitle}
        description={messages.documentTypesSubtitle}
      />

      {error !== null && <FormError message={error} />}
      {notice !== null && <FormSuccess message={notice} />}

      <div className={canManage ? 'pc-detail-grid' : undefined}>
        <div className="pc-detail-main">
          <DataTable
            caption={messages.documentTypesTitle}
            columns={columns}
            rows={types}
            rowKey={(type) => type.id}
          />
        </div>

        {canManage && (
          <section className="pc-card" aria-labelledby="new-document-type-heading">
            <h2 id="new-document-type-heading" className="pc-card-title">
              {messages.newDocumentType}
            </h2>
            <form
              className="pc-form"
              onSubmit={(event) => {
                event.preventDefault();
                void act(
                  () =>
                    standardsApi.createDocumentType(organizationId, {
                      systemCategory: category,
                      name,
                      ...(nameAr === '' ? {} : { nameAr }),
                    }),
                  messages.saved,
                ).then(() => {
                  setName('');
                  setNameAr('');
                });
              }}
            >
              <div className="pc-field">
                <label htmlFor="documentTypeName">{messages.documentTypeName}</label>
                <input
                  id="documentTypeName"
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                  required
                  minLength={2}
                />
              </div>
              <div className="pc-field">
                <label htmlFor="documentTypeNameAr">{messages.documentTypeNameAr}</label>
                <input
                  id="documentTypeNameAr"
                  dir="rtl"
                  lang="ar"
                  value={nameAr}
                  onChange={(event) => setNameAr(event.target.value)}
                />
              </div>
              <div className="pc-field">
                <label htmlFor="systemCategory">{messages.systemCategory}</label>
                <select
                  id="systemCategory"
                  value={category}
                  onChange={(event) => setCategory(event.target.value)}
                >
                  {SYSTEM_CATEGORIES.map((value) => (
                    <option key={value} value={value}>
                      {messages.systemCategories[value] ?? value}
                    </option>
                  ))}
                </select>
              </div>
              <button type="submit">{messages.newDocumentType}</button>
            </form>
          </section>
        )}
      </div>
    </>
  );
}

export default function DocumentTypesPage() {
  return <OrganizationShell>{(state) => <DocumentTypesSection {...state} />}</OrganizationShell>;
}
