import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { ORGANIZATION_TYPES, PAGINATION_MAX_LIMIT } from '@palcert/contracts';
import { Transform } from 'class-transformer';
import {
  IsBoolean,
  IsEmail,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  IsUrl,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';

const LOCALES = ['en', 'ar'] as const;
const ORGANIZATION_ROLE_CODES = [
  'ORGANIZATION_OWNER',
  'ORGANIZATION_ADMIN',
  'ORGANIZATION_REVIEWER',
  'TEMPLATE_MANAGER',
] as const;

const Trimmed = (): PropertyDecorator =>
  Transform(({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value));

/**
 * IANA timezone validation, using the runtime's own database rather than a
 * hand-maintained list — that list would be wrong within a year (§50).
 */
function isIanaTimezone(value: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: value });
    return value.includes('/') || value === 'UTC';
  } catch {
    return false;
  }
}

export class CreateOrganizationDto {
  @ApiProperty({ enum: ORGANIZATION_TYPES })
  @IsIn(ORGANIZATION_TYPES)
  type!: (typeof ORGANIZATION_TYPES)[number];

  @ApiProperty({ example: 'Islamic University of Gaza' })
  @Trimmed()
  @IsString()
  @MinLength(2)
  @MaxLength(200)
  displayName!: string;

  @ApiProperty({ example: 'Islamic University of Gaza' })
  @Trimmed()
  @IsString()
  @MinLength(2)
  @MaxLength(300)
  legalName!: string;

  @ApiPropertyOptional({
    example: 'iug',
    description:
      'Optional URL handle. Derived from the display name when omitted. Navigation only — ' +
      'never a security boundary.',
  })
  @IsOptional()
  @Trimmed()
  @IsString()
  @MaxLength(63)
  slug?: string;

  @ApiProperty({ example: 'PS', description: 'ISO 3166-1 alpha-2.' })
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim().toUpperCase() : value,
  )
  @Matches(/^[A-Z]{2}$/, { message: 'countryCode must be an ISO 3166-1 alpha-2 code.' })
  countryCode!: string;

  @ApiProperty({ example: 'Asia/Hebron', description: 'IANA timezone identifier.' })
  @Trimmed()
  @IsString()
  @MaxLength(64)
  @Matches(/^[A-Za-z0-9_+\-/]+$/, { message: 'timezone must be an IANA identifier.' })
  timezone!: string;

  @ApiPropertyOptional({ example: 'https://www.iugaza.edu.ps' })
  @IsOptional()
  @Trimmed()
  @IsUrl({ require_protocol: true, protocols: ['http', 'https'] })
  @MaxLength(300)
  website?: string;

  @ApiPropertyOptional({ enum: LOCALES, default: 'en' })
  @IsOptional()
  @IsIn(LOCALES)
  defaultLocale?: (typeof LOCALES)[number];
}

/**
 * Profile update.
 *
 * Only fields an organization user may legitimately change appear here.
 * Verification status, operational status, slug, creation metadata and internal
 * notes are absent by construction; combined with `forbidNonWhitelisted`, a
 * request that tries to set one is rejected outright rather than silently
 * ignored (§23).
 */
export class UpdateOrganizationDto {
  @ApiPropertyOptional()
  @IsOptional()
  @Trimmed()
  @IsString()
  @MinLength(2)
  @MaxLength(200)
  displayName?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @Trimmed()
  @IsString()
  @MinLength(2)
  @MaxLength(300)
  legalName?: string;

  @ApiPropertyOptional({ enum: ORGANIZATION_TYPES })
  @IsOptional()
  @IsIn(ORGANIZATION_TYPES)
  type?: (typeof ORGANIZATION_TYPES)[number];

  @ApiPropertyOptional({ example: 'PS' })
  @IsOptional()
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim().toUpperCase() : value,
  )
  @Matches(/^[A-Z]{2}$/, { message: 'countryCode must be an ISO 3166-1 alpha-2 code.' })
  countryCode?: string;

  @ApiPropertyOptional({ example: 'Asia/Hebron' })
  @IsOptional()
  @Trimmed()
  @IsString()
  @MaxLength(64)
  timezone?: string;

  @ApiPropertyOptional({ nullable: true })
  @IsOptional()
  @Trimmed()
  @IsString()
  @MaxLength(300)
  website?: string;

  @ApiPropertyOptional({ enum: LOCALES })
  @IsOptional()
  @IsIn(LOCALES)
  defaultLocale?: (typeof LOCALES)[number];
}

