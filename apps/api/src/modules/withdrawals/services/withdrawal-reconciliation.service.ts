import { Injectable } from '@nestjs/common';
import { WithdrawalScope, type WithdrawalReconciliationView } from '@palcert/contracts';
import { TenantPrismaService } from '../../../infrastructure/tenant/tenant-prisma.service';
import { ClockPort } from '../../auth/ports/clock.port';
import { SecurityEventService } from '../../auth/services/security-event.service';
import { WithdrawalFundsService } from './withdrawal-funds.service';

interface Finding {
  readonly code: string;
  readonly detail: string;
  readonly subjectId: string;
}

/**
 * Invariant verification for every withdrawal (spec §38). It reports and
 * never repairs: a discrepancy in money is something a person must look at,
 * and an automatic fix would hide the defect that caused it.
 *
 *   - every PAID request has exactly one settlement, for its exact amount,
 *     and a user's is the capture of its own CASH hold;
 *   - every open request still holds its reservation;
 *   - every rejected or cancelled request has released it;
 *   - no withdrawal hold reserves promotional credit, and none is orphaned;
 *   - no organization has been paid or reserved more than its settled net
 *     share, and PalCert no more than its realized revenue, per currency.
 */
@Injectable()
export class WithdrawalReconciliationService {
  constructor(
    private readonly tenant: TenantPrismaService,
    private readonly funds: WithdrawalFundsService,
    private readonly events: SecurityEventService,
    private readonly clock: ClockPort,
  ) {}

