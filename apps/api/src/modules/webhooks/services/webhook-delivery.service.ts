import { Injectable } from '@nestjs/common';
import {
  buildWebhookTestBody,
  canonicalWebhookBody,
  classifyWebhookHttpStatus,
  isWebhookEventType,
  nextWebhookRetryDelayMs,
  parseRetryAfterMs,
  sha256Hex,
  validateWebhookUrl,
  webhookBodyHash,
  WebhookAttemptOutcome,
  WebhookDeliveryStatus,
  WebhookErrorCode,
  WebhookSkipReason,
  WEBHOOK_TEST_TYPE,
} from '@palcert/contracts';
import { PinoLogger } from 'nestjs-pino';

import { ApiConfigService } from '../../../config/api-config.service';
import { ClockPort } from '../../auth/ports/clock.port';
import { WebhookMaterialAuthenticationError } from '../../../common/crypto/webhook-keyring';
import { SafeWebhookHttpClient, SafeWebhookHttpError } from '../http/safe-webhook-http-client';
import { signWebhookRequest } from '../http/webhook-signature';
import { WebhookCryptoService } from './webhook-crypto.service';
import { WebhookFanoutService } from './webhook-fanout.service';
import {
  WebhookGatewayService,
  type WebhookConfigMaterialRow,
  type WebhookDeliveryRow,
} from './webhook-gateway.service';

/**
 * One attempt to deliver one webhook.
 *
 * The single most important thing about this class is what it does *not* do:
 * it never throws because of what a receiver said. A 503 is an answer, not an
 * error in PalCert — the attempt happened, it is recorded, and the delivery is
 * owed another try in five minutes. Throwing would hand that to the queue's
 * retry ladder, which is short and fast by design, and PalCert would hammer a
 * struggling receiver several times a second before giving up on it entirely.
 *
 * So there are two ladders and they answer different questions:
 *
 *   queue ladder    — did this *process* manage to run the attempt?
 *                     Interruption, a dead database, a lost lease. Short.
 *   webhook ladder  — is the *receiver* ready yet?
 *                     1m, 5m, 30m, 2h, 12h, 24h, then done. Long, and it must
 *                     not occupy a queue slot for a day while it waits.
 *
 * A receiver result therefore always ends with the job succeeding and the
 * delivery carrying its own `nextAttemptAt`; the sweeper re-arms it when that
 * time comes. Only an infrastructure fault throws.
 */
@Injectable()
export class WebhookDeliveryService {
  constructor(
    private readonly gateway: WebhookGatewayService,
    private readonly crypto: WebhookCryptoService,
    private readonly fanout: WebhookFanoutService,
    private readonly http: SafeWebhookHttpClient,
    private readonly clock: ClockPort,
    private readonly config: ApiConfigService,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext(WebhookDeliveryService.name);
  }

