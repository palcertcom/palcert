'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { Dialog } from '@/components/ui/dialog';
import type { Locale } from '@/i18n/locales';
import { getStandardsMessages } from '@/i18n/standards-messages';
import {
  organizationApi,
  standardsApi,
  type StandardVersionResponse,
  type StandardVersionUsageResponse,
} from '@/lib/api-client';

/**
 * The standard-version lifecycle, as the author meets it.
 *
 *   DRAFT ──publish──> PUBLISHED ──publish a successor──> SUPERSEDED
 *                          └──archive──> ARCHIVED
 *
 * Publishing over the version in force is one decision, taken once, in a
 * dialog that names both versions. The old version is not lost: it becomes
 * SUPERSEDED, keeps its snapshot and hash, and stays the version every past
 * check, report and certificate refers to.
 */

export function formatVersionDate(value: string, locale: Locale): string {
  return new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short' }).format(
    new Date(value),
  );
}

/** One line of history for the versions table. */
export function VersionHistoryNote({
  version,
  locale,
}: {
  version: StandardVersionResponse;
  locale: Locale;
}) {
  const m = getStandardsMessages(locale).lifecycle;
  if (version.status === 'SUPERSEDED' && version.supersededAt !== null) {
    return (
      <span className="pc-version-history">
        {m.supersededByOn(
          version.supersededByVersionLabel ?? '—',
          formatVersionDate(version.supersededAt, locale),
        )}
      </span>
    );
  }
  if (version.status === 'PUBLISHED' && version.publishedAt !== null) {
    return (
      <span className="pc-version-history">
        {m.inForceSince(formatVersionDate(version.publishedAt, locale))}
      </span>
    );
  }
  if (version.status === 'ARCHIVED' && version.archivedAt !== null) {
    return (
      <span className="pc-version-history">
        {m.archivedOn(formatVersionDate(version.archivedAt, locale))}
      </span>
    );
  }
  return <span aria-hidden="true">—</span>;
}

/**
 * Publish a draft. When another version is in force, the author confirms the
 * replacement first, and the request carries the version they confirmed: if
 * someone else published in between, the server refuses rather than replacing
 * a version this author never saw.
 */
export function PublishVersionButton({
  organizationId,
  standardId,
  version,
  locale,
  onPublished,
  onError,
}: {
  organizationId: string;
  standardId: string;
  version: StandardVersionResponse;
  locale: Locale;
  onPublished: (message: string) => Promise<void>;
  onError: (caught: unknown) => void;
}) {
  const messages = getStandardsMessages(locale);
  const m = messages.lifecycle;
  const [pending, setPending] = useState(false);
  const [confirming, setConfirming] = useState<{ id: string; label: string } | null>(null);

  async function publish(replaces: { id: string; label: string } | null): Promise<void> {
    setPending(true);
    try {
      await standardsApi.publishVersion(
        organizationId,
        standardId,
        version.id,
        replaces === null ? null : replaces.id,
      );
      setConfirming(null);
      await onPublished(
        replaces === null
          ? messages.published
          : m.publishedReplacing(version.versionLabel, replaces.label),
      );
    } catch (caught) {
      setConfirming(null);
      onError(caught);
    } finally {
      setPending(false);
    }
  }

  async function start(): Promise<void> {
    setPending(true);
    try {
      // Read what is in force now, not what the page loaded with.
      const standard = await standardsApi.standard(organizationId, standardId);
      if (
        standard.publishedVersionId !== null &&
        standard.publishedVersionId !== version.id &&
        standard.publishedVersionLabel !== null
      ) {
        setConfirming({ id: standard.publishedVersionId, label: standard.publishedVersionLabel });
        setPending(false);
        return;
      }
    } catch (caught) {
      setPending(false);
      onError(caught);
      return;
    }
    await publish(null);
  }

  return (
    <>
      <button type="button" disabled={pending} onClick={() => void start()}>
        {pending && confirming === null ? messages.publishing : messages.publish}
      </button>
      <Dialog
        open={confirming !== null}
        closeLabel={messages.manage.close}
        onClose={() => setConfirming(null)}
        title={m.confirmTitle(version.versionLabel)}
        description={
          confirming === null ? undefined : (
            <p>{m.confirmBody(confirming.label, version.versionLabel)}</p>
          )
        }
      >
        {confirming !== null && (
          <div className="pc-actions">
            <button type="button" className="button secondary" onClick={() => setConfirming(null)}>
              {messages.cancel}
            </button>
            <button
              type="button"
              className="button"
              disabled={pending}
              onClick={() => void publish(confirming)}
            >
              {pending ? messages.publishing : m.confirmReplace(confirming.label)}
            </button>
          </div>
        )}
      </Dialog>
    </>
  );
}

