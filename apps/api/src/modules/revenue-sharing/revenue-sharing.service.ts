import { Injectable } from '@nestjs/common';
import {
  AppError,
  PalCertErrorCode,
  REVENUE_SERVICE_CODES,
  formatCommissionPercent,
  parseCommissionPercent,
  money,
  type RevenueServiceCode,
  type OrganizationRevenueSharesView,
  type OrganizationServiceRevenueView,
} from '@palcert/contracts';
import {
  TenantPrismaService,
  type TenantClient,
} from '../../infrastructure/tenant/tenant-prisma.service';
import { ClockPort } from '../auth/ports/clock.port';
import { SecurityEventService } from '../auth/services/security-event.service';
import { AttestationFinanceService } from '../attestations/services/attestation-finance.service';
import type { TenantContext } from '../organizations/tenant-context';
import { scopeOf } from '../attestations/services/attestation-type.service';

@Injectable()
export class RevenueSharingService {
  constructor(
    private readonly tenant: TenantPrismaService,
    private readonly clock: ClockPort,
    private readonly audit: SecurityEventService,
    private readonly attestations: AttestationFinanceService,
  ) {}

  async rates(actorUserId: string, organizationId: string): Promise<OrganizationRevenueSharesView> {
    const attestation = await this.attestations.commission(actorUserId, organizationId);
    return this.tenant.withPlatformAdmin(
      { actorUserId, organizationId, reason: 'read institution service revenue shares' },
      async (tx) => {
        const organization = await this.organization(tx, organizationId);
        const rows = await tx.organizationServiceShare.findMany({
          where: { organizationId },
          orderBy: [{ effectiveFrom: 'desc' }, { createdAt: 'desc' }, { id: 'desc' }],
        });
        const now = this.clock.now();
        return {
          organizationId,
          organizationName: organization.displayName,
          rates: REVENUE_SERVICE_CODES.map((serviceCode) => {
            if (serviceCode === 'ATTESTATION')
              return {
                serviceCode,
                institutionPercent: complement(attestation.currentPercent),
                platformPercent: attestation.currentPercent,
                isDefault: attestation.isDefault,
                effectiveFrom: attestation.currentEffectiveFrom,
                history: attestation.history.map((row) => ({
                  ...row,
                  institutionPercent: complement(row.percent),
                })),
              };
            const history = rows.filter((row) => row.productCode === serviceCode);
            const current = history.find((row) => row.effectiveFrom <= now);
            const bps = current?.institutionBps ?? 0;
            return {
              serviceCode,
              institutionPercent: formatCommissionPercent(bps),
              platformPercent: formatCommissionPercent(10000 - bps),
              isDefault: current === undefined,
              effectiveFrom: current?.effectiveFrom.toISOString() ?? null,
              history: history.slice(0, 100).map((row) => ({
                id: row.id,
                institutionPercent: formatCommissionPercent(row.institutionBps),
                effectiveFrom: row.effectiveFrom.toISOString(),
                changedByUserId: row.changedByUserId,
                changeReason: row.changeReason,
                createdAt: row.createdAt.toISOString(),
              })),
            };
          }),
        };
      },
    );
  }

