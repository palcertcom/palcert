import { Injectable } from '@nestjs/common';
import {
  AppError,
  DocumentTypeStatus,
  PalCertErrorCode,
  buildPage,
  decodeCursor,
  encodeCursor,
  resolveLimit,
  type DocumentSystemCategory,
  type DocumentTypeView,
  type Page,
} from '@palcert/contracts';
import type { Prisma } from '@palcert/database';
import {
  TenantPrismaService,
  type TenantClient,
} from '../../../infrastructure/tenant/tenant-prisma.service';
import { ClockPort } from '../../auth/ports/clock.port';
import { SecurityEventService } from '../../auth/services/security-event.service';
import type { TenantContext } from '../../organizations/tenant-context';
import { assertPlainText } from './text-safety';

export interface CreateDocumentTypeParams {
  readonly systemCategory: DocumentSystemCategory;
  readonly name: string;
  readonly nameAr?: string | undefined;
  readonly description?: string | undefined;
  readonly descriptionAr?: string | undefined;
}

export type UpdateDocumentTypeParams = Partial<CreateDocumentTypeParams>;

export interface RequestContext {
  readonly requestId: string | null;
  readonly ipAddress: string | null;
}

interface DocumentTypeRow {
  id: string;
  systemCategory: string;
  name: string;
  nameAr: string | null;
  description: string | null;
  descriptionAr: string | null;
  status: string;
  createdAt: Date;
  updatedAt: Date;
  _count?: { standards: number };
}

@Injectable()
export class DocumentTypeService {
  constructor(
    private readonly tenant: TenantPrismaService,
    private readonly events: SecurityEventService,
    private readonly clock: ClockPort,
  ) {}

  async list(
    context: TenantContext,
    query: { cursor?: string | undefined; limit?: number | undefined; status?: string | undefined },
  ): Promise<Page<DocumentTypeView>> {
    const limit = resolveLimit(query.limit);
    const cursor = parseCursor(query.cursor);

    const rows = await this.tenant.withTenant(scopeOf(context), (tx) =>
      tx.documentType.findMany({
        where: {
          ...(query.status === undefined ? {} : { status: query.status as DocumentTypeStatus }),
          // Sorted by name, tie-broken by id, exactly as ADR-0020 requires: the
          // business column alone is not unique, so a page boundary landing on
          // two identical names would skip or repeat one of them.
          ...(cursor === null
            ? {}
            : {
                OR: [
                  { name: { gt: cursor.sortValue } },
                  { name: cursor.sortValue, id: { gt: cursor.id } },
                ],
              }),
        },
        orderBy: [{ name: 'asc' }, { id: 'asc' }],
        take: limit + 1,
        include: { _count: { select: { standards: true } } },
      }),
    );

    return buildPage(rows.map(toView), limit, (item) => encodeCursor(item.name, item.id));
  }

  async get(context: TenantContext, documentTypeId: string): Promise<DocumentTypeView> {
    const row = await this.tenant.withTenant(scopeOf(context), (tx) =>
      tx.documentType.findUnique({
        where: { id: documentTypeId },
        include: { _count: { select: { standards: true } } },
      }),
    );

    // Row-level security means a document type belonging to another tenant is
    // simply not there, so "not yours" and "does not exist" are already the
    // same answer — no separate ownership check to forget.
    if (row === null) throw notFound();
    return toView(row);
  }

  async create(
    context: TenantContext,
    params: CreateDocumentTypeParams,
    request: RequestContext,
  ): Promise<DocumentTypeView> {
    assertDocumentTypeTextIsSafe(params);

    const row = await this.tenant
      .withTenant(scopeOf(context), async (tx) => {
        if (await nameIsTaken(tx, params.name, null)) throw nameTaken();

        return tx.documentType.create({
          data: {
            organizationId: context.organizationId,
            systemCategory: params.systemCategory,
            name: params.name,
            nameAr: params.nameAr ?? null,
            description: params.description ?? null,
            descriptionAr: params.descriptionAr ?? null,
            createdByUserId: context.userId,
          },
          include: { _count: { select: { standards: true } } },
        });
      })
      .catch(rethrowNameConflict);

    await this.events.audit({
      action: 'DOCUMENT_TYPE_CREATED',
      actorUserId: context.userId,
      targetType: 'DocumentType',
      targetId: row.id,
      requestId: request.requestId,
      ipAddress: request.ipAddress,
      afterState: { name: row.name, systemCategory: row.systemCategory },
    });

    return toView(row);
  }

