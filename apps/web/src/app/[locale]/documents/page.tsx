'use client';

import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { FormError } from '@/components/auth-form';
import { DataTable } from '@/components/ui/data-table';
import { PageHeader } from '@/components/ui/page-header';
import { EmptyState, LoadingState } from '@/components/ui/states';
import { StatusBadge } from '@/components/ui/status-badge';
import { getDocumentsMessages } from '@/i18n/documents-messages';
import { resolveLocale } from '@/i18n/locales';
import { ApiError, documentsApi, type DocumentResponse } from '@/lib/api-client';

/** My documents (§76): the owner's own, newest activity first. */
export default function DocumentsPage() {
  const locale = resolveLocale(useParams().locale);
  const messages = getDocumentsMessages(locale);
  const router = useRouter();

  // Null until the first page arrives: "no documents" is a fact about the
  // account and must not flash up while the list is still loading.
  const [documents, setDocuments] = useState<DocumentResponse[] | null>(null);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);

  const describe = useCallback(
    (caught: unknown): string =>
      caught instanceof ApiError
        ? (messages.errors[caught.code] ?? messages.genericError)
        : messages.genericError,
    [messages],
  );

  const load = useCallback(async (): Promise<void> => {
    try {
      const page = await documentsApi.list({ limit: 25 });
      setDocuments(page.items);
      setNextCursor(page.nextCursor);
    } catch (caught) {
      if (caught instanceof ApiError && caught.status === 401) {
        router.push(`/${locale}/unauthorized`);
        return;
      }
      setError(describe(caught));
      setDocuments([]);
    }
  }, [describe, locale, router]);

  useEffect(() => {
    void load();
  }, [load]);

  async function loadMore(): Promise<void> {
    if (nextCursor === null) return;
    try {
      const page = await documentsApi.list({ limit: 25, cursor: nextCursor });
      setDocuments((current) => [...(current ?? []), ...page.items]);
      setNextCursor(page.nextCursor);
    } catch (caught) {
      setError(describe(caught));
    }
  }

  async function create(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (name.trim().length === 0) return;
    setCreating(true);
    setError(null);
    try {
      const created = await documentsApi.create(name.trim());
      router.push(`/${locale}/documents/${created.id}`);
    } catch (caught) {
      setError(describe(caught));
    } finally {
      setCreating(false);
    }
  }

  return (
    <main className="pc-page">
      <PageHeader title={messages.myDocuments} description={messages.noDocumentsHint} />

      <form
        className="pc-inline-form pc-card"
        onSubmit={(event) => void create(event)}
        aria-label={messages.newDocument}
      >
        <div className="pc-field">
          <label htmlFor="new-document-name">{messages.documentName}</label>
          <input
            id="new-document-name"
            value={name}
            onChange={(event) => setName(event.target.value)}
            maxLength={200}
            required
            aria-describedby="new-document-hint"
          />
          <p id="new-document-hint" className="pc-hint">
            {messages.documentNameHint}
          </p>
        </div>
        <button type="submit" disabled={creating || name.trim().length === 0}>
          {messages.create}
        </button>
      </form>

      {error !== null && <FormError message={error} />}

      {documents === null ? (
        <LoadingState label={messages.loadingDocuments} />
      ) : documents.length === 0 ? (
        <EmptyState icon="document" title={messages.noDocuments} />
      ) : (
        <DataTable
          caption={messages.myDocuments}
          rows={documents}
          rowKey={(document) => document.id}
          columns={[
            {
              key: 'name',
              header: messages.documentName,
              primary: true,
              cell: (document) => (
                <Link href={`/${locale}/documents/${document.id}`} dir="auto">
                  {document.displayName}
                </Link>
              ),
            },
            {
              key: 'version',
              header: messages.latestVersion,
              cell: (document) =>
                document.latestVersion === null ? (
                  <span className="pc-hint">{messages.noVersions}</span>
                ) : (
                  <StatusBadge
                    status={document.latestVersion.status}
                    label={`${messages.version(document.latestVersion.versionNumber)} · ${
                      messages.statuses[document.latestVersion.status] ??
                      document.latestVersion.status
                    }`}
                  />
                ),
            },
            {
              key: 'updated',
              header: messages.updated,
              cell: (document) => (
                <time dateTime={document.updatedAt}>
                  {new Date(document.updatedAt).toLocaleString(locale)}
                </time>
              ),
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
