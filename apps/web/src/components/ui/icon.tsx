import brandMark1x from '@/assets/brand/palcert-icon-64.png';
import brandMark2x from '@/assets/brand/palcert-icon-128.png';
import type { SVGProps } from 'react';

/**
 * PalCert's line icons.
 *
 * Drawn here rather than taken from a library: the original design uses a
 * handful of thin outline glyphs, the content security policy loads nothing
 * from elsewhere, and a set this small does not justify a dependency. Every
 * icon is decorative (`aria-hidden`) — the words next to it carry the meaning.
 * Icons that point along the reading direction take `pc-icon-directional` so
 * they mirror in Arabic.
 */
export type IconName =
  | 'dashboard'
  | 'document'
  | 'check'
  | 'certificate'
  | 'submission'
  | 'balance'
  | 'bell'
  | 'user'
  | 'sessions'
  | 'organization'
  | 'team'
  | 'invitation'
  | 'types'
  | 'standard'
  | 'review'
  | 'verified'
  | 'key'
  | 'webhook'
  | 'plus'
  | 'menu'
  | 'close'
  | 'chevron'
  | 'chevron-down'
  | 'arrow'
  | 'globe'
  | 'logout'
  | 'upload'
  | 'shield'
  | 'lock'
  | 'wand'
  | 'sparkle'
  | 'fingerprint'
  | 'history'
  | 'qr'
  | 'circle-check'
  | 'circle-alert'
  | 'clock';

const PATHS: Record<IconName, string> = {
  dashboard: 'M4 4h7v7H4zM13 4h7v4h-7zM13 10h7v10h-7zM4 13h7v7H4z',
  document: 'M7 3h7l5 5v13H7zM14 3v5h5M10 13h6M10 17h6',
  check: 'M9 11l3 3 7-7M20 12v7a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h9',
  certificate:
    'M12 3a5 5 0 1 1 0 10 5 5 0 0 1 0-10zM8.5 12.5 7 21l5-3 5 3-1.5-8.5M10 8l1.5 1.5L14.5 6.5',
  submission: 'M4 12l16-8-6 16-2.5-6.5zM20 4 11.5 13.5',
  balance: 'M3 7h18v12H3zM3 11h18M7 15h3M16 7V5H6',
  bell: 'M6 16V11a6 6 0 1 1 12 0v5l2 2H4zM10 20a2 2 0 0 0 4 0',
  user: 'M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM4 21a8 8 0 0 1 16 0',
  sessions: 'M3 5h18v11H3zM8 20h8M12 16v4',
  organization: 'M3 21h18M5 21V9l7-5 7 5v12M9 21v-6h6v6M9 11h.01M15 11h.01',
  team: 'M9 11a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7zM2.5 20a6.5 6.5 0 0 1 13 0M16 4.5a3.5 3.5 0 0 1 0 6.5M18 14a6 6 0 0 1 3.5 6',
  invitation: 'M3 6h18v12H3zM3 7l9 6 9-6',
  types: 'M4 5h16M4 12h16M4 19h10',
  standard: 'M5 4h11a3 3 0 0 1 3 3v13H8a3 3 0 0 1-3-3zM5 17a3 3 0 0 1 3-3h11M9 8h6',
  review: 'M4 5h16v10H9l-5 4zM8 9h8M8 12h5',
  verified: 'M12 3l7 3v5c0 4.5-3 8.5-7 10-4-1.5-7-5.5-7-10V6zM9 12l2 2 4-4',
  key: 'M14 10a4 4 0 1 1-2.8-3.8L20 3v4h-3v3h-3zM8 15.5h.01',
  webhook: 'M9 7a3 3 0 1 1 3 3L8 17M15 17a3 3 0 1 1-3-3M6 20a3 3 0 1 1 1-5.8M18 20l-3-3',
  plus: 'M12 5v14M5 12h14',
  menu: 'M4 7h16M4 12h16M4 17h16',
  close: 'M6 6l12 12M18 6 6 18',
  chevron: 'M9 6l6 6-6 6',
  'chevron-down': 'M6 9l6 6 6-6',
  arrow: 'M5 12h14M13 6l6 6-6 6',
  globe:
    'M12 3a9 9 0 1 1 0 18 9 9 0 0 1 0-18zM3 12h18M12 3c2.5 2.5 3.5 5.5 3.5 9s-1 6.5-3.5 9c-2.5-2.5-3.5-5.5-3.5-9s1-6.5 3.5-9',
  logout: 'M15 4h4v16h-4M10 8l-4 4 4 4M6 12h10',
  upload: 'M12 16V5M7 10l5-5 5 5M5 19h14',
  shield: 'M12 3l7 3v5c0 4.5-3 8.5-7 10-4-1.5-7-5.5-7-10V6z',
  lock: 'M6 11h12v10H6zM8 11V8a4 4 0 1 1 8 0v3',
  wand: 'M4 20 15 9M13 7l4 4M17 3v3M15.5 4.5h3M20 8v2M19 9h2M9 4v2M8 5h2',
  sparkle:
    'M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8zM18 16l.8 2.2L21 19l-2.2.8L18 22l-.8-2.2L15 19l2.2-.8z',
  fingerprint:
    'M7 10a5 5 0 0 1 10 0v2M12 10v4c0 3 1 5 2 6M9 12v2c0 2.5.6 4.5 1.5 6M15 13v1c0 1.5.3 3 1 4.5M5 14c.5-1 .5-2.5.5-4a6.5 6.5 0 0 1 11-4.7M19 12v2',
  history: 'M4 12a8 8 0 1 0 2.3-5.7M4 4v3h3M12 8v4l3 2',
  qr: 'M4 4h6v6H4zM14 4h6v6h-6zM4 14h6v6H4zM14 14h2.5v2.5H14zM17.5 17.5H20V20h-2.5zM14 20h2M20 14v2',
  'circle-check': 'M12 3a9 9 0 1 1 0 18 9 9 0 0 1 0-18zM8 12.5l2.7 2.7L16.5 9.5',
  'circle-alert': 'M12 3a9 9 0 1 1 0 18 9 9 0 0 1 0-18zM9 9l6 6M15 9l-6 6',
  clock: 'M12 3a9 9 0 1 1 0 18 9 9 0 0 1 0-18zM12 7v5l3.5 2',
};

