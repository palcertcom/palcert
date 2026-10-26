'use client';

import { useCallback, useEffect, useId, useMemo, useRef, useState, type MouseEvent } from 'react';
import { Dialog } from '@/components/ui/dialog';
import { StatusBadge } from '@/components/ui/status-badge';
import { getExtractionMessages } from '@/i18n/extraction-messages';
import type { Locale } from '@/i18n/locales';
import { formatMessage, getReviewConsoleMessages } from '@/i18n/review-console-messages';
import {
  ApiError,
  extractionApi,
  revisionFromETag,
  type RuleProposalDetailResponse,
  type RuleProposalResponse,
  type SourceEvidenceResponse,
  type TemplateObservationResponse,
} from '@/lib/api-client';

/** The server's limit on one bulk request; larger selections go in chunks. */
export const BULK_CHUNK = 200;
export const PAGE_SIZES = [25, 50, 100] as const;

export interface RuleProposalListProps {
  readonly organizationId: string;
  readonly versionId: string;
  readonly runId: string;
  readonly locale: Locale;
  readonly revision: number;
  readonly canDecide: boolean;
  /** Called after any decision, so the page can reload rules and the revision. */
  readonly onDecided?: (revision: number) => void;
  readonly api?: Pick<
    typeof extractionApi,
    | 'proposals'
    | 'proposal'
    | 'acceptProposal'
    | 'rejectProposal'
    | 'acceptSelected'
    | 'rejectSelected'
  >;
}

// ---------------------------------------------------------------------------
// What a proposal is, for the table
// ---------------------------------------------------------------------------

const ACCEPTED_STATUSES = new Set(['ACCEPTED', 'MODIFIED_AND_ACCEPTED', 'ACCEPTED_WITH_EDITS']);
const RULE_KINDS = new Set(['EXPLICIT_REQUIREMENT', 'TEMPLATE_INFERENCE']);

export function isPending(proposal: RuleProposalResponse): boolean {
  return proposal.status === 'PENDING_REVIEW' && proposal.decision === null;
}

/**
 * A proposal "Accept all valid" may send: pending, a kind that is a rule,
 * PalCert's own validation passed, a rule actually present, and no conflict.
 * The server checks all of it again; this only decides what is offered.
 */
export function isReadyToAccept(proposal: RuleProposalResponse): boolean {
  return (
    isPending(proposal) &&
    RULE_KINDS.has(proposal.kind) &&
    proposal.validationStatus === 'VALID' &&
    proposal.suggestedRule !== null &&
    proposal.conflict.status === 'NONE'
  );
}

export function cannotBeExpressed(proposal: RuleProposalResponse): boolean {
  return proposal.suggestedRule === null || proposal.kind === 'UNREPRESENTABLE_REQUIREMENT';
}

function ruleField(proposal: RuleProposalResponse, key: string): unknown {
  return proposal.suggestedRule === null ? undefined : proposal.suggestedRule[key];
}

export function proposalCategory(proposal: RuleProposalResponse): string | null {
  const category = ruleField(proposal, 'category');
  return typeof category === 'string' ? category : null;
}

function proposalTitle(proposal: RuleProposalResponse, locale: Locale): string | null {
  const title = ruleField(proposal, locale === 'ar' ? 'titleAr' : 'titleEn');
  return typeof title === 'string' && title !== '' ? title : null;
}

function proposalProperty(proposal: RuleProposalResponse): string | null {
  const scope = ruleField(proposal, 'scope');
  if (scope !== null && typeof scope === 'object') {
    const property = (scope as Record<string, unknown>).property;
    if (typeof property === 'string') return property;
  }
  return proposal.summary?.observation?.property ?? null;
}

const OPERATOR_SYMBOLS: Readonly<Record<string, string>> = {
  EQUALS: '=',
  NOT_EQUALS: '≠',
  GREATER_THAN: '>',
  GREATER_THAN_OR_EQUAL: '≥',
  LESS_THAN: '<',
  LESS_THAN_OR_EQUAL: '≤',
};

const UNIT_SYMBOLS: Readonly<Record<string, string>> = {
  MILLIMETRE: 'mm',
  CENTIMETRE: 'cm',
  INCH: 'in',
  POINT: 'pt',
  PIXEL: 'px',
  LINES: 'lines',
  WORDS: 'words',
  CHARACTERS: 'chars',
  PAGES: 'pages',
  MEGABYTE: 'MB',
  DPI: 'dpi',
  COUNT: '',
};

function unitSymbol(unit: unknown): string {
  if (typeof unit !== 'string') return '';
  return UNIT_SYMBOLS[unit] ?? unit;
}

/** "= 30 mm", as the rule states it. Technical, so shown LTR. */
export function formatExpected(rule: Record<string, unknown> | null): string | null {
  if (rule === null) return null;
  const expected = rule.expected as Record<string, unknown> | undefined;
  if (expected === undefined || expected === null || typeof expected !== 'object') return null;
  let value: string;
  if ('number' in expected) value = String(expected.number);
  else if ('text' in expected) value = JSON.stringify(expected.text);
  else if ('boolean' in expected) value = String(expected.boolean);
  else if ('min' in expected || 'max' in expected)
    value = `${String(expected.min ?? '…')}–${String(expected.max ?? '…')}`;
  else if (Array.isArray(expected.values)) value = (expected.values as unknown[]).join(', ');
  else if ('pattern' in expected)
    value = [expected.pattern, expected.argument].filter((part) => part !== undefined).join(' ');
  else value = '';
  const operator =
    typeof rule.operator === 'string' ? (OPERATOR_SYMBOLS[rule.operator] ?? rule.operator) : '';
  const unit = unitSymbol(rule.unit);
  return [operator, value, unit].filter((part) => part !== '').join(' ');
}

function formatObserved(proposal: RuleProposalResponse): string | null {
  const observation = proposal.summary?.observation;
  if (observation === null || observation === undefined || observation.modalValue === null) {
    return null;
  }
  return [observation.modalValue, unitSymbol(observation.unit)]
    .filter((part) => part !== '')
    .join(' ');
}

