import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Length,
  Matches,
  Max,
  Min,
} from 'class-validator';
import {
  CREDIT_CLASSES,
  CURRENCY_CODES,
  ADJUSTMENT_REASON_CODES,
  PAYMENT_REFUND_REASONS,
  SERVICE_PRODUCT_CODES,
  SERVICE_PURCHASE_STATUSES,
} from '@palcert/contracts';

/**
 * Request shapes for Phase 10.
 *
 * One thing is conspicuously absent from all of them: a price. A client may
 * ask for a quote and may choose how much credit to add, within
 * server-controlled bounds — it can never state what something costs (§31).
 *
 * Amounts arrive as **strings** of minor units, not JSON numbers, so a large
 * amount cannot lose precision on the way in (§4).
 */

const MINOR_UNITS = /^(0|[1-9]\d{0,18})$/;
const SIGNED_MINOR_UNITS = /^-?(0|[1-9]\d{0,18})$/;

export class CreateTopUpDto {
  @ApiProperty({
    enum: CURRENCY_CODES,
    description: 'Must be a currency this deployment transacts in.',
  })
  @IsIn(CURRENCY_CODES)
  currency!: string;

  @ApiProperty({
    description:
      'Integer minor units as a string, e.g. "2000" for USD 20.00. A string ' +
      'rather than a number so no amount can lose precision in transit.',
    example: '2000',
  })
  @IsString()
  @Matches(MINOR_UNITS, { message: 'must be an integer number of minor units' })
  amountMinorUnits!: string;
}

export class BalanceQueryDto {
  @ApiPropertyOptional({ enum: CURRENCY_CODES })
  @IsOptional()
  @IsIn(CURRENCY_CODES)
  currency?: string;
}

export class TransactionsQueryDto extends BalanceQueryDto {
  @ApiPropertyOptional({ minimum: 1, maximum: 100, default: 25 })
  @IsOptional()
  // A query string is text: without the conversion "25" is not an integer
  // and every page request was refused with VALIDATION_FAILED.
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  cursor?: string;
}

export class TopUpParamDto {
  @ApiProperty({ format: 'uuid' })
  @IsUUID()
  topUpId!: string;
}

export class QuoteQueryDto {
  @ApiProperty({ enum: SERVICE_PRODUCT_CODES })
  @IsIn(SERVICE_PRODUCT_CODES)
  product!: string;

  @ApiPropertyOptional({ enum: CURRENCY_CODES })
  @IsOptional()
  @IsIn(CURRENCY_CODES)
  currency?: string;
}

// ---------------------------------------------------------------------------
// Administrative
// ---------------------------------------------------------------------------

export class CreatePriceDto {
  @ApiProperty({ enum: SERVICE_PRODUCT_CODES })
  @IsIn(SERVICE_PRODUCT_CODES)
  productCode!: string;

  @ApiProperty({ enum: CURRENCY_CODES })
  @IsIn(CURRENCY_CODES)
  currency!: string;

  @ApiProperty({ description: 'Integer minor units as a string.', example: '300' })
  @IsString()
  @Matches(MINOR_UNITS, { message: 'must be an integer number of minor units' })
  amountMinorUnits!: string;

  @ApiPropertyOptional({ description: 'Reserved for future geographic pricing.' })
  @IsOptional()
  @IsString()
  @Matches(/^[A-Z][A-Z0-9_]{1,15}$/)
  marketCode?: string;
}

export class PriceParamDto {
  @ApiProperty({ format: 'uuid' })
  @IsUUID()
  priceVersionId!: string;
}

export class CreateRefundDto {
  @ApiProperty({ format: 'uuid', description: 'The top-up being refunded.' })
  @IsUUID()
  topUpId!: string;

  @ApiProperty({
    description: 'Integer minor units as a string. May be less than the original (§74).',
    example: '2000',
  })
  @IsString()
  @Matches(MINOR_UNITS, { message: 'must be an integer number of minor units' })
  amountMinorUnits!: string;

  @ApiProperty({ enum: PAYMENT_REFUND_REASONS })
  @IsIn(PAYMENT_REFUND_REASONS)
  reason!: string;
}

export class RefundParamDto {
  @ApiProperty({ format: 'uuid' })
  @IsUUID()
  refundId!: string;
}

export class CreateAdjustmentDto {
  @ApiProperty({ format: 'uuid', description: 'Whose balance is being adjusted.' })
  @IsUUID()
  ownerUserId!: string;

  @ApiProperty({ enum: CURRENCY_CODES })
  @IsIn(CURRENCY_CODES)
  currency!: string;

  @ApiProperty({
    enum: CREDIT_CLASSES,
    description:
      'PROMOTIONAL credit is spendable but never withdrawable through the provider (§9).',
  })
  @IsIn(CREDIT_CLASSES)
  creditClass!: string;

  @ApiProperty({
    description: 'Signed integer minor units as a string. Negative debits the customer.',
    example: '-500',
  })
  @IsString()
  @Matches(SIGNED_MINOR_UNITS, { message: 'must be a signed integer number of minor units' })
  amountMinorUnits!: string;

  @ApiProperty({
    enum: ADJUSTMENT_REASON_CODES,
    description: 'Required: an adjustment without a stated reason is not auditable (§76).',
  })
  @IsIn(ADJUSTMENT_REASON_CODES)
  reasonCode!: string;

  @ApiProperty({
    description: 'Required, so a retried request cannot adjust the balance twice.',
    maxLength: 128,
  })
  @IsString()
  @Length(1, 128)
  idempotencyKey!: string;

  @ApiPropertyOptional({ maxLength: 500 })
  @IsOptional()
  @IsString()
  @Length(1, 500)
  note?: string;
}

export class OwnerParamDto {
  @ApiProperty({ format: 'uuid' })
  @IsUUID()
  ownerUserId!: string;
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** Filter for the admin purchases/revenue report (ADR-0149). */
export class PurchaseReportQueryDto {
  @ApiPropertyOptional({ enum: SERVICE_PRODUCT_CODES })
  @IsOptional()
  @IsIn(SERVICE_PRODUCT_CODES)
  productCode?: string;

  @ApiPropertyOptional({ enum: CURRENCY_CODES })
  @IsOptional()
  @IsIn(CURRENCY_CODES)
  currency?: string;

  @ApiPropertyOptional({ description: 'First day, inclusive (YYYY-MM-DD, UTC).' })
  @IsOptional()
  @Matches(ISO_DATE)
  from?: string;

  @ApiPropertyOptional({ description: 'Last day, inclusive (YYYY-MM-DD, UTC).' })
  @IsOptional()
  @Matches(ISO_DATE)
  to?: string;

  @ApiPropertyOptional({ enum: SERVICE_PURCHASE_STATUSES })
  @IsOptional()
  @IsIn(SERVICE_PURCHASE_STATUSES)
  status?: string;

  @ApiPropertyOptional({ minimum: 1, maximum: 200, default: 100 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(200)
  limit?: number;
}
