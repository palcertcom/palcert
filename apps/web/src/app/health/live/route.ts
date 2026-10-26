import { NextResponse } from 'next/server';

/**
 * Web liveness (Phase 20 Checkpoint 2).
 *
 * Checkpoint 20.1 found the web image alone among the three with no health
 * route and no HEALTHCHECK, so an orchestrator could not tell a wedged
 * container from a healthy one.
 *
 * Liveness only. It answers the one question a restart decision needs — is
 * this Next.js server still able to run a request handler? — and it
 * deliberately does **not** call the API. A web container that is fine while
 * the API is briefly unavailable must not be killed: restarting it would not
 * bring the API back, and a restart loop across every web replica during an
 * API blip turns a partial outage into a total one. Whether the API is healthy
 * is the API's own probe to answer.
 *
 * It sits outside `[locale]` on purpose: a probe URL must not depend on
 * negotiating a language, and it is never redirected by the locale middleware.
 */
export const dynamic = 'force-dynamic';

export function GET(): NextResponse {
  return NextResponse.json({
    status: 'ok',
    service: process.env.NEXT_PUBLIC_APP_NAME ?? 'palcert-web',
    version: process.env.APP_VERSION ?? '0.0.0',
    release: {
      ...(process.env.APP_COMMIT !== undefined ? { commit: process.env.APP_COMMIT } : {}),
      ...(process.env.APP_BUILT_AT !== undefined ? { builtAt: process.env.APP_BUILT_AT } : {}),
    },
    checkedAt: new Date().toISOString(),
  });
}
