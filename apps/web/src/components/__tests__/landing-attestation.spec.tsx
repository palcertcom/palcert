import { ATTESTATION_ARTIFACT_FORMATS } from '@palcert/contracts';
import { render, screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { LandingPage } from '@/components/landing/landing-page';
import { ATTESTATION_INFO_MESSAGES } from '@/i18n/attestation-info-messages';
import { LANDING_MESSAGES } from '@/i18n/landing-messages';
import type { Locale } from '@/i18n/locales';
import { attestationEntry, signInThen } from '@/lib/attestation-entry';
import { safeReturnPath } from '@/lib/return-path';
import { routeKind } from '@/lib/shell-navigation';

const session = vi.hoisted(() => ({ signedIn: false }));

vi.mock('next/navigation', () => ({
  usePathname: () => '/en',
  notFound: () => {
    throw new Error('not found');
  },
}));

vi.mock('@/server/session/session-hint', () => ({
  hasSessionCookie: async () => session.signedIn,
}));

beforeEach(() => {
  session.signedIn = false;
});

async function renderInfoPage(locale: Locale) {
  const { default: Page } = await import('@/app/[locale]/certificate-attestation/page');
  render(await Page({ params: Promise.resolve({ locale }) }));
}

const href = (element: HTMLElement) => element.getAttribute('href');

describe('the homepage presents three distinct services', () => {
  it.each(['en', 'ar'] as const)(
    '%s: one h1, the new hero, and the three service cards',
    (locale) => {
      const t = LANDING_MESSAGES[locale];
      render(<LandingPage locale={locale} />);
      const headings = screen.getAllByRole('heading', { level: 1 });
      expect(headings).toHaveLength(1);
      expect(headings[0]).toHaveTextContent(t.hero.title);
      expect(screen.getByText(t.hero.lead)).toBeTruthy();

      const services = screen.getByRole('region', { name: t.services.title });
      for (const title of [
        t.services.checking.title,
        t.services.attestation.title,
        t.services.verification.title,
      ]) {
        expect(within(services).getByRole('heading', { level: 3, name: title })).toBeTruthy();
      }
      // The attestation path, stage by stage, as an ordered list named in words.
      const path = within(services).getByRole('list', { name: t.services.flow.label });
      expect(
        within(path)
          .getAllByRole('listitem')
          .map((item) => item.textContent),
      ).toEqual(
        expect.arrayContaining([
          expect.stringContaining(t.services.flow.certificate),
          expect.stringContaining(t.services.flow.review),
          expect.stringContaining(t.services.flow.attested),
          expect.stringContaining(t.services.flow.verify),
        ]),
      );
    },
  );

  it.each(['en', 'ar'] as const)(
    '%s: the first screen names all three services and leads with attestation',
    (locale) => {
      const t = LANDING_MESSAGES[locale];
      render(<LandingPage locale={locale} />);
      const hero = screen.getByRole('region', { name: t.hero.title });
      const strip = within(hero).getByRole('list', { name: t.hero.servicesLabel });
      const rows = within(strip).getAllByRole('link');
      expect(rows.map((row) => row.textContent)).toEqual([
        expect.stringContaining(t.hero.services.checking.title),
        expect.stringContaining(t.hero.services.attestation.title),
        expect.stringContaining(t.hero.services.verification.title),
      ]);
      expect(rows.map(href)).toEqual([
        '#services',
        `/${locale}/certificate-attestation`,
        `/${locale}/verify`,
      ]);
      // Request attestation is the primary action; verification sits beside it.
      const request = within(hero).getByTestId('hero-request-attestation');
      expect(request).toHaveTextContent(t.services.attestation.action);
      expect(request.className).not.toContain('pc-btn-secondary');
      expect(href(within(hero).getByTestId('hero-verify'))).toBe(`/${locale}/verify`);
    },
  );

  it.each(['en', 'ar'] as const)(
    '%s: attestation CTAs go through sign-in to the existing wizard',
    (locale) => {
      const t = LANDING_MESSAGES[locale];
      render(<LandingPage locale={locale} />);
      const expected = `/${locale}/login?next=${encodeURIComponent(`/${locale}/attestations/new`)}`;
      expect(href(screen.getByTestId('hero-request-attestation'))).toBe(expected);
      expect(href(screen.getByTestId('service-request-attestation'))).toBe(expected);
      const card = screen.getByTestId('service-attestation');
      expect(href(within(card).getByRole('link', { name: t.services.attestation.learnMore }))).toBe(
        `/${locale}/certificate-attestation`,
      );
      // Verification stays its own service, on the existing public verifier.
      const services = screen.getByRole('region', { name: t.services.title });
      expect(
        href(within(services).getByRole('link', { name: t.services.verification.action })),
      ).toBe(`/${locale}/verify`);
      // And the footer leads to the explanation page.
      expect(href(screen.getByRole('link', { name: t.footer.attestation }))).toBe(
        `/${locale}/certificate-attestation`,
      );
    },
  );

  it('keeps every existing homepage section', () => {
    const t = LANDING_MESSAGES.en;
    render(<LandingPage locale="en" />);
    for (const title of [
      t.workflow.title,
      t.platform.title,
      t.solutions.title,
      t.value.title,
      t.trust.title,
      t.product.title,
      t.faq.title,
      t.cta.title,
    ]) {
      expect(screen.getByRole('heading', { level: 2, name: title })).toBeTruthy();
    }
  });
});

describe('the certificate attestation page', () => {
  it.each(['en', 'ar'] as const)(
    '%s: one h1, eight steps, honest formats and fees',
    async (locale) => {
      const m = ATTESTATION_INFO_MESSAGES[locale];
      await renderInfoPage(locale);
      const headings = screen.getAllByRole('heading', { level: 1 });
      expect(headings).toHaveLength(1);
      expect(headings[0]).toHaveTextContent(m.hero.title);
      expect(screen.getByText(m.hero.lead)).toBeTruthy();
      const steps = screen
        .getByRole('heading', { level: 2, name: m.steps.title })
        .closest('section');
      expect(within(steps as HTMLElement).getAllByRole('heading', { level: 3 })).toHaveLength(8);
      expect(screen.getByText(m.fees.lead)).toBeTruthy();
      expect(screen.getByText(m.institution.lead)).toBeTruthy();
      const formats = screen.getByRole('list', { name: m.formats.listLabel });
      expect(
        within(formats)
          .getAllByRole('listitem')
          .map((item) => item.textContent),
      ).toEqual(['PDF', 'PNG', 'JPEG', 'WebP']);
    },
  );

  it('signed out: every action goes through sign-in and returns to the workflow', async () => {
    await renderInfoPage('en');
    expect(href(screen.getByTestId('info-request-attestation'))).toBe(
      '/en/login?next=%2Fen%2Fattestations%2Fnew',
    );
    expect(href(screen.getByTestId('info-my-requests'))).toBe(
      '/en/login?next=%2Fen%2Fattestations',
    );
    expect(href(screen.getByTestId('info-verify'))).toBe('/en/verify');
    expect(
      screen.getAllByRole('link', { name: ATTESTATION_INFO_MESSAGES.en.hero.createAccount }),
    ).not.toHaveLength(0);
  });

  it('signed in: straight to the existing request wizard and list', async () => {
    session.signedIn = true;
    await renderInfoPage('ar');
    expect(href(screen.getByTestId('info-request-attestation'))).toBe('/ar/attestations/new');
    expect(href(screen.getByTestId('info-my-requests'))).toBe('/ar/attestations');
    expect(
      screen.queryByRole('link', { name: ATTESTATION_INFO_MESSAGES.ar.hero.createAccount }),
    ).toBeNull();
  });

  it('has localized metadata with language alternates', async () => {
    const { generateMetadata } = await import('@/app/[locale]/certificate-attestation/page');
    const en = await generateMetadata({ params: Promise.resolve({ locale: 'en' }) });
    const ar = await generateMetadata({ params: Promise.resolve({ locale: 'ar' }) });
    expect(en.title).toBe('Institutional Certificate Attestation | PalCert');
    expect(ar.title).toBe('المصادقة المؤسسية على الشهادات | PalCert');
    expect(en.alternates?.languages).toEqual({
      en: '/en/certificate-attestation',
      ar: '/ar/certificate-attestation',
    });
    expect(ar.description).toBe(ATTESTATION_INFO_MESSAGES.ar.meta.description);
  });

  it('is drawn in the public frame', () => {
    expect(routeKind('/en/certificate-attestation')).toBe('public');
    expect(routeKind('/ar/certificate-attestation')).toBe('public');
  });
});

describe('the copy only claims what the product does', () => {
  it('lists exactly the formats the attestation upload accepts', () => {
    const accepted = ATTESTATION_ARTIFACT_FORMATS.map((format) =>
      format === 'WEBP' ? 'WebP' : format,
    );
    for (const locale of ['en', 'ar'] as const) {
      expect(ATTESTATION_INFO_MESSAGES[locale].formats.list).toEqual(accepted);
    }
  });

  it('never claims legal, governmental or international recognition', () => {
    const text = JSON.stringify([ATTESTATION_INFO_MESSAGES, LANDING_MESSAGES.en.services]);
    expect(text).not.toMatch(/notari|government|legally|internationally recognized|accredit/i);
  });

  it('has the same shape in English and Arabic', () => {
    const shape = (value: unknown): unknown =>
      Array.isArray(value)
        ? value.map(shape)
        : value !== null && typeof value === 'object'
          ? Object.fromEntries(Object.entries(value).map(([key, inner]) => [key, shape(inner)]))
          : typeof value;
    expect(shape(ATTESTATION_INFO_MESSAGES.ar)).toEqual(shape(ATTESTATION_INFO_MESSAGES.en));
    expect(shape(LANDING_MESSAGES.ar)).toEqual(shape(LANDING_MESSAGES.en));
  });

  it('leaves no English sentence in the Arabic copy', () => {
    // Product names, formats and identifiers may stay in Latin script; a run
    // of three or more ordinary English words may not.
    const strings: string[] = [];
    const collect = (value: unknown): void => {
      if (typeof value === 'string') strings.push(value);
      else if (value !== null && typeof value === 'object') Object.values(value).forEach(collect);
    };
    collect(ATTESTATION_INFO_MESSAGES.ar);
    collect(LANDING_MESSAGES.ar.services);
    collect(LANDING_MESSAGES.ar.hero);
    for (const value of strings) expect(value).not.toMatch(/[A-Za-z]{2,}(\s+[A-Za-z]{2,}){2,}/);
  });
});

describe('entry links', () => {
  it('use the sign-in return convention the login page accepts', () => {
    for (const locale of ['en', 'ar'] as const) {
      const entry = attestationEntry(locale, false);
      for (const link of [entry.request, entry.mine, entry.check]) {
        const next = new URL(link, 'https://palcert.test').searchParams.get('next');
        expect(safeReturnPath(locale, next)).toBe(next);
      }
    }
    expect(signInThen('en', '/en/attestations/new')).toBe(
      '/en/login?next=%2Fen%2Fattestations%2Fnew',
    );
    expect(attestationEntry('en', true)).toEqual({
      request: '/en/attestations/new',
      mine: '/en/attestations',
      check: '/en/checks/new',
    });
  });
});

describe('the dashboard card', () => {
  it('offers the existing request wizard and list, per permission', async () => {
    const { AttestationCard } = await import('@/components/dashboard');
    const a = ATTESTATION_INFO_MESSAGES.ar.dashboard;
    const { unmount } = render(<AttestationCard locale="ar" canSubmit canRead />);
    const card = screen.getByRole('region', { name: a.title });
    expect(href(within(card).getByRole('link', { name: a.newRequest }))).toBe(
      '/ar/attestations/new',
    );
    expect(href(within(card).getByRole('link', { name: a.myRequests }))).toBe('/ar/attestations');
    expect(href(within(card).getByRole('link', { name: a.learnMore }))).toBe(
      '/ar/certificate-attestation',
    );
    unmount();
    render(<AttestationCard locale="en" canSubmit={false} canRead />);
    expect(
      screen.queryByRole('link', { name: ATTESTATION_INFO_MESSAGES.en.dashboard.newRequest }),
    ).toBeNull();
  });
});