export type ReviewView = 'all' | 'waiting' | 'valid' | 'cannotExpress' | 'accepted' | 'rejected';

const VIEWS: Readonly<Record<ReviewView, (proposal: RuleProposalResponse) => boolean>> = {
  all: () => true,
  waiting: isPending,
  valid: isReadyToAccept,
  cannotExpress: cannotBeExpressed,
  accepted: (proposal) => ACCEPTED_STATUSES.has(proposal.status),
  rejected: (proposal) => proposal.status === 'REJECTED',
};

export interface ReviewFilters {
  readonly view: ReviewView;
  readonly search: string;
  readonly kind: string;
  readonly status: string;
  readonly category: string;
  readonly uniformity: string;
}

export const NO_FILTERS: ReviewFilters = {
  view: 'all',
  search: '',
  kind: '',
  status: '',
  category: '',
  uniformity: '',
};

export function filterProposals(
  proposals: readonly RuleProposalResponse[],
  filters: ReviewFilters,
): RuleProposalResponse[] {
  const needle = filters.search.trim().toLowerCase();
  return proposals.filter((proposal) => {
    if (!VIEWS[filters.view](proposal)) return false;
    if (filters.kind !== '' && proposal.kind !== filters.kind) return false;
    if (filters.status !== '') {
      const accepted = filters.status === 'ACCEPTED' && ACCEPTED_STATUSES.has(proposal.status);
      if (!accepted && proposal.status !== filters.status) return false;
    }
    if (filters.category !== '' && proposalCategory(proposal) !== filters.category) return false;
    if (
      filters.uniformity !== '' &&
      proposal.summary?.observation?.uniformity !== filters.uniformity
    ) {
      return false;
    }
    if (needle === '') return true;
    const haystack = [
      proposal.suggestedRuleCode,
      ruleField(proposal, 'titleEn'),
      ruleField(proposal, 'titleAr'),
      proposalProperty(proposal),
    ]
      .filter((value): value is string => typeof value === 'string')
      .join('\n')
      .toLowerCase();
    return haystack.includes(needle);
  });
}

export type SortKey = 'ruleCode' | 'type' | 'value' | 'evidence' | 'source' | 'status';
export interface SortOrder {
  readonly key: SortKey;
  readonly direction: 'asc' | 'desc';
}

function sortValue(proposal: RuleProposalResponse, key: SortKey): string | number {
  switch (key) {
    case 'ruleCode':
      return proposal.suggestedRuleCode ?? '';
    case 'type':
      return `${proposalCategory(proposal) ?? ''} ${proposal.kind}`;
    case 'value':
      return formatExpected(proposal.suggestedRule) ?? formatObserved(proposal) ?? '';
    case 'evidence':
      return proposal.evidenceIds.length + proposal.observationIds.length;
    case 'source':
      return proposal.summary?.sources[0]?.sourceFilename ?? '';
    case 'status':
      return proposal.status;
  }
}

export function sortProposals(
  proposals: readonly RuleProposalResponse[],
  order: SortOrder | null,
): RuleProposalResponse[] {
  const sorted = [...proposals];
  if (order === null) return sorted.sort((a, b) => a.displayOrder - b.displayOrder);
  const sign = order.direction === 'asc' ? 1 : -1;
  return sorted.sort((a, b) => {
    const left = sortValue(a, order.key);
    const right = sortValue(b, order.key);
    const compared =
      typeof left === 'number' && typeof right === 'number'
        ? left - right
        : String(left).localeCompare(String(right));
    return compared === 0 ? a.displayOrder - b.displayOrder : sign * compared;
  });
}

function chunks<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let index = 0; index < items.length; index += size)
    out.push(items.slice(index, index + size));
  return out;
}

// ---------------------------------------------------------------------------
// The console
// ---------------------------------------------------------------------------

type Confirming =
  | { readonly mode: 'accept'; readonly ids: readonly string[]; readonly leftOut: number }
  | { readonly mode: 'reject'; readonly ids: readonly string[]; readonly leftOut: number };

interface BulkOutcome {
  readonly accepted: number;
  readonly rejected: number;
  readonly skipped: readonly { id: string; reason: string }[];
}

/**
 * The review console (§96, §97, §98, §130).
 *
 * A real reading produces a hundred or more proposals, so they are a dense,
 * searchable table rather than a column of cards. What made the cards worth
 * having is kept one click away: the detail panel still puts PalCert's reading
 * beside the source's own words and the template's measurements, still shows
 * a refused proposal unchanged with its reasons, and still never preselects a
 * side in a conflict.
 *
 * Bulk decisions are explicit and counted: the dialog says exactly how many
 * proposals will be decided, and "Accept all valid" can only ever send
 * proposals that carry a rule PalCert's own validator passed — and the server
 * checks that again.
 */
