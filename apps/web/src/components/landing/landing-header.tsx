'use client';

import Link from 'next/link';
import { useEffect, useId, useRef, useState } from 'react';
import { LocaleSwitcher } from '@/components/shell/locale-switcher';
import { Brand } from '@/components/shell/sidebar';
import { Icon } from '@/components/ui/icon';
import { getLandingMessages } from '@/i18n/landing-messages';
import type { Locale } from '@/i18n/locales';
import { getShellMessages } from '@/i18n/shell-messages';
import { LANDING_SECTIONS } from './landing-sections';

/**
 * The public homepage's header: the product site's navigation.
 *
 * On a wide screen every link sits in the bar. On a narrower one the bar
 * keeps only the brand and a menu button, and everything else — the
 * sections, certificate verification, the language and the two account
 * actions — moves into one disclosure panel, so each destination is reachable
 * exactly once at every width. The closed panel is `hidden`, so it adds no
 * tab stops; Escape closes it and returns focus to the button.
 */
export function LandingHeader({ locale }: { locale: Locale }) {
  const t = getLandingMessages(locale).nav;
  const shell = getShellMessages(locale);
  const base = `/${locale}`;
  const panelId = useId();
  const [open, setOpen] = useState(false);
  const button = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    function onKey(event: KeyboardEvent) {
      if (event.key !== 'Escape') return;
      setOpen(false);
      button.current?.focus();
    }
    function onPointer(event: PointerEvent) {
      const target = event.target as Node;
      if (panel.current?.contains(target) || button.current?.contains(target)) return;
      setOpen(false);
    }
    document.addEventListener('keydown', onKey);
    document.addEventListener('pointerdown', onPointer);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('pointerdown', onPointer);
    };
  }, [open]);

  // Following a link in the panel closes it; the page scrolls to the section.
  const close = () => setOpen(false);

  return (
    <header className="pc-app-topbar pc-lp-header" data-signed-out="true" data-landing="true">
      <div className="pc-topbar-context">
        <span className="pc-topbar-brand">
          <Brand locale={locale} />
        </span>
      </div>

      <nav className="pc-lp-nav" aria-label={t.label}>
        <ul>
          {LANDING_SECTIONS.map((section) => (
            <li key={section.id}>
              <a href={`#${section.id}`}>{t[section.key]}</a>
            </li>
          ))}
        </ul>
      </nav>

      <div className="pc-topbar-actions pc-lp-header-actions">
        <Link className="pc-lp-header-verify" href={`${base}/verify`}>
          <Icon name="verified" size={18} />
          {shell.verifyCertificate}
        </Link>
        <LocaleSwitcher locale={locale} />
        <Link className="pc-btn pc-btn-secondary pc-btn-sm" href={`${base}/register`}>
          {shell.createAccount}
        </Link>
        <Link className="pc-btn pc-btn-sm" href={`${base}/login`}>
          {shell.signIn}
        </Link>
      </div>

      <button
        ref={button}
        type="button"
        className="pc-icon-button pc-lp-menu-toggle"
        aria-expanded={open}
        aria-controls={panelId}
        onClick={() => setOpen((value) => !value)}
      >
        <Icon name={open ? 'close' : 'menu'} />
        <span className="pc-visually-hidden">{open ? t.closeMenu : t.openMenu}</span>
      </button>

      <div ref={panel} id={panelId} className="pc-lp-menu" hidden={!open}>
        <nav aria-label={t.label}>
          <ul className="pc-lp-menu-sections">
            {LANDING_SECTIONS.map((section) => (
              <li key={section.id}>
                <a href={`#${section.id}`} onClick={close}>
                  {t[section.key]}
                </a>
              </li>
            ))}
          </ul>
        </nav>
        <div className="pc-lp-menu-actions">
          <Link className="pc-lp-menu-verify" href={`${base}/verify`} onClick={close}>
            <Icon name="verified" size={18} />
            {shell.verifyCertificate}
          </Link>
          <Link className="pc-btn" href={`${base}/register`} onClick={close}>
            {shell.createAccount}
          </Link>
          <Link className="pc-btn pc-btn-secondary" href={`${base}/login`} onClick={close}>
            {shell.signIn}
          </Link>
          <LocaleSwitcher locale={locale} />
        </div>
      </div>
    </header>
  );
}
