import { Injectable } from '@nestjs/common';
import {
  AppError,
  CreditClass,
  LedgerEntryType,
  LedgerReasonCode,
  LedgerReferenceType,
  PalCertErrorCode,
  PaymentProviderError,
  PaymentProviderPort,
  TopUpFailureCode,
  TopUpStatus,
  formatMinorUnits,
  isKnownCurrency,
  money,
  providerIdempotencyKey,
  type BalanceTopUpView,
  type CreateTopUpResponseView,
  type ProviderPaymentState,
} from '@palcert/contracts';
import { ApiConfigService } from '../../../config/api-config.service';
import { ClockPort } from '../../auth/ports/clock.port';
import { PinoLogger } from 'nestjs-pino';
import { SecurityEventService } from '../../auth/services/security-event.service';
import {
  TenantPrismaService,
  type TenantClient,
} from '../../../infrastructure/tenant/tenant-prisma.service';
import { CreditLedgerService } from './credit-ledger.service';

/**
 * Adding credit (§41–§61).
 *
 * The rule this file exists to enforce: **a browser redirect is not proof of
 * payment** (§40). `POST /balance/top-ups` creates a record and a provider
 * session and returns a URL. Nothing is credited. Credit happens later, in
 * {@link settleFromProviderState}, and only when PalCert has verified with the
 * provider that the money is actually there — through a signed webhook or a
 * direct retrieval during reconciliation.
 *
 * The second rule: credit happens **once**, whichever path gets there first.
 * A webhook and a reconciliation sweep racing on the same top-up is normal,
 * not exceptional, and both converge on one ledger entry.
 */

export interface CreateTopUpInput {
  readonly ownerUserId: string;
  readonly currency: string;
  readonly amountMinor: bigint;
  readonly idempotencyKey?: string | undefined;
  readonly locale?: string | undefined;
}

@Injectable()
export class TopUpService {
  constructor(
    private readonly tenant: TenantPrismaService,
    private readonly provider: PaymentProviderPort,
    private readonly ledger: CreditLedgerService,
    private readonly config: ApiConfigService,
    private readonly clock: ClockPort,
    private readonly events: SecurityEventService,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext(TopUpService.name);
  }

  /**
   * Start a top-up.
   *
   * The amount is validated against server-held bounds and then persisted
   * *before* the provider is called, so the provider is asked for exactly what
   * PalCert recorded. Nothing the browser sends afterwards can change it (§43).
   */
  async create(input: CreateTopUpInput): Promise<CreateTopUpResponseView> {
    this.assertEnabled();
    this.assertCurrency(input.currency);

    const { topUpMinMinor, topUpMaxMinor } = this.config.payments;
    if (input.amountMinor < topUpMinMinor || input.amountMinor > topUpMaxMinor) {
      throw new AppError(PalCertErrorCode.TOPUP_AMOUNT_OUT_OF_RANGE, {
        message: `Top-ups must be between ${formatMinorUnits(topUpMinMinor, input.currency)} and ${formatMinorUnits(topUpMaxMinor, input.currency)} ${input.currency}.`,
        details: {
          currency: input.currency,
          minimumMinorUnits: topUpMinMinor.toString(),
          maximumMinorUnits: topUpMaxMinor.toString(),
        },
      });
    }

    const capabilities = this.provider.getCapabilities();
    const expiresAt = new Date(
      this.clock.now().getTime() + this.config.payments.topUpSessionTtlSeconds * 1_000,
    );

    // Created first and committed, so a provider call that succeeds but whose
    // response is lost still has a PalCert record reconciliation can find.
    const topUp = await this.tenant.withUser(input.ownerUserId, async (tx) => {
      if (input.idempotencyKey !== undefined) {
        const existing = await tx.balanceTopUp.findUnique({
          where: {
            ownerUserId_idempotencyKey: {
              ownerUserId: input.ownerUserId,
              idempotencyKey: input.idempotencyKey,
            },
          },
        });
        if (existing !== null) return existing;
      }
      return tx.balanceTopUp.create({
        data: {
          ownerUserId: input.ownerUserId,
          currency: input.currency,
          amountMinor: input.amountMinor,
          // Written from PalCert's own clock rather than the database default,
          // because reconciliation decides "has this been open too long?" by
          // comparing against that same clock. Two clocks answering one
          // question is how a payment quietly never gets reconciled.
          createdAt: this.clock.now(),
          provider: capabilities.provider,
          providerApiVersion: capabilities.apiVersion,
          status: TopUpStatus.CREATED,
          idempotencyKey: input.idempotencyKey ?? null,
          expiresAt,
        },
      });
    });

    // A retry of an already-started top-up must not open a second checkout the
    // customer could also pay (§44). The provider's own idempotency key is
    // derived from the top-up id, so even a lost response is safe.
    const session = await this.provider
      .createTopUpSession({
        topUpId: topUp.id,
        ownerUserId: input.ownerUserId,
        currency: topUp.currency,
        amountMinor: topUp.amountMinor,
        successUrl: this.config.payments.successUrl,
        cancelUrl: this.config.payments.cancelUrl,
        expiresAt: topUp.expiresAt ?? expiresAt,
        idempotencyKey: providerIdempotencyKey('topup', topUp.id, 'create'),
        locale: input.locale,
      })
      .catch((error: unknown) => {
        throw this.providerFailure(error);
      });

    const bound = await this.tenant.withUser(input.ownerUserId, (tx) =>
      tx.balanceTopUp.update({
        where: { id: topUp.id },
        data: {
          status: TopUpStatus.PENDING,
          providerSessionId: session.providerSessionId,
          expiresAt: session.expiresAt,
        },
      }),
    );

    await this.events.audit({
      action: 'TOPUP_CREATED',
      actorUserId: input.ownerUserId,
      targetType: 'BalanceTopUp',
      targetId: topUp.id,
      // Amount and currency, never the checkout URL or a provider secret (§92).
      afterState: { currency: topUp.currency, amountMinor: topUp.amountMinor.toString() },
    });

    return {
      topUp: toTopUpView(bound),
      checkoutUrl: session.checkoutUrl,
      expiresAt: session.expiresAt.toISOString(),
    };
  }