export function RuleProposalList({
  organizationId,
  versionId,
  runId,
  locale,
  revision,
  canDecide,
  onDecided,
  api = extractionApi,
}: RuleProposalListProps) {
  const messages = getExtractionMessages(locale);
  const text = getReviewConsoleMessages(locale);
  const searchId = useId();
  const pageSizeId = useId();
  const reasonId = useId();
  const notesId = useId();

  const [proposals, setProposals] = useState<RuleProposalResponse[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [details, setDetails] = useState<Record<string, RuleProposalDetailResponse>>({});
  const [expanded, setExpanded] = useState<string | null>(null);
  const [filters, setFilters] = useState<ReviewFilters>(NO_FILTERS);
  const [order, setOrder] = useState<SortOrder | null>(null);
  const [page, setPage] = useState(0);
  const [pageSize, setPageSize] = useState<number>(PAGE_SIZES[0]);
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [outcome, setOutcome] = useState<BulkOutcome | null>(null);
  const [confirming, setConfirming] = useState<Confirming | null>(null);
  const [bulkReason, setBulkReason] = useState('NOT_A_REQUIREMENT');
  const [bulkNotes, setBulkNotes] = useState('');
  // The draft revision decisions are made against. A ref, because a bulk
  // action chains several requests and each must see the one before it.
  const revisionRef = useRef(revision);
  useEffect(() => {
    revisionRef.current = revision;
  }, [revision]);

  const describe = useCallback(
    (caught: unknown): string =>
      caught instanceof ApiError
        ? (messages.errors[caught.code] ?? messages.genericError)
        : messages.genericError,
    [messages],
  );

  // One request for the list. The evidence behind a row is fetched when that
  // row is opened, not a request per proposal up front.
  const load = useCallback(async (): Promise<void> => {
    try {
      setProposals(await api.proposals(organizationId, versionId, runId));
    } catch (caught) {
      setError(describe(caught));
    } finally {
      setLoaded(true);
    }
  }, [api, describe, organizationId, runId, versionId]);

  useEffect(() => {
    void load();
  }, [load]);

  const openDetail = useCallback(
    async (proposalId: string): Promise<void> => {
      if (details[proposalId] !== undefined) return;
      try {
        const detail = await api.proposal(organizationId, versionId, runId, proposalId);
        setDetails((current) => ({ ...current, [proposalId]: detail }));
      } catch (caught) {
        setError(describe(caught));
      }
    },
    [api, describe, details, organizationId, runId, versionId],
  );

  function toggleExpanded(proposalId: string): void {
    const next = expanded === proposalId ? null : proposalId;
    setExpanded(next);
    if (next !== null) void openDetail(next);
  }

  function moveRevision(next: number): void {
    revisionRef.current = next;
  }

  // --- derived ---------------------------------------------------------------

  const counts = useMemo(
    () => ({
      all: proposals.length,
      waiting: proposals.filter(VIEWS.waiting).length,
      valid: proposals.filter(VIEWS.valid).length,
      cannotExpress: proposals.filter(VIEWS.cannotExpress).length,
      accepted: proposals.filter(VIEWS.accepted).length,
      rejected: proposals.filter(VIEWS.rejected).length,
    }),
    [proposals],
  );
  const filtered = useMemo(
    () => sortProposals(filterProposals(proposals, filters), order),
    [filters, order, proposals],
  );
  const pages = Math.max(1, Math.ceil(filtered.length / pageSize));
  const currentPage = Math.min(page, pages - 1);
  const visible = filtered.slice(currentPage * pageSize, (currentPage + 1) * pageSize);
  const byId = useMemo(() => new Map(proposals.map((p) => [p.id, p])), [proposals]);

  const kinds = useMemo(() => [...new Set(proposals.map((p) => p.kind))].sort(), [proposals]);
  const categories = useMemo(
    () =>
      [...new Set(proposals.map(proposalCategory).filter((c): c is string => c !== null))].sort(),
    [proposals],
  );

  const pageIds = visible.map((proposal) => proposal.id);
  const pageSelected = pageIds.filter((id) => selected.has(id)).length;
  const headerCheckbox = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (headerCheckbox.current !== null) {
      headerCheckbox.current.indeterminate = pageSelected > 0 && pageSelected < pageIds.length;
    }
  }, [pageSelected, pageIds.length]);

  function updateFilters(change: Partial<ReviewFilters>): void {
    setFilters((current) => ({ ...current, ...change }));
    setPage(0);
  }

  function toggleSort(key: SortKey): void {
    setOrder((current) =>
      current === null || current.key !== key
        ? { key, direction: 'asc' }
        : current.direction === 'asc'
          ? { key, direction: 'desc' }
          : null,
    );
    setPage(0);
  }

  function toggleSelected(proposalId: string, checked: boolean): void {
    setSelected((current) => {
      const next = new Set(current);
      if (checked) next.add(proposalId);
      else next.delete(proposalId);
      return next;
    });
  }

  function selectPage(checked: boolean): void {
    setSelected((current) => {
      const next = new Set(current);
      for (const id of pageIds) {
        if (checked) next.add(id);
        else next.delete(id);
      }
      return next;
    });
  }

  // --- single decisions ------------------------------------------------------

  async function acceptOne(proposalId: string): Promise<void> {
    setBusy(proposalId);
    setError(null);
    try {
      const result = await api.acceptProposal(
        organizationId,
        versionId,
        runId,
        proposalId,
        revisionRef.current,
      );
      setProposals((current) =>
        current.map((item) => (item.id === proposalId ? { ...item, ...result.data } : item)),
      );
      const next = revisionFromETag(result.etag, revisionRef.current + 1);
      moveRevision(next);
      onDecided?.(next);
    } catch (caught) {
      setError(describe(caught));
    } finally {
      setBusy(null);
    }
  }

  async function rejectOne(proposalId: string, reason: string, notes: string): Promise<void> {
    setBusy(proposalId);
    setError(null);
    try {
      const updated = await api.rejectProposal(organizationId, versionId, runId, proposalId, {
        ...(reason === '' ? {} : { reason }),
        ...(notes === '' ? {} : { reviewNotes: notes }),
      });
      setProposals((current) =>
        current.map((item) => (item.id === proposalId ? { ...item, ...updated } : item)),
      );
      onDecided?.(revisionRef.current);
    } catch (caught) {
      setError(describe(caught));
    } finally {
      setBusy(null);
    }
  }

  // --- bulk decisions --------------------------------------------------------

  function askAccept(ids: readonly string[]): void {
    const eligible = ids.filter((id) => {
      const proposal = byId.get(id);
      return proposal !== undefined && isReadyToAccept(proposal);
    });
    setOutcome(null);
    if (eligible.length === 0) {
      setError(text.nothingToAccept);
      return;
    }
    setError(null);
    setConfirming({ mode: 'accept', ids: eligible, leftOut: ids.length - eligible.length });
  }

  function askReject(ids: readonly string[]): void {
    const eligible = ids.filter((id) => {
      const proposal = byId.get(id);
      return proposal !== undefined && isPending(proposal);
    });
    setOutcome(null);
    if (eligible.length === 0) {
      setError(text.nothingToReject);
      return;
    }
    setError(null);
    setBulkReason('NOT_A_REQUIREMENT');
    setBulkNotes('');
    setConfirming({ mode: 'reject', ids: eligible, leftOut: ids.length - eligible.length });
  }

  async function runBulk(action: Confirming): Promise<void> {
    setConfirming(null);
    setBusy('bulk');
    setError(null);
    let accepted = 0;
    let rejected = 0;
    const skipped: { id: string; reason: string }[] = [];
    try {
      for (const chunk of chunks(action.ids, BULK_CHUNK)) {
        if (action.mode === 'accept') {
          const result = await api.acceptSelected(
            organizationId,
            versionId,
            runId,
            chunk,
            revisionRef.current,
          );
          accepted += result.data.accepted.length;
          skipped.push(...result.data.skipped);
          moveRevision(
            revisionFromETag(result.etag, revisionRef.current + result.data.accepted.length),
          );
          // The draft moved under the reviewer: stop rather than decide
          // anything more against a view nobody saw.
          if (result.data.skipped.some((entry) => entry.reason === 'STALE_STANDARD_REVISION')) {
            break;
          }
        } else {
          const result = await api.rejectSelected(organizationId, versionId, runId, chunk, {
            reason: bulkReason,
            ...(bulkNotes.trim() === '' ? {} : { reviewNotes: bulkNotes.trim() }),
          });
          rejected += result.rejected.length;
          skipped.push(...result.skipped);
        }
      }
    } catch (caught) {
      setError(describe(caught));
    } finally {
      setOutcome({ accepted, rejected, skipped });
      setSelected(new Set());
      setBusy(null);
      await load();
      onDecided?.(revisionRef.current);
    }
  }

  // --- render ----------------------------------------------------------------

  if (!loaded) return null;

  if (proposals.length === 0) {
    return (
      <section className="rule-proposals">
        <h3>{messages.proposalsTitle}</h3>
        {error !== null ? <p role="alert">{error}</p> : <p>{messages.noProposals}</p>}
      </section>
    );
  }

  const chipOrder: ReviewView[] = [
    'all',
    'waiting',
    'valid',
    'cannotExpress',
    'accepted',
    'rejected',
  ];
  const columnCount = canDecide ? 8 : 7;
  const firstShown = filtered.length === 0 ? 0 : currentPage * pageSize + 1;
  const lastShown = Math.min(filtered.length, (currentPage + 1) * pageSize);

  const sortHeader = (key: SortKey, label: string) => {
    const active = order?.key === key;
    return (
      <th
        scope="col"
        aria-sort={active ? (order.direction === 'asc' ? 'ascending' : 'descending') : 'none'}
      >
        <button type="button" className="review-sort" onClick={() => toggleSort(key)}>
          {label}
          <span aria-hidden="true" className="review-sort-mark">
            {active ? (order.direction === 'asc' ? '▲' : '▼') : '↕'}
          </span>
          {active && (
            <span className="pc-visually-hidden">
              {' '}
              ({order.direction === 'asc' ? text.sortAscending : text.sortDescending})
            </span>
          )}
        </button>
      </th>
    );
  };

  return (
    <section className="rule-proposals review-console" aria-labelledby={`${searchId}-title`}>
      <header className="review-console-title">
        <h3 id={`${searchId}-title`}>{messages.proposalsTitle}</h3>
        <p className="hint">{messages.proposalsSubtitle}</p>
      </header>

      {/* The summary and the run-wide actions stay in view while the table
          scrolls under them. */}
      <div className="review-console-head">
        <div className="pc-toolbar review-chips" role="group" aria-label={text.summaryLabel}>
          {chipOrder.map((view) => (
            <button
              key={view}
              type="button"
              className="pc-chip"
              aria-pressed={filters.view === view}
              onClick={() => updateFilters({ view })}
            >
              {text.chips[view]}
              <span className="review-chip-count">{counts[view]}</span>
            </button>
          ))}
        </div>

        {canDecide && (
          <div className="pc-toolbar review-bulk-all">
            <button
              type="button"
              className="button"
              disabled={busy !== null || counts.valid === 0}
              onClick={() => askAccept(proposals.filter(isReadyToAccept).map((p) => p.id))}
            >
              {formatMessage(text.acceptAllValid, { count: counts.valid })}
            </button>
            <button
              type="button"
              className="button secondary"
              disabled={busy !== null || counts.waiting === 0}
              onClick={() => askReject(proposals.filter(isPending).map((p) => p.id))}
            >
              {formatMessage(text.rejectAllPending, { count: counts.waiting })}
            </button>
          </div>
        )}
      </div>

      {error !== null && (
        <p role="alert" className="pc-alert pc-alert-error">
          {error}
        </p>
      )}

      {outcome !== null && (
        <div role="status" className="pc-alert pc-alert-success review-outcome">
          <p>
            {outcome.accepted > 0 &&
              formatMessage(text.resultAccepted, { count: outcome.accepted })}{' '}
            {outcome.rejected > 0 &&
              formatMessage(text.resultRejected, { count: outcome.rejected })}
          </p>
          {outcome.skipped.length > 0 && (
            <>
              <p>{formatMessage(text.resultSkipped, { count: outcome.skipped.length })}</p>
              <ul className="skipped-proposals">
                {summarizeSkipped(outcome.skipped).map(([reason, count]) => (
                  <li key={reason}>
                    {count} × {messages.errors[reason] ?? reason}
                  </li>
                ))}
              </ul>
            </>
          )}
        </div>
      )}

      {/* --- search and filters ---------------------------------------------- */}
      <div className="review-filters">
        <div className="pc-field review-search">
          <label htmlFor={searchId}>{text.searchLabel}</label>
          <input
            id={searchId}
            type="search"
            value={filters.search}
            placeholder={text.searchPlaceholder}
            onChange={(event) => updateFilters({ search: event.target.value })}
          />
        </div>
        <FilterSelect
          label={text.filterKind}
          value={filters.kind}
          any={text.filterAny}
          options={kinds.map((kind) => [kind, messages.proposalKinds[kind] ?? kind])}
          onChange={(kind) => updateFilters({ kind })}
        />
        <FilterSelect
          label={text.filterStatus}
          value={filters.status}
          any={text.filterAny}
          options={['PENDING_REVIEW', 'ACCEPTED', 'REJECTED'].map((status) => [
            status,
            text.statusLabels[status] ?? status,
          ])}
          onChange={(status) => updateFilters({ status })}
        />
        <FilterSelect
          label={text.filterCategory}
          value={filters.category}
          any={text.filterAny}
          options={categories.map((category) => [category, category])}
          ltrOptions
          onChange={(category) => updateFilters({ category })}
        />
        <FilterSelect
          label={text.filterUniformity}
          value={filters.uniformity}
          any={text.filterAny}
          options={Object.entries(text.uniformityFilterLabels)}
          onChange={(uniformity) => updateFilters({ uniformity })}
        />
        {(filters.search !== '' ||
          filters.kind !== '' ||
          filters.status !== '' ||
          filters.category !== '' ||
          filters.uniformity !== '' ||
          filters.view !== 'all') && (
          <button
            type="button"
            className="pc-button-quiet"
            onClick={() => updateFilters(NO_FILTERS)}
          >
            {text.clearFilters}
          </button>
        )}
      </div>

      {canDecide && (
        <div className="pc-toolbar review-selection-tools">
          <button
            type="button"
            className="pc-button-quiet"
            disabled={filtered.length === 0}
            onClick={() => setSelected(new Set([...selected, ...filtered.map((p) => p.id)]))}
          >
            {formatMessage(text.selectAllMatching, { count: filtered.length })}
          </button>
        </div>
      )}

      {/* --- the table ------------------------------------------------------- */}
      <div className="pc-table-scroll review-table-scroll">
        <table className="pc-table review-table">
          <caption className="pc-visually-hidden">{text.tableCaption}</caption>
          <thead>
            <tr>
              {canDecide && (
                <th scope="col" className="review-select-cell">
                  <input
                    ref={headerCheckbox}
                    type="checkbox"
                    aria-label={text.selectPage}
                    checked={pageIds.length > 0 && pageSelected === pageIds.length}
                    disabled={pageIds.length === 0}
                    onChange={(event) => selectPage(event.target.checked)}
                  />
                </th>
              )}
              {sortHeader('ruleCode', text.columns.ruleCode)}
              {sortHeader('type', text.columns.type)}
              {sortHeader('value', text.columns.value)}
              {sortHeader('evidence', text.columns.evidence)}
              {sortHeader('source', text.columns.source)}
              {sortHeader('status', text.columns.status)}
              <th scope="col">{text.columns.actions}</th>
            </tr>
          </thead>
          <tbody>
            {visible.length === 0 && (
              <tr>
                <td colSpan={columnCount}>{text.noMatches}</td>
              </tr>
            )}
            {visible.map((proposal) => (
              <ProposalRow
                key={proposal.id}
                proposal={proposal}
                detail={details[proposal.id] ?? null}
                expanded={expanded === proposal.id}
                locale={locale}
                canDecide={canDecide}
                busy={busy !== null}
                selected={selected.has(proposal.id)}
                columnCount={columnCount}
                onToggle={() => toggleExpanded(proposal.id)}
                onSelect={(checked) => toggleSelected(proposal.id, checked)}
                onAccept={() => void acceptOne(proposal.id)}
                onReject={(reason, notes) => void rejectOne(proposal.id, reason, notes)}
              />
            ))}
          </tbody>
        </table>
      </div>

      {/* --- pagination ------------------------------------------------------ */}
      <nav className="review-pagination" aria-label={text.paginationLabel}>
        <div className="pc-field review-page-size">
          <label htmlFor={pageSizeId}>{text.rowsPerPage}</label>
          <select
            id={pageSizeId}
            value={pageSize}
            onChange={(event) => {
              setPageSize(Number(event.target.value));
              setPage(0);
            }}
          >
            {PAGE_SIZES.map((size) => (
              <option key={size} value={size}>
                {size}
              </option>
            ))}
          </select>
        </div>
        <p className="review-page-range" aria-live="polite">
          {formatMessage(text.showing, { from: firstShown, to: lastShown, total: filtered.length })}
          {' · '}
          {formatMessage(text.pageOf, { page: currentPage + 1, pages })}
        </p>
        <div className="review-page-buttons">
          <button
            type="button"
            className="button secondary"
            disabled={currentPage === 0}
            onClick={() => setPage(currentPage - 1)}
          >
            {text.previousPage}
          </button>
          <button
            type="button"
            className="button secondary"
            disabled={currentPage >= pages - 1}
            onClick={() => setPage(currentPage + 1)}
          >
            {text.nextPage}
          </button>
        </div>
      </nav>

      {/* --- the sticky bulk bar --------------------------------------------- */}
      {canDecide && selected.size > 0 && (
        <div className="review-bulk-bar" role="region" aria-label={text.bulkBarLabel}>
          <strong aria-live="polite">
            {formatMessage(text.selectedCount, { count: selected.size })}
          </strong>
          <button
            type="button"
            className="button"
            disabled={busy !== null}
            onClick={() => askAccept([...selected])}
          >
            {text.acceptSelected}
          </button>
          <button
            type="button"
            className="button secondary"
            disabled={busy !== null}
            onClick={() => askReject([...selected])}
          >
            {text.rejectSelected}
          </button>
          <button
            type="button"
            className="pc-button-quiet"
            disabled={busy !== null}
            onClick={() => setSelected(new Set())}
          >
            {text.clearSelection}
          </button>
          {busy === 'bulk' && <span role="status">{text.working}</span>}
        </div>
      )}

      {/* --- confirmation, with the exact count ------------------------------ */}
      <Dialog
        open={confirming !== null}
        closeLabel={text.close}
        onClose={() => setConfirming(null)}
        title={
          confirming === null
            ? ''
            : formatMessage(
                confirming.mode === 'accept' ? text.confirmAcceptTitle : text.confirmRejectTitle,
                { count: confirming.ids.length },
              )
        }
        description={
          confirming === null ? undefined : (
            <>
              <p>
                {confirming.mode === 'accept' ? text.confirmAcceptBody : text.confirmRejectBody}
              </p>
              {confirming.leftOut > 0 && (
                <p className="hint">
                  {formatMessage(
                    confirming.mode === 'accept'
                      ? text.confirmAcceptLeftOut
                      : text.confirmRejectLeftOut,
                    { count: confirming.leftOut },
                  )}
                </p>
              )}
            </>
          )
        }
      >
        {confirming !== null && (
          <form
            className="pc-form"
            onSubmit={(event) => {
              event.preventDefault();
              void runBulk(confirming);
            }}
          >
            {confirming.mode === 'reject' && (
              <>
                <div className="pc-field">
                  <label htmlFor={reasonId}>{messages.rejectionReasonLabel}</label>
                  <select
                    id={reasonId}
                    value={bulkReason}
                    onChange={(event) => setBulkReason(event.target.value)}
                  >
                    {Object.entries(messages.rejectionReasons).map(([value, label]) => (
                      <option key={value} value={value}>
                        {label}
                      </option>
                    ))}
                  </select>
                </div>
                <div className="pc-field">
                  <label htmlFor={notesId}>{messages.reviewNotesLabel}</label>
                  <textarea
                    id={notesId}
                    value={bulkNotes}
                    maxLength={2000}
                    onChange={(event) => setBulkNotes(event.target.value)}
                  />
                  <p className="hint">{messages.reviewNotesHint}</p>
                </div>
              </>
            )}
            <div className="pc-actions">
              <button
                type="button"
                className="button secondary"
                onClick={() => setConfirming(null)}
              >
                {text.cancel}
              </button>
              <button
                type="submit"
                className={confirming.mode === 'accept' ? 'button' : 'button pc-danger'}
              >
                {formatMessage(
                  confirming.mode === 'accept'
                    ? text.confirmAcceptButton
                    : text.confirmRejectButton,
                  { count: confirming.ids.length },
                )}
              </button>
            </div>
          </form>
        )}
      </Dialog>
    </section>
  );
}

