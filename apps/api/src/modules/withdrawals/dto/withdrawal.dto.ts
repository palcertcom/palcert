import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  PAYOUT_DESTINATION_LIMITS,
  PAYOUT_DESTINATION_TYPES,
  RECEIPT_MAX_BYTES,
  WITHDRAWAL_LIMITS,
  WITHDRAWAL_POLICY_BOUNDS,
  WITHDRAWAL_REJECTION_REASONS,
  WITHDRAWAL_SCOPES,
  WITHDRAWAL_STATUSES,
  type PayoutDestinationType,
  type WithdrawalScope,
  type WithdrawalStatus,
} from '@palcert/contracts';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsDateString,
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
const MINOR_UNITS_MESSAGE = 'must be a whole number of minor units, such as 50000 for 500.00';
const CURRENCY = /^[A-Z]{3}$/;

// ---------------------------------------------------------------------------
// Params
// ---------------------------------------------------------------------------

export class WithdrawalParamDto {
  @ApiProperty({ format: 'uuid' })
  @IsUUID('4')
  requestId!: string;
}

export class WithdrawalProofParamDto extends WithdrawalParamDto {
  @ApiProperty({ format: 'uuid' })
  @IsUUID('4')
  proofId!: string;
}

export class DestinationParamDto {
  @ApiProperty({ format: 'uuid' })
  @IsUUID('4')
  destinationId!: string;
}

export class OrganizationWithdrawalParamDto extends WithdrawalParamDto {
  @ApiProperty({ format: 'uuid' })
  @IsUUID('4')
  organizationId!: string;
}

export class OrganizationDestinationParamDto extends DestinationParamDto {
  @ApiProperty({ format: 'uuid' })
  @IsUUID('4')
  organizationId!: string;
}

// ---------------------------------------------------------------------------
// Destinations
// ---------------------------------------------------------------------------

export class PayoutDestinationDto {
  @ApiProperty({ enum: PAYOUT_DESTINATION_TYPES })
  @IsIn(PAYOUT_DESTINATION_TYPES)
  type!: PayoutDestinationType;

  @ApiProperty({ maxLength: PAYOUT_DESTINATION_LIMITS.label })
  @IsString()
  @MaxLength(PAYOUT_DESTINATION_LIMITS.label)
  label!: string;

  @ApiProperty({ maxLength: PAYOUT_DESTINATION_LIMITS.beneficiaryName })
  @IsString()
  @MaxLength(PAYOUT_DESTINATION_LIMITS.beneficiaryName)
  beneficiaryName!: string;

  @ApiPropertyOptional({
    example: 'USD',
    description: 'Restrict this destination to one currency.',
  })
  @IsOptional()
  @Matches(CURRENCY)
  currency?: string;

  @ApiPropertyOptional({ maxLength: PAYOUT_DESTINATION_LIMITS.bankName })
  @IsOptional()
  @IsString()
  @MaxLength(PAYOUT_DESTINATION_LIMITS.bankName)
  bankName?: string;

  @ApiPropertyOptional({ maxLength: PAYOUT_DESTINATION_LIMITS.iban })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  iban?: string;

  @ApiPropertyOptional({ maxLength: PAYOUT_DESTINATION_LIMITS.accountNumber })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  accountNumber?: string;

  @ApiPropertyOptional({ maxLength: PAYOUT_DESTINATION_LIMITS.branch })
  @IsOptional()
  @IsString()
  @MaxLength(PAYOUT_DESTINATION_LIMITS.branch)
  branch?: string;

  @ApiPropertyOptional({ maxLength: PAYOUT_DESTINATION_LIMITS.mobileNumber })
  @IsOptional()
  @IsString()
  @MaxLength(PAYOUT_DESTINATION_LIMITS.mobileNumber)
  mobileNumber?: string;

  @ApiPropertyOptional({ maxLength: PAYOUT_DESTINATION_LIMITS.instructions })
  @IsOptional()
  @IsString()
  @MaxLength(PAYOUT_DESTINATION_LIMITS.instructions)
  instructions?: string;
}

