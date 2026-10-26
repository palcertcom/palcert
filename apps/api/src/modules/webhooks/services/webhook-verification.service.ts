import { timingSafeEqual } from 'node:crypto';

import { Injectable } from '@nestjs/common';
import {
  buildWebhookVerificationBody,
  canonicalWebhookBody,
  classifyWebhookHttpStatus,
  sha256Hex,
  validateWebhookUrl,
  WebhookAttemptOutcome,
  WebhookErrorCode,
  WEBHOOK_ENDPOINT_VERIFICATION_TYPE,
} from '@palcert/contracts';
import { PinoLogger } from 'nestjs-pino';

import { ApiConfigService } from '../../../config/api-config.service';
import { ClockPort } from '../../auth/ports/clock.port';
import { WebhookMaterialAuthenticationError } from '../../../common/crypto/webhook-keyring';
import { SafeWebhookHttpClient, SafeWebhookHttpError } from '../http/safe-webhook-http-client';
import { signWebhookRequest } from '../http/webhook-signature';
import { WebhookCryptoService } from './webhook-crypto.service';
import { WebhookGatewayService } from './webhook-gateway.service';

/**
 * Proving that a configuration reaches somebody who wants it.
 *
 * The job is keyed by the organization's verification *intent* — the
 * `WebhookManagementOperation` — and never by the configuration. A job keyed by
 * the configuration would have succeeded once and then refused to run again,
 * so an administrator who fixed their receiver could never ask a second time.
 * A new idempotency key makes a new operation, a new job, and a fresh chance.
 *
 * The other half of the design is resumption. A successful attempt is a durable
 * fact: PalCert sent a signed challenge and got the exact nonce back. If the
 * process dies between recording that and activating the configuration, the
 * reclaimed job must finish from the proof already on disk — sending a second
 * challenge to establish something already established would be a new outbound
 * request in service of nothing.
 */
@Injectable()
export class WebhookVerificationService {
  constructor(
    private readonly gateway: WebhookGatewayService,
    private readonly crypto: WebhookCryptoService,
    private readonly http: SafeWebhookHttpClient,
    private readonly clock: ClockPort,
    private readonly config: ApiConfigService,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext(WebhookVerificationService.name);
  }

