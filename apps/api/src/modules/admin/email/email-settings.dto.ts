import { ApiHideProperty, ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  EMAIL_DELIVERY_CATEGORIES,
  EMAIL_DELIVERY_STATUSES,
  EMAIL_PROVIDER_KINDS,
  EMAIL_TEXT_LIMITS,
  type EmailDeliveryCategory,
  type EmailDeliveryStatus,
  type EmailProviderKind,
} from '@palcert/contracts';
import { Type } from 'class-transformer';
import {
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
} from 'class-validator';

/**
 * Shapes only. Semantic validation (addresses, domains, key formats, header
 * safety, "enabled needs a key") happens in the service, against the same
 * contract validators the dashboard uses, so the two can never disagree.
 */
export class UpdateEmailSettingsDto {
  @ApiProperty({ enum: EMAIL_PROVIDER_KINDS })
  @IsIn(EMAIL_PROVIDER_KINDS as unknown as string[])
  provider!: EmailProviderKind;

  @ApiProperty()
  @IsBoolean()
  enabled!: boolean;

  @ApiProperty({ example: 'palcert.com', maxLength: EMAIL_TEXT_LIMITS.domain })
  @IsString()
  @MaxLength(EMAIL_TEXT_LIMITS.domain)
  sendingDomain!: string;

  @ApiProperty({ example: 'no-reply@palcert.com', maxLength: EMAIL_TEXT_LIMITS.address })
  @IsString()
  @MaxLength(EMAIL_TEXT_LIMITS.address)
  fromEmail!: string;

  @ApiProperty({ example: 'PalCert', maxLength: EMAIL_TEXT_LIMITS.fromName })
  @IsString()
  @MaxLength(EMAIL_TEXT_LIMITS.fromName)
  fromName!: string;

  @ApiPropertyOptional({ nullable: true, maxLength: EMAIL_TEXT_LIMITS.address })
  @IsOptional()
  @IsString()
  @MaxLength(EMAIL_TEXT_LIMITS.address)
  replyToEmail?: string | null;

  @ApiProperty()
  @IsBoolean()
  authVerificationEnabled!: boolean;

  @ApiProperty()
  @IsBoolean()
  authPasswordResetEnabled!: boolean;

  @ApiProperty()
  @IsBoolean()
  authInvitationEnabled!: boolean;

  @ApiProperty()
  @IsBoolean()
  workflowEmailEnabled!: boolean;

  @ApiProperty()
  @IsBoolean()
  deliveryTrackingEnabled!: boolean;

  // Write-only credential inputs are kept out of the published OpenAPI
  // document, which by contract names no provider secret as a field; they
  // are described in docs/api/email.md. Blank keeps the stored value.
  @ApiHideProperty()
  @IsOptional()
  @IsString()
  @MaxLength(EMAIL_TEXT_LIMITS.apiKey)
  apiKey?: string | null;

  @ApiHideProperty()
  @IsOptional()
  @IsString()
  @MaxLength(EMAIL_TEXT_LIMITS.webhookSecret)
  webhookSecret?: string | null;

  @ApiHideProperty()
  @IsOptional()
  @IsBoolean()
  clearWebhookSecret?: boolean;
}

export class SendTestEmailDto {
  @ApiProperty({ maxLength: EMAIL_TEXT_LIMITS.address })
  @IsString()
  @MaxLength(EMAIL_TEXT_LIMITS.address)
  recipient!: string;

  @ApiProperty({ enum: ['en', 'ar'] })
  @IsIn(['en', 'ar'])
  locale!: 'en' | 'ar';
}

export class EmailDeliveryListQueryDto {
  @ApiPropertyOptional({ enum: EMAIL_DELIVERY_STATUSES })
  @IsOptional()
  @IsIn(EMAIL_DELIVERY_STATUSES as unknown as string[])
  status?: EmailDeliveryStatus;

  @ApiPropertyOptional({ enum: EMAIL_DELIVERY_CATEGORIES })
  @IsOptional()
  @IsIn(EMAIL_DELIVERY_CATEGORIES as unknown as string[])
  category?: EmailDeliveryCategory;

  @ApiPropertyOptional({ example: 'PASSWORD_RESET' })
  @IsOptional()
  @Matches(/^[A-Z][A-Z0-9_]{0,63}$/)
  template?: string;

  @ApiPropertyOptional({ example: 'resend' })
  @IsOptional()
  @Matches(/^[a-z][a-z0-9_-]{0,31}$/)
  provider?: string;

  @ApiPropertyOptional({ description: 'ISO-8601, inclusive' })
  @IsOptional()
  @IsISO8601({ strict: true })
  from?: string;

  @ApiPropertyOptional({ description: 'ISO-8601, exclusive' })
  @IsOptional()
  @IsISO8601({ strict: true })
  to?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(200)
  cursor?: string;

  @ApiPropertyOptional({ minimum: 1, maximum: 100 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number;
}

export class EmailDeliveryParamDto {
  @ApiProperty({ format: 'uuid' })
  @IsUUID()
  id!: string;
}
