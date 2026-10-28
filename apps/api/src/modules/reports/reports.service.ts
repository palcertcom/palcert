import { Injectable } from '@nestjs/common';
import { Prisma } from '@palcert/database';
import {
  AppError,
  PalCertErrorCode,
  type AccountReportView,
  type ReportTable,
} from '@palcert/contracts';
import {
  TenantPrismaService,
  type TenantClient,
} from '../../infrastructure/tenant/tenant-prisma.service';
import { ClockPort } from '../auth/ports/clock.port';
import { SecurityEventService } from '../auth/services/security-event.service';
import {
  ReportQuery,
  REPORT_EXPORT_LIMIT,
  REPORT_PAGE_SIZE,
  validateReportQuery,
} from './report-query';
import { reportLabels, reportCode, reportMoney } from './report-labels';

export type ReportScope = {
  kind: 'user' | 'organization' | 'platform';
  userId: string;
  organizationId?: string;
};
type FinancialRow = {
  id: string;
  at: string;
  reference: string;
  type: string;
  account: string;
  currency: string;
  amount: string;
};
type Balance = {
  currency: string;
  account: string;
  opening: string;
  credits: string;
  debits: string;
  closing: string;
};
type Activity = {
  id: string;
  created_at: string;
  service: string;
  status: string;
  payment: string;
  organization: string | null;
  currency: string | null;
  quoted: string | null;
  cash: string;
  promotional: string;
  refunded: string;
};

@Injectable()
export class ReportsService {
  constructor(
    private readonly tenant: TenantPrismaService,
    private readonly clock: ClockPort,
    private readonly audit: SecurityEventService,
  ) {}

  async report(scope: ReportScope, query: ReportQuery, full = false): Promise<AccountReportView> {
    const range = validateReportQuery(query);
    const generatedAt = this.clock.now().toISOString();
    const run = async (tx: TenantClient) => {
      const l = reportLabels[query.locale];
      const subject =
        scope.kind === 'organization'
          ? (
              await tx.organization.findUniqueOrThrow({
                where: { id: scope.organizationId! },
                select: { displayName: true },
              })
            ).displayName
          : scope.kind === 'user'
            ? ((
                await tx.user.findUniqueOrThrow({
                  where: { id: scope.userId },
                  select: { displayName: true },
                })
              ).displayName ?? l.user)
            : l.platform;
      const data =
        query.kind === 'financial'
          ? await this.financial(tx, scope, query, full)
          : await this.services(tx, query, full);
      if (full && data.total > REPORT_EXPORT_LIMIT) {
        throw new AppError(PalCertErrorCode.VALIDATION_FAILED, {
          message:
            'More than 5000 records. Narrow the reporting period or filters before exporting.',
          details: { reportReason: 'EXPORT_TOO_LARGE', maximumRows: REPORT_EXPORT_LIMIT },
        });
      }
      if (full || scope.kind === 'platform')
        await this.audit.auditWithin(tx, {
          action: full ? 'ACCOUNT_REPORT_EXPORTED' : 'PLATFORM_REPORT_READ',
          actorUserId: scope.userId,
          targetType: 'Report',
          targetId: scope.organizationId ?? scope.userId,
          afterState: {
            scope: scope.kind,
            kind: query.kind,
            from: query.from,
            to: query.to,
            count: data.total,
          },
        });
      return {
        kind: query.kind,
        locale: query.locale,
        scope: scope.kind,
        title: l[query.kind],
        subject,
        generatedAt,
        period: `${this.date(query.from, query)} — ${this.date(query.to, query)} (${query.timeZone})`,
        filters: `${l.currency}: ${query.currency ?? l.all}${query.kind === 'services' ? ` · ${l.service}: ${query.service ? reportCode(query.service, query.locale) : l.all} · ${l.status}: ${query.status ? reportCode(query.status, query.locale) : l.all}` : ''}`,
        notes: [
          l.periodNote,
          query.kind === 'services'
            ? l.serviceNote
            : scope.kind === 'user'
              ? l.balanceNote
              : l.revenueNote,
        ],
        ...data,
        offset: full ? 0 : range.offset,
        nextOffset:
          !full && range.offset + REPORT_PAGE_SIZE < data.total
            ? range.offset + REPORT_PAGE_SIZE
            : null,
      };
    };
    if (scope.kind === 'platform')
      return this.tenant.withPlatformAdmin(
        { actorUserId: scope.userId, reason: 'read financial/service report' },
        run,
      );
    if (scope.kind === 'organization')
      return this.tenant.withTenant(
        { userId: scope.userId, organizationId: scope.organizationId! },
        run,
      );
    return this.tenant.withUser(scope.userId, run);
  }

