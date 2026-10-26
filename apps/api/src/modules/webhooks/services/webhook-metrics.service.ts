import { Injectable } from '@nestjs/common';
import { PinoLogger } from 'nestjs-pino';

/**
 * What the webhook subsystem says about itself, and what it deliberately does
 * not.
 *
 * PalCert has no metrics backend yet, so a counter here is a structured log
 * event with a fixed shape that an aggregator can count. That makes the
 * cardinality question a code question rather than a dashboard question, which
 * is the right place for it: an organization id or an endpoint id as a metric
 * label is a time series per customer, and a URL or a host as one is a time
 * series per third party, which is both a cost problem and a disclosure
 * problem — a metrics store is rarely held to the same tenancy rules as the
 * database.
 *
 * So metric dimensions are the three closed vocabularies and nothing else:
 * event type, status and normalized error code. Opaque ids belong in the
 * structured logs beside them, where support can correlate them and where the
 * retention and access rules are the ones PalCert already reasons about.
 */
@Injectable()
export class WebhookMetricsService {
  constructor(private readonly logger: PinoLogger) {
    this.logger.setContext('webhook.metrics');
  }

  /** One delivery reached a durable outcome. */
  deliverySettled(dimensions: {
    eventType: string;
    status: string;
    errorCode?: string | null;
  }): void {
    this.count('webhook_delivery_settled', dimensions);
  }

  /** One real network attempt finished, however it finished. */
  attemptFinished(dimensions: {
    eventType: string;
    status: string;
    errorCode?: string | null;
  }): void {
    this.count('webhook_delivery_attempt', dimensions);
  }

  /** One verification handshake finished. */
  verificationSettled(dimensions: { status: string; errorCode?: string | null }): void {
    this.count('webhook_verification_settled', { eventType: 'verification', ...dimensions });
  }

  /** One event was projected to some number of endpoints. */
  fanoutCompleted(dimensions: { eventType: string; deliveries: number }): void {
    this.logger.info(
      {
        metric: 'webhook_fanout',
        eventType: dimensions.eventType,
        // A bucketed count rather than the number, so the series does not grow
        // a dimension per organization size.
        deliveries: bucket(dimensions.deliveries),
      },
      'webhook metric',
    );
  }

  private count(
    metric: string,
    dimensions: { eventType: string; status: string; errorCode?: string | null },
  ): void {
    this.logger.info(
      {
        metric,
        eventType: dimensions.eventType,
        status: dimensions.status,
        errorCode: dimensions.errorCode ?? 'none',
      },
      'webhook metric',
    );
  }
}

/** Small numbers exactly, larger ones in buckets. Keeps the series bounded. */
function bucket(count: number): string {
  if (count <= 2) return String(count);
  if (count <= 5) return '3-5';
  if (count <= 10) return '6-10';
  return '10+';
}
