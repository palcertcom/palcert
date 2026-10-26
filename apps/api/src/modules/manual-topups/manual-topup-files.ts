import { Injectable } from '@nestjs/common';
import {
  AppError,
  MANUAL_TOPUP_FILE_MIME_TYPES,
  ManualTopUpFileStatus,
  PalCertErrorCode,
  SHA256_HEX_PATTERN,
  contentDispositionAttachment,
  manualTopUpFormatForFilename,
  sanitizeOriginalFilename,
  type DownloadAuthorizationView,
  type ManualTopUpFileFormat,
  type ManualTopUpUploadAuthorizationView,
} from '@palcert/contracts';
import { ApiConfigService } from '../../config/api-config.service';
import { ObjectStoragePort } from '../../infrastructure/storage/object-storage.port';
import { ClockPort } from '../auth/ports/clock.port';
import { storageUnavailable } from './manual-topup-support';

/** The columns of a receipt or logo row that uploading and serving need. */
export interface ManualTopUpFileRow {
  readonly status: string;
  readonly originalFilename: string;
  readonly expectedFormat: string;
  readonly detectedFormat: string | null;
  readonly declaredSizeBytes: number;
  readonly maxFileBytes: number;
  readonly clientSha256: string | null;
  readonly quarantineObjectKey: string;
  readonly cleanObjectKey: string | null;
  readonly cleanObjectVersionId: string | null;
  readonly uploadExpiresAt: Date;
}

export interface ValidatedUpload {
  readonly originalFilename: string;
  readonly expectedFormat: ManualTopUpFileFormat;
  readonly sizeBytes: number;
  readonly clientSha256: string | null;
  readonly declaredMimeType: string | null;
  readonly uploadExpiresAt: Date;
}

/**
 * The upload and download mechanics receipts and logos share.
 *
 * Exactly the secure path every other PalCert upload takes: the filename is
 * sanitized and only ever *claims* a type (the worker's signature detection
 * decides), the browser writes to a short-lived presigned URL for a
 * server-generated quarantine key, and nothing is served before it has been
 * scanned and promoted to the clean zone — and then only by a short-lived
 * signed URL bound to the exact object version.
 */
@Injectable()
export class ManualTopUpFiles {
  constructor(
    private readonly storage: ObjectStoragePort,
    private readonly config: ApiConfigService,
    private readonly clock: ClockPort,
  ) {}

  validate(
    input: {
      readonly originalFilename: string;
      readonly declaredMimeType?: string | undefined;
      readonly sizeBytes: number;
      readonly sha256?: string | undefined;
    },
    allowed: readonly ManualTopUpFileFormat[],
    maxBytes: number,
    message: string,
  ): ValidatedUpload {
    const originalFilename = sanitizeOriginalFilename(input.originalFilename);
    const expectedFormat = manualTopUpFormatForFilename(originalFilename, allowed);
    if (expectedFormat === null) {
      throw new AppError(PalCertErrorCode.MANUAL_TOPUP_FILE_TYPE_NOT_ALLOWED, {
        message,
        details: { allowedFormats: allowed },
      });
    }
    if (!Number.isInteger(input.sizeBytes) || input.sizeBytes < 1 || input.sizeBytes > maxBytes) {
      throw new AppError(PalCertErrorCode.FILE_TOO_LARGE, {
        message: `The file may be at most ${maxBytes} bytes.`,
        details: { maxBytes },
      });
    }
    const clientSha256 = input.sha256?.toLowerCase() ?? null;
    if (clientSha256 !== null && !SHA256_HEX_PATTERN.test(clientSha256)) {
      throw new AppError(PalCertErrorCode.VALIDATION_FAILED, {
        message: 'sha256 must be 64 lowercase hexadecimal characters.',
      });
    }
    return {
      originalFilename,
      expectedFormat,
      sizeBytes: input.sizeBytes,
      clientSha256,
      declaredMimeType: input.declaredMimeType?.trim().slice(0, 255) || null,
      uploadExpiresAt: new Date(
        this.clock.now().getTime() + this.config.upload.sessionTtlSeconds * 1000,
      ),
    };
  }

