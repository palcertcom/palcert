import { timingSafeEqual } from 'node:crypto';
import { NextResponse, type NextRequest } from 'next/server';
import { metricsEnabled, metricsRegistry, metricsToken } from '@/server/metrics/registry';

/**
 * The web tier's Prometheus scrape endpoint (Phase 20 Checkpoint 3).
 *
 * Outside `[locale]`, like the health probe and for the same reason: a scrape
 * URL must not depend on negotiating a language. `force-dynamic` because a
 * cached scrape is a lie about the present.
 */
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function GET(request: NextRequest): Promise<NextResponse | Response> {
  // 404, not 403: a deployment that turned telemetry off should look like one
  // that never had it rather than advertise a disabled feature.
  if (!metricsEnabled()) return new NextResponse(null, { status: 404 });

  const expected = metricsToken();
  if (
    expected !== undefined &&
    !presentedTokenMatches(request.headers.get('authorization'), expected)
  ) {
    return new NextResponse(null, { status: 403 });
  }

  const registry = metricsRegistry();
  // `metrics()` is asynchronous: prom-client awaits every collector before it
  // renders. Passing the promise straight to `Response` serves the literal
  // text "[object Promise]", which is a 200 that tells a scraper nothing.
  const body = await registry.metrics();
  return new Response(body, {
    status: 200,
    headers: {
      'Content-Type': registry.contentType,
      'Cache-Control': 'no-store',
    },
  });
}

/**
 * Constant-time comparison of the presented bearer token.
 *
 * `timingSafeEqual` throws on a length mismatch, so lengths are compared
 * first — and that comparison is not itself a leak worth avoiding: the
 * token's length is not the secret, its value is.
 */
function presentedTokenMatches(authorization: string | null, expected: string): boolean {
  if (authorization === null) return false;

  const [scheme, presented] = authorization.split(' ');
  if (scheme?.toLowerCase() !== 'bearer' || presented === undefined) return false;

  const a = Buffer.from(presented, 'utf8');
  const b = Buffer.from(expected, 'utf8');
  return a.length === b.length && timingSafeEqual(a, b);
}
