import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  MAX_MANUAL_PAYMENT_METHOD_REVIEWERS,
  MANUAL_PAYMENT_METHOD_TYPES,
  MANUAL_TOPUP_LIMITS,
  MANUAL_TOPUP_REJECTION_REASONS,
  MANUAL_TOPUP_STATUSES,
  RECEIPT_MAX_BYTES,
  type ManualTopUpStatus,
} from '@palcert/contracts';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  Max,
  MaxLength,
  Min,
} from 'class-validator';

const MINOR_UNITS = /^(0|[1-9]\d{0,18})$/;
const MINOR_UNITS_MESSAGE = 'must be a whole number of minor units, such as 15000 for 150.00';

// ---------------------------------------------------------------------------
// Params
// ---------------------------------------------------------------------------

export class ManualTopUpParamDto {
  @ApiProperty({ format: 'uuid' })
  @IsUUID('4')
  requestId!: string;
}

export class ManualTopUpReceiptParamDto extends ManualTopUpParamDto {
  @ApiProperty({ format: 'uuid' })
  @IsUUID('4')
  receiptId!: string;
}

export class PaymentMethodParamDto {
  @ApiProperty({ format: 'uuid' })
  @IsUUID('4')
  methodId!: string;
}

export class PaymentMethodLogoParamDto extends PaymentMethodParamDto {
  @ApiProperty({ format: 'uuid' })
  @IsUUID('4')
  logoId!: string;
}

// ---------------------------------------------------------------------------
// Customer
// ---------------------------------------------------------------------------

export class CreateManualTopUpDto {
  @ApiProperty({ format: 'uuid', description: 'The payment method the transfer was sent to.' })
  @IsUUID('4')
  paymentMethodId!: string;

  @ApiPropertyOptional({ example: '15000', description: 'The amount sent, in minor units.' })
  @IsOptional()
  @IsString()
  @Matches(MINOR_UNITS, { message: `amountMinorUnits ${MINOR_UNITS_MESSAGE}` })
  amountMinorUnits?: string;

