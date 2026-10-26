import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { NOTIFICATION_TYPES, type NotificationType } from '@palcert/contracts';
import { IsBoolean, IsIn, IsInt, IsOptional, IsString, IsUUID, Max, Min } from 'class-validator';
import { Type } from 'class-transformer';

export class NotificationParamDto {
  @ApiProperty({ format: 'uuid' })
  @IsUUID('4')
  notificationId!: string;
}

export class NotificationPageQueryDto {
  @ApiPropertyOptional({ description: 'Opaque token from a previous page.' })
  @IsOptional()
  @IsString()
  cursor?: string;

  @ApiPropertyOptional({ minimum: 1, maximum: 100, default: 25 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number;
}

export class NotificationTypeParamDto {
  @ApiProperty({ enum: NOTIFICATION_TYPES })
  @IsIn(NOTIFICATION_TYPES)
  notificationType!: NotificationType;
}

export class SetNotificationPreferenceDto {
  @ApiProperty({
    description:
      'Whether PalCert emails you about this type. Certificate revocation cannot be ' +
      'switched off, and asking is refused rather than quietly ignored.',
  })
  @IsBoolean()
  emailEnabled!: boolean;
}
