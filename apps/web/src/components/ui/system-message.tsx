import type { ReactNode } from 'react';
import { Icon, type IconName } from '@/components/ui/icon';

/**
 * A page that explains why there is nothing here: not found, not signed in,
 * not allowed, something failed. One layout for all of them, so each reads
 * as a deliberate answer with a way forward rather than a dead end.
 */
export function SystemMessage({
  icon,
  title,
  body,
  actions,
  alert = false,
}: {
  icon: IconName;
  title: string;
  body: string;
  actions: ReactNode;
  /** Announce the explanation (for a failure the visitor did not cause). */
  alert?: boolean;
}) {
  return (
    <main className="pc-page pc-system-page">
      <span className="pc-system-icon" aria-hidden="true">
        <Icon name={icon} size={28} />
      </span>
      <h1 className="pc-title">{title}</h1>
      <p className="pc-tagline" role={alert ? 'alert' : undefined}>
        {body}
      </p>
      <div className="pc-actions">{actions}</div>
    </main>
  );
}
