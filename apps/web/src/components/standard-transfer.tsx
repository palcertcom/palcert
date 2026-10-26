'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useId, useMemo, useRef, useState } from 'react';
import { FormError } from '@/components/auth-form';
import { formatVersionDate } from '@/components/version-lifecycle';
import type { Locale } from '@/i18n/locales';
import { getStandardTransferMessages } from '@/i18n/standard-transfer-messages';
import { getStandardsMessages } from '@/i18n/standards-messages';
import {
  ApiError,
  standardsApi,
  type StandardImportPreviewResponse,
  type StandardVersionResponse,
} from '@/lib/api-client';

/** Mirrors the server limit so an oversized file is refused before upload. */
const MAX_PACKAGE_BYTES = 5 * 1024 * 1024;
const MAX_MB = MAX_PACKAGE_BYTES / (1024 * 1024);
const PAGE = 100;

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

/**
 * Download a version as a portable package. Offered for every status: export
 * reuses content, it does not change the version.
 */
export function ExportStandardButton({
  organizationId,
  standardId,
  version,
  locale,
}: {
  organizationId: string;
  standardId: string;
  version: StandardVersionResponse;
  locale: Locale;
}) {
  const m = getStandardTransferMessages(locale);
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);

  async function download(): Promise<void> {
    setPending(true);
    setMessage(null);
    try {
      const file = await standardsApi.exportVersion(organizationId, standardId, version.id);
      const url = URL.createObjectURL(new Blob([file.text], { type: 'application/json' }));
      const link = document.createElement('a');
      link.href = url;
      link.download = file.fileName;
      link.click();
      URL.revokeObjectURL(url);
      setMessage({ ok: true, text: m.exported(file.fileName) });
    } catch (caught) {
      setMessage({
        ok: false,
        text:
          caught instanceof ApiError
            ? (m.errors[caught.code] ?? caught.message)
            : m.errors.VALIDATION_FAILED!,
      });
    } finally {
      setPending(false);
    }
  }

  return (
    <>
      <button
        type="button"
        className="secondary"
        title={m.exportHint}
        disabled={pending}
        onClick={() => void download()}
      >
        {pending ? m.exporting : m.exportStandard}
      </button>
      {message === null ? null : (
        <span className="pc-visually-hidden" role="status">
          {message.text}
        </span>
      )}
      {message !== null && !message.ok ? (
        <p className="pc-alert pc-alert-error" role="alert">
          {message.text}
        </p>
      ) : null}
    </>
  );
}

// ---------------------------------------------------------------------------
// Provenance of an imported draft
// ---------------------------------------------------------------------------