  /** A presigned PUT for the row's quarantine key, never outliving the upload window. */
  async authorizeUpload(row: ManualTopUpFileRow): Promise<ManualTopUpUploadAuthorizationView> {
    const remaining = Math.floor(
      (row.uploadExpiresAt.getTime() - this.clock.now().getTime()) / 1000,
    );
    const ttl = Math.max(30, Math.min(this.config.storage.uploadUrlTtlSeconds, remaining));
    const grant = await this.storage
      .createUploadAuthorization({
        zone: 'quarantine',
        key: row.quarantineObjectKey,
        contentLength: row.declaredSizeBytes,
        contentType: MANUAL_TOPUP_FILE_MIME_TYPES[row.expectedFormat as ManualTopUpFileFormat],
        sha256Hex: row.clientSha256,
        expiresInSeconds: ttl,
      })
      .catch((error: unknown) => {
        throw storageUnavailable(error);
      });
    return {
      method: 'PUT',
      url: grant.url,
      headers: { ...grant.headers },
      expiresAt: grant.expiresAt.toISOString(),
    };
  }

  /**
   * Check the staged object before it is accepted: it exists, and it is the
   * size the upload was authorized for. Outside any transaction, so a storage
   * round trip never holds a row lock.
   */
  async staged(
    row: ManualTopUpFileRow,
  ): Promise<{ versionId: string | null; etag: string | null }> {
    if (row.uploadExpiresAt.getTime() <= this.clock.now().getTime()) {
      throw new AppError(PalCertErrorCode.UPLOAD_SESSION_EXPIRED, {
        message: 'This upload authorization has expired. Upload the file again.',
      });
    }
    const staged = await this.storage
      .headObject({ zone: 'quarantine', key: row.quarantineObjectKey })
      .catch((error: unknown) => {
        throw storageUnavailable(error);
      });
    if (staged === null) {
      throw new AppError(PalCertErrorCode.UPLOAD_OBJECT_NOT_FOUND, {
        message: 'Nothing has been uploaded for this file yet.',
      });
    }
    if (staged.sizeBytes > row.maxFileBytes) {
      throw new AppError(PalCertErrorCode.FILE_TOO_LARGE, {
        message: `The file may be at most ${row.maxFileBytes} bytes.`,
        details: { maxBytes: row.maxFileBytes },
      });
    }
    if (staged.sizeBytes !== row.declaredSizeBytes) {
      throw new AppError(PalCertErrorCode.UPLOAD_SIZE_MISMATCH, {
        message: 'The uploaded file is not the size this upload was authorized for.',
        details: { declaredSizeBytes: row.declaredSizeBytes, uploadedSizeBytes: staged.sizeBytes },
      });
    }
    return { versionId: staged.versionId, etag: staged.etag };
  }

  /** A short-lived signed URL for a scanned file the caller is already authorized to see. */
  async download(
    row: ManualTopUpFileRow,
    disposition: 'attachment' | 'inline',
  ): Promise<DownloadAuthorizationView> {
    if (row.status !== ManualTopUpFileStatus.READY || row.cleanObjectKey === null) {
      throw new AppError(PalCertErrorCode.MANUAL_TOPUP_FILE_NOT_READY, {
        message: 'This file is not available.',
      });
    }
    const attachment = contentDispositionAttachment(row.originalFilename);
    const grant = await this.storage
      .createDownloadAuthorization({
        ref: { zone: 'clean', key: row.cleanObjectKey, versionId: row.cleanObjectVersionId },
        expiresInSeconds: this.config.storage.downloadUrlTtlSeconds,
        contentType:
          row.detectedFormat === null
            ? 'application/octet-stream'
            : MANUAL_TOPUP_FILE_MIME_TYPES[row.detectedFormat as ManualTopUpFileFormat],
        contentDisposition:
          disposition === 'inline' ? attachment.replace(/^attachment/, 'inline') : attachment,
      })
      .catch((error: unknown) => {
        throw storageUnavailable(error);
      });
    return {
      method: 'GET',
      url: grant.url,
      expiresAt: grant.expiresAt.toISOString(),
      filename: row.originalFilename,
    };
  }
}
