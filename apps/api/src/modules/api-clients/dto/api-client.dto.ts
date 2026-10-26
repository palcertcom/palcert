import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { ALL_API_CLIENT_SCOPES } from '@palcert/contracts';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsISO8601,
  IsOptional,
  IsString,
  IsUUID,
  Length,
} from 'class-validator';

export class OrganizationParamDto {
  @IsUUID()
  organizationId!: string;
}

export class ApiClientParamDto extends OrganizationParamDto {
  @IsUUID()
  apiClientId!: string;
}

export class CreateApiClientDto {
  @ApiProperty({ description: 'What this integration is, for the people who maintain it.' })
  @IsString()
  @Length(1, 120)
  displayName!: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @Length(1, 500)
  description?: string;

  @ApiProperty({
    description:
      'What the credential may reach. At least one: a client holding none could call nothing, ' +
      'and would be a credential existing for no reason.',
    enum: ALL_API_CLIENT_SCOPES,
    isArray: true,
  })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(32)
  // Shape only. Which names are scopes is decided by the service, so an
  // unknown one comes back as API_CLIENT_SCOPE_INVALID naming the offender
  // rather than as a generic validation failure an integrator has to guess at.
  @IsString({ each: true })
  scopes!: string[];

  @ApiPropertyOptional({
    description:
      'When the credential stops authenticating. Omit for a credential that does not expire. ' +
      'At most two years out.',
  })
  @IsOptional()
  @IsISO8601()
  expiresAt?: string;
}

export class RotateApiClientDto {
  @ApiPropertyOptional({
    description:
      'How long the previous secret keeps working, in seconds. Defaults to twelve hours; ' +
      'zero retires it immediately. Never more than twelve hours — an unbounded overlap is a ' +
      'second permanent credential.',
  })
  @IsOptional()
  overlapSeconds?: number;
}

export class SetApiClientEnabledDto {
  @ApiProperty({ description: 'False stops the credential reversibly; secrets survive.' })
  @IsBoolean()
  enabled!: boolean;
}