const DIRECTIONAL: ReadonlySet<IconName> = new Set(['chevron', 'arrow', 'submission', 'logout']);

export function Icon({
  name,
  size = 20,
  className,
  ...rest
}: { name: IconName; size?: number } & Omit<SVGProps<SVGSVGElement>, 'children'>) {
  const classes = ['pc-icon', DIRECTIONAL.has(name) ? 'pc-icon-directional' : '', className ?? '']
    .filter(Boolean)
    .join(' ');
  return (
    <svg
      viewBox="0 0 24 24"
      width={size}
      height={size}
      fill="none"
      stroke="currentColor"
      strokeWidth={1.6}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      className={classes}
      {...rest}
    >
      <path d={PATHS[name]} />
    </svg>
  );
}

/**
 * The PalCert application icon (the gold seal), at the size of the text it sits
 * beside. Derived from assets/brand/palcert-icon-master.png by
 * assets/brand/generate-icons.mjs; the 2x file keeps it sharp on dense screens.
 *
 * Decorative by default, because every use sits next to the visible word
 * "PalCert". Pass `label` where the mark is the only brand identifier.
 */
export function BrandMark({ size = 30, label }: { size?: number; label?: string }) {
  return (
    <img
      src={assetUrl(brandMark1x)}
      srcSet={`${assetUrl(brandMark1x)} 1x, ${assetUrl(brandMark2x)} 2x`}
      width={size}
      height={size}
      alt={label ?? ''}
      {...(label === undefined ? { 'aria-hidden': true } : {})}
      decoding="async"
      draggable={false}
      className="pc-brand-mark"
    />
  );
}

/** Next bundles a static image import as an object; plain bundlers as a URL string. */
function assetUrl(asset: string | { src: string }): string {
  return typeof asset === 'string' ? asset : asset.src;
}
