import { cookies } from 'next/headers';
import { SESSION_COOKIE_NAME } from '@palcert/contracts';

/**
 * Whether this request carries a PalCert session cookie at all.
 *
 * A hint for choosing what to render first, never an authentication decision:
 * the cookie is not read, verified or passed on — only its presence is
 * checked — and every private read still goes to the API, which decides. A
 * visitor with no cookie cannot be signed in, so the public homepage can be
 * rendered on the server for them; a visitor with one (valid or stale) gets
 * the dashboard, which asks the API who they are and falls back to the public
 * page if the answer is "nobody".
 */
export async function hasSessionCookie(): Promise<boolean> {
  return (await cookies()).has(SESSION_COOKIE_NAME);
}