  async verify(operationId: string): Promise<VerificationOutcome> {
    const operation = await this.gateway.readVerificationOperation(operationId);
    if (operation === null) {
      return { kind: 'GONE' };
    }

    if (operation.settled_at !== null) {
      return { kind: 'ALREADY_SETTLED' };
    }

    // Crash recovery. The proof exists; finish the work it was collected for.
    if (operation.succeeded_attempt_id !== null) {
      await this.activate(operation.succeeded_attempt_id, operationId);
      return { kind: 'RESUMED' };
    }

    if (operation.config_version_id === null || operation.endpoint_id === null) {
      await this.gateway.settleOperation(operationId, WebhookErrorCode.CONFIG_SUPERSEDED);
      return { kind: 'SETTLED', errorCode: WebhookErrorCode.CONFIG_SUPERSEDED };
    }

    // An endpoint the organization disabled is not asked anything, ever. The
    // operation settles saying so and the configuration stays unactivated —
    // PAUSED is different, and deliberately so: a paused endpoint may still
    // prove it works, it simply stays paused afterwards.
    if (operation.endpoint_status === 'DISABLED') {
      await this.gateway.recordVerificationRefusal(operationId, WebhookErrorCode.ENDPOINT_DISABLED);
      await this.gateway.settleOperation(operationId, WebhookErrorCode.ENDPOINT_DISABLED);
      return { kind: 'SETTLED', errorCode: WebhookErrorCode.ENDPOINT_DISABLED };
    }

    // A configuration superseded while the job waited activates nothing, and
    // the operation settles rather than retrying against a row that is gone.
    if (
      operation.config_status !== 'PENDING' ||
      operation.pending_config_version_id !== operation.config_version_id
    ) {
      await this.gateway.settleOperation(operationId, WebhookErrorCode.CONFIG_SUPERSEDED);
      return { kind: 'SETTLED', errorCode: WebhookErrorCode.CONFIG_SUPERSEDED };
    }

    // A previous worker died mid-handshake. This one holds the reclaimed job's
    // lease, so that worker is gone and its attempt is never going to finish.
    // Closing it here rather than at the dead-job path means the retry happens
    // now, and — because the database allows only one open attempt per
    // operation — it is also what makes the fresh attempt below possible at all.
    await this.closeInterruptedAttempt(operationId);

    // Everything that can refuse happens before an attempt exists, because an
    // attempt row is the record of a real network request. Manufacturing one to
    // carry a refusal would put a request in the log that never left the
    // process; the configuration's own history carries it instead.
    const prepared = await this.prepare(operation.endpoint_id, operation.config_version_id);
    if (prepared.kind === 'REFUSED') {
      await this.gateway.recordVerificationRefusal(operationId, prepared.errorCode);
      await this.gateway.settleOperation(operationId, prepared.errorCode);
      return { kind: 'SETTLED', errorCode: prepared.errorCode };
    }

    // The attempt comes first now, because the attempt *is* the wire identity:
    // its id is the delivery header and the id the signature commits to. A
    // second network attempt against the same configuration is therefore a
    // different attempt, a different header, a different challenge and a
    // different signature — a receiver can never accept a replayed handshake.
    const attemptId = await this.gateway.openVerificationAttempt(
      operationId,
      operation.config_version_id,
      this.clock.now(),
    );
    const challenge = this.crypto.newChallenge();
    const request = this.buildRequest(prepared, attemptId, challenge);
    const startedAt = Date.now();

    let response: Awaited<ReturnType<SafeWebhookHttpClient['send']>> | null = null;
    let transport: SafeWebhookHttpError | null = null;
    try {
      response = await this.http.send(request);
    } catch (error) {
      if (error instanceof SafeWebhookHttpError) {
        transport = error;
      } else {
        await this.gateway.closeVerificationAttempt({
          attemptId,
          outcome: WebhookAttemptOutcome.FAILED_RETRYABLE,
          errorCode: WebhookErrorCode.WORKER_INTERRUPTED,
          durationMs: Date.now() - startedAt,
        });
        throw error;
      }
    }

    const durationMs = Date.now() - startedAt;

    if (transport !== null) {
      // Nothing was heard, so nothing was answered. These settle or retry on
      // their own terms, and either way the attempt and the intent move in the
      // same call — a retryable one deliberately leaves the operation
      // unsettled, because the same job is allowed to try again.
      const retryable = RETRYABLE_TRANSPORT.has(transport.code);
      if (retryable) {
        await this.gateway.closeVerificationAttempt({
          attemptId,
          outcome: WebhookAttemptOutcome.FAILED_RETRYABLE,
          errorCode: transport.code,
          durationMs,
        });
        // Transport trouble retries within the same operation, on the queue's
        // own short ladder — this is interruption, not a receiver's answer.
        throw new VerificationTransportError(transport.code);
      }

      await this.gateway.settleVerificationResponse({
        attemptId,
        outcome: WebhookAttemptOutcome.FAILED_PERMANENT,
        errorCode: transport.code,
        durationMs,
      });
      return { kind: 'SETTLED', errorCode: transport.code };
    }

    const status = response!.statusCode;
    const echoed = response!.challengeEcho;
    const ok =
      classifyWebhookHttpStatus(status) === 'SUCCESS' &&
      echoed !== undefined &&
      equalsTimingSafe(echoed, challenge);

    if (!ok) {
      const errorCode =
        classifyWebhookHttpStatus(status) === 'SUCCESS'
          ? WebhookErrorCode.CHALLENGE_MISMATCH
          : classifyWebhookHttpStatus(status) === 'RETRYABLE'
            ? WebhookErrorCode.HTTP_RETRYABLE
            : WebhookErrorCode.HTTP_PERMANENT;

      // Every one of these settles, including a retryable status, and all of it
      // in one transaction.
      //
      // A 503 to a verification is still a receiver's answer, and handing it to
      // the queue's short ladder would ask a struggling receiver again within
      // seconds — the same mistake the delivery path exists to avoid, wearing
      // different clothes. A verification is also not a durable obligation the
      // way a delivery is: nobody is owed this handshake, an administrator
      // asked for it. So the answer is recorded, the intent settles, and asking
      // again is an explicit act — a new idempotency key, a new operation, a
      // new job.
      //
      // Atomic because the rule is only true if it cannot be interrupted: a
      // crash between recording the answer and settling the intent would leave
      // the intent eligible for another automatic request, which is precisely
      // the behaviour being ruled out.
      await this.gateway.settleVerificationResponse({
        attemptId,
        outcome:
          errorCode === WebhookErrorCode.HTTP_RETRYABLE
            ? WebhookAttemptOutcome.FAILED_RETRYABLE
            : WebhookAttemptOutcome.FAILED_PERMANENT,
        errorCode,
        httpStatus: status,
        durationMs,
      });
      return { kind: 'SETTLED', errorCode };
    }

    await this.gateway.closeVerificationAttempt({
      attemptId,
      outcome: WebhookAttemptOutcome.SUCCEEDED,
      httpStatus: status,
      durationMs,
    });

    await this.activate(attemptId, operationId);
    return { kind: 'VERIFIED' };
  }

