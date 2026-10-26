'use client';

import { useParams } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';
import { FormError, FormSuccess } from '@/components/auth-form';
import { OrganizationShell, type OrganizationShellState } from '@/components/organization-shell';
import {
  RuleBuilder,
  draftFromRule,
  emptyRuleDraft,
  type FieldIssue,
  type RuleDraft,
} from '@/components/rule-builder';
import { Icon } from '@/components/ui/icon';
import { PageHeader } from '@/components/ui/page-header';
import { VersionManagement } from '@/components/standards-manage';
import { ExportStandardButton, ImportProvenanceCard } from '@/components/standard-transfer';
import {
  PublishVersionButton,
  VersionRecordCard,
  formatVersionDate,
} from '@/components/version-lifecycle';
import { LoadingState } from '@/components/ui/states';
import { StatusBadge } from '@/components/ui/status-badge';
import { versionTone } from '@/lib/status-tone';
import { RuleList } from '@/components/rule-list';
import { RuleProposalList } from '@/components/rule-proposals';
import { RuleProvenancePanel } from '@/components/rule-provenance';
import { StandardSourcesPanel } from '@/components/standard-sources';
import { getAuthMessages } from '@/i18n/auth-messages';
import { getExtractionMessages } from '@/i18n/extraction-messages';
import { getStandardsMessages } from '@/i18n/standards-messages';
import {
  ApiError,
  extractionApi,
  revisionFromETag,
  standardsApi,
  type ExtractionCountersResponse,
  type ExtractionRunResponse,
  type RuleResponse,
  type RuleSchemaResponse,
  type StandardVersionResponse,
  type StandardVersionValidationResponse,
} from '@/lib/api-client';