  async setRate(
    actorUserId: string,
    organizationId: string,
    serviceCode: RevenueServiceCode,
    input: { institutionPercent: string; reason: string; effectiveFrom?: string },
    requestId: string | null,
  ): Promise<OrganizationRevenueSharesView> {
    const bps = parseCommissionPercent(input.institutionPercent);
    const reason = input.reason.trim();
    const now = this.clock.now();
    const effectiveFrom = input.effectiveFrom ? new Date(input.effectiveFrom) : now;
    if (
      bps === null ||
      !reason ||
      reason.length > 500 ||
      !REVENUE_SERVICE_CODES.includes(serviceCode) ||
      Number.isNaN(effectiveFrom.getTime()) ||
      effectiveFrom.getTime() < now.getTime() - 60000
    ) {
      throw new AppError(PalCertErrorCode.VALIDATION_FAILED, {
        message: 'Enter a share from 0 to 100%, a reason, and an effective time of now or later.',
      });
    }
    if (serviceCode === 'ATTESTATION') {
      await this.attestations.setCommission(
        actorUserId,
        organizationId,
        {
          percent: formatCommissionPercent(10000 - bps),
          reason,
          effectiveFrom: effectiveFrom.toISOString(),
        },
        requestId,
      );
    } else {
      await this.tenant.withPlatformAdmin(
        { actorUserId, organizationId, reason: 'set institution service revenue share' },
        async (tx) => {
          await this.organization(tx, organizationId);
          await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`service-share:${organizationId}:${serviceCode}`}, 0))::text`;
          const latest = await tx.organizationServiceShare.findFirst({
            where: { organizationId, productCode: serviceCode },
            orderBy: { createdAt: 'desc' },
          });
          const createdAt =
            latest && latest.createdAt >= now ? new Date(latest.createdAt.getTime() + 1) : now;
          const row = await tx.organizationServiceShare.create({
            data: {
              organizationId,
              productCode: serviceCode,
              institutionBps: bps,
              effectiveFrom,
              changedByUserId: actorUserId,
              changeReason: reason,
              createdAt,
            },
          });
          await this.audit.auditWithin(tx, {
            action: 'ORGANIZATION_SERVICE_SHARE_CHANGED',
            actorUserId,
            targetType: 'Organization',
            targetId: organizationId,
            requestId,
            afterState: {
              policyId: row.id,
              serviceCode,
              institutionBps: bps,
              effectiveFrom: effectiveFrom.toISOString(),
              reason,
            },
          });
        },
      );
    }
    return this.rates(actorUserId, organizationId);
  }

  async adminRevenue(
    actorUserId: string,
    organizationId: string,
    cursor?: string,
  ): Promise<OrganizationServiceRevenueView> {
    return this.tenant.withPlatformAdmin(
      { actorUserId, organizationId, reason: 'read institution service settlements' },
      async (tx) => {
        await this.organization(tx, organizationId);
        return this.revenue(tx, organizationId, cursor);
      },
    );
  }
  async organizationRevenue(
    context: TenantContext,
    cursor?: string,
  ): Promise<OrganizationServiceRevenueView> {
    return this.tenant.withTenant(scopeOf(context), (tx) =>
      this.revenue(tx, context.organizationId, cursor),
    );
  }

  private async organization(tx: TenantClient, id: string) {
    const row = await tx.organization.findUnique({
      where: { id },
      select: { id: true, displayName: true },
    });
    if (!row)
      throw new AppError(PalCertErrorCode.ORGANIZATION_NOT_FOUND, {
        message: 'No such institution.',
      });
    return row;
  }
  private async revenue(
    tx: TenantClient,
    organizationId: string,
    cursor?: string,
  ): Promise<OrganizationServiceRevenueView> {
    const offset = cursor === undefined ? 0 : Number(cursor);
    if (!Number.isSafeInteger(offset) || offset < 0 || offset > 1000000)
      throw new AppError(PalCertErrorCode.VALIDATION_FAILED, { message: 'Invalid cursor.' });
    type Row = {
      id: string;
      serviceCode: RevenueServiceCode;
      referenceId: string;
      currency: string;
      gross: bigint;
      institution: bigint;
      platform: bigint;
      createdAt: Date;
      isRefund: boolean;
    };
    // UNION keeps legacy attestation settlements intact and avoids counting them twice.
    const rows = await tx.$queryRaw<Row[]>`
      SELECT * FROM (
        SELECT id::text, product_code::text AS "serviceCode", purchase_id::text AS "referenceId", currency,
          gross_minor AS gross, institution_minor AS institution, platform_minor AS platform,
          created_at AS "createdAt", reversal_of_id IS NOT NULL AS "isRefund"
        FROM service_revenue_entries WHERE organization_id = ${organizationId}::uuid
        UNION ALL
        SELECT id::text, 'ATTESTATION', request_id::text, currency, gross_minor, institution_net_minor, platform_fee_minor, settled_at, false
        FROM attestation_settlements WHERE organization_id = ${organizationId}::uuid
      ) entries ORDER BY "createdAt" DESC, id DESC LIMIT 51 OFFSET ${offset}`;
    const totals = await tx.$queryRaw<
      Array<{
        serviceCode: RevenueServiceCode;
        currency: string;
        gross: bigint;
        institution: bigint;
        platform: bigint;
      }>
    >`
      SELECT "serviceCode", currency, sum(gross)::bigint AS gross, sum(institution)::bigint AS institution, sum(platform)::bigint AS platform
      FROM (
        SELECT product_code::text AS "serviceCode", currency, gross_minor AS gross, institution_minor AS institution, platform_minor AS platform
        FROM service_revenue_entries WHERE organization_id = ${organizationId}::uuid
        UNION ALL
        SELECT 'ATTESTATION', currency, gross_minor, institution_net_minor, platform_fee_minor
        FROM attestation_settlements WHERE organization_id = ${organizationId}::uuid
      ) entries GROUP BY "serviceCode", currency ORDER BY "serviceCode", currency`;
    const amounts = (row: {
      currency: string;
      gross: bigint;
      institution: bigint;
      platform: bigint;
    }) => ({
      gross: money(row.currency, row.gross),
      institution: money(row.currency, row.institution),
      platform: money(row.currency, row.platform),
    });
    return {
      totals: totals.map((row) => ({
        serviceCode: row.serviceCode,
        currency: row.currency,
        ...amounts(row),
      })),
      entries: rows
        .slice(0, 50)
        .map((row) => ({ ...row, ...amounts(row), createdAt: row.createdAt.toISOString() })),
      nextCursor: rows.length > 50 ? String(offset + 50) : null,
    };
  }
}
function complement(percent: string): string {
  return formatCommissionPercent(10000 - parseCommissionPercent(percent)!);
}
