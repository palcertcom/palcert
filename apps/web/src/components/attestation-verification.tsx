'use client';

import type { PublicAttestationView } from '@palcert/contracts';
import { useEffect, useId, useState } from 'react';
import { Icon, type IconName } from '@/components/ui/icon';
import type { AttestationsMessages } from '@/i18n/attestations-messages';
import type { Locale } from '@/i18n/locales';
import {
  AttestationDisclaimer,
  DetailRow,
  HashValue,
  formatCalendarDate,
  formatDate,
} from './attestation';

/**
 * The public verification page for one attestation, drawn to be read at a
 * glance.
 *
 * It answers two questions, and keeps them apart because they are different:
 *
 * - **Is this institutional attestation in force?** — the validity block, from
 *   the server's VALID / EXPIRED / REVOKED.
 * - **Is this exact file the one the institution attested?** — the comparison,
 *   from the SHA-256 of a file the visitor picks.
 *
 * An expired attestation of the very file in hand is red above and green
 * below, and that is the truth, so neither block reads the other's state.
 *
 * ADR-0145 holds: the attested file is never shown or offered here. The
 * "attested document" is a card of public facts about it. The visitor's own
 * file stays in their browser — previewed from a local object URL, hashed
 * with Web Crypto — and only its digest is ever sent anywhere.
 */

/** Green for in force, red for anything else. Always paired with words and an icon. */
type Tone = 'success' | 'danger';

export function validityTone(status: string): Tone {
  return status === 'VALID' ? 'success' : 'danger';
}

const VALIDITY_ICONS: Readonly<Record<string, IconName>> = {
  VALID: 'circle-check',
  EXPIRED: 'clock',
  REVOKED: 'circle-alert',
};

/** The digest's head and tail, for recognising it at a glance. */
export function shortFingerprint(sha256: string): string {
  return sha256.length <= 20 ? sha256 : `${sha256.slice(0, 10)}…${sha256.slice(-8)}`;
}

/** The format's initials for the document glyph: PDF, PNG, JPG… */
function formatInitials(mimeType: string): string {
  const subtype = mimeType.split('/')[1]?.split(/[+;.-]/)[0] ?? '';
  if (subtype === 'jpeg') return 'JPG';
  return subtype.slice(0, 4).toUpperCase() || 'FILE';
}

function fileTypeName(messages: AttestationsMessages, mimeType: string): string {
  return messages.public.fileTypes[mimeType] ?? messages.public.otherFileType;
}

function formatBytes(bytes: number, locale: Locale): string {
  const units = ['B', 'KB', 'MB', 'GB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  const number = new Intl.NumberFormat(locale === 'ar' ? 'ar' : 'en', {
    maximumFractionDigits: unit === 0 ? 0 : 1,
  }).format(value);
  return `${number} ${units[unit]}`;
}

function StatusBadge({
  tone,
  icon,
  label,
  testId,
}: {
  tone: Tone;
  icon: IconName;
  label: string;
  testId?: string;
}) {
  return (
    <span className="pc-verify-badge" data-tone={tone} data-testid={testId}>
      <Icon name={icon} size={16} />
      <span>{label}</span>
    </span>
  );
}

// ---------------------------------------------------------------------------
// 1. Validity
// ---------------------------------------------------------------------------

