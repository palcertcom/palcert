import {
  buildWebhookTestBody,
  canonicalWebhookBody,
  sha256Hex,
  webhookBodyHash,
  WebhookAttemptOutcome,
  WebhookDeliveryStatus,
  WebhookErrorCode,
  WEBHOOK_RETRY_DELAYS_MS,
} from '@palcert/contracts';

import {
  WebhookKeyUnavailableError,
  WebhookMaterialAuthenticationError,
} from '../../../common/crypto/webhook-keyring';
import { SafeWebhookHttpError } from '../http/safe-webhook-http-client';
import { WebhookDeliveryService } from './webhook-delivery.service';
import type { WebhookDeliveryRow } from './webhook-gateway.service';

/**
 * The seam the whole phase turns on: one receiver answer, one outbound call.
 *
 * A 503 is something a receiver said, not something PalCert failed at. If it
 * reached the queue's retry ladder — which exists for interruption and is
 * measured in seconds — a struggling receiver would be asked again several
 * times in a row before PalCert gave up on it entirely. So the assertions
 * below are deliberately about two things at once: what gets written, and that
 * exactly one request left the process.
 *
 * The e2e suite cannot cover this: the SSRF guard refuses every address a
 * sandbox can host, so no socket can be opened there. Here the client is a
 * stub, which is what makes the receiver's answer something a test can choose.
 */
