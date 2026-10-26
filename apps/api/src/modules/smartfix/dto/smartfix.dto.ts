import { ApiProperty } from '@nestjs/swagger';
import { IsUUID } from 'class-validator';

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
