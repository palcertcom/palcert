'use client';

import type {
  ManualPaymentMethodView,
  ManualTopUpRequestView,
} from '@palcert/contracts/finance/manual-topups';
import Link from 'next/link';
import { useParams, useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useCallback, useEffect, useRef, useState } from 'react';
import {
  DestinationDetails,
  MethodMark,
  TopUpAmount,
  describeTopUpError,
  methodName,
} from '@/components/manual-topup';
import { PageHeader } from '@/components/ui/page-header';
import { EmptyState, LoadingState } from '@/components/ui/states';
import { StepProgress } from '@/components/ui/step-progress';
import { resolveLocale } from '@/i18n/locales';
import { getManualTopUpMessages } from '@/i18n/manual-topup-messages';
import { uploadToStorage } from '@/lib/api-client';
import { manualTopUpsApi } from '@/lib/manual-topups-api';
import { toDecimalString, toMinorUnits } from '@/lib/money';
import { useIdempotencyKey } from '@/lib/use-idempotency-key';

const ACCEPT = '.pdf,.png,.jpg,.jpeg,.webp,application/pdf,image/png,image/jpeg,image/webp';
const SETTLED_FILE = new Set(['READY', 'REJECTED', 'FAILED', 'UPLOAD_EXPIRED']);

/**
 * Add balance by bank or app transfer.
 *
 * Four steps, each one thing: choose where to pay, pay there (outside
 * PalCert), say what was sent, then confirm. The last step says plainly that
 * the balance does not change yet — the person's report is not proof of
 * payment, and only PalCert finance's verification turns it into credit.
 */
export default function AddBalancePage() {
  return (
    <Suspense fallback={null}>
      <Wizard />
    </Suspense>
  );
}

