import Link from 'next/link';
import { Icon } from '@/components/ui/icon';
import type { Crumb } from '@/lib/breadcrumbs';

export function Breadcrumbs({ crumbs, label }: { crumbs: readonly Crumb[]; label: string }) {
  if (crumbs.length === 0) return null;
  return (
    <nav aria-label={label} className="pc-breadcrumbs">
      <ol>
        {crumbs.map((crumb, index) => (
          <li key={`${index}-${crumb.label}`}>
            {index > 0 ? (
              <span className="pc-breadcrumb-separator">
                <Icon name="chevron" size={14} />
              </span>
            ) : null}
            {crumb.href !== undefined ? (
              <Link href={crumb.href}>
                <bdi>{crumb.label}</bdi>
              </Link>
            ) : (
              <span aria-current="page">
                <bdi>{crumb.label}</bdi>
              </span>
            )}
          </li>
        ))}
      </ol>
    </nav>
  );
}
