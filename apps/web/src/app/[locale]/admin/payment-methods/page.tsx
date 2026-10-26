'use client';

import type {
  AdminManualPaymentMethodView,
  ManualTopUpReviewerCandidateView,
} from '@palcert/contracts/finance/manual-topups';
import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { AdminGate, ReauthNotice, useAdminLocale } from '@/components/admin/admin-kit';
import { MethodMark, describeTopUpError, methodName } from '@/components/manual-topup';
import { useShell } from '@/components/shell/shell-context';
import { ConfirmAction } from '@/components/ui/confirm-action';
import { PageHeader } from '@/components/ui/page-header';
import { StatusBadge } from '@/components/ui/status-badge';
import { EmptyState, LoadingState } from '@/components/ui/states';
import type { Locale } from '@/i18n/locales';
import { getManualTopUpMessages } from '@/i18n/manual-topup-messages';
import { newIdempotencyKey, uploadToStorage } from '@/lib/api-client';
import { paymentMethodsAdminApi, type PaymentMethodInput } from '@/lib/manual-topups-api';
import { formatMoney, toDecimalString, toMinorUnits } from '@/lib/money';

const TYPES = ['MOBILE_WALLET', 'BANK_ACCOUNT', 'OTHER'] as const;
const CURRENCIES = ['ILS', 'USD', 'JOD', 'EUR'] as const;

/** Where customers are asked to send transfers: configured by platform administrators. */
export default function AdminPaymentMethodsPage() {
  return (
    <AdminGate allowed={(can) => can.has('admin:payment-method:read')}>
      <PaymentMethods />
    </AdminGate>
  );
}

type Draft = Record<
  | 'code'
  | 'type'
  | 'nameEn'
  | 'nameAr'
  | 'descriptionEn'
  | 'descriptionAr'
  | 'currency'
  | 'recipientName'
  | 'mobileNumber'
  | 'iban'
  | 'bankName'
  | 'accountNumber'
  | 'branchName'
  | 'instructionsEn'
  | 'instructionsAr'
  | 'minAmount'
  | 'maxAmount'
  | 'displayOrder',
  string
>;

const EMPTY: Draft = {
  code: '',
  type: 'MOBILE_WALLET',
  nameEn: '',
  nameAr: '',
  descriptionEn: '',
  descriptionAr: '',
  currency: 'ILS',
  recipientName: '',
  mobileNumber: '',
  iban: '',
  bankName: '',
  accountNumber: '',
  branchName: '',
  instructionsEn: '',
  instructionsAr: '',
  minAmount: '10.00',
  maxAmount: '5000.00',
  displayOrder: '0',
};

function draftOf(method: AdminManualPaymentMethodView): Draft {
  const text = (value: string | null) => value ?? '';
  return {
    code: method.code,
    type: method.type,
    nameEn: method.nameEn,
    nameAr: method.nameAr,
    descriptionEn: text(method.descriptionEn),
    descriptionAr: text(method.descriptionAr),
    currency: method.currency,
    recipientName: text(method.recipientName),
    mobileNumber: text(method.mobileNumber),
    iban: text(method.iban),
    bankName: text(method.bankName),
    accountNumber: text(method.accountNumber),
    branchName: text(method.branchName),
    instructionsEn: text(method.instructionsEn),
    instructionsAr: text(method.instructionsAr),
    minAmount: toDecimalString(method.minAmount.minorUnits, method.currency),
    maxAmount: toDecimalString(method.maxAmount.minorUnits, method.currency),
    displayOrder: String(method.displayOrder),
  };
}

