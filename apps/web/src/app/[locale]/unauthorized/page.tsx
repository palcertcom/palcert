import Link from 'next/link';
import { notFound } from 'next/navigation';
import { SystemMessage } from '@/components/ui/system-message';
import { getAuthMessages } from '@/i18n/auth-messages';
import { isLocale } from '@/i18n/locales';

export default async function UnauthorizedPage({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  if (!isLocale(locale)) notFound();
  const messages = getAuthMessages(locale);

  return (
    <SystemMessage
      icon="lock"
      title={messages.unauthorizedTitle}
      body={messages.unauthorizedBody}
      actions={
        <Link className="pc-btn" href={`/${locale}/login`}>
          {messages.backToSignIn}
        </Link>
      }
    />
  );
}
