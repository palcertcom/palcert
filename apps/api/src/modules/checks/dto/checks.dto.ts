import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  CHECK_STATUSES,
  COMPLIANCE_DETERMINATIONS,
  StandardCheckAvailability,
  type CheckStatus,
  type ComplianceDetermination,
} from '@palcert/contracts';
import { Transform, Type } from 'class-transformer';
import {
  IsBoolean,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
} from 'class-validator';

export class CheckParamDto {
  @ApiProperty({ format: 'uuid' })
  @IsUUID('4')
  checkId!: string;
}

export class OrganizationParamDto {
  @ApiProperty({ format: 'uuid' })
  @IsUUID('4')
  organizationId!: string;
}

export class DocumentTypeParamDto {
  @ApiProperty({ format: 'uuid' })
  @IsUUID('4')
  documentTypeId!: string;
}

export class StandardParamDto {
  @ApiProperty({ format: 'uuid' })
  @IsUUID('4')
  standardId!: string;
}

export class CompatibilityQueryDto {
  @ApiProperty({
    format: 'uuid',
    description: 'The document version whose detected format decides what can be answered.',
  })
  @IsUUID('4')
  documentVersionId!: string;
}

export class CreateCheckDto {
  @ApiProperty({ format: 'uuid', description: 'The exact document version to check.' })
  @IsUUID('4')
  documentVersionId!: string;

  @ApiProperty({
    format: 'uuid',
    description:
      'A standard the catalogue lists as checkable. The check binds to its current published ' +
      'version, and keeps that version for ever.',
  })
  @IsUUID('4')
  standardId!: string;

  @ApiProperty({
    format: 'uuid',
    description:
      'A price quote PalCert issued to you for DOCUMENT_CHECK. The amount comes from the quote, ' +
      'never from this request: there is no field here for a price, and there will not be one.',
  })
  @IsUUID('4')
  priceQuoteId!: string;
}

export class CheckCollectionQueryDto {
  @ApiPropertyOptional({ description: 'Opaque cursor from a previous page.' })
  @IsOptional()
  @IsString()
  @MaxLength(512)
  cursor?: string;

  @ApiPropertyOptional({ minimum: 1, maximum: 100 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number;

  @ApiPropertyOptional({ enum: CHECK_STATUSES, description: 'Processing status, not a verdict.' })
  @IsOptional()
  @IsIn(CHECK_STATUSES)
  status?: CheckStatus;

  @ApiPropertyOptional({ enum: COMPLIANCE_DETERMINATIONS })
  @IsOptional()
  @IsIn(COMPLIANCE_DETERMINATIONS)
  determination?: ComplianceDetermination;

  @ApiPropertyOptional({ format: 'uuid' })
  @IsOptional()
  @IsUUID('4')
  documentId?: string;

  @ApiPropertyOptional({ format: 'uuid' })
  @IsOptional()
  @IsUUID('4')
  standardId?: string;
}

const OUTCOMES = ['PASS', 'FAIL', 'NOT_APPLICABLE', 'INDETERMINATE', 'ERROR'] as const;
const SEVERITIES = ['INFO', 'MINOR', 'MAJOR', 'CRITICAL'] as const;

export class CheckResultQueryDto {
  @ApiPropertyOptional({ description: 'Opaque cursor from a previous page.' })
  @IsOptional()
  @IsString()
  @MaxLength(512)
  cursor?: string;

  @ApiPropertyOptional({ minimum: 1, maximum: 100 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number;

  @ApiPropertyOptional({ enum: OUTCOMES })
  @IsOptional()
  @IsIn(OUTCOMES)
  outcome?: string;

  @ApiPropertyOptional({ enum: SEVERITIES })
  @IsOptional()
  @IsIn(SEVERITIES)
  severity?: string;

  @ApiPropertyOptional({ description: 'Only rules that block compliance.' })
  @IsOptional()
  @Transform(({ value }: { value: unknown }) =>
    value === 'true' ? true : value === 'false' ? false : value,
  )
  @IsBoolean()
  blocking?: boolean;
}

export class UpdateStandardAvailabilityDto {
  @ApiProperty({
    enum: Object.values(StandardCheckAvailability),
    description:
      'PUBLIC_CHECKABLE lets anyone outside the organization check a document against this ' +
      'standard. It never grants them the standard itself, and never gives the organization ' +
      'sight of their documents.',
  })
  @IsIn(Object.values(StandardCheckAvailability))
  checkAvailability!: StandardCheckAvailability;
}
