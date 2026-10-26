import type { ReactNode } from 'react';
// IBM Plex Sans Arabic (OFL-1.1), served from PalCert's own origin. Each file
// declares per-script `unicode-range`s, so a browser downloads a weight only
// for a page that sets text in it — in practice, only the Arabic pages.
import '@fontsource/ibm-plex-sans-arabic/400.css';
import '@fontsource/ibm-plex-sans-arabic/500.css';
import '@fontsource/ibm-plex-sans-arabic/600.css';
import '@fontsource/ibm-plex-sans-arabic/700.css';
import '../styles/app.css';

/**
 * The root layout renders no `<html>` attributes of its own — locale and text
 * direction are owned by the `[locale]` layout so every page is direction-aware
 * (§31).
 */
export default function RootLayout({ children }: { children: ReactNode }) {
  return children;
}
