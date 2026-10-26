'use client';
import { useParams } from 'next/navigation';
import { AccountReports } from '@/components/account-reports';
import { useShell } from '@/components/shell/shell-context';
import { resolveLocale } from '@/i18n/locales';
import { reportsMessages } from '@/i18n/reports-messages';
export default function ReportsPage() {
  const locale = resolveLocale(useParams().locale);
  const { globalPermissions } = useShell();
  return globalPermissions.has('balance:read:self') ? (
    <AccountReports locale={locale} base="/reports" scope="user" />
  ) : (
    <p role="alert">{reportsMessages(locale).denied}</p>
  );
}