function PaymentMethods() {
  const locale = useAdminLocale();
  const messages = getManualTopUpMessages(locale);
  const a = messages.admin;
  const { globalPermissions } = useShell();
  const canManage = globalPermissions.has('admin:payment-method:manage');
  const [methods, setMethods] = useState<AdminManualPaymentMethodView[] | null>(null);
  const [editing, setEditing] = useState<AdminManualPaymentMethodView | 'new' | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [failure, setFailure] = useState<{ message: string; reauth: boolean } | null>(null);

  const load = useCallback(async () => {
    try {
      setMethods(await paymentMethodsAdminApi.list());
    } catch (caught) {
      setFailure(describeTopUpError(messages, caught));
      setMethods((current) => current ?? []);
    }
  }, [messages]);

  useEffect(() => {
    void load();
  }, [load]);

  const replace = (updated: AdminManualPaymentMethodView) =>
    setMethods((current) =>
      (current ?? []).map((entry) => (entry.id === updated.id ? updated : entry)),
    );

  return (
    <main className="pc-page">
      <PageHeader
        title={a.methodsTitle}
        description={a.methodsIntro}
        actions={
          canManage && editing === null ? (
            <button
              type="button"
              className="pc-btn pc-btn-primary"
              onClick={() => setEditing('new')}
            >
              {a.newMethod}
            </button>
          ) : undefined
        }
      />
      {failure === null ? null : failure.reauth ? (
        <ReauthNotice locale={locale} />
      ) : (
        <p className="pc-error" role="alert">
          {failure.message}
        </p>
      )}
      {notice === null ? null : (
        <p className="pc-alert pc-alert-success" role="status">
          {notice}
        </p>
      )}

      {editing === null ? null : (
        <MethodForm
          locale={locale}
          method={editing === 'new' ? null : editing}
          onCancel={() => setEditing(null)}
          onSaved={(saved) => {
            setEditing(null);
            setNotice(a.saved);
            setFailure(null);
            if (methods?.some((entry) => entry.id === saved.id)) replace(saved);
            else setMethods((current) => [...(current ?? []), saved]);
          }}
          onFailure={setFailure}
        />
      )}

      {methods === null ? <LoadingState label={messages.loading} /> : null}
      {methods !== null && methods.length === 0 ? (
        <EmptyState icon="balance" title={a.noMethods} />
      ) : null}

      <ul className="pc-topup-admin-methods" role="list">
        {(methods ?? []).map((method) => (
          <li key={method.id} className="pc-card pc-topup-admin-method">
            <div className="pc-topup-method-head">
              <MethodMark method={method} locale={locale} />
              <div>
                <h2>{methodName(method, locale)}</h2>
                <p className="pc-hint">
                  <span className="pc-ltr">{method.code}</span> ·{' '}
                  {messages.methodTypes[method.type]} · {method.currency} ·{' '}
                  {formatMoney(method.minAmount, locale)} – {formatMoney(method.maxAmount, locale)}
                </p>
              </div>
              <StatusBadge
                label={
                  method.archivedAt !== null ? a.archived : method.enabled ? a.enabled : a.disabled
                }
                tone={
                  method.archivedAt !== null ? 'neutral' : method.enabled ? 'success' : 'warning'
                }
              />
            </div>
            {method.referenced ? <p className="pc-hint">{a.referenced}</p> : null}
            <ReviewerSummary method={method} locale={locale} />
            <p className="pc-hint">
              {a.logo}:{' '}
              {method.logo === null
                ? a.logoNone
                : (messages.fileStatuses[method.logo.status] ?? method.logo.status)}
            </p>
            {canManage && method.archivedAt === null ? (
              <div className="pc-actions">
                <button
                  type="button"
                  className="pc-btn pc-btn-secondary pc-btn-sm"
                  onClick={() => setEditing(method)}
                >
                  {a.editMethod}
                </button>
                {!method.enabled && !hasEligibleReviewer(method) ? (
                  <button
                    type="button"
                    className="pc-btn pc-btn-secondary pc-btn-sm"
                    disabled
                    aria-describedby={`reviewers-${method.id}`}
                  >
                    {a.enable}
                  </button>
                ) : (
                  <ConfirmAction
                    labels={messages.confirm}
                    describeError={(caught) => describeTopUpError(messages, caught)}
                    reauthNotice={<ReauthNotice locale={locale} />}
                    label={method.enabled ? a.disable : a.enable}
                    title={method.enabled ? a.disable : a.enable}
                    intro={method.enabled ? a.disableConfirmBody : a.enableConfirmBody}
                    buttonClassName="pc-btn pc-btn-secondary pc-btn-sm"
                    onConfirm={async () => {
                      replace(
                        await paymentMethodsAdminApi.setEnabled(
                          method.id,
                          !method.enabled,
                          method.version,
                        ),
                      );
                    }}
                  />
                )}
                <LogoUpload
                  method={method}
                  locale={locale}
                  onUpdated={replace}
                  onFailure={setFailure}
                />
                <ConfirmAction
                  labels={messages.confirm}
                  describeError={(caught) => describeTopUpError(messages, caught)}
                  reauthNotice={<ReauthNotice locale={locale} />}
                  label={a.archive}
                  title={a.archiveConfirmTitle}
                  intro={a.archiveConfirmBody}
                  danger
                  buttonClassName="pc-btn pc-btn-quiet pc-btn-sm"
                  onConfirm={async () => {
                    replace(await paymentMethodsAdminApi.archive(method.id, method.version));
                  }}
                />
              </div>
            ) : null}
          </li>
        ))}
      </ul>
    </main>
  );
}