  private date(value: string, query: ReportQuery) {
    return new Intl.DateTimeFormat(query.locale === 'ar' ? 'ar-EG-u-nu-latn' : 'en-GB', {
      timeZone: query.timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    }).format(new Date(value));
  }

  private financialSource(scope: ReportScope): Prisma.Sql {
    if (scope.kind === 'user')
      return Prisma.sql`
      SELECT id::text, created_at AS at, coalesce(reference_id::text,id::text) AS reference,
        entry_type::text AS type, credit_class::text AS account, currency::text, amount_minor_signed::numeric AS amount
      FROM credit_ledger_entries WHERE owner_user_id = ${scope.userId}::uuid`;
    if (scope.kind === 'organization')
      return Prisma.sql`
      SELECT id::text, created_at AS at, purchase_id::text AS reference,
        CASE WHEN reversal_of_id IS NULL THEN 'REVENUE' ELSE 'REFUND' END AS type,
        'CASH'::text AS account, currency::text, institution_minor::numeric AS amount
      FROM service_revenue_entries WHERE organization_id = ${scope.organizationId}::uuid
      UNION ALL SELECT id::text, settled_at, request_id::text, 'ATTESTATION', 'CASH', currency::text, institution_net_minor::numeric
      FROM attestation_settlements WHERE organization_id = ${scope.organizationId}::uuid
      UNION ALL SELECT id::text, settled_at, request_id::text, 'PAYOUT', 'CASH', currency::text, -amount_minor::numeric
      FROM withdrawal_settlements WHERE scope = 'ORGANIZATION' AND organization_id = ${scope.organizationId}::uuid`;
    return Prisma.sql`
      SELECT h.captured_entry_id::text AS id, h.captured_at AS at, p.id::text AS reference, 'REVENUE'::text AS type,
        'CASH'::text AS account, a.currency::text, (a.amount_minor - coalesce(r.institution_minor,0))::numeric AS amount
      FROM service_purchase_allocations a JOIN credit_holds h ON h.id = a.hold_id JOIN service_purchases p ON p.id = a.purchase_id
      LEFT JOIN service_revenue_entries r ON r.ledger_entry_id = h.captured_entry_id
      WHERE a.credit_class = 'CASH' AND h.status = 'CAPTURED' AND p.status IN ('DELIVERED','REFUNDED')
      UNION ALL SELECT e.id::text, e.created_at, coalesce(r.purchase_id::text,e.reference_id::text,e.id::text), 'REFUND', 'CASH', e.currency::text,
        -(e.amount_minor_signed + coalesce(r.institution_minor,0))::numeric
      FROM credit_ledger_entries e LEFT JOIN service_revenue_entries r ON r.ledger_entry_id = e.id
      WHERE e.entry_type = 'SERVICE_REFUND' AND e.credit_class = 'CASH'
      UNION ALL SELECT id::text, settled_at, request_id::text, 'ATTESTATION', 'CASH', currency::text, platform_fee_minor::numeric FROM attestation_settlements
      UNION ALL SELECT id::text, settled_at, request_id::text, 'PAYOUT', 'CASH', currency::text, -amount_minor::numeric
      FROM withdrawal_settlements WHERE scope = 'PLATFORM'`;
  }