  async list(ownerUserId: string): Promise<readonly BalanceTopUpView[]> {
    return this.tenant.withUser(ownerUserId, async (tx) => {
      const rows = await tx.balanceTopUp.findMany({
        where: { ownerUserId },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: 100,
      });
      return rows.map(toTopUpView);
    });
  }

  async get(ownerUserId: string, topUpId: string): Promise<BalanceTopUpView> {
    return this.tenant.withUser(ownerUserId, async (tx) => {
      const row = await tx.balanceTopUp.findFirst({ where: { id: topUpId, ownerUserId } });
      if (row === null) {
        throw new AppError(PalCertErrorCode.TOPUP_NOT_FOUND, {
          message: 'That top-up could not be found.',
        });
      }
      return toTopUpView(row);
    });
  }

  /**
   * Credit a top-up from verified provider state — the only path to credit.
   *
   * Called by webhook processing and by reconciliation, which routinely race.
   * Both converge on one ledger entry because:
   *
   *   - the ledger append is keyed `topup:{id}:credit`, so a second attempt
   *     returns the first entry rather than writing another;
   *   - the status update is conditional on the top-up not already having
   *     succeeded;
   *   - and a database trigger refuses to rebind `credit_entry_id` at all.
   *
   * Three independent mechanisms, because double-crediting is the failure that
   * costs real money and is hardest to notice.
   */
  async settleFromProviderState(
    topUpId: string,
    state: ProviderPaymentState,
  ): Promise<{ credited: boolean; status: TopUpStatus }> {
    const topUp = await this.tenant.withPlatformAdmin(
      { actorUserId: SYSTEM_ACTOR, reason: 'settle a payment from verified provider state' },
      (tx) => tx.balanceTopUp.findUnique({ where: { id: topUpId } }),
    );
    if (topUp === null) {
      throw new AppError(PalCertErrorCode.TOPUP_NOT_FOUND, {
        message: 'That top-up could not be found.',
      });
    }

    // Already settled. A later event about the same payment changes nothing,
    // which is what makes out-of-order delivery harmless (§125).
    if (topUp.status === TopUpStatus.SUCCEEDED) {
      return { credited: false, status: TopUpStatus.SUCCEEDED };
    }

    if (!state.paid) {
      return { credited: false, status: await this.settleUnpaid(topUp, state) };
    }

    // Verification before credit (§55). A provider that reports a different
    // amount or currency than PalCert asked for is not a payment for this
    // top-up, and guessing which is right would be guessing with a customer's
    // money.
    if (state.amountMinor !== null && state.amountMinor !== topUp.amountMinor) {
      return {
        credited: false,
        status: await this.flagMismatch(topUp.id, TopUpFailureCode.PAYMENT_AMOUNT_MISMATCH, {
          expectedMinor: topUp.amountMinor.toString(),
          reportedMinor: state.amountMinor.toString(),
        }),
      };
    }
    if (state.currency !== null && state.currency !== topUp.currency) {
      return {
        credited: false,
        status: await this.flagMismatch(topUp.id, TopUpFailureCode.PAYMENT_CURRENCY_MISMATCH, {
          expected: topUp.currency,
          reported: state.currency,
        }),
      };
    }
    // The provider must be talking about *this* top-up.
    if (state.clientReference !== null && state.clientReference !== topUp.id) {
      return {
        credited: false,
        status: await this.flagMismatch(topUp.id, TopUpFailureCode.PAYMENT_OBJECT_MISMATCH, {
          reported: state.clientReference,
        }),
      };
    }

    const outcome = await this.tenant.withUser(topUp.ownerUserId, async (tx) => {
      const account = await this.ledger.accountFor(tx, {
        ownerUserId: topUp.ownerUserId,
        currency: topUp.currency,
        // A top-up is money the customer paid, so it is always CASH. Promotional
        // credit has no payment behind it and is granted, never bought (§9).
        creditClass: CreditClass.CASH,
      });

      const entry = await this.ledger.append(tx, {
        ownerUserId: topUp.ownerUserId,
        accountId: account.id,
        currency: topUp.currency,
        creditClass: CreditClass.CASH,
        entryType: LedgerEntryType.TOP_UP_CREDIT,
        amountMinorSigned: topUp.amountMinor,
        referenceType: LedgerReferenceType.BALANCE_TOP_UP,
        referenceId: topUp.id,
        idempotencyKey: `topup:${topUp.id}:credit`,
        reasonCode: LedgerReasonCode.TOP_UP_VERIFIED,
      });

      const updated = await tx.balanceTopUp.updateMany({
        where: { id: topUp.id, status: { not: TopUpStatus.SUCCEEDED } },
        data: {
          status: TopUpStatus.SUCCEEDED,
          succeededAt: this.clock.now(),
          creditEntryId: entry.id,
          failureCode: null,
          ...(state.providerPaymentId === null || topUp.providerPaymentId !== null
            ? {}
            : { providerPaymentId: state.providerPaymentId }),
        },
      });
      return { credited: updated.count > 0 };
    });

    if (outcome.credited) {
      await this.events.audit({
        action: 'TOPUP_SUCCEEDED',
        actorUserId: null,
        targetType: 'BalanceTopUp',
        targetId: topUp.id,
        afterState: {
          currency: topUp.currency,
          amountMinor: topUp.amountMinor.toString(),
        },
      });
    }
    return { credited: outcome.credited, status: TopUpStatus.SUCCEEDED };
  }