export class PageQueryDto {
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

export class OrganizationIdParamDto {
  @ApiProperty({ format: 'uuid' })
  @IsUUID()
  organizationId!: string;
}

export class MembershipParamDto extends OrganizationIdParamDto {
  @ApiProperty({ format: 'uuid' })
  @IsUUID()
  membershipId!: string;
}

/**
 * The role-removal route carries a third path parameter. It needs its own DTO:
 * with `forbidNonWhitelisted`, validating against a DTO that omits `roleCode`
 * would reject the request outright.
 */
export class MembershipRoleParamDto extends MembershipParamDto {
  @ApiProperty({ enum: ORGANIZATION_ROLE_CODES })
  @IsIn(ORGANIZATION_ROLE_CODES)
  roleCode!: (typeof ORGANIZATION_ROLE_CODES)[number];
}

export class InvitationParamDto extends OrganizationIdParamDto {
  @ApiProperty({ format: 'uuid' })
  @IsUUID()
  invitationId!: string;
}

export class InviteMemberDto {
  @ApiProperty({ example: 'colleague@university.edu' })
  @Trimmed()
  @IsEmail({}, { message: 'A valid email address is required.' })
  @MaxLength(320)
  email!: string;

  @ApiProperty({
    enum: ORGANIZATION_ROLE_CODES,
    description:
      'Organization role only. Platform roles are rejected — an organization can never grant ' +
      'PalCert-wide authority.',
  })
  @IsIn(ORGANIZATION_ROLE_CODES)
  roleCode!: (typeof ORGANIZATION_ROLE_CODES)[number];
}

export class AcceptInvitationDto {
  @ApiProperty({ description: 'The single-use token from the invitation link.' })
  @IsString()
  @MinLength(16)
  @MaxLength(512)
  token!: string;
}

export class UpdateMemberDto {
  @ApiProperty({ enum: ['ACTIVE', 'SUSPENDED', 'REMOVED'] })
  @IsIn(['ACTIVE', 'SUSPENDED', 'REMOVED'])
  status!: 'ACTIVE' | 'SUSPENDED' | 'REMOVED';
}

export class AssignOrganizationRoleDto {
  @ApiProperty({ enum: ORGANIZATION_ROLE_CODES })
  @IsIn(ORGANIZATION_ROLE_CODES)
  roleCode!: (typeof ORGANIZATION_ROLE_CODES)[number];
}

export class TransferOwnershipDto {
  @ApiProperty({ format: 'uuid', description: 'Membership id of the new owner.' })
  @IsUUID()
  toMembershipId!: string;

  @ApiPropertyOptional({
    default: true,
    description: 'Whether the current owner gives up the owner role.',
  })
  @IsOptional()
  @IsBoolean()
  stepDown?: boolean;
}

export class RequestVerificationDto {
  @ApiPropertyOptional({ maxLength: 2000 })
  @IsOptional()
  @Trimmed()
  @IsString()
  @MaxLength(2000)
  note?: string;
}

export class VerificationDecisionDto {
  @ApiProperty()
  @IsBoolean()
  approve!: boolean;

  @ApiPropertyOptional({
    maxLength: 1000,
    description: 'Applicant-facing explanation. Shown to the organization.',
  })
  @IsOptional()
  @Trimmed()
  @IsString()
  @MaxLength(1000)
  decisionReason?: string;

  @ApiPropertyOptional({
    maxLength: 2000,
    description: 'Reviewer-only notes. Never returned to the organization.',
  })
  @IsOptional()
  @Trimmed()
  @IsString()
  @MaxLength(2000)
  internalNotes?: string;
}

export class SuspendOrganizationDto {
  @ApiPropertyOptional({ maxLength: 500 })
  @IsOptional()
  @Trimmed()
  @IsString()
  @MaxLength(500)
  reason?: string;
}

export { isIanaTimezone };
