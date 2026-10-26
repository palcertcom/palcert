import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { LandingHeader } from '@/components/landing/landing-header';
import { LANDING_MESSAGES } from '@/i18n/landing-messages';
import { SHELL_MESSAGES } from '@/i18n/shell-messages';

vi.mock('next/navigation', () => ({
  usePathname: () => '/en',
}));

function renderHeader(locale: 'en' | 'ar' = 'en') {
  render(<LandingHeader locale={locale} />);
  const t = LANDING_MESSAGES[locale].nav;
  const toggle = screen.getByRole('button', { name: t.openMenu });
  const panel = document.getElementById(toggle.getAttribute('aria-controls') ?? '');
  return { t, toggle, panel: panel as HTMLElement };
}

describe('LandingHeader mobile menu', () => {
  it('is a closed disclosure that adds no tab stops', () => {
    const { toggle, panel } = renderHeader();
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    expect(panel).not.toBeNull();
    expect(panel).toHaveAttribute('hidden');
  });

  it('opens with every public destination, once each', async () => {
    const { t, toggle, panel } = renderHeader();
    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    expect(panel).not.toHaveAttribute('hidden');
    const menu = within(panel);
    for (const [name, href] of [
      [t.services, '#services'],
      [t.howItWorks, '#how-it-works'],
      [t.platform, '#platform'],
      [t.solutions, '#solutions'],
      [t.trust, '#trust'],
      [t.faq, '#faq'],
      [SHELL_MESSAGES.en.verifyCertificate, '/en/verify'],
      [SHELL_MESSAGES.en.createAccount, '/en/register'],
      [SHELL_MESSAGES.en.signIn, '/en/login'],
    ] as const) {
      const links = menu.getAllByRole('link', { name });
      expect(links).toHaveLength(1);
      expect(links[0]).toHaveAttribute('href', href);
    }
    // The language switch, pointing at the same page in Arabic.
    expect(menu.getByRole('link', { name: /العربية/ })).toHaveAttribute('href', '/ar');
  });

  it('closes on Escape and returns focus to the button', async () => {
    const { t, toggle, panel } = renderHeader();
    fireEvent.click(toggle);
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    expect(panel).toHaveAttribute('hidden');
    expect(toggle).toHaveFocus();
    expect(toggle).toHaveAccessibleName(t.openMenu);
  });

  it('closes when a section link is followed', async () => {
    const { t, toggle, panel } = renderHeader();
    fireEvent.click(toggle);
    fireEvent.click(within(panel).getByRole('link', { name: t.faq }));
    expect(panel).toHaveAttribute('hidden');
  });

  it('is labelled in Arabic on the Arabic page', () => {
    const { toggle } = renderHeader('ar');
    expect(toggle).toHaveAccessibleName(LANDING_MESSAGES.ar.nav.openMenu);
  });
});
