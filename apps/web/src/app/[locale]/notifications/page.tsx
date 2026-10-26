'use client';

import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import { FormError } from '@/components/auth-form';
import { PageHeader } from '@/components/ui/page-header';
import { EmptyState, LoadingState } from '@/components/ui/states';
import { StatusBadge } from '@/components/ui/status-badge';
import { getNotificationsMessages } from '@/i18n/notifications-messages';
import { resolveLocale } from '@/i18n/locales';
import { ApiError, notificationsApi, type UserNotificationResponse } from '@/lib/api-client';

/**
 * A person's own notification centre (§105–§112).
 *
 * Each row says what happened and links to the page that holds the detail. It
 * does not summarise the detail: the substance of a review comment, a
 * rejection's reasons and a certificate's verification code all live behind
 * the link, where reading them requires being signed in as the person they
 * belong to.
 *
 * There is no "mark unread". `readAt` is the first time somebody saw a
 * notification, and an inbox that could rewind it would be recording what the
 * reader wanted rather than what happened.
 */
export default function NotificationsPage() {
  const locale = resolveLocale(useParams().locale);
  const messages = getNotificationsMessages(locale);
  const router = useRouter();

  const [items, setItems] = useState<UserNotificationResponse[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [pending, setPending] = useState(false);
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
        const page = await notificationsApi.list();
        if (cancelled) return;
        setItems([...page.items]);
        setCursor(page.nextCursor);
      } catch (caught) {
        if (!cancelled) setError(describe.current(caught));
      } finally {
        if (!cancelled) setLoaded(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  async function loadMore(): Promise<void> {
    if (cursor === null || pending) return;
    setPending(true);
    try {
      const page = await notificationsApi.list({ cursor });
      setItems((current) => [...current, ...page.items]);
      setCursor(page.nextCursor);
    } catch (caught) {
      setError(describe.current(caught));
    } finally {
      setPending(false);
    }
  }

  async function markRead(notificationId: string): Promise<void> {
    try {
      const updated = await notificationsApi.markRead(notificationId);
      setItems((current) => current.map((item) => (item.id === notificationId ? updated : item)));
    } catch (caught) {
      setError(describe.current(caught));
    }
  }

  async function markAllRead(): Promise<void> {
    try {
      await notificationsApi.markAllRead();
      const now = new Date().toISOString();
      setItems((current) =>
        current.map((item) => (item.readAt === null ? { ...item, readAt: now } : item)),
      );
    } catch (caught) {
      setError(describe.current(caught));
    }
  }

  const unread = items.filter((item) => item.readAt === null).length;

  const when = new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short' });

  return (
    <main className="pc-page">
      <PageHeader
        title={messages.title}
        description={messages.intro}
        actions={
          <>
            <Link className="pc-btn pc-btn-secondary" href={`/${locale}/notifications/preferences`}>
              {messages.preferencesTitle}
            </Link>
            {unread === 0 ? null : (
              <button type="button" onClick={() => void markAllRead()}>
                {messages.markAllRead}
              </button>
            )}
          </>
        }
      />

      {error === null ? null : <FormError message={error} />}

      {!loaded ? (
        <LoadingState label={messages.loading} />
      ) : items.length === 0 ? (
        <EmptyState icon="bell" title={messages.empty} />
      ) : (
        <ul className="pc-inbox">
          {items.map((item) => {
            const headingId = `notification-${item.id}`;
            return (
              <li
                key={item.id}
                className="pc-inbox-item"
                data-unread={item.readAt === null ? 'true' : 'false'}
              >
                <div className="pc-inbox-text">
                  <h2 id={headingId}>{messages.types[item.notificationType] ?? item.title}</h2>
                  <p dir="auto">{item.body}</p>
                  <p className="pc-inbox-meta">
                    <time dateTime={item.createdAt}>{when.format(new Date(item.createdAt))}</time>
                    {item.readAt === null ? (
                      <StatusBadge tone="gold" label={messages.unreadBadge} />
                    ) : null}
                  </p>
                </div>
                <div className="pc-inbox-actions">
                  {/*
                    The link the notification carries, which is always an
                    application route. It is never rewritten here into an
                    absolute URL: a relative route is what keeps a shared
                    screenshot from becoming a way into somebody's account.
                  */}
                  <Link
                    className="pc-btn pc-btn-secondary pc-btn-sm"
                    href={item.deepLink}
                    aria-describedby={headingId}
                  >
                    {messages.open}
                  </Link>
                  {item.readAt === null ? (
                    <button
                      type="button"
                      className="pc-button-quiet"
                      onClick={() => void markRead(item.id)}
                      aria-describedby={headingId}
                    >
                      {messages.markRead}
                    </button>
                  ) : null}
                </div>
              </li>
            );
          })}
        </ul>
      )}

      {cursor === null ? null : (
        <button
          type="button"
          className="secondary"
          onClick={() => void loadMore()}
          disabled={pending}
        >
          {pending ? messages.loading : messages.loadMore}
        </button>
      )}
    </main>
  );
}
