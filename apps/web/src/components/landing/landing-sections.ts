/**
 * The homepage sections the header, the menu and the footer link to, in page
 * order.
 *
 * Its own module on purpose: the header is a client component, and a server
 * component that imports a plain value from a client module receives a
 * reference to it, not the value.
 */
export const LANDING_SECTIONS = [
  { id: 'services', key: 'services' },
  { id: 'how-it-works', key: 'howItWorks' },
  { id: 'platform', key: 'platform' },
  { id: 'solutions', key: 'solutions' },
  { id: 'trust', key: 'trust' },
  { id: 'faq', key: 'faq' },
] as const;
