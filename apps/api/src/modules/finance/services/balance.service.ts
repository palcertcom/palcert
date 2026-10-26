import { Injectable } from '@nestjs/common';
import {
  AppError,
  CreditClass,
  CreditHoldPurpose,
  LedgerEntryType,
  LedgerReasonCode,
  LedgerReferenceType,
  PalCertErrorCode,
  money,
  type BalanceSummaryView,
  type CreditBalanceView,
  type CreditHoldView,
  type LedgerEntryView,
  type ServiceProductCode,
} from '@palcert/contracts';
import { ApiConfigService } from '../../../config/api-config.service';
import { TenantPrismaService } from '../../../infrastructure/tenant/tenant-prisma.service';
import { CreditLedgerService } from './credit-ledger.service';

/**
 * What a customer sees of their own money (§62, §63, §64).
 *
 * Everything here runs under the owner's own RLS scope, so "can this person
 * see this balance?" is answered by the database rather than by a `where`
 * clause somebody has to remember to write.
 *
 * Internal accounting identifiers never leave: a transaction line carries its
 * own id, its currency and its credit class, which is everything a person
 * needs and nothing about how PalCert files it (§64).
 */
@Injectable()
export class BalanceService {
  constructor(
    private readonly tenant: TenantPrismaService,
    private readonly ledger: CreditLedgerService,
    private readonly config: ApiConfigService,
  ) {}

  /**
   * The balance page's answer for one currency.
   *
   * Cash and promotional are reported separately because they are not
   * interchangeable: one may be refundable and the other never is, and a
   * single blended number would hide that from the person it matters to (§9).
   */
  async summary(ownerUserId: string, currency?: string): Promise<BalanceSummaryView> {
    const target = currency ?? this.config.payments.defaultCurrency;

    return this.tenant.withUser(ownerUserId, async (tx) => {
      const positions = (await this.ledger.positions(tx, ownerUserId)).filter(
        (position) => position.currency === target,
      );

      const accounts: CreditBalanceView[] = positions.map((position) => ({
        currency: position.currency,
        creditClass: position.creditClass,
        ledgerBalance: money(position.currency, position.ledgerBalanceMinor),
        reserved: money(position.currency, position.reservedMinor),
        available: money(position.currency, position.availableMinor),
      }));

      const sum = (
        predicate: (position: (typeof positions)[number]) => boolean,
        field: 'ledgerBalanceMinor' | 'reservedMinor' | 'availableMinor',
      ): bigint =>
        positions.filter(predicate).reduce((total, position) => total + position[field], 0n);

      return {
        currency: target,
        available: money(
          target,
          sum(() => true, 'availableMinor'),
        ),
        reserved: money(
          target,
          sum(() => true, 'reservedMinor'),
        ),
        cash: money(
          target,
          sum((position) => position.creditClass === CreditClass.CASH, 'ledgerBalanceMinor'),
        ),
        promotional: money(
          target,
          sum((position) => position.creditClass === CreditClass.PROMOTIONAL, 'ledgerBalanceMinor'),
        ),
        accounts,
      };
    });
  }

  /** Every currency the customer holds anything in, so the page can offer a switch. */
  async currencies(ownerUserId: string): Promise<readonly string[]> {
    return this.tenant.withUser(ownerUserId, async (tx) => {
      const accounts = await tx.customerCreditAccount.findMany({
        where: { ownerUserId },
        select: { currency: true },
        distinct: ['currency'],
        orderBy: { currency: 'asc' },
      });
      const held = accounts.map((account) => account.currency);
      return held.length > 0 ? held : [this.config.payments.defaultCurrency];
    });
  }

  /**
   * Transaction history, newest first (§63).
   *
   * Cursor-paginated on `(createdAt, id)` like every other collection in the
   * product (ADR-0020), so a new entry arriving mid-scroll cannot make a page
   * skip one.
   */
  async transactions(
    ownerUserId: string,
    options: { readonly limit?: number; readonly cursor?: string } = {},
  ): Promise<{ items: readonly LedgerEntryView[]; nextCursor: string | null }> {
    const limit = Math.min(Math.max(options.limit ?? 25, 1), 100);

    return this.tenant.withUser(ownerUserId, async (tx) => {
      const rows = await tx.creditLedgerEntry.findMany({
        where: { ownerUserId },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: limit + 1,
        ...(options.cursor === undefined ? {} : { cursor: { id: options.cursor }, skip: 1 }),
      });

      const page = rows.slice(0, limit);
      // A capture points at its hold, and the hold at its purchase. Two reads
      // for the whole page, so history can name the service that was paid for.
      const holdIds = page
        .filter((row) => row.referenceType === LedgerReferenceType.CREDIT_HOLD && row.referenceId)
        .map((row) => row.referenceId as string);
      const products = new Map<string, ServiceProductCode>();
      if (holdIds.length > 0) {
        const holds = await tx.creditHold.findMany({
          where: { id: { in: holdIds }, referenceType: LedgerReferenceType.SERVICE_PURCHASE },
          select: { id: true, referenceId: true },
        });
        const purchaseIds = holds
          .map((hold) => hold.referenceId)
          .filter((id): id is string => !!id);
        const purchases =
          purchaseIds.length === 0
            ? []
            : await tx.servicePurchase.findMany({
                where: { id: { in: purchaseIds } },
                select: { id: true, productCode: true },
              });
        const byPurchase = new Map(
          purchases.map((p) => [p.id, p.productCode as ServiceProductCode]),
        );
        for (const hold of holds) {
          const code = hold.referenceId === null ? undefined : byPurchase.get(hold.referenceId);
          if (code !== undefined) products.set(hold.id, code);
        }
      }
      return {
        items: page.map((row) => ({
          ...toEntryView(row),
          serviceProductCode:
            row.referenceType === LedgerReferenceType.CREDIT_HOLD && row.referenceId
              ? (products.get(row.referenceId) ?? null)
              : null,
        })),
        nextCursor: rows.length > limit ? (page[page.length - 1]?.id ?? null) : null,
      };
    });
  }

