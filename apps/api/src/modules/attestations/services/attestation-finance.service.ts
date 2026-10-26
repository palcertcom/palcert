import { Injectable } from '@nestjs/common';
import {
  AppError,
  AttestationPaymentStatus,
  AttestationRequestStatus,
  AttestationVerificationStatus,
  DEFAULT_COMMISSION_BPS,
  PalCertErrorCode,
  attestationVerificationStatus,
  formatCommissionPercent,
  isCalendarDate,
  money,
  parseCommissionPercent,
  type AttestationCommissionView,
  type AttestationRevenueTotalsView,
  type AttestationSettlementLineView,
  type OrganizationAttestationRevenueView,
  type PlatformAttestationOverviewView,
} from '@palcert/contracts';
import type { Prisma } from '@palcert/database';
import {
  TenantPrismaService,
  type TenantClient,
} from '../../../infrastructure/tenant/tenant-prisma.service';
import { ClockPort } from '../../auth/ports/clock.port';
import { SecurityEventService } from '../../auth/services/security-event.service';
import type { TenantContext } from '../../organizations/tenant-context';
import { cleanText, parseIsoDate } from '../attestation-support';
import { scopeOf } from './attestation-type.service';

export interface RevenueQuery {
  readonly from?: string | undefined;
  readonly to?: string | undefined;
  readonly attestationTypeId?: string | undefined;
  readonly status?: AttestationRequestStatus | undefined;
  readonly paymentStatus?: AttestationPaymentStatus | undefined;
  readonly search?: string | undefined;
  readonly cursor?: string | undefined;
  readonly limit?: number | undefined;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Attestation money, as each audience may see it (§21–§24).
 *
 * Every figure here is read from the ledger-backed records — settlements and
 * their revenue entries for what was earned, the requests' own price snapshots
 * for what is merely reserved or was released. Nothing is derived from an
 * attestation, and nothing here writes a balance.
 */
@Injectable()
export class AttestationFinanceService {
  constructor(
    private readonly tenant: TenantPrismaService,
    private readonly events: SecurityEventService,
    private readonly clock: ClockPort,
  ) {}

  // -------------------------------------------------------------------------
  // Commission (PalCert administration)
  // -------------------------------------------------------------------------

  async commission(
    actorUserId: string,
    organizationId: string,
  ): Promise<AttestationCommissionView> {
    return this.tenant.withPlatformAdmin(
      { actorUserId, reason: 'read an organization attestation commission', organizationId },
      async (tx) => {
        await assertOrganization(tx, organizationId);
        return this.commissionView(tx, organizationId);
      },
    );
  }