  async update(
    context: TenantContext,
    documentTypeId: string,
    params: UpdateDocumentTypeParams,
    request: RequestContext,
  ): Promise<DocumentTypeView> {
    assertDocumentTypeTextIsSafe(params);

    const before = await this.get(context, documentTypeId);

    const row = await this.tenant
      .withTenant(scopeOf(context), async (tx) => {
        if (params.name !== undefined && (await nameIsTaken(tx, params.name, documentTypeId))) {
          throw nameTaken();
        }

        return tx.documentType.update({
          where: { id: documentTypeId },
          data: {
            ...(params.systemCategory === undefined
              ? {}
              : { systemCategory: params.systemCategory }),
            ...(params.name === undefined ? {} : { name: params.name }),
            ...(params.nameAr === undefined ? {} : { nameAr: params.nameAr || null }),
            ...(params.description === undefined
              ? {}
              : { description: params.description || null }),
            ...(params.descriptionAr === undefined
              ? {}
              : { descriptionAr: params.descriptionAr || null }),
          },
          include: { _count: { select: { standards: true } } },
        });
      })
      .catch(rethrowNameConflict);

    await this.events.audit({
      action: 'DOCUMENT_TYPE_UPDATED',
      actorUserId: context.userId,
      targetType: 'DocumentType',
      targetId: documentTypeId,
      requestId: request.requestId,
      ipAddress: request.ipAddress,
      beforeState: { name: before.name, systemCategory: before.systemCategory },
      afterState: { name: row.name, systemCategory: row.systemCategory },
    });

    return toView(row);
  }

  /**
   * Archive a document type.
   *
   * Refused while standards still reference it. Cascading would orphan them;
   * silently allowing it would leave a picker offering a type whose standards
   * are unreachable. Telling the author to move or archive those standards
   * first is the only honest option.
   */
  async archive(
    context: TenantContext,
    documentTypeId: string,
    request: RequestContext,
  ): Promise<DocumentTypeView> {
    const current = await this.get(context, documentTypeId);

    if (current.status === DocumentTypeStatus.ARCHIVED) {
      throw new AppError(PalCertErrorCode.DOCUMENT_TYPE_ARCHIVED, {
        message: 'This document type is already archived.',
      });
    }

    const activeStandards = await this.tenant.withTenant(scopeOf(context), (tx) =>
      tx.standard.count({ where: { documentTypeId, status: 'ACTIVE' } }),
    );

    if (activeStandards > 0) {
      throw new AppError(PalCertErrorCode.DOCUMENT_TYPE_IN_USE, {
        message:
          `${activeStandards} active standard(s) still use this document type. Archive or move ` +
          'them before archiving the type.',
        details: { activeStandards },
      });
    }

    return this.setStatus(context, documentTypeId, DocumentTypeStatus.ARCHIVED, request);
  }

  async restore(
    context: TenantContext,
    documentTypeId: string,
    request: RequestContext,
  ): Promise<DocumentTypeView> {
    const current = await this.get(context, documentTypeId);
    if (current.status === DocumentTypeStatus.ACTIVE) {
      throw new AppError(PalCertErrorCode.CONFLICT, {
        message: 'This document type is already active.',
      });
    }
    return this.setStatus(context, documentTypeId, DocumentTypeStatus.ACTIVE, request);
  }

