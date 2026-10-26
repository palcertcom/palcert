import { Injectable } from '@nestjs/common';
import {
  AppError,
  CANONICAL_MIME_TYPES,
  PalCertErrorCode,
  SubmissionProcessingStatus,
  contentDispositionAttachment,
  type DocumentFormat,
  type DownloadAuthorizationView,
} from '@palcert/contracts';
import type { SubmissionRevision } from '@palcert/database';
import { ApiConfigService } from '../../../config/api-config.service';
import {
  ObjectStoragePort,
  ObjectStorageUnavailableError,
} from '../../../infrastructure/storage/object-storage.port';
import { TenantPrismaService } from '../../../infrastructure/tenant/tenant-prisma.service';
import { SecurityEventService } from '../../auth/services/security-event.service';
import type { TenantContext } from '../../organizations/tenant-context';

/** What a caller may fetch from one revision's evidence. */
export type SnapshotKind = 'document' | 'report';

/**
 * Handing out the submitted bytes, to either party (§78, §79).
 *
 * Nothing about the snapshot is public. The objects live under an
 * organization-scoped key with no name, email or title in it; the bucket
 * grants nothing to anonymous readers; and every fetch is a fresh signed GET
 * that expires in minutes. There is no permanent URL to leak, and knowing a
 * key buys nothing without a signature.
 *
 * Both parties come through here, and each is authorized by the thing that
 * makes them a party: the author because the revision is theirs, the
 * organization because the revision was handed to it. Neither authorization
 * reaches the private original — this signs the *snapshot*, which is why an
 * organization getting a URL here gains no access to the document, the check
 * or any other version (§26).
 */
@Injectable()
export class SubmissionDownloadService {
  constructor(
    private readonly tenant: TenantPrismaService,
    private readonly storage: ObjectStoragePort,
    private readonly events: SecurityEventService,
    private readonly config: ApiConfigService,
  ) {}

  /** The author fetching evidence they submitted. */
  async forSubmitter(
    userId: string,
    revisionId: string,
    kind: SnapshotKind,
  ): Promise<DownloadAuthorizationView> {
    const revision = await this.tenant.withUser(userId, (tx) =>
      tx.submissionRevision.findFirst({ where: { id: revisionId, ownerUserId: userId } }),
    );
    return this.sign(revision, kind, userId, null);
  }

  /** A reviewer fetching evidence their organization was handed. */
  async forOrganization(
    context: TenantContext,
    revisionId: string,
    kind: SnapshotKind,
  ): Promise<DownloadAuthorizationView> {
    const revision = await this.tenant.withTenant(
      { organizationId: context.organizationId, userId: context.userId },
      (tx) =>
        tx.submissionRevision.findFirst({
          where: { id: revisionId, organizationId: context.organizationId },
        }),
    );
    return this.sign(revision, kind, context.userId, context.organizationId);
  }

  private async sign(
    revision: SubmissionRevision | null,
    kind: SnapshotKind,
    actorUserId: string,
    organizationId: string | null,
  ): Promise<DownloadAuthorizationView> {
    // §90: an id the caller is not a party to is not found, never forbidden.
    if (revision === null) {
      throw new AppError(PalCertErrorCode.SUBMISSION_REVISION_NOT_FOUND, {
        message: 'That submission revision does not exist.',
      });
    }
    if (revision.processingStatus !== SubmissionProcessingStatus.READY) {
      throw new AppError(PalCertErrorCode.SUBMISSION_NOT_READY, {
        message: 'That submission is still being prepared.',
      });
    }

    const key = kind === 'document' ? revision.documentSnapshotKey : revision.reportSnapshotKey;
    const versionId =
      kind === 'document' ? revision.documentSnapshotVersionId : revision.reportSnapshotVersionId;
    if (key === null) {
      throw new AppError(PalCertErrorCode.SUBMISSION_NOT_READY, {
        message: 'That submission is still being prepared.',
      });
    }

    // §78: the filename is generic on purpose. A snapshot handed to an
    // institution must not carry the author's own filename into their systems,
    // and a key that named the document would leak a title to anyone who saw
    // a URL.
    const filename =
      kind === 'document'
        ? `submission-${revision.revisionNumber}.${extensionOf(revision.sourceDocumentFormat as DocumentFormat)}`
        : `submission-${revision.revisionNumber}-report.json`;

    const grant = await this.storage
      .createDownloadAuthorization({
        ref: { zone: 'derived', key, versionId },
        expiresInSeconds: this.config.storage.downloadUrlTtlSeconds,
        contentDisposition: contentDispositionAttachment(filename),
        contentType:
          kind === 'document'
            ? CANONICAL_MIME_TYPES[revision.sourceDocumentFormat as DocumentFormat]
            : 'application/json',
      })
      .catch((error: unknown) => {
        if (error instanceof ObjectStorageUnavailableError) {
          throw new AppError(PalCertErrorCode.STORAGE_UNAVAILABLE, {
            message: 'Storage is temporarily unavailable. Please try again.',
          });
        }
        throw error;
      });

    await this.events.audit({
      action: 'SUBMISSION_SNAPSHOT_DOWNLOADED',
      actorUserId,
      targetType: 'SubmissionRevision',
      targetId: revision.id,
      afterState: { kind, organizationId },
    });

    return {
      method: 'GET',
      url: grant.url,
      expiresAt: grant.expiresAt.toISOString(),
      filename,
    };
  }
}

function extensionOf(format: DocumentFormat): string {
  return format === 'PDF' ? 'pdf' : 'docx';
}