function summarizeSkipped(skipped: readonly { reason: string }[]): [string, number][] {
  const counts = new Map<string, number>();
  for (const entry of skipped) counts.set(entry.reason, (counts.get(entry.reason) ?? 0) + 1);
  return [...counts.entries()];
}

function FilterSelect({
  label,
  value,
  any,
  options,
  ltrOptions = false,
  onChange,
}: {
  readonly label: string;
  readonly value: string;
  readonly any: string;
  readonly options: readonly (readonly [string, string])[];
  readonly ltrOptions?: boolean;
  readonly onChange: (value: string) => void;
}) {
  const id = useId();
  return (
    <div className="pc-field review-filter">
      <label htmlFor={id}>{label}</label>
      <select id={id} value={value} onChange={(event) => onChange(event.target.value)}>
        <option value="">{any}</option>
        {options.map(([optionValue, optionLabel]) => (
          <option key={optionValue} value={optionValue} dir={ltrOptions ? 'ltr' : undefined}>
            {optionLabel}
          </option>
        ))}
      </select>
    </div>
  );
}

// ---------------------------------------------------------------------------
// One row, and its detail
// ---------------------------------------------------------------------------

interface ProposalRowProps {
  readonly proposal: RuleProposalResponse;
  readonly detail: RuleProposalDetailResponse | null;
  readonly expanded: boolean;
  readonly locale: Locale;
  readonly canDecide: boolean;
  readonly busy: boolean;
  readonly selected: boolean;
  readonly columnCount: number;
  readonly onToggle: () => void;
  readonly onSelect: (checked: boolean) => void;
  readonly onAccept: () => void;
  readonly onReject: (reason: string, notes: string) => void;
}