  @ApiPropertyOptional({
    maxLength: MANUAL_TOPUP_LIMITS.referenceOriginal,
    description: 'The transfer reference exactly as the bank or wallet shows it.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(MANUAL_TOPUP_LIMITS.referenceOriginal)
  reference?: string;

  @ApiPropertyOptional({ maxLength: MANUAL_TOPUP_LIMITS.customerNote })
  @IsOptional()
  @IsString()
  @MaxLength(MANUAL_TOPUP_LIMITS.customerNote)
  customerNote?: string;
}

export class UpdateManualTopUpDto {
  @ApiPropertyOptional({ example: '15000', nullable: true })
  @IsOptional()
  @IsString()
  @Matches(MINOR_UNITS, { message: `amountMinorUnits ${MINOR_UNITS_MESSAGE}` })
  amountMinorUnits?: string | null;

  @ApiPropertyOptional({ maxLength: MANUAL_TOPUP_LIMITS.referenceOriginal, nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(MANUAL_TOPUP_LIMITS.referenceOriginal)
  reference?: string | null;

  @ApiPropertyOptional({ maxLength: MANUAL_TOPUP_LIMITS.customerNote, nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(MANUAL_TOPUP_LIMITS.customerNote)
  customerNote?: string | null;

  @ApiPropertyOptional({ description: 'Detach the current receipt.' })
  @IsOptional()
  @IsBoolean()
  removeReceipt?: boolean;
}

export class CreateManualTopUpFileDto {
  @ApiProperty({ maxLength: 255 })
  @IsString()
  @MaxLength(255)
  originalFilename!: string;

  @ApiPropertyOptional({ maxLength: 255 })
  @IsOptional()
  @IsString()
  @MaxLength(255)
  declaredMimeType?: string;

  @ApiProperty({ minimum: 1, maximum: RECEIPT_MAX_BYTES })
  @IsInt()
  @Min(1)
  @Max(RECEIPT_MAX_BYTES)
  sizeBytes!: number;

  @ApiPropertyOptional({ description: 'Optional client SHA-256, lowercase hex.' })
  @IsOptional()
  @Matches(/^[0-9a-fA-F]{64}$/)
  sha256?: string;
}

export class ManualTopUpListQueryDto {
  @ApiPropertyOptional({ enum: MANUAL_TOPUP_STATUSES })
  @IsOptional()
  @IsIn(MANUAL_TOPUP_STATUSES)
  status?: ManualTopUpStatus;

  @ApiPropertyOptional({ minimum: 1, maximum: 100 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number;

  @ApiPropertyOptional({ format: 'uuid' })
  @IsOptional()
  @IsUUID('4')
  cursor?: string;
}

// ---------------------------------------------------------------------------
// Finance
// ---------------------------------------------------------------------------

export class ManualTopUpQueueQueryDto extends ManualTopUpListQueryDto {
  @ApiPropertyOptional({ format: 'uuid' })
  @IsOptional()
  @IsUUID('4')
  paymentMethodId?: string;

  @ApiPropertyOptional({ example: 'ILS' })
  @IsOptional()
  @Matches(/^[A-Z]{3}$/)
  currency?: string;

  @ApiPropertyOptional({ description: 'Part of a transfer reference.' })
  @IsOptional()
  @IsString()
  @MaxLength(MANUAL_TOPUP_LIMITS.referenceOriginal)
  reference?: string;

  @ApiPropertyOptional({ format: 'uuid' })
  @IsOptional()
  @IsUUID('4')
  ownerUserId?: string;
}

export class ApproveManualTopUpDto {
  @ApiProperty({
    example: '15000',
    description:
      'The amount being credited, restated by the reviewer as confirmation. It must equal the ' +
      'reported amount: an approval never changes what was reported.',
  })
  @IsString()
  @Matches(MINOR_UNITS, { message: `confirmAmountMinorUnits ${MINOR_UNITS_MESSAGE}` })
  confirmAmountMinorUnits!: string;

  @ApiProperty({ example: 'ILS' })
  @Matches(/^[A-Z]{3}$/)
  confirmCurrency!: string;
}

export class RejectManualTopUpDto {
  @ApiProperty({ enum: MANUAL_TOPUP_REJECTION_REASONS })
  @IsIn(MANUAL_TOPUP_REJECTION_REASONS)
  reason!: string;

  @ApiPropertyOptional({
    maxLength: MANUAL_TOPUP_LIMITS.rejectionNote,
    description: 'Shown to the customer. Required when the reason is OTHER.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(MANUAL_TOPUP_LIMITS.rejectionNote)
  note?: string;
}

// ---------------------------------------------------------------------------
// Payment methods
// ---------------------------------------------------------------------------

export class PaymentMethodBodyDto {
  @ApiProperty({ enum: MANUAL_PAYMENT_METHOD_TYPES })
  @IsIn(MANUAL_PAYMENT_METHOD_TYPES)
  type!: string;

  @ApiProperty({ maxLength: MANUAL_TOPUP_LIMITS.name })
  @IsString()
  @MaxLength(MANUAL_TOPUP_LIMITS.name)
  nameEn!: string;

  @ApiProperty({ maxLength: MANUAL_TOPUP_LIMITS.name })
  @IsString()
  @MaxLength(MANUAL_TOPUP_LIMITS.name)
  nameAr!: string;

  @ApiPropertyOptional({ maxLength: MANUAL_TOPUP_LIMITS.description, nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(MANUAL_TOPUP_LIMITS.description)
  descriptionEn?: string | null;

  @ApiPropertyOptional({ maxLength: MANUAL_TOPUP_LIMITS.description, nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(MANUAL_TOPUP_LIMITS.description)
  descriptionAr?: string | null;

  @ApiProperty({ example: 'ILS' })
  @Matches(/^[A-Za-z]{3}$/)
  currency!: string;

  @ApiPropertyOptional({ maxLength: MANUAL_TOPUP_LIMITS.recipientName, nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(MANUAL_TOPUP_LIMITS.recipientName)
  recipientName?: string | null;

  @ApiPropertyOptional({ maxLength: 32, nullable: true, example: '+970599000000' })
  @IsOptional()
  @IsString()
  @MaxLength(32)
  mobileNumber?: string | null;

  @ApiPropertyOptional({ maxLength: 64, nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  iban?: string | null;

  @ApiPropertyOptional({ maxLength: MANUAL_TOPUP_LIMITS.bankName, nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(MANUAL_TOPUP_LIMITS.bankName)
  bankName?: string | null;

  @ApiPropertyOptional({ maxLength: MANUAL_TOPUP_LIMITS.accountNumber, nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(MANUAL_TOPUP_LIMITS.accountNumber)
  accountNumber?: string | null;

  @ApiPropertyOptional({ maxLength: MANUAL_TOPUP_LIMITS.branchName, nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(MANUAL_TOPUP_LIMITS.branchName)
  branchName?: string | null;

  @ApiPropertyOptional({ maxLength: MANUAL_TOPUP_LIMITS.instructions, nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(MANUAL_TOPUP_LIMITS.instructions)
  instructionsEn?: string | null;

  @ApiPropertyOptional({ maxLength: MANUAL_TOPUP_LIMITS.instructions, nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(MANUAL_TOPUP_LIMITS.instructions)
  instructionsAr?: string | null;

  @ApiProperty({ example: '1000' })
  @IsString()
  @Matches(MINOR_UNITS, { message: `minAmountMinorUnits ${MINOR_UNITS_MESSAGE}` })
  minAmountMinorUnits!: string;

  @ApiProperty({ example: '500000' })
  @IsString()
  @Matches(MINOR_UNITS, { message: `maxAmountMinorUnits ${MINOR_UNITS_MESSAGE}` })
  maxAmountMinorUnits!: string;

  @ApiPropertyOptional({ minimum: 0, maximum: MANUAL_TOPUP_LIMITS.maxDisplayOrder })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(MANUAL_TOPUP_LIMITS.maxDisplayOrder)
  displayOrder?: number;

  @ApiPropertyOptional({
    type: [String],
    maxItems: MAX_MANUAL_PAYMENT_METHOD_REVIEWERS,
    description:
      'PalCert users who review this method’s top-ups. Each must hold ' +
      'finance:manual-topup:review through a platform role. Omitted on an edit: unchanged. ' +
      'Empty: every finance reviewer is alerted.',
  })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(MAX_MANUAL_PAYMENT_METHOD_REVIEWERS)
  @IsUUID('all', { each: true })
  reviewerUserIds?: string[];
}

export class CreatePaymentMethodDto extends PaymentMethodBodyDto {
  @ApiProperty({ example: 'JAWWAL_PAY', description: 'Permanent identifier. Cannot change later.' })
  @IsString()
  @MaxLength(MANUAL_TOPUP_LIMITS.code)
  code!: string;
}

export class UpdatePaymentMethodDto extends PaymentMethodBodyDto {
  @ApiProperty({ description: 'The version that was read; a stale one is refused.' })
  @IsInt()
  @Min(1)
  expectedVersion!: number;
}

export class PaymentMethodVersionDto {
  @ApiProperty({ description: 'The version that was read; a stale one is refused.' })
  @IsInt()
  @Min(1)
  expectedVersion!: number;
}
