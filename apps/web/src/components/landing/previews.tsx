import type { ReactNode } from 'react';
import { BrandMark, Icon, type IconName } from '@/components/ui/icon';
import { getCertificatesMessages } from '@/i18n/certificates-messages';
import { getChecksMessages } from '@/i18n/checks-messages';
import { getDocumentsMessages } from '@/i18n/documents-messages';
import { getLandingMessages } from '@/i18n/landing-messages';
import type { Locale } from '@/i18n/locales';
import { getShellMessages } from '@/i18n/shell-messages';
import { getSubmissionsMessages } from '@/i18n/submissions-messages';
import { formatMoney } from '@/lib/money';

/**
 * Illustrations of the product, drawn in HTML rather than pasted as images.
 *
 * They reuse the application's own labels (a report here says what a real
 * report says, in either language) and mirror in Arabic like every screen.
 * They are pictures, not records: each is hidden from assistive technology
 * and captioned as sample data by the figure around it, and none of it is a
 * link or a control.
 */

type Tone = 'success' | 'warning' | 'danger' | 'gold' | 'neutral' | 'info';

function Badge({ tone, children }: { tone: Tone; children: ReactNode }) {
  return (
    <span className="pc-status pc-lp-mock-badge" data-tone={tone}>
      <span className="pc-status-dot" />
      {children}
    </span>
  );
}

/** The window every illustration sits in: a thin bar with the PalCert mark. */
export function PreviewFrame({
  children,
  className = '',
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <div className={`pc-lp-frame ${className}`.trim()} aria-hidden="true">
      <div className="pc-lp-frame-bar">
        <BrandMark size={16} />
        <span className="pc-lp-frame-dots">
          <span />
          <span />
          <span />
        </span>
      </div>
      <div className="pc-lp-frame-body">{children}</div>
    </div>
  );
}

function MiniSidebar({ locale, active }: { locale: Locale; active: IconName }) {
  const m = getShellMessages(locale);
  const items: [IconName, string][] = [
    ['dashboard', m.dashboard],
    ['document', m.documents],
    ['check', m.checks],
    ['submission', m.submissions],
    ['certificate', m.certificates],
  ];
  return (
    <div className="pc-lp-mini-sidebar">
      {items.map(([icon, label]) => (
        <span key={icon} className="pc-lp-mini-nav" data-active={icon === active || undefined}>
          <Icon name={icon} size={14} />
          <span>{label}</span>
        </span>
      ))}
    </div>
  );
}

function Stat({ label, value, tone }: { label: string; value: number; tone?: Tone }) {
  return (
    <span className="pc-lp-mock-stat" data-tone={tone}>
      <span>{label}</span>
      <strong>{value}</strong>
    </span>
  );
}

/** The compliance report, the heart of the product. */
function ReportBody({ locale }: { locale: Locale }) {
  const s = getLandingMessages(locale).sample;
  const c = getChecksMessages(locale);
  return (
    <>
      <span className="pc-lp-mock-crumbs">
        {getShellMessages(locale).checks} › {s.reportTitle}
      </span>
      <span className="pc-lp-mock-title">{s.documentName}</span>
      <span className="pc-lp-mock-meta">{s.standardName}</span>
      <span className="pc-lp-mock-result">
        <Icon name="verified" size={18} />
        {c.determinations.COMPLIANT}
      </span>
      <span className="pc-lp-mock-stats">
        <Stat label={c.counts.total} value={48} />
        <Stat label={c.counts.passed} value={46} tone="success" />
        <Stat label={c.counts.failed} value={0} tone="danger" />
        <Stat label={c.counts.notApplicable} value={2} />
      </span>
    </>
  );
}

/** The hero: a report in the workspace, a submission decided, a certificate issued. */
export function WorkspacePreview({ locale }: { locale: Locale }) {
  const s = getLandingMessages(locale).sample;
  const cert = getCertificatesMessages(locale);
  const sub = getSubmissionsMessages(locale);
  return (
    <div className="pc-lp-hero-visual">
      <PreviewFrame className="pc-lp-frame-hero">
        <div className="pc-lp-mock-app">
          <MiniSidebar locale={locale} active="check" />
          <div className="pc-lp-mock-main">
            <ReportBody locale={locale} />
            <span className="pc-lp-mock-rows">
              {[1, 2, 3].map((row) => (
                <span key={row} className="pc-lp-mock-row">
                  <span className="pc-lp-mock-line" data-width={row} />
                  <Badge tone="success">{getChecksMessages(locale).counts.passed}</Badge>
                </span>
              ))}
            </span>
          </div>
        </div>
      </PreviewFrame>

      <div className="pc-lp-float pc-lp-float-submission" aria-hidden="true">
        <span className="pc-lp-float-label">
          <Icon name="submission" size={14} />
          {getShellMessages(locale).submissions}
        </span>
        <span className="pc-lp-float-value">{s.institution}</span>
        <Badge tone="success">{sub.displayStatuses.APPROVED}</Badge>
      </div>

      <div className="pc-lp-float pc-lp-float-certificate" aria-hidden="true">
        <span className="pc-lp-float-label">
          <Icon name="certificate" size={14} />
          {getShellMessages(locale).certificates}
        </span>
        <span className="pc-lp-float-value">{cert.compliant}</span>
        <code className="pc-lp-float-code">{s.certificateNumber}</code>
      </div>
    </div>
  );
}

