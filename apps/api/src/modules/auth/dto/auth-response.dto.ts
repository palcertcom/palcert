import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

/**
 * Response DTOs.
 *
 * These are the only shapes authentication returns. Notably absent everywhere:
 * password hashes, session tokens, CSRF tokens, TOTP secrets and recovery code
 * digests. Session and CSRF tokens travel exclusively in cookies (§2, §33).
 */

export const LoginResultStatus = {
  AUTHENTICATED: 'AUTHENTICATED',
  MFA_REQUIRED: 'MFA_REQUIRED',
  MFA_ENROLLMENT_REQUIRED: 'MFA_ENROLLMENT_REQUIRED',
} as const;

export type LoginResultStatus = (typeof LoginResultStatus)[keyof typeof LoginResultStatus];

export class LoginResponseDto {
  @ApiProperty({ enum: Object.values(LoginResultStatus) })
  status!: LoginResultStatus;
}

export class GenericAcknowledgementDto {
  @ApiProperty({
    example: true,
    description:
      'Always true. Endpoints that accept an email address acknowledge the request without ' +
      'revealing whether an account exists.',
  })
  acknowledged!: boolean;
}

export class UserProfileDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty() email!: string;
  @ApiProperty({ nullable: true, type: String }) displayName!: string | null;
  @ApiProperty() status!: string;
  @ApiProperty() preferredLocale!: string;
  @ApiProperty() emailVerified!: boolean;
  @ApiProperty() mfaEnrolled!: boolean;
  @ApiProperty() mfaRequired!: boolean;
  @ApiProperty({ type: [String] }) roles!: string[];
  @ApiProperty({ type: [String] }) permissions!: string[];
  @ApiProperty() createdAt!: string;
  @ApiProperty({ nullable: true, type: String }) lastLoginAt!: string | null;
}

export class SessionSummaryDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty() createdAt!: string;
  @ApiProperty() lastActivityAt!: string;
  @ApiProperty() absoluteExpiresAt!: string;
  @ApiProperty() idleExpiresAt!: string;
  @ApiProperty() assuranceLevel!: string;
  @ApiProperty({ nullable: true, type: String }) ipAddress!: string | null;
  @ApiProperty({ nullable: true, type: String }) userAgent!: string | null;
  @ApiProperty({ description: 'True for the session making this request.' }) current!: boolean;
}

export class MfaEnrollmentResponseDto {
  @ApiProperty({ description: 'otpauth:// URI for manual entry.' }) provisioningUri!: string;
  @ApiProperty({ description: 'PNG data URL of the provisioning URI.' }) qrCodeDataUrl!: string;
  @ApiProperty({ description: 'Base32 secret, shown once during enrollment.' }) secret!: string;
}

export class MfaConfirmationResponseDto {
  @ApiProperty({
    type: [String],
    description: 'Single-use recovery codes. Displayed once and never retrievable again.',
  })
  recoveryCodes!: string[];
}

export class RevokedSessionsDto {
  @ApiProperty({ description: 'How many sessions were revoked.' }) revoked!: number;
  @ApiPropertyOptional() message?: string;
}
