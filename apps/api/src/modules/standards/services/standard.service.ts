import { Injectable } from '@nestjs/common';
import {
  AppError,
  PalCertErrorCode,
  StandardStatus,
  buildPage,
  decodeCursor,
  encodeCursor,
  isValidStandardCode,
  resolveLimit,
  type DocumentSystemCategory,
  type Page,
  type StandardCheckAvailability,
  type StandardView,
} from '@palcert/contracts';
import { TenantPrismaService } from '../../../infrastructure/tenant/tenant-prisma.service';
import { ClockPort } from '../../auth/ports/clock.port';
import { SecurityEventService } from '../../auth/services/security-event.service';
import type { TenantContext } from '../../organizations/tenant-context';
import { assertPlainText } from './text-safety';

export interface CreateStandardParams {
  readonly documentTypeId: string;
  readonly code: string;
  readonly nameEn: string;
  readonly nameAr: string;
  readonly descriptionEn?: string | undefined;
  readonly descriptionAr?: string | undefined;
}

export interface UpdateStandardParams {
  readonly documentTypeId?: string | undefined;
  readonly nameEn?: string | undefined;
  readonly nameAr?: string | undefined;
  readonly descriptionEn?: string | undefined;
  readonly descriptionAr?: string | undefined;
}

export interface StandardListQuery {
  readonly cursor?: string | undefined;
  readonly limit?: number | undefined;
  readonly status?: string | undefined;
  readonly documentTypeId?: string | undefined;
  readonly search?: string | undefined;
}

export interface RequestContext {
  readonly requestId: string | null;
  readonly ipAddress: string | null;
}

interface StandardRow {
  id: string;
  documentTypeId: string;
  code: string;
  nameEn: string;
  nameAr: string;
  descriptionEn: string | null;
  descriptionAr: string | null;
  status: string;
  checkAvailability: string;
  createdAt: Date;
  updatedAt: Date;
  documentType?: { name: string; systemCategory: string };
  _count?: { versions: number };
  versions?: Array<{ id: string; versionLabel: string }>;
}

/**
 * Everything a standard read needs, in one place.
 *
 * `versions` is filtered to the single published one: the summary shows what is
 * currently in force, and loading a standard's whole version history to find it
 * would be wasteful on a list endpoint.
 */
const STANDARD_INCLUDE = {
  documentType: { select: { name: true, systemCategory: true } },
  _count: { select: { versions: true } },
  versions: {
    where: { status: 'PUBLISHED' as const },
    select: { id: true, versionLabel: true },
    take: 1,
  },
};

@Injectable()
export class StandardService {
  constructor(
    private readonly tenant: TenantPrismaService,
    private readonly events: SecurityEventService,
    private readonly clock: ClockPort,
  ) {}

  async list(context: TenantContext, query: StandardListQuery): Promise<Page<StandardView>> {
    const limit = resolveLimit(query.limit);
    const cursor = parseCursor(query.cursor);
    const search = query.search?.trim();

    const rows = await this.tenant.withTenant(scopeOf(context), (tx) =>
      tx.standard.findMany({
        where: {
          ...(query.status === undefined ? {} : { status: query.status as StandardStatus }),
          ...(query.documentTypeId === undefined ? {} : { documentTypeId: query.documentTypeId }),
          // Search is a filter within the tenant, never a lookup across it: the
          // query runs inside tenant context, so row-level security confines it
          // regardless of what is typed here.
          ...(search === undefined || search === ''
            ? {}
            : {
                OR: [
                  { code: { contains: search, mode: 'insensitive' as const } },
                  { nameEn: { contains: search, mode: 'insensitive' as const } },
                  { nameAr: { contains: search, mode: 'insensitive' as const } },
                ],
              }),
          ...(cursor === null
            ? {}
            : {
                AND: [
                  {
                    OR: [
                      { code: { gt: cursor.sortValue } },
                      { code: cursor.sortValue, id: { gt: cursor.id } },
                    ],
                  },
                ],
              }),
        },
        orderBy: [{ code: 'asc' }, { id: 'asc' }],
        take: limit + 1,
        include: STANDARD_INCLUDE,
      }),
    );

    return buildPage(rows.map(toView), limit, (item) => encodeCursor(item.code, item.id));
  }

  async get(context: TenantContext, standardId: string): Promise<StandardView> {
    const row = await this.tenant.withTenant(scopeOf(context), (tx) =>
      tx.standard.findUnique({ where: { id: standardId }, include: STANDARD_INCLUDE }),
    );
    if (row === null) throw notFound();
    return toView(row);
  }

