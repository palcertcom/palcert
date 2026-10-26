import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { Dashboard } from '@/components/dashboard';
import { LandingPage } from '@/components/landing/landing-page';
import { getLandingMessages } from '@/i18n/landing-messages';
import { LOCALES, isLocale } from '@/i18n/locales';
import { getShellMessages } from '@/i18n/shell-messages';
import { hasSessionCookie } from '@/server/session/session-hint';

export async function generateMetadata({
  params,
}: {
  params: Promise<{ locale: string }>;
}): Promise<Metadata> {
  const { locale } = await params;
  if (!isLocale(locale)) return {};
  const landing = getLandingMessages(locale);
  const brand = getShellMessages(locale).brand;
  const title = `${brand} — ${landing.hero.title}`;
  return {
    title,
    description: landing.hero.lead,
    alternates: {
      languages: Object.fromEntries(LOCALES.map((candidate) => [candidate, `/${candidate}`])),
    },
    openGraph: { title, description: landing.hero.lead, locale, type: 'website' },
  };
}

/**
 * Home: PalCert's front door when signed out, the dashboard when signed in.
 *
 * A request without a session cookie is rendered on the server as the public
 * homepage, so a first visit and a crawler receive the whole page rather
 * than a loading state. Nothing in it depends on who is asking. A request
 * with a cookie gets the dashboard, which reads the session from the API.
 */
export default async function HomePage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  if (!isLocale(locale)) notFound();
  if (!(await hasSessionCookie())) return <LandingPage locale={locale} />;
  return <Dashboard locale={locale} />;
}
