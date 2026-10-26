import { randomUUID } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import {
  AppError,
  LOGO_FORMATS,
  LOGO_MAX_BYTES,
  MAX_MANUAL_PAYMENT_METHOD_REVIEWERS,
  MANUAL_PAYMENT_METHOD_CODE_PATTERN,
  MANUAL_TOPUP_LIMITS,
  ManualPaymentMethodType,
  ManualTopUpFileStatus,
  MAX_MINOR_UNITS,
  PalCertErrorCode,
  ProcessingJobType,
  isKnownCurrency,
  money,
  normalizeIban,
  normalizeMobileNumber,
  parseMinorUnits,
  type AdminManualPaymentMethodView,
  type ManualPaymentMethodLogoUploadResponse,
  type ManualPaymentMethodLogoView,
  type ManualPaymentMethodReviewerView,
  type ManualPaymentMethodView,
  type ManualTopUpFileFormat,
  type ManualTopUpReviewerCandidateView,
  type ManualTopUpUploadAuthorizationView,
} from '@palcert/contracts';
import type { ManualPaymentMethod, ManualPaymentMethodLogo } from '@palcert/database';
import { ApiConfigService } from '../../../config/api-config.service';
import { OutboxDispatcher } from '../../../infrastructure/queue/outbox-dispatcher';
import { ProcessingJobService } from '../../../infrastructure/queue/processing-job.service';
import { quarantinePaymentMethodLogoKey } from '../../../infrastructure/storage/storage-keys';
import {
  TenantPrismaService,
  type TenantClient,
} from '../../../infrastructure/tenant/tenant-prisma.service';
import { ClockPort } from '../../auth/ports/clock.port';
import { AuthThrottleService, ThrottleScope } from '../../auth/services/auth-throttle.service';
import { SecurityEventService } from '../../auth/services/security-event.service';
import { ManualTopUpFiles } from '../manual-topup-files';
import {
  cleanText,
  isUniqueViolation,
  methodNotFound,
  type RequestContext,
} from '../manual-topup-support';

/** What an administrator sends to create or edit a method. */
export interface PaymentMethodInput {
  readonly code?: string | undefined;
  readonly type: string;
  readonly nameEn: string;
  readonly nameAr: string;
  readonly descriptionEn?: string | null | undefined;
  readonly descriptionAr?: string | null | undefined;
  readonly currency: string;
  readonly recipientName?: string | null | undefined;
  readonly mobileNumber?: string | null | undefined;
  readonly iban?: string | null | undefined;
  readonly bankName?: string | null | undefined;
  readonly accountNumber?: string | null | undefined;
  readonly branchName?: string | null | undefined;
  readonly instructionsEn?: string | null | undefined;
  readonly instructionsAr?: string | null | undefined;
  readonly minAmountMinorUnits: string;
  readonly maxAmountMinorUnits: string;
  readonly displayOrder?: number | undefined;
  /**
   * The finance staff who review this method's top-ups. Omitted on an edit:
   * unchanged. An empty list: nobody assigned, so every finance reviewer is
   * alerted, as for methods made before assignment existed.
   */
  readonly reviewerUserIds?: readonly string[] | undefined;
}

/** The permission that makes somebody a top-up reviewer. Assignment adds nothing to it. */
const REVIEW_PERMISSION = 'finance:manual-topup:review';

interface ReviewerRow {
  payment_method_id: string;
  user_id: string;
  created_at: Date;
  display_name: string | null;
  email: string;
  email_verified: boolean;
  eligible: boolean;
}

type MethodFields = Omit<
  ManualPaymentMethod,
  | 'id'
  | 'code'
  | 'logoId'
  | 'enabled'
  | 'version'
  | 'createdByUserId'
  | 'updatedByUserId'
  | 'createdAt'
  | 'updatedAt'
  | 'archivedAt'
>;

type MethodWithLogo = ManualPaymentMethod & { logo: ManualPaymentMethodLogo | null };

function invalid(message: string, field?: string): AppError {
  return new AppError(PalCertErrorCode.MANUAL_PAYMENT_METHOD_INVALID, {
    message,
    ...(field === undefined ? {} : { details: { field } }),
  });
}

function bounded(value: string | null | undefined, max: number, field: string): string | null {
  const cleaned = cleanText(value);
  if (cleaned !== null && cleaned.length > max) {
    throw invalid(`${field} may be at most ${max} characters.`, field);
  }
  return cleaned;
}

/**
 * The configured places PalCert asks people to send money (§ payment methods).
 *
 * Reads for customers run in the customer's own scope, where row-level
 * security shows only enabled, unarchived methods. Every administrative read
 * and write runs through the audited platform elevation. A method is never
 * deleted: requests name it, so the end of its life is archiving, and a
 * change to its details never reaches a request already made — each request
 * froze its own snapshot.
 */
