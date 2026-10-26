'use client';

import Link from 'next/link';
import { PageHeader } from '@/components/ui/page-header';
import { EmptyState } from '@/components/ui/states';
import { StatusBadge } from '@/components/ui/status-badge';
import { useParams, useRouter } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';
import { FormError } from '@/components/auth-form';
import { ApiError, authApi, type SessionSummaryResponse } from '@/lib/api-client';
import { getAuthMessages, messageForErrorCode } from '@/i18n/auth-messages';
import { resolveLocale } from '@/i18n/locales';

export default function SessionsPage() {
  const locale = resolveLocale(useParams().locale);
  const messages = getAuthMessages(locale);
  const router = useRouter();

  const [sessions, setSessions] = useState<SessionSummaryResponse[]>([]);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (): Promise<void> => {
    try {
      setSessions(await authApi.sessions());
    } catch (caught) {
      if (caught instanceof ApiError && [401, 403].includes(caught.status)) {
        router.push(`/${locale}/unauthorized`);
        return;
      }
      setError(
        caught instanceof ApiError
          ? messageForErrorCode(messages, caught.code)
          : messages.genericError,
      );
    }
  }, [locale, messages, router]);

  useEffect(() => {
    void load();
  }, [load]);

  async function revoke(session: SessionSummaryResponse): Promise<void> {
    try {
      await authApi.revokeSession(session.id);
      if (session.current) {
        router.push(`/${locale}/login`);
        return;
      }
      await load();
    } catch (caught) {
      setError(
        caught instanceof ApiError
          ? messageForErrorCode(messages, caught.code)
          : messages.genericError,
      );
    }
  }

  async function signOutEverywhere(): Promise<void> {
    await authApi.logoutAll().catch(() => undefined);
    router.push(`/${locale}/login`);
  }

  const formatter = new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short' });

  return (
    <main className="pc-page">
      <p className="pc-back-link">
        <Link href={`/${locale}/profile`}>{messages.profileTitle}</Link>
      </p>
      <PageHeader
        title={messages.sessionsTitle}
        description={messages.sessionsSubtitle}
        actions={
          <button type="button" className="pc-danger" onClick={() => void signOutEverywhere()}>
            {messages.signOutEverywhere}
          </button>
        }
      />
      <FormError message={error} />

      {sessions.length === 0 ? (
        <EmptyState icon="sessions" title={messages.sessionsNone} headingLevel={2} />
      ) : (
        <ul className="pc-integration-list">
          {sessions.map((session) => (
            <li
              key={session.id}
              className="pc-card pc-integration-card"
              data-current={session.current ? 'true' : undefined}
            >
              <div className="pc-integration-head">
                <h2 className="pc-card-title pc-session-agent">{session.userAgent ?? '—'}</h2>
                {session.current && <StatusBadge tone="gold" label={messages.sessionCurrent} />}
              </div>
              <dl className="pc-summary">
                <dt>{messages.sessionLastActive}</dt>
                <dd>{formatter.format(new Date(session.lastActivityAt))}</dd>
                <dt>{messages.sessionExpires}</dt>
                <dd>{formatter.format(new Date(session.absoluteExpiresAt))}</dd>
              </dl>
              <div className="pc-actions">
                <button
                  type="button"
                  className="pc-btn pc-btn-secondary pc-btn-sm"
                  onClick={() => void revoke(session)}
                >
                  {messages.sessionRevoke}
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </main>
  );
}
