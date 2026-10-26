import { Injectable } from '@nestjs/common';
import {
  ACTIVE_SERVICE_PRODUCT_CODES,
  isAIServiceProduct,
  AppError,
  DEFAULT_MARKET_CODE,
  PalCertErrorCode,
  PriceVersionStatus,
  ServiceProductCode,
  isKnownCurrency,
  money,
  type PriceQuoteView,
  type PriceVersionView,
  type ServiceProductView,
} from '@palcert/contracts';
import { ApiConfigService } from '../../../config/api-config.service';
import { ClockPort } from '../../auth/ports/clock.port';
import { PrismaService } from '../../../infrastructure/prisma/prisma.service';
import { SecurityEventService } from '../../auth/services/security-event.service';
import {
  TenantPrismaService,
  type TenantClient,
} from '../../../infrastructure/tenant/tenant-prisma.service';

/**
 * Pricing (§24–§33).
 *
 * Two rules shape every method here. Prices belong to PalCert globally, so
 * nothing takes an organization id — there is no code path by which an
 * institution could discount a check for its own members (§107). And the
 * client never states a price: it asks for one, and the server derives it from
 * the active price list (§31).
 */
@Injectable()
export class PricingService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tenant: TenantPrismaService,
    private readonly config: ApiConfigService,
    private readonly clock: ClockPort,
    private readonly events: SecurityEventService,
  ) {}

  async products(): Promise<readonly ServiceProductView[]> {
    const rows = await this.prisma.serviceProduct.findMany({ orderBy: { productCode: 'asc' } });
    return rows.map((row) => ({
      productCode: row.productCode as ServiceProductCode,
      active: row.active,
      nameEn: row.nameEn,
      nameAr: row.nameAr,
      descriptionEn: row.descriptionEn,
      descriptionAr: row.descriptionAr,
    }));
  }

  async prices(
    filter: {
      readonly productCode?: ServiceProductCode;
      readonly currency?: string;
    } = {},
  ): Promise<readonly PriceVersionView[]> {
    const rows = await this.prisma.priceVersion.findMany({
      where: {
        ...(filter.productCode === undefined ? {} : { productCode: filter.productCode }),
        ...(filter.currency === undefined ? {} : { currency: filter.currency }),
      },
      orderBy: [{ productCode: 'asc' }, { currency: 'asc' }, { createdAt: 'desc' }],
    });
    return rows.map(toPriceView);
  }

  /** Draft a price. Drafting is not charging; activation is a separate act (§27). */
  async createPrice(input: {
    readonly productCode: ServiceProductCode;
    readonly currency: string;
    readonly amountMinor: bigint;
    readonly marketCode?: string;
    readonly createdByUserId: string;
  }): Promise<PriceVersionView> {
    this.assertCurrency(input.currency);
    const product = await this.prisma.serviceProduct.findUnique({
      where: { productCode: input.productCode },
    });
    if (product === null) {
      throw new AppError(PalCertErrorCode.SERVICE_PRODUCT_NOT_FOUND, {
        message: 'That service does not exist.',
      });
    }
    if (input.amountMinor <= 0n) {
      throw new AppError(PalCertErrorCode.VALIDATION_FAILED, {
        message: 'A price must be greater than zero.',
      });
    }

    // Pricing is a platform-administrative act, so the write is elevated and
    // the elevation is logged with a reason (§95, §151).
    const created = await this.tenant.withPlatformAdmin(
      { actorUserId: input.createdByUserId, reason: 'draft a PalCert service price' },
      (tx) =>
        tx.priceVersion.create({
          data: {
            productCode: input.productCode,
            currency: input.currency,
            amountMinor: input.amountMinor,
            marketCode: input.marketCode ?? DEFAULT_MARKET_CODE,
            status: PriceVersionStatus.DRAFT,
            createdByUserId: input.createdByUserId,
          },
        }),
    );
    await this.events.audit({
      action: 'PRICE_CREATED',
      actorUserId: input.createdByUserId,
      targetType: 'PriceVersion',
      targetId: created.id,
      afterState: {
        productCode: input.productCode,
        currency: input.currency,
        amountMinor: input.amountMinor.toString(),
      },
    });
    return toPriceView(created);
  }

  /**
   * Put a price into force.
   *
   * Retiring the outgoing price and activating the incoming one happen in one
   * transaction, so there is never a moment with two active prices or none.
   * The partial unique index is what actually guarantees it: two concurrent
   * activations both pass the read, and the loser's INSERT fails rather than
   * leaving PalCert unable to say what a check costs (§29).
   */
  async activatePrice(priceVersionId: string, actorUserId: string): Promise<PriceVersionView> {
    const now = this.clock.now();
    let activated: PriceVersionView;
    try {
      activated = await this.tenant.withPlatformAdmin(
        { actorUserId, reason: 'put a PalCert service price into force' },
        async (tx) => {
          const price = await tx.priceVersion.findUnique({ where: { id: priceVersionId } });
          if (price === null) {
            throw new AppError(PalCertErrorCode.PRICE_NOT_FOUND, {
              message: 'That price could not be found.',
            });
          }
          if (price.status === PriceVersionStatus.ACTIVE) return toPriceView(price);
          if (price.status !== PriceVersionStatus.DRAFT) {
            throw new AppError(PalCertErrorCode.PRICE_IMMUTABLE, {
              message: 'A retired price cannot be reactivated. Create a new one.',
            });
          }

          await tx.priceVersion.updateMany({
            where: {
              productCode: price.productCode,
              currency: price.currency,
              marketCode: price.marketCode,
              status: PriceVersionStatus.ACTIVE,
            },
            data: {
              status: PriceVersionStatus.RETIRED,
              retiredAt: now,
              effectiveUntil: now,
            },
          });

          const row = await tx.priceVersion.update({
            where: { id: price.id },
            data: {
              status: PriceVersionStatus.ACTIVE,
              activatedAt: now,
              effectiveFrom: now,
            },
          });
          return toPriceView(row);
        },
      );
    } catch (error) {
      if (error instanceof AppError) throw error;
      // The partial unique index fired: someone else activated a price for
      // this product and currency while we were working.
      throw new AppError(PalCertErrorCode.PRICE_ALREADY_ACTIVE, {
        message: 'Another price for that service and currency was activated at the same time.',
        internalContext: { priceVersionId },
      });
    }

    await this.events.audit({
      action: 'PRICE_ACTIVATED',
      actorUserId,
      targetType: 'PriceVersion',
      targetId: priceVersionId,
      afterState: {
        productCode: activated.productCode,
        currency: activated.amount.currency,
        amountMinor: activated.amount.minorUnits,
      },
    });
    return activated;
  }

  /** Take a price out of force without replacing it. */
  async retirePrice(priceVersionId: string, actorUserId: string): Promise<PriceVersionView> {
    const now = this.clock.now();
    const price = await this.prisma.priceVersion.findUnique({ where: { id: priceVersionId } });
    if (price === null) {
      throw new AppError(PalCertErrorCode.PRICE_NOT_FOUND, {
        message: 'That price could not be found.',
      });
    }
    if (price.status === PriceVersionStatus.RETIRED) return toPriceView(price);
    if (price.status === PriceVersionStatus.DRAFT) {
      throw new AppError(PalCertErrorCode.PRICE_IMMUTABLE, {
        message: 'A draft price is not in force and cannot be retired.',
      });
    }
    const retired = await this.tenant.withPlatformAdmin(
      { actorUserId, reason: 'take a PalCert service price out of force' },
      (tx) =>
        tx.priceVersion.update({
          where: { id: price.id },
          data: { status: PriceVersionStatus.RETIRED, retiredAt: now, effectiveUntil: now },
        }),
    );
    await this.events.audit({
      action: 'PRICE_RETIRED',
      actorUserId,
      targetType: 'PriceVersion',
      targetId: priceVersionId,
    });
    return toPriceView(retired);
  }

  /**
   * Quote a price to one customer (§30).
   *
   * The amount is copied onto the quote, not referenced. That is what lets
   * PalCert honour the quote after a price change: the captured number is the
   * customer's, and the new price applies to the next person who asks (§32).
   */
  async createQuote(input: {
    readonly ownerUserId: string;
    readonly productCode: ServiceProductCode;
    readonly currency?: string;
  }): Promise<PriceQuoteView> {
    const currency = input.currency ?? this.config.payments.defaultCurrency;
    this.assertCurrency(currency);

    if (!ACTIVE_SERVICE_PRODUCT_CODES.includes(input.productCode)) {
      throw new AppError(PalCertErrorCode.SERVICE_PRODUCT_NOT_ACTIVE, {
        message: 'That service is not available yet.',
      });
    }

    const price = await this.prisma.priceVersion.findFirst({
      where: {
        productCode: input.productCode,
        currency,
        marketCode: DEFAULT_MARKET_CODE,
        status: PriceVersionStatus.ACTIVE,
      },
    });
    if (price === null) {
      // ADR-0149: no active price means no AI. There is no free fallback.
      throw new AppError(PalCertErrorCode.PRICE_NOT_AVAILABLE, {
        message: isAIServiceProduct(input.productCode)
          ? 'This AI service is not currently available in your balance currency.'
          : 'That service has no price in this currency yet.',
        details: { productCode: input.productCode, currency },
      });
    }

    const now = this.clock.now();
    // A quote belongs to the person it was quoted to, so it is written under
    // their own scope and the database enforces the ownership.
    const quote = await this.tenant.withUser(input.ownerUserId, (tx) =>
      tx.priceQuote.create({
        data: {
          ownerUserId: input.ownerUserId,
          productCode: input.productCode,
          priceVersionId: price.id,
          currency: price.currency,
          amountMinor: price.amountMinor,
          // Both timestamps come from the one clock that decides whether a
          // quote has expired. Taking `createdAt` from the database default
          // instead would let clock drift produce a quote that was born
          // expired — which a CHECK constraint rightly refuses.
          createdAt: now,
          expiresAt: new Date(now.getTime() + this.config.payments.quoteTtlSeconds * 1_000),
        },
      }),
    );
    return this.toQuoteView(quote);
  }

  /**
   * Read a quote back.
   *
   * An expired quote is returned rather than hidden, flagged as expired: a
   * customer who waited too long should be told that, not told the quote never
   * existed. Phase 11 will refuse to charge against one.
   */
  async quote(tx: TenantClient, ownerUserId: string, quoteId: string): Promise<PriceQuoteView> {
    const quote = await tx.priceQuote.findFirst({ where: { id: quoteId, ownerUserId } });
    if (quote === null) {
      throw new AppError(PalCertErrorCode.QUOTE_NOT_FOUND, {
        message: 'That quote could not be found.',
      });
    }
    return this.toQuoteView(quote);
  }

  /** Currencies this deployment transacts in: the registry, narrowed by config. */
  enabledCurrencies(): readonly string[] {
    return this.config.payments.enabledCurrencies.filter((code) => isKnownCurrency(code));
  }

  private assertCurrency(currency: string): void {
    if (!this.enabledCurrencies().includes(currency)) {
      throw new AppError(PalCertErrorCode.CURRENCY_NOT_SUPPORTED, {
        message: 'PalCert does not transact in that currency.',
        details: { currency, supported: [...this.enabledCurrencies()] },
      });
    }
  }

  private toQuoteView(quote: {
    id: string;
    productCode: string;
    currency: string;
    amountMinor: bigint;
    createdAt: Date;
    expiresAt: Date;
  }): PriceQuoteView {
    return {
      id: quote.id,
      productCode: quote.productCode as ServiceProductCode,
      amount: money(quote.currency, quote.amountMinor),
      createdAt: quote.createdAt.toISOString(),
      expiresAt: quote.expiresAt.toISOString(),
      expired: quote.expiresAt.getTime() <= this.clock.now().getTime(),
    };
  }
}

function toPriceView(row: {
  id: string;
  productCode: string;
  marketCode: string;
  currency: string;
  amountMinor: bigint;
  status: string;
  effectiveFrom: Date | null;
  effectiveUntil: Date | null;
  createdAt: Date;
  activatedAt: Date | null;
}): PriceVersionView {
  return {
    id: row.id,
    productCode: row.productCode as ServiceProductCode,
    marketCode: row.marketCode,
    amount: money(row.currency, row.amountMinor),
    status: row.status as PriceVersionStatus,
    effectiveFrom: row.effectiveFrom?.toISOString() ?? null,
    effectiveUntil: row.effectiveUntil?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
    activatedAt: row.activatedAt?.toISOString() ?? null,
  };
}
