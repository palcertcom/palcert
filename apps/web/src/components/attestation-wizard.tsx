'use client';

import type {
  AttestationArtifactView,
  AttestationCatalogueOrganizationView,
  AttestationQuoteView,
  AttestationRequestOwnerView,
  AttestationTypePublicView,
} from '@palcert/contracts';
import Link from 'next/link';
import { useCallback, useEffect, useId, useRef, useState, type FormEvent } from 'react';
import {
  AttestationDisclaimer,
  HashValue,
  describeAttestationError,
  money,
} from '@/components/attestation';
import { FormError } from '@/components/auth-form';
import { StepProgress } from '@/components/ui/step-progress';
import { StatusBadge } from '@/components/ui/status-badge';
import type { AttestationsMessages } from '@/i18n/attestations-messages';
import type { Locale } from '@/i18n/locales';
import { newIdempotencyKey, uploadToStorage } from '@/lib/api-client';
import { attestationsApi, type AttestationMetadataInput } from '@/lib/attestations-api';

const STEP = { INSTITUTION: 0, TYPE: 1, DETAILS: 2, FILE: 3, REVIEW: 4 } as const;
const SETTLED = new Set(['READY', 'REJECTED', 'FAILED', 'UPLOAD_EXPIRED', 'CANCELLED']);
const EXTENSIONS: Record<string, string> = {
  PDF: '.pdf',
  PNG: '.png',
  JPEG: '.jpg,.jpeg',
  WEBP: '.webp',
};
const MIME: Record<string, string> = {
  PDF: 'application/pdf',
  PNG: 'image/png',
  JPEG: 'image/jpeg',
  WEBP: 'image/webp',
};

type Fields = Record<
  | 'certificateTitle'
  | 'certificateType'
  | 'issuingOrganization'
  | 'issueDate'
  | 'referenceNumber'
  | 'recipientName'
  | 'description'
  | 'notesForReviewer',
  string
>;

const EMPTY_FIELDS: Fields = {
  certificateTitle: '',
  certificateType: '',
  issuingOrganization: '',
  issueDate: '',
  referenceNumber: '',
  recipientName: '',
  description: '',
  notesForReviewer: '',
};

function toInput(fields: Fields): AttestationMetadataInput {
  const orNull = (value: string) => (value.trim() === '' ? null : value.trim());
  return {
    certificateTitle: fields.certificateTitle.trim(),
    certificateType: orNull(fields.certificateType),
    issuingOrganization: orNull(fields.issuingOrganization),
    issueDate: orNull(fields.issueDate),
    referenceNumber: orNull(fields.referenceNumber),
    recipientName: orNull(fields.recipientName),
    description: orNull(fields.description),
    notesForReviewer: orNull(fields.notesForReviewer),
  };
}

function fromRequest(request: AttestationRequestOwnerView): Fields {
  const s = request.submitted;
  return {
    certificateTitle: s.certificateTitle ?? '',
    certificateType: s.certificateType ?? '',
    issuingOrganization: s.issuingOrganization ?? '',
    issueDate: s.issueDate ?? '',
    referenceNumber: s.referenceNumber ?? '',
    recipientName: s.recipientName ?? '',
    description: s.description ?? '',
    notesForReviewer: request.notesForReviewer ?? '',
  };
}

export interface AttestationWizardProps {
  readonly locale: Locale;
  readonly messages: AttestationsMessages;
  /** Resume this draft. */
  readonly draftId?: string | null;
  /** Renew the attestation on this earlier request. */
  readonly renewFromRequestId?: string | null;
  readonly onSubmitted: (requestId: string) => void;
  readonly api?: typeof attestationsApi;
  readonly upload?: typeof uploadToStorage;
  readonly pollIntervalMs?: number;
}

/**
 * Asking an institution to attest a certificate the user holds.
 *
 * Institution, then the kind of attestation (which fixes the fee, the file
 * types and the details required), then the details, then the file, then a
 * review that states the fee against the user's balance before anything is
 * reserved. A draft is created once the details are first saved, so leaving
 * half-way loses nothing; nothing is reserved until Submit.
 */