  /**
   * Set PalCert's commission for one institution.
   *
   * A new row, never an edit: the history says who changed the rate, when it
   * took effect and why, and every request already submitted keeps the rate
   * it was submitted under.
   */
  async setCommission(
    actorUserId: string,
    organizationId: string,
    input: {
      readonly percent: string;
      readonly effectiveFrom?: string | null;
      readonly reason: string;
    },
    requestId: string | null,
  ): Promise<AttestationCommissionView> {
    const bps = parseCommissionPercent(input.percent);
    if (bps === null) {
      throw new AppError(PalCertErrorCode.ATTESTATION_COMMISSION_INVALID, {
        message: 'A commission must be between 0% and 100%, with at most two decimals.',
      });
    }
    const reason = cleanText(input.reason);
    if (reason === null || reason.length > 500) {
      throw new AppError(PalCertErrorCode.VALIDATION_FAILED, {
        message: 'Say why the commission is changing (at most 500 characters).',
      });
    }
    const now = this.clock.now();
    let effectiveFrom = now;
    if (
      input.effectiveFrom !== undefined &&
      input.effectiveFrom !== null &&
      input.effectiveFrom !== ''
    ) {
      const parsed = new Date(input.effectiveFrom);
      if (Number.isNaN(parsed.getTime()) || parsed.getTime() < now.getTime() - 60_000) {
        throw new AppError(PalCertErrorCode.ATTESTATION_COMMISSION_INVALID, {
          message: 'A commission change takes effect now or in the future, never in the past.',
        });
      }
      effectiveFrom = parsed;
    }

    return this.tenant.withPlatformAdmin(
      { actorUserId, reason: 'set an organization attestation commission', organizationId },
      async (tx) => {
        await assertOrganization(tx, organizationId);
        // Changes to one institution's rate are serialised, and each row is
        // recorded strictly after the one before it, so "the latest change at
        // an instant" is never a tie, even under a frozen or coarse clock.
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${'attestation-commission:' + organizationId}, 0))`;
        const before = await currentCommission(tx, organizationId, now);
        const latest = await tx.organizationAttestationCommission.findFirst({
          where: { organizationId },
          orderBy: [{ createdAt: 'desc' }],
          select: { createdAt: true },
        });
        const createdAt =
          latest !== null && latest.createdAt.getTime() >= now.getTime()
            ? new Date(latest.createdAt.getTime() + 1)
            : now;
        const created = await tx.organizationAttestationCommission.create({
          data: {
            organizationId,
            commissionBps: bps,
            effectiveFrom,
            changedByUserId: actorUserId,
            changeReason: reason,
            createdAt,
          },
        });
        await this.events.auditWithin(tx, {
          action: 'ORGANIZATION_ATTESTATION_COMMISSION_CHANGED',
          actorUserId,
          targetType: 'Organization',
          targetId: organizationId,
          requestId,
          beforeState: { commissionBps: before?.commissionBps ?? DEFAULT_COMMISSION_BPS },
          afterState: {
            commissionBps: created.commissionBps,
            effectiveFrom: effectiveFrom.toISOString(),
            commissionId: created.id,
          },
        });
        return this.commissionView(tx, organizationId);
      },
    );
  }

  private async commissionView(
    tx: TenantClient,
    organizationId: string,
  ): Promise<AttestationCommissionView> {
    const now = this.clock.now();
    const history = await tx.organizationAttestationCommission.findMany({
      where: { organizationId },
      orderBy: [{ effectiveFrom: 'desc' }, { createdAt: 'desc' }],
      take: 100,
    });
    const names = new Map<string, string>();
    const users = await tx.user.findMany({
      where: { id: { in: [...new Set(history.map((row) => row.changedByUserId))] } },
      select: { id: true, displayName: true },
    });
    for (const user of users) names.set(user.id, user.displayName ?? '');
    const current = history.find((row) => row.effectiveFrom.getTime() <= now.getTime()) ?? null;
    return {
      organizationId,
      currentPercent: formatCommissionPercent(current?.commissionBps ?? DEFAULT_COMMISSION_BPS),
      currentEffectiveFrom: current?.effectiveFrom.toISOString() ?? null,
      isDefault: current === null,
      history: history.map((row) => ({
        id: row.id,
        percent: formatCommissionPercent(row.commissionBps),
        effectiveFrom: row.effectiveFrom.toISOString(),
        changedByUserId: row.changedByUserId,
        changedByName: names.get(row.changedByUserId) ?? null,
        changeReason: row.changeReason,
        createdAt: row.createdAt.toISOString(),
      })),
    };
  }

  // -------------------------------------------------------------------------
  // Institution revenue
  // -------------------------------------------------------------------------

  async organizationRevenue(
    context: TenantContext,
    query: RevenueQuery,
  ): Promise<OrganizationAttestationRevenueView> {
    return this.tenant.withTenant(scopeOf(context), (tx) =>
      this.revenue(tx, context.organizationId, query),
    );
  }

  /** The same report for one organization, for PalCert staff. */
  async adminOrganizationRevenue(
    actorUserId: string,
    organizationId: string,
    query: RevenueQuery,
  ): Promise<OrganizationAttestationRevenueView> {
    return this.tenant.withPlatformAdmin(
      { actorUserId, reason: 'read an organization attestation revenue report', organizationId },
      async (tx) => {
        await assertOrganization(tx, organizationId);
        return this.revenue(tx, organizationId, query);
      },
    );
  }

  private async revenue(
    tx: TenantClient,
    organizationId: string,
    query: RevenueQuery,
  ): Promise<OrganizationAttestationRevenueView> {
    const limit = Math.min(Math.max(query.limit ?? 50, 1), 200);
    const offset = decodeOffset(query.cursor);
    const where: Prisma.AttestationRequestWhereInput = {
      organizationId,
      pricedAt: { not: null },
      ...(query.attestationTypeId === undefined
        ? {}
        : { attestationTypeId: query.attestationTypeId }),
      ...(query.status === undefined ? {} : { status: query.status }),
      ...(query.paymentStatus === undefined ? {} : { paymentStatus: query.paymentStatus }),
      ...dateRange(query.from, query.to),
    };
    const search = cleanText(query.search ?? null);
    if (search !== null) {
      where.OR = [
        { certificateTitle: { contains: search, mode: 'insensitive' } },
        { captureEntryId: isUuid(search) ? search : undefined },
        { attestation: { reference: { contains: search.toUpperCase() } } },
      ].filter(
        (clause) => Object.values(clause)[0] !== undefined,
      ) as Prisma.AttestationRequestWhereInput[];
    }

    const [rows, all] = await Promise.all([
      tx.attestationRequest.findMany({
        where,
        include: { attestation: { select: { reference: true } }, settlement: true },
        orderBy: [{ submittedAt: 'desc' }, { id: 'desc' }],
        skip: offset,
        take: limit + 1,
      }),
      tx.attestationRequest.findMany({
        where,
        select: {
          currency: true,
          paymentStatus: true,
          grossFeeMinor: true,
          platformFeeMinor: true,
          institutionNetMinor: true,
        },
      }),
    ]);
    const page = rows.slice(0, limit);
    const owners = await ownerNames(
      tx,
      page.map((row) => row.id),
    );

    const totals = new Map<
      string,
      {
        gross: bigint;
        platform: bigint;
        net: bigint;
        reserved: bigint;
        settled: bigint;
        released: bigint;
      }
    >();
    for (const row of all) {
      if (row.currency === null) continue;
      const bucket = totals.get(row.currency) ?? {
        gross: 0n,
        platform: 0n,
        net: 0n,
        reserved: 0n,
        settled: 0n,
        released: 0n,
      };
      const gross = row.grossFeeMinor ?? 0n;
      if (row.paymentStatus === AttestationPaymentStatus.SETTLED) {
        bucket.gross += gross;
        bucket.platform += row.platformFeeMinor ?? 0n;
        bucket.net += row.institutionNetMinor ?? 0n;
        bucket.settled += gross;
      } else if (row.paymentStatus === AttestationPaymentStatus.RESERVED) {
        bucket.reserved += gross;
      } else if (row.paymentStatus === AttestationPaymentStatus.RELEASED) {
        bucket.released += gross;
      }
      totals.set(row.currency, bucket);
    }

    const totalsView: AttestationRevenueTotalsView[] = [...totals.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([currency, bucket]) => ({
        currency,
        gross: money(currency, bucket.gross),
        platformFee: money(currency, bucket.platform),
        institutionNet: money(currency, bucket.net),
        pendingReserved: money(currency, bucket.reserved),
        settled: money(currency, bucket.settled),
        released: money(currency, bucket.released),
      }));

    const lines: AttestationSettlementLineView[] = page.map((row) => {
      const currency = row.currency ?? 'USD';
      return {
        requestId: row.id,
        attestationReference: row.attestation?.reference ?? null,
        attestationTypeName: { en: row.typeNameEn, ar: row.typeNameAr },
        ownerDisplayName: owners.get(row.id) ?? '',
        status: row.status as AttestationRequestStatus,
        paymentStatus: row.paymentStatus as AttestationPaymentStatus,
        gross: money(currency, row.grossFeeMinor ?? 0n),
        platformFee: money(currency, row.platformFeeMinor ?? 0n),
        institutionNet: money(currency, row.institutionNetMinor ?? 0n),
        platformCommissionPercent: formatCommissionPercent(row.platformCommissionBps ?? 0),
        submittedAt: row.submittedAt?.toISOString() ?? null,
        settledAt: row.paymentSettledAt?.toISOString() ?? null,
        releasedAt: row.paymentReleasedAt?.toISOString() ?? null,
        transactionReference: row.captureEntryId,
      };
    });

    return {
      totals: totalsView,
      lines,
      nextCursor: rows.length > limit ? encodeOffset(offset + limit) : null,
    };
  }

  // -------------------------------------------------------------------------
  // Platform overview
  // -------------------------------------------------------------------------

  async platformOverview(
    actorUserId: string,
    query: { readonly from?: string; readonly to?: string; readonly organizationId?: string },
  ): Promise<PlatformAttestationOverviewView> {
    const now = this.clock.now();
    return this.tenant.withPlatformAdmin(
      { actorUserId, reason: 'read platform attestation finance' },
      async (tx) => {
        const scope: Prisma.AttestationRequestWhereInput = {
          status: { not: AttestationRequestStatus.DRAFT },
          ...(query.organizationId === undefined ? {} : { organizationId: query.organizationId }),
          ...dateRange(query.from, query.to),
        };
        const requests = await tx.attestationRequest.findMany({
          where: scope,
          select: {
            organizationId: true,
            organizationName: true,
            status: true,
            currency: true,
            paymentStatus: true,
            grossFeeMinor: true,
            platformFeeMinor: true,
            institutionNetMinor: true,
            attestation: { select: { revokedAt: true, validUntil: true } },
          },
        });

        const counts = {
          requests: 0,
          approvals: 0,
          rejections: 0,
          valid: 0,
          expired: 0,
          revoked: 0,
        };
        const byCurrency = new Map<string, { gross: bigint; platform: bigint; net: bigint }>();
        const byOrganization = new Map<
          string,
          {
            name: string;
            currency: string;
            gross: bigint;
            platform: bigint;
            net: bigint;
            approved: number;
            rejected: number;
            pending: number;
          }
        >();

        for (const row of requests) {
          counts.requests += 1;
          if (row.status === AttestationRequestStatus.APPROVED) counts.approvals += 1;
          if (row.status === AttestationRequestStatus.REJECTED) counts.rejections += 1;
          if (row.attestation !== null) {
            const status = attestationVerificationStatus({
              revokedAt: row.attestation.revokedAt,
              validUntil: row.attestation.validUntil,
              now,
            });
            if (status === AttestationVerificationStatus.VALID) counts.valid += 1;
            if (status === AttestationVerificationStatus.EXPIRED) counts.expired += 1;
            if (status === AttestationVerificationStatus.REVOKED) counts.revoked += 1;
          }
          const currency = row.currency ?? 'USD';
          const key = `${row.organizationId}:${currency}`;
          const org = byOrganization.get(key) ?? {
            name: row.organizationName,
            currency,
            gross: 0n,
            platform: 0n,
            net: 0n,
            approved: 0,
            rejected: 0,
            pending: 0,
          };
          if (row.status === AttestationRequestStatus.APPROVED) org.approved += 1;
          if (row.status === AttestationRequestStatus.REJECTED) org.rejected += 1;
          if (
            row.status === AttestationRequestStatus.SUBMITTED ||
            row.status === AttestationRequestStatus.IN_REVIEW ||
            row.status === AttestationRequestStatus.NEEDS_INFORMATION
          ) {
            org.pending += 1;
          }
          if (row.paymentStatus === AttestationPaymentStatus.SETTLED) {
            org.gross += row.grossFeeMinor ?? 0n;
            org.platform += row.platformFeeMinor ?? 0n;
            org.net += row.institutionNetMinor ?? 0n;
            const bucket = byCurrency.get(currency) ?? { gross: 0n, platform: 0n, net: 0n };
            bucket.gross += row.grossFeeMinor ?? 0n;
            bucket.platform += row.platformFeeMinor ?? 0n;
            bucket.net += row.institutionNetMinor ?? 0n;
            byCurrency.set(currency, bucket);
          }
          byOrganization.set(key, org);
        }

        const organizationIds = [
          ...new Set([...byOrganization.keys()].map((key) => key.split(':')[0]!)),
        ];
        const rates = new Map<string, number>();
        for (const organizationId of organizationIds) {
          const current = await currentCommission(tx, organizationId, now);
          rates.set(organizationId, current?.commissionBps ?? DEFAULT_COMMISSION_BPS);
        }

        return {
          ...counts,
          byCurrency: [...byCurrency.entries()].map(([currency, bucket]) => ({
            currency,
            gross: money(currency, bucket.gross),
            platformCommission: money(currency, bucket.platform),
            organizationNet: money(currency, bucket.net),
          })),
          organizations: [...byOrganization.entries()]
            .map(([key, org]) => {
              const organizationId = key.split(':')[0]!;
              return {
                organizationId,
                organizationName: org.name,
                currency: org.currency,
                currentCommissionPercent: formatCommissionPercent(rates.get(organizationId) ?? 0),
                gross: money(org.currency, org.gross),
                platformRevenue: money(org.currency, org.platform),
                institutionNet: money(org.currency, org.net),
                approved: org.approved,
                rejected: org.rejected,
                pending: org.pending,
              };
            })
            .sort((a, b) => a.organizationName.localeCompare(b.organizationName)),
        };
      },
    );
  }
}

// ---------------------------------------------------------------------------

async function assertOrganization(tx: TenantClient, organizationId: string): Promise<void> {
  const organization = await tx.organization.findUnique({
    where: { id: organizationId },
    select: { id: true },
  });
  if (organization === null) {
    throw new AppError(PalCertErrorCode.ORGANIZATION_NOT_FOUND, {
      message: 'No such organization.',
    });
  }
}

async function currentCommission(tx: TenantClient, organizationId: string, at: Date) {
  return tx.organizationAttestationCommission.findFirst({
    where: { organizationId, effectiveFrom: { lte: at } },
    orderBy: [{ effectiveFrom: 'desc' }, { createdAt: 'desc' }, { id: 'desc' }],
  });
}

/**
 * Requesters' display names, by request, through the same narrow function the
 * review queue uses: it answers only for the organization in scope.
 */
async function ownerNames(
  tx: TenantClient,
  requestIds: readonly string[],
): Promise<Map<string, string>> {
  if (requestIds.length === 0) return new Map();
  const rows = await tx.$queryRaw<Array<{ request_id: string; display_name: string }>>`
    SELECT * FROM app_attestation_request_owners(${[...requestIds]}::uuid[])`;
  return new Map(rows.map((row) => [row.request_id, row.display_name]));
}

function dateRange(
  from: string | undefined,
  to: string | undefined,
): Prisma.AttestationRequestWhereInput {
  const range: { gte?: Date; lt?: Date } = {};
  if (from !== undefined && isCalendarDate(from)) range.gte = parseIsoDate(from)!;
  if (to !== undefined && isCalendarDate(to))
    range.lt = new Date(parseIsoDate(to)!.getTime() + DAY_MS);
  return Object.keys(range).length === 0 ? {} : { submittedAt: range };
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}

function encodeOffset(offset: number): string {
  return Buffer.from(`o:${offset}`, 'utf8').toString('base64url');
}

function decodeOffset(cursor: string | undefined): number {
  if (cursor === undefined || cursor === '') return 0;
  const match = /^o:(\d{1,7})$/.exec(Buffer.from(cursor, 'base64url').toString('utf8'));
  return match === null ? 0 : Number(match[1]);
}
