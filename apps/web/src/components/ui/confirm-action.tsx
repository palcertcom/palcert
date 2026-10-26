'use client';

import { useId, useState, type FormEvent, type ReactNode } from 'react';
import { FormError } from '@/components/auth-form';
import { Dialog } from '@/components/ui/dialog';

export interface ConfirmLabels {
  readonly cancel: string;
  readonly close: string;
  readonly optional: string;
  readonly pending: string;
  /** Appended to a required field's label when it is left empty. */
  readonly invalid: string;
}

export interface ConfirmField {
  readonly name: string;
  readonly label: string;
  readonly hint?: string;
  readonly maxLength: number;
  readonly required?: boolean;
  readonly multiline?: boolean;
  /** A closed list: rendered as a select, starting at its first option. */
  readonly options?: readonly { readonly value: string; readonly label: string }[];
  readonly inputMode?: 'decimal' | 'text';
  readonly ltr?: boolean;
  /** A message when the value is not acceptable, checked before anything is sent. */
  readonly validate?: (value: string) => string | null;
}

/**
 * A button that opens a dialog saying what will happen, optionally asks for
 * a reason, and does it only on confirmation.
 *
 * Failures stay inside the dialog, with the reason; a refusal for want of a
 * recent sign-in offers the way back rather than a dead end.
 */
export function ConfirmAction({
  labels,
  describeError,
  reauthNotice,
  label,
  ariaLabel,
  title,
  intro,
  confirmLabel,
  danger = false,
  fields = [],
  disabled = false,
  buttonClassName,
  onConfirm,
}: {
  labels: ConfirmLabels;
  /** Turns a failure into a sentence, and says whether a fresh sign-in would help. */
  describeError: (caught: unknown) => { message: string; reauth: boolean };
  /** Shown instead of the message when the API wants a recent sign-in. */
  reauthNotice?: ReactNode;
  label: string;
  /** When the visible label is a symbol, the name a screen reader should hear. */
  ariaLabel?: string;
  title: string;
  intro: string;
  confirmLabel?: string;
  danger?: boolean;
  fields?: readonly ConfirmField[];
  disabled?: boolean;
  buttonClassName?: string;
  onConfirm: (values: Readonly<Record<string, string>>) => Promise<void>;
}) {
  const idPrefix = useId();
  const [open, setOpen] = useState(false);
  const initial = (): Record<string, string> =>
    Object.fromEntries(
      fields
        .filter((field) => field.options !== undefined && field.options.length > 0)
        .map((field) => [field.name, field.options![0]!.value]),
    );
  const [values, setValues] = useState<Record<string, string>>(initial);
  const [pending, setPending] = useState(false);
  const [failure, setFailure] = useState<{ message: string; reauth: boolean } | null>(null);

  function close(): void {
    setOpen(false);
    setValues(initial());
    setFailure(null);
  }

  async function submit(event: FormEvent): Promise<void> {
    event.preventDefault();
    if (pending) return;
    const missing = fields.find(
      (field) => field.required === true && (values[field.name] ?? '').trim() === '',
    );
    if (missing !== undefined) {
      setFailure({
        message: `${missing.label}: ${labels.invalid}`,
        reauth: false,
      });
      return;
    }
    for (const field of fields) {
      const problem = field.validate?.(values[field.name] ?? '') ?? null;
      if (problem !== null) {
        setFailure({ message: problem, reauth: false });
        return;
      }
    }
    setPending(true);
    setFailure(null);
    try {
      await onConfirm(values);
      close();
    } catch (caught) {
      setFailure(describeError(caught));
    } finally {
      setPending(false);
    }
  }

  return (
    <>
      <button
        type="button"
        className={buttonClassName ?? (danger ? 'pc-btn pc-btn-danger' : 'pc-btn pc-btn-secondary')}
        disabled={disabled}
        aria-label={ariaLabel}
        onClick={() => setOpen(true)}
      >
        {label}
      </button>
      <Dialog
        open={open}
        title={title}
        description={<p>{intro}</p>}
        onClose={close}
        closeLabel={labels.close}
      >
        <form className="pc-form" onSubmit={submit} noValidate>
          {failure === null ? null : failure.reauth && reauthNotice !== undefined ? (
            reauthNotice
          ) : (
            <FormError message={failure.message} />
          )}
          {fields.map((field) => {
            const id = `${idPrefix}-${field.name}`;
            const hintId = `${id}-hint`;
            const common = {
              id,
              name: field.name,
              value: values[field.name] ?? '',
              maxLength: field.maxLength,
              required: field.required === true,
              'aria-describedby': field.hint === undefined ? undefined : hintId,
              onChange: (event: { target: { value: string } }) =>
                setValues((current) => ({ ...current, [field.name]: event.target.value })),
            };
            return (
              <div key={field.name} className="pc-field">
                <label htmlFor={id}>
                  {field.label}
                  {field.required === true ? null : (
                    <span className="pc-hint"> ({labels.optional})</span>
                  )}
                </label>
                {field.options !== undefined ? (
                  <select
                    id={common.id}
                    name={common.name}
                    value={common.value}
                    aria-describedby={common['aria-describedby']}
                    onChange={common.onChange}
                  >
                    {field.options.map((option) => (
                      <option key={option.value} value={option.value}>
                        {option.label}
                      </option>
                    ))}
                  </select>
                ) : field.multiline === true ? (
                  <textarea rows={3} {...common} />
                ) : (
                  <input
                    type="text"
                    {...common}
                    {...(field.inputMode === undefined ? {} : { inputMode: field.inputMode })}
                    {...(field.ltr === true ? { dir: 'ltr' } : {})}
                  />
                )}
                {field.hint === undefined ? null : (
                  <p id={hintId} className="pc-hint">
                    {field.hint}
                  </p>
                )}
              </div>
            );
          })}
          <div className="pc-actions">
            <button type="button" className="secondary" onClick={close}>
              {labels.cancel}
            </button>
            <button
              type="submit"
              className={danger ? 'pc-danger' : undefined}
              disabled={pending}
              aria-busy={pending}
            >
              {pending ? labels.pending : (confirmLabel ?? label)}
            </button>
          </div>
        </form>
      </Dialog>
    </>
  );
}
