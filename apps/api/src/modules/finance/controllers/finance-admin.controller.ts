import { Body, Controller, Get, HttpCode, HttpStatus, Param, Post, Query } from '@nestjs/common';
import { ApiCookieAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import {
  CreditClass,
  LedgerReasonCode,
  PaymentRefundReason,
  Permission,
  ServiceProductCode,
  parseMinorUnits,
  type AdminBalanceView,
  type AdminServicePurchaseView,
  type BalanceTopUpView,
  type LedgerEntryView,
  type LedgerVerificationView,
  type PaymentRefundView,
  type PriceVersionView,
  type AdminPurchaseReportRowView,
  type ServicePurchaseStatus,
  type ServicePurchaseSummaryView,
} from '@palcert/contracts';
import { CurrentUser, RequirePermissions } from '../../auth/decorators/auth.decorators';
import type { RequestPrincipal } from '../../auth/authenticated-request';
import { FinanceAdminService, type PurchaseReportFilter } from '../services/finance-admin.service';
import { PaymentRefundService } from '../services/payment-refund.service';
import { PricingService } from '../services/pricing.service';
import {
  BalanceQueryDto,
  CreateAdjustmentDto,
  CreatePriceDto,
  CreateRefundDto,
  OwnerParamDto,
  PriceParamDto,
  PurchaseReportQueryDto,
  RefundParamDto,
} from '../dto/finance.dto';

/**
 * Finance and pricing operations (§95, §96, §121).
 *
 * The full admin portal is Phase 19; this is the protected API the financial
 * operations of Phase 10 genuinely need and no more.
 *
 * Permissions are split deliberately. Reading a payment, reading the ledger,
 * changing a price, refunding money and adjusting a balance are five different
 * authorities, so support can answer "where is my top-up?" without being able
 * to move a single unit of anyone's money (§78, §135).
 */
@ApiTags('finance')
@ApiCookieAuth()
@Controller('admin/finance')
export class FinanceAdminController {
  constructor(
    private readonly finance: FinanceAdminService,
    private readonly refunds: PaymentRefundService,
    private readonly pricing: PricingService,
  ) {}

  // --- pricing -------------------------------------------------------------

  @Get('prices')
  @RequirePermissions(Permission.PRICING_PRICE_READ)
  @ApiOperation({ summary: 'Every price version, current and historical' })
  @ApiResponse({ status: 200 })
  prices(): Promise<readonly PriceVersionView[]> {
    return this.pricing.prices();
  }

  @Post('prices')
  @RequirePermissions(Permission.PRICING_PRICE_CREATE)
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({
    summary: 'Draft a price',
    description: 'A draft charges nobody. Putting it into force is a separate permission.',
  })
  @ApiResponse({ status: 201 })
  createPrice(
    @Body() body: CreatePriceDto,
    @CurrentUser() principal: RequestPrincipal,
  ): Promise<PriceVersionView> {
    return this.pricing.createPrice({
      productCode: body.productCode as ServiceProductCode,
      currency: body.currency,
      amountMinor: parseMinorUnits(body.amountMinorUnits),
      ...(body.marketCode === undefined ? {} : { marketCode: body.marketCode }),
      createdByUserId: principal.userId,
    });
  }

  @Post('prices/:priceVersionId/activate')
  @RequirePermissions(Permission.PRICING_PRICE_ACTIVATE)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Put a price into force',
    description:
      'Retires the outgoing price and activates this one in one transaction, so there is ' +
      'never a moment with two active prices or none. Its amount is immutable from now on.',
  })
  @ApiResponse({ status: 200 })
  @ApiResponse({ status: 409, description: 'PRICE_ALREADY_ACTIVE or PRICE_IMMUTABLE' })
  activatePrice(
    @Param() params: PriceParamDto,
    @CurrentUser() principal: RequestPrincipal,
  ): Promise<PriceVersionView> {
    return this.pricing.activatePrice(params.priceVersionId, principal.userId);
  }

  @Post('prices/:priceVersionId/retire')
  @RequirePermissions(Permission.PRICING_PRICE_ACTIVATE)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Take a price out of force',
    description: 'Lifecycle metadata only: the amount charged historically does not change.',
  })
  @ApiResponse({ status: 200 })
  retirePrice(
    @Param() params: PriceParamDto,
    @CurrentUser() principal: RequestPrincipal,
  ): Promise<PriceVersionView> {
    return this.pricing.retirePrice(params.priceVersionId, principal.userId);
  }

  // --- customer finance ----------------------------------------------------

  @Get('customers/:ownerUserId/balance')
  @RequirePermissions(Permission.FINANCE_LEDGER_READ)
  @ApiOperation({ summary: 'A customer’s balance' })
  @ApiResponse({ status: 200 })
  balance(
    @Param() params: OwnerParamDto,
    @Query() query: BalanceQueryDto,
    @CurrentUser() principal: RequestPrincipal,
  ): Promise<AdminBalanceView> {
    return this.finance.balanceOf(params.ownerUserId, principal.userId, query.currency);
  }

  @Get('customers/:ownerUserId/payments')
  @RequirePermissions(Permission.FINANCE_PAYMENT_READ)
  @ApiOperation({
    summary: 'A customer’s payments',
    description:
      'What support needs to answer “where is my top-up?”. Deliberately separate from ' +
      'the ledger permission.',
  })
  @ApiResponse({ status: 200 })
  payments(
    @Param() params: OwnerParamDto,
    @CurrentUser() principal: RequestPrincipal,
  ): Promise<readonly BalanceTopUpView[]> {
    return this.finance.paymentsOf(params.ownerUserId, principal.userId);
  }

  @Get('customers/:ownerUserId/purchases')
  @RequirePermissions(Permission.FINANCE_PURCHASE_READ)
  @ApiOperation({
    summary: 'What a customer bought',
    description:
      'Service purchases with their allocation breakdown, newest first. Read-only: reading ' +
      'whether a check was charged confers none of the authority to change it. Carries no ' +
      'account, hold or ledger identifier.',
  })
  @ApiResponse({ status: 200 })
  purchases(
    @Param() params: OwnerParamDto,
    @CurrentUser() principal: RequestPrincipal,
  ): Promise<readonly AdminServicePurchaseView[]> {
    return this.finance.purchasesOf(params.ownerUserId, principal.userId);
  }

  @Get('purchases/summary')
  @RequirePermissions(Permission.FINANCE_PURCHASE_READ)
  @ApiOperation({
    summary: 'Purchases and captured revenue by product',
    description:
      'Counts and amounts per product and currency (DOCUMENT_CHECK, SMARTFIX, AI_REVIEW, ' +
      'AI_RULE_EXTRACTION, …): reserved, captured, released, refunded. Currencies are never ' +
      'added together. Read-only, computed from the purchases themselves.',
  })
  @ApiResponse({ status: 200 })
  purchaseSummary(
    @Query() query: PurchaseReportQueryDto,
    @CurrentUser() principal: RequestPrincipal,
  ): Promise<ServicePurchaseSummaryView> {
    return this.finance.purchaseSummary(reportFilter(query), principal.userId);
  }

  @Get('purchases')
  @RequirePermissions(Permission.FINANCE_PURCHASE_READ)
  @ApiOperation({
    summary: 'Purchase report',
    description:
      'Individual purchases for the same filter, newest first (at most 200): product, payer, ' +
      'amount, currency, status and dates — and, for an organization-scoped AI run, the ' +
      'organization it was for (context only; the initiating user paid).',
  })
  @ApiResponse({ status: 200 })
  purchaseReport(
    @Query() query: PurchaseReportQueryDto,
    @CurrentUser() principal: RequestPrincipal,
  ): Promise<readonly AdminPurchaseReportRowView[]> {
    return this.finance.purchaseReport(reportFilter(query), principal.userId);
  }

  @Post('adjustments')
  @RequirePermissions(Permission.FINANCE_ADJUSTMENT_CREATE)
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({
    summary: 'Credit or debit a balance',
    description:
      'Appends a reasoned, audited ledger entry. It cannot edit or delete an existing ' +
      'one — corrections are compensating entries, and the database refuses anything else.',
  })
  @ApiResponse({ status: 201 })
  adjust(
    @Body() body: CreateAdjustmentDto,
    @CurrentUser() principal: RequestPrincipal,
  ): Promise<LedgerEntryView> {
    return this.finance.adjust({
      ownerUserId: body.ownerUserId,
      currency: body.currency,
      creditClass: body.creditClass as CreditClass,
      amountMinorSigned: parseMinorUnits(body.amountMinorUnits),
      reasonCode: body.reasonCode as LedgerReasonCode,
      actorUserId: principal.userId,
      idempotencyKey: body.idempotencyKey,
      ...(body.note === undefined ? {} : { note: body.note }),
    });
  }

  @Post('refunds')
  @RequirePermissions(Permission.FINANCE_REFUND_CREATE)
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({
    summary: 'Refund a payment through the provider',
    description:
      'Reserves the customer’s cash credit first, so it cannot be spent while the refund ' +
      'settles. Never more than the original payment, and never promotional credit.',
  })
  @ApiResponse({ status: 201 })
  @ApiResponse({ status: 409, description: 'REFUND_EXCEEDS_REMAINING or REFUND_NOT_ELIGIBLE' })
  @ApiResponse({ status: 409, description: 'INSUFFICIENT_BALANCE if the credit is already spent' })
  createRefund(
    @Body() body: CreateRefundDto,
    @CurrentUser() principal: RequestPrincipal,
  ): Promise<PaymentRefundView> {
    return this.refunds.createRefund({
      topUpId: body.topUpId,
      amountMinor: parseMinorUnits(body.amountMinorUnits),
      reason: body.reason as PaymentRefundReason,
      requestedByUserId: principal.userId,
      idempotencyKey: `${body.topUpId}:${body.amountMinorUnits}:${body.reason}`,
    });
  }

  @Get('refunds/:refundId')
  @RequirePermissions(Permission.FINANCE_PAYMENT_READ)
  @ApiOperation({ summary: 'One refund' })
  @ApiResponse({ status: 200 })
  refund(
    @Param() params: RefundParamDto,
    @CurrentUser() principal: RequestPrincipal,
  ): Promise<PaymentRefundView> {
    return this.refunds.get(params.refundId, principal.userId);
  }

  @Get('verify-ledger')
  @RequirePermissions(Permission.FINANCE_LEDGER_READ)
  @ApiOperation({
    summary: 'Check the financial invariants',
    description:
      'Read-only. Replays every account from its entries and checks that each settled ' +
      'payment, capture and refund produced exactly one ledger row. It never repairs ' +
      'anything: a discrepancy is for a person to understand, not for code to guess at.',
  })
  @ApiResponse({ status: 200 })
  verifyLedger(@CurrentUser() principal: RequestPrincipal): Promise<LedgerVerificationView> {
    return this.finance.verifyLedger(principal.userId);
  }
}

function reportFilter(query: PurchaseReportQueryDto): PurchaseReportFilter {
  return {
    ...(query.productCode === undefined
      ? {}
      : { productCode: query.productCode as ServiceProductCode }),
    ...(query.currency === undefined ? {} : { currency: query.currency }),
    ...(query.from === undefined ? {} : { from: query.from }),
    ...(query.to === undefined ? {} : { to: query.to }),
    ...(query.status === undefined ? {} : { status: query.status as ServicePurchaseStatus }),
    ...(query.limit === undefined ? {} : { limit: query.limit }),
  };
}
