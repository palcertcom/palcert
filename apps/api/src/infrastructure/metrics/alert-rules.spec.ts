import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * The alert rules are only as good as the metrics they name
 * (Phase 20 Checkpoint 3).
 *
 * A rule that references a metric nothing emits does not fail: it evaluates
 * to an empty vector and stays silent forever. That is the worst failure mode
 * an alert has — it looks configured, it is reviewed, it is trusted, and it
 * will never fire. So every metric name the rule file uses is checked against
 * the names the code actually declares, and a rename that forgets the rules
 * breaks this test instead of quietly disarming an alert.
 *
 * Parsed with regular expressions rather than a YAML library on purpose: the
 * API does not depend on one, and adding a dependency so a test can read six
 * hundred lines of its own repository would be a poor trade.
 */
const root = join(__dirname, '..', '..', '..', '..', '..');
const read = (path: string) => readFileSync(join(root, path), 'utf8');

const rules = read('ops/alerts/palcert.rules.yml');
const declared = new Set<string>([
  ...[
    ...read('apps/api/src/infrastructure/metrics/metrics.service.ts').matchAll(
      /name: '(palcert_[a-z0-9_]+)'/g,
    ),
  ].map((match) => match[1]!),
  ...[
    ...read('apps/api/src/infrastructure/metrics/database-metrics.collector.ts').matchAll(
      /name: '(palcert_[a-z0-9_]+)'/g,
    ),
  ].map((match) => match[1]!),
  ...[...read('services/document-engine/app/metrics.py').matchAll(/"(palcert_[a-z0-9_]+)"/g)].map(
    (match) => match[1]!,
  ),
  // prom-client's default collectors, prefixed. Declared by the library, not
  // by PalCert, so they are listed rather than scraped out of source.
  'palcert_process_resident_memory_bytes',
  'palcert_nodejs_eventloop_lag_seconds',
  'palcert_nodejs_heap_size_total_bytes',
]);

/** Histogram suffixes a rule uses that the metric itself does not declare. */
function baseName(referenced: string): string {
  return referenced.replace(/_(bucket|sum|count)$/, '');
}

function referencedMetrics(): string[] {
  return [...new Set([...rules.matchAll(/\b(palcert_[a-z0-9_]+)/g)].map((match) => match[1]!))];
}

function alertNames(): string[] {
  return [...rules.matchAll(/^ {6}- alert: (\w+)$/gm)].map((match) => match[1]!);
}

describe('alert rules', () => {
  it('references only metrics PalCert actually emits', () => {
    const missing = referencedMetrics()
      .map(baseName)
      .filter((name) => !declared.has(name));

    expect(missing).toEqual([]);
  });

  it('covers every operational condition the checkpoint requires', () => {
    // Named explicitly so deleting one is a decision somebody has to make,
    // rather than something that happens while editing YAML.
    for (const alert of [
      'PalCertServiceDown',
      'PalCertHighErrorRate',
      'PalCertLatencyDegraded',
      'PalCertJobDead',
      'PalCertQueueBacklogGrowing',
      'PalCertOldestQueuedJobStale',
      'PalCertJobLeasesExpiring',
      'PalCertJobFailureRateHigh',
      'PalCertNotificationsNotSending',
      'PalCertNotificationsFailingPermanently',
      'PalCertWebhooksNotDelivering',
      'PalCertWebhooksFailingPermanently',
      'PalCertAnalyzerFailing',
      'PalCertAnalyzerTimingOut',
      'PalCertCertificatesStuckUnissued',
      'PalCertTopUpsFailing',
      'PalCertApiClientAuthFailureSpike',
      'PalCertStorageUnavailable',
      'PalCertLoginFailureSpike',
      'PalCertMetricsCollectorDown',
      'PalCertReleaseSplitBrain',
    ]) {
      expect(alertNames()).toContain(alert);
    }
  });

  it('gives every alert a severity and a summary', () => {
    const blocks = rules.split(/^ {6}- alert: /m).slice(1);

    expect(blocks).toHaveLength(alertNames().length);
    for (const block of blocks) {
      expect(block).toMatch(/severity: (page|ticket)/);
      expect(block).toMatch(/summary:/);
    }
  });

  it('marks every invented threshold as an assumption', () => {
    // The checkpoint's rule: a threshold that needs workload knowledge is
    // configurable and documented, never invented silently. Each such rule
    // says ASSUMPTION in its own comment, and the alerting document records
    // what to re-derive once real traffic exists.
    const withRatios = rules
      .split(/^ {6}- alert: /m)
      .slice(1)
      .filter((block) => {
        const expression = /expr: \|?([\s\S]*?)\n {8}for:/.exec(block)?.[1] ?? '';
        return /> 0\.\d|> [1-9]\d{1,}/.test(expression);
      });

    expect(withRatios.length).toBeGreaterThan(0);
    for (const block of withRatios) {
      expect(block).toContain('ASSUMPTION');
    }
  });

  it('never renders an identifier or a secret into an alert', () => {
    // An annotation is rendered into a page, an email and a chat message, and
    // those go places a database row does not. What matters is what gets
    // *interpolated*, so the check is on the template expressions rather than
    // on prose — a description that says "no address appears here" is the
    // point being made, not a leak.
    const interpolated = [...rules.matchAll(/\{\{ \$labels\.([a-z_]+) \}\}/g)].map(
      (match) => match[1]!,
    );

    for (const forbidden of [
      'document_id',
      'user_id',
      'owner_user_id',
      'organization_id',
      'email',
      'recipient',
      'client_id',
      'url',
    ]) {
      expect(interpolated).not.toContain(forbidden);
    }

    // And no secret field name anywhere in the file, prose included.
    for (const forbidden of ['client_secret', 'signing_secret', 'sk_live', 'whsec_']) {
      expect(rules).not.toContain(forbidden);
    }
  });
});