const INTERACTIVE = 'button, input, select, textarea, a, label';

function ProposalRow({
  proposal,
  detail,
  expanded,
  locale,
  canDecide,
  busy,
  selected,
  columnCount,
  onToggle,
  onSelect,
  onAccept,
  onReject,
}: ProposalRowProps) {
  const messages = getExtractionMessages(locale);
  const text = getReviewConsoleMessages(locale);
  const detailId = useId();

  const code = proposal.suggestedRuleCode;
  const title = proposalTitle(proposal, locale);
  const category = proposalCategory(proposal);
  const expected = formatExpected(proposal.suggestedRule);
  const observed = formatObserved(proposal);
  const observation = proposal.summary?.observation ?? null;
  const sources = proposal.summary?.sources ?? [];
  const ready = isReadyToAccept(proposal);

  function onRowClick(event: MouseEvent<HTMLTableRowElement>): void {
    if ((event.target as HTMLElement).closest(INTERACTIVE) !== null) return;
    onToggle();
  }

  return (
    <>
      <tr
        className="review-row"
        data-expanded={expanded}
        data-selected={selected}
        onClick={onRowClick}
      >
        {canDecide && (
          <td className="review-select-cell" data-label={text.columns.select}>
            <input
              type="checkbox"
              checked={selected}
              aria-label={formatMessage(text.selectRow, {
                code: code ?? messages.proposalKinds[proposal.kind] ?? proposal.kind,
              })}
              onChange={(event) => onSelect(event.target.checked)}
            />
          </td>
        )}
        <td data-label={text.columns.ruleCode} className="review-code-cell">
          {code !== null ? (
            <code dir="ltr">{code}</code>
          ) : (
            <span className="hint">{text.noRuleCode}</span>
          )}
          {title !== null && <span className="review-title">{title}</span>}
        </td>
        <td data-label={text.columns.type}>
          {category !== null && (
            <code dir="ltr" className="review-category">
              {category}
            </code>
          )}
          <span className="review-kind">
            {messages.proposalKinds[proposal.kind] ?? proposal.kind}
          </span>
        </td>
        <td data-label={text.columns.value}>
          {observed !== null && (
            <span className="review-value">
              {text.observedPrefix}: <bdi dir="ltr">{observed}</bdi>
            </span>
          )}
          {expected !== null && (
            <span className="review-value">
              {text.expectedPrefix}: <bdi dir="ltr">{expected}</bdi>
            </span>
          )}
          {observed === null && expected === null && <span className="hint">—</span>}
        </td>
        <td data-label={text.columns.evidence}>
          {proposal.evidenceIds.length > 0 && (
            <span className="review-value">
              {formatMessage(text.passages, { count: proposal.evidenceIds.length })}
            </span>
          )}
          {proposal.observationIds.length > 0 && (
            <span className="review-value">
              {formatMessage(text.measurements, { count: proposal.observationIds.length })}
            </span>
          )}
          {observation !== null && (
            <span className="hint">
              {text.uniformityFilterLabels[observation.uniformity] ?? observation.uniformity}
            </span>
          )}
        </td>
        <td data-label={text.columns.source} className="review-source-cell">
          {sources.length === 0 ? (
            <span className="hint">—</span>
          ) : (
            <bdi>
              {sources[0]!.sourceFilename}
              {sources.length > 1 && ` +${sources.length - 1}`}
            </bdi>
          )}
        </td>
        <td data-label={text.columns.status}>
          <span className="review-badges">
            <StatusBadge
              label={text.statusLabels[proposal.status] ?? proposal.status}
              tone={
                ACCEPTED_STATUSES.has(proposal.status)
                  ? 'success'
                  : proposal.status === 'REJECTED'
                    ? 'neutral'
                    : 'gold'
              }
            />
            {proposal.validationStatus === 'INVALID' && (
              <StatusBadge label={text.invalidBadge} tone="danger" />
            )}
            {proposal.conflict.status !== 'NONE' && (
              <StatusBadge label={text.conflictBadge} tone="warning" />
            )}
          </span>
        </td>
        <td data-label={text.columns.actions}>
          <span className="pc-row-actions">
            <button
              type="button"
              className="pc-button-quiet pc-btn-sm"
              aria-expanded={expanded}
              aria-controls={detailId}
              onClick={onToggle}
            >
              {expanded ? text.hideDetails : text.details}
            </button>
            {canDecide && ready && (
              <button type="button" className="button pc-btn-sm" disabled={busy} onClick={onAccept}>
                {messages.accept}
              </button>
            )}
          </span>
        </td>
      </tr>
      {expanded && (
        <tr className="review-detail-row">
          <td colSpan={columnCount} id={detailId}>
            <ProposalDetail
              proposal={proposal}
              detail={detail}
              locale={locale}
              canDecide={canDecide}
              busy={busy}
              onAccept={onAccept}
              onReject={onReject}
            />
          </td>
        </tr>
      )}
    </>
  );
}

