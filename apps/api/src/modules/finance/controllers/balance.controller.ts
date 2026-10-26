import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Query,
  Req,
} from '@nestjs/common';
import { ApiCookieAuth, ApiHeader, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import {
  AppError,
  PalCertErrorCode,
  Permission,
  parseMinorUnits,
  type BalanceSummaryView,
  type BalanceTopUpView,
  type CreateTopUpResponseView,
  type CreditHoldView,
  type LedgerEntryView,
  type PaymentRefundView,
  type PriceQuoteView,
  type ServiceProductView,
} from '@palcert/contracts';
import { type AuthenticatedRequest, type RequestPrincipal } from '../../auth/authenticated-request';
import { CurrentUser, RequirePermissions } from '../../auth/decorators/auth.decorators';
import { BalanceService } from '../services/balance.service';
import { PaymentRefundService } from '../services/payment-refund.service';
import { PricingService } from '../services/pricing.service';
import { TopUpService } from '../services/top-up.service';
import {
  BalanceQueryDto,
  CreateTopUpDto,
  QuoteQueryDto,
  TopUpParamDto,
  TransactionsQueryDto,
} from '../dto/finance.dto';

const IDEMPOTENCY_KEY_MAX_LENGTH = 128;

/**
 * A customer's own money (§62, §63, §118, §120).
 *
 * Every route is scoped to the caller. There is no route by which an
 * organization reaches a member's balance, and none by which one customer
 * reaches another's — not because the controllers check, but because the
 * services run under the owner's RLS scope and the database decides (§79, §99).
 *
 * `POST /balance/top-ups` returns a provider checkout URL and credits nothing.
 * That is the whole contract: the browser going to that URL and coming back is
 * not evidence of payment (§40).
 */
@ApiTags('balance')
@ApiCookieAuth()
@Controller()
export class BalanceController {
  constructor(
    private readonly balances: BalanceService,
    private readonly topUps: TopUpService,
    private readonly refunds: PaymentRefundService,
    private readonly pricing: PricingService,
  ) {}

  @Get('balance')
  @RequirePermissions(Permission.BALANCE_READ_SELF)
  @ApiOperation({
    summary: 'Your PalCert Balance',
    description:
      'Available, reserved, cash and promotional amounts for one currency. ' +
      'Reserved credit is money an in-flight service has claimed but not yet spent.',
  })
  @ApiResponse({ status: 200 })
  balance(
    @CurrentUser() principal: RequestPrincipal,
    @Query() query: BalanceQueryDto,
  ): Promise<BalanceSummaryView> {
    return this.balances.summary(principal.userId, query.currency);
  }

  @Get('balance/currencies')
  @RequirePermissions(Permission.BALANCE_READ_SELF)
  @ApiOperation({ summary: 'Currencies you hold a balance in' })
  @ApiResponse({ status: 200 })
  currencies(@CurrentUser() principal: RequestPrincipal): Promise<readonly string[]> {
    return this.balances.currencies(principal.userId);
  }

  @Get('balance/transactions')
  @RequirePermissions(Permission.BALANCE_READ_SELF)
  @ApiOperation({
    summary: 'Your transaction history',
    description:
      'Every movement of your credit, newest first. Internal accounting identifiers ' +
      'are deliberately not included.',
  })
  @ApiResponse({ status: 200 })
  transactions(
    @CurrentUser() principal: RequestPrincipal,
    @Query() query: TransactionsQueryDto,
  ): Promise<{ items: readonly LedgerEntryView[]; nextCursor: string | null }> {
    return this.balances.transactions(principal.userId, {
      ...(query.limit === undefined ? {} : { limit: query.limit }),
      ...(query.cursor === undefined ? {} : { cursor: query.cursor }),
    });
  }

  @Get('balance/holds')
  @RequirePermissions(Permission.BALANCE_READ_SELF)
  @ApiOperation({
    summary: 'Credit currently reserved',
    description: 'Explains why part of a balance is not available to spend.',
  })
  @ApiResponse({ status: 200 })
  holds(@CurrentUser() principal: RequestPrincipal): Promise<readonly CreditHoldView[]> {
    return this.balances.holds(principal.userId);
  }

  @Post('balance/top-ups')
  @RequirePermissions(Permission.BALANCE_TOPUP_SELF)
  @HttpCode(HttpStatus.CREATED)
  @ApiHeader({
    name: 'Idempotency-Key',
    required: false,
    description: 'A retried request returns the same top-up rather than opening a second one.',
  })
  @ApiOperation({
    summary: 'Add credit',
    description:
      'Creates a top-up and a provider-hosted checkout session, and returns its URL. ' +
      'It credits nothing: the balance changes only after PalCert verifies the payment ' +
      'with the provider.',
  })
  @ApiResponse({ status: 201 })
  @ApiResponse({ status: 422, description: 'TOPUP_AMOUNT_OUT_OF_RANGE or CURRENCY_NOT_SUPPORTED' })
  @ApiResponse({ status: 503, description: 'PAYMENTS_DISABLED or PAYMENT_PROVIDER_UNAVAILABLE' })
  createTopUp(
    @CurrentUser() principal: RequestPrincipal,
    @Body() body: CreateTopUpDto,
    @Req() request: AuthenticatedRequest,
  ): Promise<CreateTopUpResponseView> {
    const header = request.headers['idempotency-key'];
    return this.topUps.create({
      ownerUserId: principal.userId,
      currency: body.currency,
      amountMinor: parseMinorUnits(body.amountMinorUnits),
      idempotencyKey: idempotencyKeyOf(typeof header === 'string' ? header : undefined),
      locale: principal.preferredLocale,
    });
  }

  @Get('balance/top-ups')
  @RequirePermissions(Permission.BALANCE_READ_SELF)
  @ApiOperation({ summary: 'Your top-ups, newest first' })
  @ApiResponse({ status: 200 })
  listTopUps(@CurrentUser() principal: RequestPrincipal): Promise<readonly BalanceTopUpView[]> {
    return this.topUps.list(principal.userId);
  }

  @Get('balance/top-ups/:topUpId')
  @RequirePermissions(Permission.BALANCE_READ_SELF)
  @ApiOperation({
    summary: 'One top-up',
    description:
      'What the payment-return page reads. It reports PalCert’s current status and ' +
      'never marks a payment successful itself.',
  })
  @ApiResponse({ status: 200 })
  @ApiResponse({ status: 404, description: 'TOPUP_NOT_FOUND, also for another customer’s top-up' })
  topUp(
    @CurrentUser() principal: RequestPrincipal,
    @Param() params: TopUpParamDto,
  ): Promise<BalanceTopUpView> {
    return this.topUps.get(principal.userId, params.topUpId);
  }

  @Get('balance/refunds')
  @RequirePermissions(Permission.BALANCE_READ_SELF)
  @ApiOperation({
    summary: 'Refunds made to you',
    description:
      'Read-only. External refunds are initiated by PalCert finance, not self-service (§69).',
  })
  @ApiResponse({ status: 200 })
  refundHistory(@CurrentUser() principal: RequestPrincipal): Promise<readonly PaymentRefundView[]> {
    return this.refunds.listForOwner(principal.userId);
  }

  // --- pricing -------------------------------------------------------------

  @Get('pricing/products')
  @ApiOperation({
    summary: 'PalCert’s services',
    description: 'What PalCert sells. Prices are PalCert’s; an organization cannot set one.',
  })
  @ApiResponse({ status: 200 })
  products(): Promise<readonly ServiceProductView[]> {
    return this.pricing.products();
  }

  @Get('pricing/quote')
  @RequirePermissions(Permission.BALANCE_READ_SELF)
  @ApiOperation({
    summary: 'Quote a service',
    description:
      'The server derives the amount from PalCert’s active price list. The client asks ' +
      'for a quote; it never states a price.',
  })
  @ApiResponse({ status: 200 })
  @ApiResponse({ status: 409, description: 'PRICE_NOT_AVAILABLE or SERVICE_PRODUCT_NOT_ACTIVE' })
  quote(
    @CurrentUser() principal: RequestPrincipal,
    @Query() query: QuoteQueryDto,
  ): Promise<PriceQuoteView> {
    return this.pricing.createQuote({
      ownerUserId: principal.userId,
      productCode: query.product as never,
      ...(query.currency === undefined ? {} : { currency: query.currency }),
    });
  }
}

function idempotencyKeyOf(header: string | undefined): string | undefined {
  if (header === undefined) return undefined;
  const trimmed = header.trim();
  if (trimmed.length === 0) return undefined;
  if (trimmed.length > IDEMPOTENCY_KEY_MAX_LENGTH || !/^[\x20-\x7e]+$/.test(trimmed)) {
    throw new AppError(PalCertErrorCode.VALIDATION_FAILED, {
      message: 'Idempotency-Key must be 1 to 128 printable ASCII characters.',
      details: { field: 'Idempotency-Key' },
    });
  }
  return trimmed;
}
