import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { WEBHOOK_EVENT_TYPES, type WebhookEventType } from '@palcert/contracts';
import {
  ArrayMaxSize,
  ArrayUnique,
  IsArray,
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

export class OrganizationParamDto {
  @ApiProperty({ format: 'uuid' })
  @IsUUID('4')
  organizationId!: string;
}

export class WebhookEndpointParamDto extends OrganizationParamDto {
  @ApiProperty({ format: 'uuid' })
  @IsUUID('4')
  endpointId!: string;
}

export class WebhookDeliveryParamDto extends OrganizationParamDto {
  @ApiProperty({ format: 'uuid' })
  @IsUUID('4')
  deliveryId!: string;
}

/**
 * The closed event vocabulary, and nothing else.
 *
 * No wildcard, deliberately: an event type added in a later phase would start
 * flowing to every existing integration on the day it shipped, which is a
 * disclosure decision nobody made.
 */
export class WebhookSubscriptionsDto {
  @ApiProperty({
    isArray: true,
    enum: WEBHOOK_EVENT_TYPES,
    description: 'The exact set to subscribe to. An empty array unsubscribes from everything.',
  })
  @IsArray()
  @ArrayUnique()
  @ArrayMaxSize(WEBHOOK_EVENT_TYPES.length)
  @IsIn(WEBHOOK_EVENT_TYPES, { each: true })
  eventTypes!: WebhookEventType[];
}

export class CreateWebhookEndpointDto extends WebhookSubscriptionsDto {
  @ApiProperty({ description: 'What this integration is for, in the administrator’s own words.' })
  @IsString()
  @Length(1, 200)
  description!: string;

  @ApiProperty({
    description:
      'An HTTPS URL on a public address. Query strings, IP literals, non-standard ports ' +
      'and PalCert’s own hosts are refused with WEBHOOK_URL_NOT_ALLOWED.',
  })
  @IsString()
  @MaxLength(2048)
  url!: string;
}

export class UpdateWebhookDescriptionDto {
  @ApiProperty()
  @IsString()
  @Length(1, 200)
  description!: string;
}

export class UpdateWebhookUrlDto {
  @ApiProperty({
    description:
      'Saved as a new immutable configuration version. The currently verified one keeps ' +
      'serving until this one proves itself.',
  })
  @IsString()
  @MaxLength(2048)
  url!: string;
}

export class WebhookDeliveryQueryDto {
  @ApiPropertyOptional({ format: 'uuid', description: 'Only this endpoint’s deliveries.' })
  @IsOptional()
  @IsUUID('4')
  endpointId?: string;

  @ApiPropertyOptional({ description: 'Opaque token from the previous page.' })
  @IsOptional()
  @IsString()
  @MaxLength(512)
  cursor?: string;

  @ApiPropertyOptional({ minimum: 1, maximum: 50, default: 20 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(50)
  limit?: number;
}