  /**
   * Close an attempt a dead worker left open, exactly once.
   *
   * Returns quietly when there is nothing to close, which is the ordinary case.
   * The closed attempt says `WORKER_INTERRUPTED` rather than anything about the
   * receiver, because nobody knows what the receiver did — the request may
   * never have left, or may have been answered and the answer lost. The retry
   * gets a new attempt id and a new challenge, so a receiver can tell the two
   * apart even if it saw both.
   */
  private async closeInterruptedAttempt(operationId: string): Promise<void> {
    const attempts = await this.gateway.verificationAttempts(operationId);
    const open = attempts.find((attempt) => attempt.outcome === null);
    if (open === undefined) return;

    await this.gateway.closeVerificationAttempt({
      attemptId: open.id,
      outcome: WebhookAttemptOutcome.FAILED_RETRYABLE,
      errorCode: WebhookErrorCode.WORKER_INTERRUPTED,
    });
    this.logger.warn(
      { operationId, attemptId: open.id },
      'closed a verification attempt an interrupted worker left open',
    );
  }

  /**
   * Finish from proof already on disk, with no network at all.
   *
   * Used by the dead-job path: the handshake succeeded, the process died before
   * the configuration went live, and the queue then spent its budget on a job
   * whose remaining work is two database writes.
   */
  async resume(operationId: string): Promise<VerificationOutcome> {
    const operation = await this.gateway.readVerificationOperation(operationId);
    if (operation === null) return { kind: 'GONE' };
    if (operation.settled_at !== null) return { kind: 'ALREADY_SETTLED' };
    if (operation.succeeded_attempt_id === null) {
      throw new Error(`webhook verification operation ${operationId} has no successful attempt`);
    }
    await this.activate(operation.succeeded_attempt_id, operationId);
    return { kind: 'RESUMED' };
  }

  private async activate(attemptId: string, operationId: string): Promise<void> {
    await this.gateway.activateConfig(attemptId);
    await this.gateway.settleOperation(operationId, null);
  }

