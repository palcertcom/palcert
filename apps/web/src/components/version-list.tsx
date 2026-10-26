'use client';

import { StatusBadge } from '@/components/ui/status-badge';
import type { DocumentsMessages } from '@/i18n/documents-messages';
import type { DocumentVersionResponse } from '@/lib/api-client';

export interface VersionListProps {
  readonly versions: readonly DocumentVersionResponse[];
  readonly messages: DocumentsMessages;
  readonly locale: string;
  readonly onDownload: (version: DocumentVersionResponse) => void;
  readonly onRetry: (version: DocumentVersionResponse) => void;
  readonly busyVersionId?: string | null;
}

export function formatBytes(bytes: number | null, locale: string): string {
  if (bytes === null) return '—';
  const units = ['B', 'KB', 'MB', 'GB'];
  let value = bytes;
  let index = 0;
  while (value >= 1024 && index < units.length - 1) {
    value /= 1024;
    index += 1;
  }
  return `${new Intl.NumberFormat(locale, { maximumFractionDigits: index === 0 ? 0 : 1 }).format(value)} ${units[index]}`;
}

/**
 * Version history (§77, §79, §80).
 *
 * A rejected version explains what was wrong with the *file* in plain words;
 * a failed version says plainly that the problem was PalCert's and offers a
 * retry that needs no re-upload. Neither ever names a scanner, a bucket or a
 * queue.
 */
export function VersionList({
  versions,
  messages,
  locale,
  onDownload,
  onRetry,
  busyVersionId = null,
}: VersionListProps) {
  if (versions.length === 0) return <p className="pc-hint">{messages.noVersions}</p>;

  return (
    <ul className="pc-version-list">
      {versions.map((version) => {
        const status = messages.statuses[version.status] ?? version.status;
        const busy = busyVersionId === version.id;
        return (
          <li key={version.id} className={`pc-version pc-version-${version.status.toLowerCase()}`}>
            <div className="pc-version-header">
              <strong>{messages.version(version.versionNumber)}</strong>
              <StatusBadge status={version.status} label={status} />
            </div>
            <dl className="pc-definitions">
              <dt>{messages.size}</dt>
              <dd>{formatBytes(version.sizeBytes, locale)}</dd>
              {version.sha256 !== null && (
                <>
                  <dt>{messages.fingerprint}</dt>
                  <dd>
                    <code>{version.sha256}</code>
                  </dd>
                </>
              )}
              <dt>{messages.created}</dt>
              <dd>{new Date(version.createdAt).toLocaleString(locale)}</dd>
            </dl>
            <p className="pc-version-filename" dir="auto">
              {version.originalFilename}
            </p>

            {version.status === 'REJECTED' && (
              <p className="pc-error" role="note">
                {messages.rejections[version.rejectionCode ?? ''] ?? messages.stageRejected}
              </p>
            )}
            {version.status === 'FAILED' && (
              <p className="pc-warning" role="note">
                {messages.failedExplanation} {messages.failedNotInvalid}
              </p>
            )}

            <div className="pc-actions">
              {version.status === 'READY' && (
                <button type="button" onClick={() => onDownload(version)} disabled={busy}>
                  {busy ? messages.downloadPreparing : messages.download}
                </button>
              )}
              {version.status === 'FAILED' && version.retryable && (
                <button type="button" onClick={() => onRetry(version)} disabled={busy}>
                  {messages.retryProcessing}
                </button>
              )}
            </div>
          </li>
        );
      })}
    </ul>
  );
}
