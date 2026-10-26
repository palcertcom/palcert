import { Module } from '@nestjs/common';
import { AIProviderModule } from '../infrastructure/ai/ai-provider.module';
import { PaymentProviderModule } from '../infrastructure/payments/payment-provider.module';
import { StorageModule } from '../infrastructure/storage/storage.module';
import { HealthController } from './health.controller';
import { HealthService } from './health.service';
import { DatabaseHealthIndicator } from './indicators/database.health-indicator';
import { RedisHealthIndicator } from './indicators/redis.health-indicator';
import { StorageHealthIndicator } from './indicators/storage.health-indicator';

@Module({
  imports: [StorageModule, AIProviderModule, PaymentProviderModule],
  controllers: [HealthController],
  providers: [HealthService, DatabaseHealthIndicator, RedisHealthIndicator, StorageHealthIndicator],
  exports: [HealthService],
})
export class HealthModule {}
