'use client';

import type { AttestationTypeView } from '@palcert/contracts';
import Link from 'next/link';
import { useCallback, useEffect, useId, useState, type FormEvent } from 'react';
import { describeAttestationError, money } from '@/components/attestation';
import { FormError } from '@/components/auth-form';
import { OrganizationShell } from '@/components/organization-shell';
import { DataTable } from '@/components/ui/data-table';
import { PageHeader } from '@/components/ui/page-header';
import { EmptyState, ErrorState, LoadingState } from '@/components/ui/states';
import { StatusBadge } from '@/components/ui/status-badge';
import { getAttestationsMessages, type AttestationsMessages } from '@/i18n/attestations-messages';
import type { Locale } from '@/i18n/locales';
import { getOrganizationMessages } from '@/i18n/organization-messages';
import { attestationReviewApi, type AttestationTypeInput } from '@/lib/attestations-api';
import { toDecimalString, toMinorUnits } from '@/lib/money';

const FORMATS = ['PDF', 'PNG', 'JPEG', 'WEBP'] as const;
const OPTIONAL_FIELDS = [
  'certificateType',
  'issuingOrganization',
  'issueDate',
  'referenceNumber',
  'recipientName',
  'description',
] as const;
const CURRENCIES = ['USD', 'EUR', 'ILS', 'JOD'] as const;

/** The institution's attestation types: what it attests, for how much, for how long. */
export default function AttestationTypesPage() {
  return (
    <OrganizationShell>
      {({ organizationId, locale, permissions }) =>
        permissions.has('attestation:type:manage') ? (
          <Types
            locale={locale}
            organizationId={organizationId}
            canSetFee={permissions.has('attestation:fee:manage')}
          />
        ) : (
          <>
            <PageHeader title={getAttestationsMessages(locale).types.title} />
            <ErrorState
              title={getOrganizationMessages(locale).errors['ORGANIZATION_ACCESS_DENIED'] ?? ''}
            />
          </>
        )
      }
    </OrganizationShell>
  );
}

function Types({
  locale,
  organizationId,
  canSetFee,
}: {
  locale: Locale;
  organizationId: string;
  canSetFee: boolean;
}) {
  const messages = getAttestationsMessages(locale);
  const t = messages.types;
  const [types, setTypes] = useState<AttestationTypeView[] | null>(null);
  const [editing, setEditing] = useState<AttestationTypeView | 'new' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setTypes(await attestationReviewApi.types(organizationId));
    } catch (caught) {
      setError(describeAttestationError(messages, caught));
    }
  }, [organizationId, messages]);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <>
      <Link
        className="pc-back-link"
        href={`/${locale}/organizations/${organizationId}/attestations`}
      >
        {messages.review.backToQueue}
      </Link>
      <PageHeader
        title={t.title}
        description={t.intro}
        actions={
          editing === null ? (
            <button
              type="button"
              className="pc-btn"
              onClick={() => setEditing('new')}
              data-testid="new-attestation-type"
            >
              {t.newType}
            </button>
          ) : undefined
        }
      />
      {error === null ? null : <FormError message={error} />}
      {notice === null ? null : (
        <p role="status" className="pc-hint">
          {notice}
        </p>
      )}

      {editing === null ? null : (
        <TypeForm
          key={editing === 'new' ? 'new' : editing.id}
          messages={messages}
          initial={editing === 'new' ? null : editing}
          canSetFee={canSetFee}
          onCancel={() => setEditing(null)}
          onSave={async (input, fee) => {
            if (editing === 'new') {
              await attestationReviewApi.createType(organizationId, { ...input, ...fee });
              setNotice(t.created);
            } else {
              await attestationReviewApi.updateType(organizationId, editing.id, input);
              if (
                canSetFee &&
                (fee.currency !== editing.fee.currency ||
                  fee.feeMinorUnits !== editing.fee.minorUnits)
              ) {
                await attestationReviewApi.setFee(
                  organizationId,
                  editing.id,
                  fee.currency,
                  fee.feeMinorUnits,
                );
              }
              setNotice(t.saved);
            }
            setEditing(null);
            await load();
          }}
        />
      )}

      {types === null ? (
        <LoadingState label={messages.loading} />
      ) : types.length === 0 ? (
        <EmptyState icon="types" title={t.emptyTitle} description={t.emptyHint} />
      ) : (
        <DataTable
          caption={t.title}
          rows={types}
          rowKey={(type) => type.id}
          columns={[
            {
              key: 'name',
              header: t.nameEn,
              primary: true,
              cell: (type) => (
                <span className="pc-cell-stack">
                  <bdi>{locale === 'ar' ? type.nameAr : type.nameEn}</bdi>
                  <span className="pc-hint">
                    <bdi>{locale === 'ar' ? type.nameEn : type.nameAr}</bdi>
                  </span>
                </span>
              ),
            },
            {
              key: 'fee',
              header: t.fee,
              align: 'end',
              cell: (type) => <span className="pc-money">{money(type.fee, locale)}</span>,
            },
            {
              key: 'validity',
              header: t.defaultValidityDays,
              cell: (type) =>
                type.defaultValidityDays === null
                  ? messages.noExpiry
                  : String(type.defaultValidityDays),
            },
            {
              key: 'formats',
              header: t.allowedFormats,
              cell: (type) => type.allowedFormats.join(', '),
            },
            {
              key: 'enabled',
              header: messages.queue.status,
              cell: (type) => (
                <StatusBadge
                  status={type.enabled ? 'ACTIVE' : 'DISABLED'}
                  label={type.enabled ? t.enabled : t.disabled}
                />
              ),
            },
            {
              key: 'edit',
              header: t.editType,
              cell: (type) => (
                <button
                  type="button"
                  className="pc-btn pc-btn-secondary pc-btn-sm"
                  onClick={() => setEditing(type)}
                >
                  {t.editType}
                </button>
              ),
            },
          ]}
        />
      )}
    </>
  );
}

