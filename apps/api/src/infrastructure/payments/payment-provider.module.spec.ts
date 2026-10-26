import { Global, Module } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { AppError, PalCertErrorCode, PaymentProviderPort } from '@palcert/contracts';
import { ApiConfigService } from '../../config/api-config.service';
import { ConfigModule } from '../../config/config.module';
import { DisabledPaymentProvider } from './disabled-payment-provider';
import { FakePaymentProvider } from './fake-payment-provider';
import { StripePaymentProvider } from './stripe-payment-provider';
import { PaymentProviderModule } from './payment-provider.module';

/**
 * Which provider a deployment gets, and what happens when it has none
 * (Phase 20 Checkpoint 7).
 *
 * The defect these exist for: the factory used to ignore `PAYMENTS_ENABLED`
 * and construct the configured adapter regardless. `PAYMENT_PROVIDER` defaults
 * to `stripe`, so an installation that had simply never thought about payments
 * got the Stripe adapter built at boot, which threw for want of a secret key —
 * and the API did not start. A feature switch that requires the credentials of
 * the feature it switches off is not a feature switch, and turning one on is
 * not supposed to be the price of booting.
 *
 * The module is exercised through Nest rather than by calling the factory
 * function directly, because the failure was a *boot* failure: it happened
 * during module initialization, and a test that calls a factory by hand would
 * not have caught where it happened.
 */

/** The parts of the config service this module reads, and nothing else. */
function configuration(overrides: {
  enabled: boolean;
  provider?: 'stripe' | 'fake';
  secretKey?: string;
  nodeEnv?: 'development' | 'test' | 'production';
}): ApiConfigService {
  return {
    nodeEnv: overrides.nodeEnv ?? 'test',
    payments: {
      enabled: overrides.enabled,
      provider: overrides.provider ?? 'stripe',
      enabledCurrencies: ['USD'],
    },
    stripe: {
      secretKey: overrides.secretKey,
      webhookSecret: undefined,
      apiVersion: '2026-08-26.dahlia',
      baseUrl: undefined,
      timeoutMs: 5_000,
    },
  } as unknown as ApiConfigService;
}

/**
 * The real `ConfigModule` validates the whole process environment when it
 * initializes, so importing it here would make these tests depend on whatever
 * `.env` the machine happens to have — and an override of `ApiConfigService`
 * does not stop that: the validation runs in a *different* provider's factory,
 * before the override applies. Replacing the module is what actually keeps the
 * process environment out of it.
 */
async function resolveProvider(config: ApiConfigService): Promise<PaymentProviderPort> {
  @Global()
  @Module({
    providers: [{ provide: ApiConfigService, useValue: config }],
    exports: [ApiConfigService],
  })
  class StubConfigModule {}

  const moduleRef = await Test.createTestingModule({ imports: [PaymentProviderModule] })
    .overrideModule(ConfigModule)
    .useModule(StubConfigModule)
    .compile();
  return moduleRef.get(PaymentProviderPort);
}

describe('PaymentProviderModule', () => {
  describe('payments enabled', () => {
    it('constructs the configured provider when its credential is present', async () => {
      const provider = await resolveProvider(
        configuration({ enabled: true, provider: 'stripe', secretKey: 'sk_test_for_module_spec' }),
      );
      expect(provider).toBeInstanceOf(StripePaymentProvider);
      expect(provider.getCapabilities().provider).toBe('stripe');
    });

    it('refuses to start when the credential is missing', async () => {
      // The configuration schema refuses this combination too, so this is the
      // second lock: a deployment that reached the module with payments on and
      // no key must fail loudly at boot rather than at a customer's first
      // top-up.
      await expect(
        resolveProvider(configuration({ enabled: true, provider: 'stripe', secretKey: undefined })),
      ).rejects.toThrow(/STRIPE_SECRET_KEY/);
    });

    it('still refuses the double in production', async () => {
      await expect(
        resolveProvider(configuration({ enabled: true, provider: 'fake', nodeEnv: 'production' })),
      ).rejects.toThrow(/fake payment provider must never serve production/);
    });

    it('allows the double outside production', async () => {
      const provider = await resolveProvider(configuration({ enabled: true, provider: 'fake' }));
      expect(provider).toBeInstanceOf(FakePaymentProvider);
    });
  });

  describe('payments disabled', () => {
    it('starts with no provider credentials at all', async () => {
      // The regression. `provider` is left at its default of `stripe` and no
      // key is supplied, which is exactly the shape of a deployment that has
      // never configured payments — and exactly what used to refuse to boot.
      const provider = await resolveProvider(configuration({ enabled: false }));
      expect(provider).toBeInstanceOf(DisabledPaymentProvider);
    });

    it('starts in production with no provider credentials', async () => {
      const provider = await resolveProvider(
        configuration({ enabled: false, nodeEnv: 'production' }),
      );
      expect(provider).toBeInstanceOf(DisabledPaymentProvider);
    });

    it('does not construct a provider merely because one is named', async () => {
      const provider = await resolveProvider(
        configuration({ enabled: false, provider: 'fake', nodeEnv: 'production' }),
      );
      // `fake` named, production, payments off: the fake adapter must not be
      // the answer either. Disabled outranks the provider name.
      expect(provider).toBeInstanceOf(DisabledPaymentProvider);
    });

    it('answers every payment operation with a deterministic disabled contract', async () => {
      const provider = await resolveProvider(configuration({ enabled: false }));

      const operations: ReadonlyArray<[string, () => unknown]> = [
        ['createTopUpSession', () => provider.createTopUpSession({} as never)],
        [
          'retrievePayment',
          () => provider.retrievePayment({ providerSessionId: null, providerPaymentId: null }),
        ],
        ['refundPayment', () => provider.refundPayment({} as never)],
        [
          'verifyAndParseWebhook',
          () =>
            provider.verifyAndParseWebhook({
              rawBody: Buffer.from('{}'),
              signatureHeader: undefined,
            }),
        ],
      ];

      for (const [name, call] of operations) {
        let caught: unknown;
        try {
          await call();
        } catch (error) {
          caught = error;
        }
        expect(AppError.isAppError(caught)).toBe(true);
        const error = caught as AppError;
        expect(error.code).toBe(PalCertErrorCode.PAYMENTS_DISABLED);
        // 503, not 500: this is a deliberate statement about the installation,
        // not a fault. A client can tell the difference and so can a log.
        expect(error.httpStatus).toBe(503);
        expect(error.details).toMatchObject({ operation: name });
      }
    });

    it('reports capabilities honestly rather than claiming none exist', async () => {
      const provider = await resolveProvider(configuration({ enabled: false }));
      expect(provider.getCapabilities()).toMatchObject({
        provider: 'disabled',
        supportsHostedCheckout: false,
        supportsPartialRefunds: false,
        supportedCurrencies: [],
      });
    });

    it('does not take readiness down', async () => {
      // Disabling payments is a deployment decision, not an outage. If this
      // reported a failure the instance would leave the load balancer for a
      // feature it was deliberately configured without.
      const provider = await resolveProvider(configuration({ enabled: false }));
      await expect(provider.checkAvailability()).resolves.toMatchObject({ ok: true });
    });
  });
});
