'use client';

import { useCallback, useState } from 'react';
import type { Locale } from '@/i18n/locales';
import { getSubmissionsMessages } from '@/i18n/submissions-messages';
import {
  ApiError,
  submissionsApi,
  type SubmissionDisclosureResponse,
  type SubmissionRevisionResponse,
  type SubmissionTechnicalSummaryResponse,
} from '@/lib/api-client';

/** The slice of the client these components use, so a test can supply its own. */
export type SubmissionApi = {
  readonly disclosure: typeof submissionsApi.disclosure;
  readonly submit: typeof submissionsApi.submit;
};

const DEFAULT_API: SubmissionApi = {
  disclosure: submissionsApi.disclosure,
  submit: submissionsApi.submit,
};

function describe(caught: unknown, locale: Locale): string {
  const messages = getSubmissionsMessages(locale);
  return caught instanceof ApiError
    ? (messages.errors[caught.code] ?? messages.genericError)
    : messages.genericError;
}

/** The technical result, labelled as PalCert's and never as a decision (§82). */
export function TechnicalSummary({
  locale,
  technical,
}: {
  locale: Locale;
  technical: SubmissionTechnicalSummaryResponse;
}) {
  const messages = getSubmissionsMessages(locale);
  return (
    <section className="pc-card" aria-labelledby="technical-heading">
      <h3 id="technical-heading">{messages.technicalTitle}</h3>
      <p className="pc-hint">{messages.technicalHint}</p>
      <dl className="pc-definitions">
        <dt>{messages.determinationLabel}</dt>
        <dd>{technical.determination}</dd>
        {technical.score === null ? null : (
          <>
            <dt>{messages.scoreLabel}</dt>
            <dd>{technical.score}</dd>
          </>
        )}
        <dt>{messages.queueResult}</dt>
        <dd>{messages.ruleCounts(technical.passedRules, technical.totalRules)}</dd>
      </dl>
    </section>
  );
}

/**
 * The disclosure, and the button (§20, §21, §86).
 *
 * Deliberately two steps. Reading what would be shared is not submitting, and
 * the submit button does not exist until the reader has been shown the list —
 * both the list of what goes and the list of what stays.
 */