  private async financial(tx: TenantClient, scope: ReportScope, query: ReportQuery, full: boolean) {
    const { from, to, offset } = validateReportQuery(query);
    // One statement gives the summaries, count and details the SAME database snapshot.
    // Cast money to text inside JSON: no numeric parsing/rounding in JS.
    const [result] = await tx.$queryRaw<
      Array<{ rows: FinancialRow[]; balances: Balance[]; total: number }>
    >(Prisma.sql`
      WITH entries AS (${this.financialSource(scope)}), eligible AS (
        SELECT * FROM entries WHERE at < ${to} AND (${query.currency ?? null}::text IS NULL OR currency = ${query.currency ?? null})
      ), period AS (SELECT * FROM eligible WHERE at >= ${from}), balances AS (
        SELECT currency, account, coalesce(sum(amount) FILTER (WHERE at < ${from}),0)::text AS opening,
          coalesce(sum(amount) FILTER (WHERE at >= ${from} AND amount > 0),0)::text AS credits,
          coalesce(sum(-amount) FILTER (WHERE at >= ${from} AND amount < 0),0)::text AS debits,
          coalesce(sum(amount),0)::text AS closing FROM eligible GROUP BY currency, account ORDER BY currency, account
      ), page AS (SELECT id, at, reference, type, account, currency, amount::text FROM period ORDER BY at DESC, id DESC
        LIMIT ${full ? REPORT_EXPORT_LIMIT : REPORT_PAGE_SIZE} OFFSET ${full ? 0 : offset})
      SELECT (SELECT count(*)::int FROM period) AS total,
        coalesce((SELECT jsonb_agg(to_jsonb(page) ORDER BY at DESC,id DESC) FROM page),'[]'::jsonb) AS rows,
        coalesce((SELECT jsonb_agg(to_jsonb(balances) ORDER BY currency,account) FROM balances),'[]'::jsonb) AS balances`);
    const l = reportLabels[query.locale];
    const r = result!;
    return {
      total: r.total,
      summaries: [
        {
          title: l.summary,
          columns: [l.currency, l.account, l.opening, l.credits, l.debits, l.closing],
          rows: r.balances.map((b) => [
            b.currency,
            reportCode(b.account, query.locale),
            ...[b.opening, b.credits, b.debits, b.closing].map((n) => reportMoney(n, b.currency)),
          ]),
        },
      ],
      detail: {
        title: l.details,
        columns: [l.date, l.reference, l.type, l.account, l.currency, l.amount],
        rows: r.rows.map((row) => [
          this.date(row.at, query),
          row.reference,
          reportCode(row.type, query.locale),
          reportCode(row.account, query.locale),
          row.currency,
          reportMoney(row.amount, row.currency),
        ]),
      },
    };
  }

  private async services(tx: TenantClient, query: ReportQuery, full: boolean) {
    const { from, to, offset } = validateReportQuery(query);
    const [result] = await tx.$queryRaw<
      Array<{
        rows: Activity[];
        summary: Array<{ service: string; status: string; count: number }>;
        total: number;
      }>
    >`
      WITH activity AS MATERIALIZED (
        SELECT * FROM report_service_activity(${from}::timestamptz,${to}::timestamptz)
        WHERE (${query.currency ?? null}::text IS NULL OR currency = ${query.currency ?? null})
          AND (${query.service ?? null}::text IS NULL OR service = ${query.service ?? null})
          AND (${query.status ?? null}::text IS NULL OR status = ${query.status ?? null})
      ), summary AS (SELECT service,status,count(*)::int AS count FROM activity GROUP BY service,status),
      page AS (SELECT * FROM activity ORDER BY created_at DESC,id DESC LIMIT ${full ? REPORT_EXPORT_LIMIT : REPORT_PAGE_SIZE} OFFSET ${full ? 0 : offset})
      SELECT (SELECT count(*)::int FROM activity) AS total,
        coalesce((SELECT jsonb_agg(to_jsonb(summary) ORDER BY service,status) FROM summary),'[]'::jsonb) AS summary,
        coalesce((SELECT jsonb_agg(to_jsonb(page) ORDER BY created_at DESC,id DESC) FROM page),'[]'::jsonb) AS rows`;
    const l = reportLabels[query.locale];
    const r = result!;
    const summaries: ReportTable[] = [
      {
        title: l.summary,
        columns: [l.service, l.status, l.count],
        rows: r.summary.map((s) => [
          reportCode(s.service, query.locale),
          reportCode(s.status, query.locale),
          String(s.count),
        ]),
      },
    ];
    return {
      total: r.total,
      summaries,
      detail: {
        title: l.details,
        columns: [
          l.date,
          l.reference,
          l.service,
          l.organization,
          l.status,
          l.payment,
          l.currency,
          l.quoted,
          l.cash,
          l.promo,
          l.refunded,
        ],
        rows: r.rows.map((row) => [
          this.date(row.created_at, query),
          row.id,
          reportCode(row.service, query.locale),
          row.organization ?? '—',
          reportCode(row.status, query.locale),
          reportCode(row.payment, query.locale),
          row.currency ?? '—',
          ...[row.quoted, row.cash, row.promotional, row.refunded].map((n) =>
            n !== null && row.currency ? reportMoney(n, row.currency) : '—',
          ),
        ]),
      },
    };
  }
}