  async run(actorUserId: string): Promise<WithdrawalReconciliationView> {
    const view = await this.tenant.withPlatformAdmin(
      { actorUserId, reason: 'reconcile withdrawals' },
      async (tx) => {
        const findings: Finding[] = [];

        const paid = await tx.$queryRaw<
          Array<{ id: string; settlements: bigint; amount_ok: boolean; ledger_ok: boolean }>
        >`
          SELECT r."id",
                 count(s."id") AS "settlements",
                 coalesce(bool_and(s."amount_minor" = r."amount_minor" AND s."currency" = r."currency"), false) AS "amount_ok",
                 coalesce(bool_and(
                   r."scope" <> 'USER' OR EXISTS (
                     SELECT 1 FROM "credit_ledger_entries" e
                       JOIN "credit_holds" h ON h."captured_entry_id" = e."id"
                      WHERE e."id" = s."ledger_entry_id"
                        AND e."entry_type" = 'WITHDRAWAL_DEBIT'
                        AND e."credit_class" = 'CASH'
                        AND e."amount_minor_signed" = -r."amount_minor"
                        AND h."id" = r."hold_id")), false) AS "ledger_ok"
            FROM "withdrawal_requests" r
            LEFT JOIN "withdrawal_settlements" s ON s."request_id" = r."id"
           WHERE r."status" = 'PAID'
           GROUP BY r."id"`;
        for (const row of paid) {
          if (row.settlements !== 1n) {
            findings.push({
              code: 'PAID_SETTLEMENT_COUNT',
              detail: `A paid withdrawal has ${row.settlements} settlements; exactly one is required.`,
              subjectId: row.id,
            });
          } else if (!row.amount_ok) {
            findings.push({
              code: 'PAID_SETTLEMENT_AMOUNT',
              detail: 'A settlement does not match its request’s amount or currency.',
              subjectId: row.id,
            });
          } else if (!row.ledger_ok) {
            findings.push({
              code: 'PAID_LEDGER_MISMATCH',
              detail: 'A user payout is not settled by the capture of its own CASH hold.',
              subjectId: row.id,
            });
          }
        }

        const reservations = await tx.$queryRaw<
          Array<{
            id: string;
            status: string;
            hold_status: string | null;
            reservation_status: string | null;
          }>
        >`
          SELECT r."id", r."status"::text AS "status",
                 h."status"::text AS "hold_status",
                 wr."status"::text AS "reservation_status"
            FROM "withdrawal_requests" r
            LEFT JOIN "credit_holds" h ON h."id" = r."hold_id"
            LEFT JOIN "withdrawal_reservations" wr ON wr."id" = r."reservation_id"
           WHERE r."status" IN ('PENDING_REVIEW', 'APPROVED', 'PROCESSING', 'FAILED', 'REJECTED', 'CANCELLED')
             AND r."submitted_at" IS NOT NULL`;
        for (const row of reservations) {
          const held = row.hold_status ?? row.reservation_status;
          const open = ['PENDING_REVIEW', 'APPROVED', 'PROCESSING', 'FAILED'].includes(row.status);
          if (open && held !== 'ACTIVE') {
            findings.push({
              code: 'OPEN_RESERVATION_MISSING',
              detail: `An open withdrawal (${row.status}) does not hold an active reservation.`,
              subjectId: row.id,
            });
          }
          if (!open && held !== 'RELEASED' && held !== 'EXPIRED') {
            findings.push({
              code: 'CLOSED_RESERVATION_NOT_RELEASED',
              detail: `A ${row.status.toLowerCase()} withdrawal still holds its reservation.`,
              subjectId: row.id,
            });
          }
        }

        const holds = await tx.$queryRaw<
          Array<{ id: string; credit_class: string; request_id: string | null }>
        >`
          SELECT h."id", h."credit_class"::text AS "credit_class", r."id" AS "request_id"
            FROM "credit_holds" h
            LEFT JOIN "withdrawal_requests" r ON r."hold_id" = h."id"
           WHERE h."purpose" = 'WITHDRAWAL'
             AND (h."credit_class" <> 'CASH' OR r."id" IS NULL)`;
        for (const row of holds) {
          findings.push(
            row.credit_class !== 'CASH'
              ? {
                  code: 'PROMOTIONAL_WITHDRAWAL_HOLD',
                  detail: 'A withdrawal hold reserves promotional credit.',
                  subjectId: row.id,
                }
              : {
                  code: 'ORPHAN_WITHDRAWAL_HOLD',
                  detail: 'A withdrawal hold is not linked to any request.',
                  subjectId: row.id,
                },
          );
        }

        // An organization never paid or reserved beyond its settled net share.
        const orgs = await tx.$queryRaw<
          Array<{
            organization_id: string;
            currency: string;
            entitled: bigint | null;
            committed: bigint | null;
          }>
        >`
          WITH committed AS (
            SELECT "organization_id", "currency", sum("amount_minor") AS "amount"
              FROM (
                SELECT "organization_id", "currency", "amount_minor" FROM "withdrawal_settlements"
                 WHERE "scope" = 'ORGANIZATION'
                UNION ALL
                SELECT "organization_id", "currency", "amount_minor" FROM "withdrawal_reservations"
                 WHERE "scope" = 'ORGANIZATION' AND "status" = 'ACTIVE'
              ) x
             GROUP BY "organization_id", "currency"
          ), entitled AS (
            SELECT "organization_id", "currency", sum("amount_minor") AS "amount"
              FROM (
                SELECT "organization_id", "currency", "amount_minor" FROM "attestation_revenue_entries" WHERE "account" = 'INSTITUTION'
                UNION ALL
                SELECT "organization_id", "currency", "institution_minor" AS "amount_minor" FROM "service_revenue_entries"
              ) revenue
             GROUP BY "organization_id", "currency"
          )
          SELECT c."organization_id", c."currency"::text AS "currency",
                 coalesce(e."amount", 0)::bigint AS "entitled", c."amount"::bigint AS "committed"
            FROM committed c
            LEFT JOIN entitled e ON e."organization_id" = c."organization_id" AND e."currency" = c."currency"
           WHERE c."amount" > coalesce(e."amount", 0)`;
        for (const row of orgs) {
          findings.push({
            code: 'ORGANIZATION_OVERCOMMITTED',
            detail: `${row.currency}: paid and reserved ${row.committed} exceeds settled net share ${row.entitled}.`,
            subjectId: row.organization_id,
          });
        }

        for (const row of await this.funds.platform(tx)) {
          if (row.paidOutMinor + row.reservedMinor > row.realizedMinor) {
            findings.push({
              code: 'PLATFORM_OVERCOMMITTED',
              detail: `${row.currency}: paid and reserved ${row.paidOutMinor + row.reservedMinor} exceeds realized revenue ${row.realizedMinor}.`,
              subjectId: row.currency,
            });
          }
        }

        const checked = await tx.withdrawalRequest.count({
          where: { scope: { in: Object.values(WithdrawalScope) } },
        });
        return {
          checkedAt: this.clock.now().toISOString(),
          requestsChecked: checked,
          consistent: findings.length === 0,
          findings,
        };
      },
    );
    await this.events.audit({
      action: 'WITHDRAWAL_RECONCILIATION_RUN',
      actorUserId,
      targetType: 'WithdrawalReconciliation',
      targetId: null,
      afterState: {
        requestsChecked: view.requestsChecked,
        findings: view.findings.length,
        codes: [...new Set(view.findings.map((finding) => finding.code))],
      },
    });
    return view;
  }
}
