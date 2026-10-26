'use client';

import { useCallback, useState } from 'react';
import type { Locale } from '@/i18n/locales';
import { getCertificatesMessages } from '@/i18n/certificates-messages';
import {
  ApiError,
  certificateReviewApi,
  certificatesApi,
  type CertificateResponse,
  type PublicCertificateVerificationResponse,
  type SubmissionCertificateStatusResponse,
} from '@/lib/api-client';

/** The slices of the client these components use, so a test can supply its own. */
export type CertificateApi = {
  readonly download: typeof certificatesApi.download;
};

export type CertificateReviewApi = {
  readonly revoke: typeof certificateReviewApi.revoke;
};

const DEFAULT_API: CertificateApi = { download: certificatesApi.download };
const DEFAULT_REVIEW_API: CertificateReviewApi = { revoke: certificateReviewApi.revoke };

const REVOCATION_REASONS = [
  'ISSUED_IN_ERROR',
  'EVIDENCE_INTEGRITY_FAILURE',
  'ADMINISTRATIVE_CORRECTION',
  'SECURITY_INCIDENT',
  'OTHER',
] as const;

function describe(caught: unknown, locale: Locale): string {
  const messages = getCertificatesMessages(locale);
  return caught instanceof ApiError
    ? (messages.errors[caught.code] ?? messages.genericError)
    : messages.genericError;
}

function formatDate(value: string, locale: Locale): string {
  return new Intl.DateTimeFormat(locale, { dateStyle: 'medium' }).format(new Date(value));
}

/**
 * A hash, shown in full and copyable (§106).
 *
 * Truncating it would make the one thing it is for — comparing it against a
 * hash you computed yourself — impossible, so it wraps instead.
 */
export function HashRow({
  locale,
  label,
  value,
}: {
  locale: Locale;
  label: string;
  value: string;
}) {
  const messages = getCertificatesMessages(locale);
  const [copied, setCopied] = useState(false);

  const copy = useCallback(() => {
    void navigator.clipboard?.writeText(value).then(() => setCopied(true));
  }, [value]);

  return (
    <div className="pc-hash-row">
      <dt>{label}</dt>
      <dd>
        <code className="pc-hash">{value}</code>
        <button type="button" className="pc-button-quiet" onClick={copy}>
          {copied ? messages.copied : messages.copy}
        </button>
      </dd>
    </div>
  );
}

/**
 * The two authorities, side by side and never merged (§109, §114).
 *
 * Both rows always render, in both languages, with their own label. A reader
 * who takes away only one sentence should take away that PalCert measured and
 * the institution decided — two acts, by two parties.
 */
export function AuthorityRows({
  locale,
  technicalResult,
  institutionDecision,
}: {
  locale: Locale;
  technicalResult: string;
  institutionDecision: string;
}) {
  const messages = getCertificatesMessages(locale);
  return (
    <>
      <dt>{messages.technicalResult}</dt>
      <dd>{technicalResult === 'COMPLIANT' ? messages.compliant : technicalResult}</dd>
      <dt>{messages.institutionDecision}</dt>
      <dd>{institutionDecision === 'APPROVED' ? messages.approved : institutionDecision}</dd>
    </>
  );
}

/**
 * What public verification says (§99–§115).
 *
 * Rendered from the public response alone, never from a certificate the
 * viewer happens to own: this component is what a stranger sees, and giving
 * it access to the richer type is how a private field leaks onto a public
 * page.
 */
