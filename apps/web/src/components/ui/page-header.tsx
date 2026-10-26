import type { ReactNode } from 'react';

/**
 * Page title, one line of context, and the page's actions.
 *
 * Title and primary action share a row on wide screens and stack on narrow
 * ones; the primary action is always the first one after the title.
 */
export function PageHeader({
  title,
  description,
  actions,
  titleId,
}: {
  title: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  titleId?: string;
}) {
  return (
    <header className="pc-page-header">
      <div className="pc-page-header-text">
        <h1 id={titleId}>{title}</h1>
        {description === undefined ? null : <p>{description}</p>}
      </div>
      {actions === undefined ? null : <div className="pc-page-header-actions">{actions}</div>}
    </header>
  );
}
