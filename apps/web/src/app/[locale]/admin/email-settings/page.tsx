'use client';

import type { EmailSettingsView } from '@palcert/contracts/email';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { AdminGate, useAdminLocale } from '@/components/admin/admin-kit';
import { EmailSettingsForm, describeEmailError } from '@/components/admin/email-settings-form';
import { FormError } from '@/components/auth-form';
import { useShell } from '@/components/shell/shell-context';
import { PageHeader } from '@/components/ui/page-header';
import { LoadingState } from '@/components/ui/states';
import { getEmailMessages } from '@/i18n/email-messages';
import { apiUrl } from '@/lib/api-client';
import { emailAdminApi } from '@/lib/email-api';

/** Platform email configuration (ADR-0146). */
export default function EmailSettingsPage() {
  return (
    <AdminGate allowed={(can) => can.has('admin:email-settings:read')}>
      <EmailSettings />
    </AdminGate>
  );
}

function EmailSettings() {
  const locale = useAdminLocale();
  const m = getEmailMessages(locale);
  const { globalPermissions } = useShell();
  const [view, setView] = useState<EmailSettingsView | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    emailAdminApi
      .settings()
      .then(setView)
      .catch((caught: unknown) => setError(describeEmailError(m, caught).message));
  }, [m]);

  const webhookEndpoint = absolute(apiUrl('/webhooks/resend'));

  return (
    <main className="pc-page">
      <PageHeader title={m.settings.title} description={m.settings.intro} />
      {globalPermissions.has('admin:email-delivery:read') ? (
        <p>
          <Link
            className="pc-btn pc-btn-secondary pc-btn-sm"
            href={`/${locale}/admin/email-deliveries`}
          >
            {m.nav.deliveries}
          </Link>
        </p>
      ) : null}
      {error === null ? null : <FormError message={error} />}
      {view === null ? (
        error === null ? (
          <LoadingState label={m.settings.loading} />
        ) : null
      ) : (
        <EmailSettingsForm
          locale={locale}
          messages={m}
          initial={view}
          canManage={globalPermissions.has('admin:email-settings:manage')}
          canTest={globalPermissions.has('admin:email-settings:test')}
          webhookEndpoint={webhookEndpoint}
        />
      )}
    </main>
  );
}

function absolute(path: string): string {
  if (/^https?:\/\//.test(path)) return path;
  return typeof window === 'undefined' ? path : `${window.location.origin}${path}`;
}