@Injectable()
export class ManualPaymentMethodService {
  constructor(
    private readonly tenant: TenantPrismaService,
    private readonly files: ManualTopUpFiles,
    private readonly jobs: ProcessingJobService,
    private readonly dispatcher: OutboxDispatcher,
    private readonly events: SecurityEventService,
    private readonly throttle: AuthThrottleService,
    private readonly config: ApiConfigService,
    private readonly clock: ClockPort,
  ) {}

  // -------------------------------------------------------------------------
  // The customer's catalogue
  // -------------------------------------------------------------------------

  async catalogue(userId: string): Promise<readonly ManualPaymentMethodView[]> {
    const enabled = new Set(this.config.payments.enabledCurrencies);
    const rows = await this.tenant.withUser(userId, (tx) =>
      tx.manualPaymentMethod.findMany({
        where: { enabled: true, archivedAt: null },
        include: { logo: true },
        orderBy: [{ displayOrder: 'asc' }, { code: 'asc' }],
      }),
    );
    const listed = rows.filter((row) => enabled.has(row.currency));
    return Promise.all(listed.map((row) => this.customerView(row)));
  }

  /** One method the customer may use, or not-found. Used inside a caller's transaction. */
  async usable(tx: TenantClient, methodId: string): Promise<ManualPaymentMethod | null> {
    const method = await tx.manualPaymentMethod.findUnique({ where: { id: methodId } });
    if (
      method === null ||
      !method.enabled ||
      method.archivedAt !== null ||
      !this.config.payments.enabledCurrencies.includes(method.currency)
    ) {
      return null;
    }
    return method;
  }

  // -------------------------------------------------------------------------
  // Administration
  // -------------------------------------------------------------------------

  async list(actorUserId: string): Promise<readonly AdminManualPaymentMethodView[]> {
    const rows = await this.tenant.withPlatformAdmin(
      { actorUserId, reason: 'read manual payment methods' },
      (tx) =>
        tx.manualPaymentMethod.findMany({
          include: { logo: true, _count: { select: { requests: true } } },
          orderBy: [
            { archivedAt: { sort: 'asc', nulls: 'first' } },
            { displayOrder: 'asc' },
            { code: 'asc' },
          ],
        }),
    );
    const reviewers = await this.reviewersOf(
      actorUserId,
      rows.map((row) => row.id),
    );
    return Promise.all(
      rows.map((row) => this.adminView(row, row._count.requests > 0, reviewers.get(row.id) ?? [])),
    );
  }

  /**
   * Who an administrator may assign: ACTIVE users holding the review
   * permission through a GLOBAL role. Organization roles never qualify, and
   * nobody else is listed — the admin form cannot offer an address that
   * could receive the mail but not open the review page.
   */
  async reviewerCandidates(
    actorUserId: string,
  ): Promise<readonly ManualTopUpReviewerCandidateView[]> {
    const rows = await this.tenant.withPlatformAdmin(
      { actorUserId, reason: 'list manual top-up reviewer candidates' },
      (tx) =>
        tx.$queryRaw<
          Array<{
            user_id: string;
            display_name: string | null;
            email: string;
            email_verified: boolean;
            roles: string[];
          }>
        >`
          SELECT u."id" AS "user_id", u."display_name", u."email",
                 (u."email_verified_at" IS NOT NULL) AS "email_verified",
                 array_agg(DISTINCT r."code" ORDER BY r."code") AS "roles"
            FROM "user_roles" ur
            JOIN "roles" r ON r."id" = ur."role_id"
            JOIN "role_permissions" rp ON rp."role_id" = r."id"
            JOIN "permissions" p ON p."id" = rp."permission_id" AND p."code" = ${REVIEW_PERMISSION}
            JOIN "users" u ON u."id" = ur."user_id"
           WHERE ur."scope" = 'GLOBAL'
             AND ur."organization_id" IS NULL
             AND u."status" = 'ACTIVE'
           GROUP BY u."id"
           ORDER BY lower(coalesce(u."display_name", u."email")), u."id"`,
    );
    return rows.map((row) => ({
      userId: row.user_id,
      displayName: row.display_name,
      email: row.email,
      emailVerified: row.email_verified,
      roles: row.roles,
    }));
  }

  async get(actorUserId: string, methodId: string): Promise<AdminManualPaymentMethodView> {
    const row = await this.tenant.withPlatformAdmin(
      { actorUserId, reason: 'read a manual payment method' },
      (tx) =>
        tx.manualPaymentMethod.findUnique({
          where: { id: methodId },
          include: { logo: true, _count: { select: { requests: true } } },
        }),
    );
    if (row === null) throw methodNotFound();
    const reviewers = await this.reviewersOf(actorUserId, [row.id]);
    return this.adminView(row, row._count.requests > 0, reviewers.get(row.id) ?? []);
  }

