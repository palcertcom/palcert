import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  ATTESTATION_ARTIFACT_FORMATS,
  ATTESTATION_REQUEST_STATUSES,
  ATTESTATION_TEXT_LIMITS,
  ATTESTATION_VERIFICATION_STATUSES,
  CONFIGURABLE_REQUIRED_FIELDS,
  type AttestationPaymentStatus,
  type AttestationRequestStatus,
  type AttestationVerificationStatus,
} from '@palcert/contracts';
import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsISO8601,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';
import { QUEUE_TABS } from '../services/attestation-review.service';

const MINOR_UNITS = /^(0|[1-9]\d{0,14})$/;
const PAYMENT_STATUSES = ['NOT_REQUIRED', 'UNPAID', 'RESERVED', 'SETTLED', 'RELEASED'] as const;

// ---------------------------------------------------------------------------
// Params
// ---------------------------------------------------------------------------

export class RequestParamDto {
  @ApiProperty({ format: 'uuid' })
  @IsUUID('4')
  requestId!: string;
}

export class RequestArtifactParamDto extends RequestParamDto {
  @ApiProperty({ format: 'uuid' })
  @IsUUID('4')
  artifactId!: string;
}

export class OrganizationParamDto {
  @ApiProperty({ format: 'uuid' })
  @IsUUID('4')
  organizationId!: string;
}

export class OrganizationRequestParamDto extends OrganizationParamDto {
  @ApiProperty({ format: 'uuid' })
  @IsUUID('4')
  requestId!: string;
}

export class OrganizationTypeParamDto extends OrganizationParamDto {
  @ApiProperty({ format: 'uuid' })
  @IsUUID('4')
  typeId!: string;
}

export class OrganizationAttestationParamDto extends OrganizationParamDto {
  @ApiProperty({ format: 'uuid' })
  @IsUUID('4')
  attestationId!: string;
}

export class PublicTokenParamDto {
  @ApiProperty({ description: 'The 32-symbol public token from a verification link.' })
  @IsString()
  @MaxLength(64)
  token!: string;
}

export class QrQueryDto {
  @ApiPropertyOptional({ enum: ['png', 'svg'], default: 'png' })
  @IsOptional()
  @IsIn(['png', 'svg'])
  format?: 'png' | 'svg';
}

export class ArtifactLinkQueryDto {
  @ApiPropertyOptional({ enum: ['inline', 'attachment'], default: 'attachment' })
  @IsOptional()
  @IsIn(['inline', 'attachment'])
  disposition?: 'inline' | 'attachment';
}

// ---------------------------------------------------------------------------
// Owner
// ---------------------------------------------------------------------------

export class MetadataDto {
  @ApiPropertyOptional({ maxLength: ATTESTATION_TEXT_LIMITS.certificateTitle })
  @IsOptional()
  @IsString()
  @MaxLength(ATTESTATION_TEXT_LIMITS.certificateTitle)
  certificateTitle?: string;

