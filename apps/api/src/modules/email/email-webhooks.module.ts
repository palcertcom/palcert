import { Module } from '@nestjs/common';
import { OutboundEmailModule } from '../../infrastructure/email/outbound-email.module';
import { ResendWebhookController } from './resend-webhook.controller';
import { ResendWebhookService } from './resend-webhook.service';

@Module({
  imports: [OutboundEmailModule],
  controllers: [ResendWebhookController],
  providers: [ResendWebhookService],
})
export class EmailWebhooksModule {}
