'use client';

import type {
  AttestationRecordView,
  AttestationRequestEventView,
  AttestationSubmittedMetadata,
  MoneyView,
} from '@palcert/contracts';
import { useEffect, useState } from 'react';
import { StatusBadge } from '@/components/ui/status-badge';
import type { AttestationsMessages } from '@/i18n/attestations-messages';
import type { Locale } from '@/i18n/locales';
import { ApiError } from '@/lib/api-client';
import { fetchBlob } from '@/lib/attestations-api';
import { formatMoney } from '@/lib/money';

/** Turn a failure into a sentence from the attestation catalogue. */
export function describeAttestationError(messages: AttestationsMessages, caught: unknown): string {
  if (caught instanceof ApiError) return messages.errors[caught.code] ?? messages.genericError;
  return messages.genericError;
}

export function money(amount: MoneyView, locale: Locale): string {
  return formatMoney(amount, locale);
}

export function formatDate(value: string | null, locale: Locale, withTime = false): string {
  if (value === null) return '—';
  const options: Intl.DateTimeFormatOptions = withTime
    ? { dateStyle: 'medium', timeStyle: 'short', timeZone: 'UTC' }
    : { dateStyle: 'medium', timeZone: 'UTC' };
  return new Intl.DateTimeFormat(locale, options).format(new Date(value));
}

/** An ISO calendar date (YYYY-MM-DD), shown as a date without shifting timezones. */
export function formatCalendarDate(value: string | null, locale: Locale): string {
  if (value === null) return '—';
  return formatDate(`${value.slice(0, 10)}T00:00:00Z`, locale);
}

export function RequestStatusBadge({
  status,
  messages,
}: {
  status: string;
  messages: AttestationsMessages;
}) {
  return <StatusBadge status={status} label={messages.statuses[status] ?? status} />;
}

export function VerificationBadge({
  status,
  messages,
}: {
  status: string;
  messages: AttestationsMessages;
}) {
  return (
    <StatusBadge
      status={status}
      label={messages.verificationStatuses[status] ?? status}
      title={messages.verificationHints[status]}
    />
  );
}

export function PaymentBadge({
  status,
  messages,
}: {
  status: string;
  messages: AttestationsMessages;
}) {
  return <StatusBadge status={status} label={messages.paymentStatuses[status] ?? status} />;
}

/** The standing sentence every attestation page carries. */
export function AttestationDisclaimer({ messages }: { messages: AttestationsMessages }) {
  return (
    <p className="pc-hint" data-testid="attestation-disclaimer">
      {messages.disclaimer}
    </p>
  );
}

/** A long technical value: left-to-right, wrapped, copyable. */
export function HashValue({
  label,
  value,
  messages,
  testId,
}: {
  label: string;
  value: string;
  messages: AttestationsMessages;
  testId?: string;
}) {
  const [copied, setCopied] = useState(false);
  async function copy(): Promise<void> {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard access can be refused; the value stays selectable.
    }
  }
  return (
    <div className="pc-field">
      <span className="pc-hint">{label}</span>
      <div className="pc-inline">
        <code dir="ltr" className="pc-hash" data-testid={testId}>
          {value}
        </code>
        <button type="button" className="pc-btn pc-btn-quiet pc-btn-sm" onClick={() => void copy()}>
          {copied ? messages.copied : messages.copy}
        </button>
      </div>
    </div>
  );
}

export function DetailRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <dt>{label}</dt>
      <dd>{children}</dd>
    </div>
  );
}