function TypeForm({
  messages,
  initial,
  canSetFee,
  onCancel,
  onSave,
}: {
  messages: AttestationsMessages;
  initial: AttestationTypeView | null;
  canSetFee: boolean;
  onCancel: () => void;
  onSave: (
    input: AttestationTypeInput,
    fee: { currency: string; feeMinorUnits: string },
  ) => Promise<void>;
}) {
  const t = messages.types;
  const id = useId();
  const [values, setValues] = useState({
    nameEn: initial?.nameEn ?? '',
    nameAr: initial?.nameAr ?? '',
    descriptionEn: initial?.descriptionEn ?? '',
    descriptionAr: initial?.descriptionAr ?? '',
    instructionsEn: initial?.instructionsEn ?? '',
    instructionsAr: initial?.instructionsAr ?? '',
    currency: initial?.fee.currency ?? 'USD',
    fee: initial === null ? '0.00' : toDecimalString(initial.fee.minorUnits, initial.fee.currency),
    defaultValidityDays:
      initial === null
        ? '365'
        : initial.defaultValidityDays === null
          ? ''
          : String(initial.defaultValidityDays),
    maxFileMb: initial === null ? '20' : String(Math.floor(initial.maxFileBytes / (1024 * 1024))),
    reminderDays: (initial?.reminderDays ?? [30, 14, 7, 1]).join(', '),
  });
  const [enabled, setEnabled] = useState(initial?.enabled ?? true);
  const [allowNoExpiry, setAllowNoExpiry] = useState(initial?.allowNoExpiry ?? false);
  const [override, setOverride] = useState(initial?.reviewerMayOverrideValidity ?? true);
  const [requiredFields, setRequiredFields] = useState<Set<string>>(
    new Set(initial?.requiredFields ?? []),
  );
  const [formats, setFormats] = useState<Set<string>>(new Set(initial?.allowedFormats ?? FORMATS));
  const [pending, setPending] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);

  const set = (key: keyof typeof values) => (event: { target: { value: string } }) =>
    setValues((current) => ({ ...current, [key]: event.target.value }));
  const orNull = (value: string) => (value.trim() === '' ? null : value.trim());
  const toggle = (setter: typeof setFormats, value: string) =>
    setter((current) => {
      const next = new Set(current);
      if (next.has(value)) next.delete(value);
      else next.add(value);
      return next;
    });

  async function submit(event: FormEvent): Promise<void> {
    event.preventDefault();
    if (pending) return;
    const feeMinorUnits = toMinorUnits(values.fee, values.currency);
    const reminders = values.reminderDays
      .split(/[,،\s]+/)
      .filter((part) => part !== '')
      .map(Number);
    if (values.nameEn.trim() === '' || values.nameAr.trim() === '') {
      setFailure(`${t.nameEn} / ${t.nameAr}: ${messages.required}`);
      return;
    }
    if (feeMinorUnits === null) {
      setFailure(`${t.fee}: ${t.feeHint}`);
      return;
    }
    if (reminders.some((day) => !Number.isInteger(day) || day < 1)) {
      setFailure(`${t.reminderDays}: ${t.reminderHint}`);
      return;
    }
    setPending(true);
    setFailure(null);
    try {
      await onSave(
        {
          nameEn: values.nameEn.trim(),
          nameAr: values.nameAr.trim(),
          descriptionEn: orNull(values.descriptionEn),
          descriptionAr: orNull(values.descriptionAr),
          instructionsEn: orNull(values.instructionsEn),
          instructionsAr: orNull(values.instructionsAr),
          enabled,
          defaultValidityDays:
            values.defaultValidityDays.trim() === '' ? null : Number(values.defaultValidityDays),
          allowNoExpiry,
          reviewerMayOverrideValidity: override,
          requiredFields: [...requiredFields],
          allowedFormats: [...formats],
          maxFileBytes: Math.max(1, Number(values.maxFileMb) || 20) * 1024 * 1024,
          reminderDays: [...new Set(reminders)].sort((a, b) => b - a),
        },
        { currency: values.currency, feeMinorUnits },
      );
    } catch (caught) {
      setFailure(describeAttestationError(messages, caught));
    } finally {
      setPending(false);
    }
  }

  const input = (
    key: keyof typeof values,
    label: string,
    options: { ltr?: boolean; hint?: string; multiline?: boolean; type?: string } = {},
  ) => (
    <div className="pc-field">
      <label htmlFor={`${id}-${key}`}>{label}</label>
      {options.multiline === true ? (
        <textarea
          id={`${id}-${key}`}
          rows={2}
          maxLength={2000}
          value={values[key]}
          onChange={set(key)}
        />
      ) : (
        <input
          id={`${id}-${key}`}
          type={options.type ?? 'text'}
          value={values[key]}
          onChange={set(key)}
          {...(options.ltr === true ? { dir: 'ltr' } : {})}
          {...(options.hint === undefined ? {} : { 'aria-describedby': `${id}-${key}-hint` })}
        />
      )}
      {options.hint === undefined ? null : (
        <p id={`${id}-${key}-hint`} className="pc-hint">
          {options.hint}
        </p>
      )}
    </div>
  );

  return (
    <section
      className="pc-card"
      aria-labelledby={`${id}-title`}
      data-testid="attestation-type-form"
    >
      <h2 id={`${id}-title`} className="pc-card-title">
        {initial === null ? t.newType : t.editType}
      </h2>
      <form className="pc-form" onSubmit={(event) => void submit(event)} noValidate>
        {failure === null ? null : <FormError message={failure} />}
        {input('nameEn', t.nameEn, { ltr: true })}
        <div className="pc-field">
          <label htmlFor={`${id}-nameAr`}>{t.nameAr}</label>
          <input
            id={`${id}-nameAr`}
            dir="rtl"
            lang="ar"
            value={values.nameAr}
            onChange={set('nameAr')}
          />
        </div>
        {input('descriptionEn', t.descriptionEn, { multiline: true })}
        {input('descriptionAr', t.descriptionAr, { multiline: true })}
        {input('instructionsEn', t.instructionsEn, { multiline: true })}
        {input('instructionsAr', t.instructionsAr, { multiline: true })}

        <fieldset className="pc-fieldset" disabled={initial !== null && !canSetFee}>
          <legend>{t.fee}</legend>
          <div className="pc-field">
            <label htmlFor={`${id}-currency`}>{t.currency}</label>
            <select id={`${id}-currency`} value={values.currency} onChange={set('currency')}>
              {CURRENCIES.map((currency) => (
                <option key={currency} value={currency}>
                  {currency}
                </option>
              ))}
            </select>
          </div>
          {input('fee', t.fee, {
            ltr: true,
            hint: initial === null ? t.feeHint : `${t.feeHint} ${t.feeChangeNote}`,
          })}
        </fieldset>

        {input('defaultValidityDays', t.defaultValidityDays, {
          ltr: true,
          type: 'number',
          hint: t.defaultValidityHint,
        })}
        <label className="pc-check">
          <input
            type="checkbox"
            checked={allowNoExpiry}
            onChange={(event) => setAllowNoExpiry(event.target.checked)}
          />
          {t.allowNoExpiry}
        </label>
        <label className="pc-check">
          <input
            type="checkbox"
            checked={override}
            onChange={(event) => setOverride(event.target.checked)}
          />
          {t.reviewerMayOverride}
        </label>

        <fieldset className="pc-fieldset">
          <legend>{t.requiredFields}</legend>
          <label className="pc-check">
            <input type="checkbox" checked disabled />
            {messages.fields['certificateTitle']}
          </label>
          {OPTIONAL_FIELDS.map((field) => (
            <label key={field} className="pc-check">
              <input
                type="checkbox"
                checked={requiredFields.has(field)}
                onChange={() => toggle(setRequiredFields, field)}
              />
              {messages.fields[field]}
            </label>
          ))}
        </fieldset>

        <fieldset className="pc-fieldset">
          <legend>{t.allowedFormats}</legend>
          {FORMATS.map((format) => (
            <label key={format} className="pc-check">
              <input
                type="checkbox"
                checked={formats.has(format)}
                onChange={() => toggle(setFormats, format)}
              />
              {format}
            </label>
          ))}
        </fieldset>
        {input('maxFileMb', t.maxFileMb, { ltr: true, type: 'number' })}
        {input('reminderDays', t.reminderDays, { ltr: true, hint: t.reminderHint })}
        <label className="pc-check">
          <input
            type="checkbox"
            checked={enabled}
            onChange={(event) => setEnabled(event.target.checked)}
          />
          {t.enabled}
        </label>

        <div className="pc-actions">
          <button type="button" className="secondary" onClick={onCancel}>
            {messages.cancel}
          </button>
          <button
            type="submit"
            className="pc-btn"
            disabled={pending}
            data-testid="save-attestation-type"
          >
            {pending ? messages.saving : messages.save}
          </button>
        </div>
      </form>
    </section>
  );
}