function ProposalDetail({
  proposal,
  detail,
  locale,
  canDecide,
  busy,
  onAccept,
  onReject,
}: {
  readonly proposal: RuleProposalResponse;
  readonly detail: RuleProposalDetailResponse | null;
  readonly locale: Locale;
  readonly canDecide: boolean;
  readonly busy: boolean;
  readonly onAccept: () => void;
  readonly onReject: (reason: string, notes: string) => void;
}) {
  const messages = getExtractionMessages(locale);
  const text = getReviewConsoleMessages(locale);
  const reasonId = useId();
  const notesId = useId();
  const [reason, setReason] = useState('NOT_A_REQUIREMENT');
  const [notes, setNotes] = useState('');

  const decided = !isPending(proposal);
  const conflicting = proposal.kind === 'CONFLICTING_REQUIREMENT';
  const sources = proposal.summary?.sources ?? [];

  return (
    <div className={`review-detail proposal-${proposal.kind.toLowerCase()}`}>
      <div className="review-detail-main">
        <section>
          {/* "Stated in the guidelines" and "observed in the template" call
              for different decisions, so the kind is read first (§46). */}
          <h4>{messages.proposalKinds[proposal.kind] ?? proposal.kind}</h4>
          <p className="hint">{messages.proposalKindHints[proposal.kind]}</p>
        </section>

        <section className="proposal-interpretation">
          <h5>{messages.interpretation}</h5>
          <p>{locale === 'ar' ? proposal.interpretationAr : proposal.interpretationEn}</p>
          {/* §127: PalCert's wording, never presented as the institution's. */}
          <p className="hint">{messages.interpretationIsTranslation}</p>
        </section>

        {proposal.requiresClarification && (
          <p className="proposal-clarification">
            {proposal.ambiguityNote ?? ''} {messages.clarificationNeeded}
          </p>
        )}
        {proposal.kind === 'UNREPRESENTABLE_REQUIREMENT' && (
          <p className="hint">{messages.unrepresentableExplanation}</p>
        )}

        {detail === null ? (
          <p className="hint" role="status">
            {text.loadingDetail}
          </p>
        ) : (
          <>
            {detail.evidence.length > 0 && (
              <section className="proposal-evidence">
                <h5>{messages.evidenceTitle}</h5>
                {detail.evidence.map((evidence) => (
                  <EvidenceQuote key={evidence.id} evidence={evidence} locale={locale} />
                ))}
              </section>
            )}
            {detail.observations.length > 0 && (
              <section className="proposal-observations">
                <h5>{messages.observationTitle}</h5>
                {detail.observations.map((observation) => (
                  <ObservationMeasurement
                    key={observation.id}
                    observation={observation}
                    locale={locale}
                  />
                ))}
                {/* Next to the numbers it qualifies (§4, §33). */}
                <p className="hint">{messages.observationNotARequirement}</p>
              </section>
            )}
          </>
        )}

        {conflicting && (
          <section className="proposal-conflict" role="note">
            <h5>{messages.conflictTitle}</h5>
            <p>{messages.conflictExplanation}</p>
            <p className="hint">{messages.conflictResolveYourself}</p>
          </section>
        )}
        {proposal.conflict.status !== 'NONE' && !conflicting && (
          <p className="proposal-conflict" role="note">
            {messages.conflictWithExistingRule}{' '}
            {proposal.conflict.existingRuleCode !== null && (
              <code dir="ltr">{proposal.conflict.existingRuleCode}</code>
            )}
          </p>
        )}
      </div>

      <aside className="review-detail-side">
        <dl className="review-facts">
          <dt>{text.detailSources}</dt>
          <dd>
            {sources.length === 0
              ? '—'
              : sources.map((source) => (
                  <bdi key={source.sourceAssetId} className="review-fact-line">
                    {source.sourceFilename}
                  </bdi>
                ))}
          </dd>
          {proposal.summary?.observation !== null &&
            proposal.summary?.observation !== undefined && (
              <>
                <dt>{text.detailOccurrences}</dt>
                <dd>
                  {formatMessage(text.occurrences, {
                    matching: proposal.summary.observation.matchingCount,
                    total: proposal.summary.observation.occurrenceCount,
                  })}
                </dd>
                <dt>{text.detailUniformity}</dt>
                <dd>
                  {text.uniformityFilterLabels[proposal.summary.observation.uniformity] ??
                    proposal.summary.observation.uniformity}
                </dd>
              </>
            )}
          <dt>{text.detailCanCheck}</dt>
          <dd>
            {messages.automationSupportLabels[proposal.automationSupport] ??
              proposal.automationSupport}
          </dd>
          <dt>{text.detailValidation}</dt>
          <dd>
            {proposal.validationStatus === 'INVALID' || proposal.validationIssues.length > 0 ? (
              <>
                <span>{messages.invalidProposalTitle}</span>
                <ul className="review-issues">
                  {proposal.validationIssues.map((issue, index) => (
                    <li key={index}>
                      <code dir="ltr">{issue.path}</code> — {issue.message}
                    </li>
                  ))}
                </ul>
              </>
            ) : (
              text.detailNoIssues
            )}
          </dd>
        </dl>

        {decided ? (
          <div className="proposal-decision" role="status">
            <p>{text.statusLabels[proposal.status] ?? proposal.status}</p>
            {(proposal.status === 'MODIFIED_AND_ACCEPTED' ||
              proposal.status === 'ACCEPTED_WITH_EDITS') && (
              // §65, §66: both versions are kept; history is never rewritten.
              <p className="hint">{messages.acceptedAsEdited}</p>
            )}
            {proposal.decision !== null && (
              <p className="hint">
                {messages.decidedOn}{' '}
                <time dateTime={proposal.decision.reviewedAt}>
                  {new Date(proposal.decision.reviewedAt).toLocaleString(locale)}
                </time>
              </p>
            )}
          </div>
        ) : (
          canDecide && (
            <div className="proposal-actions">
              {isReadyToAccept(proposal) && (
                <button type="button" className="button" disabled={busy} onClick={onAccept}>
                  {messages.accept}
                </button>
              )}
              <div className="proposal-rejection">
                <div className="pc-field">
                  <label htmlFor={reasonId}>{messages.rejectionReasonLabel}</label>
                  <select
                    id={reasonId}
                    value={reason}
                    onChange={(event) => setReason(event.target.value)}
                  >
                    {Object.entries(messages.rejectionReasons).map(([value, label]) => (
                      <option key={value} value={value}>
                        {label}
                      </option>
                    ))}
                  </select>
                </div>
                <div className="pc-field">
                  <label htmlFor={notesId}>{messages.reviewNotesLabel}</label>
                  <textarea
                    id={notesId}
                    value={notes}
                    maxLength={2000}
                    onChange={(event) => setNotes(event.target.value)}
                  />
                  {/* §70: said before they write, not left to assume. */}
                  <p className="hint">{messages.reviewNotesHint}</p>
                </div>
                <button
                  type="button"
                  className="button secondary"
                  disabled={busy}
                  onClick={() => onReject(reason, notes)}
                >
                  {messages.reject}
                </button>
              </div>
            </div>
          )
        )}
      </aside>
    </div>
  );
}

