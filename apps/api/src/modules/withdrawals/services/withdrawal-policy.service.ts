import { Injectable } from '@nestjs/common';
import {
  AppError,
  PalCertErrorCode,
  Permission,
  WITHDRAWAL_POLICY_BOUNDS,
  isKnownCurrency,
  money,
  type MoneyView,
  type WithdrawalPolicyView,
  type WithdrawalReviewerCandidateView,
  type WithdrawalReviewerView,
} from '@palcert/contracts';
import {
  TenantPrismaService,
  type TenantClient,
} from '../../../infrastructure/tenant/tenant-prisma.service';
import { ClockPort } from '../../auth/ports/clock.port';
import { SecurityEventService } from '../../auth/services/security-event.service';
import { invalid, type RequestContext } from '../withdrawal-support';

/** The permission that makes somebody a withdrawal reviewer. Assignment adds nothing to it. */
const REVIEW_PERMISSION = Permission.FINANCE_WITHDRAWAL_REVIEW;

/** The most reviewers one alert may name. */
const MAX_WITHDRAWAL_REVIEWERS = 20;

export interface PolicyNow {
  readonly userManualTopUpClearingDays: number;
  readonly organizationClearingDays: number;
}

export interface CurrencyLimit {
  readonly minAmountMinor: bigint | null;
  readonly maxAmountMinor: bigint | null;
}

/**
 * Withdrawal policy, per-currency limits and reviewer assignment
 * (spec §19, §28; decisions D3, D4).
 *
 * The clearing periods are bounded by the database as well as here, and no
 * fee exists anywhere in this model: a fee, if PalCert ever charges one, will
 * be a new versioned policy, never a silent deduction.
 */
@Injectable()
export class WithdrawalPolicyService {
  constructor(
    private readonly tenant: TenantPrismaService,
    private readonly events: SecurityEventService,
    private readonly clock: ClockPort,
  ) {}

  /** The policy as it stands, read inside the caller's transaction. */
  async current(tx: TenantClient): Promise<PolicyNow> {
    const row = await tx.withdrawalPolicy.findUnique({ where: { id: 1 } });
    return {
      userManualTopUpClearingDays:
        row?.userManualTopUpClearingDays ??
        WITHDRAWAL_POLICY_BOUNDS.userManualTopUpClearingDays.default,
      organizationClearingDays:
        row?.organizationClearingDays ?? WITHDRAWAL_POLICY_BOUNDS.organizationClearingDays.default,
    };
  }

  async limitFor(tx: TenantClient, currency: string): Promise<CurrencyLimit> {
    const row = await tx.withdrawalCurrencyLimit.findUnique({ where: { currency } });
    return {
      minAmountMinor: row?.minAmountMinor ?? null,
      maxAmountMinor: row?.maxAmountMinor ?? null,
    };
  }

  limitViews(
    currency: string,
    limit: CurrencyLimit,
  ): { minimum: MoneyView | null; maximum: MoneyView | null } {
    return {
      minimum: limit.minAmountMinor === null ? null : money(currency, limit.minAmountMinor),
      maximum: limit.maxAmountMinor === null ? null : money(currency, limit.maxAmountMinor),
    };
  }

  async view(actorUserId: string): Promise<WithdrawalPolicyView> {
    return this.tenant.withPlatformAdmin(
      { actorUserId, reason: 'read the withdrawal policy' },
      (tx) => this.viewIn(tx),
    );
  }

  async update(
    actorUserId: string,
    input: {
      readonly userManualTopUpClearingDays: number;
      readonly organizationClearingDays: number;
      readonly expectedVersion: number;
    },
    context: RequestContext,
  ): Promise<WithdrawalPolicyView> {
    const user = WITHDRAWAL_POLICY_BOUNDS.userManualTopUpClearingDays;
    const org = WITHDRAWAL_POLICY_BOUNDS.organizationClearingDays;
    if (
      !Number.isInteger(input.userManualTopUpClearingDays) ||
      input.userManualTopUpClearingDays < user.min ||
      input.userManualTopUpClearingDays > user.max
    ) {
      throw invalid(
        'userManualTopUpClearingDays',
        `The manual top-up clearing period must be ${user.min} to ${user.max} days.`,
      );
    }
    if (
      !Number.isInteger(input.organizationClearingDays) ||
      input.organizationClearingDays < org.min ||
      input.organizationClearingDays > org.max
    ) {
      throw invalid(
        'organizationClearingDays',
        `The organization clearing period must be ${org.min} to ${org.max} days.`,
      );
    }

    const { before, view } = await this.tenant.withPlatformAdmin(
      { actorUserId, reason: 'change the withdrawal policy' },
      async (tx) => {
        await tx.$queryRaw`SELECT "id" FROM "withdrawal_policy" WHERE "id" = 1 FOR UPDATE`;
        const current = await tx.withdrawalPolicy.findUniqueOrThrow({ where: { id: 1 } });
        if (current.version !== input.expectedVersion) {
          throw new AppError(PalCertErrorCode.WITHDRAWAL_CONFLICT, {
            message: 'The policy changed since you opened it. Reload it and try again.',
            details: { version: current.version },
          });
        }
        await tx.withdrawalPolicy.update({
          where: { id: 1 },
          data: {
            userManualTopUpClearingDays: input.userManualTopUpClearingDays,
            organizationClearingDays: input.organizationClearingDays,
            version: current.version + 1,
            updatedAt: this.clock.now(),
            updatedByUserId: actorUserId,
          },
        });
        return { before: current, view: await this.viewIn(tx) };
      },
    );
    await this.events.audit({
      action: 'WITHDRAWAL_POLICY_UPDATED',
      actorUserId,
      targetType: 'WithdrawalPolicy',
      targetId: '1',
      requestId: context.requestId,
      ipAddress: context.ipAddress,
      beforeState: {
        userManualTopUpClearingDays: before.userManualTopUpClearingDays,
        organizationClearingDays: before.organizationClearingDays,
      },
      afterState: {
        userManualTopUpClearingDays: input.userManualTopUpClearingDays,
        organizationClearingDays: input.organizationClearingDays,
      },
    });
    return view;
  }

