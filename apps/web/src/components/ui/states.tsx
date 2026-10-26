import type { ReactNode } from 'react';
import { Icon, type IconName } from './icon';

/**
 * An honest empty state: what is missing, why it matters, and the one real
 * action that fills it. The action must lead into the existing workflow — an
 * empty state whose button does nothing is worse than none.
 */
export function EmptyState({
  icon = 'document',
  title,
  description,
  action,
  headingLevel = 2,
}: {
  icon?: IconName;
  title: string;
  description?: ReactNode;
  action?: ReactNode;
  headingLevel?: 2 | 3;
}) {
  const Heading = headingLevel === 2 ? 'h2' : 'h3';
  return (
    <div className="pc-empty-state">
      <span className="pc-empty-state-art">
        <Icon name={icon} size={40} />
      </span>
      <Heading>{title}</Heading>
      {description === undefined ? null : <p>{description}</p>}
      {action ?? null}
    </div>
  );
}

/** A loading line, announced politely to assistive technology. */
export function LoadingState({ label }: { label: string }) {
  return (
    <p className="pc-loading" role="status" aria-live="polite">
      <span className="pc-spinner" aria-hidden="true" />
      {label}
    </p>
  );
}

/** A block-level failure: what went wrong, and optionally what to do. */
export function ErrorState({
  title,
  description,
  action,
}: {
  title: string;
  description?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className="pc-error-state" role="alert">
      <h2>{title}</h2>
      {description === undefined ? null : <p>{description}</p>}
      {action ?? null}
    </div>
  );
}
