import { ApiProperty } from '@nestjs/swagger';
import { IsUUID } from 'class-validator';

export class CheckParamDto {
  @ApiProperty({ format: 'uuid' })
  @IsUUID('4')
  checkId!: string;
}

export class AIReviewParamDto extends CheckParamDto {
  @ApiProperty({ format: 'uuid' })
  @IsUUID('4')
  reviewId!: string;
}

/**
 * Starting an AI review buys one (ADR-0149).
 *
 * The body names a quote and nothing else: the amount, currency, price version
 * and payer are all the server's. Any other property is refused by the global
 * validation pipe.
 */
export class CreateAIReviewDto {
  @ApiProperty({
    format: 'uuid',
    description:
      'An AI_REVIEW price quote of your own, unexpired and unused (GET /balance/pricing/quote' +
      '?product=AI_REVIEW). The price is the one it was issued at, even if the published price ' +
      'has since changed.',
  })
  @IsUUID('4')
  priceQuoteId!: string;
}
