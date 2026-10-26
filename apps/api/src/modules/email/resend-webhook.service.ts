import { createHash } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import {
  AppError,
  EmailDeliveryStatus,
  OutboundEmailFailure,
  PalCertErrorCode,
} from '@palcert/contracts';
import { Prisma } from '@palcert/database';
import { PinoLogger } from 'nestjs-pino';
import { EmailDeliveryRecorder } from '../../infrastructure/email/email-delivery-recorder';
import { EmailSettingsService } from '../../infrastructure/email/email-settings.service';
import { verifySvixSignature } from '../../infrastructure/email/svix-signature';
import { PrismaService } from '../../infrastructure/prisma/prisma.service';

const PROVIDER = 'resend';

/** What each Resend event means for a delivery, or null when it changes nothing. */
const EVENT_STATUS: Readonly<
  Record<string, { status: EmailDeliveryStatus; failure: OutboundEmailFailure | null }>
> = {
  'email.sent': { status: EmailDeliveryStatus.ACCEPTED, failure: null },
  'email.delivery_delayed': { status: EmailDeliveryStatus.DELAYED, failure: null },
  'email.delivered': { status: EmailDeliveryStatus.DELIVERED, failure: null },
  'email.bounced': {
    status: EmailDeliveryStatus.BOUNCED,
    failure: OutboundEmailFailure.RECIPIENT_REJECTED,
  },
  'email.complained': { status: EmailDeliveryStatus.COMPLAINED, failure: null },
  'email.failed': {
    status: EmailDeliveryStatus.FAILED,
    failure: OutboundEmailFailure.PROVIDER_REJECTED,
  },
  'email.suppressed': {
    status: EmailDeliveryStatus.FAILED,
    failure: OutboundEmailFailure.RECIPIENT_REJECTED,
  },
};

export interface ResendWebhookInput {
  readonly rawBody: Buffer;
  readonly svixId: string | undefined;
  readonly svixTimestamp: string | undefined;
  readonly svixSignature: string | undefined;
}

/**
 * Receive one signed Resend event (ADR-0146).
 *
 * Verify, then update delivery metadata and nothing else. Idempotent by the
 * Svix message id; tolerant of duplicates and of events arriving out of order
 * (a status never moves backwards). The payload is hashed and discarded: a
 * bounce can quote the recipient's mail server, so none of it is stored.
 */
@Injectable()
export class ResendWebhookService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly settings: EmailSettingsService,
    private readonly recorder: EmailDeliveryRecorder,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext(ResendWebhookService.name);
  }

  async ingest(input: ResendWebhookInput): Promise<{ received: true; duplicate: boolean }> {
    const secret = await this.settings.openWebhookSecret();
    const valid =
      secret !== null &&
      verifySvixSignature({
        secret,
        id: input.svixId,
        timestamp: input.svixTimestamp,
        signatureHeader: input.svixSignature,
        body: input.rawBody,
        now: new Date(),
      });
    if (!valid) {
      throw new AppError(PalCertErrorCode.EMAIL_WEBHOOK_SIGNATURE_INVALID, {
        message: 'The webhook signature could not be verified.',
      });
    }
    const eventId = input.svixId as string;

    const existing = await this.prisma.emailProviderEvent.findUnique({
      where: { provider_eventId: { provider: PROVIDER, eventId } },
      select: { id: true },
    });
    if (existing !== null) return { received: true, duplicate: true };

    const payload = parse(input.rawBody);
    const type = typeof payload?.type === 'string' ? payload.type.slice(0, 64) : 'unknown';
    const data = payload?.data as Record<string, unknown> | undefined;
    const emailId =
      typeof data?.email_id === 'string' && data.email_id.length <= 200 ? data.email_id : null;
    const occurredAt = parseDate(payload?.created_at);

    const settings = await this.settings.snapshot();
    const mapping = EVENT_STATUS[type];
    let outcome: 'APPLIED' | 'STALE' | 'UNMATCHED' | 'IGNORED' = 'IGNORED';
    if (settings.deliveryTrackingEnabled && mapping !== undefined && emailId !== null) {
      outcome = await this.recorder.applyProviderStatus({
        provider: PROVIDER,
        providerMessageId: emailId,
        next: mapping.status,
        failure: mapping.failure,
        at: occurredAt ?? new Date(),
      });
    }

    try {
      await this.prisma.emailProviderEvent.create({
        data: {
          provider: PROVIDER,
          eventId,
          eventType: type,
          providerMessageId: emailId,
          payloadSha256: createHash('sha256').update(input.rawBody).digest('hex'),
          outcome,
          occurredAt,
        },
      });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        // A concurrent redelivery recorded it first. The status update above
        // was conditional, so applying it twice changed nothing.
        return { received: true, duplicate: true };
      }
      throw error;
    }

    this.logger.info({ eventType: type, outcome }, 'email provider event received');
    return { received: true, duplicate: false };
  }
}

function parse(body: Buffer): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(body.toString('utf8'));
    return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function parseDate(value: unknown): Date | null {
  if (typeof value !== 'string') return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}
