import { Module } from '@nestjs/common';
import { AIProviderPort } from '@palcert/contracts';
import { ApiConfigService } from '../../config/api-config.service';
import { ConfigModule } from '../../config/config.module';
import { AnthropicAIProvider } from './anthropic-provider';
import { FakeAIProvider } from './fake-ai-provider';

/**
 * Which provider PalCert talks to (§3, §4, §64).
 *
 * Chosen by configuration at boot, and there is exactly one: Phase 8 does not
 * fall back to a second vendor when the first is unavailable. A silent
 * failover would send someone's unpublished research to a company they were
 * never told about, under terms they never saw — so an outage is reported as
 * an outage, and the deterministic report keeps working (§64, §105).
 */
@Module({
  imports: [ConfigModule],
  providers: [
    AnthropicAIProvider,
    FakeAIProvider,
    {
      provide: AIProviderPort,
      inject: [ApiConfigService, AnthropicAIProvider, FakeAIProvider],
      useFactory: (
        config: ApiConfigService,
        anthropic: AnthropicAIProvider,
        fake: FakeAIProvider,
      ): AIProviderPort => {
        // Configuration validation already refuses the double in production;
        // this is the second lock on the same door.
        if (config.ai.provider === 'fake') {
          if (config.nodeEnv === 'production') {
            throw new Error('the fake AI provider must never serve production');
          }
          return fake;
        }
        return anthropic;
      },
    },
  ],
  exports: [AIProviderPort, FakeAIProvider],
})
export class AIProviderModule {}