function LogoUpload({
  method,
  locale,
  onUpdated,
  onFailure,
}: {
  method: AdminManualPaymentMethodView;
  locale: Locale;
  onUpdated: (method: AdminManualPaymentMethodView) => void;
  onFailure: (failure: { message: string; reauth: boolean }) => void;
}) {
  const messages = getManualTopUpMessages(locale);
  const input = useRef<HTMLInputElement | null>(null);
  const [busy, setBusy] = useState(false);

  async function upload(file: File): Promise<void> {
    setBusy(true);
    try {
      const created = await paymentMethodsAdminApi.createLogo(
        method.id,
        {
          originalFilename: file.name,
          sizeBytes: file.size,
          declaredMimeType: file.type || undefined,
        },
        newIdempotencyKey(),
      );
      await uploadToStorage(created.upload, file, () => undefined);
      let current = await paymentMethodsAdminApi.finalizeLogo(method.id, created.logo.id);
      const deadline = Date.now() + 60_000;
      while (
        current.logo !== null &&
        ['UPLOADED', 'VALIDATING', 'SCANNING'].includes(current.logo.status) &&
        Date.now() < deadline
      ) {
        await new Promise((resolve) => setTimeout(resolve, 750));
        current = await paymentMethodsAdminApi.get(method.id);
      }
      onUpdated(current);
    } catch (caught) {
      onFailure(describeTopUpError(messages, caught));
    } finally {
      setBusy(false);
      if (input.current !== null) input.current.value = '';
    }
  }

  return (
    <>
      <input
        ref={input}
        type="file"
        accept=".png,.jpg,.jpeg,.webp,image/png,image/jpeg,image/webp"
        className="pc-visually-hidden"
        aria-label={messages.admin.logoUpload}
        onChange={(event) => {
          const file = event.target.files?.[0];
          if (file !== undefined) void upload(file);
        }}
      />
      <button
        type="button"
        className="pc-btn pc-btn-secondary pc-btn-sm"
        disabled={busy}
        title={messages.admin.logoHint}
        onClick={() => input.current?.click()}
      >
        {busy ? messages.admin.saving : messages.admin.logoUpload}
      </button>
    </>
  );
}