/** Submitted metadata, as the user described the certificate. */
export function SubmittedDetails({
  metadata,
  messages,
  locale,
}: {
  metadata: AttestationSubmittedMetadata;
  messages: AttestationsMessages;
  locale: Locale;
}) {
  const entries: [string, string | null][] = [
    ['certificateTitle', metadata.certificateTitle],
    ['certificateType', metadata.certificateType],
    ['issuingOrganization', metadata.issuingOrganization],
    [
      'issueDate',
      metadata.issueDate === null ? null : formatCalendarDate(metadata.issueDate, locale),
    ],
    ['referenceNumber', metadata.referenceNumber],
    ['recipientName', metadata.recipientName],
    ['description', metadata.description],
  ];
  return (
    <dl className="pc-definitions">
      {entries.map(([key, value]) => (
        <DetailRow key={key} label={messages.fields[key] ?? key}>
          {value === null || value === '' ? messages.none : <bdi>{value}</bdi>}
        </DetailRow>
      ))}
    </dl>
  );
}

export function EventHistory({
  events,
  messages,
  locale,
}: {
  events: readonly AttestationRequestEventView[];
  messages: AttestationsMessages;
  locale: Locale;
}) {
  return (
    <ol className="pc-timeline" aria-label={messages.details.history}>
      {events.map((event) => (
        <li key={event.id}>
          <strong>{messages.eventTypes[event.eventType] ?? event.eventType}</strong>{' '}
          <time dateTime={event.createdAt} className="pc-hint">
            {formatDate(event.createdAt, locale, true)}
          </time>
          {event.message === null ? null : (
            <p>
              <bdi>{event.message}</bdi>
            </p>
          )}
        </li>
      ))}
    </ol>
  );
}

/**
 * The QR image and its downloads.
 *
 * The QR encodes only the public URL. It is fetched with the session (the
 * route is the owner's or the institution's) and shown from a local object
 * URL, which is revoked when the component goes away.
 */
