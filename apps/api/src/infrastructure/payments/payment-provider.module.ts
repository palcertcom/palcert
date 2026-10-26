import { Module } from '@nestjs/common';
import { PaymentProviderPort } from '@palcert/contracts';
import { ApiConfigService } from '../../config/api-config.service';
import { ConfigModule } from '../../config/config.module';
import { DisabledPaymentProvider } from './disabled-payment-provider';
import { FakePaymentProvider } from './fake-payment-provider';
import { StripePaymentProvider } from './stripe-payment-provider';

/**
 * Which payment company PalCert talks to (§34, §35, §36).
 *
 * Chosen by configuration at boot. Stripe is the reference adapter, not an
 * assumption: Stripe cannot onboard merchants in every country PalCert intends
 * to serve, so a regional provider is a foreseeable requirement. Changing
 * `PAYMENT_PROVIDER` must be all it takes — no change to the ledger, balances,
 * holds, pricing or refunds.
 *
 * The Stripe adapter is constructed lazily, because it needs a credential a
 * deployment without payments has no reason to hold.
 *
 * And it is not constructed at all when payments are off. Until Phase 20
 * Checkpoint 7 this factory ignored `PAYMENTS_ENABLED` entirely: a deployment
 * that had disabled payments still had the Stripe adapter built at boot, so it
 * still had to supply `STRIPE_SECRET_KEY`, and without one the API threw
 * during module initialization and never started. That turned an optional
 * feature into a mandatory credential and a configuration error into an
 * outage. `DisabledPaymentProvider` stands in instead — no credential, no
 * client, no network, and a deliberate `PAYMENTS_DISABLED` for every
 * operation.
 */
@Module({
  imports: [ConfigModule],
  providers: [
    FakePaymentProvider,
    DisabledPaymentProvider,
    {
      provide: PaymentProviderPort,
      inject: [ApiConfigService, FakePaymentProvider, DisabledPaymentProvider],
      useFactory: (
        config: ApiConfigService,
        fake: FakePaymentProvider,
        disabled: DisabledPaymentProvider,
      ): PaymentProviderPort => {
        // First, because it is the only branch that must hold regardless of
        // which provider is *named*. `PAYMENT_PROVIDER` keeps its default of
        // `stripe` on a deployment that has simply never thought about
        // payments, and that deployment must still boot.
        if (!config.payments.enabled) {
          return disabled;
        }
        if (config.payments.provider === 'fake') {
          // Configuration validation already refuses the double in production.
          // This is the second lock on the same door, and it matters more here
          // than for AI: this double confirms payments that never happened.
          if (config.nodeEnv === 'production') {
            throw new Error('the fake payment provider must never serve production');
          }
          return fake;
        }
        return new StripePaymentProvider(config);
      },
    },
  ],
  exports: [PaymentProviderPort, FakePaymentProvider, DisabledPaymentProvider],
})
export class PaymentProviderModule {}