function MethodForm({
  locale,
  method,
  onCancel,
  onSaved,
  onFailure,
}: {
  locale: Locale;
  method: AdminManualPaymentMethodView | null;
  onCancel: () => void;
  onSaved: (method: AdminManualPaymentMethodView) => void;
  onFailure: (failure: { message: string; reauth: boolean }) => void;
}) {
  const messages = getManualTopUpMessages(locale);
  const a = messages.admin;
  const d = messages.destination;
  const [draft, setDraft] = useState<Draft>(method === null ? EMPTY : draftOf(method));
  const [reviewerIds, setReviewerIds] = useState<string[]>(
    method === null ? [] : method.reviewers.map((reviewer) => reviewer.userId),
  );
  const [saving, setSaving] = useState(false);
  const set = (key: keyof Draft) => (value: string) =>
    setDraft((current) => ({ ...current, [key]: value }));
  const nullable = (value: string) => (value.trim() === '' ? null : value.trim());

  async function submit(event: FormEvent): Promise<void> {
    event.preventDefault();
    const min = toMinorUnits(draft.minAmount, draft.currency);
    const max = toMinorUnits(draft.maxAmount, draft.currency);
    if (min === null || max === null) {
      onFailure({ message: messages.wizard.amountInvalid, reauth: false });
      return;
    }
    const input: PaymentMethodInput = {
      ...(method === null ? { code: draft.code.trim().toUpperCase() } : {}),
      type: draft.type,
      nameEn: draft.nameEn,
      nameAr: draft.nameAr,
      descriptionEn: nullable(draft.descriptionEn),
      descriptionAr: nullable(draft.descriptionAr),
      currency: draft.currency,
      recipientName: nullable(draft.recipientName),
      mobileNumber: draft.type === 'MOBILE_WALLET' ? nullable(draft.mobileNumber) : null,
      iban: draft.type === 'BANK_ACCOUNT' ? nullable(draft.iban) : null,
      bankName: draft.type === 'BANK_ACCOUNT' ? nullable(draft.bankName) : null,
      accountNumber: draft.type === 'BANK_ACCOUNT' ? nullable(draft.accountNumber) : null,
      branchName: draft.type === 'BANK_ACCOUNT' ? nullable(draft.branchName) : null,
      instructionsEn: nullable(draft.instructionsEn),
      instructionsAr: nullable(draft.instructionsAr),
      minAmountMinorUnits: min,
      maxAmountMinorUnits: max,
      displayOrder: Number.parseInt(draft.displayOrder || '0', 10),
      reviewerUserIds: reviewerIds,
    };
    setSaving(true);
    try {
      onSaved(
        method === null
          ? await paymentMethodsAdminApi.create(input)
          : await paymentMethodsAdminApi.update(method.id, input, method.version),
      );
    } catch (caught) {
      onFailure(describeTopUpError(messages, caught));
    } finally {
      setSaving(false);
    }
  }

  const field = (
    key: keyof Draft,
    label: string,
    options: { ltr?: boolean; multiline?: boolean; required?: boolean; hint?: string } = {},
  ) => (
    <label className="pc-field" key={key}>
      <span>{label}</span>
      {options.multiline ? (
        <textarea rows={3} value={draft[key]} onChange={(event) => set(key)(event.target.value)} />
      ) : (
        <input
          value={draft[key]}
          dir={options.ltr ? 'ltr' : undefined}
          required={options.required}
          onChange={(event) => set(key)(event.target.value)}
        />
      )}
      {options.hint === undefined ? null : <span className="pc-hint">{options.hint}</span>}
    </label>
  );

  return (
    <section className="pc-card" aria-labelledby="method-form-title">
      <h2 id="method-form-title">{method === null ? a.newMethod : a.editMethod}</h2>
      <p className="pc-alert pc-alert-warning">{a.editWarning}</p>
      <form className="pc-form pc-topup-method-form" onSubmit={(event) => void submit(event)}>
        {method === null
          ? field('code', a.code, { ltr: true, required: true, hint: a.codeHint })
          : null}
        <label className="pc-field">
          <span>{a.type}</span>
          <select value={draft.type} onChange={(event) => set('type')(event.target.value)}>
            {TYPES.map((type) => (
              <option key={type} value={type}>
                {messages.methodTypes[type]}
              </option>
            ))}
          </select>
        </label>
        <label className="pc-field">
          <span>{d.currency}</span>
          <select
            value={draft.currency}
            disabled={method?.referenced === true}
            onChange={(event) => set('currency')(event.target.value)}
          >
            {CURRENCIES.map((currency) => (
              <option key={currency} value={currency}>
                {currency}
              </option>
            ))}
          </select>
        </label>
        {field('nameEn', a.nameEn, { required: true })}
        {field('nameAr', a.nameAr, { required: true })}
        {field('descriptionEn', a.descriptionEn, { multiline: true })}
        {field('descriptionAr', a.descriptionAr, { multiline: true })}
        {field('recipientName', d.recipientName)}
        {draft.type === 'MOBILE_WALLET'
          ? field('mobileNumber', d.mobileNumber, { ltr: true })
          : null}
        {draft.type === 'BANK_ACCOUNT' ? (
          <>
            {field('bankName', d.bankName)}
            {field('iban', d.iban, { ltr: true })}
            {field('accountNumber', d.accountNumber, { ltr: true })}
            {field('branchName', d.branchName)}
          </>
        ) : null}
        {field('instructionsEn', a.instructionsEn, { multiline: true })}
        {field('instructionsAr', a.instructionsAr, { multiline: true })}
        {field('minAmount', a.minAmount, { ltr: true, required: true })}
        {field('maxAmount', a.maxAmount, { ltr: true, required: true })}
        {field('displayOrder', a.displayOrder, { ltr: true })}
        <ReviewerPicker
          locale={locale}
          method={method}
          selected={reviewerIds}
          onChange={setReviewerIds}
        />
        <div className="pc-actions">
          <button type="button" className="pc-btn pc-btn-secondary" onClick={onCancel}>
            {a.cancel}
          </button>
          <button type="submit" className="pc-btn pc-btn-primary" disabled={saving}>
            {saving ? a.saving : a.save}
          </button>
        </div>
      </form>
    </section>
  );
}

/** Whether at least one assignee can still act on the method's alerts. */
function hasEligibleReviewer(method: AdminManualPaymentMethodView): boolean {
  return method.reviewers.some((reviewer) => reviewer.eligible);
}