  /**
   * Record a provider outcome that is not a payment.
   *
   * No compensating ledger entry is needed, because no credit was ever written
   * (§59). The top-up simply stops being open.
   */
  private async settleUnpaid(
    topUp: { id: string; status: TopUpStatus },
    state: ProviderPaymentState,
  ): Promise<TopUpStatus> {
    const next = state.cancelled
      ? TopUpStatus.CANCELLED
      : state.expired
        ? TopUpStatus.EXPIRED
        : topUp.status;
    if (next === topUp.status) return topUp.status;

    await this.tenant.withPlatformAdmin(
      { actorUserId: SYSTEM_ACTOR, reason: 'record a provider payment outcome' },
      (tx) =>
        tx.balanceTopUp.updateMany({
          where: { id: topUp.id, status: { notIn: [TopUpStatus.SUCCEEDED] } },
          data: {
            status: next,
            ...(next === TopUpStatus.CANCELLED
              ? {
                  cancelledAt: this.clock.now(),
                  failureCode: TopUpFailureCode.CANCELLED_BY_CUSTOMER,
                }
              : {
                  failedAt: this.clock.now(),
                  failureCode: TopUpFailureCode.PROVIDER_SESSION_EXPIRED,
                }),
          },
        }),
    );
    await this.events.audit({
      action: 'TOPUP_FAILED',
      actorUserId: null,
      targetType: 'BalanceTopUp',
      targetId: topUp.id,
      afterState: { status: next },
    });
    return next;
  }

