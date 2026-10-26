'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { getNotificationsMessages } from '@/i18n/notifications-messages';
import type { Locale } from '@/i18n/locales';
import { Icon } from '@/components/ui/icon';
import { notificationsApi } from '@/lib/api-client';

/** How often the badge re-reads the count. Slow on purpose — see below. */
const POLL_INTERVAL_MS = 60_000;

/**
 * The unread badge (§110).
 *
 * Polled rather than pushed, and slowly. A live socket for a badge would be a
 * long-lived authenticated connection per open tab, and the thing it would
 * deliver is a number — the cost is real and the benefit is that somebody
 * learns about an approval within a second rather than within a minute. When
 * something is genuinely urgent, PalCert sends email; that is what the email
 * channel is for.
 *
 * It renders nothing at all when the count cannot be read. A signed-out
 * visitor meeting an error badge in the header would be told that something is
 * broken when in fact nothing is: they simply have no inbox.
 */
export function NotificationBell({
  locale,
  onCountChange,
  current = false,
}: {
  readonly locale: Locale;
  /** Lets the shell show the same number in the sidebar without a second poll. */
  readonly onCountChange?: (count: number | null) => void;
  /** Whether the inbox is the page being shown. */
  readonly current?: boolean;
}) {
  const messages = getNotificationsMessages(locale);
  const [unread, setUnread] = useState<number | null>(null);

  useEffect(() => {
    let cancelled = false;

    async function read(): Promise<void> {
      try {
        const result = await notificationsApi.unreadCount();
        if (!cancelled) {
          setUnread(result.unread);
          onCountChange?.(result.unread);
        }
      } catch {
        // Not signed in, or the API is unreachable. Either way the header says
        // nothing rather than showing an error somebody cannot act on.
        if (!cancelled) {
          setUnread(null);
          onCountChange?.(null);
        }
      }
    }

    void read();
    const timer = setInterval(() => void read(), POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
    // Deliberately once: the callback is the shell's state setter, and the
    // poll must not restart whenever a parent re-renders.
  }, []);

  if (unread === null) return null;

  return (
    <Link
      href={`/${locale}/notifications`}
      aria-label={messages.bellLabel}
      className="pc-icon-button pc-bell"
      aria-current={current ? 'page' : undefined}
    >
      <Icon name="bell" size={22} />
      <span className="pc-visually-hidden">{messages.bellLabel}</span>
      {unread === 0 ? null : (
        <span
          className="pc-count-badge"
          data-testid="notification-unread-count"
          aria-label={messages.unreadLabel}
        >
          {unread}
        </span>
      )}
    </Link>
  );
}