  @ApiPropertyOptional({ maxLength: ATTESTATION_TEXT_LIMITS.certificateType, nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(ATTESTATION_TEXT_LIMITS.certificateType)
  certificateType?: string | null;

  @ApiPropertyOptional({ maxLength: ATTESTATION_TEXT_LIMITS.issuingOrganization, nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(ATTESTATION_TEXT_LIMITS.issuingOrganization)
  issuingOrganization?: string | null;

  @ApiPropertyOptional({ description: 'YYYY-MM-DD', nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(10)
  issueDate?: string | null;

  @ApiPropertyOptional({ maxLength: ATTESTATION_TEXT_LIMITS.referenceNumber, nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(ATTESTATION_TEXT_LIMITS.referenceNumber)
  referenceNumber?: string | null;

  @ApiPropertyOptional({ maxLength: ATTESTATION_TEXT_LIMITS.recipientName, nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(ATTESTATION_TEXT_LIMITS.recipientName)
  recipientName?: string | null;

  @ApiPropertyOptional({ maxLength: ATTESTATION_TEXT_LIMITS.description, nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(ATTESTATION_TEXT_LIMITS.description)
  description?: string | null;

  @ApiPropertyOptional({ maxLength: ATTESTATION_TEXT_LIMITS.notesForReviewer, nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(ATTESTATION_TEXT_LIMITS.notesForReviewer)
  notesForReviewer?: string | null;
}

export class CreateAttestationRequestDto extends MetadataDto {
  @ApiProperty({ format: 'uuid' })
  @IsUUID('4')
  attestationTypeId!: string;

  @ApiProperty({ maxLength: ATTESTATION_TEXT_LIMITS.certificateTitle })
  @IsString()
  @MaxLength(ATTESTATION_TEXT_LIMITS.certificateTitle)
  declare certificateTitle: string;

  @ApiPropertyOptional({
    format: 'uuid',
    nullable: true,
    description: 'Renewal: the earlier attestation this re-attestation replaces. Never modified.',
  })
  @IsOptional()
  @IsUUID('4')
  previousAttestationId?: string | null;
}

export class OwnerRequestListQueryDto {
  @ApiPropertyOptional({ enum: ATTESTATION_REQUEST_STATUSES })
  @IsOptional()
  @IsIn(ATTESTATION_REQUEST_STATUSES as readonly string[])
  status?: AttestationRequestStatus;
}

export class CreateArtifactDto {
  @ApiProperty({ maxLength: 255 })
  @IsString()
  @MaxLength(255)
  originalFilename!: string;

  @ApiPropertyOptional({ maxLength: 255 })
  @IsOptional()
  @IsString()
  @MaxLength(255)
  declaredMimeType?: string;

  @ApiProperty({ minimum: 1, maximum: 20971520 })
  @IsInt()
  @Min(1)
  @Max(20971520)
  sizeBytes!: number;

  @ApiPropertyOptional({
    description: 'Optional client SHA-256, lowercase hex, for early mismatch detection.',
  })
  @IsOptional()
  @Matches(/^[0-9a-fA-F]{64}$/)
  sha256?: string;
}

export class RespondDto {
  @ApiProperty({ maxLength: ATTESTATION_TEXT_LIMITS.ownerResponse })
  @IsString()
  @MaxLength(ATTESTATION_TEXT_LIMITS.ownerResponse)
  message!: string;

  @ApiPropertyOptional({ type: MetadataDto })
  @IsOptional()
  @ValidateNested()
  @Type(() => MetadataDto)
  metadata?: MetadataDto;
}

// ---------------------------------------------------------------------------
// Institution
// ---------------------------------------------------------------------------

export class QueueQueryDto {
  @ApiPropertyOptional({ enum: QUEUE_TABS })
  @IsOptional()
  @IsIn(QUEUE_TABS as readonly string[])
  status?: string;

  @ApiPropertyOptional({ format: 'uuid' })
  @IsOptional()
  @IsUUID('4')
  attestationTypeId?: string;

  @ApiPropertyOptional({ maxLength: 200 })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  search?: string;

  @ApiPropertyOptional({ format: 'uuid' })
  @IsOptional()
  @IsUUID('4')
  reviewerUserId?: string;

  @ApiPropertyOptional({ enum: PAYMENT_STATUSES })
  @IsOptional()
  @IsIn(PAYMENT_STATUSES as readonly string[])
  paymentStatus?: AttestationPaymentStatus;

  @ApiPropertyOptional({ enum: ATTESTATION_VERIFICATION_STATUSES })
  @IsOptional()
  @IsIn(ATTESTATION_VERIFICATION_STATUSES as readonly string[])
  validity?: AttestationVerificationStatus;

  @ApiPropertyOptional({ description: 'YYYY-MM-DD' })
  @IsOptional()
  @Matches(/^\d{4}-\d{2}-\d{2}$/)
  submittedFrom?: string;

  @ApiPropertyOptional({ description: 'YYYY-MM-DD' })
  @IsOptional()
  @Matches(/^\d{4}-\d{2}-\d{2}$/)
  submittedTo?: string;

  @ApiPropertyOptional({ enum: ['submittedAt', 'updatedAt'] })
  @IsOptional()
  @IsIn(['submittedAt', 'updatedAt'])
  sort?: 'submittedAt' | 'updatedAt';

  @ApiPropertyOptional({ enum: ['asc', 'desc'] })
  @IsOptional()
  @IsIn(['asc', 'desc'])
  order?: 'asc' | 'desc';

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(64)
  cursor?: string;

  @ApiPropertyOptional({ minimum: 1, maximum: 100 })
  @IsOptional()
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? Number.parseInt(value, 10) : value,
  )
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number;
}

export class AssignDto {
  @ApiProperty({ format: 'uuid', nullable: true })
  @IsOptional()
  @IsUUID('4')
  reviewerUserId!: string | null;
}

export class RequestInformationDto {
  @ApiProperty({ maxLength: ATTESTATION_TEXT_LIMITS.reviewerMessage })
  @IsString()
  @MaxLength(ATTESTATION_TEXT_LIMITS.reviewerMessage)
  message!: string;
}

export class RejectDto {
  @ApiProperty({ maxLength: ATTESTATION_TEXT_LIMITS.rejectionReason })
  @IsString()
  @MaxLength(ATTESTATION_TEXT_LIMITS.rejectionReason)
  reason!: string;
}

export class RevokeDto {
  @ApiProperty({ maxLength: ATTESTATION_TEXT_LIMITS.revocationReason })
  @IsString()
  @MaxLength(ATTESTATION_TEXT_LIMITS.revocationReason)
  reason!: string;
}

export class ApproveDto {
  @ApiProperty({ description: 'The reviewer confirms they examined this exact certificate.' })
  @IsBoolean()
  confirm!: boolean;

  @ApiProperty({ maxLength: ATTESTATION_TEXT_LIMITS.certificateTitle })
  @IsString()
  @MaxLength(ATTESTATION_TEXT_LIMITS.certificateTitle)
  certificateTitle!: string;

  @ApiPropertyOptional({ nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(ATTESTATION_TEXT_LIMITS.certificateType)
  certificateType?: string | null;

  @ApiPropertyOptional({ nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(ATTESTATION_TEXT_LIMITS.recipientName)
  holderName?: string | null;

  @ApiPropertyOptional({ nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(ATTESTATION_TEXT_LIMITS.issuingOrganization)
  issuingOrganization?: string | null;

  @ApiPropertyOptional({ nullable: true, description: 'YYYY-MM-DD' })
  @IsOptional()
  @IsString()
  @MaxLength(10)
  issueDate?: string | null;

  @ApiPropertyOptional({ nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(ATTESTATION_TEXT_LIMITS.referenceNumber)
  referenceNumber?: string | null;

  @ApiPropertyOptional({ default: true })
  @IsOptional()
  @IsBoolean()
  holderNamePublic?: boolean;

  @ApiPropertyOptional({ default: true })
  @IsOptional()
  @IsBoolean()
  referenceNumberPublic?: boolean;

  @ApiPropertyOptional({ nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(ATTESTATION_TEXT_LIMITS.institutionNote)
  institutionNote?: string | null;

  @ApiPropertyOptional({
    nullable: true,
    description: 'ISO-8601 instant. Defaults to the approval time.',
  })
  @IsOptional()
  @IsISO8601({ strict: true })
  validFrom?: string | null;

  @ApiPropertyOptional({ nullable: true, description: 'ISO-8601 valid-through instant.' })
  @IsOptional()
  @IsISO8601({ strict: true })
  validUntil?: string | null;

  @ApiPropertyOptional({ nullable: true, minimum: 1, maximum: 36600 })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(36600)
  validityDays?: number | null;

  @ApiPropertyOptional({ description: 'Only where the attestation type allows it.' })
  @IsOptional()
  @IsBoolean()
  noExpiry?: boolean;
}

export class AttestationTypeDto {
  @ApiPropertyOptional({ maxLength: 200 })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  nameEn?: string;

  @ApiPropertyOptional({ maxLength: 200 })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  nameAr?: string;

  @ApiPropertyOptional({ nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(ATTESTATION_TEXT_LIMITS.typeDescription)
  descriptionEn?: string | null;

  @ApiPropertyOptional({ nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(ATTESTATION_TEXT_LIMITS.typeDescription)
  descriptionAr?: string | null;

  @ApiPropertyOptional({ nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(ATTESTATION_TEXT_LIMITS.typeInstructions)
  instructionsEn?: string | null;

  @ApiPropertyOptional({ nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(ATTESTATION_TEXT_LIMITS.typeInstructions)
  instructionsAr?: string | null;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  enabled?: boolean;

  @ApiPropertyOptional({ description: 'ISO 4217; must be enabled on this deployment.' })
  @IsOptional()
  @Matches(/^[A-Za-z]{3}$/)
  currency?: string;

  @ApiPropertyOptional({ description: 'Fee in minor units, as a decimal string.' })
  @IsOptional()
  @Matches(MINOR_UNITS)
  feeMinorUnits?: string;

  @ApiPropertyOptional({ nullable: true, minimum: 1, maximum: 36600 })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(36600)
  defaultValidityDays?: number | null;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  allowNoExpiry?: boolean;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  reviewerMayOverrideValidity?: boolean;

  @ApiPropertyOptional({ enum: CONFIGURABLE_REQUIRED_FIELDS, isArray: true })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(10)
  @IsIn(CONFIGURABLE_REQUIRED_FIELDS as readonly string[], { each: true })
  requiredFields?: string[];

  @ApiPropertyOptional({ enum: ATTESTATION_ARTIFACT_FORMATS, isArray: true })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(4)
  @IsIn(ATTESTATION_ARTIFACT_FORMATS as readonly string[], { each: true })
  allowedFormats?: string[];

  @ApiPropertyOptional({ minimum: 1024, maximum: 20971520 })
  @IsOptional()
  @IsInt()
  @Min(1024)
  @Max(20971520)
  maxFileBytes?: number;

  @ApiPropertyOptional({ isArray: true, type: Number })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(8)
  @IsInt({ each: true })
  @Min(1, { each: true })
  @Max(365, { each: true })
  reminderDays?: number[];
}

export class AttestationFeeDto {
  @ApiProperty({ description: 'ISO 4217; must be enabled on this deployment.' })
  @Matches(/^[A-Za-z]{3}$/)
  currency!: string;

  @ApiProperty({ description: 'Fee in minor units, as a decimal string. "1000" is $10.00.' })
  @Matches(MINOR_UNITS)
  feeMinorUnits!: string;
}

export class RevenueQueryDto {
  @ApiPropertyOptional({ description: 'YYYY-MM-DD' })
  @IsOptional()
  @Matches(/^\d{4}-\d{2}-\d{2}$/)
  from?: string;

  @ApiPropertyOptional({ description: 'YYYY-MM-DD' })
  @IsOptional()
  @Matches(/^\d{4}-\d{2}-\d{2}$/)
  to?: string;

  @ApiPropertyOptional({ format: 'uuid' })
  @IsOptional()
  @IsUUID('4')
  attestationTypeId?: string;

  @ApiPropertyOptional({ enum: ATTESTATION_REQUEST_STATUSES })
  @IsOptional()
  @IsIn(ATTESTATION_REQUEST_STATUSES as readonly string[])
  status?: AttestationRequestStatus;

  @ApiPropertyOptional({ enum: PAYMENT_STATUSES })
  @IsOptional()
  @IsIn(PAYMENT_STATUSES as readonly string[])
  paymentStatus?: AttestationPaymentStatus;

  @ApiPropertyOptional({
    maxLength: 200,
    description: 'Title, attestation reference or transaction id.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  search?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(64)
  cursor?: string;

  @ApiPropertyOptional({ minimum: 1, maximum: 200 })
  @IsOptional()
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? Number.parseInt(value, 10) : value,
  )
  @IsInt()
  @Min(1)
  @Max(200)
  limit?: number;
}

// ---------------------------------------------------------------------------
// Administration and public
// ---------------------------------------------------------------------------

export class SetCommissionDto {
  @ApiProperty({
    description: 'Platform commission, e.g. "15" or "12.5". 0 to 100, two decimals at most.',
  })
  @IsString()
  @Matches(/^\d{1,3}(\.\d{1,2})?$/)
  percent!: string;

  @ApiPropertyOptional({
    nullable: true,
    description: 'ISO-8601. Defaults to now; never in the past.',
  })
  @IsOptional()
  @IsISO8601({ strict: true })
  effectiveFrom?: string | null;

  @ApiProperty({ maxLength: 500 })
  @IsString()
  @MaxLength(500)
  reason!: string;
}

export class PlatformOverviewQueryDto {
  @ApiPropertyOptional({ description: 'YYYY-MM-DD' })
  @IsOptional()
  @Matches(/^\d{4}-\d{2}-\d{2}$/)
  from?: string;

  @ApiPropertyOptional({ description: 'YYYY-MM-DD' })
  @IsOptional()
  @Matches(/^\d{4}-\d{2}-\d{2}$/)
  to?: string;

  @ApiPropertyOptional({ format: 'uuid' })
  @IsOptional()
  @IsUUID('4')
  organizationId?: string;
}

export class VerifyFileDto {
  @ApiProperty({
    description:
      'SHA-256 of the file, computed by the visitor. The file itself is never sent to PalCert.',
  })
  @Matches(/^[0-9a-fA-F]{64}$/)
  sha256!: string;
}