  /**
   * Stop, and ask a person (§56, §57, §104).
   *
   * PalCert does not "fix" a disagreement with the provider by picking the
   * number it likes. Both ways of guessing are wrong: crediting money nobody
   * paid, or keeping money somebody did. The evidence is preserved and the
   * top-up waits.
   */
  private async flagMismatch(
    topUpId: string,
    failureCode: TopUpFailureCode,
    detail: Record<string, string>,
  ): Promise<TopUpStatus> {
    await this.tenant.withPlatformAdmin(
      { actorUserId: SYSTEM_ACTOR, reason: 'flag a payment for reconciliation' },
      (tx) =>
        tx.balanceTopUp.updateMany({
          where: { id: topUpId, status: { not: TopUpStatus.SUCCEEDED } },
          data: { status: TopUpStatus.RECONCILIATION_REQUIRED, failureCode },
        }),
    );
    // Operators need the numbers to resolve it; no card data or provider
    // payload is involved (§82).
    this.logger.error({ topUpId, failureCode, ...detail }, 'Payment requires reconciliation');
    await this.events.audit({
      action: 'TOPUP_FAILED',
      actorUserId: null,
      targetType: 'BalanceTopUp',
      targetId: topUpId,
      afterState: { failureCode },
    });
    return TopUpStatus.RECONCILIATION_REQUIRED;
  }

  private assertEnabled(): void {
    if (!this.config.payments.enabled) {
      throw new AppError(PalCertErrorCode.PAYMENTS_DISABLED, {
        message: 'Adding credit is not available in this installation.',
      });
    }
  }

  private assertCurrency(currency: string): void {
    const supported = this.config.payments.enabledCurrencies.filter((code) =>
      isKnownCurrency(code),
    );
    if (!supported.includes(currency)) {
      throw new AppError(PalCertErrorCode.CURRENCY_NOT_SUPPORTED, {
        message: 'PalCert does not transact in that currency.',
        details: { currency, supported },
      });
    }
  }

  private providerFailure(error: unknown): AppError {
    if (error instanceof PaymentProviderError) {
      return new AppError(PalCertErrorCode.PAYMENT_PROVIDER_UNAVAILABLE, {
        message: 'Adding credit is temporarily unavailable. Your balance is unchanged.',
        internalContext: { providerFailureKind: error.kind },
      });
    }
    return new AppError(PalCertErrorCode.PAYMENT_PROVIDER_UNAVAILABLE, {
      message: 'Adding credit is temporarily unavailable. Your balance is unchanged.',
    });
  }
}

/**
 * The actor recorded when PalCert itself settles a payment.
 *
 * A fixed nil UUID rather than a real user: a webhook is not a person, and
 * attributing its effects to whoever happened to own the top-up would make the
 * audit trail say something untrue.
 */
export const SYSTEM_ACTOR = '00000000-0000-0000-0000-000000000000';

export function toTopUpView(row: {
  id: string;
  status: TopUpStatus;
  currency: string;
  amountMinor: bigint;
  provider: string;
  failureCode: string | null;
  createdAt: Date;
  expiresAt: Date | null;
  succeededAt: Date | null;
  failedAt: Date | null;
  cancelledAt: Date | null;
}): BalanceTopUpView {
  return {
    id: row.id,
    status: row.status,
    amount: money(row.currency, row.amountMinor),
    provider: row.provider,
    failureCode: row.failureCode as TopUpFailureCode | null,
    createdAt: row.createdAt.toISOString(),
    expiresAt: row.expiresAt?.toISOString() ?? null,
    succeededAt: row.succeededAt?.toISOString() ?? null,
    failedAt: row.failedAt?.toISOString() ?? null,
    cancelledAt: row.cancelledAt?.toISOString() ?? null,
  };
}

export type { TenantClient };