  /** Set or clear one currency's optional minimum and maximum. */
  async setLimit(
    actorUserId: string,
    input: {
      readonly currency: string;
      readonly minAmountMinor: bigint | null;
      readonly maxAmountMinor: bigint | null;
    },
    context: RequestContext,
  ): Promise<WithdrawalPolicyView> {
    if (!isKnownCurrency(input.currency)) {
      throw invalid('currency', 'Choose a supported currency.');
    }
    for (const [field, value] of [
      ['minAmountMinorUnits', input.minAmountMinor],
      ['maxAmountMinorUnits', input.maxAmountMinor],
    ] as const) {
      if (value !== null && (value <= 0n || value > 1_000_000_000_000_000n)) {
        throw invalid(field, 'A limit must be a positive amount.');
      }
    }
    if (
      input.minAmountMinor !== null &&
      input.maxAmountMinor !== null &&
      input.minAmountMinor > input.maxAmountMinor
    ) {
      throw invalid('minAmountMinorUnits', 'The minimum cannot exceed the maximum.');
    }

    const view = await this.tenant.withPlatformAdmin(
      { actorUserId, reason: 'change a withdrawal limit' },
      async (tx) => {
        if (input.minAmountMinor === null && input.maxAmountMinor === null) {
          await tx.withdrawalCurrencyLimit.deleteMany({ where: { currency: input.currency } });
        } else {
          await tx.withdrawalCurrencyLimit.upsert({
            where: { currency: input.currency },
            create: {
              currency: input.currency,
              minAmountMinor: input.minAmountMinor,
              maxAmountMinor: input.maxAmountMinor,
              updatedByUserId: actorUserId,
            },
            update: {
              minAmountMinor: input.minAmountMinor,
              maxAmountMinor: input.maxAmountMinor,
              updatedByUserId: actorUserId,
              updatedAt: this.clock.now(),
            },
          });
        }
        return this.viewIn(tx);
      },
    );
    await this.events.audit({
      action: 'WITHDRAWAL_LIMIT_UPDATED',
      actorUserId,
      targetType: 'WithdrawalCurrencyLimit',
      targetId: input.currency,
      requestId: context.requestId,
      ipAddress: context.ipAddress,
      afterState: {
        currency: input.currency,
        minAmountMinor: input.minAmountMinor?.toString() ?? null,
        maxAmountMinor: input.maxAmountMinor?.toString() ?? null,
      },
    });
    return view;
  }

  // -------------------------------------------------------------------------
  // Reviewers
  // -------------------------------------------------------------------------

  async reviewers(actorUserId: string): Promise<readonly WithdrawalReviewerView[]> {
    const rows = await this.tenant.withPlatformAdmin(
      { actorUserId, reason: 'read withdrawal reviewers' },
      (tx) =>
        tx.$queryRaw<
          Array<{
            user_id: string;
            display_name: string | null;
            email: string;
            eligible: boolean;
            created_at: Date;
          }>
        >`
          SELECT wr."user_id", u."display_name", u."email",
                 app_notification_is_platform_reviewer(wr."user_id", ${REVIEW_PERMISSION}) AS "eligible",
                 wr."created_at"
            FROM "withdrawal_reviewers" wr
            JOIN "users" u ON u."id" = wr."user_id"
           ORDER BY lower(coalesce(u."display_name", u."email")), wr."user_id"`,
    );
    return rows.map((row) => ({
      userId: row.user_id,
      displayName: row.display_name,
      email: row.email,
      eligible: row.eligible,
      assignedAt: row.created_at.toISOString(),
    }));
  }