describe('WebhookDeliveryService — the receiver ladder never becomes the queue ladder', () => {
  const NOW = new Date('2026-06-01T12:00:00.000Z');
  const URL_PLAINTEXT = 'https://receiver.example/hooks/palcert';
  const CONTROL_AT = new Date('2026-05-31T09:00:00.000Z');

  const testBody = canonicalWebhookBody(buildWebhookTestBody(CONTROL_AT));

  const delivery: WebhookDeliveryRow = {
    id: '11111111-1111-4111-8111-111111111111',
    webhook_event_id: null,
    endpoint_id: '22222222-2222-4222-8222-222222222222',
    endpoint_config_version_id: '33333333-3333-4333-8333-333333333333',
    organization_id: '44444444-4444-4444-8444-444444444444',
    kind: 'TEST',
    status: WebhookDeliveryStatus.PENDING,
    attempt_count: 0,
    next_attempt_at: null,
    replay_of_delivery_id: null,
    control_occurred_at: CONTROL_AT,
    body_sha256: webhookBodyHash(testBody),
    event_body_sha256: null,
    event_type: null,
    endpoint_status: 'ACTIVE',
    subscribed: false,
  };

  function build(
    overrides: {
      readonly delivery?: Partial<WebhookDeliveryRow>;
      readonly respond?: () => Promise<{ statusCode: number; retryAfter?: string }>;
      readonly gateway?: { openAttempts?: Array<Record<string, unknown>> };
    } = {},
  ) {
    const row = { ...delivery, ...overrides.delivery };
    const transitions: Array<Record<string, unknown>> = [];
    const closed: Array<Record<string, unknown>> = [];
    const finished: Array<Record<string, unknown>> = [];
    const begun: Array<Record<string, unknown>> = [];
    const send = jest.fn(
      overrides.respond ?? (() => Promise.resolve({ statusCode: 204, durationMs: 1 })),
    );

    const gateway = {
      readDelivery: jest.fn().mockResolvedValue(row),
      transitionDelivery: jest.fn(async (input: Record<string, unknown>) => {
        transitions.push(input);
      }),
      beginAttempt: jest.fn(async () => {
        begun.push({ attemptNumber: (overrides.delivery?.attempt_count ?? 0) + 1 });
        return {
          attemptId: '55555555-5555-4555-8555-555555555555',
          attemptNumber: (overrides.delivery?.attempt_count ?? 0) + 1,
        };
      }),
      openAttempts: jest.fn().mockResolvedValue(overrides.gateway?.openAttempts ?? []),
      readEvent: jest.fn().mockResolvedValue({
        id: '66666666-6666-4666-8666-666666666666',
        event_type: 'submission.approved',
        occurred_at: CONTROL_AT,
        data: {},
      }),
      closeAttempt: jest.fn(async (input: Record<string, unknown>) => {
        closed.push(input);
      }),
      finishAttempt: jest.fn(async (input: Record<string, unknown>) => {
        finished.push(input);
      }),
      configMaterial: jest.fn().mockResolvedValue({
        endpoint_id: row.endpoint_id,
        status: 'ACTIVE',
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
    };

    const crypto = {
      openUrl: jest.fn().mockReturnValue(URL_PLAINTEXT),
      openSigningSecret: jest.fn().mockReturnValue(Buffer.alloc(32, 7)),
      fingerprint: jest.fn().mockReturnValue('fp'),
    };

    const service = new WebhookDeliveryService(
      gateway as never,
      crypto as never,
      { assertBodyMatchesHash: jest.fn() } as never,
      { send } as never,
      { now: () => NOW } as never,
      { webhookAllowedPorts: [443], webhookOwnHosts: [] } as never,
      { setContext: jest.fn(), error: jest.fn(), warn: jest.fn(), info: jest.fn() } as never,
    );

    return { service, send, transitions, closed, finished, begun, gateway, crypto };
  }

  /** The retryable receiver answers, each of which the checkpoint names. */
  it.each([500, 503, 408, 425, 429])(
    'answers a %i with one request and a business retry, not a queue retry',
    async (statusCode) => {
      const { service, send, closed, finished } = build({
        respond: () => Promise.resolve({ statusCode }),
      });

      // Resolving rather than throwing *is* the property: a job that returns
      // normally is a job the queue will not re-run.
      const result = await service.attempt(delivery.id);
      expect(result).toMatchObject({ kind: 'RETRYABLE', httpStatus: statusCode });

      // One answer, one request. Nothing retried inside this call.
      expect(send).toHaveBeenCalledTimes(1);

      // One write, not two: the attempt's outcome and the delivery's next
      // business time are the same transaction, so no crash can leave the
      // answer durable and the delivery not knowing about it.
      expect(closed).toHaveLength(0);
      expect(finished).toHaveLength(1);
      expect(finished[0]).toMatchObject({
        outcome: WebhookAttemptOutcome.FAILED_RETRYABLE,
        errorCode: WebhookErrorCode.HTTP_RETRYABLE,
        httpStatus: statusCode,
        deliveryStatus: WebhookDeliveryStatus.FAILED_RETRYABLE,
      });
      // The first rung of the webhook ladder, a minute out — not seconds.
      expect((finished[0]!.nextAttemptAt as Date).getTime()).toBe(
        NOW.getTime() + WEBHOOK_RETRY_DELAYS_MS[0]!,
      );
    },
  );

  it('lets a receiver ask for longer, but never for sooner and never past a day', async () => {
    const { service, finished } = build({
      respond: () => Promise.resolve({ statusCode: 429, retryAfter: '3600' }),
    });
    await service.attempt(delivery.id);
    expect((finished.at(-1)!.nextAttemptAt as Date).getTime()).toBe(NOW.getTime() + 3_600_000);

    const tooSoon = build({
      respond: () => Promise.resolve({ statusCode: 503, retryAfter: '1' }),
    });
    await tooSoon.service.attempt(delivery.id);
    // Below the ladder's own rung, so the ladder wins.
    expect((tooSoon.finished.at(-1)!.nextAttemptAt as Date).getTime()).toBe(
      NOW.getTime() + WEBHOOK_RETRY_DELAYS_MS[0]!,
    );

    const tooLate = build({
      respond: () => Promise.resolve({ statusCode: 503, retryAfter: '999999' }),
    });
    await tooLate.service.attempt(delivery.id);
    expect((tooLate.finished.at(-1)!.nextAttemptAt as Date).getTime()).toBe(
      NOW.getTime() + 86_400_000,
    );
  });

  it('stops when the ladder runs out rather than retrying for ever', async () => {
    const { service, finished } = build({
      delivery: { attempt_count: WEBHOOK_RETRY_DELAYS_MS.length },
      respond: () => Promise.resolve({ statusCode: 503 }),
    });

    await service.attempt(delivery.id);
    // The attempt still records what the receiver said; the delivery records
    // that PalCert is done asking. Two facts, one transaction.
    expect(finished.at(-1)).toMatchObject({
      outcome: WebhookAttemptOutcome.FAILED_RETRYABLE,
      errorCode: WebhookErrorCode.HTTP_RETRYABLE,
      deliveryStatus: WebhookDeliveryStatus.FAILED_PERMANENT,
      nextAttemptAt: null,
    });
  });

  it('never asks again about a permanent answer', async () => {
    const { service, send, finished } = build({
      respond: () => Promise.resolve({ statusCode: 404 }),
    });

    const result = await service.attempt(delivery.id);
    expect(result).toMatchObject({ kind: 'PERMANENT' });
    expect(send).toHaveBeenCalledTimes(1);
    expect(finished.at(-1)).toMatchObject({
      outcome: WebhookAttemptOutcome.FAILED_PERMANENT,
      deliveryStatus: WebhookDeliveryStatus.FAILED_PERMANENT,
      nextAttemptAt: null,
    });
  });

  it('refuses to follow a redirect instead of treating it as an answer', async () => {
    const { service, finished } = build({
      respond: () => Promise.resolve({ statusCode: 302 }),
    });
    await service.attempt(delivery.id);
    expect(finished.at(-1)).toMatchObject({
      deliveryStatus: WebhookDeliveryStatus.FAILED_PERMANENT,
      errorCode: WebhookErrorCode.REDIRECT_REFUSED,
    });
  });

  it('records a delivered webhook and its attempt in one write', async () => {
    const { service, finished, transitions, begun } = build({
      respond: () => Promise.resolve({ statusCode: 200 }),
    });

    await service.attempt(delivery.id);
    expect(finished).toHaveLength(1);
    expect(finished[0]).toMatchObject({
      outcome: WebhookAttemptOutcome.SUCCEEDED,
      deliveryStatus: WebhookDeliveryStatus.DELIVERED,
      httpStatus: 200,
      errorCode: null,
      nextAttemptAt: null,
    });
    // No parent-only transition at all: starting and finishing are each one
    // write that moves the delivery and its attempt together.
    expect(transitions).toHaveLength(0);
    expect(begun).toHaveLength(1);
  });

  it('treats a transport refusal as a receiver answer, not an interruption', async () => {
    // The socket never got an answer, but the *attempt* still happened and it
    // is the receiver's side that was unreachable. Same ladder, same silence.
    const { service, finished } = build({
      respond: () =>
        Promise.reject(new SafeWebhookHttpError(WebhookErrorCode.CONNECT_TIMEOUT, 'timed out')),
    });

    const result = await service.attempt(delivery.id);
    expect(result).toMatchObject({
      kind: 'RETRYABLE',
      errorCode: WebhookErrorCode.CONNECT_TIMEOUT,
    });
    expect(finished.at(-1)).toMatchObject({
      outcome: WebhookAttemptOutcome.FAILED_RETRYABLE,
      deliveryStatus: WebhookDeliveryStatus.FAILED_RETRYABLE,
    });
  });

  describe('the ladder rung comes from the attempt, not the parent counter', () => {
    it('uses the first rung for the first attempt, whatever the parent has counted', async () => {
      // The defect this replaced: a crash between "mark SENDING and count it"
      // and "open the attempt" moved the counter without any attempt happening,
      // and the ladder was indexed by that counter. The number now comes back
      // from the doorway that created the attempt row.
      const { service, finished, gateway } = build({
        respond: () => Promise.resolve({ statusCode: 503 }),
      });
      gateway.beginAttempt.mockResolvedValueOnce({
        attemptId: '55555555-5555-4555-8555-555555555555',
        attemptNumber: 1,
      });

      await service.attempt(delivery.id);
      expect((finished.at(-1)!.nextAttemptAt as Date).getTime()).toBe(
        NOW.getTime() + WEBHOOK_RETRY_DELAYS_MS[0]!,
      );
    });

    it('uses the rung the attempt number names', async () => {
      const { service, finished, gateway } = build({
        respond: () => Promise.resolve({ statusCode: 503 }),
      });
      gateway.beginAttempt.mockResolvedValueOnce({
        attemptId: '55555555-5555-4555-8555-555555555555',
        attemptNumber: 3,
      });

      await service.attempt(delivery.id);
      expect((finished.at(-1)!.nextAttemptAt as Date).getTime()).toBe(
        NOW.getTime() + WEBHOOK_RETRY_DELAYS_MS[2]!,
      );
    });
  });

  describe('the crash window between an attempt and its delivery', () => {
    /**
     * The window this closes, and why it was the worst one.
     *
     * Two commits meant an instant where the receiver's answer was durable and
     * the delivery did not know it. A reclaiming worker read that as a delivery
     * stuck SENDING with no open attempt — an interrupted send — and asked the
     * receiver again. PalCert had the answer on disk and threw it away.
     *
     * There is now no such instant: one doorway closes the attempt and moves
     * the delivery together, and the database refuses to record a receiver
     * answer on an attempt any other way.
     */
    it('never leaves a finished attempt beside a delivery that does not know', async () => {
      const { service, finished, transitions } = build({
        respond: () => Promise.resolve({ statusCode: 503 }),
      });
      await service.attempt(delivery.id);

      // Nothing writes the attempt's outcome except the call that also writes
      // the delivery's, so there is no ordering in which one lands alone.
      expect(finished).toHaveLength(1);
      expect(finished[0]).toMatchObject({
        outcome: WebhookAttemptOutcome.FAILED_RETRYABLE,
        deliveryStatus: WebhookDeliveryStatus.FAILED_RETRYABLE,
      });
      // And no parent-only transition carries a receiver's answer.
      for (const transition of transitions) {
        expect(transition.httpStatus ?? null).toBeNull();
      }
    });

    it('sends nothing more when the answer landed and the response was lost', async () => {
      // The commit succeeded, then the process died before the job could
      // succeed. The queue redelivers; the reclaimed run reads a delivery that
      // already knows, and waits.
      const { service, send } = build({
        delivery: {
          status: WebhookDeliveryStatus.FAILED_RETRYABLE,
          attempt_count: 1,
          next_attempt_at: new Date(NOW.getTime() + WEBHOOK_RETRY_DELAYS_MS[0]!),
        },
      });

      expect(await service.attempt(delivery.id)).toMatchObject({ kind: 'WAITING' });
      expect(send).not.toHaveBeenCalled();
    });

    it('settles a delivered webhook the same way, with no second request', async () => {
      const { service, send } = build({
        delivery: { status: WebhookDeliveryStatus.DELIVERED },
      });
      expect(await service.attempt(delivery.id)).toMatchObject({ kind: 'ALREADY_SETTLED' });
      expect(send).not.toHaveBeenCalled();
    });

    it('falls back to the ambiguous-send path when the write never landed', async () => {
      // The other side of the boundary: the transaction did not commit, so the
      // attempt is still open and the delivery still SENDING. That genuinely is
      // an unknown outcome, and it is handled as one.
      const { service, send, closed, transitions } = build({
        delivery: { status: WebhookDeliveryStatus.SENDING, attempt_count: 1 },
        gateway: { openAttempts: [{ id: 'open-attempt', attempt_number: 1, outcome: null }] },
      });

      await service.attempt(delivery.id);

      expect(closed[0]).toMatchObject({
        attemptId: 'open-attempt',
        outcome: WebhookAttemptOutcome.FAILED_RETRYABLE,
        errorCode: WebhookErrorCode.WORKER_INTERRUPTED,
      });
      expect(transitions[0]).toMatchObject({
        status: WebhookDeliveryStatus.FAILED_RETRYABLE,
        errorCode: WebhookErrorCode.WORKER_INTERRUPTED,
      });
      // At-least-once, knowingly: the receiver may see this event twice.
      expect(send).toHaveBeenCalledTimes(1);
    });
  });

  it('does throw when PalCert itself could not carry the attempt out', async () => {
    // The other side of the line. Nothing was learned about the receiver, so
    // this is the queue's ladder — and the open attempt is closed first, so no
    // attempt row is left hanging.
    const { service, closed, transitions, begun } = build({
      respond: () => Promise.reject(new Error('the database went away')),
    });

    await expect(service.attempt(delivery.id)).rejects.toThrow('the database went away');
    expect(closed[0]).toMatchObject({
      outcome: WebhookAttemptOutcome.FAILED_RETRYABLE,
      errorCode: WebhookErrorCode.WORKER_INTERRUPTED,
    });
    // No business outcome was written: the attempt began, the delivery is still
    // SENDING where that begin left it, and the crash-recovery path owns it.
    expect(begun).toHaveLength(1);
    expect(transitions).toHaveLength(0);
  });

  it('re-checks the endpoint before every attempt, and sends nothing when it is paused', async () => {
    const { service, send, transitions } = build({ delivery: { endpoint_status: 'PAUSED' } });

    await service.attempt(delivery.id);
    expect(send).not.toHaveBeenCalled();
    expect(transitions.at(-1)).toMatchObject({ status: WebhookDeliveryStatus.SKIPPED });
  });

  describe('an early queue redelivery does not become an early request', () => {
    /**
     * The window this closes: the attempt ran, the 503 was written with a time
     * five minutes out, and the process died before the job could succeed. The
     * queue redelivers in seconds. Without the check below, the next thing that
     * happens is a second request to a receiver that just asked for time — the
     * queue's ladder driving outbound traffic, which is the one thing the whole
     * two-ladder design exists to prevent.
     */
    it('sends nothing while the delivery is still waiting for its business time', async () => {
      const { service, send, transitions } = build({
        delivery: {
          status: WebhookDeliveryStatus.FAILED_RETRYABLE,
          attempt_count: 1,
          next_attempt_at: new Date(NOW.getTime() + 5 * 60_000),
        },
      });

      const result = await service.attempt(delivery.id);

      expect(result).toMatchObject({ kind: 'WAITING' });
      // Zero network, zero attempt, zero mutation.
      expect(send).not.toHaveBeenCalled();
      expect(transitions).toHaveLength(0);
    });

    it('proceeds once that time has arrived', async () => {
      const { service, send } = build({
        delivery: {
          status: WebhookDeliveryStatus.FAILED_RETRYABLE,
          attempt_count: 1,
          next_attempt_at: new Date(NOW.getTime() - 1),
        },
      });

      await service.attempt(delivery.id);
      expect(send).toHaveBeenCalledTimes(1);
    });

    it('refuses to improvise a schedule for a row the database forbids', async () => {
      // FAILED_RETRYABLE with no next attempt time cannot exist — there is a
      // CHECK constraint saying so. If one appears anyway, PalCert does not
      // guess whether it is owed an attempt now or in twelve hours.
      const { service, send } = build({
        delivery: {
          status: WebhookDeliveryStatus.FAILED_RETRYABLE,
          attempt_count: 1,
          next_attempt_at: null,
        },
      });

      await expect(service.attempt(delivery.id)).rejects.toThrow(/no next attempt time/);
      expect(send).not.toHaveBeenCalled();
    });
  });

  describe('a delivery a dead worker left sending', () => {
    it('recovers on the first reclaim, without waiting for the queue to give up', async () => {
      const { service, send, transitions, closed } = build({
        delivery: { status: WebhookDeliveryStatus.SENDING, attempt_count: 1 },
      });

      const result = await service.attempt(delivery.id);

      // Crashed before the attempt row existed: nothing to close, and the
      // delivery is normalized and retried in this same run.
      expect(
        closed.filter((c) => c.errorCode === WebhookErrorCode.WORKER_INTERRUPTED),
      ).toHaveLength(0);
      expect(transitions[0]).toMatchObject({
        status: WebhookDeliveryStatus.FAILED_RETRYABLE,
        errorCode: WebhookErrorCode.WORKER_INTERRUPTED,
      });
      expect(send).toHaveBeenCalledTimes(1);
      expect(result).toMatchObject({ kind: 'DELIVERED' });
    });

    it('closes the attempt the dead worker left open, once', async () => {
      const { service, send, transitions, closed, gateway } = build({
        delivery: { status: WebhookDeliveryStatus.SENDING, attempt_count: 1 },
      });
      gateway.openAttempts.mockResolvedValueOnce([
        { id: 'open-attempt', attempt_number: 1, outcome: null },
      ]);

      await service.attempt(delivery.id);

      expect(closed[0]).toMatchObject({
        attemptId: 'open-attempt',
        outcome: WebhookAttemptOutcome.FAILED_RETRYABLE,
        errorCode: WebhookErrorCode.WORKER_INTERRUPTED,
      });
      expect(transitions[0]).toMatchObject({
        status: WebhookDeliveryStatus.FAILED_RETRYABLE,
        errorCode: WebhookErrorCode.WORKER_INTERRUPTED,
      });
      // And the run continues: a second request may reach a receiver that
      // already accepted the first. That is accepted at-least-once behaviour —
      // the envelope's id is stable across every retry, so a receiver that
      // deduplicates on it sees one event.
      expect(send).toHaveBeenCalledTimes(1);
    });
  });

  describe('PalCert failing is never an organization failing', () => {
    it('does not settle a delivery because a doorway raised', async () => {
      const { service, transitions, gateway } = build();
      gateway.configMaterial.mockRejectedValueOnce(new Error('connection terminated unexpectedly'));

      // Throws, so the queue's short ladder retries it. Nothing was written
      // against the endpoint.
      await expect(service.attempt(delivery.id)).rejects.toThrow('connection terminated');
      expect(transitions).toHaveLength(0);
    });

    it('does not settle a delivery because the event could not be read', async () => {
      const { service, transitions, gateway } = build({
        delivery: {
          kind: 'ORIGINAL',
          subscribed: true,
          webhook_event_id: '66666666-6666-4666-8666-666666666666',
          event_type: 'submission.approved',
          control_occurred_at: null,
          body_sha256: null,
        },
      });
      gateway.readEvent.mockRejectedValueOnce(new Error('the database went away'));

      await expect(service.attempt(delivery.id)).rejects.toThrow('the database went away');
      expect(transitions).toHaveLength(0);
    });

    it('does not settle a delivery because this process is missing a key', async () => {
      // A deployment that shipped without a key is not evidence that somebody's
      // receiver is broken. The delivery waits for a process that has the key.
      const { service, transitions, crypto } = build();
      crypto.openUrl.mockImplementationOnce(() => {
        throw new WebhookKeyUnavailableError('k9');
      });

      await expect(service.attempt(delivery.id)).rejects.toThrow(WebhookKeyUnavailableError);
      expect(transitions).toHaveLength(0);
    });

    it('does settle a delivery whose stored material will not authenticate', async () => {
      // The other side of the same line: a row that no longer describes itself.
      // Asking again in twelve hours cannot change it.
      const { service, transitions, crypto } = build();
      crypto.openUrl.mockImplementationOnce(() => {
        throw new WebhookMaterialAuthenticationError('k1');
      });

      const result = await service.attempt(delivery.id);
      expect(result).toMatchObject({
        kind: 'PERMANENT',
        errorCode: WebhookErrorCode.CONFIG_INTEGRITY_MISMATCH,
      });
      expect(transitions.at(-1)).toMatchObject({
        status: WebhookDeliveryStatus.FAILED_PERMANENT,
        errorCode: WebhookErrorCode.CONFIG_INTEGRITY_MISMATCH,
      });
    });
  });
});
