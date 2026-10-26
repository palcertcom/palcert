import { Module } from '@nestjs/common';

import { SafeWebhookHttpClient } from './http/safe-webhook-http-client';
import { ApiConfigService } from '../../config/api-config.service';
import { ConfigModule } from '../../config/config.module';
import { PrismaModule } from '../../infrastructure/prisma/prisma.module';
import { QueueModule } from '../../infrastructure/queue/queue.module';
import { TenantPrismaService } from '../../infrastructure/tenant/tenant-prisma.service';
import { ClockPort, SystemClock } from '../auth/ports/clock.port';
import { WebhookCryptoService } from './services/webhook-crypto.service';
import { WebhookDeliveryService } from './services/webhook-delivery.service';
import { WebhookDeliverySweeper } from './services/webhook-delivery-sweeper.service';
import { WebhookFanoutReconciler } from './services/webhook-fanout-reconciler.service';
import { WebhookFanoutService } from './services/webhook-fanout.service';
import { WebhookGatewayService } from './services/webhook-gateway.service';
import { WebhookKeyringService } from './services/webhook-keyring.service';
import { WebhookRevealSweeper } from './services/webhook-reveal-sweeper.service';
import { WebhookRewrapService } from './services/webhook-rewrap.service';
import { WebhookEndpointService } from './services/webhook-endpoint.service';
import { WebhookReadService } from './services/webhook-read.service';
import { WebhookManagementService } from './services/webhook-management.service';
import { WebhookMetricsService } from './services/webhook-metrics.service';
import { WebhookSubscriptionService } from './services/webhook-subscription.service';
import { WebhookVerificationService } from './services/webhook-verification.service';

/**
 * The part of Phase 17 both processes need.
 *
 * The API imports it for management; the worker imports it for fan-out,
 * delivery and verification. The HTTP client is provided here and nowhere
 * else, so there is one place that can open a socket to a customer address.
 */
@Module({
  imports: [ConfigModule, PrismaModule, QueueModule],
  providers: [
    TenantPrismaService,
    { provide: ClockPort, useClass: SystemClock },
    WebhookKeyringService,
    WebhookCryptoService,
    WebhookGatewayService,
    WebhookFanoutService,
    WebhookDeliveryService,
    WebhookVerificationService,
    WebhookFanoutReconciler,
    WebhookDeliverySweeper,
    WebhookRevealSweeper,
    WebhookRewrapService,
    WebhookEndpointService,
    WebhookManagementService,
    WebhookSubscriptionService,
    WebhookReadService,
    WebhookMetricsService,
    {
      provide: SafeWebhookHttpClient,
      inject: [ApiConfigService],
      useFactory: (config: ApiConfigService) => new SafeWebhookHttpClient(config.webhookHttpLimits),
    },
  ],
  exports: [
    WebhookKeyringService,
    WebhookCryptoService,
    WebhookGatewayService,
    WebhookFanoutService,
    WebhookDeliveryService,
    WebhookVerificationService,
    WebhookFanoutReconciler,
    WebhookDeliverySweeper,
    WebhookRevealSweeper,
    WebhookRewrapService,
    WebhookEndpointService,
    WebhookManagementService,
    WebhookSubscriptionService,
    WebhookReadService,
    WebhookMetricsService,
    SafeWebhookHttpClient,
    TenantPrismaService,
  ],
})
export class WebhooksCoreModule {}