function Wizard() {
  const locale = resolveLocale(useParams().locale);
  const messages = getManualTopUpMessages(locale);
  const w = messages.wizard;
  const router = useRouter();
  const resumeId = useSearchParams().get('draft');
  const createKey = useIdempotencyKey();
  const receiptKey = useIdempotencyKey();

  const [methods, setMethods] = useState<ManualPaymentMethodView[] | null>(null);
  const [method, setMethod] = useState<ManualPaymentMethodView | null>(null);
  const [request, setRequest] = useState<ManualTopUpRequestView | null>(null);
  const [step, setStep] = useState(0);
  const [amount, setAmount] = useState('');
  const [reference, setReference] = useState('');
  const [note, setNote] = useState('');
  const [progress, setProgress] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fileInput = useRef<HTMLInputElement | null>(null);
  const headingRef = useRef<HTMLHeadingElement | null>(null);

  const fail = useCallback(
    (caught: unknown) => setError(describeTopUpError(messages, caught).message),
    [messages],
  );

  // The catalogue, and a draft to resume if the link named one.
  useEffect(() => {
    void (async () => {
      try {
        const list = await manualTopUpsApi.methods();
        setMethods(list);
        if (resumeId !== null) {
          const draft = await manualTopUpsApi.get(resumeId);
          if (draft.status !== 'DRAFT') {
            router.replace(`/${locale}/balance/top-ups/${draft.id}`);
            return;
          }
          setRequest(draft);
          setMethod(list.find((entry) => entry.id === draft.paymentMethod.methodId) ?? null);
          setAmount(
            draft.amount.minorUnits === '0'
              ? ''
              : toDecimalString(draft.amount.minorUnits, draft.amount.currency),
          );
          setReference(draft.reference ?? '');
          setNote(draft.customerNote ?? '');
          setStep(2);
        }
      } catch (caught) {
        fail(caught);
        setMethods([]);
      }
    })();
  }, [fail, locale, resumeId, router]);

  // Move focus to the step heading so a screen reader hears where it is.
  useEffect(() => {
    headingRef.current?.focus();
  }, [step]);

  const currency = request?.paymentMethod.currency ?? method?.currency ?? 'USD';
  const destination = request?.paymentMethod ?? method;

  async function startDraft(): Promise<void> {
    if (method === null) return;
    if (request !== null) {
      setStep(2);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const created = await manualTopUpsApi.create(method.id, {}, createKey.keyFor(method.id));
      setRequest(created);
      setStep(2);
    } catch (caught) {
      fail(caught);
    } finally {
      setBusy(false);
    }
  }

  /** Save what has been typed; returns the saved request, or null when invalid. */
  async function saveDetails(): Promise<ManualTopUpRequestView | null> {
    if (request === null) return null;
    const minor = amount.trim() === '' ? null : toMinorUnits(amount, currency);
    if (amount.trim() !== '' && minor === null) {
      setError(w.amountInvalid);
      return null;
    }
    setError(null);
    const saved = await manualTopUpsApi.update(request.id, {
      amountMinorUnits: minor,
      reference: reference.trim() === '' ? null : reference,
      customerNote: note.trim() === '' ? null : note,
    });
    setRequest(saved);
    return saved;
  }

  async function toReview(): Promise<void> {
    setBusy(true);
    try {
      const saved = await saveDetails();
      if (saved === null) return;
      if (saved.amount.minorUnits === '0' || saved.reference === null) {
        setError(messages.errors['MANUAL_TOPUP_INVALID'] ?? messages.genericError);
        return;
      }
      setStep(3);
    } catch (caught) {
      fail(caught);
    } finally {
      setBusy(false);
    }
  }

  async function saveForLater(): Promise<void> {
    setBusy(true);
    try {
      const saved = await saveDetails();
      if (saved !== null) router.push(`/${locale}/balance/top-ups/${saved.id}`);
    } catch (caught) {
      fail(caught);
    } finally {
      setBusy(false);
    }
  }

  async function attach(file: File): Promise<void> {
    if (request === null) return;
    setError(null);
    setProgress(0);
    try {
      const created = await manualTopUpsApi.createReceipt(
        request.id,
        {
          originalFilename: file.name,
          sizeBytes: file.size,
          declaredMimeType: file.type || undefined,
        },
        receiptKey.keyFor(`${request.id}:${file.name}:${file.size}:${file.lastModified}`),
      );
      await uploadToStorage(created.upload, file, setProgress);
      let current = await manualTopUpsApi.finalizeReceipt(request.id, created.receipt.id);
      // The scan runs in the background; wait for its verdict.
      const deadline = Date.now() + 60_000;
      while (
        current.receipt !== null &&
        !SETTLED_FILE.has(current.receipt.status) &&
        Date.now() < deadline
      ) {
        await new Promise((resolve) => setTimeout(resolve, 750));
        current = await manualTopUpsApi.get(request.id);
      }
      setRequest(current);
    } catch (caught) {
      fail(caught);
    } finally {
      receiptKey.reset();
      setProgress(null);
      if (fileInput.current !== null) fileInput.current.value = '';
    }
  }

  async function removeReceipt(): Promise<void> {
    if (request === null) return;
    try {
      setRequest(await manualTopUpsApi.update(request.id, { removeReceipt: true }));
    } catch (caught) {
      fail(caught);
    }
  }

  async function submit(): Promise<void> {
    if (request === null) return;
    setBusy(true);
    setError(null);
    try {
      const submitted = await manualTopUpsApi.submit(request.id);
      router.push(`/${locale}/balance/top-ups/${submitted.id}`);
    } catch (caught) {
      fail(caught);
      setBusy(false);
    }
  }

  const receipt = request?.receipt ?? null;
  const receiptBusy = progress !== null || (receipt !== null && !SETTLED_FILE.has(receipt.status));

  return (
    <main className="pc-page pc-topup-wizard">
      <PageHeader title={w.title} description={w.intro} />
      <StepProgress steps={w.steps} current={step} label={w.title} stateLabels={w.stepState} />

      {error === null ? null : (
        <p className="pc-error" role="alert">
          {error}
        </p>
      )}

      {methods === null ? <LoadingState label={messages.loading} /> : null}

      {methods !== null && step === 0 ? (
        <section className="pc-card" aria-labelledby="topup-step">
          <h2 id="topup-step" tabIndex={-1} ref={headingRef}>
            {w.chooseTitle}
          </h2>
          {methods.length === 0 ? (
            <EmptyState
              icon="balance"
              title={w.noMethods}
              description={w.noMethodsHint}
              headingLevel={3}
            />
          ) : (
            <>
              <p className="pc-hint">{w.chooseIntro}</p>
              <ul className="pc-topup-methods" role="list">
                {methods.map((entry) => (
                  <li key={entry.id}>
                    <button
                      type="button"
                      className="pc-topup-method"
                      data-selected={method?.id === entry.id ? 'true' : undefined}
                      aria-pressed={method?.id === entry.id}
                      onClick={() => {
                        setMethod(entry);
                        setStep(1);
                      }}
                    >
                      <MethodMark method={entry} locale={locale} />
                      <span className="pc-topup-method-text">
                        <strong>{methodName(entry, locale)}</strong>
                        <span className="pc-hint">
                          {messages.methodTypes[entry.type] ?? entry.type} · {entry.currency}
                        </span>
                        {(locale === 'ar' ? entry.descriptionAr : entry.descriptionEn) ===
                        null ? null : (
                          <span className="pc-hint">
                            {locale === 'ar' ? entry.descriptionAr : entry.descriptionEn}
                          </span>
                        )}
                      </span>
                      <span className="pc-btn pc-btn-secondary pc-btn-sm" aria-hidden="true">
                        {w.select}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            </>
          )}
        </section>
      ) : null}

      {step === 1 && method !== null ? (
        <section className="pc-card" aria-labelledby="topup-step">
          <div className="pc-topup-method-head">
            <MethodMark method={method} locale={locale} />
            <h2 id="topup-step" tabIndex={-1} ref={headingRef}>
              {w.sendTitle}: {methodName(method, locale)}
            </h2>
          </div>
          <p className="pc-hint">{w.sendIntro}</p>
          <DestinationDetails
            destination={method}
            locale={locale}
            limits={{ min: method.minAmount, max: method.maxAmount }}
          />
          <div className="pc-actions">
            <button type="button" className="pc-btn pc-btn-secondary" onClick={() => setStep(0)}>
              {w.back}
            </button>
            <button
              type="button"
              className="pc-btn pc-btn-primary"
              disabled={busy}
              onClick={() => void startDraft()}
            >
              {w.sent}
            </button>
          </div>
        </section>
      ) : null}

      {step === 2 && request !== null ? (
        <section className="pc-card" aria-labelledby="topup-step">
          <h2 id="topup-step" tabIndex={-1} ref={headingRef}>
            {w.detailsTitle}
          </h2>
          <p className="pc-hint">{w.detailsIntro}</p>
          <form
            className="pc-form"
            onSubmit={(event) => {
              event.preventDefault();
              void toReview();
            }}
          >
            <div className="pc-field">
              <label htmlFor="topup-amount">{w.amount}</label>
              <input
                id="topup-amount"
                name="amount"
                inputMode="decimal"
                autoComplete="off"
                dir="ltr"
                required
                value={amount}
                onChange={(event) => setAmount(event.target.value)}
                aria-describedby="topup-amount-hint"
              />
              <span id="topup-amount-hint" className="pc-hint">
                {w.amountHint(currency)}
              </span>
            </div>
            <div className="pc-field">
              <label htmlFor="topup-reference">{w.reference}</label>
              <input
                id="topup-reference"
                name="reference"
                autoComplete="off"
                dir="ltr"
                required
                maxLength={100}
                value={reference}
                onChange={(event) => setReference(event.target.value)}
                aria-describedby="topup-reference-hint"
              />
              <span id="topup-reference-hint" className="pc-hint">
                {w.referenceHint}
              </span>
            </div>

            <div className="pc-field">
              <span id="topup-receipt-label">{w.receipt}</span>
              <p className="pc-hint">{w.receiptHint}</p>
              {receipt === null ? null : (
                <p className="pc-topup-receipt" role="status">
                  <span>{receipt.originalFilename}</span>
                  <span className="pc-hint">
                    {' '}
                    — {messages.fileStatuses[receipt.status] ?? receipt.status}
                  </span>
                </p>
              )}
              {progress === null ? null : (
                <p role="status" aria-live="polite">
                  {w.receiptUploading(Math.round(progress * 100))}
                </p>
              )}
              <div className="pc-actions">
                <input
                  ref={fileInput}
                  type="file"
                  accept={ACCEPT}
                  className="pc-visually-hidden"
                  aria-labelledby="topup-receipt-label"
                  onChange={(event) => {
                    const file = event.target.files?.[0];
                    if (file !== undefined) void attach(file);
                  }}
                />
                <button
                  type="button"
                  className="pc-btn pc-btn-secondary pc-btn-sm"
                  disabled={receiptBusy}
                  onClick={() => fileInput.current?.click()}
                >
                  {receipt === null ? w.receiptChoose : w.receiptReplace}
                </button>
                {receipt === null ? null : (
                  <button
                    type="button"
                    className="pc-btn pc-btn-quiet pc-btn-sm"
                    disabled={receiptBusy}
                    onClick={() => void removeReceipt()}
                  >
                    {w.receiptRemove}
                  </button>
                )}
              </div>
            </div>

            <div className="pc-field">
              <label htmlFor="topup-note">{w.note}</label>
              <textarea
                id="topup-note"
                name="note"
                rows={3}
                maxLength={500}
                value={note}
                onChange={(event) => setNote(event.target.value)}
                aria-describedby="topup-note-hint"
              />
              <span id="topup-note-hint" className="pc-hint">
                {w.noteHint}
              </span>
            </div>

            <div className="pc-actions">
              <button
                type="button"
                className="pc-btn pc-btn-quiet"
                disabled={busy}
                onClick={() => void saveForLater()}
              >
                {w.saveDraft}
              </button>
              <button
                type="submit"
                className="pc-btn pc-btn-primary"
                disabled={busy || receiptBusy}
              >
                {w.next}
              </button>
            </div>
          </form>
        </section>
      ) : null}

      {step === 3 && request !== null && destination !== null && destination !== undefined ? (
        <section className="pc-card" aria-labelledby="topup-step">
          <h2 id="topup-step" tabIndex={-1} ref={headingRef}>
            {w.reviewTitle}
          </h2>
          <dl className="pc-topup-summary">
            <div>
              <dt>{messages.waiting.amount}</dt>
              <dd>
                <TopUpAmount amount={request.amount} locale={locale} />
              </dd>
            </div>
            <div>
              <dt>{messages.waiting.reference}</dt>
              <dd className="pc-ltr" dir="ltr">
                {request.reference}
              </dd>
            </div>
            <div>
              <dt>{messages.waiting.method}</dt>
              <dd>{methodName(request.paymentMethod, locale)}</dd>
            </div>
            {request.receipt === null ? null : (
              <div>
                <dt>{w.receipt}</dt>
                <dd>{request.receipt.originalFilename}</dd>
              </div>
            )}
          </dl>
          <div className="pc-alert pc-alert-warning" role="note">
            <strong>{w.reviewNotice}</strong>
            <p>{w.reviewNoticeDetail}</p>
          </div>
          <div className="pc-actions">
            <button type="button" className="pc-btn pc-btn-secondary" onClick={() => setStep(2)}>
              {w.back}
            </button>
            <button
              type="button"
              className="pc-btn pc-btn-primary"
              disabled={busy}
              onClick={() => void submit()}
            >
              {busy ? w.submitting : w.submit}
            </button>
          </div>
        </section>
      ) : null}

      <p>
        <Link href={`/${locale}/balance`}>{messages.waiting.backToBalance}</Link>
      </p>
    </main>
  );
}
