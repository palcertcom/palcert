'use client';

import { useCallback, useEffect, useId, useMemo, useState } from 'react';
import { AIServiceFee, useAIServiceQuote, type AIServiceFeeApi } from '@/components/ai-service-fee';
import { ExtractionProgressPanel } from '@/components/extraction-progress';
import { getExtractionMessages, type ExtractionMessages } from '@/i18n/extraction-messages';
import type { Locale } from '@/i18n/locales';
import {
  ApiError,
  extractionApi,
  uploadToStorage,
  type ExtractionRunResponse,
  type OrganizationAIConsentResponse,
  type StandardSourceResponse,
} from '@/lib/api-client';

/** Bounded polling, like every other long-running operation in the product. */
const POLL_INTERVAL_MS = 2_000;
const POLL_MAX_INTERVAL_MS = 15_000;
const POLL_DEADLINE_MS = 10 * 60 * 1_000;

const SETTLED_SOURCE = new Set(['READY', 'REJECTED', 'FAILED', 'DELETED']);
const SETTLED_RUN = new Set(['COMPLETED', 'FAILED', 'CANCELLED']);

export interface StandardSourcesPanelProps {
  readonly organizationId: string;
  readonly versionId: string;
  readonly locale: Locale;
  /** False once the version is published: sources and readings are draft-only (§7). */
  readonly isDraft: boolean;
  readonly canManageSources: boolean;
  readonly canRunExtraction: boolean;
  readonly canManageConsent: boolean;
  readonly onRunCompleted?: (run: ExtractionRunResponse) => void;
  /** Injectable for tests; defaults to the real client. */
  readonly api?: Pick<
    typeof extractionApi,
    | 'consent'
    | 'grantConsent'
    | 'revokeConsent'
    | 'sources'
    | 'createSource'
    | 'finalizeSource'
    | 'source'
    | 'deleteSource'
    | 'sourceDownload'
    | 'runs'
    | 'startRun'
    | 'run'
    | 'cancelRun'
  > &
    Partial<Pick<typeof extractionApi, 'runProgress'>>;
  readonly upload?: typeof uploadToStorage;
  readonly pollIntervalMs?: number;
  /** Injectable for tests: where the AI fee and the balance come from. */
  readonly feeApi?: AIServiceFeeApi;
}

/**
 * The source documents of a draft standard, and the reading that turns them
 * into proposals (§94, §95, §129).
 *
 * The panel is arranged so the order of the page matches the order of the
 * promise: what the institution agreed to, what it uploaded, and only then what
 * PalCert read. The reading button does not exist until there is something
 * ready to read and someone authorized to agree has agreed.
 */
