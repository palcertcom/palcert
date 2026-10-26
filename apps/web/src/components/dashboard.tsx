'use client';

import Link from 'next/link';
import { useEffect, useState, type ReactNode } from 'react';
import { Amount } from '@/components/balance-panels';
import { LandingPage } from '@/components/landing/landing-page';
import { useShell } from '@/components/shell/shell-context';
import { Icon } from '@/components/ui/icon';
import { PageHeader } from '@/components/ui/page-header';
import { EmptyState, LoadingState } from '@/components/ui/states';
import { StatusBadge } from '@/components/ui/status-badge';
import { checkStageLabel, getChecksMessages } from '@/i18n/checks-messages';
import { getAttestationInfoMessages } from '@/i18n/attestation-info-messages';
import { getBalanceMessages } from '@/i18n/balance-messages';
import { getCertificatesMessages } from '@/i18n/certificates-messages';
import { getDocumentsMessages } from '@/i18n/documents-messages';
import type { Locale } from '@/i18n/locales';
import { getShellMessages } from '@/i18n/shell-messages';
import { getSubmissionsMessages } from '@/i18n/submissions-messages';
import {
  balanceApi,
  certificatesApi,
  checksApi,
  documentsApi,
  submissionsApi,
  type BalanceSummaryResponse,
  type CertificateResponse,
  type CheckResponse,
  type DocumentResponse,
  type OfficialSubmissionResponse,
} from '@/lib/api-client';

const RECENT = 5;

/** A list that loads on its own, so one failing read does not blank the page. */
type Slice<T> = { state: 'loading' } | { state: 'ready'; items: T[] } | { state: 'error' };

function useRecent<T>(enabled: boolean, read: () => Promise<{ items: T[] } | T[]>): Slice<T> {
  const [slice, setSlice] = useState<Slice<T>>({ state: 'loading' });
  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    read().then(
      (page) => {
        const items = Array.isArray(page) ? page : page.items;
        if (!cancelled) setSlice({ state: 'ready', items: items.slice(0, RECENT) });
      },
      () => {
        if (!cancelled) setSlice({ state: 'error' });
      },
    );
    return () => {
      cancelled = true;
    };
    // `read` is a fresh arrow each render; what to read only changes with `enabled`.
  }, [enabled]);
  return slice;
}

/**
 * The home page.
 *
 * Signed out, it is PalCert's front door. Signed in, it is a dashboard made
 * only of things PalCert actually knows about this person, each read from its
 * own endpoint and shown only to someone allowed to read it: their latest
 * documents, checks, official submissions and certificates, their balance as
 * the ledger states it, their organizations and their unread count. No
 * totals, trends or scores are invented to fill the space — an empty account
 * says it is empty and offers the first step.
 */
export function Dashboard({ locale }: { locale: Locale }) {
  const shell = useShell();
  if (shell.status === 'loading') {
    return (
      <main className="pc-page">
        <LoadingState label={getShellMessages(locale).loading} />
      </main>
    );
  }
  if (shell.status === 'signed-out') return <LandingPage locale={locale} />;
  return <SignedInDashboard locale={locale} />;
}

