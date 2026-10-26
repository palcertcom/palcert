import { Module } from '@nestjs/common';
import { AICoreModule } from './ai-core.module';
import { AIReviewsController } from './controllers/ai-reviews.controller';

/**
 * AI review (Phase 8), with its HTTP surface.
 *
 * The module owns consent, the review lifecycle and reading AI output back. It
 * owns no evaluation and no compliance decision: the deterministic layer built
 * in Phase 7 remains the only thing that decides anything.
 */
@Module({
  imports: [AICoreModule],
  controllers: [AIReviewsController],
  exports: [AICoreModule],
})
export class AIModule {}