  async create(
    actorUserId: string,
    input: PaymentMethodInput,
    context: RequestContext,
  ): Promise<AdminManualPaymentMethodView> {
    const code = (input.code ?? '').trim().toUpperCase();
    if (!MANUAL_PAYMENT_METHOD_CODE_PATTERN.test(code)) {
      throw invalid(
        'A code is 2 to 40 uppercase letters, digits or underscores, starting with a letter.',
        'code',
      );
    }
    const fields = this.validate(input);
    const reviewerIds = this.reviewerList(input.reviewerUserIds ?? []);
    const now = this.clock.now();

    let created: ManualPaymentMethod;
    try {
      created = await this.tenant.withPlatformAdmin(
        { actorUserId, reason: 'create a manual payment method' },
        async (tx) => {
          const method = await tx.manualPaymentMethod.create({
            data: {
              ...fields,
              code,
              // A new method is never live until somebody decides it is.
              enabled: false,
              createdByUserId: actorUserId,
              updatedByUserId: actorUserId,
              createdAt: now,
              updatedAt: now,
            },
          });
          await this.replaceReviewers(tx, method.id, reviewerIds, actorUserId);
          return method;
        },
      );
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new AppError(PalCertErrorCode.MANUAL_PAYMENT_METHOD_CODE_TAKEN, {
          message: 'Another payment method already uses that code.',
          details: { field: 'code' },
        });
      }
      throw error;
    }