/** Who owns a method's top-ups, said on its card. */
function ReviewerSummary({
  method,
  locale,
}: {
  method: AdminManualPaymentMethodView;
  locale: Locale;
}) {
  const r = getManualTopUpMessages(locale).reviewers;
  const ready = hasEligibleReviewer(method);
  return (
    <div
      className="pc-topup-reviewers"
      id={`reviewers-${method.id}`}
      data-testid="method-reviewers"
    >
      <p className="pc-topup-reviewers-line">
        <strong>{r.label}:</strong>{' '}
        {method.reviewers.length === 0 ? (
          <span>{r.none}</span>
        ) : (
          method.reviewers.map((reviewer, index) => (
            <span key={reviewer.userId}>
              {index > 0 ? (locale === 'ar' ? '، ' : ', ') : null}
              <span dir="auto">{reviewer.displayName ?? reviewer.email}</span>
              {reviewer.eligible ? null : (
                <span className="pc-topup-reviewer-flag"> ({r.ineligible})</span>
              )}
            </span>
          ))
        )}
      </p>
      {method.reviewers.length === 0 && method.enabled ? (
        <p className="pc-hint">{r.noneHint}</p>
      ) : null}
      {!ready && !method.enabled && method.archivedAt === null ? (
        <p className="pc-alert pc-alert-warning">{r.required}</p>
      ) : null}
    </div>
  );
}

/**
 * Choosing a method's reviewers from the PalCert staff who may review
 * top-ups. There is no free-text field: an address that could receive the
 * alert but not open the review page cannot be entered here at all.
 */
function ReviewerPicker({
  locale,
  method,
  selected,
  onChange,
}: {
  locale: Locale;
  method: AdminManualPaymentMethodView | null;
  selected: readonly string[];
  onChange: (ids: string[]) => void;
}) {
  const r = getManualTopUpMessages(locale).reviewers;
  const [candidates, setCandidates] = useState<ManualTopUpReviewerCandidateView[] | null>(null);

  useEffect(() => {
    let live = true;
    paymentMethodsAdminApi
      .reviewerCandidates()
      .then((list) => {
        if (live) setCandidates(list);
      })
      .catch(() => {
        if (live) setCandidates([]);
      });
    return () => {
      live = false;
    };
  }, []);

  // Assignees who have since lost the permission are still shown, so an
  // administrator can see them and take them off.
  const lapsed = (method?.reviewers ?? []).filter(
    (reviewer) => !(candidates ?? []).some((candidate) => candidate.userId === reviewer.userId),
  );
  const toggle = (userId: string, on: boolean) =>
    onChange(on ? [...selected, userId] : selected.filter((id) => id !== userId));

  return (
    <fieldset className="pc-topup-reviewer-picker" data-testid="reviewer-picker">
      <legend>{r.title}</legend>
      <p className="pc-hint">{r.hint}</p>
      <p className="pc-topup-reviewer-assign">{r.assign}</p>
      {candidates === null ? (
        <p className="pc-hint">{getManualTopUpMessages(locale).loading}</p>
      ) : candidates.length === 0 && lapsed.length === 0 ? (
        <p className="pc-alert pc-alert-warning">{r.noCandidates}</p>
      ) : (
        <ul className="pc-topup-reviewer-options" role="list">
          {candidates.map((candidate) => {
            const id = `reviewer-${candidate.userId}`;
            return (
              <li key={candidate.userId}>
                <input
                  type="checkbox"
                  id={id}
                  checked={selected.includes(candidate.userId)}
                  onChange={(event) => toggle(candidate.userId, event.target.checked)}
                />
                <label htmlFor={id}>
                  <span className="pc-topup-reviewer-name" dir="auto">
                    {candidate.displayName ?? candidate.email}
                  </span>
                  <span className="pc-topup-reviewer-meta">
                    <span className="pc-ltr">{candidate.email}</span>
                    {' · '}
                    {candidate.emailVerified ? r.emailVerified : r.emailNotVerified}
                    {candidate.roles.length > 0
                      ? ` · ${candidate.roles.map((role) => r.roles[role] ?? role).join(', ')}`
                      : ''}
                  </span>
                </label>
              </li>
            );
          })}
          {lapsed.map((reviewer) => {
            const id = `reviewer-${reviewer.userId}`;
            return (
              <li key={reviewer.userId} data-lapsed="true">
                <input
                  type="checkbox"
                  id={id}
                  checked={selected.includes(reviewer.userId)}
                  onChange={(event) => toggle(reviewer.userId, event.target.checked)}
                />
                <label htmlFor={id}>
                  <span className="pc-topup-reviewer-name" dir="auto">
                    {reviewer.displayName ?? reviewer.email}
                  </span>
                  <span className="pc-topup-reviewer-meta">
                    <span className="pc-ltr">{reviewer.email}</span>
                    {' · '}
                    {r.ineligible} — {r.ineligibleHint}
                  </span>
                </label>
              </li>
            );
          })}
        </ul>
      )}
      {selected.length === 0 ? <p className="pc-hint">{r.required}</p> : null}
    </fieldset>
  );
}
