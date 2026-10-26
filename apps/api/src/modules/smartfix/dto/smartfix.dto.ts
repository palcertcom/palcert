import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsUUID, IsOptional, IsBoolean, IsIn } from 'class-validator';
import { SMARTFIX_AI_CONSENT_VERSION } from '@palcert/contracts';

export class PlanSmartFixDto {
  @ApiPropertyOptional({
    format: 'uuid',
    description: 'SMARTFIX quote reserved before external AI planning.',
  })
  @IsOptional()
  @IsUUID('4')
  priceQuoteId?: string;
  @ApiPropertyOptional({ default: false })
  @IsOptional()
  @IsBoolean()
  useAI?: boolean;

  @ApiPropertyOptional({ enum: [SMARTFIX_AI_CONSENT_VERSION] })
  @IsOptional()
  @IsIn([SMARTFIX_AI_CONSENT_VERSION])
  formattingAIConsentVersion?: string;
}

export class CheckParamDto {
  @ApiProperty({ format: 'uuid' })
  @IsUUID('4')
  checkId!: string;
}

export class PlanParamDto {
  @ApiProperty({ format: 'uuid' })
  @IsUUID('4')
  planId!: string;
}

export class SmartFixRequestParamDto {
  @ApiProperty({ format: 'uuid' })
  @IsUUID('4')
  smartFixRequestId!: string;
}

export class StartSmartFixDto {
  @ApiProperty({
    format: 'uuid',
    description: 'The plan to execute. What runs is this plan, not a freshly computed one.',
  })
  @IsUUID('4')
  planId!: string;

  @ApiProperty({
    format: 'uuid',
    description:
      'A SMARTFIX price quote of your own, unexpired and unused. The price is the one it was ' +
      'issued at, even if the published price has since changed.',
  })
  @IsUUID('4')
  priceQuoteId!: string;
}
