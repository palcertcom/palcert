import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  CERTIFICATE_REVOCATION_COMMENT_MAX_LENGTH,
  CERTIFICATE_REVOCATION_REASONS,
  ORGANIZATION_CERTIFICATE_FILTERS,
  ORGANIZATION_CERTIFICATE_SEARCH_MAX_LENGTH,
  PAGINATION_MAX_LIMIT,
  type CertificateRevocationReason,
  type OrganizationCertificateFilter,
} from '@palcert/contracts';
import { Transform } from 'class-transformer';
import {
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Length,
  Max,
  MaxLength,
  Min,
} from 'class-validator';

export class CertificateParamDto {
  @ApiProperty({ format: 'uuid' })
  @IsUUID('4')
  certificateId!: string;
}

export class OrganizationCertificateParamDto {
  @ApiProperty({ format: 'uuid' })
  @IsUUID('4')
  organizationId!: string;

  @ApiProperty({ format: 'uuid' })
  @IsUUID('4')
  certificateId!: string;
}

export class OrganizationIdOnlyParamDto {
  @ApiProperty({ format: 'uuid' })
  @IsUUID('4')
  organizationId!: string;
}

export class OrganizationCertificateListQueryDto {
  @ApiPropertyOptional({ enum: ORGANIZATION_CERTIFICATE_FILTERS })
  @IsOptional()
  @IsIn(ORGANIZATION_CERTIFICATE_FILTERS)
  status?: OrganizationCertificateFilter;

  @ApiPropertyOptional({
    description:
      'Matches the standard code or name and the document type, or one certificate ' +
      'number exactly.',
    maxLength: ORGANIZATION_CERTIFICATE_SEARCH_MAX_LENGTH,
  })
  @IsOptional()
  @IsString()
  @MaxLength(ORGANIZATION_CERTIFICATE_SEARCH_MAX_LENGTH)
  q?: string;

  @ApiPropertyOptional({ description: 'Opaque cursor from a previous page.' })
  @IsOptional()
  @IsString()
  @MaxLength(512)
  cursor?: string;

  @ApiPropertyOptional({ minimum: 1, maximum: PAGINATION_MAX_LIMIT, default: 25 })
  @IsOptional()
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? Number.parseInt(value, 10) : value,
  )
  @IsInt()
  @Min(1)
  @Max(PAGINATION_MAX_LIMIT)
  limit?: number;
}

export class SubmissionRevisionParamDto {
  @ApiProperty({ format: 'uuid' })
  @IsUUID('4')
  revisionId!: string;
}

export class VerificationCodeParamDto {
  @ApiProperty({
    description:
      'The certificate number or its bare code. Case, spacing and the PC- prefix are ' +
      'normalized, and the look-alike characters a person might mistype are mapped.',
  })
  @IsString()
  // Bounded rather than pattern-matched: an invalid code must answer "not
  // found" exactly as an unknown one does, so the shape cannot be probed.
  @Length(1, 128)
  verificationCode!: string;
}

export class RevokeCertificateDto {
  @ApiProperty({
    enum: CERTIFICATE_REVOCATION_REASONS,
    description:
      'Administrative categories only. PalCert cannot adjudicate why an institution changed ' +
      'its mind, and a code implying otherwise would put PalCert’s name on their judgement.',
  })
  @IsIn(CERTIFICATE_REVOCATION_REASONS)
  reasonCode!: CertificateRevocationReason;

  @ApiPropertyOptional({
    description: 'A private note for the record. Never shown publicly.',
    maxLength: CERTIFICATE_REVOCATION_COMMENT_MAX_LENGTH,
  })
  @IsOptional()
  @IsString()
  @MaxLength(CERTIFICATE_REVOCATION_COMMENT_MAX_LENGTH)
  comment?: string;
}