  /**
   * Run one business attempt.
   *
   * Returns the outcome so the worker can log it. Never throws for anything a
   * receiver did; throws only when PalCert itself could not carry the attempt
   * out, which is what the queue ladder is for.
   */
  async attempt(deliveryId: string): Promise<DeliveryOutcome> {
    let delivery = await this.gateway.readDelivery(deliveryId);
    if (delivery === null) {
      // Nothing to do, and nothing to retry: a job for a delivery that does
      // not exist is a job that has already been superseded.
      return { kind: 'GONE' };
    }

    if (isTerminal(delivery.status)) {
      // A redelivered job for a settled delivery. Ordinary, and silent.
      return { kind: 'ALREADY_SETTLED', status: delivery.status };
    }

    // A worker died mid-attempt and this job has been reclaimed. The lease is
    // this process's now, so the previous one is gone and there is nobody to
    // wait for. Recovery happens here, on the first reclaim, rather than after
    // the queue has spent the whole attempt budget discovering the same thing.
    const recovered =
      delivery.status === WebhookDeliveryStatus.SENDING
        ? await this.recoverInterrupted(delivery)
        : delivery;

    // The business ladder, enforced against the queue's.
    //
    // This is the window the whole design would otherwise leave open: the
    // attempt ran, the 503 was persisted with a time five minutes out, and
    // then the process died before the job could succeed. The queue redelivers
    // within seconds, and without this the next thing that happens is another
    // request to a receiver that just asked for time.
    if (recovered.status === WebhookDeliveryStatus.FAILED_RETRYABLE) {
      if (recovered.next_attempt_at === null) {
        // The database forbids this row. If one exists anyway, PalCert does not
        // improvise a schedule for it.
        throw new Error(`webhook delivery ${deliveryId} is retryable with no next attempt time`);
      }
      if (recovered.next_attempt_at.getTime() > this.clock.now().getTime()) {
        // Zero network, zero attempt, zero mutation. The job succeeds and the
        // sweeper re-arms it when the delivery's own time arrives.
        return { kind: 'WAITING', nextAttemptAt: recovered.next_attempt_at };
      }
    }

    delivery = recovered;
    const skip = this.preflightSkip(delivery);
    if (skip !== null) {
      await this.gateway.transitionDelivery({
        deliveryId,
        status: WebhookDeliveryStatus.SKIPPED,
        skipReason: skip,
      });
      return { kind: 'SKIPPED', reason: skip };
    }

    // Integrity is checked before anything is sent, and a failure here is
    // permanent with zero network: a configuration whose stored metadata no
    // longer describes its ciphertext is not something to retry against.
    let prepared: PreparedRequest;
    try {
      prepared = await this.prepare(delivery);
    } catch (error) {
      // Only a deterministic fact about the *configuration* settles a delivery
      // permanently. A database that was unreachable for a moment, a doorway
      // that raised, a key this deployment is missing — none of those are
      // evidence that an organization's receiver is broken, and settling on
      // their behalf would quietly cancel a webhook because PalCert had a bad
      // minute. Everything else throws and takes the queue's short ladder.
      if (!(error instanceof IntegrityError)) throw error;

      await this.gateway.transitionDelivery({
        deliveryId,
        status: WebhookDeliveryStatus.FAILED_PERMANENT,
        errorCode: error.code,
      });
      this.logger.error(
        { deliveryId, errorCode: error.code },
        'webhook delivery refused before any network attempt',
      );
      return { kind: 'PERMANENT', errorCode: error.code };
    }

    // One write: the delivery becomes SENDING, the attempt is counted, and the
    // attempt row it counts is inserted. Splitting those was how an
    // infrastructure crash could spend a rung of an organization's retry ladder
    // without any request ever leaving the process.
    const begun = await this.gateway.beginAttempt(deliveryId, this.clock.now());
    const attemptId = begun.attemptId;
    const startedAt = Date.now();

    let response: Awaited<ReturnType<SafeWebhookHttpClient['send']>> | null = null;
    let transport: SafeWebhookHttpError | null = null;
    try {
      response = await this.http.send(prepared.request);
    } catch (error) {
      if (error instanceof SafeWebhookHttpError) {
        transport = error;
      } else {
        // Not a receiver answer and not a transport refusal: PalCert failed to
        // carry the attempt out. Close the attempt so nothing is left open,
        // then let it reach the queue ladder.
        await this.gateway.closeAttempt({
          attemptId,
          outcome: WebhookAttemptOutcome.FAILED_RETRYABLE,
          errorCode: WebhookErrorCode.WORKER_INTERRUPTED,
          durationMs: Date.now() - startedAt,
        });
        throw error;
      }
    }

    const durationMs = Date.now() - startedAt;
    const verdict = this.classify(delivery, response, transport);
    const settlement = this.settle(begun.attemptNumber, verdict, response?.retryAfter);

    // One write. The attempt row and the delivery it belongs to move together,
    // so there is no instant at which PalCert holds a receiver's answer on disk
    // and a delivery that does not know about it — which is the state a
    // reclaiming worker would have read as an interrupted send and answered
    // with another request.
    await this.gateway.finishAttempt({
      attemptId,
      outcome: verdict.outcome,
      errorCode: verdict.errorCode,
      httpStatus: verdict.httpStatus,
      durationMs,
      deliveryStatus: settlement.deliveryStatus,
      nextAttemptAt: settlement.nextAttemptAt,
    });

    return { ...verdict.result, eventType: delivery.event_type };
  }

