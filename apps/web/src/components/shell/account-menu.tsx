'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useId, useRef, useState } from 'react';
import { Icon } from '@/components/ui/icon';
import type { Locale } from '@/i18n/locales';
import { getShellMessages } from '@/i18n/shell-messages';
import { authApi, type UserProfileResponse } from '@/lib/api-client';

/**
 * The signed-in person's menu: who they are, their account pages, sign out.
 *
 * A disclosure (a button that shows a panel of ordinary links), not an ARIA
 * `menu`: the items are links and one button, and a menu role would promise
 * arrow-key behaviour a screen-reader user would then have to discover does
 * not exist. Escape closes it and puts focus back on the button.
 */
export function AccountMenu({
  locale,
  user,
  canReadProfile,
  canReadSessions,
  onSignedOut,
}: {
  locale: Locale;
  user: UserProfileResponse;
  canReadProfile: boolean;
  canReadSessions: boolean;
  onSignedOut: () => void;
}) {
  const m = getShellMessages(locale);
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [signingOut, setSigningOut] = useState(false);
  const panelId = useId();
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);

  const name = user.displayName?.trim() || user.email;
  const initial = name.charAt(0).toUpperCase();

  useEffect(() => {
    if (!open) return;
    function onPointerDown(event: PointerEvent): void {
      if (rootRef.current !== null && !rootRef.current.contains(event.target as Node)) {
        setOpen(false);
      }
    }
    function onKeyDown(event: KeyboardEvent): void {
      if (event.key === 'Escape') {
        setOpen(false);
        triggerRef.current?.focus();
      }
    }
    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open]);

  async function signOut(): Promise<void> {
    setSigningOut(true);
    try {
      await authApi.logout();
    } catch {
      // The session may already be gone; the sign-in page is the right place
      // either way, and it will say if something is still wrong.
    }
    setOpen(false);
    onSignedOut();
    router.push(`/${locale}/login`);
  }

  return (
    <div className="pc-menu" ref={rootRef}>
      <button
        ref={triggerRef}
        type="button"
        className="pc-menu-trigger"
        aria-expanded={open}
        aria-controls={panelId}
        onClick={() => setOpen((value) => !value)}
      >
        <span className="pc-avatar" aria-hidden="true">
          {initial}
        </span>
        <span className="pc-menu-name" dir="auto">
          {name}
        </span>
        <span className="pc-visually-hidden">{m.accountMenu}</span>
        <Icon name="chevron-down" size={16} />
      </button>
      {open ? (
        <div className="pc-menu-panel" id={panelId}>
          <div className="pc-menu-header">
            <span>{m.signedInAs}</span>
            {name === user.email ? (
              <strong dir="ltr" className="pc-ltr">
                {user.email}
              </strong>
            ) : (
              <>
                <strong>{name}</strong>
                <span dir="ltr" className="pc-ltr">
                  {user.email}
                </span>
              </>
            )}
          </div>
          {canReadProfile ? (
            <Link
              className="pc-menu-item"
              href={`/${locale}/profile`}
              onClick={() => setOpen(false)}
            >
              <Icon name="user" size={18} />
              {m.profile}
            </Link>
          ) : null}
          {canReadSessions ? (
            <Link
              className="pc-menu-item"
              href={`/${locale}/sessions`}
              onClick={() => setOpen(false)}
            >
              <Icon name="sessions" size={18} />
              {m.sessions}
            </Link>
          ) : null}
          <div className="pc-menu-separator" role="separator" />
          <button
            type="button"
            className="pc-menu-item"
            onClick={() => void signOut()}
            disabled={signingOut}
          >
            <Icon name="logout" size={18} />
            {m.signOut}
          </button>
        </div>
      ) : null}
    </div>
  );
}
