'use client';

import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import { FormError } from '@/components/auth-form';
import { DataTable } from '@/components/ui/data-table';
import { PageHeader } from '@/components/ui/page-header';
import { LoadingState } from '@/components/ui/states';
import { StatusBadge } from '@/components/ui/status-badge';
import { getNotificationsMessages } from '@/i18n/notifications-messages';
import { resolveLocale } from '@/i18n/locales';
import { ApiError, notificationsApi, type NotificationPreferenceResponse } from '@/lib/api-client';

/**
 * Which workflow emails PalCert sends (§106, §113).
 *
 * Every type is listed, including the ones this person has never touched, so
 * the screen shows what PalCert actually does rather than only what they have
 * changed. A screen built from stored rows alone would show a new account an
 * empty page and imply PalCert sends them nothing.
 *
 * The revocation row has no switch, and says why. A disabled control with no
 * explanation reads as a bug; this one is a decision, and the decision is that
 * whether a certificate somebody may already have shown an employer still
 * verifies is not something to find out by chance.
 */
export default function NotificationPreferencesPage() {
  const locale = resolveLocale(useParams().locale);
  const messages = getNotificationsMessages(locale);
  const router = useRouter();

  const [rows, setRows] = useState<NotificationPreferenceResponse[] | null>(null);
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // A plain function, and deliberately not a `useCallback` the load effect
  // depends on. `useRouter()` returns a fresh object on every render, so a
  // memo keyed on it changes every render too — and an effect keyed on that
  // memo refetches on every render, quietly discarding whatever the person
  // just changed.
  const describe = useRef((caught: unknown): string => {
    if (caught instanceof ApiError && [401, 403].includes(caught.status)) {
      router.push(`/${locale}/unauthorized`);
      return messages.errors.UNAUTHENTICATED ?? messages.genericError;
    }
    return caught instanceof ApiError
      ? (messages.errors[caught.code] ?? messages.genericError)
      : messages.genericError;
  });

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const result = await notificationsApi.preferences();
        if (!cancelled) setRows([...result]);
      } catch (caught) {
        if (!cancelled) setError(describe.current(caught));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  async function toggle(row: NotificationPreferenceResponse): Promise<void> {
    if (row.mandatory) return;
    setPending(row.notificationType);
    setError(null);
    try {
      const updated = await notificationsApi.setPreference(row.notificationType, !row.emailEnabled);
      setRows((current) =>
        current === null
          ? current
          : current.map((item) =>
              item.notificationType === updated.notificationType
                ? { ...item, emailEnabled: updated.emailEnabled }
                : item,
            ),
      );
    } catch (caught) {
      setError(describe.current(caught));
    } finally {
      setPending(null);
    }
  }

  return (
    <main className="pc-page">
      <p className="pc-back-link">
        <Link href={`/${locale}/notifications`}>{messages.title}</Link>
      </p>
      <PageHeader title={messages.preferencesTitle} description={messages.preferencesIntro} />
      <p className="pc-hint">{messages.inAppNote}</p>

      {error === null ? null : <FormError message={error} />}

      {rows === null ? (
        <LoadingState label={messages.loading} />
      ) : (
        <DataTable
          caption={messages.preferencesTitle}
          rows={rows}
          rowKey={(row) => row.notificationType}
          columns={[
            {
              key: 'type',
              header: messages.typeColumn,
              primary: true,
              cell: (row) => messages.types[row.notificationType] ?? row.notificationType,
            },
            {
              key: 'email',
              header: messages.emailColumn,
              cell: (row) =>
                row.mandatory ? (
                  <StatusBadge tone="neutral" label={messages.alwaysOn} />
                ) : (
                  <label className="pc-check">
                    <input
                      type="checkbox"
                      checked={row.emailEnabled}
                      disabled={pending === row.notificationType}
                      onChange={() => void toggle(row)}
                    />
                    <span>
                      {messages.emailColumn}
                      <span className="pc-visually-hidden">
                        : {messages.types[row.notificationType] ?? row.notificationType}
                      </span>
                    </span>
                  </label>
                ),
            },
          ]}
        />
      )}

      {rows?.some((row) => row.mandatory) === true ? (
        <p className="pc-hint">{messages.mandatoryNote}</p>
      ) : null}
    </main>
  );
}