export function DashboardPreview({ locale }: { locale: Locale }) {
  const s = getLandingMessages(locale).sample;
  const m = getShellMessages(locale);
  const d = getDocumentsMessages(locale);
  const c = getChecksMessages(locale);
  return (
    <PreviewFrame>
      <div className="pc-lp-mock-app">
        <MiniSidebar locale={locale} active="dashboard" />
        <div className="pc-lp-mock-main">
          <span className="pc-lp-mock-title">{s.welcome}</span>
          <span className="pc-lp-mock-panels">
            <span className="pc-lp-mock-panel">
              <span className="pc-lp-mock-panel-title">{s.recentDocuments}</span>
              <span className="pc-lp-mock-item">
                <Icon name="document" size={14} />
                <span>{s.documentName}</span>
                <Badge tone="success">{d.statuses.READY}</Badge>
              </span>
              <span className="pc-lp-mock-item">
                <Icon name="document" size={14} />
                <span>{s.secondDocumentName}</span>
                <Badge tone="success">{d.statuses.READY}</Badge>
              </span>
            </span>
            <span className="pc-lp-mock-panel">
              <span className="pc-lp-mock-panel-title">{s.recentChecks}</span>
              <span className="pc-lp-mock-item">
                <Icon name="check" size={14} />
                <span>{s.standardName}</span>
                <Badge tone="success">{c.determinations.COMPLIANT}</Badge>
              </span>
              <span className="pc-lp-mock-item">
                <Icon name="balance" size={14} />
                <span>{m.balance}</span>
                <span className="pc-lp-mock-amount">
                  {formatMoney({ currency: 'USD', minorUnits: '4400' }, locale)}
                </span>
              </span>
            </span>
          </span>
        </div>
      </div>
    </PreviewFrame>
  );
}

export function DocumentsPreview({ locale }: { locale: Locale }) {
  const s = getLandingMessages(locale).sample;
  const d = getDocumentsMessages(locale);
  const versions: [number, Tone, string | undefined][] = [
    [3, 'neutral', d.statuses.SCANNING],
    [2, 'success', d.statuses.READY],
    [1, 'success', d.statuses.READY],
  ];
  return (
    <PreviewFrame>
      <div className="pc-lp-mock-main pc-lp-mock-solo">
        <span className="pc-lp-mock-title">{s.documentName}</span>
        <span className="pc-lp-mock-meta">{getShellMessages(locale).documents}</span>
        <span className="pc-lp-mock-list">
          {versions.map(([n, tone, label]) => (
            <span key={n} className="pc-lp-mock-item">
              <Icon name="history" size={14} />
              <span>{s.version(n)}</span>
              <Badge tone={tone}>{label}</Badge>
            </span>
          ))}
        </span>
      </div>
    </PreviewFrame>
  );
}

export function ReportPreview({ locale }: { locale: Locale }) {
  return (
    <PreviewFrame>
      <div className="pc-lp-mock-main pc-lp-mock-solo">
        <ReportBody locale={locale} />
      </div>
    </PreviewFrame>
  );
}

export function ReviewQueuePreview({ locale }: { locale: Locale }) {
  const s = getLandingMessages(locale).sample;
  const sub = getSubmissionsMessages(locale);
  const rows: [string, Tone, string | undefined][] = [
    [s.author, 'gold', sub.displayStatuses.UNDER_REVIEW],
    [s.secondAuthor, 'warning', sub.displayStatuses.REVISION_REQUESTED],
    [s.thirdAuthor, 'success', sub.displayStatuses.APPROVED],
  ];
  return (
    <PreviewFrame>
      <div className="pc-lp-mock-main pc-lp-mock-solo">
        <span className="pc-lp-mock-title">{s.submissionQueue}</span>
        <span className="pc-lp-mock-meta">{s.institution}</span>
        <span className="pc-lp-mock-list">
          {rows.map(([name, tone, label]) => (
            <span key={name} className="pc-lp-mock-item">
              <Icon name="user" size={14} />
              <span>{name}</span>
              <Badge tone={tone}>{label}</Badge>
            </span>
          ))}
        </span>
      </div>
    </PreviewFrame>
  );
}

/** What the public verification page tells a verifier. */
export function VerificationPreview({ locale }: { locale: Locale }) {
  const s = getLandingMessages(locale).sample;
  const cert = getCertificatesMessages(locale);
  return (
    <PreviewFrame className="pc-lp-frame-verify">
      <div className="pc-lp-mock-main pc-lp-mock-solo">
        <span className="pc-lp-mock-result">
          <Icon name="verified" size={18} />
          {cert.statuses.VALID}
        </span>
        <span className="pc-lp-mock-dl">
          <span>{cert.certificateNumber}</span>
          <code>{s.certificateNumber}</code>
          <span>{cert.technicalResult}</span>
          <strong>{cert.compliant}</strong>
          <span>{cert.institutionDecision}</span>
          <strong>{cert.approved}</strong>
          <span>{s.issuedLabel}</span>
          <strong>{s.issued}</strong>
        </span>
      </div>
    </PreviewFrame>
  );
}