  async create(
    context: TenantContext,
    params: CreateStandardParams,
    request: RequestContext,
  ): Promise<StandardView> {
    assertStandardTextIsSafe(params);
    assertCodeShape(params.code);

    const row = await this.tenant
      .withTenant(scopeOf(context), async (tx) => {
        // The composite foreign key would refuse a document type from another
        // tenant anyway; this read exists to turn that into a clear 404 rather
        // than an opaque constraint violation, and to reject an archived type
        // before anything is written.
        const documentType = await tx.documentType.findUnique({
          where: { id: params.documentTypeId },
        });
        if (documentType === null) {
          throw new AppError(PalCertErrorCode.DOCUMENT_TYPE_NOT_FOUND, {
            message: 'That document type does not exist.',
          });
        }
        if (documentType.status === 'ARCHIVED') {
          throw new AppError(PalCertErrorCode.DOCUMENT_TYPE_ARCHIVED, {
            message: 'That document type is archived and cannot take new standards.',
          });
        }

        if ((await tx.standard.findFirst({ where: { code: params.code } })) !== null) {
          throw codeTaken();
        }

        return tx.standard.create({
          data: {
            organizationId: context.organizationId,
            documentTypeId: params.documentTypeId,
            code: params.code,
            nameEn: params.nameEn,
            nameAr: params.nameAr,
            descriptionEn: params.descriptionEn ?? null,
            descriptionAr: params.descriptionAr ?? null,
            createdByUserId: context.userId,
          },
          include: STANDARD_INCLUDE,
        });
      })
      .catch(rethrowCodeConflict);

    await this.events.audit({
      action: 'STANDARD_CREATED',
      actorUserId: context.userId,
      targetType: 'Standard',
      targetId: row.id,
      requestId: request.requestId,
      ipAddress: request.ipAddress,
      afterState: { code: row.code, nameEn: row.nameEn },
    });

    return toView(row);
  }

  /**
   * Edit a standard's identity fields.
   *
   * `code` is deliberately absent: it is the stable handle other systems quote,
   * and renaming it would silently invalidate every external reference. A
   * standard that needs a different code is a different standard.
   */
  async update(
    context: TenantContext,
    standardId: string,
    params: UpdateStandardParams,
    request: RequestContext,
  ): Promise<StandardView> {
    assertStandardTextIsSafe(params);

    const before = await this.get(context, standardId);
    if (before.status === StandardStatus.ARCHIVED) {
      throw new AppError(PalCertErrorCode.STANDARD_ARCHIVED, {
        message: 'This standard is archived. Restore it before editing.',
      });
    }

    const row = await this.tenant.withTenant(scopeOf(context), async (tx) => {
      if (params.documentTypeId !== undefined) {
        const documentType = await tx.documentType.findUnique({
          where: { id: params.documentTypeId },
        });
        if (documentType === null) {
          throw new AppError(PalCertErrorCode.DOCUMENT_TYPE_NOT_FOUND, {
            message: 'That document type does not exist.',
          });
        }
        if (documentType.status === 'ARCHIVED') {
          throw new AppError(PalCertErrorCode.DOCUMENT_TYPE_ARCHIVED, {
            message: 'That document type is archived.',
          });
        }
      }

      return tx.standard.update({
        where: { id: standardId },
        data: {
          ...(params.documentTypeId === undefined ? {} : { documentTypeId: params.documentTypeId }),
          ...(params.nameEn === undefined ? {} : { nameEn: params.nameEn }),
          ...(params.nameAr === undefined ? {} : { nameAr: params.nameAr }),
          ...(params.descriptionEn === undefined
            ? {}
            : { descriptionEn: params.descriptionEn || null }),
          ...(params.descriptionAr === undefined
            ? {}
            : { descriptionAr: params.descriptionAr || null }),
        },
        include: STANDARD_INCLUDE,
      });
    });

    await this.events.audit({
      action: 'STANDARD_UPDATED',
      actorUserId: context.userId,
      targetType: 'Standard',
      targetId: standardId,
      requestId: request.requestId,
      ipAddress: request.ipAddress,
      beforeState: { nameEn: before.nameEn, documentTypeId: before.documentTypeId },
      afterState: { nameEn: row.nameEn, documentTypeId: row.documentTypeId },
    });

    return toView(row);
  }

  /**
   * Publish a standard to the check catalogue, or withdraw it (§16, §99).
   *
   * A route of its own, not a field on the general update, and behind its own
   * permission. Making an institution's standard visible to everyone in the
   * world is a deliberate decision with a named actor in the audit log — never
   * something that happens as a side effect of renaming it.
   *
   * Withdrawing it stops new checks. It does not touch checks already running
   * or reports already written: those captured a version, and a version does
   * not become unreadable because the standard later became private (§24).
   */
  async setCheckAvailability(
    context: TenantContext,
    standardId: string,
    availability: StandardCheckAvailability,
    request: RequestContext,
  ): Promise<StandardView> {
    const before = await this.get(context, standardId);
    if (before.status === StandardStatus.ARCHIVED) {
      throw new AppError(PalCertErrorCode.STANDARD_ARCHIVED, {
        message: 'An archived standard cannot be published to the catalogue.',
      });
    }

    const row = await this.tenant.withTenant(scopeOf(context), (tx) =>
      tx.standard.update({
        where: { id: standardId },
        data: { checkAvailability: availability },
        include: STANDARD_INCLUDE,
      }),
    );

    await this.events.audit({
      action: 'STANDARD_CHECK_AVAILABILITY_CHANGED',
      actorUserId: context.userId,
      targetType: 'Standard',
      targetId: standardId,
      requestId: request.requestId,
      ipAddress: request.ipAddress,
      beforeState: { checkAvailability: before.checkAvailability },
      afterState: { checkAvailability: availability },
    });

    return toView(row);
  }