export function QrCode({
  svgPath,
  pngPath,
  messages,
  filenameBase,
}: {
  svgPath: string;
  pngPath: string;
  messages: AttestationsMessages;
  filenameBase: string;
}) {
  const [svgUrl, setSvgUrl] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    // A data: URL, not a blob: one: the Content-Security-Policy allows
    // images from 'self' and data: only, and should stay that way.
    void fetchBlob(svgPath)
      .then(
        (blob) =>
          new Promise<string>((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => resolve(String(reader.result));
            reader.onerror = () => reject(reader.error);
            reader.readAsDataURL(blob);
          }),
      )
      .then((url) => {
        if (!cancelled) setSvgUrl(url);
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, [svgPath]);

  async function download(path: string, extension: 'png' | 'svg'): Promise<void> {
    const blob = await fetchBlob(path);
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `${filenameBase}.${extension}`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  return (
    <div className="pc-qr">
      <h3 className="pc-card-subtitle">{messages.details.qrCode}</h3>
      {svgUrl === null ? (
        failed ? (
          <p className="pc-hint">{messages.genericError}</p>
        ) : (
          <p className="pc-hint">{messages.loading}</p>
        )
      ) : (
        <img
          src={svgUrl}
          alt={messages.details.qrAlt}
          width={180}
          height={180}
          data-testid="attestation-qr"
        />
      )}
      <div className="pc-actions">
        <button
          type="button"
          className="pc-btn pc-btn-secondary pc-btn-sm"
          onClick={() => void download(pngPath, 'png')}
        >
          {messages.details.downloadPng}
        </button>
        <button
          type="button"
          className="pc-btn pc-btn-secondary pc-btn-sm"
          onClick={() => void download(svgPath, 'svg')}
        >
          {messages.details.downloadSvg}
        </button>
      </div>
    </div>
  );
}

/** The attestation itself, for its owner and its institution. */
export function AttestationRecordCard({
  record,
  messages,
  locale,
  qr,
  actions,
}: {
  record: AttestationRecordView;
  messages: AttestationsMessages;
  locale: Locale;
  qr: { svgPath: string; pngPath: string } | null;
  actions?: React.ReactNode;
}) {
  const d = messages.details;
  const typeName = locale === 'ar' ? record.attestationTypeName.ar : record.attestationTypeName.en;
  return (
    <section
      className="pc-card"
      aria-labelledby="attestation-record-title"
      data-testid="attestation-record"
    >
      <div className="pc-title-row">
        <h2 id="attestation-record-title" className="pc-card-title">
          {d.attestation}
        </h2>
        <VerificationBadge status={record.verificationStatus} messages={messages} />
      </div>
      <dl className="pc-definitions">
        <DetailRow label={d.reference}>
          <code dir="ltr" data-testid="attestation-reference">
            {record.reference}
          </code>
        </DetailRow>
        <DetailRow label={messages.public.attestedBy}>
          <bdi>{record.organizationName}</bdi>
        </DetailRow>
        <DetailRow label={messages.public.type}>
          <bdi>{typeName}</bdi>
        </DetailRow>
        <DetailRow label={messages.fields['certificateTitle'] ?? ''}>
          <bdi>{record.confirmed.certificateTitle}</bdi>
        </DetailRow>
        {record.confirmed.holderName === null ? null : (
          <DetailRow label={messages.review.holderName}>
            <bdi>{record.confirmed.holderName}</bdi>
          </DetailRow>
        )}
        <DetailRow label={d.validFrom}>{formatDate(record.validFrom, locale)}</DetailRow>
        <DetailRow label={d.validUntil}>
          <span data-testid="attestation-valid-until">
            {record.validUntil === null
              ? messages.noExpiry
              : formatDate(record.validUntil, locale, true)}
          </span>
        </DetailRow>
        <DetailRow label={d.approvedAt}>{formatDate(record.approvedAt, locale, true)}</DetailRow>
        {record.revokedAt === null ? null : (
          <>
            <DetailRow label={d.revokedAt}>{formatDate(record.revokedAt, locale, true)}</DetailRow>
            {record.revocationReason === null ? null : (
              <DetailRow label={d.revocationReason}>
                <bdi>{record.revocationReason}</bdi>
              </DetailRow>
            )}
          </>
        )}
        {record.institutionNote === null ? null : (
          <DetailRow label={d.institutionNote}>
            <bdi>{record.institutionNote}</bdi>
          </DetailRow>
        )}
      </dl>

      <HashValue
        label={d.artifactHash}
        value={record.artifactSha256}
        messages={messages}
        testId="attestation-sha256"
      />
      <HashValue label={d.attestationHash} value={record.attestationHash} messages={messages} />
      <p className="pc-hint">{d.hashHint}</p>

      {record.verificationUrl === null ? null : (
        <div className="pc-field">
          <span className="pc-hint">{d.verificationLink}</span>
          <div className="pc-inline">
            <a
              href={record.verificationUrl}
              dir="ltr"
              className="pc-hash"
              data-testid="attestation-verification-url"
            >
              {record.verificationUrl}
            </a>
          </div>
          <a
            className="pc-btn pc-btn-secondary pc-btn-sm"
            href={record.verificationUrl}
            target="_blank"
            rel="noopener noreferrer"
          >
            {d.openPublicPage}
          </a>
        </div>
      )}
      {qr === null || record.verificationUrl === null ? null : (
        <QrCode
          svgPath={qr.svgPath}
          pngPath={qr.pngPath}
          messages={messages}
          filenameBase={record.reference}
        />
      )}
      {actions === undefined ? null : <div className="pc-actions">{actions}</div>}
      <AttestationDisclaimer messages={messages} />
    </section>
  );
}

/** A row of labelled figures, such as a dashboard summary. */
export function Figures({
  items,
  label,
}: {
  items: readonly {
    readonly key: string;
    readonly label: string;
    readonly value: React.ReactNode;
  }[];
  label: string;
}) {
  return (
    <dl className="pc-admin-figures" aria-label={label}>
      {items.map((item) => (
        <div key={item.key} className="pc-admin-figure" data-figure={item.key}>
          <dt className="pc-admin-figure-label">{item.label}</dt>
          <dd className="pc-admin-figure-value">{item.value}</dd>
        </div>
      ))}
    </dl>
  );
}