export function SubmitSection({
  locale,
  checkId,
  api = DEFAULT_API,
  onSubmitted,
}: {
  locale: Locale;
  checkId: string;
  api?: SubmissionApi;
  onSubmitted?: (revision: SubmissionRevisionResponse) => void;
}) {
  const messages = getSubmissionsMessages(locale);

  const [disclosure, setDisclosure] = useState<SubmissionDisclosureResponse | null>(null);
  const [revision, setRevision] = useState<SubmissionRevisionResponse | null>(null);
  const [showing, setShowing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // §96: one key per attempt at this check, so a double-click or a retried
  // request is the same submission rather than a second handoff.
  const [idempotencyKey] = useState(() => crypto.randomUUID());

  const reveal = useCallback(async () => {
    setError(null);
    setBusy(true);
    try {
      setDisclosure(await api.disclosure(checkId));
      setShowing(true);
    } catch (caught) {
      setError(describe(caught, locale));
    } finally {
      setBusy(false);
    }
  }, [api, checkId, locale]);

  const submit = useCallback(async () => {
    setError(null);
    setBusy(true);
    try {
      const created = await api.submit(checkId, idempotencyKey);
      setRevision(created);
      setShowing(false);
      onSubmitted?.(created);
    } catch (caught) {
      setError(describe(caught, locale));
    } finally {
      setBusy(false);
    }
  }, [api, checkId, idempotencyKey, locale, onSubmitted]);

  if (revision !== null) {
    return (
      <section className="pc-card" aria-labelledby="submitted-heading">
        <h3 id="submitted-heading">{messages.title}</h3>
        <p>{messages.processingStatuses[revision.processingStatus]}</p>
        <p className="pc-hint">{messages.processingHints[revision.processingStatus]}</p>
      </section>
    );
  }

  return (
    <section className="pc-card" aria-labelledby="submit-heading">
      <h3 id="submit-heading">{messages.title}</h3>
      <p>{messages.intro}</p>
      {error === null ? null : <p role="alert">{error}</p>}

      {!showing || disclosure === null ? (
        <button type="button" onClick={() => void reveal()} disabled={busy}>
          {messages.disclosureTitle}
        </button>
      ) : (
        <div>
          <h4>{messages.disclosureTitle}</h4>
          <p>{messages.disclosureIntro(disclosure.organizationName)}</p>

          <h5>{messages.willShare}</h5>
          <ul>
            {disclosure.shared.map((key) => (
              <li key={key}>{messages.sharedItems[key] ?? key}</li>
            ))}
          </ul>

          <h5>{messages.willNotShare}</h5>
          <ul>
            {disclosure.notShared.map((key) => (
              <li key={key}>{messages.notSharedItems[key] ?? key}</li>
            ))}
          </ul>

          <p className="pc-hint">{messages.submitHint}</p>
          <button type="button" onClick={() => void submit()} disabled={busy}>
            {busy ? messages.submitting : messages.submit}
          </button>
          <button type="button" onClick={() => setShowing(false)} disabled={busy}>
            {messages.cancel}
          </button>
        </div>
      )}
    </section>
  );
}

/** The institution's decision, and the history behind it (§88, §89). */
export function DecisionHistory({
  locale,
  events,
}: {
  locale: Locale;
  events: readonly {
    id: string;
    eventSource: string;
    fromStatus: string | null;
    toStatus: string;
    reasonCode: string | null;
    createdAt: string;
  }[];
}) {
  const messages = getSubmissionsMessages(locale);
  const when = new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short' });

  return (
    <section className="pc-card" aria-labelledby="history-heading">
      <h2 id="history-heading" className="pc-card-title">
        {messages.historyTitle}
      </h2>
      <ol className="pc-timeline">
        {events.map((event) => (
          <li
            key={event.id}
            data-tone={
              event.toStatus === 'APPROVED'
                ? 'success'
                : event.toStatus === 'REJECTED'
                  ? 'danger'
                  : event.toStatus === 'REVISION_REQUESTED'
                    ? 'warning'
                    : undefined
            }
          >
            <strong>{messages.displayStatuses[event.toStatus] ?? event.toStatus}</strong>{' '}
            <span className="pc-hint">
              {event.eventSource === 'SYSTEM'
                ? messages.historyBySystem
                : messages.historyByInstitution}
            </span>{' '}
            <time dateTime={event.createdAt}>{when.format(new Date(event.createdAt))}</time>
            {event.reasonCode === null ? null : (
              <span> — {messages.reasonCodes[event.reasonCode] ?? event.reasonCode}</span>
            )}
          </li>
        ))}
      </ol>
    </section>
  );
}

/** The institution's comments, as the author reads them (§67). */
export function InstitutionComments({
  locale,
  comments,
}: {
  locale: Locale;
  comments: readonly { id: string; body: string; createdAt: string }[];
}) {
  const messages = getSubmissionsMessages(locale);
  const when = new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short' });

  return (
    <section className="pc-card" aria-labelledby="comments-heading">
      <h3 id="comments-heading">{messages.commentsTitle}</h3>
      {comments.length === 0 ? (
        <p>{messages.commentsEmpty}</p>
      ) : (
        <ul>
          {comments.map((comment) => (
            <li key={comment.id}>
              <p>{comment.body}</p>
              <time dateTime={comment.createdAt}>{when.format(new Date(comment.createdAt))}</time>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/** A short, copyable digest. Truncated for reading, complete in the title. */
export function Digest({ value }: { value: string | null }) {
  if (value === null || value === '') return <span>—</span>;
  return (
    <code title={value}>
      {value.length > 20 ? `${value.slice(0, 12)}…${value.slice(-6)}` : value}
    </code>
  );
}