export function AttestationWizard({
  locale,
  messages,
  draftId = null,
  renewFromRequestId = null,
  onSubmitted,
  api = attestationsApi,
  upload = uploadToStorage,
  pollIntervalMs = 1000,
}: AttestationWizardProps) {
  const w = messages.wizard;
  const formId = useId();
  const [step, setStep] = useState<number>(STEP.INSTITUTION);
  const [organizations, setOrganizations] = useState<AttestationCatalogueOrganizationView[] | null>(
    null,
  );
  const [organizationId, setOrganizationId] = useState<string | null>(null);
  const [types, setTypes] = useState<AttestationTypePublicView[] | null>(null);
  const [typeId, setTypeId] = useState<string | null>(null);
  const [fields, setFields] = useState<Fields>(EMPTY_FIELDS);
  const [request, setRequest] = useState<AttestationRequestOwnerView | null>(null);
  const [previousAttestation, setPreviousAttestation] = useState<{
    id: string;
    reference: string;
  } | null>(null);
  const [file, setFile] = useState<File | null>(null);
  const [progress, setProgress] = useState<number | null>(null);
  const [artifact, setArtifact] = useState<AttestationArtifactView | null>(null);
  const [quote, setQuote] = useState<AttestationQuoteView | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const createKey = useRef<string>(newIdempotencyKey());
  const heading = useRef<HTMLHeadingElement>(null);

  const fail = useCallback(
    (caught: unknown) => setError(describeAttestationError(messages, caught)),
    [messages],
  );

  // Where the wizard starts: a fresh request, a resumed draft, or a renewal.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const catalogue = await api.catalogue();
        if (cancelled) return;
        setOrganizations(catalogue);
        if (draftId !== null) {
          const draft = await api.get(draftId);
          if (cancelled) return;
          setRequest(draft);
          setOrganizationId(draft.organizationId);
          setTypeId(draft.attestationTypeId);
          setFields(fromRequest(draft));
          setArtifact(draft.artifact);
          setStep(draft.artifact?.status === 'READY' ? STEP.REVIEW : STEP.FILE);
        } else if (renewFromRequestId !== null) {
          const earlier = await api.get(renewFromRequestId);
          if (cancelled) return;
          setOrganizationId(earlier.organizationId);
          setTypeId(earlier.attestationTypeId);
          setFields({ ...fromRequest(earlier), notesForReviewer: '' });
          if (earlier.attestation !== null) {
            setPreviousAttestation({
              id: earlier.attestation.id,
              reference: earlier.attestation.reference,
            });
          }
          setStep(STEP.DETAILS);
        }
      } catch (caught) {
        if (!cancelled) fail(caught);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [api, draftId, renewFromRequestId, fail]);

  // The chosen institution's attestation types.
  useEffect(() => {
    if (organizationId === null) return;
    let cancelled = false;
    setTypes(null);
    void api
      .catalogueTypes(organizationId)
      .then((rows) => {
        if (!cancelled) setTypes(rows);
      })
      .catch((caught: unknown) => {
        if (!cancelled) fail(caught);
      });
    return () => {
      cancelled = true;
    };
  }, [api, organizationId, fail]);

  // While PalCert checks the file, poll the request until the file settles.
  useEffect(() => {
    if (request === null || artifact === null || SETTLED.has(artifact.status)) return;
    const timer = setTimeout(() => {
      void api
        .get(request.id)
        .then((latest) => {
          setRequest(latest);
          setArtifact(latest.artifact);
        })
        .catch(fail);
    }, pollIntervalMs);
    return () => clearTimeout(timer);
  }, [api, request, artifact, pollIntervalMs, fail]);

  // The quote, whenever the review step opens.
  useEffect(() => {
    if (step !== STEP.REVIEW || request === null) return;
    let cancelled = false;
    setQuote(null);
    void api
      .quote(request.id)
      .then((value) => {
        if (!cancelled) setQuote(value);
      })
      .catch((caught: unknown) => {
        if (!cancelled) fail(caught);
      });
    return () => {
      cancelled = true;
    };
  }, [api, step, request, fail]);

  useEffect(() => {
    heading.current?.focus();
  }, [step]);

  const organization = organizations?.find((candidate) => candidate.id === organizationId) ?? null;
  const type = types?.find((candidate) => candidate.id === typeId) ?? null;
  const typeName = (candidate: AttestationTypePublicView) =>
    locale === 'ar' ? candidate.nameAr : candidate.nameEn;
  const required = new Set<string>(['certificateTitle', ...(type?.requiredFields ?? [])]);

  function go(next: number): void {
    setError(null);
    setStep(next);
  }

  async function saveDetails(event: FormEvent): Promise<void> {
    event.preventDefault();
    if (typeId === null || busy) return;
    const missing = [...required].find((key) => fields[key as keyof Fields].trim() === '');
    if (missing !== undefined) {
      setError(`${messages.fields[missing] ?? missing}: ${messages.required}`);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const saved =
        request === null
          ? await api.create(
              {
                attestationTypeId: typeId,
                ...(previousAttestation === null
                  ? {}
                  : { previousAttestationId: previousAttestation.id }),
                ...toInput(fields),
              },
              createKey.current,
            )
          : await api.update(request.id, toInput(fields));
      setRequest(saved);
      setArtifact(saved.artifact);
      go(saved.artifact?.status === 'READY' ? STEP.REVIEW : STEP.FILE);
    } catch (caught) {
      fail(caught);
    } finally {
      setBusy(false);
    }
  }

  async function startUpload(): Promise<void> {
    if (request === null || file === null || busy) return;
    setBusy(true);
    setError(null);
    try {
      const created = await api.createArtifact(
        request.id,
        {
          originalFilename: file.name,
          sizeBytes: file.size,
          ...(file.type ? { declaredMimeType: file.type } : {}),
        },
        newIdempotencyKey(),
      );
      setArtifact(created.artifact);
      setProgress(0);
      await upload(created.upload, file, (fraction) => setProgress(fraction));
      const finalized = await api.finalizeArtifact(request.id, created.artifact.id);
      setArtifact(finalized);
    } catch (caught) {
      fail(caught);
    } finally {
      setProgress(null);
      setBusy(false);
    }
  }

  async function submit(): Promise<void> {
    if (request === null || busy) return;
    setBusy(true);
    setError(null);
    try {
      const submitted = await api.submit(request.id);
      onSubmitted(submitted.id);
    } catch (caught) {
      fail(caught);
      // A shortfall may have changed; show the current numbers.
      void api
        .quote(request.id)
        .then(setQuote)
        .catch(() => undefined);
    } finally {
      setBusy(false);
    }
  }

  const maxMb = type === null ? '20' : (type.maxFileBytes / (1024 * 1024)).toFixed(0);
  const accept = (type?.allowedFormats ?? ['PDF', 'PNG', 'JPEG', 'WEBP'])
    .flatMap((format) => [EXTENSIONS[format], MIME[format]])
    .filter((value): value is string => value !== undefined)
    .join(',');

  return (
    <section
      className="pc-card"
      aria-labelledby={`${formId}-title`}
      data-testid="attestation-wizard"
    >
      <StepProgress steps={w.steps} current={step} label={w.title} stateLabels={w.stepStates} />
      {previousAttestation === null ? null : (
        <p className="pc-hint" data-testid="renewal-of">
          {w.renewalOf(previousAttestation.reference)}
        </p>
      )}
      <h2 id={`${formId}-title`} className="pc-card-title" tabIndex={-1} ref={heading}>
        {w.steps[step]}
      </h2>
      <p className="pc-hint">{w.stepOf(step + 1, w.steps.length)}</p>
      {error === null ? null : <FormError message={error} />}

      {step === STEP.INSTITUTION ? (
        <fieldset className="pc-fieldset">
          <legend>{w.chooseInstitution}</legend>
          <p className="pc-hint">{w.institutionHint}</p>
          {organizations === null ? (
            <p className="pc-hint">{messages.loading}</p>
          ) : organizations.length === 0 ? (
            <p>{w.noInstitutions}</p>
          ) : (
            organizations.map((candidate) => (
              <label key={candidate.id} className="pc-radio">
                <input
                  type="radio"
                  name="organization"
                  value={candidate.id}
                  checked={organizationId === candidate.id}
                  onChange={() => {
                    setOrganizationId(candidate.id);
                    setTypeId(null);
                  }}
                />
                <bdi>{candidate.displayName}</bdi>
                {candidate.verified ? (
                  <span className="pc-hint"> · {w.verifiedInstitution}</span>
                ) : null}
              </label>
            ))
          )}
          <div className="pc-actions">
            <button
              type="button"
              className="pc-btn"
              disabled={organizationId === null}
              onClick={() => go(STEP.TYPE)}
              data-testid="wizard-next"
            >
              {w.next}
            </button>
          </div>
        </fieldset>
      ) : null}

      {step === STEP.TYPE ? (
        <fieldset className="pc-fieldset">
          <legend>
            {w.chooseType} {organization === null ? null : <bdi>({organization.displayName})</bdi>}
          </legend>
          {types === null ? (
            <p className="pc-hint">{messages.loading}</p>
          ) : types.length === 0 ? (
            <p>{w.noTypes}</p>
          ) : (
            types.map((candidate) => {
              const description =
                locale === 'ar' ? candidate.descriptionAr : candidate.descriptionEn;
              return (
                <label key={candidate.id} className="pc-radio">
                  <input
                    type="radio"
                    name="attestationType"
                    value={candidate.id}
                    checked={typeId === candidate.id}
                    onChange={() => setTypeId(candidate.id)}
                  />
                  <span className="pc-cell-stack">
                    <strong>
                      <bdi>{typeName(candidate)}</bdi>
                    </strong>{' '}
                    <span className="pc-money">{money(candidate.fee, locale)}</span>
                    {description === null ? null : <span className="pc-hint">{description}</span>}
                    {candidate.defaultValidityDays === null ? (
                      <span className="pc-hint">{messages.noExpiry}</span>
                    ) : (
                      <span className="pc-hint">
                        {w.defaultValidity(candidate.defaultValidityDays)}
                      </span>
                    )}
                  </span>
                </label>
              );
            })
          )}
          <div className="pc-actions">
            <button type="button" className="secondary" onClick={() => go(STEP.INSTITUTION)}>
              {w.back}
            </button>
            <button
              type="button"
              className="pc-btn"
              disabled={typeId === null}
              onClick={() => go(STEP.DETAILS)}
              data-testid="wizard-next"
            >
              {w.next}
            </button>
          </div>
        </fieldset>
      ) : null}

      {step === STEP.DETAILS ? (
        <form className="pc-form" onSubmit={(event) => void saveDetails(event)} noValidate>
          <p className="pc-hint">{w.detailsIntro}</p>
          {(
            [
              ['certificateTitle', 'text', 300],
              ['certificateType', 'text', 200],
              ['issuingOrganization', 'text', 300],
              ['issueDate', 'date', 10],
              ['referenceNumber', 'text', 200],
              ['recipientName', 'text', 200],
              ['description', 'textarea', 2000],
            ] as const
          ).map(([key, kind, maxLength]) => {
            const id = `${formId}-${key}`;
            const isRequired = required.has(key);
            return (
              <div key={key} className="pc-field">
                <label htmlFor={id}>
                  {messages.fields[key]}
                  {isRequired ? null : <span className="pc-hint"> ({messages.optional})</span>}
                </label>
                {kind === 'textarea' ? (
                  <textarea
                    id={id}
                    name={key}
                    rows={3}
                    maxLength={maxLength}
                    value={fields[key]}
                    onChange={(event) =>
                      setFields((current) => ({ ...current, [key]: event.target.value }))
                    }
                  />
                ) : (
                  <input
                    id={id}
                    name={key}
                    type={kind}
                    maxLength={maxLength}
                    required={isRequired}
                    aria-required={isRequired}
                    {...(kind === 'date' ? { dir: 'ltr' } : {})}
                    value={fields[key]}
                    onChange={(event) =>
                      setFields((current) => ({ ...current, [key]: event.target.value }))
                    }
                  />
                )}
              </div>
            );
          })}
          <div className="pc-field">
            <label htmlFor={`${formId}-notes`}>
              {w.notesForReviewer} <span className="pc-hint">({messages.optional})</span>
            </label>
            <textarea
              id={`${formId}-notes`}
              name="notesForReviewer"
              rows={2}
              maxLength={2000}
              aria-describedby={`${formId}-notes-hint`}
              value={fields.notesForReviewer}
              onChange={(event) =>
                setFields((current) => ({ ...current, notesForReviewer: event.target.value }))
              }
            />
            <p id={`${formId}-notes-hint`} className="pc-hint">
              {w.notesHint}
            </p>
          </div>
          <div className="pc-actions">
            {request === null ? (
              <button type="button" className="secondary" onClick={() => go(STEP.TYPE)}>
                {w.back}
              </button>
            ) : null}
            <button
              type="submit"
              className="pc-btn"
              disabled={busy}
              data-testid="wizard-save-details"
            >
              {busy ? messages.saving : request === null ? w.createDraft : w.next}
            </button>
          </div>
        </form>
      ) : null}

      {step === STEP.FILE ? (
        <div className="pc-form">
          {type === null ? null : (
            <>
              {(locale === 'ar' ? type.instructionsAr : type.instructionsEn) === null ? null : (
                <div className="pc-field">
                  <span className="pc-hint">{w.instructions}</span>
                  <p>
                    <bdi>{locale === 'ar' ? type.instructionsAr : type.instructionsEn}</bdi>
                  </p>
                </div>
              )}
              <p className="pc-hint">{w.acceptedFormats(type.allowedFormats.join(', '), maxMb)}</p>
            </>
          )}
          <div className="pc-field">
            <label htmlFor={`${formId}-file`}>{w.chooseFile}</label>
            <input
              id={`${formId}-file`}
              type="file"
              accept={accept}
              aria-describedby={`${formId}-file-hint`}
              onChange={(event) => setFile(event.target.files?.[0] ?? null)}
            />
            <p id={`${formId}-file-hint`} className="pc-hint">
              {w.fileHint}
            </p>
          </div>
          <div className="pc-actions">
            <button
              type="button"
              className="pc-btn"
              disabled={file === null || busy}
              onClick={() => void startUpload()}
              data-testid="upload-artifact"
            >
              {artifact?.status === 'READY' ? w.replaceFile : w.upload}
            </button>
          </div>
          <div role="status" aria-live="polite" data-testid="artifact-status">
            {progress !== null ? (
              <>
                <progress max={1} value={progress} />
                <span>{w.uploading(Math.round(progress * 100))}</span>
              </>
            ) : artifact === null ? null : artifact.status === 'READY' ? (
              <span>{w.fileReady}</span>
            ) : artifact.status === 'REJECTED' ? (
              <FormError
                message={
                  messages.rejections[artifact.rejectionCode ?? ''] ??
                  messages.artifactStatuses['REJECTED'] ??
                  ''
                }
              />
            ) : SETTLED.has(artifact.status) ? (
              <StatusBadge
                status={artifact.status}
                label={messages.artifactStatuses[artifact.status] ?? artifact.status}
              />
            ) : (
              <span>{w.checking}</span>
            )}
          </div>
          {artifact?.status === 'READY' && artifact.sha256 !== null ? (
            <HashValue
              label={w.fingerprint}
              value={artifact.sha256}
              messages={messages}
              testId="draft-sha256"
            />
          ) : null}
          <div className="pc-actions">
            <button type="button" className="secondary" onClick={() => go(STEP.DETAILS)}>
              {w.back}
            </button>
            <button
              type="button"
              className="pc-btn"
              disabled={artifact?.status !== 'READY'}
              onClick={() => go(STEP.REVIEW)}
              data-testid="wizard-next"
            >
              {w.next}
            </button>
          </div>
        </div>
      ) : null}

      {step === STEP.REVIEW && request !== null ? (
        <div className="pc-form" data-testid="attestation-review-step">
          <dl className="pc-definitions">
            <div>
              <dt>{messages.mine.institution}</dt>
              <dd>
                <bdi>{request.organizationName}</bdi>
              </dd>
            </div>
            <div>
              <dt>{messages.mine.type}</dt>
              <dd>
                <bdi>
                  {locale === 'ar'
                    ? request.attestationTypeName.ar
                    : request.attestationTypeName.en}
                </bdi>
              </dd>
            </div>
            <div>
              <dt>{messages.fields['certificateTitle']}</dt>
              <dd>
                <bdi>{fields.certificateTitle}</bdi>
              </dd>
            </div>
            {artifact === null ? null : (
              <div>
                <dt>{messages.details.file}</dt>
                <dd>
                  <bdi>{artifact.originalFilename}</bdi>
                </dd>
              </div>
            )}
          </dl>
          {artifact?.sha256 ? (
            <HashValue label={w.fingerprint} value={artifact.sha256} messages={messages} />
          ) : null}

          {quote === null ? (
            <p className="pc-hint">{messages.loading}</p>
          ) : (
            <>
              <dl className="pc-definitions" data-testid="attestation-quote">
                <div>
                  <dt>{w.feeLabel}</dt>
                  <dd className="pc-money" data-testid="quote-fee">
                    {money(quote.fee, locale)}
                  </dd>
                </div>
                <div>
                  <dt>{w.balanceLabel}</dt>
                  <dd className="pc-money" data-testid="quote-balance">
                    {money(quote.availableBalance, locale)}
                  </dd>
                </div>
              </dl>
              {quote.fee.minorUnits === '0' ? (
                <p>{w.freeOfCharge}</p>
              ) : (
                <p className="pc-hint">{w.reserveNote}</p>
              )}
              <p className="pc-hint">{w.refundPolicy}</p>
              {quote.sufficient ? null : (
                <div role="alert" data-testid="insufficient-balance">
                  <p>{w.insufficient(money(quote.shortfall, locale))}</p>
                  <Link className="pc-btn pc-btn-secondary" href={`/${locale}/balance`}>
                    {w.topUp}
                  </Link>
                </div>
              )}
            </>
          )}
          <div className="pc-actions">
            <button type="button" className="secondary" onClick={() => go(STEP.DETAILS)}>
              {w.back}
            </button>
            <button
              type="button"
              className="pc-btn"
              disabled={busy || quote === null || !quote.sufficient}
              onClick={() => void submit()}
              data-testid="submit-attestation"
            >
              {busy ? w.submitting : w.submit}
            </button>
          </div>
        </div>
      ) : null}
      <AttestationDisclaimer messages={messages} />
    </section>
  );
}