function EvidenceQuote({
  evidence,
  locale,
}: {
  readonly evidence: SourceEvidenceResponse;
  readonly locale: Locale;
}) {
  const messages = getExtractionMessages(locale);
  return (
    <figure className="evidence">
      {/* The source's own words, rendered as text by React — never as markup,
          whatever a guideline document happens to contain (§152). */}
      <blockquote>{evidence.excerpt}</blockquote>
      <figcaption className="hint">
        {messages.evidenceFrom} <bdi>{evidence.sourceFilename}</bdi>
        {evidence.startPage !== null && `, ${messages.evidencePage} ${evidence.startPage}`}
        {evidence.nodeIds.length > 0 && `, ${messages.evidenceNode} ${evidence.nodeIds.length}`}
      </figcaption>
    </figure>
  );
}

function ObservationMeasurement({
  observation,
  locale,
}: {
  readonly observation: TemplateObservationResponse;
  readonly locale: Locale;
}) {
  const messages = getExtractionMessages(locale);
  return (
    <div className="observation">
      <p>
        <strong dir="ltr">{observation.property}</strong>
        {observation.modalValue !== null && (
          <bdi dir="ltr">
            {`: ${observation.modalValue}`}
            {observation.unit !== null && ` ${observation.unit}`}
          </bdi>
        )}
      </p>
      {/* The counts, not a verdict and never a percentage (§33, §34, §147). */}
      <p className="observation-counts">
        {observation.matchingCount} {messages.observationCounts} {observation.occurrenceCount}
      </p>
      <p className="hint">
        {messages.uniformityLabels[observation.uniformity] ?? observation.uniformity}
      </p>
      <p className="hint">
        {messages.observationObservedIn} <bdi>{observation.sourceFilename}</bdi>
      </p>
    </div>
  );
}
