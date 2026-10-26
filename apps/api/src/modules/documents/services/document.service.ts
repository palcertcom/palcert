import { Injectable } from '@nestjs/common';
import {
  AppError,
  DocumentAuditAction,
  DocumentStatus,
  DocumentVersionStatus,
  PalCertErrorCode,
  ProcessingJobType,
  buildPage,
  decodeCursor,
  encodeCursor,
  resolveLimit,
  type DocumentView,
  type Page,
} from '@palcert/contracts';
import { OutboxDispatcher } from '../../../infrastructure/queue/outbox-dispatcher';
import { ProcessingJobService } from '../../../infrastructure/queue/processing-job.service';
import {
  TenantPrismaService,
  type TenantClient,
} from '../../../infrastructure/tenant/tenant-prisma.service';
import { ClockPort } from '../../auth/ports/clock.port';
import { SecurityEventService } from '../../auth/services/security-event.service';
import { assertPlainText } from '../../standards/services/text-safety';
import { toDocumentView } from '../mapping';

export interface RequestContext {
  readonly requestId: string | null;
  readonly ipAddress: string | null;
}

/** Newest version first; what the list and the detail page both show. */
const LATEST_VERSION = {
  versions: {
    orderBy: { versionNumber: 'desc' as const },
    take: 1,
    include: { uploadSession: true },
  },
};

/**
 * A user's documents (ADR-0031).
 *
 * Every read and write runs under `withUser`, so row-level security confines
 * it to the caller's own rows, and a foreign identifier is simply not found.
 * Nothing here takes an organization: documents have none.
 */
@Injectable()
export class DocumentService {
  constructor(
    private readonly tenant: TenantPrismaService,
    private readonly events: SecurityEventService,
    private readonly jobs: ProcessingJobService,
    private readonly dispatcher: OutboxDispatcher,
    private readonly clock: ClockPort,
  ) {}

  async list(
    userId: string,
    query: { cursor?: string | undefined; limit?: number | undefined },
  ): Promise<Page<DocumentView>> {
    const limit = resolveLimit(query.limit);
    const cursor = parseCursor(query.cursor);

    const rows = await this.tenant.withUser(userId, (tx) =>
      tx.document.findMany({
        where: {
          ownerUserId: userId,
          status: DocumentStatus.ACTIVE,
          ...(cursor === null
            ? {}
            : {
                OR: [
                  { updatedAt: { lt: new Date(cursor.sortValue) } },
                  { updatedAt: new Date(cursor.sortValue), id: { gt: cursor.id } },
                ],
              }),
        },
        orderBy: [{ updatedAt: 'desc' }, { id: 'asc' }],
        take: limit + 1,
        include: LATEST_VERSION,
      }),
    );

    return buildPage(rows.map(toDocumentView), limit, (item) =>
      encodeCursor(item.updatedAt, item.id),
    );
  }

  async get(userId: string, documentId: string): Promise<DocumentView> {
    const row = await this.tenant.withUser(userId, (tx) => loadDocument(tx, documentId));
    return toDocumentView(row);
  }

  async create(
    userId: string,
    displayName: string,
    request: RequestContext,
  ): Promise<DocumentView> {
    assertPlainText('displayName', displayName);

    const row = await this.tenant.withUser(userId, (tx) =>
      tx.document.create({
        data: { ownerUserId: userId, displayName, status: DocumentStatus.ACTIVE },
        include: LATEST_VERSION,
      }),
    );

    await this.events.audit({
      action: DocumentAuditAction.DOCUMENT_CREATED,
      actorUserId: userId,
      targetType: 'Document',
      targetId: row.id,
      requestId: request.requestId,
      ipAddress: request.ipAddress,
    });

    return toDocumentView(row);
  }

  async update(
    userId: string,
    documentId: string,
    params: { displayName?: string | undefined },
    request: RequestContext,
  ): Promise<DocumentView> {
    assertPlainText('displayName', params.displayName);

    const row = await this.tenant.withUser(userId, async (tx) => {
      await loadDocument(tx, documentId);
      return tx.document.update({
        where: { id: documentId },
        data: { ...(params.displayName === undefined ? {} : { displayName: params.displayName }) },
        include: LATEST_VERSION,
      });
    });

    await this.events.audit({
      action: DocumentAuditAction.DOCUMENT_UPDATED,
      actorUserId: userId,
      targetType: 'Document',
      targetId: documentId,
      requestId: request.requestId,
      ipAddress: request.ipAddress,
    });

    return toDocumentView(row);
  }

  /**
   * Soft delete (§83, §84).
   *
   * The row is marked and hidden immediately; the objects are removed by a
   * purge job that refuses while any retention lock exists and records each
   * object as gone only once storage confirms it. Nothing later can find a
   * deleted document through the normal API.
   */
  async remove(userId: string, documentId: string, request: RequestContext): Promise<void> {
    const now = this.clock.now();
    const job = await this.tenant.withUser(userId, async (tx) => {
      await loadDocument(tx, documentId);

      await tx.document.update({
        where: { id: documentId },
        data: { status: DocumentStatus.DELETED, deletedAt: now },
      });
      // Abandon any upload still in flight; its staged object is purged too.
      await tx.uploadSession.updateMany({
        where: { documentId, status: 'CREATED' },
        data: { status: 'CANCELLED', cancelledAt: now },
      });
      await tx.documentVersion.updateMany({
        where: { documentId, status: DocumentVersionStatus.AWAITING_UPLOAD },
        data: { status: DocumentVersionStatus.CANCELLED },
      });

      return this.jobs.enqueueInTransaction(tx, {
        type: ProcessingJobType.DOCUMENT_PURGE,
        resourceType: 'DOCUMENT',
        resourceId: documentId,
        ownerUserId: userId,
      });
    });

    await this.events.audit({
      action: DocumentAuditAction.DOCUMENT_DELETED,
      actorUserId: userId,
      targetType: 'Document',
      targetId: documentId,
      requestId: request.requestId,
      ipAddress: request.ipAddress,
    });

    await this.dispatcher.dispatchNow(job.id);
  }
}

/** The caller's own, live document — or not found, whoever else owns it. */
export async function loadDocument(tx: TenantClient, documentId: string) {
  const row = await tx.document.findUnique({ where: { id: documentId } });
  if (row === null) {
    throw new AppError(PalCertErrorCode.DOCUMENT_NOT_FOUND, {
      message: 'That document does not exist.',
    });
  }
  if (row.status === DocumentStatus.DELETED) {
    throw new AppError(PalCertErrorCode.DOCUMENT_DELETED, {
      message: 'That document has been deleted.',
    });
  }
  return row;
}

function parseCursor(cursor: string | undefined): { sortValue: string; id: string } | null {
  if (cursor === undefined) return null;
  const decoded = decodeCursor(cursor);
  if (decoded === null || Number.isNaN(Date.parse(decoded.sortValue))) {
    throw new AppError(PalCertErrorCode.VALIDATION_FAILED, {
      message: 'That page cursor is not one this API issued.',
      details: { field: 'cursor' },
    });
  }
  return decoded;
}