  /**
   * Bring a delivery a dead worker left mid-flight back into a legal state.
   *
   * Two crashes look identical from here and both are handled the same way:
   * one that happened after SENDING but before the attempt row was opened,
   * and one that happened after the request may already have reached the
   * receiver. The second means a retry can deliver the same event twice, which
   * is accepted at-least-once behaviour — the envelope's `id` is the
   * `WebhookEvent`'s and is stable across every retry and replay, so a receiver
   * that deduplicates on it sees one event.
   *
   * The delivery lands FAILED_RETRYABLE with a time already past, because this
   * was PalCert's interruption and not a receiver asking to be left alone. So
   * the wait check above lets it straight through and this attempt proceeds.
   */
  private async recoverInterrupted(delivery: WebhookDeliveryRow): Promise<WebhookDeliveryRow> {
    const attempts = await this.gateway.openAttempts(delivery.id);
    const open = attempts.find((attempt) => attempt.outcome === null);
    if (open !== undefined) {
      await this.gateway.closeAttempt({
        attemptId: open.id,
        outcome: WebhookAttemptOutcome.FAILED_RETRYABLE,
        errorCode: WebhookErrorCode.WORKER_INTERRUPTED,
      });
    }

    await this.gateway.transitionDelivery({
      deliveryId: delivery.id,
      status: WebhookDeliveryStatus.FAILED_RETRYABLE,
      errorCode: WebhookErrorCode.WORKER_INTERRUPTED,
      nextAttemptAt: this.clock.now(),
    });

    this.logger.warn(
      { deliveryId: delivery.id, closedAttempt: open?.id ?? null },
      'recovered a webhook delivery an interrupted worker left sending',
    );

    return {
      ...delivery,
      status: WebhookDeliveryStatus.FAILED_RETRYABLE,
      next_attempt_at: this.clock.now(),
    };
  }

  /**
   * Re-checked before *every* attempt, not once at fan-out.
   *
   * An organization that unsubscribes or pauses between the first attempt and
   * the fourth has said something, and the fourth attempt is where it takes
   * effect. A TEST delivery ignores subscriptions — nobody subscribes to a
   * test — but still requires an active endpoint.
   */
  private preflightSkip(delivery: WebhookDeliveryRow): WebhookSkipReason | null {
    if (delivery.endpoint_status !== 'ACTIVE') {
      return WebhookSkipReason.ENDPOINT_INACTIVE;
    }
    if (delivery.kind !== 'TEST' && !delivery.subscribed) {
      return WebhookSkipReason.UNSUBSCRIBED;
    }
    return null;
  }

  /**
   * Decrypt, re-derive, compare, rebuild, hash, sign.
   *
   * Every one of those verbs is a separate opportunity for a stored row to
   * disagree with itself, and each disagreement is caught here rather than
   * being sent to a receiver that would have no way to notice.
   */
  private async prepare(delivery: WebhookDeliveryRow): Promise<PreparedRequest> {
    const material = await this.gateway.configMaterial(delivery.endpoint_config_version_id);
    if (material === null) {
      throw new IntegrityError(WebhookErrorCode.CONFIG_INTEGRITY_MISMATCH);
    }

    const url = openOrClassify(() =>
      this.crypto.openUrl(
        {
          kid: material.url_encryption_key_id,
          ciphertext: material.url_ciphertext,
          iv: material.url_iv,
          authTag: material.url_auth_tag,
        },
        delivery.endpoint_id,
        delivery.endpoint_config_version_id,
      ),
    );

    this.assertConfigIntegrity(url, material);

    const secret = openOrClassify(() =>
      this.crypto.openSigningSecret(
        {
          kid: material.secret_encryption_key_id,
          ciphertext: material.secret_ciphertext,
          iv: material.secret_iv,
          authTag: material.secret_auth_tag,
        },
        delivery.endpoint_id,
        delivery.endpoint_config_version_id,
      ),
    );

    if (this.crypto.fingerprint(secret) !== material.secret_fingerprint) {
      throw new IntegrityError(WebhookErrorCode.CONFIG_INTEGRITY_MISMATCH);
    }

    const body = await this.canonicalBody(delivery);
    const bytes = Buffer.from(body, 'utf8');
    const timestamp = Math.floor(this.clock.now().getTime() / 1000);
    const signature = signWebhookRequest(secret, timestamp, delivery.id, bytes);

    const parsed = new URL(url);
    return {
      request: {
        host: parsed.hostname,
        port: parsed.port === '' ? 443 : Number(parsed.port),
        path: parsed.pathname,
        body: bytes,
        signature,
        eventTypeHeader: delivery.kind === 'TEST' ? WEBHOOK_TEST_TYPE : (delivery.event_type ?? ''),
        deliveryIdHeader: delivery.id,
        // A control message projects no event, so sending an id that referred
        // to nothing would invite a receiver to record it as one.
        ...(delivery.kind === 'TEST'
          ? {}
          : { eventIdHeader: delivery.webhook_event_id ?? undefined }),
      },
    };
  }

