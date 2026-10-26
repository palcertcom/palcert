import Link from 'next/link';
import { notFound } from 'next/navigation';
import { SystemMessage } from '@/components/ui/system-message';
import { getAuthMessages } from '@/i18n/auth-messages';
import { isLocale } from '@/i18n/locales';

export default async function ForbiddenPage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  if (!isLocale(locale)) notFound();
  const messages = getAuthMessages(locale);

  return (
    <SystemMessage
      icon="shield"
      title={messages.forbiddenTitle}
      body={messages.forbiddenBody}
      actions={
        <Link className="pc-btn pc-btn-secondary" href={`/${locale}/profile`}>
          {messages.profileTitle}
        </Link>
      }
    />
  );
}
