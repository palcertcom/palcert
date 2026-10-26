import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import { notFound } from 'next/navigation';
import { LOCALES, directionFor, isLocale } from '@/i18n/locales';
import { getMessages } from '@/i18n/messages';
import { AppFrame } from '@/components/shell/app-frame';
import { ShellProvider } from '@/components/shell/shell-context';

export function generateStaticParams(): Array<{ locale: string }> {
  return LOCALES.map((locale) => ({ locale }));
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ locale: string }>;
}): Promise<Metadata> {
  const { locale } = await params;
  if (!isLocale(locale)) return { title: 'PalCert' };
  const messages = getMessages(locale);
  return { title: messages.appName, description: messages.tagline };
}

export default async function LocaleLayout({
  children,
  params,
}: {
  children: ReactNode;
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  if (!isLocale(locale)) notFound();

  return (
    <html lang={locale} dir={directionFor(locale)}>
      <body>
        <ShellProvider>
          <AppFrame locale={locale}>{children}</AppFrame>
        </ShellProvider>
      </body>
    </html>
  );
}
