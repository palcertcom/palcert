import { Module } from '@nestjs/common';
import { ConfigModule } from '../../config/config.module';
import { EmailDeliveryRecorder } from './email-delivery-recorder';
import { EmailSettingsService } from './email-settings.service';

/**
 * The shared bottom layer of PalCert mail (ADR-0146): the admin-managed
 * provider configuration and the delivery-metadata writer. Imported by the
 * auth module, the notification core and the admin console; each producer
 * keeps its own port above it.
 */
@Module({
  imports: [ConfigModule],
  providers: [EmailSettingsService, EmailDeliveryRecorder],
  exports: [EmailSettingsService, EmailDeliveryRecorder],
})
export class OutboundEmailModule {}