export function PublicCertificate({
  locale,
  result,
}: {
  locale: Locale;
  result: PublicCertificateVerificationResponse;
}) {
  const messages = getCertificatesMessages(locale);
  const status = result.verificationStatus;

  return (
    <section className="pc-card" aria-labelledby="verification-heading">
      {/* §112: the status is a sentence, so it survives being read aloud,
          printed in grey, or seen by somebody who cannot tell red from green. */}
      <h2 id="verification-heading" data-status={status}>
        {messages.statuses[status] ?? status}
      </h2>
      <p>{messages.statusHints[status] ?? ''}</p>

      <dl className="pc-definitions">
        <dt>{messages.certificateNumber}</dt>
        <dd>
          <code>{result.certificateNumber}</code>
        </dd>

        <AuthorityRows
          locale={locale}
          technicalResult={result.technicalResult}
          institutionDecision={result.institutionDecision}
        />

        <dt>{messages.organization}</dt>
        <dd>{result.organizationName}</dd>
        <dt>{messages.documentType}</dt>
        <dd>{result.documentTypeName}</dd>
        <dt>{messages.documentFormat}</dt>
        <dd>{result.documentFormat}</dd>
        <dt>{messages.standard}</dt>
        <dd>
          {result.standardName} · {result.standardVersionLabel}
        </dd>
        <dt>{messages.issued}</dt>
        <dd>{formatDate(result.issuedAt, locale)}</dd>
        <dt>{messages.validUntil}</dt>
        <dd>
          {result.validUntil === null ? messages.noExpiry : formatDate(result.validUntil, locale)}
        </dd>
        {result.revokedAt === null ? null : (
          <>
            <dt>{messages.revokedAt}</dt>
            <dd>{formatDate(result.revokedAt, locale)}</dd>
            {result.revocationReason === null ? null : (
              <>
                <dt>{messages.revocationReason}</dt>
                {/* §67: the category only. The note the institution wrote is
                    theirs, and stays private. */}
                <dd>{messages.reasons[result.revocationReason] ?? result.revocationReason}</dd>
              </>
            )}
          </>
        )}
      </dl>

      <p className="pc-hint">{messages.authorityNote}</p>

      <h3>{messages.hashes}</h3>
      <p className="pc-hint">{messages.hashesHint}</p>
      <dl className="pc-definitions">
        <HashRow locale={locale} label={messages.documentHash} value={result.documentSha256} />
        <HashRow locale={locale} label={messages.reportHash} value={result.reportHash} />
        <HashRow locale={locale} label={messages.standardHash} value={result.standardContentHash} />
        <HashRow
          locale={locale}
          label={messages.evidenceHash}
          value={result.submissionEvidenceHash}
        />
        <HashRow locale={locale} label={messages.claimHash} value={result.certificateClaimHash} />
        <HashRow
          locale={locale}
          label={messages.artifactHash}
          value={result.certificateArtifactSha256}
        />
      </dl>
    </section>
  );
}

/**
 * The holder's own certificate (§116, §118).
 *
 * Has what the public page does not: the verification link to hand to
 * somebody, and the PDF. A revoked certificate still downloads — it is the
 * record of what was issued, and hiding it would not unsay it.
 */
export function CertificateCard({
  locale,
  certificate,
  api = DEFAULT_API,
}: {
  locale: Locale;
  certificate: CertificateResponse;
  api?: CertificateApi;
}) {
  const messages = getCertificatesMessages(locale);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);

  const download = useCallback(async () => {
    setError(null);
    setBusy(true);
    try {
      const grant = await api.download(certificate.id);
      window.location.assign(grant.url);
    } catch (caught) {
      setError(describe(caught, locale));
    } finally {
      setBusy(false);
    }
  }, [api, certificate.id, locale]);

  const copyLink = useCallback(() => {
    if (certificate.verificationUrl === null) return;
    void navigator.clipboard?.writeText(certificate.verificationUrl).then(() => setCopied(true));
  }, [certificate.verificationUrl]);

  const issued = certificate.issuedAt !== null;

  return (
    <section className="pc-card" aria-labelledby={`certificate-${certificate.id}`}>
      <h2 id={`certificate-${certificate.id}`}>
        {certificate.revokedAt === null ? messages.statuses.VALID : messages.statuses.REVOKED}
      </h2>
      <dl className="pc-definitions">
        <dt>{messages.certificateNumber}</dt>
        <dd>
          <code>{certificate.certificateNumber ?? '—'}</code>
        </dd>
        <AuthorityRows
          locale={locale}
          technicalResult={certificate.technicalResult}
          institutionDecision={certificate.institutionDecision}
        />
        <dt>{messages.organization}</dt>
        <dd>{certificate.organizationName}</dd>
        <dt>{messages.documentType}</dt>
        <dd>{certificate.documentTypeName}</dd>
        <dt>{messages.standard}</dt>
        <dd>
          {certificate.standardName} · {certificate.standardVersionLabel}
        </dd>
        {certificate.issuedAt === null ? null : (
          <>
            <dt>{messages.issued}</dt>
            <dd>{formatDate(certificate.issuedAt, locale)}</dd>
          </>
        )}
        <dt>{messages.validUntil}</dt>
        <dd>
          {certificate.validUntil === null
            ? messages.noExpiry
            : formatDate(certificate.validUntil, locale)}
        </dd>
      </dl>

      {issued ? (
        <div className="pc-actions">
          <button type="button" onClick={() => void download()} disabled={busy}>
            {messages.download}
          </button>
          {certificate.verificationUrl === null ? null : (
            <button type="button" className="pc-button-quiet" onClick={copyLink}>
              {copied ? messages.copied : messages.copyLink}
            </button>
          )}
        </div>
      ) : (
        <p>{messages.issuanceStatuses[certificate.issuanceStatus] ?? ''}</p>
      )}

      {error === null ? null : <p role="alert">{error}</p>}
    </section>
  );
}

