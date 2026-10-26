import { sha256Hex, WebhookAttemptOutcome, WebhookErrorCode } from '@palcert/contracts';

import { WebhookKeyUnavailableError } from '../../../common/crypto/webhook-keyring';
import { SafeWebhookHttpError } from '../http/safe-webhook-http-client';
import { WebhookVerificationService } from './webhook-verification.service';

/**
 * What a verification puts on the wire, and what it does with the answer.
 *
 * Two properties this suite exists for. The wire identity of a verification is
 * the *verification attempt*, so two handshakes against one configuration can
 * never be byte-identical — a receiver can tell a fresh challenge from a
 * replayed one, and PalCert's log can say which attempt a receiver saw. And a
 * receiver's HTTP answer settles the administrator's intent rather than
 * entering the queue's short ladder, because a 503 to a handshake is still
 * something a receiver said.
 */
describe('WebhookVerificationService', () => {
  const NOW = new Date('2026-06-01T12:00:00.000Z');
  const URL_PLAINTEXT = 'https://receiver.example/hooks/palcert';
  const OPERATION_ID = '11111111-1111-4111-8111-111111111111';
  const ENDPOINT_ID = '22222222-2222-4222-8222-222222222222';
  const CONFIG_ID = '33333333-3333-4333-8333-333333333333';

  function build(
    overrides: {
      readonly operation?: Record<string, unknown>;
      readonly respond?: (challenge: string) => Promise<{
        statusCode: number;
        challengeEcho?: string;
      }>;
      readonly attempts?: Array<Record<string, unknown>>;
    } = {},
  ) {
    const operation = {
      id: OPERATION_ID,
      organization_id: '44444444-4444-4444-8444-444444444444',
      endpoint_id: ENDPOINT_ID,
      config_version_id: CONFIG_ID,
      settled_at: null,
      config_status: 'PENDING',
      endpoint_status: 'PENDING_VERIFICATION',
      pending_config_version_id: CONFIG_ID,
      succeeded_attempt_id: null,
      attempt_count: 0n,
      ...overrides.operation,
    };

    const attemptIds = ['attempt-one', 'attempt-two', 'attempt-three'];
    let opened = 0;
    let challenge = '';

    const requests: Array<Record<string, unknown>> = [];
    const send = jest.fn(async (request: Record<string, unknown>) => {
      requests.push(request);
      const responder = overrides.respond ?? (async () => ({ statusCode: 200 }));
      const response = await responder(challenge);
      return { ...response, durationMs: 1 };
    });

    const gateway = {
      readVerificationOperation: jest.fn().mockResolvedValue(operation),
      configMaterial: jest.fn().mockResolvedValue({
        endpoint_id: ENDPOINT_ID,
        status: 'PENDING',
        url_ciphertext: 'c',
        url_iv: 'i',
        url_auth_tag: 't',
        url_encryption_key_id: 'k1',
        url_sha256: sha256Hex(URL_PLAINTEXT),
        host: 'receiver.example',
        port: 443,
        secret_ciphertext: 'c',
        secret_iv: 'i',
        secret_auth_tag: 't',
        secret_encryption_key_id: 'k1',
        secret_fingerprint: 'fp',
      }),
      openVerificationAttempt: jest.fn(async () => attemptIds[opened++]!),
      closeVerificationAttempt: jest.fn(),
      settleVerificationResponse: jest.fn(),
      verificationAttempts: jest.fn().mockResolvedValue(overrides.attempts ?? []),
      recordVerificationRefusal: jest.fn(),
      settleOperation: jest.fn(),
      activateConfig: jest.fn(),
    };

    const crypto = {
      openUrl: jest.fn().mockReturnValue(URL_PLAINTEXT),
      openSigningSecret: jest.fn().mockReturnValue(Buffer.alloc(32, 7)),
      fingerprint: jest.fn().mockReturnValue('fp'),
      newChallenge: jest.fn(() => {
        challenge = `challenge-${opened}`;
        return challenge;
      }),
    };

    const service = new WebhookVerificationService(
      gateway as never,
      crypto as never,
      { send } as never,
      { now: () => NOW } as never,
      { webhookAllowedPorts: [443], webhookOwnHosts: [] } as never,
      { setContext: jest.fn(), error: jest.fn(), warn: jest.fn(), info: jest.fn() } as never,
    );

    return { service, gateway, crypto, send, requests };
  }

  describe('wire identity', () => {
    it('signs and addresses each request with its own verification attempt', async () => {
      const { service, gateway, requests } = build({
        respond: async () => ({ statusCode: 500 }),
      });

      await service.verify(OPERATION_ID);
      // A settled operation would refuse a second run, so the second handshake
      // is the ordinary administrator retry: a new operation, same config.
      gateway.openVerificationAttempt.mockClear();
      await service.verify(OPERATION_ID);

      expect(requests).toHaveLength(2);
      expect(requests[0]!.deliveryIdHeader).toBe('attempt-one');
      expect(requests[1]!.deliveryIdHeader).toBe('attempt-two');
      expect(requests[0]!.deliveryIdHeader).not.toBe(requests[1]!.deliveryIdHeader);
      // Neither the configuration id nor anything else stable is on the wire.
      expect(requests[0]!.deliveryIdHeader).not.toBe(CONFIG_ID);
      // A different id means a different signature over the same body.
      expect(requests[0]!.signature).not.toEqual(requests[1]!.signature);
      expect(requests[0]!.eventTypeHeader).toBe('webhook.endpoint_verification');
      expect(requests[0]!.eventIdHeader).toBeUndefined();
    });

    it('accepts only the challenge it generated for this attempt', async () => {
      const { service, gateway } = build({
        respond: async (challenge) => ({ statusCode: 200, challengeEcho: challenge }),
      });
      await expect(service.verify(OPERATION_ID)).resolves.toMatchObject({ kind: 'VERIFIED' });
      expect(gateway.activateConfig).toHaveBeenCalledWith('attempt-one');

      const stale = build({
        respond: async () => ({ statusCode: 200, challengeEcho: 'challenge-0' }),
      });
      await expect(stale.service.verify(OPERATION_ID)).resolves.toMatchObject({
        kind: 'SETTLED',
        errorCode: WebhookErrorCode.CHALLENGE_MISMATCH,
      });
      expect(stale.gateway.activateConfig).not.toHaveBeenCalled();
      expect(stale.gateway.settleVerificationResponse).toHaveBeenCalledWith(
        expect.objectContaining({
          outcome: WebhookAttemptOutcome.FAILED_PERMANENT,
          errorCode: WebhookErrorCode.CHALLENGE_MISMATCH,
        }),
      );
    });
  });

  describe('a receiver that answered stays out of the queue', () => {
    it.each([408, 425, 429, 500, 503])(
      'settles the intent on a %i rather than requeueing the job',
      async (statusCode) => {
        const { service, gateway, send } = build({
          respond: async () => ({ statusCode }),
        });

        // Resolving is the property: a thrown error here would put a receiver's
        // answer on the queue's short ladder, which asks again within seconds.
        const result = await service.verify(OPERATION_ID);
        expect(result).toMatchObject({
          kind: 'SETTLED',
          errorCode: WebhookErrorCode.HTTP_RETRYABLE,
        });
        expect(send).toHaveBeenCalledTimes(1);
        // One transaction: the attempt's answer and the intent's settlement
        // cannot be separated by a crash.
        expect(gateway.settleVerificationResponse).toHaveBeenCalledWith(
          expect.objectContaining({
            attemptId: 'attempt-one',
            outcome: WebhookAttemptOutcome.FAILED_RETRYABLE,
            errorCode: WebhookErrorCode.HTTP_RETRYABLE,
            httpStatus: statusCode,
          }),
        );
        // And nothing settled the intent on its own.
        expect(gateway.settleOperation).not.toHaveBeenCalled();
        expect(gateway.closeVerificationAttempt).not.toHaveBeenCalled();
      },
    );
  });

  describe('refusals before the wire', () => {
    it('makes no network request and no attempt for a disabled endpoint', async () => {
      const { service, gateway, send } = build({
        operation: { endpoint_status: 'DISABLED' },
      });

      const result = await service.verify(OPERATION_ID);

      expect(result).toMatchObject({
        kind: 'SETTLED',
        errorCode: WebhookErrorCode.ENDPOINT_DISABLED,
      });
      expect(send).not.toHaveBeenCalled();
      expect(gateway.openVerificationAttempt).not.toHaveBeenCalled();
      expect(gateway.activateConfig).not.toHaveBeenCalled();
    });

    it('lets a paused endpoint prove itself', async () => {
      // Paused is not disabled: the configuration may still be verified, and
      // activation leaves the endpoint paused — which is the lifecycle's job,
      // not this service's.
      const { service, gateway, send } = build({
        operation: { endpoint_status: 'PAUSED' },
        respond: async (challenge) => ({ statusCode: 200, challengeEcho: challenge }),
      });

      await expect(service.verify(OPERATION_ID)).resolves.toMatchObject({ kind: 'VERIFIED' });
      expect(send).toHaveBeenCalledTimes(1);
      expect(gateway.activateConfig).toHaveBeenCalledWith('attempt-one');
    });

    it('never manufactures a wire attempt for a configuration it refused', async () => {
      const { service, gateway, send } = build();
      gateway.configMaterial.mockResolvedValueOnce({
        endpoint_id: ENDPOINT_ID,
        status: 'PENDING',
        url_ciphertext: 'c',
        url_iv: 'i',
        url_auth_tag: 't',
        url_encryption_key_id: 'k1',
        // No longer describes the URL it is stored with.
        url_sha256: sha256Hex('https://somewhere.else.example/hook'),
        host: 'receiver.example',
        port: 443,
        secret_ciphertext: 'c',
        secret_iv: 'i',
        secret_auth_tag: 't',
        secret_encryption_key_id: 'k1',
        secret_fingerprint: 'fp',
      });

      const result = await service.verify(OPERATION_ID);

      expect(result).toMatchObject({
        kind: 'SETTLED',
        errorCode: WebhookErrorCode.CONFIG_INTEGRITY_MISMATCH,
      });
      expect(send).not.toHaveBeenCalled();
      // The configuration's history still records it; the wire log does not.
      expect(gateway.openVerificationAttempt).not.toHaveBeenCalled();
      expect(gateway.recordVerificationRefusal).toHaveBeenCalledWith(
        OPERATION_ID,
        WebhookErrorCode.CONFIG_INTEGRITY_MISMATCH,
      );
    });

    it('does not settle anything because this process is missing a key', async () => {
      const { service, gateway, crypto } = build();
      crypto.openUrl.mockImplementationOnce(() => {
        throw new WebhookKeyUnavailableError('k9');
      });

      await expect(service.verify(OPERATION_ID)).rejects.toThrow(WebhookKeyUnavailableError);
      expect(gateway.settleOperation).not.toHaveBeenCalled();
      expect(gateway.recordVerificationRefusal).not.toHaveBeenCalled();
    });
  });

  describe('resuming from proof', () => {
    it('activates from a successful attempt without asking again', async () => {
      const { service, gateway, send } = build({
        operation: { succeeded_attempt_id: 'attempt-from-before' },
      });

      await expect(service.resume(OPERATION_ID)).resolves.toMatchObject({ kind: 'RESUMED' });
      expect(send).not.toHaveBeenCalled();
      expect(gateway.activateConfig).toHaveBeenCalledWith('attempt-from-before');
      expect(gateway.settleOperation).toHaveBeenCalledWith(OPERATION_ID, null);
    });

    it('refuses to resume an operation that never succeeded', async () => {
      const { service } = build();
      await expect(service.resume(OPERATION_ID)).rejects.toThrow(/no successful attempt/);
    });
  });

  describe('the crash window between an answer and its settlement', () => {
    it.each([
      ['a permanent status', 404, WebhookErrorCode.HTTP_PERMANENT],
      ['a retryable status', 503, WebhookErrorCode.HTTP_RETRYABLE],
    ])(
      'settles %s atomically, so a redelivery finds nothing to do',
      async (_label, status, code) => {
        const { service, gateway } = build({ respond: async () => ({ statusCode: status }) });
        await service.verify(OPERATION_ID);

        expect(gateway.settleVerificationResponse).toHaveBeenCalledTimes(1);
        expect(gateway.settleVerificationResponse).toHaveBeenCalledWith(
          expect.objectContaining({ errorCode: code, httpStatus: status }),
        );

        // The redelivery after the lost response: the operation is settled, so
        // the run stops before anything is opened or sent.
        const after = build({ operation: { settled_at: new Date() } });
        await expect(after.service.verify(OPERATION_ID)).resolves.toMatchObject({
          kind: 'ALREADY_SETTLED',
        });
        expect(after.send).not.toHaveBeenCalled();
        expect(after.gateway.openVerificationAttempt).not.toHaveBeenCalled();
      },
    );

    it('leaves the intent open when nothing was heard at all', async () => {
      // A transport failure is not an answer. The attempt closes alone — which
      // is exactly what the close doorway is still allowed to do — and the same
      // job may try again on the queue's ladder.
      const { service, gateway } = build({
        respond: async () => {
          throw new SafeWebhookHttpError(WebhookErrorCode.CONNECT_TIMEOUT, 'timed out');
        },
      });

      await expect(service.verify(OPERATION_ID)).rejects.toThrow(/transport failure/);
      expect(gateway.closeVerificationAttempt).toHaveBeenCalledWith(
        expect.objectContaining({
          outcome: WebhookAttemptOutcome.FAILED_RETRYABLE,
          errorCode: WebhookErrorCode.CONNECT_TIMEOUT,
        }),
      );
      expect(gateway.settleVerificationResponse).not.toHaveBeenCalled();
      expect(gateway.settleOperation).not.toHaveBeenCalled();
    });
  });

  describe('first reclaim', () => {
    it('closes an attempt the dead worker left open and opens a fresh one', async () => {
      // Not at the dead-job path: this worker holds the reclaimed lease, so the
      // previous one is gone. The retry gets a new id and a new challenge, so a
      // receiver that saw both can tell them apart.
      const { service, gateway, crypto, requests } = build({
        attempts: [{ id: 'attempt-from-dead-worker', attempt_number: 1, outcome: null }],
        respond: async (challenge) => ({ statusCode: 200, challengeEcho: challenge }),
      });

      await expect(service.verify(OPERATION_ID)).resolves.toMatchObject({ kind: 'VERIFIED' });

      expect(gateway.closeVerificationAttempt).toHaveBeenCalledWith(
        expect.objectContaining({
          attemptId: 'attempt-from-dead-worker',
          outcome: WebhookAttemptOutcome.FAILED_RETRYABLE,
          errorCode: WebhookErrorCode.WORKER_INTERRUPTED,
        }),
      );
      expect(requests).toHaveLength(1);
      expect(requests[0]!.deliveryIdHeader).toBe('attempt-one');
      expect(requests[0]!.deliveryIdHeader).not.toBe('attempt-from-dead-worker');
      expect(crypto.newChallenge).toHaveBeenCalledTimes(1);
    });

    it('leaves a closed attempt alone', async () => {
      const { service, gateway } = build({
        attempts: [{ id: 'attempt-from-before', attempt_number: 1, outcome: 'FAILED_RETRYABLE' }],
        respond: async () => ({ statusCode: 500 }),
      });

      await service.verify(OPERATION_ID);
      expect(gateway.closeVerificationAttempt).not.toHaveBeenCalled();
    });
  });
});