export class UpdatePayoutDestinationDto extends PayoutDestinationDto {
  @ApiProperty({ description: 'The version you are editing, for conflict detection.' })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  expectedVersion!: number;
}

export class VersionDto {
  @ApiProperty({ description: 'The version you are acting on, for conflict detection.' })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  expectedVersion!: number;
}

export class OptionalVersionDto {
  @ApiPropertyOptional()
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  expectedVersion?: number;
}

export class ListDestinationsQueryDto {
  @ApiPropertyOptional({ enum: ['true', 'false'] })
  @IsOptional()
  @IsIn(['true', 'false'])
  includeArchived?: 'true' | 'false';
}

// ---------------------------------------------------------------------------
// Requests
// ---------------------------------------------------------------------------

export class SubmitWithdrawalDto {
  @ApiProperty({ example: 'USD' })
  @Matches(CURRENCY)
  currency!: string;

  @ApiProperty({ example: '50000', description: 'The amount to withdraw, in minor units.' })
  @IsString()
  @Matches(MINOR_UNITS, { message: `amountMinorUnits ${MINOR_UNITS_MESSAGE}` })
  amountMinorUnits!: string;

  @ApiProperty({ format: 'uuid', description: 'A saved, live payout destination of yours.' })
  @IsUUID('4')
  destinationId!: string;

  @ApiPropertyOptional({ maxLength: WITHDRAWAL_LIMITS.requesterNote })
  @IsOptional()
  @IsString()
  @MaxLength(WITHDRAWAL_LIMITS.requesterNote)
  note?: string;
}

export class WithdrawableQueryDto {
  @ApiProperty({ example: 'USD' })
  @Matches(CURRENCY)
  currency!: string;
}

export class WithdrawalListQueryDto {
  @ApiPropertyOptional({ enum: WITHDRAWAL_STATUSES })
  @IsOptional()
  @IsIn(WITHDRAWAL_STATUSES)
  status?: WithdrawalStatus;

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

export class AdminWithdrawalQueueQueryDto extends WithdrawalListQueryDto {
  @ApiPropertyOptional({ enum: WITHDRAWAL_SCOPES })
  @IsOptional()
  @IsIn(WITHDRAWAL_SCOPES)
  scope?: WithdrawalScope;

  @ApiPropertyOptional({ example: 'USD' })
  @IsOptional()
  @Matches(CURRENCY)
  currency?: string;

  @ApiPropertyOptional({ format: 'uuid' })
  @IsOptional()
  @IsUUID('4')
  organizationId?: string;

  @ApiPropertyOptional({ format: 'uuid' })
  @IsOptional()
  @IsUUID('4')
  requesterUserId?: string;

  @ApiPropertyOptional({ format: 'date-time' })
  @IsOptional()
  @IsDateString()
  from?: string;

  @ApiPropertyOptional({ format: 'date-time' })
  @IsOptional()
  @IsDateString()
  to?: string;
}

// ---------------------------------------------------------------------------
// Finance
// ---------------------------------------------------------------------------

export class ApproveWithdrawalDto extends VersionDto {
  @ApiProperty({ example: '50000', description: 'Restate the amount being approved.' })
  @IsString()
  @Matches(MINOR_UNITS, { message: `confirmAmountMinorUnits ${MINOR_UNITS_MESSAGE}` })
  confirmAmountMinorUnits!: string;

  @ApiProperty({ example: 'USD' })
  @Matches(CURRENCY)
  confirmCurrency!: string;
}

export class RejectWithdrawalDto extends VersionDto {
  @ApiProperty({ enum: WITHDRAWAL_REJECTION_REASONS })
  @IsIn(WITHDRAWAL_REJECTION_REASONS)
  reason!: string;

  @ApiPropertyOptional({ maxLength: WITHDRAWAL_LIMITS.rejectionNote })
  @IsOptional()
  @IsString()
  @MaxLength(WITHDRAWAL_LIMITS.rejectionNote)
  note?: string;
}

export class MarkPaidDto extends ApproveWithdrawalDto {
  @ApiProperty({
    maxLength: WITHDRAWAL_LIMITS.externalReference,
    description: 'The transfer reference the bank or wallet issued. Mandatory.',
  })
  @IsString()
  @MaxLength(WITHDRAWAL_LIMITS.externalReference)
  externalTransferReference!: string;