function VersionEditor({ organizationId, permissions, locale }: OrganizationShellState) {
  const params = useParams();
  const standardId = typeof params.standardId === 'string' ? params.standardId : '';
  const versionId = typeof params.versionId === 'string' ? params.versionId : '';

  const messages = getStandardsMessages(locale);
  const auth = getAuthMessages(locale);
  const extraction = getExtractionMessages(locale);

  const [schema, setSchema] = useState<RuleSchemaResponse | null>(null);
  const [version, setVersion] = useState<StandardVersionResponse | null>(null);
  const [rules, setRules] = useState<RuleResponse[]>([]);
  const [validation, setValidation] = useState<StandardVersionValidationResponse | null>(null);

  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [issues, setIssues] = useState<readonly FieldIssue[]>([]);
  const [editing, setEditing] = useState<{ draft: RuleDraft; ruleId: string | null } | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [cloneLabel, setCloneLabel] = useState('');
  const [latestRun, setLatestRun] = useState<ExtractionRunResponse | null>(null);
  const [counters, setCounters] = useState<ExtractionCountersResponse | null>(null);
  // Off by default: upgrading the schema a clone is judged by is the author's
  // decision, never a side effect of copying.
  const [upgradeSchema, setUpgradeSchema] = useState(false);

  const canWriteRules = permissions.has('standard:rule:write');
  const canPublish = permissions.has('standard:version:publish');
  const canCreateVersion = permissions.has('standard:version:create');

  // Phase 9. Reading sources, deciding on proposals and committing the
  // institution to external processing are three different permissions on
  // purpose: doing the work does not carry the authority to agree to it (§16).
  const canManageSources = permissions.has('standard:source:create');
  const canRunExtraction = permissions.has('standard:extraction:run');
  const canDecideProposals = permissions.has('standard:proposal:decide');
  const canReadExtraction = permissions.has('standard:extraction:read');
  const canManageConsent = permissions.has('organization:ai-consent:manage');

  const describe = useCallback(
    (caught: unknown): string =>
      caught instanceof ApiError
        ? (messages.errors[caught.code] ?? caught.message ?? auth.genericError)
        : auth.genericError,
    [auth, messages],
  );

  const load = useCallback(async (): Promise<void> => {
    try {
      const [loadedVersion, rulePage] = await Promise.all([
        standardsApi.version(organizationId, standardId, versionId),
        standardsApi.rules(organizationId, standardId, versionId, { limit: 100 }),
      ]);
      setVersion(loadedVersion);
      // A verdict describes the draft it was reached on. Once the draft is
      // reloaded — a rule added, deleted, accepted from a proposal — it may no
      // longer be true, and "ready to publish" beside "Rules 0" was exactly that.
      setValidation(null);
      setRules(rulePage.items);
    } catch (caught) {
      setError(describe(caught));
    }
    // Counters are advisory: a version page that failed to render because the
    // extraction counts were unavailable would be a worse page (§156).
    if (!canReadExtraction) return;
    try {
      setCounters(await extractionApi.counters(organizationId, versionId));
    } catch {
      setCounters(null);
    }
  }, [canReadExtraction, describe, organizationId, standardId, versionId]);

  useEffect(() => {
    void standardsApi
      .ruleSchema()
      .then(setSchema)
      .catch((caught: unknown) => setError(describe(caught)));
  }, [describe]);

  useEffect(() => {
    void load();
  }, [load]);

  /**
   * Run a draft mutation.
   *
   * Every one of these bumps the version's revision, so the local copy is
   * refreshed afterwards — sending a stale `If-Match` on the next edit would
   * be refused with a 412 the author did nothing to deserve.
   */
  async function mutate(action: () => Promise<{ etag: string | null }>): Promise<void> {
    if (version === null) return;
    setError(null);
    setNotice(null);
    setIssues([]);
    setSubmitting(true);
    try {
      const result = await action();
      setVersion({ ...version, revision: revisionFromETag(result.etag, version.revision + 1) });
      await load();
      setNotice(messages.saved);
      setEditing(null);
    } catch (caught) {
      if (caught instanceof ApiError && caught.code === 'RULE_SCHEMA_INVALID') {
        // Field-level problems belong beside the fields, not in the banner.
        const reported = (caught.details?.issues ?? []) as FieldIssue[];
        setIssues(reported);
      }
      setError(describe(caught));
    } finally {
      setSubmitting(false);
    }
  }

  async function runValidation(): Promise<void> {
    setError(null);
    setNotice(null);
    try {
      setValidation(await standardsApi.validateVersion(organizationId, standardId, versionId));
    } catch (caught) {
      setError(describe(caught));
    }
  }

  function publishFailed(caught: unknown): void {
    if (caught instanceof ApiError && caught.code === 'STANDARD_VERSION_INVALID') {
      setValidation({
        valid: false,
        ruleCount: rules.length,
        issues: (caught.details?.issues ?? []) as StandardVersionValidationResponse['issues'],
      });
    }
    setError(describe(caught));
  }

  if (schema === null || version === null) {
    return error !== null ? <FormError message={error} /> : <LoadingState label={auth.sending} />;
  }

  const isDraft = version.status === 'DRAFT';
  const editable = isDraft && canWriteRules;
  const bannerState =
    version.status === 'DRAFT'
      ? 'draft'
      : version.status === 'SUPERSEDED'
        ? 'superseded'
        : version.status === 'ARCHIVED'
          ? 'archived'
          : 'published';

  return (
    <>
      <PageHeader
        title={
          <>
            {messages.versionLabel} <bdi>{version.versionLabel}</bdi>{' '}
            <StatusBadge
              status={version.status}
              tone={versionTone(version.status)}
              label={messages.versionStatuses[version.status] ?? version.status}
            />
          </>
        }
        actions={
          <>
            <button type="button" className="secondary" onClick={() => void runValidation()}>
              {messages.validate}
            </button>
            <ExportStandardButton
              organizationId={organizationId}
              standardId={standardId}
              version={version}
              locale={locale}
            />
            {isDraft && canPublish && (
              <PublishVersionButton
                organizationId={organizationId}
                standardId={standardId}
                version={version}
                locale={locale}
                onPublished={async (message) => {
                  setError(null);
                  setNotice(message);
                  await load();
                }}
                onError={(caught) => {
                  setNotice(null);
                  publishFailed(caught);
                }}
              />
            )}
          </>
        }
      />

      {/* Published and draft must never be mistaken for each other: one is
          what documents are checked against and is frozen, the other is
          work in progress that no check ever uses. */}
      <p className="pc-version-banner" data-state={bannerState}>
        <Icon name={isDraft ? 'standard' : 'lock'} size={18} />
        {isDraft
          ? messages.draftVersionNotice
          : version.status === 'SUPERSEDED'
            ? messages.lifecycle.supersededNotice(
                version.supersededByVersionLabel ?? '—',
                version.supersededAt === null
                  ? '—'
                  : formatVersionDate(version.supersededAt, locale),
              )
            : version.status === 'ARCHIVED'
              ? messages.lifecycle.archivedNotice
              : messages.publishedVersionReadOnly}
      </p>

      <ImportProvenanceCard version={version} locale={locale} />

      <VersionManagement
        locale={locale}
        organizationId={organizationId}
        standardId={standardId}
        version={version}
        permissions={permissions}
        onChanged={async (message) => {
          setError(null);
          setNotice(message);
          await load();
        }}
      />

      {error !== null && <FormError message={error} />}
      {notice !== null && <FormSuccess message={notice} />}

      {/*
        §155: publishing with proposals still undecided is allowed — they are
        not part of the standard and never were — but a reviewer about to
        freeze a version should be told that what they left is being left.
      */}
      {isDraft && canPublish && (counters?.pendingProposals ?? 0) > 0 && (
        <p className="pc-notice" role="status">
          {extraction.publishWithPendingProposals}
        </p>
      )}

      {validation !== null && (
        <div className="pc-validation" role="status">
          {validation.valid ? (
            <FormSuccess message={messages.validationPassed} />
          ) : (
            <>
              <FormError message={messages.validationFailed} />
              <ul>
                {validation.issues.map((issue) => (
                  <li key={`${issue.ruleCode ?? ''}:${issue.path}:${issue.code}`}>
                    <code>{issue.ruleCode ?? '—'}</code> · <code>{issue.path}</code> ·{' '}
                    {messages.errors[issue.code] ?? issue.message}
                  </li>
                ))}
              </ul>
            </>
          )}
        </div>
      )}

      <div className="pc-detail-grid">
        <div className="pc-detail-main">
          <section aria-labelledby="rules-heading">
            <div className="pc-section-heading">
              <h2 id="rules-heading">{messages.rules}</h2>

              {editable && editing === null && (
                <button
                  type="button"
                  className="pc-btn-sm"
                  onClick={() => setEditing({ draft: emptyRuleDraft(schema), ruleId: null })}
                >
                  {messages.addRule}
                </button>
              )}
            </div>

            {editing !== null && (
              <RuleBuilder
                schema={schema}
                messages={messages}
                initial={editing.draft}
                issues={issues}
                submitting={submitting}
                ruleSchemaVersion={version.ruleSchemaVersion}
                onCancel={() => {
                  setEditing(null);
                  setIssues([]);
                }}
                onSubmit={(payload) => {
                  void mutate(() =>
                    editing.ruleId === null
                      ? standardsApi.createRule(
                          organizationId,
                          standardId,
                          versionId,
                          version.revision,
                          payload,
                        )
                      : standardsApi.updateRule(
                          organizationId,
                          standardId,
                          versionId,
                          editing.ruleId,
                          version.revision,
                          payload,
                        ),
                  );
                }}
              />
            )}

            <RuleList
              rules={rules}
              messages={messages}
              editable={editable}
              onEdit={(rule) => {
                setIssues([]);
                setEditing({ draft: draftFromRule(rule, schema), ruleId: rule.id });
              }}
              onDelete={(rule) => {
                void mutate(() =>
                  standardsApi.deleteRule(
                    organizationId,
                    standardId,
                    versionId,
                    rule.id,
                    version.revision,
                  ),
                );
              }}
              onReorder={(ruleIds) => {
                void mutate(() =>
                  standardsApi.reorderRules(
                    organizationId,
                    standardId,
                    versionId,
                    version.revision,
                    ruleIds,
                  ),
                );
              }}
            />
          </section>

          {/*
        Phase 9 sits below the rules, not above them: the standard is the
        page's subject, and extraction is a way of writing it rather than a
        thing that happens to it (§129).
      */}
          {canReadExtraction && (
            <StandardSourcesPanel
              organizationId={organizationId}
              versionId={versionId}
              locale={locale}
              isDraft={isDraft}
              canManageSources={canManageSources}
              canRunExtraction={canRunExtraction}
              canManageConsent={canManageConsent}
              onRunCompleted={setLatestRun}
            />
          )}

          {canReadExtraction && (
            <RuleProvenancePanel
              organizationId={organizationId}
              versionId={versionId}
              locale={locale}
              rules={rules}
            />
          )}
        </div>

        <div className="pc-detail-side">
          <section className="pc-card" aria-labelledby="version-facts-heading">
            <h2 id="version-facts-heading" className="pc-card-title">
              {messages.versionLabel} <bdi>{version.versionLabel}</bdi>
            </h2>
            <dl className="pc-summary">
              <dt>{messages.rules}</dt>
              <dd>{version.ruleCount}</dd>
              <dt>{messages.revision}</dt>
              <dd>{version.revision}</dd>
            </dl>
            {version.contentHash !== null && (
              <div className="pc-hash-block">
                <p className="pc-hash-label">{messages.contentHash}</p>
                <code className="pc-hash">{version.contentHash}</code>
                <p className="pc-hint">{messages.contentHashHint}</p>
              </div>
            )}
          </section>

          <VersionRecordCard
            organizationId={organizationId}
            standardId={standardId}
            version={version}
            locale={locale}
            canReadMembers={permissions.has('organization:member:read')}
          />

          {counters !== null && (
            <section className="pc-card" aria-labelledby="extraction-counters-heading">
              <h2 id="extraction-counters-heading" className="pc-card-title">
                {extraction.sectionTitle}
              </h2>
              <dl className="pc-stat-list pc-stat-list-compact">
                {Object.entries(counters).map(([key, value]) => (
                  <div key={key}>
                    <dt>{extraction.counterLabels[key] ?? key}</dt>
                    <dd>{value}</dd>
                  </div>
                ))}
              </dl>
            </section>
          )}

          {!isDraft && canCreateVersion && (
            <section className="pc-card" aria-labelledby="clone-heading">
              <h2 id="clone-heading" className="pc-card-title">
                {messages.cloneVersion}
              </h2>
              <form
                className="pc-form"
                onSubmit={(event) => {
                  event.preventDefault();
                  void standardsApi
                    .cloneVersion(organizationId, standardId, versionId, cloneLabel, upgradeSchema)
                    .then(() => {
                      setNotice(messages.saved);
                      setCloneLabel('');
                      setUpgradeSchema(false);
                    })
                    .catch((caught: unknown) => setError(describe(caught)));
                }}
              >
                <p className="pc-hint">
                  {version.status === 'PUBLISHED'
                    ? messages.cloneHint
                    : messages.lifecycle.cloneHistoricalHint}
                </p>
                <div className="pc-field">
                  <label htmlFor="cloneLabel">{messages.versionLabel}</label>
                  <input
                    id="cloneLabel"
                    value={cloneLabel}
                    onChange={(event) => setCloneLabel(event.target.value)}
                    required
                  />
                </div>
                {version.ruleSchemaVersion < schema.ruleSchemaVersion && (
                  <div className="pc-field">
                    <label className="pc-check" htmlFor="upgradeRuleSchema">
                      <input
                        id="upgradeRuleSchema"
                        type="checkbox"
                        checked={upgradeSchema}
                        onChange={(event) => setUpgradeSchema(event.target.checked)}
                      />
                      {messages.upgradeRuleSchema}
                    </label>
                    <p className="pc-hint">
                      {messages.upgradeRuleSchemaHint(
                        version.ruleSchemaVersion,
                        schema.ruleSchemaVersion,
                      )}
                    </p>
                  </div>
                )}
                <button type="submit">{messages.cloneVersion}</button>
              </form>
            </section>
          )}
        </div>
      </div>

      {/*
        The review console takes the page's full width: a real reading produces
        a hundred or more proposals, and a dense table needs the room the
        side column would otherwise take.
      */}
      {canReadExtraction && latestRun !== null && latestRun.status === 'COMPLETED' && (
        <RuleProposalList
          organizationId={organizationId}
          versionId={versionId}
          runId={latestRun.id}
          locale={locale}
          revision={version.revision}
          canDecide={canDecideProposals && isDraft}
          onDecided={() => {
            void load();
          }}
        />
      )}
    </>
  );
}

export default function VersionEditorPage() {
  return <OrganizationShell>{(state) => <VersionEditor {...state} />}</OrganizationShell>;
}
