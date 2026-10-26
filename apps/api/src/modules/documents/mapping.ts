import {
  DocumentVersionStatus,
  type DocumentFailureCode,
  type DocumentFormat,
  type DocumentRejectionCode,
  type DocumentStatus,
  type DocumentVersionView,
  type DocumentView,
} from '@palcert/contracts';
import type { Document, DocumentVersion, UploadSession } from '@palcert/database';

export type VersionRow = DocumentVersion & { uploadSession?: UploadSession | null };

const iso = (value: Date | null | undefined): string | null => (value ? value.toISOString() : null);

/**
 * The owner's view of a version. Storage keys, bucket names, object version
 * ids, etags, scanner internals and operator diagnostics are deliberately
 * absent (§76, §37).
 */
export function toDocumentVersionView(row: VersionRow): DocumentVersionView {
  return {
    id: row.id,
    documentId: row.documentId,
    versionNumber: row.versionNumber,
    status: row.status as DocumentVersionStatus,
    originalFilename: row.originalFilename,
    declaredMimeType: row.declaredMimeType,
    detectedMimeType: row.detectedMimeType,
    detectedFormat: (row.detectedFormat as DocumentFormat | null) ?? null,
    sizeBytes: row.sizeBytes,
    sha256: row.sha256,
    rejectionCode: (row.rejectionCode as DocumentRejectionCode | null) ?? null,
    failureCode: (row.failureCode as DocumentFailureCode | null) ?? null,
    retryable: row.status === DocumentVersionStatus.FAILED && row.quarantineDeletedAt === null,
    uploadExpiresAt:
      row.status === DocumentVersionStatus.AWAITING_UPLOAD
        ? iso(row.uploadSession?.expiresAt ?? null)
        : null,
    createdAt: row.createdAt.toISOString(),
    uploadedAt: iso(row.uploadedAt),
    validatedAt: iso(row.validatedAt),
    scannedAt: iso(row.scannedAt),
    readyAt: iso(row.readyAt),
    rejectedAt: iso(row.rejectedAt),
    failedAt: iso(row.failedAt),
  };
}

export function toDocumentView(row: Document & { versions?: VersionRow[] }): DocumentView {
  const latest = row.versions?.[0];
  return {
    id: row.id,
    displayName: row.displayName,
    status: row.status as DocumentStatus,
    latestVersion: latest ? toDocumentVersionView(latest) : null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}
