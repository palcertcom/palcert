/**
 * The web origin's Content Security Policy (Phase 20 Checkpoint 7).
 *
 * The Checkpoint 20.1 audit raised **F-007**: the only HTML origin PalCert
 * serves — the one that renders user-supplied document metadata and carries
 * the session cookie — had no CSP and no HSTS. Four headers were set; neither
 * of those two was among them.
 *
 * This is derived from what the application actually is, not copied from a
 * template. PalCert's web tier is unusually easy to write a strict policy for:
 * it has no CSS-in-JS, no `next/font`, no analytics, no embedded third-party
 * widget and no CDN. Its dependencies are `next`, `react`, `react-dom` and
 * `prom-client`. So every directive below can start from `'none'` and only
 * open what is demonstrably needed.
 */

/**
 * ## Why there is no nonce
 *
 * A nonce-based `script-src` was built first, and a real browser rejected it.
 * Twenty-three of PalCert's routes are prerendered by Next at build time
 * (`generateStaticParams` on the locale segment), and a per-request nonce
 * cannot be written into HTML that was generated before the request existed.
 * The measured result was unambiguous: the two dynamic routes rendered with
 * every script nonced and no violations; every prerendered route refused all
 * seventeen of its own scripts. `'strict-dynamic'` made it worse, because it
 * disables the `'self'` host allowance that would otherwise have carried them.
 *
 * Making every route dynamic would fix it and is not a hardening change — it
 * is a rendering-architecture change to twenty-three pages, for an app whose
 * prerendered pages are the login and marketing surfaces. Checkpoint 20.7
 * asks for the minimum safe v1 policy in exactly this situation, with the
 * enhancement deferred rather than the application broken.
 *
 * So `script-src` is `'self' 'unsafe-inline'`. What that costs is precise and
 * worth stating: an injected `<script>` in the page would execute. What it
 * does not cost is everything else — `default-src 'none'` denies each
 * directive nobody opened, `object-src`/`base-uri`/`frame-ancestors` are
 * `'none'`, `form-action` and `connect-src` are same-origin, so the usual
 * escalation paths out of an injection (exfiltrate to an attacker host,
 * retarget every relative URL, frame the app, post the form elsewhere) are
 * closed. And `unsafe-eval` is absent in production, which is the hard
 * requirement.
 *
 * Recorded as **P-015**: nonce-based `script-src`, which needs the prerendered
 * routes to become dynamic.
 */

/**
 * `unsafe-eval` is absent in production, which the checkpoint requires.
 *
 * The development server needs it: Next's fast refresh compiles modules in the
 * browser. That is a property of `next dev`, never of a built image, and both
 * policies are derived here so they cannot drift into "production got the dev
 * one by accident".
 */
const isDevelopment = process.env.NODE_ENV === 'development';

/**
 * Where the browser may reach the API.
 *
 * Empty (the production default) means same-origin, which the release topology
 * guarantees by serving the API under `/api/` on the web app's own host. A
 * deployment that splits them must name the API origin here, so the policy
 * follows the deployment rather than assuming one.
 */
function apiOrigin() {
  const configured = process.env.NEXT_PUBLIC_API_URL;
  if (configured === undefined || configured === '') return undefined;
  try {
    return new URL(configured).origin;
  } catch {
    return undefined;
  }
}

export function contentSecurityPolicy() {
  const directives = {
    // Everything not named below is denied. Starting from `'none'` means a
    // directive nobody thought about fails closed rather than inheriting
    // something permissive.
    'default-src': ["'none'"],

    // `strict-dynamic` is what makes a nonce workable with a bundler: the
    // nonced entry script may load the chunks it needs without every chunk URL
    // being enumerated. Browsers that honour it ignore the `'self'` fallback;
    // browsers that do not fall back to it, so neither is redundant.
    // See the note above: `'unsafe-inline'` rather than a nonce, because
    // twenty-three routes are prerendered and a nonce cannot reach HTML that
    // was generated before the request. No nonce is emitted either — a browser
    // ignores one when `'unsafe-inline'` is present, so shipping one would
    // make the header *look* stronger than it is, which is worse than the
    // weaker policy because the next person reads the header and believes it.
    'script-src': ["'self'", "'unsafe-inline'", ...(isDevelopment ? ["'unsafe-eval'"] : [])],

    // **The one compromise, and it is deliberate.**
    //
    // Next inlines critical CSS into the document and React writes `style`
    // attributes for the seven components that position things inline. Both
    // are framework and application behaviour that a nonce cannot cover —
    // style attributes are not noncable at all. Removing `unsafe-inline` here
    // would mean rewriting those components and giving up Next's CSS
    // inlining, for a class of attack (CSS exfiltration) that needs script
    // injection to be useful and is already denied above.
    //
    // Recorded as a v1 policy with the enhancement deferred, rather than
    // shipped as if it were strict.
    'style-src': ["'self'", "'unsafe-inline'"],

    // `blob:` is for local previews only: the public attestation page shows
    // the visitor an image they picked from their own device, from an object
    // URL the page itself created, so the file never leaves the browser. A
    // `blob:` URL can only be minted by script already running on this origin.
    // Plugins and frames stay closed below; a PDF is not embedded.
    'img-src': ["'self'", 'data:', 'blob:'],
    'font-src': ["'self'"],

    // The browser talks to its own origin, plus the API origin when a
    // deployment has configured a separate one. In the release topology there
    // is none: the API is same-origin behind the proxy, which is why the
    // session cookie is first-party and the CSRF origin check has something
    // to compare against.
    'connect-src': ["'self'", ...(apiOrigin() === undefined ? [] : [apiOrigin()])],

    // No plugins, no embedding, no framing — of us or by us.
    'object-src': ["'none'"],
    'frame-src': ["'none'"],
    'frame-ancestors': ["'none'"],

    // A form that posts somewhere else is exfiltration; PalCert has none.
    'form-action': ["'self'"],
    // `<base>` injection retargets every relative URL on the page, which turns
    // one injected tag into a whole-page hijack.
    'base-uri': ["'none'"],

    'manifest-src': ["'self'"],
    'worker-src': ["'self'"],
  };

  const policy = Object.entries(directives)
    .map(([name, values]) => `${name} ${values.join(' ')}`)
    .join('; ');

  // `upgrade-insecure-requests` is a directive with no value. Production only:
  // in development it would rewrite `http://localhost` requests to https and
  // break the dev server.
  return isDevelopment ? policy : `${policy}; upgrade-insecure-requests`;
}