export function AttestationValidity({
  view,
  messages,
  locale,
}: {
  view: PublicAttestationView;
  messages: AttestationsMessages;
  locale: Locale;
}) {
  const p = messages.public;
  const status = view.verificationStatus;
  const tone = validityTone(status);
  const titleId = useId();
  return (
    <section
      className="pc-verify-validity"
      data-tone={tone}
      data-status={status}
      aria-labelledby={titleId}
      data-testid="attestation-validity"
    >
      <span className="pc-verify-validity-icon">
        <Icon name={VALIDITY_ICONS[status] ?? 'circle-alert'} size={40} />
      </span>
      <div className="pc-verify-validity-body">
        <p className="pc-verify-question">{p.validityQuestion}</p>
        <h2
          id={titleId}
          className="pc-verify-validity-title"
          data-testid="public-attestation-status"
        >
          {p.validityTitles[status] ?? status}
        </h2>
        <p role="status">{p.validityExplanations[status]}</p>
        <dl className="pc-verify-validity-dates">
          {status === 'EXPIRED' && view.validUntil !== null ? (
            <DetailRow label={p.expiredOn}>
              <strong data-testid="public-expired-on">
                {formatDate(view.validUntil, locale, true)}
              </strong>
            </DetailRow>
          ) : null}
          {status === 'REVOKED' && view.revokedAt !== null ? (
            <DetailRow label={p.revokedOn}>
              <strong>{formatDate(view.revokedAt, locale, true)}</strong>
            </DetailRow>
          ) : null}
          {status === 'VALID' ? (
            <DetailRow label={p.validUntil}>
              {view.validUntil === null
                ? messages.noExpiry
                : formatDate(view.validUntil, locale, true)}
            </DetailRow>
          ) : null}
          <DetailRow label={p.attestedBy}>
            <bdi>{view.organization.name}</bdi>
          </DetailRow>
        </dl>
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------
// 2. The attested document, as a protected card
// ---------------------------------------------------------------------------

export function ProtectedDocumentCard({
  view,
  messages,
  locale,
  comparison,
}: {
  view: PublicAttestationView;
  messages: AttestationsMessages;
  locale: Locale;
  /** The comparison outcome, when there is one; it colours the frame only. */
  comparison: ComparisonOutcome | null;
}) {
  const p = messages.public;
  const tone = validityTone(view.verificationStatus);
  const typeName = locale === 'ar' ? view.attestationType.ar : view.attestationType.en;
  return (
    <article
      className="pc-verify-panel pc-verify-document"
      data-frame={comparison === 'match' ? 'success' : 'neutral'}
      aria-label={p.attestedDocument}
      data-testid="attested-document"
    >
      <header className="pc-verify-panel-head">
        <h3 className="pc-verify-panel-title">{p.attestedDocument}</h3>
        <StatusBadge
          tone={tone}
          icon={VALIDITY_ICONS[view.verificationStatus] ?? 'circle-alert'}
          label={p.validityBadges[view.verificationStatus] ?? view.verificationStatus}
          testId="attested-document-validity"
        />
      </header>
      <div className="pc-verify-sheet">
        <div className="pc-verify-sheet-glyph" aria-hidden="true">
          <Icon name="document" size={44} />
          <span className="pc-verify-sheet-format">{formatInitials(view.artifactMimeType)}</span>
        </div>
        <div className="pc-verify-sheet-body">
          <p className="pc-verify-protected">
            <Icon name="lock" size={16} />
            <span>{p.protectedDocument}</span>
          </p>
          <p className="pc-verify-sheet-title">
            <bdi>{view.certificate.title}</bdi>
          </p>
          <dl className="pc-verify-sheet-facts">
            <DetailRow label={p.documentType}>
              <span data-testid="attested-document-type">
                {fileTypeName(messages, view.artifactMimeType)}
              </span>
            </DetailRow>
            <DetailRow label={p.type}>
              <bdi>{typeName}</bdi>
            </DetailRow>
            <DetailRow label={p.attestedBy}>
              <bdi>{view.organization.name}</bdi>
            </DetailRow>
            <DetailRow label={p.fingerprint}>
              <code
                dir="ltr"
                className="pc-verify-code"
                data-testid="attested-document-fingerprint"
              >
                {shortFingerprint(view.artifactSha256)}
              </code>
            </DetailRow>
            <DetailRow label={p.reference}>
              <code dir="ltr" className="pc-verify-code">
                {view.reference}
              </code>
            </DetailRow>
          </dl>
        </div>
      </div>
      <p className="pc-verify-privacy" data-testid="attested-document-privacy">
        <Icon name="shield" size={18} />
        <span>{p.noFileHere}</span>
      </p>
    </article>
  );
}

// ---------------------------------------------------------------------------
// 3–4. The visitor's file, and the comparison
// ---------------------------------------------------------------------------

/** `other`: not this attestation's file, but a VALID attestation of another. */
export type ComparisonOutcome = 'match' | 'other' | 'differs';

export type CompareFile = (file: File) => Promise<{ digest: string; outcome: ComparisonOutcome }>;

type Selected = {
  readonly name: string;
  readonly type: string;
  readonly size: number;
  /** A local object URL for an image or PDF; null for anything else. */
  readonly url: string | null;
  readonly kind: 'image' | 'pdf' | 'other';
};

type Check =
  | { readonly kind: 'idle' }
  | { readonly kind: 'checking' }
  | { readonly kind: 'done'; readonly digest: string; readonly outcome: ComparisonOutcome }
  | { readonly kind: 'failed' };

/** Raster formats a browser decodes safely in an <img>; SVG is not among them. */
const IMAGE_TYPES: ReadonlySet<string> = new Set([
  'image/png',
  'image/jpeg',
  'image/webp',
  'image/gif',
]);

function previewKind(type: string): Selected['kind'] {
  if (IMAGE_TYPES.has(type)) return 'image';
  if (type === 'application/pdf') return 'pdf';
  return 'other';
}

export function AttestationComparison({
  view,
  messages,
  locale,
  compare,
  onFailure,
}: {
  view: PublicAttestationView;
  messages: AttestationsMessages;
  locale: Locale;
  compare: CompareFile;
  onFailure?: () => void;
}) {
  const p = messages.public;
  const inputId = useId();
  const titleId = useId();
  const [selected, setSelected] = useState<Selected | null>(null);
  const [check, setCheck] = useState<Check>({ kind: 'idle' });

  // A local object URL lives as long as the file is on screen, and no longer.
  useEffect(() => {
    const url = selected?.url ?? null;
    return () => {
      if (url !== null) URL.revokeObjectURL(url);
    };
  }, [selected]);

  async function choose(file: File | undefined): Promise<void> {
    if (file === undefined) return;
    const kind = previewKind(file.type);
    // Re-typed explicitly, so the browser renders it as what it says it is.
    const url =
      kind === 'other' ? null : URL.createObjectURL(new Blob([file], { type: file.type }));
    setSelected({ name: file.name, type: file.type, size: file.size, url, kind });
    setCheck({ kind: 'checking' });
    try {
      const result = await compare(file);
      setCheck({ kind: 'done', ...result });
    } catch {
      setCheck({ kind: 'failed' });
      onFailure?.();
    }
  }

  const outcome = check.kind === 'done' ? check.outcome : null;
  const matched = outcome === 'match';
  return (
    <section className="pc-card pc-verify-compare" aria-labelledby={titleId}>
      <h2 id={titleId} className="pc-card-title">
        {p.checkFileTitle}
      </h2>
      <p className="pc-verify-question">{p.comparisonQuestion}</p>
      <p className="pc-hint">{p.checkFileIntro}</p>

      <div className="pc-verify-grid" data-outcome={outcome ?? 'none'} data-testid="verify-compare">
        <ProtectedDocumentCard
          view={view}
          messages={messages}
          locale={locale}
          comparison={outcome}
        />

        <article
          className="pc-verify-panel pc-verify-visitor"
          data-frame={outcome === null ? 'neutral' : matched ? 'success' : 'danger'}
          aria-label={p.fileYouSelected}
          data-testid="visitor-file"
        >
          <header className="pc-verify-panel-head">
            <h3 className="pc-verify-panel-title">{p.fileYouSelected}</h3>
            {outcome === null ? null : (
              <StatusBadge
                tone={matched ? 'success' : 'danger'}
                icon={matched ? 'circle-check' : 'circle-alert'}
                label={matched ? p.matchTitle : p.mismatchTitle}
              />
            )}
          </header>
          <div className="pc-field pc-verify-picker">
            <label htmlFor={inputId}>{p.chooseFile}</label>
            <input
              id={inputId}
              type="file"
              data-testid="verify-file-input"
              onChange={(event) => void choose(event.target.files?.[0])}
            />
            <p className="pc-hint pc-verify-local">
              <Icon name="lock" size={14} />
              <span>{p.staysLocal}</span>
            </p>
          </div>
          <VisitorPreview selected={selected} messages={messages} locale={locale} />
        </article>
      </div>

      <div role="status" aria-live="polite" data-testid="verify-file-result">
        {check.kind === 'checking' ? <p className="pc-hint">{p.checking}</p> : null}
        {check.kind === 'done' ? (
          <div className="pc-verify-result" data-tone={matched ? 'success' : 'danger'}>
            <span className="pc-verify-result-icon">
              <Icon name={matched ? 'circle-check' : 'circle-alert'} size={32} />
            </span>
            <div>
              <p className="pc-verify-result-title" data-outcome={check.outcome}>
                <strong>{matched ? p.matchTitle : p.mismatchTitle}</strong>
              </p>
              <p>{matched ? p.matchText : p.mismatchText}</p>
              {check.outcome === 'other' ? <p>{p.fileMatchesOther}</p> : null}
              {check.outcome === 'differs' ? <p className="pc-hint">{p.mismatchHint}</p> : null}
              <HashValue label={p.computedHash} value={check.digest} messages={messages} />
            </div>
          </div>
        ) : null}
      </div>
    </section>
  );
}

function VisitorPreview({
  selected,
  messages,
  locale,
}: {
  selected: Selected | null;
  messages: AttestationsMessages;
  locale: Locale;
}) {
  const p = messages.public;
  if (selected === null) {
    return (
      <div className="pc-verify-empty" data-testid="visitor-file-empty">
        <Icon name="upload" size={32} />
        <p>{p.noFileSelected}</p>
      </div>
    );
  }
  return (
    <div className="pc-verify-preview" data-kind={selected.kind} data-testid="visitor-file-preview">
      {selected.kind === 'image' && selected.url !== null ? (
        <img
          src={selected.url}
          alt={p.imagePreviewAlt}
          className="pc-verify-preview-image"
          data-testid="visitor-file-image"
        />
      ) : (
        <div className="pc-verify-sheet pc-verify-sheet-local">
          <div className="pc-verify-sheet-glyph" aria-hidden="true">
            <Icon name="document" size={44} />
            <span className="pc-verify-sheet-format">
              {formatInitials(selected.type || 'x/file')}
            </span>
          </div>
          <div className="pc-verify-sheet-body">
            {selected.kind === 'pdf' ? (
              <>
                <p className="pc-hint">{p.pdfNotEmbedded}</p>
                {selected.url === null ? null : (
                  <a
                    href={selected.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="pc-btn pc-btn-secondary pc-btn-sm"
                    data-testid="visitor-file-open"
                  >
                    {p.openLocalPreview}
                  </a>
                )}
              </>
            ) : (
              <p className="pc-hint" data-testid="visitor-file-no-preview">
                {p.noPreview}
              </p>
            )}
          </div>
        </div>
      )}
      <dl className="pc-verify-sheet-facts">
        <DetailRow label={p.fileName}>
          <bdi dir="auto" className="pc-verify-filename" data-testid="visitor-file-name">
            {selected.name}
          </bdi>
        </DetailRow>
        <DetailRow label={p.documentType}>{fileTypeName(messages, selected.type)}</DetailRow>
        <DetailRow label={p.fileSize}>
          <span dir="ltr">{formatBytes(selected.size, locale)}</span>
        </DetailRow>
      </dl>
    </div>
  );
}

// ---------------------------------------------------------------------------
// 5. Details, then the technical record
// ---------------------------------------------------------------------------

export function AttestationDetails({
  view,
  messages,
  locale,
}: {
  view: PublicAttestationView;
  messages: AttestationsMessages;
  locale: Locale;
}) {
  const p = messages.public;
  const titleId = useId();
  const technicalId = useId();
  const typeName = locale === 'ar' ? view.attestationType.ar : view.attestationType.en;
  return (
    <>
      <section className="pc-card" aria-labelledby={titleId} data-testid="attestation-details">
        <p className="pc-hint">{p.verifiedBy}</p>
        <h2 id={titleId} className="pc-card-title">
          {p.detailsTitle}
        </h2>
        <dl className="pc-definitions">
          <DetailRow label={p.attestedBy}>
            <bdi>{view.organization.name}</bdi>{' '}
            <span className="pc-hint">
              ({view.organization.verified ? p.institutionVerified : p.institutionUnverified})
            </span>
          </DetailRow>
          <DetailRow label={p.type}>
            <bdi>{typeName}</bdi>
          </DetailRow>
          <DetailRow label={p.certificate}>
            <bdi>{view.certificate.title}</bdi>
          </DetailRow>
          {view.certificate.holderName === null ? null : (
            <DetailRow label={p.holder}>
              <bdi>{view.certificate.holderName}</bdi>
            </DetailRow>
          )}
          {view.certificate.issuingOrganization === null ? null : (
            <DetailRow label={p.issuer}>
              <bdi>{view.certificate.issuingOrganization}</bdi>
            </DetailRow>
          )}
          {view.certificate.issueDate === null ? null : (
            <DetailRow label={p.issueDate}>
              {formatCalendarDate(view.certificate.issueDate, locale)}
            </DetailRow>
          )}
          {view.certificate.referenceNumber === null ? null : (
            <DetailRow label={p.referenceNumber}>
              <bdi>{view.certificate.referenceNumber}</bdi>
            </DetailRow>
          )}
        </dl>
      </section>

      <section
        className="pc-card pc-verify-technical"
        aria-labelledby={technicalId}
        data-testid="technical-details"
      >
        <h2 id={technicalId} className="pc-verify-technical-title">
          {p.technicalDetails}
        </h2>
        <dl className="pc-definitions">
          <DetailRow label={p.reference}>
            <code dir="ltr">{view.reference}</code>
          </DetailRow>
          <DetailRow label={p.validFrom}>{formatDate(view.validFrom, locale)}</DetailRow>
          <DetailRow label={p.validUntil}>
            <span data-testid="public-valid-until">
              {view.validUntil === null
                ? messages.noExpiry
                : formatDate(view.validUntil, locale, true)}
            </span>
          </DetailRow>
          <DetailRow label={p.attestedAt}>{formatDate(view.attestedAt, locale)}</DetailRow>
          {view.revokedAt === null ? null : (
            <DetailRow label={p.revokedAt}>{formatDate(view.revokedAt, locale, true)}</DetailRow>
          )}
          <DetailRow label={p.fileFormat}>
            <code dir="ltr">{view.artifactMimeType}</code>
          </DetailRow>
        </dl>
        <HashValue
          label={p.artifactHash}
          value={view.artifactSha256}
          messages={messages}
          testId="public-sha256"
        />
        <HashValue label={p.attestationHash} value={view.attestationHash} messages={messages} />
      </section>

      <AttestationDisclaimer messages={messages} />
    </>
  );
}

/** The whole public answer for one attestation, top to bottom. */
export function PublicAttestationVerification({
  view,
  messages,
  locale,
  compare,
  onFailure,
}: {
  view: PublicAttestationView;
  messages: AttestationsMessages;
  locale: Locale;
  compare: CompareFile;
  onFailure?: () => void;
}) {
  return (
    <div
      className="pc-verify"
      data-status={view.verificationStatus}
      data-testid="public-attestation"
    >
      <AttestationValidity view={view} messages={messages} locale={locale} />
      <AttestationComparison
        view={view}
        messages={messages}
        locale={locale}
        compare={compare}
        {...(onFailure === undefined ? {} : { onFailure })}
      />
      <AttestationDetails view={view} messages={messages} locale={locale} />
    </div>
  );
}