  /** A customer's own reservations, so "why is $3 unavailable?" is answerable. */
  async holds(ownerUserId: string): Promise<readonly CreditHoldView[]> {
    return this.tenant.withUser(ownerUserId, async (tx) => {
      const rows = await tx.creditHold.findMany({
        where: { ownerUserId },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: 100,
      });
      return rows.map((row) => ({
        id: row.id,
        status: row.status,
        purpose: row.purpose as CreditHoldPurpose,
        amount: money(row.currency, row.amountMinor),
        creditClass: row.creditClass,
        expiresAt: row.expiresAt?.toISOString() ?? null,
        createdAt: row.createdAt.toISOString(),
        capturedAt: row.capturedAt?.toISOString() ?? null,
        releasedAt: row.releasedAt?.toISOString() ?? null,
        expiredAt: row.expiredAt?.toISOString() ?? null,
      }));
    });
  }

  /**
   * Return a service fee to the balance (§66, §67).
   *
   * This is the method Phase 11 calls when a check fails for a reason that is
   * PalCert's fault after the fee was already captured. It writes a
   * compensating entry pointing at the original charge — it does not edit the
   * charge, which the database would refuse anyway (§13).
   *
   * Full refunds only in this phase: a partial service refund needs an
   * explicit amount and a story about what fraction of a service was
   * delivered, and Phase 11 does not need one (§67).
   */
  async refundServiceCharge(params: {
    readonly ownerUserId: string;
    readonly ledgerEntryId: string;
    readonly reasonCode?: LedgerReasonCode;
  }): Promise<LedgerEntryView> {
    return this.tenant.withUser(params.ownerUserId, async (tx) => {
      const original = await tx.creditLedgerEntry.findFirst({
        where: { id: params.ledgerEntryId, ownerUserId: params.ownerUserId },
      });
      if (original === null) {
        throw new AppError(PalCertErrorCode.LEDGER_ENTRY_NOT_FOUND, {
          message: 'That charge could not be found.',
        });
      }
      if (original.entryType !== LedgerEntryType.SERVICE_CHARGE) {
        throw new AppError(PalCertErrorCode.LEDGER_ENTRY_NOT_REFUNDABLE, {
          message: 'That transaction is not a service charge, so there is no fee to return.',
        });
      }

      // Over-refund protection: one refund per charge, enforced by looking for
      // an existing reversal before writing one. The idempotency key below is
      // the guarantee; this is the readable error (§67).
      const existing = await tx.creditLedgerEntry.findFirst({
        where: { reversalOfEntryId: original.id, ownerUserId: params.ownerUserId },
      });
      if (existing !== null) return toEntryView(existing);

      const entry = await tx.creditLedgerEntry.create({
        data: {
          ownerUserId: original.ownerUserId,
          accountId: original.accountId,
          currency: original.currency,
          creditClass: original.creditClass,
          entryType: LedgerEntryType.SERVICE_REFUND,
          // The exact amount that was taken, with the sign flipped.
          amountMinorSigned: -original.amountMinorSigned,
          referenceType: LedgerReferenceType.LEDGER_ENTRY,
          referenceId: original.id,
          reversalOfEntryId: original.id,
          reasonCode: params.reasonCode ?? LedgerReasonCode.SERVICE_FAILED,
          // Two concurrent refunds of the same charge write one entry (§127).
          idempotencyKey: `service-refund:${original.id}`,
        },
      });
      return toEntryView(entry);
    });
  }
}

function toEntryView(row: {
  id: string;
  entryType: string;
  creditClass: CreditClass;
  currency: string;
  amountMinorSigned: bigint;
  reasonCode: string | null;
  reversalOfEntryId: string | null;
  createdAt: Date;
}): LedgerEntryView {
  return {
    publicId: row.id,
    entryType: row.entryType as LedgerEntryType,
    creditClass: row.creditClass,
    amount: money(row.currency, row.amountMinorSigned),
    reasonCode: row.reasonCode as LedgerReasonCode | null,
    reversalOfEntryId: row.reversalOfEntryId,
    createdAt: row.createdAt.toISOString(),
  };
}
