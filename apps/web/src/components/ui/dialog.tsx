'use client';

import { useEffect, useId, useRef, type ReactNode } from 'react';

/**
 * A modal dialog on the native `<dialog>` element.
 *
 * `showModal()` gives what a hand-rolled overlay has to fake: the rest of the
 * page is inert, focus stays inside, Escape closes it, and the platform draws
 * the backdrop. When it closes, focus returns to whatever opened it, so a
 * keyboard user is never dropped at the top of the page.
 *
 * It is for decisions that deserve a pause — disabling a second factor,
 * suspending an organization — not for ordinary forms.
 */
export function Dialog({
  open,
  title,
  description,
  onClose,
  children,
  closeLabel,
}: {
  open: boolean;
  title: string;
  description?: ReactNode;
  onClose: () => void;
  children: ReactNode;
  /** Accessible name of the corner close button. */
  closeLabel: string;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const returnTo = useRef<Element | null>(null);
  const titleId = useId();
  const descriptionId = useId();

  useEffect(() => {
    const dialog = ref.current;
    if (dialog === null) return;
    if (open && !dialog.open) {
      returnTo.current = document.activeElement;
      // jsdom and very old engines lack showModal; the attribute still
      // renders the content, which is all a test needs.
      if (typeof dialog.showModal === 'function') dialog.showModal();
      else dialog.setAttribute('open', '');
      const first = dialog.querySelector<HTMLElement>(
        'input:not([disabled]), select:not([disabled]), textarea:not([disabled]), button:not([disabled]):not(.pc-dialog-close)',
      );
      first?.focus();
    } else if (!open && dialog.open) {
      if (typeof dialog.close === 'function') dialog.close();
      else dialog.removeAttribute('open');
      if (returnTo.current instanceof HTMLElement) returnTo.current.focus();
    }
  }, [open]);

  return (
    <dialog
      ref={ref}
      className="pc-dialog"
      aria-labelledby={titleId}
      aria-describedby={description === undefined ? undefined : descriptionId}
      onCancel={(event) => {
        // Escape: let React own the state rather than the element.
        event.preventDefault();
        onClose();
      }}
    >
      {open ? (
        <div className="pc-dialog-body">
          <div className="pc-dialog-header">
            <h2 id={titleId}>{title}</h2>
            <button
              type="button"
              className="pc-icon-button pc-dialog-close"
              aria-label={closeLabel}
              onClick={onClose}
            >
              <span aria-hidden="true">×</span>
            </button>
          </div>
          {description === undefined ? null : (
            <div id={descriptionId} className="pc-dialog-description">
              {description}
            </div>
          )}
          {children}
        </div>
      ) : null}
    </dialog>
  );
}