/**
 * What a submission screen says about its certificate (§116–§121).
 *
 * The ineligible case is the one worth care. "No certificate" is useless;
 * which of the two authorities has not said yes is what a person can act on,
 * and saying the wrong one would blame a university for PalCert's finding.
 */
export function SubmissionCertificateSection({
  locale,
  status,
  api = DEFAULT_API,
}: {
  locale: Locale;
  status: SubmissionCertificateStatusResponse;
  api?: CertificateApi;
}) {
  const messages = getCertificatesMessages(locale);

  if (status.certificate !== null) {
    return <CertificateCard locale={locale} certificate={status.certificate} api={api} />;
  }

  return (
    <section className="pc-card" aria-labelledby="certificate-status-heading">
      <h2 id="certificate-status-heading">{messages.title}</h2>
      <p>
        {status.reason === null
          ? messages.issuanceStatuses.PENDING
          : (messages.ineligible[status.reason] ?? messages.genericError)}
      </p>
    </section>
  );
}

/**
 * Withdrawing a certificate (§59–§70).
 *
 * Two deliberate frictions: the reason is a closed list, because PalCert
 * cannot adjudicate an institution's change of mind and a free-text reason
 * shown publicly would put PalCert's name on their judgement; and the note is
 * marked private on the form itself, so nobody writes something there
 * expecting a stranger to read it.
 */
export function RevokeCertificate({
  locale,
  organizationId,
  certificateId,
  api = DEFAULT_REVIEW_API,
  onRevoked,
}: {
  locale: Locale;
  organizationId: string;
  certificateId: string;
  api?: CertificateReviewApi;
  onRevoked?: (certificate: CertificateResponse) => void;
}) {
  const messages = getCertificatesMessages(locale);
  const [reasonCode, setReasonCode] = useState<string>(REVOCATION_REASONS[0]);
  const [comment, setComment] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = useCallback(async () => {
    setError(null);
    setBusy(true);
    try {
      const revoked = await api.revoke(organizationId, certificateId, {
        reasonCode,
        comment: comment.trim() === '' ? undefined : comment.trim(),
      });
      onRevoked?.(revoked);
    } catch (caught) {
      setError(describe(caught, locale));
    } finally {
      setBusy(false);
    }
  }, [api, certificateId, comment, locale, onRevoked, organizationId, reasonCode]);

  return (
    <section className="pc-card" aria-labelledby="revoke-heading">
      <h2 id="revoke-heading">{messages.revoke}</h2>
      <p className="pc-hint">{messages.revokeHint}</p>

      <label htmlFor="revoke-reason">{messages.revokeReasonLabel}</label>
      <select
        id="revoke-reason"
        value={reasonCode}
        onChange={(event) => setReasonCode(event.target.value)}
      >
        {REVOCATION_REASONS.map((reason) => (
          <option key={reason} value={reason}>
            {messages.reasons[reason]}
          </option>
        ))}
      </select>

      <label htmlFor="revoke-comment">{messages.revokeCommentLabel}</label>
      <textarea
        id="revoke-comment"
        value={comment}
        maxLength={2000}
        onChange={(event) => setComment(event.target.value)}
        aria-describedby="revoke-comment-hint"
      />
      <p id="revoke-comment-hint" className="pc-hint">
        {messages.revokeCommentHint}
      </p>

      <button type="button" onClick={() => void submit()} disabled={busy}>
        {busy ? messages.revoking : messages.revoke}
      </button>
      {error === null ? null : <p role="alert">{error}</p>}
    </section>
  );
}