  /**
   * Who may be assigned: ACTIVE users holding finance:withdrawal:review
   * through a GLOBAL role. No arbitrary address can ever be offered.
   */
  async reviewerCandidates(
    actorUserId: string,
  ): Promise<readonly WithdrawalReviewerCandidateView[]> {
    const rows = await this.tenant.withPlatformAdmin(
      { actorUserId, reason: 'list withdrawal reviewer candidates' },
      (tx) =>
        tx.$queryRaw<Array<{ user_id: string; display_name: string | null; email: string }>>`
          SELECT DISTINCT u."id" AS "user_id", u."display_name", u."email",
                 lower(coalesce(u."display_name", u."email")) AS "sort_key"
            FROM "user_roles" ur
            JOIN "role_permissions" rp ON rp."role_id" = ur."role_id"
            JOIN "permissions" p ON p."id" = rp."permission_id" AND p."code" = ${REVIEW_PERMISSION}
            JOIN "users" u ON u."id" = ur."user_id"
           WHERE ur."scope" = 'GLOBAL'
             AND ur."organization_id" IS NULL
             AND u."status" = 'ACTIVE'
           ORDER BY "sort_key", u."id"`,
    );
    return rows.map((row) => ({
      userId: row.user_id,
      displayName: row.display_name,
      email: row.email,
    }));
  }

  /**
   * Make the assigned reviewers exactly `ids`. An empty list is allowed and
   * means "every global finance reviewer" — the routing records which applied.
   */
  async replaceReviewers(
    actorUserId: string,
    ids: readonly string[],
    context: RequestContext,
  ): Promise<readonly WithdrawalReviewerView[]> {
    if (ids.length > MAX_WITHDRAWAL_REVIEWERS) {
      throw invalid('userIds', `At most ${MAX_WITHDRAWAL_REVIEWERS} reviewers may be assigned.`);
    }
    if (new Set(ids).size !== ids.length) {
      throw invalid('userIds', 'Each reviewer may be assigned only once.');
    }
    const change = await this.tenant.withPlatformAdmin(
      { actorUserId, reason: 'change withdrawal reviewers' },
      async (tx) => {
        const current = await tx.withdrawalReviewer.findMany({ select: { userId: true } });
        const existing = new Set(current.map((row) => row.userId));
        const wanted = new Set(ids);
        const added = ids.filter((id) => !existing.has(id));
        const removed = [...existing].filter((id) => !wanted.has(id));
        if (added.length > 0) {
          const eligible = await tx.$queryRaw<Array<{ user_id: string }>>`
            SELECT u."id" AS "user_id" FROM "users" u
             WHERE u."id" = ANY(${added}::uuid[])
               AND app_notification_is_platform_reviewer(u."id", ${REVIEW_PERMISSION})`;
          const ok = new Set(eligible.map((row) => row.user_id));
          const refused = added.find((id) => !ok.has(id));
          if (refused !== undefined) {
            throw new AppError(PalCertErrorCode.VALIDATION_FAILED, {
              message:
                'Only active PalCert staff who can review withdrawals may be assigned as reviewers.',
              details: { field: 'userIds', userId: refused },
            });
          }
        }
        if (removed.length > 0) {
          await tx.withdrawalReviewer.deleteMany({ where: { userId: { in: removed } } });
        }
        if (added.length > 0) {
          await tx.withdrawalReviewer.createMany({
            data: added.map((userId) => ({ userId, createdByUserId: actorUserId })),
          });
        }
        return { added, removed };
      },
    );
    if (change.added.length + change.removed.length > 0) {
      await this.events.audit({
        action: 'WITHDRAWAL_REVIEWERS_UPDATED',
        actorUserId,
        targetType: 'WithdrawalReviewers',
        targetId: null,
        requestId: context.requestId,
        ipAddress: context.ipAddress,
        afterState: { added: change.added, removed: change.removed },
      });
    }
    return this.reviewers(actorUserId);
  }

  private async viewIn(tx: TenantClient): Promise<WithdrawalPolicyView> {
    const policy = await tx.withdrawalPolicy.findUnique({ where: { id: 1 } });
    const limits = await tx.withdrawalCurrencyLimit.findMany({ orderBy: { currency: 'asc' } });
    return {
      userManualTopUpClearingDays:
        policy?.userManualTopUpClearingDays ??
        WITHDRAWAL_POLICY_BOUNDS.userManualTopUpClearingDays.default,
      organizationClearingDays:
        policy?.organizationClearingDays ??
        WITHDRAWAL_POLICY_BOUNDS.organizationClearingDays.default,
      limits: limits.map((limit) => ({
        currency: limit.currency,
        ...this.limitViews(limit.currency, {
          minAmountMinor: limit.minAmountMinor,
          maxAmountMinor: limit.maxAmountMinor,
        }),
      })),
      feeMinorUnits: '0',
      version: policy?.version ?? 1,
      updatedAt: policy?.updatedAt.toISOString() ?? null,
    };
  }
}
