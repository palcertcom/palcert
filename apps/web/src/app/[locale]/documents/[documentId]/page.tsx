'use client';

import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';
import { FormError } from '@/components/auth-form';
import { DocumentUploader } from '@/components/document-uploader';
import { PageHeader } from '@/components/ui/page-header';
import { LoadingState } from '@/components/ui/states';
import { StatusBadge } from '@/components/ui/status-badge';
import { VersionList } from '@/components/version-list';
import { getDocumentsMessages } from '@/i18n/documents-messages';
import { resolveLocale } from '@/i18n/locales';
import {
  ApiError,
  documentsApi,
  type DocumentResponse,
  type DocumentVersionResponse,
} from '@/lib/api-client';

/** Document detail: rename, upload a version, history, download (§77). */
export default function DocumentDetailPage() {
  const params = useParams();
  const locale = resolveLocale(params.locale);
  const documentId = typeof params.documentId === 'string' ? params.documentId : '';
  const messages = getDocumentsMessages(locale);
  const router = useRouter();

  const [document, setDocument] = useState<DocumentResponse | null>(null);
  const [versions, setVersions] = useState<DocumentVersionResponse[]>([]);
  const [renaming, setRenaming] = useState(false);
  const [name, setName] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busyVersion, setBusyVersion] = useState<string | null>(null);

  const describe = useCallback(
    (caught: unknown): string =>
      caught instanceof ApiError
        ? (messages.errors[caught.code] ?? messages.genericError)
        : messages.genericError,
    [messages],
  );

  const load = useCallback(async (): Promise<void> => {
    try {
      const [profile, page] = await Promise.all([
        documentsApi.get(documentId),
        documentsApi.versions(documentId, { limit: 50 }),
      ]);
      setDocument(profile);
      setName(profile.displayName);
      setVersions(page.items);
    } catch (caught) {
      if (caught instanceof ApiError && caught.status === 401) {
        router.push(`/${locale}/unauthorized`);
        return;
      }
      setError(describe(caught));
    }
  }, [describe, documentId, locale, router]);

  useEffect(() => {
    void load();
  }, [load]);

  const onVersionChange = useCallback((version: DocumentVersionResponse) => {
    setVersions((current) => {
      const index = current.findIndex((entry) => entry.id === version.id);
      if (index === -1) return [version, ...current];
      const next = [...current];
      next[index] = version;
      return next;
    });
  }, []);

  async function rename(): Promise<void> {
    try {
      const updated = await documentsApi.rename(documentId, name.trim());
      setDocument(updated);
      setRenaming(false);
    } catch (caught) {
      setError(describe(caught));
    }
  }

  async function remove(): Promise<void> {
    if (!window.confirm(messages.deleteConfirm)) return;
    try {
      await documentsApi.remove(documentId);
      router.push(`/${locale}/documents`);
    } catch (caught) {
      setError(describe(caught));
    }
  }

  async function download(version: DocumentVersionResponse): Promise<void> {
    setBusyVersion(version.id);
    setError(null);
    try {
      const grant = await documentsApi.downloadAuthorization(documentId, version.id);
      // The signed URL is used immediately and never shown or stored.
      window.location.assign(grant.url);
    } catch (caught) {
      setError(describe(caught));
    } finally {
      setBusyVersion(null);
    }
  }

  async function retry(version: DocumentVersionResponse): Promise<void> {
    setBusyVersion(version.id);
    setError(null);
    try {
      onVersionChange(await documentsApi.retry(documentId, version.id));
      setNotice(messages.retryQueued);
    } catch (caught) {
      setError(describe(caught));
    } finally {
      setBusyVersion(null);
    }
  }

  if (document === null) {
    return (
      <main className="pc-page">
        <p className="pc-back-link">
          <Link href={`/${locale}/documents`}>{messages.backToDocuments}</Link>
        </p>
        {error !== null ? (
          <FormError message={error} />
        ) : (
          <LoadingState label={messages.loadingDocuments} />
        )}
      </main>
    );
  }

  const latest = versions[0] ?? document.latestVersion;

  return (
    <main className="pc-page">
      <p className="pc-back-link">
        <Link href={`/${locale}/documents`}>{messages.backToDocuments}</Link>
      </p>

      {renaming ? (
        <form
          className="pc-inline-form pc-card"
          onSubmit={(event) => {
            event.preventDefault();
            void rename();
          }}
        >
          <div className="pc-field">
            <label htmlFor="document-name">{messages.documentName}</label>
            <input
              id="document-name"
              value={name}
              onChange={(event) => setName(event.target.value)}
              maxLength={200}
              required
            />
          </div>
          <button type="submit">{messages.save}</button>
          <button
            type="button"
            onClick={() => {
              setRenaming(false);
              setName(document.displayName);
            }}
          >
            {messages.cancel}
          </button>
        </form>
      ) : (
        <PageHeader
          title={document.displayName}
          actions={
            <>
              <button type="button" onClick={() => setRenaming(true)}>
                {messages.rename}
              </button>
              <button type="button" className="pc-danger" onClick={() => void remove()}>
                {messages.deleteDocument}
              </button>
            </>
          }
        />
      )}

      {error !== null && <FormError message={error} />}
      {notice !== null && (
        <p role="status" className="pc-notice">
          {notice}
        </p>
      )}

      <div className="pc-detail-grid">
        <section className="pc-detail-main" aria-labelledby="version-history-heading">
          <h2 id="version-history-heading">{messages.versionHistory}</h2>
          <VersionList
            versions={versions}
            messages={messages}
            locale={locale}
            onDownload={(version) => void download(version)}
            onRetry={(version) => void retry(version)}
            busyVersionId={busyVersion}
          />
        </section>

        <aside className="pc-detail-side">
          <DocumentUploader
            documentId={documentId}
            messages={messages}
            onVersionChange={onVersionChange}
          />

          <section className="pc-card" aria-labelledby="document-facts-heading">
            <h2 id="document-facts-heading" className="pc-card-title">
              {messages.details}
            </h2>
            <dl className="pc-summary">
              <dt>{messages.latestVersion}</dt>
              <dd>
                {latest === null || latest === undefined ? (
                  <span className="pc-hint">{messages.noVersions}</span>
                ) : (
                  <StatusBadge
                    status={latest.status}
                    label={`${messages.version(latest.versionNumber)} · ${
                      messages.statuses[latest.status] ?? latest.status
                    }`}
                  />
                )}
              </dd>
              <dt>{messages.created}</dt>
              <dd>
                <time dateTime={document.createdAt}>
                  {new Date(document.createdAt).toLocaleString(locale)}
                </time>
              </dd>
              <dt>{messages.updated}</dt>
              <dd>
                <time dateTime={document.updatedAt}>
                  {new Date(document.updatedAt).toLocaleString(locale)}
                </time>
              </dd>
            </dl>
          </section>
        </aside>
      </div>
    </main>
  );
}