  /**
   * Everything that can refuse, before anything exists that says it happened.
   *
   * Decrypt, re-derive, compare, re-validate the policy. If any of it
   * disagrees, nothing was sent and no attempt was opened — the caller records
   * the refusal against the configuration and settles the intent. Only once
   * this returns READY does a verification attempt come into existence, and
   * with it the challenge: generated per attempt, compared against the
   * immediate response, and then forgotten, because persisting it would be
   * persisting an answer key.
   */
  private async prepare(
    endpointId: string,
    configVersionId: string,
  ): Promise<PreparedVerification> {
    const material = await this.gateway.configMaterial(configVersionId);
    if (material === null) {
      return { kind: 'REFUSED', errorCode: WebhookErrorCode.CONFIG_INTEGRITY_MISMATCH };
    }

    // Material that will not authenticate under a key this process *holds* is a
    // stored row that no longer describes itself, and that is a refusal. A key
    // this process does not hold is a deployment that shipped short, and that
    // throws: it takes the queue's ladder and waits for a process that has the
    // key, rather than telling an organization their configuration is broken.
    let url: string;
    let secret: string;
    try {
      url = this.crypto.openUrl(
        {
          kid: material.url_encryption_key_id,
          ciphertext: material.url_ciphertext,
          iv: material.url_iv,
          authTag: material.url_auth_tag,
        },
        endpointId,
        configVersionId,
      );
      secret = this.crypto.openSigningSecret(
        {
          kid: material.secret_encryption_key_id,
          ciphertext: material.secret_ciphertext,
          iv: material.secret_iv,
          authTag: material.secret_auth_tag,
        },
        endpointId,
        configVersionId,
      );
    } catch (error) {
      if (error instanceof WebhookMaterialAuthenticationError) {
        return { kind: 'REFUSED', errorCode: WebhookErrorCode.CONFIG_INTEGRITY_MISMATCH };
      }
      throw error;
    }

    if (sha256Hex(url) !== material.url_sha256) {
      return { kind: 'REFUSED', errorCode: WebhookErrorCode.CONFIG_INTEGRITY_MISMATCH };
    }
    if (this.crypto.fingerprint(secret) !== material.secret_fingerprint) {
      return { kind: 'REFUSED', errorCode: WebhookErrorCode.CONFIG_INTEGRITY_MISMATCH };
    }

    const verdict = validateWebhookUrl(url, {
      allowedPorts: this.config.webhookAllowedPorts,
      ownHosts: this.config.webhookOwnHosts,
    });
    if (!verdict.ok) {
      return { kind: 'REFUSED', errorCode: WebhookErrorCode.URL_POLICY_VIOLATION };
    }
    if (verdict.value.host !== material.host || verdict.value.port !== material.port) {
      return { kind: 'REFUSED', errorCode: WebhookErrorCode.CONFIG_INTEGRITY_MISMATCH };
    }

    const parsed = new URL(url);
    return {
      kind: 'READY',
      secret,
      host: parsed.hostname,
      port: parsed.port === '' ? 443 : Number(parsed.port),
      path: parsed.pathname,
    };
  }

  /**
   * The wire message, built around the attempt that will carry it.
   *
   * A verification carries the *verification attempt's* id in the delivery
   * header and no event id at all, because it projects no event. Signing over
   * the configuration id instead — which is what this used to do — would make
   * every retry against one configuration produce a byte-identical signed
   * request, so a receiver could not tell a fresh handshake from a replayed
   * one and PalCert's own log could not tell which attempt a receiver saw.
   */
  private buildRequest(
    prepared: Extract<PreparedVerification, { kind: 'READY' }>,
    attemptId: string,
    challenge: string,
  ): Parameters<SafeWebhookHttpClient['send']>[0] {
    const body = canonicalWebhookBody(buildWebhookVerificationBody(challenge, this.clock.now()));
    const bytes = Buffer.from(body, 'utf8');
    const timestamp = Math.floor(this.clock.now().getTime() / 1000);

    return {
      host: prepared.host,
      port: prepared.port,
      path: prepared.path,
      body: bytes,
      signature: signWebhookRequest(prepared.secret, timestamp, attemptId, bytes),
      eventTypeHeader: WEBHOOK_ENDPOINT_VERIFICATION_TYPE,
      deliveryIdHeader: attemptId,
    };
  }
}

const RETRYABLE_TRANSPORT = new Set<string>([
  WebhookErrorCode.DNS_TEMPORARY_FAILURE,
  WebhookErrorCode.CONNECT_TIMEOUT,
  WebhookErrorCode.CONNECTION_RESET,
  WebhookErrorCode.TLS_INTERRUPTED,
  WebhookErrorCode.REQUEST_TIMEOUT,
]);

/** Compared without leaking where two values first differ. */
function equalsTimingSafe(left: string, right: string): boolean {
  const a = Buffer.from(left, 'utf8');
  const b = Buffer.from(right, 'utf8');
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/** Thrown so the queue's short ladder retries an interrupted handshake. */
export class VerificationTransportError extends Error {
  constructor(readonly code: string) {
    super(`webhook verification transport failure: ${code}`);
    this.name = 'VerificationTransportError';
  }
}

type PreparedVerification =
  | { kind: 'REFUSED'; errorCode: string }
  | {
      kind: 'READY';
      secret: string;
      host: string;
      port: number;
      path: string;
    };

export type VerificationOutcome =
  | { kind: 'GONE' }
  | { kind: 'ALREADY_SETTLED' }
  | { kind: 'RESUMED' }
  | { kind: 'VERIFIED' }
  | { kind: 'SETTLED'; errorCode: string };
