import { NextResponse, type NextRequest } from 'next/server';
import { LOCALES, negotiateLocale } from '@/i18n/locales';

/**
 * Redirects locale-less paths to a locale-prefixed route, choosing the user's
 * preferred language from `Accept-Language` (§31).
 */
export function middleware(request: NextRequest): NextResponse {
  const { pathname } = request.nextUrl;

  const hasLocale = LOCALES.some(
    (locale) => pathname === `/${locale}` || pathname.startsWith(`/${locale}/`),
  );
  if (hasLocale) return NextResponse.next();

  const locale = negotiateLocale(request.headers.get('accept-language'));
  const url = request.nextUrl.clone();
  url.pathname = `/${locale}${pathname === '/' ? '' : pathname}`;
  return NextResponse.redirect(url);
}

export const config = {
  // `health` and `metrics` are excluded alongside the framework paths: a
  // probe or a scrape must not be redirected to a locale-prefixed URL.
  // Without this, /health/live answers 307 to /en/health/live and every
  // orchestrator reads a wedged container (Phase 20 Checkpoints 2 and 3).
  matcher: ['/((?!api|health|metrics|_next/static|_next/image|favicon.ico|.*\\..*).*)'],
};
