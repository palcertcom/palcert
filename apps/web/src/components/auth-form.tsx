'use client';

import type { ReactNode } from 'react';
import { useEffect, useId, useRef } from 'react';

/**
 * Accessible form primitives (§36, §37).
 *
 * Rules encoded here so no screen can get them wrong:
 *  - every input has a real `<label>` tied by id, never a placeholder as label;
 *  - errors are associated via `aria-describedby` and announced with `role="alert"`;
 *  - `autoComplete` is set correctly so password managers work;
 *  - paste is never blocked — disabling it makes generated passwords unusable
 *    and is security theatre.
 */

export function FormShell({
  title,
  subtitle,
  children,
}: {
  title: string;
  subtitle?: string;
  children: ReactNode;
}) {
  return (
    <main className="pc-page pc-auth">
      <h1 className="pc-title">{title}</h1>
      {subtitle !== undefined && <p className="pc-tagline">{subtitle}</p>}
      {children}
    </main>
  );
}

export function Field({
  label,
  type,
  value,
  onChange,
  autoComplete,
  required = true,
  hint,
  error,
  inputMode,
  maxLength,
  name,
}: {
  label: string;
  type: 'email' | 'password' | 'text';
  value: string;
  onChange: (value: string) => void;
  autoComplete: string;
  required?: boolean;
  hint?: string;
  error?: string;
  inputMode?: 'numeric' | 'text' | 'email';
  maxLength?: number;
  name?: string;
}) {
  const id = useId();
  const hintId = `${id}-hint`;
  const errorId = `${id}-error`;

  // Keep what was typed before the page came alive (Phase 20 Checkpoint 8).
  //
  // The server renders these inputs, so on a slow connection they are on
  // screen — and typeable — seconds before React has loaded. Whatever is typed
  // in that window lives only in the DOM; the component's state is still the
  // empty string it started with, and a controlled input does not read the DOM
  // back when React takes it over. The person sees their email and password
  // filled in, presses Sign in, the form posts `{"email":"","password":""}`,
  // and PalCert tells them to "check the information you entered" — which was
  // correct. Measured on the release build with scripts delayed by three
  // seconds; the same thing is what a mobile connection does.
  //
  // So on mount, if the DOM already holds something the state does not, hand
  // it to the owner exactly as if it had been typed after hydration. Once, and
  // only when there is something to recover: a field that starts empty, or
  // that the owner has already filled, is left alone.
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    const typedBeforeHydration = inputRef.current?.value ?? '';
    if (typedBeforeHydration !== '' && typedBeforeHydration !== value) {
      onChange(typedBeforeHydration);
    }
    // Mount only: this recovers input from before React existed, and running
    // it again would fight the person's own edits.
  }, []);

  const describedBy = [hint !== undefined ? hintId : null, error !== undefined ? errorId : null]
    .filter((entry): entry is string => entry !== null)
    .join(' ');

  return (
    <div className="pc-field">
      <label htmlFor={id}>{label}</label>
      <input
        ref={inputRef}
        id={id}
        name={name ?? id}
        type={type}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        autoComplete={autoComplete}
        required={required}
        aria-invalid={error !== undefined}
        aria-describedby={describedBy.length > 0 ? describedBy : undefined}
        {...(inputMode !== undefined ? { inputMode } : {})}
        {...(maxLength !== undefined ? { maxLength } : {})}
      />
      {hint !== undefined && (
        <p id={hintId} className="pc-hint">
          {hint}
        </p>
      )}
      {error !== undefined && (
        <p id={errorId} className="pc-field-error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}

/** Errors are announced immediately; `role="alert"` gives an implicit live region. */
export function FormError({ message }: { message: string | null }) {
  if (message === null) return null;
  return (
    <p className="pc-alert pc-alert-error" role="alert">
      {message}
    </p>
  );
}

export function FormSuccess({ message }: { message: string | null }) {
  if (message === null) return null;
  return (
    <p className="pc-alert pc-alert-success" role="status">
      {message}
    </p>
  );
}

export function SubmitButton({
  label,
  pendingLabel,
  pending,
}: {
  label: string;
  pendingLabel: string;
  pending: boolean;
}) {
  return (
    <button type="submit" className="pc-button" disabled={pending} aria-busy={pending}>
      {pending ? pendingLabel : label}
    </button>
  );
}