export function StandardSourcesPanel({
  organizationId,
  versionId,
  locale,
  isDraft,
  canManageSources,
  canRunExtraction,
  canManageConsent,
  onRunCompleted,
  api = extractionApi,
  upload = uploadToStorage,
  pollIntervalMs = POLL_INTERVAL_MS,
  feeApi,
}: StandardSourcesPanelProps) {
  const messages = getExtractionMessages(locale);
  const kindFieldId = useId();
  const authorityFieldId = useId();
  const fileFieldId = useId();

  const [consent, setConsent] = useState<OrganizationAIConsentResponse | null>(null);
  const [sources, setSources] = useState<StandardSourceResponse[]>([]);
  const [runs, setRuns] = useState<ExtractionRunResponse[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [unavailable, setUnavailable] = useState(false);
  const [starting, setStarting] = useState(false);
  // ADR-0149: the fee comes from the member's own balance, shown before they start.
  const fee = useAIServiceQuote('AI_RULE_EXTRACTION', feeApi);
  const [uploadFraction, setUploadFraction] = useState<number | null>(null);

  const [sourceKind, setSourceKind] = useState('GUIDELINE_PDF');
  const [authority, setAuthority] = useState('PRIMARY');
  const [file, setFile] = useState<File | null>(null);

  const describe = useCallback(
    (caught: unknown): string =>
      caught instanceof ApiError
        ? (messages.errors[caught.code] ?? messages.genericError)
        : messages.genericError,
    [messages],
  );

  const load = useCallback(async (): Promise<void> => {
    try {
      const [loadedSources, loadedRuns] = await Promise.all([
        api.sources(organizationId, versionId),
        api.runs(organizationId, versionId),
      ]);
      setSources(loadedSources);
      setRuns(loadedRuns);
    } catch (caught) {
      if (caught instanceof ApiError && caught.code === 'AI_DISABLED') {
        setUnavailable(true);
        return;
      }
      setError(describe(caught));
    }
  }, [api, describe, organizationId, versionId]);

  useEffect(() => {
    void (async () => {
      try {
        setConsent(await api.consent(organizationId));
      } catch (caught) {
        // Not being allowed to *see* the institution's agreement is not an
        // error worth shouting about; it just means this reviewer cannot give
        // it (§16).
        if (!(caught instanceof ApiError && (caught.status === 403 || caught.status === 404))) {
          setError(describe(caught));
        }
      }
      await load();
    })();
  }, [api, describe, load, organizationId]);

  // Poll while anything is still moving: a source being checked, or a reading
  // in progress. Both stop at a deadline rather than forever.
  const pending =
    sources.some((source) => !SETTLED_SOURCE.has(source.status)) ||
    runs.some((run) => !SETTLED_RUN.has(run.status));

  useEffect(() => {
    if (!pending) return;
    let cancelled = false;
    const startedAt = Date.now();
    let interval = pollIntervalMs;
    let timer: ReturnType<typeof setTimeout> | null = null;

    async function tick(): Promise<void> {
      await load();
      if (cancelled || Date.now() - startedAt > POLL_DEADLINE_MS) return;
      interval = Math.min(interval * 1.5, POLL_MAX_INTERVAL_MS);
      timer = setTimeout(() => void tick(), interval);
    }

    timer = setTimeout(() => void tick(), interval);
    return () => {
      cancelled = true;
      if (timer !== null) clearTimeout(timer);
    };
  }, [load, pending, pollIntervalMs]);

  const latestRun = runs[0] ?? null;
  // Stable, so the progress panel's polling is not restarted on every render.
  const progressApi = useMemo(
    () => (api.runProgress === undefined ? null : { runProgress: api.runProgress }),
    [api],
  );
  useEffect(() => {
    if (latestRun?.status === 'COMPLETED') onRunCompleted?.(latestRun);
  }, [latestRun, onRunCompleted]);

  async function agree(): Promise<void> {
    setError(null);
    try {
      setConsent(await api.grantConsent(organizationId));
    } catch (caught) {
      setError(describe(caught));
    }
  }

  async function withdraw(): Promise<void> {
    setError(null);
    try {
      setConsent(await api.revokeConsent(organizationId));
    } catch (caught) {
      setError(describe(caught));
    }
  }

  async function addSource(): Promise<void> {
    if (file === null) return;
    setError(null);
    setUploadFraction(0);
    try {
      const created = await api.createSource(
        organizationId,
        versionId,
        {
          sourceKind,
          originalFilename: file.name,
          sizeBytes: file.size,
          ...(file.type === '' ? {} : { declaredMimeType: file.type }),
          authority,
        },
        crypto.randomUUID(),
      );
      await upload(created.upload, file, setUploadFraction);
      const finalized = await api.finalizeSource(organizationId, versionId, created.source.id);
      setSources((current) => [finalized, ...current.filter((item) => item.id !== finalized.id)]);
      setFile(null);
    } catch (caught) {
      setError(describe(caught));
    } finally {
      setUploadFraction(null);
    }
  }

  async function downloadSource(sourceId: string): Promise<void> {
    setError(null);
    try {
      const grant = await api.sourceDownload(organizationId, versionId, sourceId);
      // The signed URL is used at once and never shown or stored.
      window.location.assign(grant.url);
    } catch (caught) {
      setError(describe(caught));
    }
  }

  async function removeSource(sourceId: string): Promise<void> {
    setError(null);
    try {
      await api.deleteSource(organizationId, versionId, sourceId);
      setSources((current) => current.filter((item) => item.id !== sourceId));
    } catch (caught) {
      setError(describe(caught));
    }
  }

  async function startRun(): Promise<void> {
    if (fee.quote === null || fee.short) return;
    setStarting(true);
    setError(null);
    try {
      const started = await api.startRun(
        organizationId,
        versionId,
        fee.quote.id,
        crypto.randomUUID(),
      );
      setRuns((current) => [started, ...current]);
    } catch (caught) {
      setError(describe(caught));
    } finally {
      setStarting(false);
      // A quote funds one run; the next needs a fresh one.
      void fee.refresh();
    }
  }

  async function cancelRun(runId: string): Promise<void> {
    setError(null);
    try {
      const cancelled = await api.cancelRun(organizationId, versionId, runId);
      setRuns((current) => current.map((run) => (run.id === runId ? cancelled : run)));
    } catch (caught) {
      setError(describe(caught));
    }
  }

  if (unavailable) {
    return (
      <section className="standard-sources">
        <h2>{messages.sectionTitle}</h2>
        <p>{messages.errors.AI_DISABLED}</p>
      </section>
    );
  }

  const readySources = sources.filter((source) => source.status === 'READY');
  const consentGranted = consent?.granted === true && consent.renewalRequired !== true;

  return (
    <section className="standard-sources">
      <header>
        <h2>{messages.sectionTitle}</h2>
        <p className="hint">{messages.sectionSubtitle}</p>
        {!isDraft && <p className="hint">{messages.draftOnlyNotice}</p>}
      </header>

      {error !== null && <p role="alert">{error}</p>}

      {/* --- the institution's agreement ----------------------------------- */}
      {consent !== null && !consentGranted && (
        <div className="ai-consent">
          <h3>{messages.consentTitle}</h3>
          <p>{messages.consentExplanation}</p>
          <p className="hint">{messages.consentProviderNote}</p>
          <p className="hint">{messages.consentRetentionNote}</p>
          <p className="hint">{messages.consentOrganizationScope}</p>
          {consent.renewalRequired && <p className="hint">{messages.consentRenewalRequired}</p>}
          {/* Uploading and hand-writing rules never needed this, and a reviewer
              must not be left thinking the feature is closed to them (§17). */}
          <p className="hint">{messages.manualAlternative}</p>
          {canManageConsent ? (
            <button type="button" className="button" onClick={() => void agree()}>
              {messages.consentAgree}
            </button>
          ) : (
            // §16: doing the job does not carry the authority to commit the
            // institution to external processing.
            <p className="hint">{messages.consentNotPermitted}</p>
          )}
        </div>
      )}

      {consentGranted && canManageConsent && (
        <p className="hint">
          {messages.consentGrantedOn}{' '}
          {consent?.acceptedAt !== null && consent?.acceptedAt !== undefined && (
            <time dateTime={consent.acceptedAt}>
              {new Date(consent.acceptedAt).toLocaleDateString(locale)}
            </time>
          )}{' '}
          <button type="button" className="button secondary" onClick={() => void withdraw()}>
            {messages.consentRevoke}
          </button>
        </p>
      )}

      {/* --- the sources themselves ---------------------------------------- */}
      <h3>{messages.sourcesTitle}</h3>
      <p className="hint">{messages.sourcesSubtitle}</p>

      {sources.length === 0 ? (
        <p>{messages.noSources}</p>
      ) : (
        <ul className="source-list">
          {sources.map((source) => (
            <li key={source.id} className={`source source-${source.status.toLowerCase()}`}>
              <h4>{source.originalFilename}</h4>
              <dl>
                <dt>{messages.sourceKindLabel}</dt>
                <dd>{messages.sourceKinds[source.sourceKind] ?? source.sourceKind}</dd>
                <dt>{messages.authorityLabel}</dt>
                <dd>
                  {source.authority === null
                    ? '—'
                    : (messages.authorities[source.authority] ?? source.authority)}
                </dd>
                {source.pageCount !== null && (
                  <>
                    <dt>{messages.pageCount}</dt>
                    <dd>{source.pageCount}</dd>
                  </>
                )}
                {source.sha256 !== null && (
                  <>
                    <dt>{messages.digestLabel}</dt>
                    <dd>
                      <code>{source.sha256}</code>
                    </dd>
                  </>
                )}
              </dl>

              <p
                aria-live="polite"
                className={`source-status status-${source.status.toLowerCase()}`}
              >
                {messages.sourceStatuses[source.status] ?? source.status}
              </p>

              {source.status === 'REJECTED' && (
                <p role="status">
                  {messages.sourceRejected}{' '}
                  {source.rejectionCode !== null &&
                    (messages.sourceRejectionReasons[source.rejectionCode] ?? '')}
                </p>
              )}

              {/* §8: an uploaded source never changes, and the reason is shown
                  rather than left for a reviewer to discover by failing. */}
              {/* Not a warning about the document: a statement of what PalCert did. */}
              {source.status === 'READY' && (source.legacyEquationCount ?? 0) > 0 && (
                <p
                  className="pc-alert pc-alert-info"
                  role="note"
                  data-testid="legacy-equations-notice"
                >
                  {messages.legacyEquationsNotice}
                </p>
              )}
              {source.status === 'READY' && <p className="hint">{messages.sourceImmutable}</p>}
              {source.retentionLocked && <p className="hint">{messages.retentionLocked}</p>}

              {source.status === 'READY' && (
                <button
                  type="button"
                  className="button secondary"
                  aria-label={`${messages.downloadSource}: ${source.originalFilename}`}
                  onClick={() => void downloadSource(source.id)}
                >
                  {messages.downloadSource}
                </button>
              )}

              {canManageSources && isDraft && !source.retentionLocked && (
                <button
                  type="button"
                  className="button secondary"
                  onClick={() => {
                    if (window.confirm(messages.confirmRemoveSource)) void removeSource(source.id);
                  }}
                >
                  {messages.removeSource}
                </button>
              )}
            </li>
          ))}
        </ul>
      )}

      {canManageSources && isDraft && (
        <div className="source-uploader">
          <h4>{messages.addSource}</h4>

          <label htmlFor={kindFieldId}>{messages.sourceKindLabel}</label>
          <select
            id={kindFieldId}
            value={sourceKind}
            onChange={(event) => setSourceKind(event.target.value)}
          >
            {Object.entries(messages.sourceKinds).map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
          {/* The distinction the whole phase rests on, stated where the choice
              is made rather than only in a proposal card afterwards (§4). */}
          <p className="hint">{messages.sourceKindHints[sourceKind]}</p>

          <label htmlFor={authorityFieldId}>{messages.authorityLabel}</label>
          <select
            id={authorityFieldId}
            value={authority}
            onChange={(event) => setAuthority(event.target.value)}
          >
            {Object.entries(messages.authorities).map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
          <p className="hint">{messages.authorityHint}</p>

          <label htmlFor={fileFieldId}>{messages.chooseFile}</label>
          <input
            id={fileFieldId}
            type="file"
            onChange={(event) => setFile(event.target.files?.[0] ?? null)}
          />

          {uploadFraction !== null && (
            <progress value={uploadFraction} max={1} aria-label={messages.uploading} />
          )}

          <button
            type="button"
            className="button"
            disabled={file === null || uploadFraction !== null}
            onClick={() => void addSource()}
          >
            {uploadFraction === null ? messages.addSource : messages.uploading}
          </button>
        </div>
      )}

      {/* --- the reading ---------------------------------------------------- */}
      <h3>{messages.runTitle}</h3>

      {latestRun === null && <p>{messages.noRunYet}</p>}

      {latestRun !== null && (
        <div className="extraction-run">
          <p aria-live="polite">{messages.runStatuses[latestRun.status] ?? latestRun.status}</p>

          {progressApi !== null && (
            <ExtractionProgressPanel
              key={latestRun.id}
              organizationId={organizationId}
              versionId={versionId}
              runId={latestRun.id}
              locale={locale}
              canCancel={canRunExtraction}
              onCancel={() => cancelRun(latestRun.id)}
              onSettled={() => void load()}
              api={progressApi}
            />
          )}

          {progressApi === null && !SETTLED_RUN.has(latestRun.status) && (
            <>
              <p>{messages.running}</p>
              {canRunExtraction && (
                <button
                  type="button"
                  className="button secondary"
                  onClick={() => void cancelRun(latestRun.id)}
                >
                  {messages.cancelRun}
                </button>
              )}
            </>
          )}

          {latestRun.status === 'FAILED' && (
            <p role="status">
              {messages.runFailed}{' '}
              {latestRun.failureKind !== null &&
                (messages.runFailureKinds[latestRun.failureKind] ?? '')}
            </p>
          )}

          {latestRun.status === 'COMPLETED' && latestRun.summary !== null && (
            <>
              <h4>{messages.summaryTitle}</h4>
              <dl className="extraction-summary">
                {Object.entries(latestRun.summary).map(([key, value]) => (
                  <div key={key}>
                    <dt>{messages.summaryLabels[key] ?? key}</dt>
                    <dd>{value}</dd>
                  </div>
                ))}
              </dl>
              {/* §93: PalCert does not know it found everything, and says so. */}
              <p className="hint">{messages.notExhaustive}</p>
              <dl className="extraction-provenance">
                <dt>{messages.modelLabel}</dt>
                <dd>{latestRun.providerReturnedModel ?? latestRun.configuredModel}</dd>
                {latestRun.extractionRunHash !== null && (
                  <>
                    <dt>{messages.runHashLabel}</dt>
                    <dd>
                      <code>{latestRun.extractionRunHash}</code>
                    </dd>
                  </>
                )}
              </dl>
            </>
          )}
        </div>
      )}

      {runs.length > 1 && (
        <p className="hint">
          {messages.previousRuns}: {runs.length - 1}. {messages.runSupersededNotice}
        </p>
      )}

      {canRunExtraction && isDraft && consentGranted && readySources.length > 0 && (
        <>
          <AIServiceFee state={fee} locale={locale} organizationScoped />
          <button
            type="button"
            className="button"
            disabled={
              starting ||
              fee.quote === null ||
              fee.short ||
              fee.unavailable ||
              (latestRun !== null && !SETTLED_RUN.has(latestRun.status))
            }
            onClick={() => void startRun()}
          >
            {starting ? messages.starting : messages.startExtraction}
          </button>
        </>
      )}
    </section>
  );
}

export type { ExtractionMessages };
