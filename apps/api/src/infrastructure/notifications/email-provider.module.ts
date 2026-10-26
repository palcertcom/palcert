import { Module } from '@nestjs/common';
import { NotificationEmailProviderPort } from '@palcert/contracts';
import { ApiConfigService } from '../../config/api-config.service';
import { ConfigModule } from '../../config/config.module';
import { DisabledEmailProvider } from './disabled-email-provider';
import { FakeEmailProvider } from './fake-email-provider';
import { SmtpEmailProvider } from './smtp-email-provider';

/**
 * Which transport, if any, sends workflow mail (§52, §115).
 *
 * Chosen by configuration at boot. `disabled` is the default and a legitimate
 * production choice — PalCert is usable with in-app notifications alone — so
 * the absence of an SMTP relay is a configuration, not a degraded mode.
 *
 * The SMTP adapter is constructed lazily, because it needs a credential a
 * deployment without workflow mail has no reason to hold.
 */
@Module({
  imports: [ConfigModule],
  providers: [
    DisabledEmailProvider,
    FakeEmailProvider,
    {
      provide: NotificationEmailProviderPort,
      inject: [ApiConfigService, DisabledEmailProvider, FakeEmailProvider],
      useFactory: (
        config: ApiConfigService,
        disabled: DisabledEmailProvider,
        fake: FakeEmailProvider,
      ): NotificationEmailProviderPort => {
        const provider = config.notificationEmail.provider;
        if (provider === 'fake') {
          // Configuration validation already refuses the double in production.
          // This is the second lock on the same door: a transport that accepts
          // every message and sends none would record deliveries that never
          // happened, which is worse than sending nothing at all.
          if (config.nodeEnv === 'production') {
            throw new Error('the fake email provider must never serve production');
          }
          return fake;
        }
        if (provider === 'smtp') {
          return new SmtpEmailProvider(config);
        }
        return disabled;
      },
    },
  ],
  exports: [NotificationEmailProviderPort, FakeEmailProvider],
})
export class EmailProviderModule {}