  /** The stored metadata must still describe the decrypted URL. */
  private assertConfigIntegrity(url: string, material: WebhookConfigMaterialRow): void {
    if (sha256Hex(url) !== material.url_sha256) {
      throw new IntegrityError(WebhookErrorCode.CONFIG_INTEGRITY_MISMATCH);
    }

    const verdict = validateWebhookUrl(url, {
      allowedPorts: this.config.webhookAllowedPorts,
      ownHosts: this.config.webhookOwnHosts,
    });
    if (!verdict.ok) {
      // The policy changed under a configuration that was legal when saved, or
      // the ciphertext was edited. Either way PalCert does not send.
      throw new IntegrityError(WebhookErrorCode.URL_POLICY_VIOLATION);
    }
    if (verdict.value.host !== material.host || verdict.value.port !== material.port) {
      throw new IntegrityError(WebhookErrorCode.CONFIG_INTEGRITY_MISMATCH);
    }
  }

  /**
   * The exact bytes, rebuilt and re-verified.
   *
   * A TEST body comes from the delivery's own immutable `controlOccurredAt`,
   * so every retry reproduces it; a business body comes from the event and is
   * checked against the hash stored when it was projected.
   */
  private async canonicalBody(delivery: WebhookDeliveryRow): Promise<string> {
    if (delivery.kind === 'TEST') {
      if (delivery.control_occurred_at === null || delivery.body_sha256 === null) {
        throw new IntegrityError(WebhookErrorCode.CONFIG_INTEGRITY_MISMATCH);
      }
      const body = canonicalWebhookBody(
        buildWebhookTestBody(new Date(delivery.control_occurred_at)),
      );
      if (webhookBodyHash(body) !== delivery.body_sha256) {
        throw new IntegrityError(WebhookErrorCode.CONFIG_INTEGRITY_MISMATCH);
      }
      return body;
    }

    if (delivery.webhook_event_id === null || delivery.event_type === null) {
      throw new IntegrityError(WebhookErrorCode.CONFIG_INTEGRITY_MISMATCH);
    }
    if (!isWebhookEventType(delivery.event_type)) {
      throw new IntegrityError(WebhookErrorCode.CONFIG_INTEGRITY_MISMATCH);
    }

    const event = await this.gateway.readEvent(delivery.webhook_event_id);
    if (event === null) {
      throw new IntegrityError(WebhookErrorCode.CONFIG_INTEGRITY_MISMATCH);
    }

    try {
      return this.fanout.assertBodyMatchesHash(event.id, event);
    } catch {
      throw new IntegrityError(WebhookErrorCode.CONFIG_INTEGRITY_MISMATCH);
    }
  }

  private classify(
    delivery: WebhookDeliveryRow,
    response: { statusCode: number; challengeEcho?: string } | null,
    transport: SafeWebhookHttpError | null,
  ): Verdict {
    if (transport !== null) {
      const retryable = RETRYABLE_TRANSPORT.has(transport.code);
      return {
        outcome: retryable
          ? WebhookAttemptOutcome.FAILED_RETRYABLE
          : WebhookAttemptOutcome.FAILED_PERMANENT,
        errorCode: transport.code,
        httpStatus: null,
        result: retryable
          ? { kind: 'RETRYABLE', errorCode: transport.code }
          : { kind: 'PERMANENT', errorCode: transport.code },
      };
    }

    const status = response!.statusCode;
    const classified = classifyWebhookHttpStatus(status);

    if (classified === 'SUCCESS') {
      return {
        outcome: WebhookAttemptOutcome.SUCCEEDED,
        errorCode: null,
        httpStatus: status,
        result: { kind: 'DELIVERED', httpStatus: status },
      };
    }

    // A 3xx is refused rather than followed: PalCert does not accept a new
    // destination from the answer to a request it already validated.
    const code =
      status >= 300 && status < 400
        ? WebhookErrorCode.REDIRECT_REFUSED
        : status === 410
          ? WebhookErrorCode.ENDPOINT_GONE
          : classified === 'RETRYABLE'
            ? WebhookErrorCode.HTTP_RETRYABLE
            : WebhookErrorCode.HTTP_PERMANENT;

    return {
      outcome:
        classified === 'RETRYABLE'
          ? WebhookAttemptOutcome.FAILED_RETRYABLE
          : WebhookAttemptOutcome.FAILED_PERMANENT,
      errorCode: code,
      httpStatus: status,
      result:
        classified === 'RETRYABLE'
          ? { kind: 'RETRYABLE', errorCode: code, httpStatus: status }
          : { kind: 'PERMANENT', errorCode: code, httpStatus: status },
    };
  }