  private async setStatus(
    context: TenantContext,
    documentTypeId: string,
    status: DocumentTypeStatus,
    request: RequestContext,
  ): Promise<DocumentTypeView> {
    const row = await this.tenant.withTenant(scopeOf(context), (tx) =>
      tx.documentType.update({
        where: { id: documentTypeId },
        data: {
          status,
          archivedAt: status === DocumentTypeStatus.ARCHIVED ? this.clock.now() : null,
        },
        include: { _count: { select: { standards: true } } },
      }),
    );

    await this.events.audit({
      action:
        status === DocumentTypeStatus.ARCHIVED
          ? 'DOCUMENT_TYPE_ARCHIVED'
          : 'DOCUMENT_TYPE_RESTORED',
      actorUserId: context.userId,
      targetType: 'DocumentType',
      targetId: documentTypeId,
      requestId: request.requestId,
      ipAddress: request.ipAddress,
      afterState: { status },
    });

    return toView(row);
  }
}

function scopeOf(context: TenantContext): { organizationId: string; userId: string } {
  return { organizationId: context.organizationId, userId: context.userId };
}

function parseCursor(cursor: string | undefined): { sortValue: string; id: string } | null {
  if (cursor === undefined) return null;
  const decoded = decodeCursor(cursor);
  if (decoded === null) {
    throw new AppError(PalCertErrorCode.VALIDATION_FAILED, {
      message: 'That page cursor is not one this API issued.',
      details: { field: 'cursor' },
    });
  }
  return decoded;
}

function notFound(): AppError {
  return new AppError(PalCertErrorCode.DOCUMENT_TYPE_NOT_FOUND, {
    message: 'That document type does not exist.',
  });
}

function assertDocumentTypeTextIsSafe(params: UpdateDocumentTypeParams): void {
  assertPlainText('name', params.name);
  assertPlainText('nameAr', params.nameAr);
  assertPlainText('description', params.description);
  assertPlainText('descriptionAr', params.descriptionAr);
}

/**
 * Backstop for a name collision that slips past the pre-check.
 *
 * The pre-check inside the transaction produces this error in every ordinary
 * case; this exists for the genuine race, where two concurrent creates both
 * find the name free and the unique index arbitrates. Without it that race
 * would surface as a 500.
 *
 * Discrimination is by model rather than by constraint name: under the
 * least-privileged application role PostgreSQL does not hand Prisma the
 * constraint, so `meta.target` is null (the driver reports "Unique constraint
 * failed on the (not available)"). `document_types` has exactly one
 * user-reachable unique constraint — the case-insensitive name — so the model
 * alone identifies it. The other, `(id, organization_id)`, can only be violated
 * by a UUID collision.
 */
function rethrowNameConflict(error: unknown): never {
  const code = (error as { code?: string }).code;
  const model = (error as { meta?: { modelName?: string } }).meta?.modelName;

  if (code === 'P2002' && model === 'DocumentType') {
    throw nameTaken();
  }
  throw error as Error;
}

function nameTaken(): AppError {
  return new AppError(PalCertErrorCode.DOCUMENT_TYPE_NAME_TAKEN, {
    message: 'A document type with that name already exists in this organization.',
  });
}

/**
 * Is this name already used in the tenant, ignoring case?
 *
 * Raw SQL rather than Prisma's `mode: 'insensitive'`, which compiles to ILIKE
 * and would treat `%` and `_` in a user-supplied name as wildcards. This
 * mirrors the `lower(name)` unique index exactly.
 */
async function nameIsTaken(
  tx: TenantClient,
  name: string,
  excludingId: string | null,
): Promise<boolean> {
  const rows = await tx.$queryRaw<Array<{ taken: boolean }>>`
    SELECT EXISTS (
      SELECT 1 FROM "document_types"
      WHERE lower("name") = lower(${name})
        AND ("id" <> ${excludingId}::uuid OR ${excludingId}::uuid IS NULL)
    ) AS taken
  `;
  return rows[0]?.taken === true;
}

function toView(row: DocumentTypeRow): DocumentTypeView {
  return {
    id: row.id,
    systemCategory: row.systemCategory as DocumentSystemCategory,
    name: row.name,
    nameAr: row.nameAr,
    description: row.description,
    descriptionAr: row.descriptionAr,
    status: row.status as DocumentTypeStatus,
    standardCount: row._count?.standards ?? 0,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export type { Prisma };