function SignedInDashboard({ locale }: { locale: Locale }) {
  const shell = useShell();
  const m = getShellMessages(locale);
  const d = m.dashboardPage;
  const documentsMessages = getDocumentsMessages(locale);
  const checksMessages = getChecksMessages(locale);
  const submissionsMessages = getSubmissionsMessages(locale);
  const certificatesMessages = getCertificatesMessages(locale);
  const balanceMessages = getBalanceMessages(locale);
  const can = shell.globalPermissions;

  const documents = useRecent<DocumentResponse>(can.has('document:read:self'), () =>
    documentsApi.list({ limit: RECENT }),
  );
  const checks = useRecent<CheckResponse>(can.has('check:read:self'), () =>
    checksApi.list({ limit: RECENT }),
  );
  const submissions = useRecent<OfficialSubmissionResponse>(can.has('submission:read:self'), () =>
    submissionsApi.list(),
  );
  const certificates = useRecent<CertificateResponse>(can.has('certificate:read:self'), () =>
    certificatesApi.list(),
  );
  const balance = useBalance(can.has('balance:read:self'));

  const name = shell.user?.displayName?.trim();
  const reviewOrganization =
    shell.currentOrganization !== null &&
    shell.organizationPermissions.has('submission:review:read')
      ? shell.currentOrganization.organization
      : null;

  const actions = [
    can.has('document:write:self')
      ? { href: `/${locale}/documents`, label: d.newDocument, icon: 'plus' as const }
      : null,
    can.has('check:create:self')
      ? { href: `/${locale}/checks/new`, label: d.startCheck, icon: 'check' as const }
      : null,
    reviewOrganization !== null
      ? {
          href: `/${locale}/organizations/${reviewOrganization.id}/submissions`,
          label: d.reviewSubmissions,
          icon: 'review' as const,
        }
      : null,
  ].filter((action) => action !== null);

  return (
    <main className="pc-page pc-dashboard">
      <PageHeader
        title={name ? d.welcomeNamed(name) : d.welcome}
        description={d.intro}
        actions={
          actions.length > 0 ? (
            <div className="pc-actions" role="group" aria-label={d.quickActions}>
              {actions.map((action, index) => (
                <Link
                  key={action.href}
                  href={action.href}
                  className={index === 0 ? 'pc-btn' : 'pc-btn pc-btn-secondary'}
                >
                  <Icon name={action.icon} size={18} />
                  {action.label}
                </Link>
              ))}
            </div>
          ) : undefined
        }
      />

      {shell.unreadNotifications !== null && shell.unreadNotifications > 0 ? (
        <div className="pc-alert pc-alert-warning pc-dashboard-attention">
          <strong>{d.unreadTitle}</strong> <span>{d.unreadBody(shell.unreadNotifications)}</span>{' '}
          <Link href={`/${locale}/notifications`}>{d.openInbox}</Link>
        </div>
      ) : null}

      {balance.state === 'ready' ? (
        <section className="pc-card pc-dashboard-balance" aria-labelledby="dashboard-balance">
          <Icon name="balance" size={28} />
          <div className="pc-dashboard-balance-figure">
            <h2 id="dashboard-balance">{d.balanceTitle}</h2>
            <p>
              <span className="pc-hint">{balanceMessages.available}</span>{' '}
              <strong>
                <Amount amount={balance.summary.available} locale={locale} />
              </strong>
            </p>
          </div>
          <Link href={`/${locale}/balance`}>{d.viewBalance}</Link>
        </section>
      ) : null}

      {can.has('attestation:submit:self') || can.has('attestation:read:self') ? (
        <AttestationCard
          locale={locale}
          canSubmit={can.has('attestation:submit:self')}
          canRead={can.has('attestation:read:self')}
        />
      ) : null}

      <div className="pc-dashboard-grid">
        {can.has('document:read:self') ? (
          <DashboardPanel
            id="recent-documents"
            title={d.recentDocuments}
            viewAll={{ href: `/${locale}/documents`, label: d.viewAll }}
          >
            <SliceView
              slice={documents}
              loading={m.loading}
              error={d.couldNotLoad}
              empty={
                <EmptyState
                  icon="document"
                  title={d.noDocuments}
                  description={d.noDocumentsHint}
                  headingLevel={3}
                />
              }
              render={(items) => (
                <ul className="pc-dashboard-list">
                  {items.map((document) => (
                    <li key={document.id}>
                      <Link href={`/${locale}/documents/${document.id}`} dir="auto">
                        {document.displayName}
                      </Link>
                      {document.latestVersion === null ? (
                        <span className="pc-hint">{documentsMessages.noVersions}</span>
                      ) : (
                        <StatusBadge
                          status={document.latestVersion.status}
                          label={
                            documentsMessages.statuses[document.latestVersion.status] ??
                            document.latestVersion.status
                          }
                        />
                      )}
                    </li>
                  ))}
                </ul>
              )}
            />
          </DashboardPanel>
        ) : null}

        {can.has('check:read:self') ? (
          <DashboardPanel
            id="recent-checks"
            title={d.recentChecks}
            viewAll={{ href: `/${locale}/checks`, label: d.viewAll }}
          >
            <SliceView
              slice={checks}
              loading={m.loading}
              error={d.couldNotLoad}
              empty={
                <EmptyState
                  icon="check"
                  title={d.noChecks}
                  description={d.noChecksHint}
                  headingLevel={3}
                />
              }
              render={(items) => (
                <ul className="pc-dashboard-list">
                  {items.map((check) => (
                    <li key={check.id}>
                      <span className="pc-dashboard-item">
                        <Link href={`/${locale}/checks/${check.id}`} dir="auto">
                          {check.documentName}
                        </Link>
                        <span className="pc-hint">
                          <bdi>{check.standardName}</bdi> <bdi>{check.standardVersionLabel}</bdi>
                        </span>
                      </span>
                      {check.determination === null ? (
                        <StatusBadge
                          status={check.status}
                          label={checkStageLabel(check.status, checksMessages)}
                        />
                      ) : (
                        <StatusBadge
                          status={check.determination}
                          label={
                            checksMessages.determinations[check.determination] ??
                            check.determination
                          }
                        />
                      )}
                    </li>
                  ))}
                </ul>
              )}
            />
          </DashboardPanel>
        ) : null}

        {can.has('submission:read:self') ? (
          <DashboardPanel
            id="recent-submissions"
            title={d.recentSubmissions}
            viewAll={{ href: `/${locale}/submissions`, label: d.viewAll }}
          >
            <SliceView
              slice={submissions}
              loading={m.loading}
              error={d.couldNotLoad}
              empty={
                <EmptyState
                  icon="submission"
                  title={d.noSubmissions}
                  description={d.noSubmissionsHint}
                  headingLevel={3}
                />
              }
              render={(items) => (
                <ul className="pc-dashboard-list">
                  {items.map((submission) => (
                    <li key={submission.id}>
                      <span className="pc-dashboard-item">
                        <Link href={`/${locale}/submissions/${submission.id}`} dir="auto">
                          {submission.documentName}
                        </Link>
                        <span className="pc-hint">
                          <bdi>{submission.organizationName}</bdi>
                        </span>
                      </span>
                      <StatusBadge
                        status={submission.displayStatus}
                        label={
                          submissionsMessages.displayStatuses[submission.displayStatus] ??
                          submission.displayStatus
                        }
                      />
                    </li>
                  ))}
                </ul>
              )}
            />
          </DashboardPanel>
        ) : null}

        {can.has('certificate:read:self') ? (
          <DashboardPanel
            id="recent-certificates"
            title={d.recentCertificates}
            viewAll={{ href: `/${locale}/certificates`, label: d.viewAll }}
          >
            <SliceView
              slice={certificates}
              loading={m.loading}
              error={d.couldNotLoad}
              empty={
                <EmptyState
                  icon="certificate"
                  title={d.noCertificates}
                  description={d.noCertificatesHint}
                  headingLevel={3}
                />
              }
              render={(items) => (
                <ul className="pc-dashboard-list">
                  {items.map((certificate) => {
                    const state =
                      certificate.revokedAt === null ? certificate.issuanceStatus : 'REVOKED';
                    return (
                      <li key={certificate.id}>
                        <span className="pc-dashboard-item">
                          <Link href={`/${locale}/certificates/${certificate.id}`}>
                            <code>{certificate.certificateNumber ?? certificate.id}</code>
                          </Link>
                          <span className="pc-hint">
                            <bdi>{certificate.organizationName}</bdi>
                          </span>
                        </span>
                        <StatusBadge
                          status={state}
                          label={certificatesMessages.issuanceStatuses[state] ?? state}
                        />
                      </li>
                    );
                  })}
                </ul>
              )}
            />
            {/* The public check, where certificates are: anyone holding one
                may want to see what a verifier sees. */}
            <p className="pc-dashboard-panel-footer">
              <Link href={`/${locale}/verify`}>{m.verifyCertificate}</Link>
            </p>
          </DashboardPanel>
        ) : null}

        <DashboardPanel
          id="your-organizations"
          title={d.yourOrganizations}
          viewAll={{ href: `/${locale}/organizations`, label: d.viewAll }}
        >
          {shell.organizations.length === 0 ? (
            <EmptyState
              icon="organization"
              title={d.noOrganizations}
              description={d.noOrganizationsHint}
              headingLevel={3}
              action={
                <Link className="pc-btn pc-btn-secondary" href={`/${locale}/organizations/new`}>
                  {m.createOrganization}
                </Link>
              }
            />
          ) : (
            <ul className="pc-dashboard-list">
              {shell.organizations.map((entry) => (
                <li key={entry.organization.id}>
                  <Link href={`/${locale}/organizations/${entry.organization.id}`} dir="auto">
                    {entry.organization.displayName}
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </DashboardPanel>
      </div>
    </main>
  );
}

type BalanceState = { state: 'hidden' } | { state: 'ready'; summary: BalanceSummaryResponse };

/**
 * The balance as the ledger states it — or nothing. A balance that could not
 * be read is left off the dashboard rather than shown as zero: zero is a
 * statement about someone's money.
 */
function useBalance(enabled: boolean): BalanceState {
  const [state, setState] = useState<BalanceState>({ state: 'hidden' });
  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    balanceApi.balance().then(
      (summary) => {
        if (!cancelled) setState({ state: 'ready', summary });
      },
      () => undefined,
    );
    return () => {
      cancelled = true;
    };
  }, [enabled]);
  return state;
}

function DashboardPanel({
  id,
  title,
  viewAll,
  children,
}: {
  id: string;
  title: string;
  viewAll: { href: string; label: string };
  children: ReactNode;
}) {
  return (
    <section className="pc-card pc-dashboard-panel" aria-labelledby={id}>
      <header className="pc-dashboard-panel-header">
        <h2 id={id}>{title}</h2>
        <Link href={viewAll.href}>
          {viewAll.label}
          <span className="pc-visually-hidden">: {title}</span>
        </Link>
      </header>
      {children}
    </section>
  );
}

function SliceView<T>({
  slice,
  loading,
  error,
  empty,
  render,
}: {
  slice: Slice<T>;
  loading: string;
  error: string;
  empty: ReactNode;
  render: (items: T[]) => ReactNode;
}) {
  if (slice.state === 'loading') return <LoadingState label={loading} />;
  if (slice.state === 'error') return <p className="pc-hint">{error}</p>;
  if (slice.items.length === 0) return <>{empty}</>;
  return <>{render(slice.items)}</>;
}

/**
 * The way into certificate attestation from the dashboard: the existing
 * request wizard and the person's own requests. The sidebar already lists
 * Attestations; this card says what it is for.
 */
export function AttestationCard({
  locale,
  canSubmit,
  canRead,
}: {
  locale: Locale;
  canSubmit: boolean;
  canRead: boolean;
}) {
  const a = getAttestationInfoMessages(locale).dashboard;
  return (
    <section
      className="pc-card pc-dashboard-attestation"
      aria-labelledby="dashboard-attestation"
      data-testid="dashboard-attestation"
    >
      <Icon name="certificate" size={28} />
      <div className="pc-dashboard-attestation-text">
        <h2 id="dashboard-attestation">{a.title}</h2>
        <p>{a.text}</p>
      </div>
      <div className="pc-actions">
        {canSubmit ? (
          <Link className="pc-btn pc-btn-sm" href={`/${locale}/attestations/new`}>
            <Icon name="plus" size={16} />
            {a.newRequest}
          </Link>
        ) : null}
        {canRead ? (
          <Link className="pc-btn pc-btn-secondary pc-btn-sm" href={`/${locale}/attestations`}>
            {a.myRequests}
          </Link>
        ) : null}
        <Link className="pc-dashboard-attestation-more" href={`/${locale}/certificate-attestation`}>
          {a.learnMore}
        </Link>
      </div>
    </section>
  );
}