  @ApiPropertyOptional({ maxLength: WITHDRAWAL_LIMITS.executionNote })
  @IsOptional()
  @IsString()
  @MaxLength(WITHDRAWAL_LIMITS.executionNote)
  note?: string;
}

export class MarkFailedDto extends VersionDto {
  @ApiProperty({ maxLength: WITHDRAWAL_LIMITS.executionNote })
  @IsString()
  @MaxLength(WITHDRAWAL_LIMITS.executionNote)
  note!: string;

  @ApiPropertyOptional({ maxLength: WITHDRAWAL_LIMITS.externalReference })
  @IsOptional()
  @IsString()
  @MaxLength(WITHDRAWAL_LIMITS.externalReference)
  externalReference?: string;
}

export class ReleaseWithdrawalDto extends VersionDto {
  @ApiProperty({ maxLength: WITHDRAWAL_LIMITS.releaseNote })
  @IsString()
  @MaxLength(WITHDRAWAL_LIMITS.releaseNote)
  note!: string;
}

export class CreateWithdrawalProofDto {
  @ApiProperty({ maxLength: 255 })
  @IsString()
  @MaxLength(255)
  originalFilename!: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(255)
  declaredMimeType?: string;

  @ApiProperty({ minimum: 1, maximum: RECEIPT_MAX_BYTES })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(RECEIPT_MAX_BYTES)
  sizeBytes!: number;

  @ApiPropertyOptional({ pattern: '^[0-9a-f]{64}$' })
  @IsOptional()
  @Matches(/^[0-9a-fA-F]{64}$/)
  sha256?: string;
}

// ---------------------------------------------------------------------------
// Policy
// ---------------------------------------------------------------------------

export class UpdateWithdrawalPolicyDto extends VersionDto {
  @ApiProperty({
    minimum: WITHDRAWAL_POLICY_BOUNDS.userManualTopUpClearingDays.min,
    maximum: WITHDRAWAL_POLICY_BOUNDS.userManualTopUpClearingDays.max,
  })
  @Type(() => Number)
  @IsInt()
  @Min(WITHDRAWAL_POLICY_BOUNDS.userManualTopUpClearingDays.min)
  @Max(WITHDRAWAL_POLICY_BOUNDS.userManualTopUpClearingDays.max)
  userManualTopUpClearingDays!: number;

  @ApiProperty({
    minimum: WITHDRAWAL_POLICY_BOUNDS.organizationClearingDays.min,
    maximum: WITHDRAWAL_POLICY_BOUNDS.organizationClearingDays.max,
  })
  @Type(() => Number)
  @IsInt()
  @Min(WITHDRAWAL_POLICY_BOUNDS.organizationClearingDays.min)
  @Max(WITHDRAWAL_POLICY_BOUNDS.organizationClearingDays.max)
  organizationClearingDays!: number;
}

export class WithdrawalLimitDto {
  @ApiProperty({ example: 'USD' })
  @Matches(CURRENCY)
  currency!: string;

  @ApiPropertyOptional({ example: '1000', nullable: true })
  @IsOptional()
  @IsString()
  @Matches(MINOR_UNITS, { message: `minAmountMinorUnits ${MINOR_UNITS_MESSAGE}` })
  minAmountMinorUnits?: string | null;

  @ApiPropertyOptional({ example: '1000000', nullable: true })
  @IsOptional()
  @IsString()
  @Matches(MINOR_UNITS, { message: `maxAmountMinorUnits ${MINOR_UNITS_MESSAGE}` })
  maxAmountMinorUnits?: string | null;
}

export class WithdrawalReviewersDto {
  @ApiProperty({ type: [String], maxItems: 20 })
  @IsArray()
  @ArrayMaxSize(20)
  @IsUUID('4', { each: true })
  userIds!: string[];
}
