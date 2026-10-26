import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import {
  IsBoolean,
  IsEmail,
  IsIn,
  IsOptional,
  IsString,
  IsUUID,
  Length,
  MaxLength,
  MinLength,
} from 'class-validator';

/**
 * Request DTOs.
 *
 * Every field a client may send is declared explicitly. Combined with the
 * global ValidationPipe (`whitelist` + `forbidNonWhitelisted`), an unexpected
 * property is rejected rather than ignored — which is what makes mass
 * assignment impossible (§25).
 *
 * Password fields carry only length bounds here; the real policy lives in
 * PasswordService so it stays configurable and testable in one place.
 */

const LOCALES = ['en', 'ar'] as const;

/**
 * Trim surrounding whitespace before validation.
 *
 * Users paste addresses out of emails and documents and routinely pick up a
 * leading or trailing space; rejecting that as "not a valid email address" is a
 * confusing dead end. Normalization for identity purposes still happens in
 * `normalizeEmail` — this only prevents a pointless validation failure.
 */
const TrimmedEmail = (): PropertyDecorator =>
  Transform(({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value));

export class RegisterDto {
  @ApiProperty({ example: 'researcher@university.edu' })
  @TrimmedEmail()
  @IsEmail({}, { message: 'A valid email address is required.' })
  @MaxLength(320)
  email!: string;

  @ApiProperty({ minLength: 12, description: 'Minimum length is set by AUTH_PASSWORD_MIN_LENGTH.' })
  @IsString()
  @MaxLength(4096)
  password!: string;

  @ApiPropertyOptional({ maxLength: 120 })
  @IsOptional()
  @IsString()
  @MaxLength(120)
  displayName?: string;

  @ApiPropertyOptional({ enum: LOCALES, default: 'en' })
  @IsOptional()
  @IsIn(LOCALES)
  locale?: (typeof LOCALES)[number];
}

export class LoginDto {
  @ApiProperty()
  @TrimmedEmail()
  @IsEmail({}, { message: 'A valid email address is required.' })
  @MaxLength(320)
  email!: string;

  @ApiProperty()
  @IsString()
  @MaxLength(4096)
  password!: string;
}

export class EmailOnlyDto {
  @ApiProperty()
  @TrimmedEmail()
  @IsEmail({}, { message: 'A valid email address is required.' })
  @MaxLength(320)
  email!: string;
}

export class TokenDto {
  @ApiProperty({ description: 'The single-use token from the emailed link.' })
  @IsString()
  @Length(16, 512)
  token!: string;
}

export class ResetPasswordDto extends TokenDto {
  @ApiProperty()
  @IsString()
  @MaxLength(4096)
  newPassword!: string;
}

export class ChangePasswordDto {
  @ApiProperty()
  @IsString()
  @MaxLength(4096)
  currentPassword!: string;

  @ApiProperty()
  @IsString()
  @MaxLength(4096)
  newPassword!: string;
}

export class MfaCodeDto {
  @ApiProperty({ example: '123456', description: 'Six-digit code from the authenticator app.' })
  @IsString()
  @Length(6, 10)
  code!: string;
}

export class MfaChallengeDto {
  @ApiProperty({ description: 'TOTP code, or a recovery code when useRecoveryCode is true.' })
  @IsString()
  @Length(6, 32)
  code!: string;

  @ApiPropertyOptional({ default: false })
  @IsOptional()
  @IsBoolean()
  useRecoveryCode?: boolean;
}

export class MfaDisableDto extends MfaCodeDto {
  @ApiProperty({ description: 'Current password, required for this sensitive change.' })
  @IsString()
  @MaxLength(4096)
  password!: string;
}

export class UpdateProfileDto {
  @ApiPropertyOptional({ maxLength: 120 })
  @IsOptional()
  @IsString()
  @MaxLength(120)
  displayName?: string;

  @ApiPropertyOptional({ enum: LOCALES })
  @IsOptional()
  @IsIn(LOCALES)
  preferredLocale?: (typeof LOCALES)[number];
}

export class SessionIdParamDto {
  @ApiProperty({ format: 'uuid' })
  @IsUUID()
  id!: string;
}

export class AssignRoleDto {
  @ApiProperty({ example: 'PALCERT_SUPPORT' })
  @IsString()
  @MinLength(2)
  @MaxLength(64)
  roleCode!: string;
}

export class SuspendUserDto {
  @ApiPropertyOptional({ maxLength: 500 })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  reason?: string;
}