  async archive(
    context: TenantContext,
    standardId: string,
    request: RequestContext,
  ): Promise<StandardView> {
    const current = await this.get(context, standardId);
    if (current.status === StandardStatus.ARCHIVED) {
      throw new AppError(PalCertErrorCode.STANDARD_ARCHIVED, {
        message: 'This standard is already archived.',
      });
    }
    return this.setStatus(context, standardId, StandardStatus.ARCHIVED, request);
  }

  async restore(
    context: TenantContext,
    standardId: string,
    request: RequestContext,
  ): Promise<StandardView> {
    const current = await this.get(context, standardId);
    if (current.status === StandardStatus.ACTIVE) {
      throw new AppError(PalCertErrorCode.CONFLICT, {
        message: 'This standard is already active.',
      });
    }
    return this.setStatus(context, standardId, StandardStatus.ACTIVE, request);
  }

  private async setStatus(
    context: TenantContext,
    standardId: string,
    status: StandardStatus,
    request: RequestContext,
  ): Promise<StandardView> {
    // Archiving a standard deliberately leaves its published versions alone.
    // They stay readable and stay hashed, because documents were judged against
    // them and a past result must remain explainable.
    const row = await this.tenant.withTenant(scopeOf(context), (tx) =>
      tx.standard.update({
        where: { id: standardId },
        data: {
          status,
          archivedAt: status === StandardStatus.ARCHIVED ? this.clock.now() : null,
        },
        include: STANDARD_INCLUDE,
      }),
    );

    await this.events.audit({
      action: status === StandardStatus.ARCHIVED ? 'STANDARD_ARCHIVED' : 'STANDARD_RESTORED',
      actorUserId: context.userId,
      targetType: 'Standard',
      targetId: standardId,
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
  return new AppError(PalCertErrorCode.STANDARD_NOT_FOUND, {
    message: 'That standard does not exist.',
  });
}

function assertCodeShape(code: string): void {
  if (!isValidStandardCode(code)) {
    throw new AppError(PalCertErrorCode.VALIDATION_FAILED, {
      message:
        'code must be UPPERCASE, starting with a letter, with dots, underscores or hyphens ' +
        'between segments — for example IUG.THESIS.FORMAT.',
      details: { field: 'code' },
    });
  }
}

function assertStandardTextIsSafe(params: UpdateStandardParams): void {
  assertPlainText('nameEn', params.nameEn);
  assertPlainText('nameAr', params.nameAr);
  assertPlainText('descriptionEn', params.descriptionEn);
  assertPlainText('descriptionAr', params.descriptionAr);
}

/**
 * Backstop for a code collision that slips past the pre-check.
 *
 * Discriminated by model, not by constraint name: under the least-privileged
 * application role PostgreSQL does not hand Prisma the constraint, so
 * `meta.target` is null. `standards` has one user-reachable unique constraint,
 * `(organization_id, code)`; the other is `(id, organization_id)`, violable
 * only by a UUID collision.
 */
function rethrowCodeConflict(error: unknown): never {
  const prismaCode = (error as { code?: string }).code;
  const model = (error as { meta?: { modelName?: string } }).meta?.modelName;

  if (prismaCode === 'P2002' && model === 'Standard') throw codeTaken();
  throw error as Error;
}

function codeTaken(): AppError {
  return new AppError(PalCertErrorCode.STANDARD_CODE_TAKEN, {
    message: 'A standard with that code already exists in this organization.',
  });
}

function toView(row: StandardRow): StandardView {
  const published = row.versions?.[0];
  return {
    id: row.id,
    documentTypeId: row.documentTypeId,
    documentTypeName: row.documentType?.name ?? '',
    documentTypeCategory: (row.documentType?.systemCategory ?? 'OTHER') as DocumentSystemCategory,
    code: row.code,
    nameEn: row.nameEn,
    nameAr: row.nameAr,
    descriptionEn: row.descriptionEn,
    descriptionAr: row.descriptionAr,
    status: row.status as StandardStatus,
    checkAvailability: row.checkAvailability as StandardCheckAvailability,
    versionCount: row._count?.versions ?? 0,
    publishedVersionId: published?.id ?? null,
    publishedVersionLabel: published?.versionLabel ?? null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}