  /**
   * Where the delivery lands, and when it is next owed an attempt.
   *
   * Decided in memory and handed to the database as one already-bounded answer,
   * because the ladder is PalCert's and not the receiver's. `Retry-After` may
   * push the next attempt later than the ladder would, but never earlier and
   * never beyond a day — and it is read here and forgotten, never stored.
   *
   * When the rungs run out the delivery is permanently failed while the attempt
   * still records what the receiver actually said. Those are two different
   * facts: the receiver may well be worth asking again, and PalCert is done
   * asking.
   */
  private settle(
    attemptNumber: number,
    verdict: Verdict,
    retryAfter: string | undefined,
  ): { deliveryStatus: WebhookDeliveryStatus; nextAttemptAt: Date | null } {
    if (verdict.result.kind === 'DELIVERED') {
      return { deliveryStatus: WebhookDeliveryStatus.DELIVERED, nextAttemptAt: null };
    }

    if (verdict.result.kind === 'PERMANENT') {
      return { deliveryStatus: WebhookDeliveryStatus.FAILED_PERMANENT, nextAttemptAt: null };
    }

    // The rung is the attempt's own number, as the database assigned it when the
    // attempt row was created. Reading it from the parent's counter would mean
    // trusting a number that a crash could have moved without any attempt
    // having happened — which is the defect this whole doorway exists to fix.
    const ladderDelay = nextWebhookRetryDelayMs(attemptNumber);
    if (ladderDelay === null) {
      return { deliveryStatus: WebhookDeliveryStatus.FAILED_PERMANENT, nextAttemptAt: null };
    }

    const now = this.clock.now().getTime();
    const honoured =
      verdict.httpStatus === 429 || verdict.httpStatus === 503
        ? parseRetryAfterMs(retryAfter, now)
        : null;

    return {
      deliveryStatus: WebhookDeliveryStatus.FAILED_RETRYABLE,
      nextAttemptAt: new Date(now + Math.max(ladderDelay, honoured ?? 0)),
    };
  }
}

/** Transport codes worth asking about again; everything else is permanent. */
const RETRYABLE_TRANSPORT = new Set<string>([
  WebhookErrorCode.DNS_TEMPORARY_FAILURE,
  WebhookErrorCode.CONNECT_TIMEOUT,
  WebhookErrorCode.CONNECTION_RESET,
  WebhookErrorCode.TLS_INTERRUPTED,
  WebhookErrorCode.REQUEST_TIMEOUT,
]);

function isTerminal(status: WebhookDeliveryStatus): boolean {
  return (
    status === WebhookDeliveryStatus.DELIVERED ||
    status === WebhookDeliveryStatus.FAILED_PERMANENT ||
    status === WebhookDeliveryStatus.SKIPPED
  );
}

/**
 * Open sealed material, keeping the two failures apart.
 *
 * Material that will not authenticate under a key this process holds is a row
 * that no longer describes itself: permanent, and the delivery settles. A key
 * this process does not hold is a deployment problem, so it escapes to the
 * queue's ladder and the delivery keeps waiting for a process that has the key.
 */
function openOrClassify(open: () => string): string {
  try {
    return open();
  } catch (error) {
    if (error instanceof WebhookMaterialAuthenticationError) {
      throw new IntegrityError(WebhookErrorCode.CONFIG_INTEGRITY_MISMATCH);
    }
    throw error;
  }
}

class IntegrityError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = 'IntegrityError';
  }
}

interface PreparedRequest {
  readonly request: Parameters<SafeWebhookHttpClient['send']>[0];
}

interface Verdict {
  readonly outcome: WebhookAttemptOutcome;
  readonly errorCode: string | null;
  readonly httpStatus: number | null;
  readonly result: DeliveryOutcome;
}

/**
 * What one attempt came to.
 *
 * `eventType` rides along so the worker can put it on a metric without reading
 * the delivery again — it is one of nine closed values, which is exactly the
 * kind of dimension a counter may carry.
 */
export type DeliveryOutcome = { readonly eventType?: string | null } & (
  | { kind: 'GONE' }
  | { kind: 'ALREADY_SETTLED'; status: WebhookDeliveryStatus }
  | { kind: 'WAITING'; nextAttemptAt: Date }
  | { kind: 'SKIPPED'; reason: WebhookSkipReason }
  | { kind: 'DELIVERED'; httpStatus: number }
  | { kind: 'RETRYABLE'; errorCode: string; httpStatus?: number }
  | { kind: 'PERMANENT'; errorCode: string; httpStatus?: number }
);