/**
 * The record of a version that was published: when, by whom, whether and by
 * what it was replaced, and what still relies on it.
 */
export function VersionRecordCard({
  organizationId,
  standardId,
  version,
  locale,
  canReadMembers,
}: {
  organizationId: string;
  standardId: string;
  version: StandardVersionResponse;
  locale: Locale;
  canReadMembers: boolean;
}) {
  const m = getStandardsMessages(locale).lifecycle;
  const [usage, setUsage] = useState<StandardVersionUsageResponse | null>(null);
  const [publisher, setPublisher] = useState<string | null>(null);

  const wasPublished = version.publishedAt !== null;

  useEffect(() => {
    // A draft has never been published, so nothing can rely on it yet.
    if (!wasPublished) return;
    let live = true;
    void standardsApi
      .versionUsage(organizationId, standardId, version.id)
      .then((value) => {
        if (live) setUsage(value);
      })
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [organizationId, standardId, version.id, wasPublished]);

  useEffect(() => {
    // Best effort: the person's name when the viewer may read the member list,
    // nothing otherwise. The publication record itself never depends on it.
    const userId = version.publishedByUserId;
    if (!canReadMembers || userId === null) return;
    let live = true;
    void organizationApi
      .members(organizationId, { limit: 100 })
      .then((page) => {
        if (!live) return;
        const member = page.items.find((item) => item.userId === userId);
        setPublisher(member === undefined ? m.unknownPerson : (member.displayName ?? member.email));
      })
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [canReadMembers, m.unknownPerson, organizationId, version.publishedByUserId]);

  if (version.publishedAt === null) return null;
  const versionBase = `/${locale}/organizations/${organizationId}/standards/${standardId}/versions`;

  return (
    <section className="pc-card" aria-labelledby="version-record-heading">
      <h2 id="version-record-heading" className="pc-card-title">
        {m.historyColumn}
      </h2>
      <dl className="pc-summary">
        <dt>{m.publishedOn}</dt>
        <dd>{formatVersionDate(version.publishedAt, locale)}</dd>
        {publisher !== null && (
          <>
            <dt>{m.publishedBy}</dt>
            <dd>
              <bdi>{publisher}</bdi>
            </dd>
          </>
        )}
        {version.supersededAt !== null && (
          <>
            <dt>{m.supersededOn}</dt>
            <dd>{formatVersionDate(version.supersededAt, locale)}</dd>
          </>
        )}
        {version.supersededByVersionId !== null && (
          <>
            <dt>{m.supersededByLabel}</dt>
            <dd>
              <Link href={`${versionBase}/${version.supersededByVersionId}`}>
                <bdi>{version.supersededByVersionLabel ?? version.supersededByVersionId}</bdi>
              </Link>
            </dd>
          </>
        )}
      </dl>
      {usage !== null && (
        <>
          <h3 className="pc-card-subtitle">{m.usageTitle}</h3>
          <dl className="pc-summary" data-testid="version-usage">
            <dt>{m.usageSubmissions}</dt>
            <dd>{usage.submissionCount}</dd>
            <dt>{m.usageCertificates}</dt>
            <dd>{usage.certificateCount}</dd>
          </dl>
          <p className="pc-hint">{m.usageHint}</p>
          {usage.certificateCount > 0 && (
            <p>
              <Link href={`/${locale}/organizations/${organizationId}/certificates`}>
                {m.viewCertificates}
              </Link>
            </p>
          )}
        </>
      )}
    </section>
  );
}