    await this.events.audit({
      action: 'MANUAL_PAYMENT_METHOD_CREATED',
      actorUserId,
      targetType: 'ManualPaymentMethod',
      targetId: created.id,
      requestId: context.requestId,
      ipAddress: context.ipAddress,
      afterState: {
        code,
        type: fields.type,
        currency: fields.currency,
        enabled: false,
        reviewerUserIds: reviewerIds,
      },
    });
    return this.get(actorUserId, created.id);
  }

  async update(
    actorUserId: string,
    methodId: string,
    input: PaymentMethodInput & { readonly expectedVersion: number },
    context: RequestContext,
  ): Promise<AdminManualPaymentMethodView> {
    const fields = this.validate(input);
    const reviewerIds =
      input.reviewerUserIds === undefined ? undefined : this.reviewerList(input.reviewerUserIds);
    let reviewerChange: { added: string[]; removed: string[] } | null = null;
    const changed = await this.mutate(
      actorUserId,
      methodId,
      input.expectedVersion,
      'edit',
      (current) => {
        const names = (Object.keys(fields) as (keyof MethodFields & string)[]).filter(
          (key) => String(current[key] ?? '') !== String(fields[key] ?? ''),
        );
        return { data: fields, changed: names };
      },
      async (tx, current) => {
        if (reviewerIds === undefined) return [];
        reviewerChange = await this.replaceReviewers(tx, methodId, reviewerIds, actorUserId);
        // An offered method must keep somebody who can act on its alerts.
        // Methods offered before assignment existed, with nobody assigned,
        // stay valid; only emptying an assignment while offered is refused.
        if (current.enabled && reviewerChange.removed.length > 0) {
          await this.requireEligibleReviewer(tx, methodId);
        }
        return reviewerChange.added.length + reviewerChange.removed.length > 0 ? ['reviewers'] : [];
      },
    );

    await this.events.audit({
      action: 'MANUAL_PAYMENT_METHOD_UPDATED',
      actorUserId,
      targetType: 'ManualPaymentMethod',
      targetId: methodId,
      requestId: context.requestId,
      ipAddress: context.ipAddress,
      // Which fields changed, not what to. The values are PalCert's own
      // account details and do not belong in an audit export.
      afterState: { changedFields: changed, version: input.expectedVersion + 1 },
    });
    const change = reviewerChange as { added: string[]; removed: string[] } | null;
    if (change !== null && change.added.length + change.removed.length > 0) {
      await this.events.audit({
        action: 'MANUAL_PAYMENT_METHOD_REVIEWERS_CHANGED',
        actorUserId,
        targetType: 'ManualPaymentMethod',
        targetId: methodId,
        requestId: context.requestId,
        ipAddress: context.ipAddress,
        afterState: { addedUserIds: change.added, removedUserIds: change.removed },
      });
    }
    return this.get(actorUserId, methodId);
  }

  async setEnabled(
    actorUserId: string,
    methodId: string,
    enabled: boolean,
    expectedVersion: number,
    context: RequestContext,
  ): Promise<AdminManualPaymentMethodView> {
    await this.mutate(
      actorUserId,
      methodId,
      expectedVersion,
      enabled ? 'enable' : 'disable',
      (current) => {
        if (enabled && !this.config.payments.enabledCurrencies.includes(current.currency)) {
          throw invalid(
            `${current.currency} is not enabled on this deployment, so a method in it cannot be offered.`,
            'currency',
          );
        }
        return { data: { enabled }, changed: ['enabled'] };
      },
      async (tx) => {
        // Never silently publish a method nobody is responsible for.
        if (enabled) await this.requireEligibleReviewer(tx, methodId);
        return [];
      },
    );
    await this.events.audit({
      action: enabled ? 'MANUAL_PAYMENT_METHOD_ENABLED' : 'MANUAL_PAYMENT_METHOD_DISABLED',
      actorUserId,
      targetType: 'ManualPaymentMethod',
      targetId: methodId,
      requestId: context.requestId,
      ipAddress: context.ipAddress,
      afterState: { enabled },
    });
    return this.get(actorUserId, methodId);
  }

  /** The end of a method's life. Permanent; requests made against it keep their snapshots. */
  async archive(
    actorUserId: string,
    methodId: string,
    expectedVersion: number,
    context: RequestContext,
  ): Promise<AdminManualPaymentMethodView> {
    await this.mutate(actorUserId, methodId, expectedVersion, 'archive', () => ({
      data: { enabled: false, archivedAt: this.clock.now() },
      changed: ['archivedAt'],
    }));
    await this.events.audit({
      action: 'MANUAL_PAYMENT_METHOD_ARCHIVED',
      actorUserId,
      targetType: 'ManualPaymentMethod',
      targetId: methodId,
      requestId: context.requestId,
      ipAddress: context.ipAddress,
    });
    return this.get(actorUserId, methodId);
  }

  // -------------------------------------------------------------------------
  // Logos
  // -------------------------------------------------------------------------

  async createLogoUpload(
    actorUserId: string,
    methodId: string,
    input: {
      readonly originalFilename: string;
      readonly declaredMimeType?: string | undefined;
      readonly sizeBytes: number;
      readonly sha256?: string | undefined;
      readonly idempotencyKey?: string | undefined;
    },
    context: RequestContext,
  ): Promise<ManualPaymentMethodLogoUploadResponse> {
    await this.throttle.consume(ThrottleScope.MANUAL_TOPUP_UPLOAD, actorUserId);
    const upload = this.files.validate(
      input,
      LOGO_FORMATS,
      LOGO_MAX_BYTES,
      'A logo must be a PNG, JPEG or WebP image. SVG is not accepted.',
    );
    const idempotencyKey = cleanText(input.idempotencyKey ?? null);

    const logo = await this.tenant.withPlatformAdmin(
      { actorUserId, reason: 'upload a manual payment method logo' },
      async (tx) => {
        if (idempotencyKey !== null) {
          const existing = await tx.manualPaymentMethodLogo.findFirst({
            where: { uploadedByUserId: actorUserId, idempotencyKey },
          });
          if (existing !== null) {
            if (existing.paymentMethodId !== methodId) {
              throw new AppError(PalCertErrorCode.IDEMPOTENCY_KEY_REUSED, {
                message: 'This Idempotency-Key was already used for a different upload.',
              });
            }
            return existing;
          }
        }
        const method = await tx.manualPaymentMethod.findUnique({ where: { id: methodId } });
        if (method === null) throw methodNotFound();
        if (method.archivedAt !== null) throw invalid('An archived method cannot be changed.');

        const logoId = randomUUID();
        return tx.manualPaymentMethodLogo.create({
          data: {
            id: logoId,
            paymentMethodId: methodId,
            uploadedByUserId: actorUserId,
            status: ManualTopUpFileStatus.AWAITING_UPLOAD,
            originalFilename: upload.originalFilename,
            declaredMimeType: upload.declaredMimeType,
            expectedFormat: upload.expectedFormat,
            declaredSizeBytes: upload.sizeBytes,
            maxFileBytes: LOGO_MAX_BYTES,
            clientSha256: upload.clientSha256,
            quarantineObjectKey: quarantinePaymentMethodLogoKey({
              paymentMethodId: methodId,
              logoId,
            }),
            idempotencyKey,
            uploadExpiresAt: upload.uploadExpiresAt,
          },
        });
      },
    );

    await this.events.audit({
      action: 'MANUAL_PAYMENT_METHOD_LOGO_UPLOAD_STARTED',
      actorUserId,
      targetType: 'ManualPaymentMethodLogo',
      targetId: logo.id,
      requestId: context.requestId,
      ipAddress: context.ipAddress,
      afterState: { paymentMethodId: methodId, expectedFormat: logo.expectedFormat },
    });
    return { logo: logoView(logo)!, upload: await this.files.authorizeUpload(logo) };
  }

  async reauthorizeLogo(
    actorUserId: string,
    methodId: string,
    logoId: string,
  ): Promise<ManualTopUpUploadAuthorizationView> {
    const logo = await this.loadLogo(actorUserId, methodId, logoId);
    if (logo.status !== ManualTopUpFileStatus.AWAITING_UPLOAD) {
      throw new AppError(PalCertErrorCode.VALIDATION_FAILED, {
        message: 'This logo has already been uploaded.',
      });
    }
    return this.files.authorizeUpload(logo);
  }

  /**
   * Pin the uploaded logo, make it the method's logo, and queue its scan.
   *
   * The method points at the logo straight away, but the catalogue shows a
   * logo only once it is READY: until the scan passes, customers simply see
   * no logo, and a rejected one never appears at all.
   */
  async finalizeLogo(
    actorUserId: string,
    methodId: string,
    logoId: string,
    context: RequestContext,
  ): Promise<AdminManualPaymentMethodView> {
    const logo = await this.loadLogo(actorUserId, methodId, logoId);
    if (logo.status !== ManualTopUpFileStatus.AWAITING_UPLOAD)
      return this.get(actorUserId, methodId);
    const staged = await this.files.staged(logo);
    const now = this.clock.now();

    const job = await this.tenant.withPlatformAdmin(
      { actorUserId, reason: 'attach a manual payment method logo' },
      async (tx) => {
        const claimed = await tx.manualPaymentMethodLogo.updateMany({
          where: { id: logoId, status: ManualTopUpFileStatus.AWAITING_UPLOAD },
          data: {
            status: ManualTopUpFileStatus.UPLOADED,
            uploadedAt: now,
            quarantineObjectVersionId: staged.versionId,
            quarantineObjectEtag: staged.etag,
            updatedAt: now,
          },
        });
        if (claimed.count !== 1) return null;

        const method = await tx.manualPaymentMethod.findUnique({ where: { id: methodId } });
        if (method === null || method.archivedAt !== null) throw methodNotFound();
        await tx.manualPaymentMethod.update({
          where: { id: methodId },
          data: {
            logoId,
            version: method.version + 1,
            updatedByUserId: actorUserId,
            updatedAt: now,
          },
        });

        return this.jobs.enqueueInTransaction(tx, {
          type: ProcessingJobType.MANUAL_PAYMENT_METHOD_LOGO_INGEST,
          resourceType: 'MANUAL_PAYMENT_METHOD_LOGO',
          resourceId: logoId,
          // Filed under the administrator who uploaded it: a logo is that
          // person's act, and the worker re-enters the platform scope as them.
          ownerUserId: actorUserId,
        });
      },
    );

    if (job !== null) {
      await this.dispatcher.dispatchNow(job.id);
      await this.events.audit({
        action: 'MANUAL_PAYMENT_METHOD_LOGO_UPLOADED',
        actorUserId,
        targetType: 'ManualPaymentMethodLogo',
        targetId: logoId,
        requestId: context.requestId,
        ipAddress: context.ipAddress,
        afterState: { paymentMethodId: methodId },
      });
    }
    return this.get(actorUserId, methodId);
  }

  async removeLogo(
    actorUserId: string,
    methodId: string,
    expectedVersion: number,
    context: RequestContext,
  ): Promise<AdminManualPaymentMethodView> {
    await this.mutate(actorUserId, methodId, expectedVersion, 'edit', () => ({
      data: { logoId: null },
      changed: ['logoId'],
    }));
    await this.events.audit({
      action: 'MANUAL_PAYMENT_METHOD_LOGO_REMOVED',
      actorUserId,
      targetType: 'ManualPaymentMethod',
      targetId: methodId,
      requestId: context.requestId,
      ipAddress: context.ipAddress,
    });
    return this.get(actorUserId, methodId);
  }

  // -------------------------------------------------------------------------

  /**
   * One optimistic-concurrency edit: `WHERE version = expected`, bumping it.
   * A stale version is refused rather than silently overwriting somebody
   * else's change to where customers send money.
   */
  private async mutate(
    actorUserId: string,
    methodId: string,
    expectedVersion: number,
    action: string,
    build: (current: ManualPaymentMethod) => {
      data: Partial<MethodFields> & {
        enabled?: boolean;
        archivedAt?: Date;
        logoId?: string | null;
      };
      changed: readonly string[];
    },
    after?: (tx: TenantClient, current: ManualPaymentMethod) => Promise<readonly string[]>,
  ): Promise<readonly string[]> {
    return this.tenant.withPlatformAdmin(
      { actorUserId, reason: `${action} a manual payment method` },
      async (tx) => {
        const current = await tx.manualPaymentMethod.findUnique({ where: { id: methodId } });
        if (current === null) throw methodNotFound();
        if (current.archivedAt !== null) throw invalid('An archived method cannot be changed.');
        if (current.version !== expectedVersion) {
          throw new AppError(PalCertErrorCode.MANUAL_PAYMENT_METHOD_CONFLICT, {
            message: 'This payment method was changed by somebody else. Reload it and try again.',
            details: { currentVersion: current.version },
          });
        }
        const { data, changed } = build(current);
        if (data.currency !== undefined && data.currency !== current.currency) {
          const used = await tx.manualTopUpRequest.count({ where: { paymentMethodId: methodId } });
          if (used > 0) {
            throw invalid(
              'This method already has top-up requests, so its currency cannot change. ' +
                'Archive it and create a new one instead.',
              'currency',
            );
          }
        }
        const updated = await tx.manualPaymentMethod.updateMany({
          where: { id: methodId, version: expectedVersion },
          data: {
            ...data,
            version: expectedVersion + 1,
            updatedByUserId: actorUserId,
            updatedAt: this.clock.now(),
          },
        });
        if (updated.count !== 1) {
          throw new AppError(PalCertErrorCode.MANUAL_PAYMENT_METHOD_CONFLICT, {
            message: 'This payment method was changed by somebody else. Reload it and try again.',
          });
        }
        const more = after === undefined ? [] : await after(tx, current);
        return [...changed, ...more];
      },
    );
  }

  /** A reviewer list as sent: unique ids, within the limit. */
  private reviewerList(ids: readonly string[]): string[] {
    if (ids.length > MAX_MANUAL_PAYMENT_METHOD_REVIEWERS) {
      throw invalid(
        `A method may name at most ${MAX_MANUAL_PAYMENT_METHOD_REVIEWERS} reviewers.`,
        'reviewerUserIds',
      );
    }
    if (new Set(ids).size !== ids.length) {
      throw invalid('Each reviewer may be assigned only once.', 'reviewerUserIds');
    }
    return [...ids];
  }

  /**
   * Make the method's assignees exactly `ids`. Each new one must hold the
   * review permission through a platform role — checked here with a clear
   * error, and again by the database trigger, which no caller can skip.
   */
  private async replaceReviewers(
    tx: TenantClient,
    methodId: string,
    ids: readonly string[],
    actorUserId: string,
  ): Promise<{ added: string[]; removed: string[] }> {
    const current = await tx.manualPaymentMethodReviewer.findMany({
      where: { paymentMethodId: methodId },
      select: { userId: true },
    });
    const existing = new Set(current.map((row) => row.userId));
    const wanted = new Set(ids);
    const added = ids.filter((id) => !existing.has(id));
    const removed = [...existing].filter((id) => !wanted.has(id));

    if (added.length > 0) {
      const eligible = await tx.$queryRaw<Array<{ user_id: string }>>`
        SELECT u."id" AS "user_id"
          FROM "users" u
         WHERE u."id" = ANY(${added}::uuid[])
           AND app_notification_is_platform_reviewer(u."id", ${REVIEW_PERMISSION})`;
      const ok = new Set(eligible.map((row) => row.user_id));
      const refused = added.find((id) => !ok.has(id));
      if (refused !== undefined) {
        throw new AppError(PalCertErrorCode.MANUAL_PAYMENT_METHOD_REVIEWER_INELIGIBLE, {
          message:
            'Only active PalCert staff who can review manual top-ups may be assigned as reviewers.',
          details: { field: 'reviewerUserIds', userId: refused },
        });
      }
    }
    if (removed.length > 0) {
      await tx.manualPaymentMethodReviewer.deleteMany({
        where: { paymentMethodId: methodId, userId: { in: removed } },
      });
    }
    if (added.length > 0) {
      await tx.manualPaymentMethodReviewer.createMany({
        data: added.map((userId) => ({
          paymentMethodId: methodId,
          userId,
          createdByUserId: actorUserId,
          createdAt: this.clock.now(),
        })),
      });
    }
    return { added, removed };
  }

  /** Refuse unless at least one assignee still holds the review permission. */
  private async requireEligibleReviewer(tx: TenantClient, methodId: string): Promise<void> {
    const rows = await tx.$queryRaw<Array<{ eligible: bigint }>>`
      SELECT count(*) AS "eligible"
        FROM "manual_payment_method_reviewers" mr
       WHERE mr."payment_method_id" = ${methodId}::uuid
         AND app_notification_is_platform_reviewer(mr."user_id", ${REVIEW_PERMISSION})`;
    if ((rows[0]?.eligible ?? 0n) === 0n) {
      throw new AppError(PalCertErrorCode.MANUAL_PAYMENT_METHOD_REVIEWER_REQUIRED, {
        message:
          'Assign at least one finance reviewer before offering this payment method to customers.',
        details: { field: 'reviewerUserIds' },
      });
    }
  }

  /** Every method's assignees, with whether each can still act. One query. */
  private async reviewersOf(
    actorUserId: string,
    methodIds: readonly string[],
  ): Promise<Map<string, ManualPaymentMethodReviewerView[]>> {
    const byMethod = new Map<string, ManualPaymentMethodReviewerView[]>();
    if (methodIds.length === 0) return byMethod;
    const rows = await this.tenant.withPlatformAdmin(
      { actorUserId, reason: 'read manual payment method reviewers' },
      (tx) =>
        tx.$queryRaw<ReviewerRow[]>`
          SELECT mr."payment_method_id", mr."user_id", mr."created_at",
                 u."display_name", u."email",
                 (u."email_verified_at" IS NOT NULL) AS "email_verified",
                 app_notification_is_platform_reviewer(mr."user_id", ${REVIEW_PERMISSION}) AS "eligible"
            FROM "manual_payment_method_reviewers" mr
            JOIN "users" u ON u."id" = mr."user_id"
           WHERE mr."payment_method_id" = ANY(${[...methodIds]}::uuid[])
           ORDER BY lower(coalesce(u."display_name", u."email")), mr."user_id"`,
    );
    for (const row of rows) {
      const list = byMethod.get(row.payment_method_id) ?? [];
      list.push({
        userId: row.user_id,
        displayName: row.display_name,
        email: row.email,
        emailVerified: row.email_verified,
        eligible: row.eligible,
        assignedAt: row.created_at.toISOString(),
      });
      byMethod.set(row.payment_method_id, list);
    }
    return byMethod;
  }

  private validate(input: PaymentMethodInput): MethodFields {
    if (!(Object.values(ManualPaymentMethodType) as string[]).includes(input.type)) {
      throw invalid('Choose a mobile wallet, a bank account or another method.', 'type');
    }
    const type = input.type as ManualPaymentMethodType;
    const currency = input.currency.trim().toUpperCase();
    if (!isKnownCurrency(currency)) {
      throw new AppError(PalCertErrorCode.CURRENCY_NOT_SUPPORTED, {
        message: 'PalCert does not know that currency.',
        details: { field: 'currency' },
      });
    }

    const nameEn = bounded(input.nameEn, MANUAL_TOPUP_LIMITS.name, 'nameEn');
    const nameAr = bounded(input.nameAr, MANUAL_TOPUP_LIMITS.name, 'nameAr');
    if (nameEn === null) throw invalid('An English name is required.', 'nameEn');
    if (nameAr === null) throw invalid('An Arabic name is required.', 'nameAr');

    const mobileInput = cleanText(input.mobileNumber);
    const mobileNumber = mobileInput === null ? null : normalizeMobileNumber(mobileInput);
    if (mobileInput !== null && mobileNumber === null) {
      throw invalid(
        'Enter the wallet phone number as 7 to 15 digits, optionally starting with +.',
        'mobileNumber',
      );
    }
    const ibanInput = cleanText(input.iban);
    const iban = ibanInput === null ? null : normalizeIban(ibanInput);
    if (ibanInput !== null && iban === null) {
      throw invalid(
        'That IBAN is not valid. Check its country code, length and check digits.',
        'iban',
      );
    }
    const accountNumber = bounded(
      input.accountNumber,
      MANUAL_TOPUP_LIMITS.accountNumber,
      'accountNumber',
    );
    if (accountNumber !== null && !/^[A-Za-z0-9-]{1,40}$/.test(accountNumber)) {
      throw invalid('An account number is letters, digits and hyphens only.', 'accountNumber');
    }

    const fields: MethodFields = {
      type,
      nameEn,
      nameAr,
      descriptionEn: bounded(input.descriptionEn, MANUAL_TOPUP_LIMITS.description, 'descriptionEn'),
      descriptionAr: bounded(input.descriptionAr, MANUAL_TOPUP_LIMITS.description, 'descriptionAr'),
      currency,
      recipientName: bounded(
        input.recipientName,
        MANUAL_TOPUP_LIMITS.recipientName,
        'recipientName',
      ),
      mobileNumber,
      iban,
      bankName: bounded(input.bankName, MANUAL_TOPUP_LIMITS.bankName, 'bankName'),
      accountNumber,
      branchName: bounded(input.branchName, MANUAL_TOPUP_LIMITS.branchName, 'branchName'),
      instructionsEn: bounded(
        input.instructionsEn,
        MANUAL_TOPUP_LIMITS.instructions,
        'instructionsEn',
      ),
      instructionsAr: bounded(
        input.instructionsAr,
        MANUAL_TOPUP_LIMITS.instructions,
        'instructionsAr',
      ),
      minAmountMinor: this.amount(input.minAmountMinorUnits, 'minAmountMinorUnits'),
      maxAmountMinor: this.amount(input.maxAmountMinorUnits, 'maxAmountMinorUnits'),
      displayOrder: input.displayOrder ?? 0,
    };

    if (fields.maxAmountMinor < fields.minAmountMinor) {
      throw invalid('The maximum must be at least the minimum.', 'maxAmountMinorUnits');
    }
    if (
      !Number.isInteger(fields.displayOrder) ||
      fields.displayOrder < 0 ||
      fields.displayOrder > MANUAL_TOPUP_LIMITS.maxDisplayOrder
    ) {
      throw invalid('The display order is a whole number from 0 to 9999.', 'displayOrder');
    }

    // Type-specific destinations, mirrored by a database CHECK.
    if (type === ManualPaymentMethodType.MOBILE_WALLET) {
      if (fields.mobileNumber === null)
        throw invalid('A wallet needs its phone number.', 'mobileNumber');
      if (fields.recipientName === null) {
        throw invalid('A wallet needs the name it is registered to.', 'recipientName');
      }
    } else if (type === ManualPaymentMethodType.BANK_ACCOUNT) {
      if (fields.bankName === null) throw invalid('A bank account needs its bank.', 'bankName');
      if (fields.recipientName === null) {
        throw invalid('A bank account needs the account holder’s name.', 'recipientName');
      }
      if (fields.iban === null && fields.accountNumber === null) {
        throw invalid('A bank account needs an IBAN or an account number.', 'iban');
      }
    } else if (fields.instructionsEn === null || fields.instructionsAr === null) {
      throw invalid('This method needs instructions in English and Arabic.', 'instructionsEn');
    }
    return fields;
  }

  private amount(value: string, field: string): bigint {
    let parsed: bigint;
    try {
      parsed = parseMinorUnits(value);
    } catch {
      throw invalid('Amounts are whole numbers of minor units, such as 1000 for 10.00.', field);
    }
    if (parsed <= 0n || parsed > MAX_MINOR_UNITS) {
      throw invalid('Amounts must be greater than zero.', field);
    }
    return parsed;
  }

  private async loadLogo(
    actorUserId: string,
    methodId: string,
    logoId: string,
  ): Promise<ManualPaymentMethodLogo> {
    const logo = await this.tenant.withPlatformAdmin(
      { actorUserId, reason: 'read a manual payment method logo' },
      (tx) => tx.manualPaymentMethodLogo.findUnique({ where: { id: logoId } }),
    );
    if (logo === null || logo.paymentMethodId !== methodId) {
      throw new AppError(PalCertErrorCode.MANUAL_TOPUP_FILE_NOT_FOUND, {
        message: 'No such logo on this payment method.',
      });
    }
    return logo;
  }

  private async logoUrl(logo: ManualPaymentMethodLogo | null): Promise<string | null> {
    if (logo === null || logo.status !== ManualTopUpFileStatus.READY) return null;
    try {
      return (await this.files.download(logo, 'inline')).url;
    } catch {
      // A logo is decoration. Storage being briefly unavailable must not take
      // the payment instructions down with it.
      return null;
    }
  }

  private async customerView(row: MethodWithLogo): Promise<ManualPaymentMethodView> {
    return {
      id: row.id,
      code: row.code,
      type: row.type as ManualPaymentMethodType,
      nameEn: row.nameEn,
      nameAr: row.nameAr,
      descriptionEn: row.descriptionEn,
      descriptionAr: row.descriptionAr,
      currency: row.currency,
      recipientName: row.recipientName,
      mobileNumber: row.mobileNumber,
      iban: row.iban,
      bankName: row.bankName,
      accountNumber: row.accountNumber,
      branchName: row.branchName,
      instructionsEn: row.instructionsEn,
      instructionsAr: row.instructionsAr,
      minAmount: money(row.currency, row.minAmountMinor),
      maxAmount: money(row.currency, row.maxAmountMinor),
      logoUrl: await this.logoUrl(row.logo),
    };
  }

  private async adminView(
    row: MethodWithLogo,
    referenced: boolean,
    reviewers: readonly ManualPaymentMethodReviewerView[],
  ): Promise<AdminManualPaymentMethodView> {
    return {
      ...(await this.customerView(row)),
      enabled: row.enabled,
      displayOrder: row.displayOrder,
      version: row.version,
      archivedAt: row.archivedAt?.toISOString() ?? null,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
      createdByUserId: row.createdByUserId,
      updatedByUserId: row.updatedByUserId,
      logo: logoView(row.logo),
      referenced,
      reviewers,
    };
  }
}

function logoView(logo: ManualPaymentMethodLogo | null): ManualPaymentMethodLogoView | null {
  if (logo === null) return null;
  return {
    id: logo.id,
    status: logo.status as ManualTopUpFileStatus,
    format: (logo.detectedFormat ?? null) as ManualTopUpFileFormat | null,
    sizeBytes: logo.sizeBytes,
    rejectionCode: logo.rejectionCode,
  };
}
