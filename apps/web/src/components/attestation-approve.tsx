'use client';

import type { AttestationRequestReviewView } from '@palcert/contracts';
import { useId, useState, type FormEvent } from 'react';
import { describeAttestationError } from '@/components/attestation';
import { FormError } from '@/components/auth-form';
import { Dialog } from '@/components/ui/dialog';
import type { AttestationsMessages } from '@/i18n/attestations-messages';
import type { ApproveAttestationInput } from '@/lib/attestations-api';

type ValidityMode = 'days' | 'until' | 'none';

/**
 * Approve and attest: the confirmed details, what the public page may show,
 * the validity, and the reviewer's explicit confirmation.
 */
export function ApproveDialog({
  view,
  messages,
  onApprove,
}: {
  view: AttestationRequestReviewView;
  messages: AttestationsMessages;
  onApprove: (input: ApproveAttestationInput) => Promise<void>;
}) {
  const r = messages.review;
  const id = useId();
  const policy = view.typePolicy;
  const initial = () => ({
    certificateTitle: view.submitted.certificateTitle,
    certificateType: view.submitted.certificateType ?? '',
    holderName: view.submitted.recipientName ?? '',
    issuingOrganization: view.submitted.issuingOrganization ?? '',
    issueDate: view.submitted.issueDate ?? '',
    referenceNumber: view.submitted.referenceNumber ?? '',
    institutionNote: '',
    validFrom: '',
    validityDays: policy.defaultValidityDays === null ? '' : String(policy.defaultValidityDays),
    validUntil: '',
  });
  const [open, setOpen] = useState(false);
  const [values, setValues] = useState(initial);
  const [mode, setMode] = useState<ValidityMode>(
    policy.defaultValidityDays === null ? 'none' : 'days',
  );
  const [holderPublic, setHolderPublic] = useState(true);
  const [referencePublic, setReferencePublic] = useState(true);
  const [confirmed, setConfirmed] = useState(false);
  const [pending, setPending] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);

  const set = (key: keyof ReturnType<typeof initial>) => (event: { target: { value: string } }) =>
    setValues((current) => ({ ...current, [key]: event.target.value }));
  const orNull = (value: string) => (value.trim() === '' ? null : value.trim());

  function close(): void {
    setOpen(false);
    setValues(initial());
    setConfirmed(false);
    setFailure(null);
  }

  async function submit(event: FormEvent): Promise<void> {
    event.preventDefault();
    if (pending) return;
    if (!confirmed) {
      setFailure(messages.errors['ATTESTATION_CONFIRMATION_REQUIRED'] ?? messages.genericError);
      return;
    }
    if (values.certificateTitle.trim() === '') {
      setFailure(`${messages.fields['certificateTitle']}: ${messages.required}`);
      return;
    }
    const usesDefault =
      policy.defaultValidityDays !== null &&
      (!policy.reviewerMayOverrideValidity ||
        Number(values.validityDays) === policy.defaultValidityDays);
    setPending(true);
    setFailure(null);
    try {
      await onApprove({
        confirm: true,
        certificateTitle: values.certificateTitle.trim(),
        certificateType: orNull(values.certificateType),
        holderName: orNull(values.holderName),
        issuingOrganization: orNull(values.issuingOrganization),
        issueDate: orNull(values.issueDate),
        referenceNumber: orNull(values.referenceNumber),
        holderNamePublic: holderPublic,
        referenceNumberPublic: referencePublic,
        institutionNote: orNull(values.institutionNote),
        ...(values.validFrom === ''
          ? {}
          : { validFrom: new Date(`${values.validFrom}T00:00:00Z`).toISOString() }),
        // The type's own default needs no override, and a type that fixes its
        // validity refuses one, so the default is sent as "nothing chosen".
        ...(mode === 'days'
          ? usesDefault
            ? {}
            : { validityDays: Number(values.validityDays) }
          : mode === 'until'
            ? { validUntil: new Date(`${values.validUntil}T23:59:59Z`).toISOString() }
            : { noExpiry: true }),
      });
      close();
    } catch (caught) {
      setFailure(describeAttestationError(messages, caught));
    } finally {
      setPending(false);
    }
  }

  const text = (
    key: keyof ReturnType<typeof initial>,
    label: string,
    type = 'text',
    maxLength = 300,
  ) => (
    <div className="pc-field">
      <label htmlFor={`${id}-${key}`}>{label}</label>
      <input
        id={`${id}-${key}`}
        type={type}
        maxLength={maxLength}
        value={values[key]}
        onChange={set(key)}
        {...(type === 'date' || type === 'number' ? { dir: 'ltr' } : {})}
      />
    </div>
  );

  return (
    <>
      <button
        type="button"
        className="pc-btn"
        onClick={() => setOpen(true)}
        data-testid="approve-open"
      >
        {r.approve}
      </button>
      <Dialog
        open={open}
        title={r.approveTitle}
        description={<p>{r.approveIntro}</p>}
        onClose={close}
        closeLabel={messages.close}
      >
        <form className="pc-form" onSubmit={(event) => void submit(event)} noValidate>
          {failure === null ? null : <FormError message={failure} />}
          {text('certificateTitle', messages.fields['certificateTitle'] ?? '')}
          {text('certificateType', messages.fields['certificateType'] ?? '')}
          {text('holderName', r.holderName)}
          <label className="pc-check">
            <input
              type="checkbox"
              checked={holderPublic}
              onChange={(event) => setHolderPublic(event.target.checked)}
            />
            {r.showHolderName}
          </label>
          {text('issuingOrganization', messages.fields['issuingOrganization'] ?? '')}
          {text('issueDate', messages.fields['issueDate'] ?? '', 'date', 10)}
          {text('referenceNumber', messages.fields['referenceNumber'] ?? '')}
          <label className="pc-check">
            <input
              type="checkbox"
              checked={referencePublic}
              onChange={(event) => setReferencePublic(event.target.checked)}
            />
            {r.showReference}
          </label>
          {text('validFrom', r.validFrom, 'date', 10)}
          <fieldset className="pc-fieldset">
            <legend>{r.validityMode}</legend>
            {(
              [
                [
                  'days',
                  r.validityDays,
                  policy.reviewerMayOverrideValidity || policy.defaultValidityDays !== null,
                ],
                ['until', r.validityUntil, policy.reviewerMayOverrideValidity],
                ['none', r.validityNone, policy.allowNoExpiry],
              ] as const
            )
              .filter(([, , allowed]) => allowed)
              .map(([value, label]) => (
                <label key={value} className="pc-radio">
                  <input
                    type="radio"
                    name={`${id}-validity`}
                    value={value}
                    checked={mode === value}
                    onChange={() => setMode(value)}
                  />
                  {label}
                </label>
              ))}
          </fieldset>
          {mode === 'days' ? (
            <div className="pc-field">
              <label htmlFor={`${id}-days`}>{r.validityDaysLabel}</label>
              <input
                id={`${id}-days`}
                type="number"
                min={1}
                max={36500}
                dir="ltr"
                value={values.validityDays}
                readOnly={!policy.reviewerMayOverrideValidity}
                onChange={set('validityDays')}
              />
            </div>
          ) : null}
          {mode === 'until' ? text('validUntil', r.validUntilLabel, 'date', 10) : null}
          <div className="pc-field">
            <label htmlFor={`${id}-note`}>{r.institutionNote}</label>
            <textarea
              id={`${id}-note`}
              rows={2}
              maxLength={2000}
              value={values.institutionNote}
              onChange={set('institutionNote')}
            />
            <p className="pc-hint">{r.institutionNoteHint}</p>
          </div>
          <label className="pc-check">
            <input
              type="checkbox"
              checked={confirmed}
              onChange={(event) => setConfirmed(event.target.checked)}
              data-testid="approve-confirm"
            />
            {r.confirmLabel}
          </label>
          <div className="pc-actions">
            <button type="button" className="secondary" onClick={close}>
              {messages.cancel}
            </button>
            <button
              type="submit"
              className="pc-btn"
              disabled={pending}
              data-testid="approve-submit"
            >
              {pending ? r.approving : r.approve}
            </button>
          </div>
        </form>
      </Dialog>
    </>
  );
}
