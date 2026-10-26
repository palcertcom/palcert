'use client';

import { useEffect, useRef, useState } from 'react';
import { StepProgress } from '@/components/ui/step-progress';
import { StatusBadge } from '@/components/ui/status-badge';
import type { Locale } from '@/i18n/locales';
import { formatMessage, getReviewConsoleMessages } from '@/i18n/review-console-messages';
import { extractionApi, type ExtractionProgressResponse } from '@/lib/api-client';

/** Every two and a half seconds while a reading is active, as asked of the console. */
export const PROGRESS_POLL_INTERVAL_MS = 2_500;
/** After a failed read, back off rather than hammer a struggling API. */
const PROGRESS_POLL_MAX_INTERVAL_MS = 15_000;

const STEPS = [
  'PREPARING_SOURCE',
  'ANALYSING_SOURCE',
  'MEASURING_TEMPLATE',
  'GENERATING_PROPOSALS',
  'VALIDATING',
  'SAVING',
  'COMPLETED',
] as const;

const SETTLED = new Set(['COMPLETED', 'FAILED', 'CANCELLED']);

export interface ExtractionProgressPanelProps {
  readonly organizationId: string;
  readonly versionId: string;
  readonly runId: string;
  readonly locale: Locale;
  readonly canCancel: boolean;
  readonly onCancel?: () => Promise<void>;
  /** Called once, when the run is seen to have finished. */
  readonly onSettled?: (progress: ExtractionProgressResponse) => void;
  readonly api?: Pick<typeof extractionApi, 'runProgress'>;
  readonly pollIntervalMs?: number;
}

/**
 * Where a reading has got to.
 *
 * Everything shown is what the server read back from the run's own records —
 * the stage, the proposal batches settled, the passages and measurements
 * saved — so reloading the page shows the same thing, and nothing is
 * extrapolated from elapsed time. A total that is not known yet is said to be
 * not known, and the bar is indeterminate rather than invented.
 */
export function ExtractionProgressPanel({
  organizationId,
  versionId,
  runId,
  locale,
  canCancel,
  onCancel,
  onSettled,
  api = extractionApi,
  pollIntervalMs = PROGRESS_POLL_INTERVAL_MS,
}: ExtractionProgressPanelProps) {
  const messages = getReviewConsoleMessages(locale);
  const [progress, setProgress] = useState<ExtractionProgressResponse | null>(null);
  const [cancelling, setCancelling] = useState(false);
  const settledFor = useRef<string | null>(null);
  const onSettledRef = useRef(onSettled);
  onSettledRef.current = onSettled;

  useEffect(() => {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let interval = pollIntervalMs;

    async function tick(): Promise<void> {
      let settled = false;
      try {
        const read = await api.runProgress(organizationId, versionId, runId);
        if (stopped) return;
        setProgress(read);
        interval = pollIntervalMs;
        settled = SETTLED.has(read.status);
        if (settled && settledFor.current !== runId) {
          settledFor.current = runId;
          onSettledRef.current?.(read);
        }
      } catch {
        interval = Math.min(interval * 2, PROGRESS_POLL_MAX_INTERVAL_MS);
      }
      if (!stopped && !settled) timer = setTimeout(() => void tick(), interval);
    }

    void tick();
    return () => {
      stopped = true;
      if (timer !== null) clearTimeout(timer);
    };
  }, [api, organizationId, pollIntervalMs, runId, versionId]);

  if (progress === null) return null;

  const running = !SETTLED.has(progress.status);
  const state = running ? 'RUNNING' : progress.status;
  const stepIndex =
    progress.stage === 'COMPLETED'
      ? STEPS.length
      : Math.max(0, STEPS.indexOf(progress.stage as (typeof STEPS)[number]));
  const showSteps = progress.status !== 'FAILED' && progress.status !== 'CANCELLED';

  const elapsed =
    progress.elapsedSeconds === null
      ? null
      : formatMessage(messages.elapsedValue, {
          minutes: Math.floor(progress.elapsedSeconds / 60),
          seconds: progress.elapsedSeconds % 60,
        });

  async function cancel(): Promise<void> {
    if (onCancel === undefined) return;
    setCancelling(true);
    try {
      await onCancel();
    } finally {
      setCancelling(false);
    }
  }

  return (
    <section className="extraction-progress" aria-labelledby={`progress-${runId}`}>
      <div className="extraction-progress-head">
        <h4 id={`progress-${runId}`}>{messages.progressTitle}</h4>
        <StatusBadge
          label={messages.progressStates[state] ?? state}
          tone={
            state === 'COMPLETED'
              ? 'success'
              : state === 'FAILED'
                ? 'danger'
                : state === 'CANCELLED'
                  ? 'neutral'
                  : 'gold'
          }
        />
      </div>

      {showSteps && (
        <StepProgress
          steps={STEPS.map((step) => messages.progressStages[step] ?? step)}
          current={stepIndex}
          label={messages.progressStepsLabel}
          stateLabels={messages.stepStates}
        />
      )}

      <div className="extraction-progress-bar" aria-live="polite">
        {progress.totalBatches === null ? (
          <>
            {running && <progress aria-label={messages.progressBarLabel} />}
            <p className="hint">{messages.batchesNotYetKnown}</p>
          </>
        ) : (
          <>
            <progress
              value={progress.completedBatches}
              max={Math.max(1, progress.totalBatches)}
              aria-label={messages.progressBarLabel}
            />
            <p>
              {formatMessage(messages.batchesOf, {
                done: progress.completedBatches,
                total: progress.totalBatches,
              })}
              {progress.failedBatches > 0 &&
                ` · ${formatMessage(messages.batchesFailed, { count: progress.failedBatches })}`}
            </p>
          </>
        )}
        {progress.stage === 'VALIDATING' && <p className="hint">{messages.validatingTogether}</p>}
      </div>

      <dl className="pc-stat-list pc-stat-list-compact extraction-progress-counts">
        <div>
          <dt>{messages.evidenceLabel}</dt>
          <dd>{progress.evidenceCount ?? '—'}</dd>
        </div>
        <div>
          <dt>{messages.observationsLabel}</dt>
          <dd>{progress.observationCount ?? '—'}</dd>
        </div>
        <div>
          <dt>{messages.proposalsLabel}</dt>
          <dd>
            {progress.proposalCount ?? <span className="hint">{messages.countedWhenSaved}</span>}
          </dd>
        </div>
        <div>
          <dt>{messages.elapsedLabel}</dt>
          <dd>{elapsed ?? '—'}</dd>
        </div>
      </dl>

      {running && progress.cancellable && canCancel && onCancel !== undefined && (
        <div className="extraction-progress-cancel">
          <button
            type="button"
            className="button secondary"
            disabled={cancelling}
            onClick={() => void cancel()}
          >
            {cancelling ? messages.cancelling : messages.cancel}
          </button>
          <p className="hint">{messages.cancelNote}</p>
        </div>
      )}
    </section>
  );
}