export function ImportProvenanceCard({
  version,
  locale,
}: {
  version: StandardVersionResponse;
  locale: Locale;
}) {
  const m = getStandardTransferMessages(locale);
  // Absent as well as null: a view from before provenance existed has neither.
  const provenance = version.importProvenance ?? null;
  if (provenance === null) return null;
  const adopted = version.status !== 'DRAFT';
  return (
    <section className="pc-card transfer-provenance" aria-labelledby="import-provenance-heading">
      <h2 id="import-provenance-heading" className="pc-card-title">
        {m.provenanceTitle}
      </h2>
      <dl className="pc-summary">
        <dt>{m.importedFrom}</dt>
        <dd>
          <bdi>{provenance.sourceOrganizationName}</bdi>
        </dd>
        <dt>{m.standard}</dt>
        <dd>
          <code>{provenance.sourceStandardCode}</code>{' '}
          <bdi>
            {locale === 'ar' ? provenance.sourceStandardNameAr : provenance.sourceStandardNameEn}
          </bdi>
        </dd>
        <dt>{m.sourceVersion}</dt>
        <dd>
          <bdi>{provenance.sourceVersionLabel}</bdi>
        </dd>
        <dt>{m.sourceStatus}</dt>
        <dd>{m.statuses[provenance.sourceVersionStatus] ?? provenance.sourceVersionStatus}</dd>
        <dt>{m.imported}</dt>
        <dd>{formatVersionDate(provenance.importedAt, locale)}</dd>
      </dl>
      <p className="pc-hint">{adopted ? m.provenanceAdopted : m.provenanceNotice}</p>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Import wizard
// ---------------------------------------------------------------------------

type PreviewRule = StandardImportPreviewResponse['rules'][number];

function describeValue(rule: PreviewRule, units: Readonly<Record<string, string>>): string {
  const expected = rule.expected;
  if (expected === null) return '—';
  const unit = rule.unit === null ? '' : ` ${units[rule.unit] ?? rule.unit}`;
  const tolerance = rule.tolerance === null ? '' : ` ±${rule.tolerance}`;
  switch (expected['type']) {
    case 'NUMBER':
      return `${String(expected['number'])}${unit}${tolerance}`;
    case 'NUMBER_RANGE':
      return `${String(expected['min'])}–${String(expected['max'])}${unit}${tolerance}`;
    case 'STRING':
      return String(expected['text']);
    case 'BOOLEAN':
      return String(expected['boolean']);
    case 'STRING_LIST':
    case 'NUMBER_LIST':
      return Array.isArray(expected['values']) ? expected['values'].join(', ') : '—';
    case 'PATTERN':
      return expected['argument'] === undefined
        ? String(expected['pattern'])
        : `${String(expected['pattern'])} “${String(expected['argument'])}”`;
    default:
      return '—';
  }
}

export function StandardImportWizard({
  organizationId,
  locale,
  canCreateStandard,
}: {
  organizationId: string;
  locale: Locale;
  canCreateStandard: boolean;
}) {
  const m = getStandardTransferMessages(locale);
  const sm = getStandardsMessages(locale);
  const router = useRouter();
  const ids = { file: useId(), search: useId(), category: useId(), invalid: useId() };
  const codeRef = useRef<HTMLInputElement>(null);

  const [text, setText] = useState<string | null>(null);
  const [preview, setPreview] = useState<StandardImportPreviewResponse | null>(null);
  const [reading, setReading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [search, setSearch] = useState('');
  const [category, setCategory] = useState('');
  const [invalidOnly, setInvalidOnly] = useState(false);
  const [limit, setLimit] = useState(PAGE);
  const [open, setOpen] = useState<number | null>(null);

  const [mode, setMode] = useState<'NEW_STANDARD' | 'EXISTING_STANDARD'>('NEW_STANDARD');
  const [code, setCode] = useState('');
  const [nameEn, setNameEn] = useState('');
  const [nameAr, setNameAr] = useState('');
  const [documentTypeId, setDocumentTypeId] = useState('');
  const [standardId, setStandardId] = useState('');
  const [versionLabel, setVersionLabel] = useState('');
  const [acknowledge, setAcknowledge] = useState(false);
  const [importing, setImporting] = useState(false);

  const describe = (caught: unknown): string =>
    caught instanceof ApiError
      ? (m.errors[caught.code] ?? caught.message)
      : m.errors.VALIDATION_FAILED!;

  function reset(): void {
    setText(null);
    setPreview(null);
    setError(null);
    setSearch('');
    setCategory('');
    setInvalidOnly(false);
    setOpen(null);
    setAcknowledge(false);
  }

  async function choose(file: File | undefined): Promise<void> {
    reset();
    if (file === undefined) return;
    if (file.size > MAX_PACKAGE_BYTES) {
      setError(m.fileTooLarge(MAX_MB));
      return;
    }
    setReading(true);
    try {
      const content = await file.text();
      const result = await standardsApi.previewImport(organizationId, content);
      setText(content);
      setPreview(result);
      setCode(result.standard.code);
      setNameEn(result.standard.nameEn);
      setNameAr(result.standard.nameAr);
      setVersionLabel(result.version.versionLabel);
      setDocumentTypeId(
        result.destination.documentTypes.find((type) => type.matchesCategory)?.id ?? '',
      );
      setMode(canCreateStandard ? 'NEW_STANDARD' : 'EXISTING_STANDARD');
      setStandardId('');
    } catch (caught) {
      setError(describe(caught));
    } finally {
      setReading(false);
    }
  }

  const categories = useMemo(
    () =>
      preview === null
        ? []
        : [
            ...new Set(
              preview.rules.map((rule) => rule.category).filter((c): c is string => c !== null),
            ),
          ].sort(),
    [preview],
  );

  const filtered = useMemo(() => {
    if (preview === null) return [];
    const needle = search.trim().toLowerCase();
    return preview.rules.filter(
      (rule) =>
        (!invalidOnly || !rule.valid) &&
        (category === '' || rule.category === category) &&
        (needle === '' ||
          [rule.ruleCode, rule.titleEn, rule.titleAr].some(
            (value) => value !== null && value.toLowerCase().includes(needle),
          )),
    );
  }, [preview, search, category, invalidOnly]);

  if (preview === null || text === null) {
    return (
      <section className="pc-card pc-form-card" aria-labelledby="import-file-heading">
        <h2 id="import-file-heading" className="pc-card-title">
          {m.importTitle}
        </h2>
        <p className="pc-hint">{m.importIntro}</p>
        <div className="pc-field">
          <label htmlFor={ids.file}>{m.chooseFile}</label>
          <input
            id={ids.file}
            type="file"
            accept=".json,.palcert.json,application/json"
            disabled={reading}
            onChange={(event) => void choose(event.target.files?.[0])}
          />
          <p className="pc-hint">{m.chooseFileHint(MAX_MB)}</p>
        </div>
        {reading && <p role="status">{m.reading}</p>}
        {error !== null && <FormError message={error} />}
      </section>
    );
  }

  const existingWithCode = preview.destination.existingStandardWithCode;
  const codeCollides =
    mode === 'NEW_STANDARD' &&
    existingWithCode !== null &&
    code.trim().toUpperCase() === existingWithCode.code;
  const target =
    preview.destination.standards.find((standard) => standard.id === standardId) ?? null;
  const labelTaken =
    mode === 'EXISTING_STANDARD' &&
    target !== null &&
    target.versionLabels.includes(versionLabel.trim());
  const matchingTypes = preview.destination.documentTypes.filter((type) => type.matchesCategory);
  const latestImport = preview.previousImports[0];
  const destinationReady =
    versionLabel.trim() !== '' &&
    (mode === 'NEW_STANDARD'
      ? canCreateStandard &&
        code.trim() !== '' &&
        nameEn.trim() !== '' &&
        nameAr.trim() !== '' &&
        documentTypeId !== '' &&
        !codeCollides
      : target !== null && target.compatible && !labelTaken);
  const canSubmit =
    preview.canImport &&
    destinationReady &&
    (latestImport === undefined || acknowledge) &&
    !importing;

  async function submit(): Promise<void> {
    if (preview === null || text === null) return;
    setImporting(true);
    setError(null);
    try {
      const result = await standardsApi.importStandard(organizationId, {
        package: text,
        packageHash: preview.packageHash,
        mode,
        versionLabel: versionLabel.trim(),
        ...(mode === 'NEW_STANDARD'
          ? { code: code.trim(), nameEn: nameEn.trim(), nameAr: nameAr.trim(), documentTypeId }
          : { standardId }),
        ...(latestImport === undefined ? {} : { acknowledgeDuplicate: acknowledge }),
      });
      router.push(
        `/${locale}/organizations/${organizationId}/standards/${result.standardId}/versions/${result.versionId}`,
      );
    } catch (caught) {
      setError(describe(caught));
      setImporting(false);
    }
  }

  const shown = filtered.slice(0, limit);

  return (
    <div className="transfer-import">
      <section className="pc-card" aria-labelledby="import-summary-heading">
        <div className="pc-section-heading">
          <h2 id="import-summary-heading" className="pc-card-title">
            {m.summaryHeading}
          </h2>
          <button type="button" className="pc-btn pc-btn-secondary pc-btn-sm" onClick={reset}>
            {m.chooseAnother}
          </button>
        </div>
        <dl className="pc-summary transfer-summary" data-testid="import-summary">
          <dt>{m.source}</dt>
          <dd>
            <bdi>{preview.source.organizationName}</bdi>
          </dd>
          <dt>{m.standard}</dt>
          <dd>
            <code>{preview.standard.code}</code>{' '}
            <bdi>{locale === 'ar' ? preview.standard.nameAr : preview.standard.nameEn}</bdi>
          </dd>
          <dt>{m.exportedVersion}</dt>
          <dd>
            <bdi>{preview.source.versionLabel}</bdi> ·{' '}
            {m.statuses[preview.source.versionStatus] ?? preview.source.versionStatus}
          </dd>
          <dt>{m.exportedAt}</dt>
          <dd>{formatVersionDate(preview.exportedAt, locale)}</dd>
          <dt>{m.documentCategory}</dt>
          <dd>
            {sm.systemCategories[preview.documentType.systemCategory] ??
              preview.documentType.systemCategory}
          </dd>
          <dt>{m.rules}</dt>
          <dd data-testid="import-rule-count">
            {m.ruleCounts(preview.ruleCount, preview.validRuleCount, preview.invalidRuleCount)}
          </dd>
          <dt>{m.ruleSchema}</dt>
          <dd>
            {m.ruleSchemaValue(
              preview.schema.sourceRuleSchemaVersion,
              preview.schema.importRuleSchemaVersion,
            )}
          </dd>
          <dt>{m.integrity}</dt>
          <dd>
            <span className="transfer-ok">✓ {m.integrityVerified}</span>
            <span className="pc-hint transfer-note">{m.integrityNote}</span>
          </dd>
          <dt>{m.compatibility}</dt>
          <dd>
            {preview.canImport ? (
              <span className="transfer-ok">✓ {m.compatible}</span>
            ) : (
              <span className="transfer-bad">{m.needsAttention(preview.invalidRuleCount)}</span>
            )}
          </dd>
          <dt>{m.packageHash}</dt>
          <dd>
            <code className="pc-hash">{preview.packageHash}</code>
          </dd>
        </dl>
        {preview.warnings.length > 0 && (
          <div className="pc-notice" role="note">
            <p>
              <strong>{m.warnings}</strong>
            </p>
            <ul>
              {preview.warnings.map((warning) => (
                <li key={warning.code}>{m.warningText[warning.code] ?? warning.message}</li>
              ))}
            </ul>
          </div>
        )}
      </section>

      <section className="pc-card" aria-labelledby="import-rules-heading">
        <h2 id="import-rules-heading" className="pc-card-title">
          {m.rulesHeading}
        </h2>
        <div className="transfer-filters">
          <div className="pc-field">
            <label htmlFor={ids.search}>{m.search}</label>
            <input
              id={ids.search}
              type="search"
              value={search}
              placeholder={m.searchPlaceholder}
              onChange={(event) => {
                setSearch(event.target.value);
                setLimit(PAGE);
              }}
            />
          </div>
          <div className="pc-field">
            <label htmlFor={ids.category}>{m.filterCategory}</label>
            <select
              id={ids.category}
              value={category}
              onChange={(event) => {
                setCategory(event.target.value);
                setLimit(PAGE);
              }}
            >
              <option value="">{m.allCategories}</option>
              {categories.map((value) => (
                <option key={value} value={value}>
                  {sm.categories[value] ?? value}
                </option>
              ))}
            </select>
          </div>
          <label className="pc-check" htmlFor={ids.invalid}>
            <input
              id={ids.invalid}
              type="checkbox"
              checked={invalidOnly}
              onChange={(event) => {
                setInvalidOnly(event.target.checked);
                setLimit(PAGE);
              }}
            />
            {m.invalidOnly}
          </label>
        </div>
        <p className="pc-hint" role="status">
          {m.showing(shown.length, filtered.length)}
        </p>
        {filtered.length === 0 ? (
          <p>{m.noMatches}</p>
        ) : (
          <table className="transfer-rules">
            <thead>
              <tr>
                <th scope="col">{m.colCode}</th>
                <th scope="col">{m.colCategory}</th>
                <th scope="col">{m.colValue}</th>
                <th scope="col">{m.colStatus}</th>
                <th scope="col">
                  <span className="pc-visually-hidden">{m.details}</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {shown.map((rule) => (
                <RuleRow
                  key={rule.index}
                  rule={rule}
                  expanded={open === rule.index}
                  onToggle={() => setOpen(open === rule.index ? null : rule.index)}
                  locale={locale}
                />
              ))}
            </tbody>
          </table>
        )}
        {filtered.length > shown.length && (
          <button type="button" className="secondary" onClick={() => setLimit(limit + PAGE)}>
            {sm.loadMore}
          </button>
        )}
      </section>

      <section className="pc-card pc-form-card" aria-labelledby="import-destination-heading">
        <h2 id="import-destination-heading" className="pc-card-title">
          {m.destinationHeading}
        </h2>
        {!preview.canImport && <FormError message={m.invalidBlocks} />}

        <fieldset className="transfer-modes">
          <legend className="pc-visually-hidden">{m.destinationHeading}</legend>
          <label className="pc-check">
            <input
              type="radio"
              name="import-mode"
              checked={mode === 'NEW_STANDARD'}
              disabled={!canCreateStandard}
              onChange={() => setMode('NEW_STANDARD')}
            />
            <span>
              {m.modeNew}
              <span className="pc-hint transfer-note">{m.modeNewHint}</span>
            </span>
          </label>
          <label className="pc-check">
            <input
              type="radio"
              name="import-mode"
              checked={mode === 'EXISTING_STANDARD'}
              onChange={() => setMode('EXISTING_STANDARD')}
            />
            <span>
              {m.modeExisting}
              <span className="pc-hint transfer-note">{m.modeExistingHint}</span>
            </span>
          </label>
        </fieldset>

        {mode === 'NEW_STANDARD' ? (
          <div className="pc-form">
            <div className="pc-field">
              <label htmlFor="import-code">{m.code}</label>
              <input
                id="import-code"
                ref={codeRef}
                value={code}
                dir="ltr"
                onChange={(event) => setCode(event.target.value)}
              />
            </div>
            {codeCollides && existingWithCode !== null && (
              <div className="pc-notice transfer-collision" role="alert">
                <p>
                  <strong>{m.codeTakenTitle}</strong>
                </p>
                <p>{m.codeTakenBody(existingWithCode.code)}</p>
                <div className="pc-actions">
                  <button
                    type="button"
                    className="secondary"
                    onClick={() => codeRef.current?.focus()}
                  >
                    {m.changeCode}
                  </button>
                  {existingWithCode.compatible && (
                    <button
                      type="button"
                      className="secondary"
                      onClick={() => {
                        setMode('EXISTING_STANDARD');
                        setStandardId(existingWithCode.id);
                      }}
                    >
                      {m.importAsVersion}
                    </button>
                  )}
                  <Link
                    className="pc-btn pc-btn-secondary"
                    href={`/${locale}/organizations/${organizationId}/standards`}
                  >
                    {m.cancel}
                  </Link>
                </div>
              </div>
            )}
            <div className="pc-field">
              <label htmlFor="import-name-en">{m.nameEn}</label>
              <input
                id="import-name-en"
                value={nameEn}
                onChange={(event) => setNameEn(event.target.value)}
              />
            </div>
            <div className="pc-field">
              <label htmlFor="import-name-ar">{m.nameAr}</label>
              <input
                id="import-name-ar"
                value={nameAr}
                dir="rtl"
                lang="ar"
                onChange={(event) => setNameAr(event.target.value)}
              />
            </div>
            <div className="pc-field">
              <label htmlFor="import-document-type">{m.documentType}</label>
              <select
                id="import-document-type"
                value={documentTypeId}
                onChange={(event) => setDocumentTypeId(event.target.value)}
              >
                <option value="">{m.chooseDocumentType}</option>
                {matchingTypes.map((type) => (
                  <option key={type.id} value={type.id}>
                    {type.name}
                  </option>
                ))}
              </select>
              {matchingTypes.length === 0 && (
                <p className="pc-hint">
                  {m.noDocumentTypeInCategory(
                    sm.systemCategories[preview.documentType.systemCategory] ??
                      preview.documentType.systemCategory,
                  )}
                </p>
              )}
            </div>
          </div>
        ) : (
          <div className="pc-form">
            <div className="pc-field">
              <label htmlFor="import-standard">{m.existingStandard}</label>
              <select
                id="import-standard"
                value={standardId}
                onChange={(event) => setStandardId(event.target.value)}
              >
                <option value="">{m.chooseStandard}</option>
                {preview.destination.standards.map((standard) => (
                  <option key={standard.id} value={standard.id} disabled={!standard.compatible}>
                    {standard.code} — {locale === 'ar' ? standard.nameAr : standard.nameEn}
                    {standard.compatible ? '' : ` (${m.incompatibleStandard})`}
                  </option>
                ))}
              </select>
              {target !== null && target.draftCount > 0 && (
                <p className="pc-hint" role="note">
                  {m.draftsAlready(target.draftCount)}
                </p>
              )}
            </div>
          </div>
        )}

        <div className="pc-field">
          <label htmlFor="import-version-label">{m.versionLabel}</label>
          <input
            id="import-version-label"
            value={versionLabel}
            maxLength={40}
            onChange={(event) => setVersionLabel(event.target.value)}
          />
          {labelTaken && <p className="pc-field-error">{m.labelTaken}</p>}
        </div>

        {latestImport !== undefined && (
          <div className="pc-notice" role="alert">
            <p>
              <strong>{m.duplicateTitle}</strong>
            </p>
            <p>{m.duplicateBody(formatVersionDate(latestImport.importedAt, locale))}</p>
            <label className="pc-check">
              <input
                type="checkbox"
                checked={acknowledge}
                onChange={(event) => setAcknowledge(event.target.checked)}
              />
              {m.acknowledgeDuplicate}
            </label>
          </div>
        )}

        <p className="pc-hint">{m.draftOnly}</p>
        {error !== null && <FormError message={error} />}
        <div className="pc-actions">
          <Link
            className="pc-btn pc-btn-secondary"
            href={`/${locale}/organizations/${organizationId}/standards`}
          >
            {m.cancel}
          </Link>
          <button
            type="button"
            className="pc-btn"
            disabled={!canSubmit}
            onClick={() => void submit()}
          >
            {importing ? m.importing : m.importButton}
          </button>
        </div>
      </section>
    </div>
  );
}

function RuleRow({
  rule,
  expanded,
  onToggle,
  locale,
}: {
  rule: PreviewRule;
  expanded: boolean;
  onToggle: () => void;
  locale: Locale;
}) {
  const m = getStandardTransferMessages(locale);
  const sm = getStandardsMessages(locale);
  const title = locale === 'ar' ? rule.titleAr : rule.titleEn;
  return (
    <>
      <tr className="transfer-rule" data-valid={rule.valid ? 'true' : 'false'}>
        <td data-label={m.colCode}>
          <code dir="ltr">{rule.ruleCode ?? '—'}</code>
          {title !== null && <span className="transfer-rule-title">{title}</span>}
        </td>
        <td data-label={m.colCategory}>
          {rule.category === null ? '—' : (sm.categories[rule.category] ?? rule.category)}
        </td>
        <td data-label={m.colValue}>
          <bdi dir="ltr">{describeValue(rule, sm.units)}</bdi>
        </td>
        <td data-label={m.colStatus}>
          <span className={rule.valid ? 'transfer-ok' : 'transfer-bad'}>
            {rule.valid ? m.valid : m.invalid}
          </span>
        </td>
        <td>
          <button
            type="button"
            className="pc-btn pc-btn-secondary pc-btn-sm"
            aria-expanded={expanded}
            onClick={onToggle}
          >
            {expanded ? m.hideDetails : m.details}
          </button>
        </td>
      </tr>
      {expanded && (
        <tr className="transfer-rule-details">
          <td colSpan={5}>
            <dl className="pc-summary">
              <dt>{m.scope}</dt>
              <dd>
                <code dir="ltr">
                  {rule.scope === null
                    ? '—'
                    : Object.entries(rule.scope)
                        .map(([key, value]) => `${key}: ${String(value)}`)
                        .join(', ')}
                </code>
              </dd>
              <dt>{m.severity}</dt>
              <dd>
                {rule.severity === null ? '—' : (sm.severities[rule.severity] ?? rule.severity)}
              </dd>
              <dt>{m.blocking}</dt>
              <dd>{rule.blocking === null ? '—' : rule.blocking ? m.yes : m.no}</dd>
              {rule.titleEn !== null && (
                <>
                  <dt>{sm.titleEn}</dt>
                  <dd>{rule.titleEn}</dd>
                </>
              )}
              {rule.titleAr !== null && (
                <>
                  <dt>{sm.titleAr}</dt>
                  <dd dir="rtl" lang="ar">
                    {rule.titleAr}
                  </dd>
                </>
              )}
            </dl>
            {rule.issues.length > 0 && (
              <>
                <p>
                  <strong>{m.issuesHeading}</strong>
                </p>
                <ul className="transfer-issues">
                  {rule.issues.map((issue) => (
                    <li key={`${issue.path}:${issue.code}:${issue.message}`}>
                      <code dir="ltr">{issue.path === '' ? 'rule' : issue.path}</code> —{' '}
                      {issue.message}
                    </li>
                  ))}
                </ul>
              </>
            )}
          </td>
        </tr>
      )}
    </>
  );
}
