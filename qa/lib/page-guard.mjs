/**
 * The checks that apply to every page, regardless of what a journey is about
 * (Phase 20 Checkpoint 8).
 *
 * A journey test asserts the thing it is about. These assert the things that
 * are wrong on *any* page and that nobody writes a test for: an exception
 * swallowed by an error boundary, a hydration mismatch that silently makes the
 * page non-interactive, a CSP violation, a request to a development endpoint,
 * a translation key rendered raw because a locale file is missing an entry.
 *
 * They are collected per page and reported together, because one root cause
 * usually produces several symptoms and a list is more useful than the first
 * one to fire.
 */

/**
 * Hosts that must never appear in a request from a deployed page — *other than
 * the deployment's own origin*.
 *
 * That exception is the whole subtlety. The QA stack is itself served from
 * `https://localhost:8543`, so a check that simply forbids `localhost` flags
 * every stylesheet the page legitimately loads. The first version did exactly
 * that and reported five clean steps as five failures. What is actually being
 * looked for is a request to somewhere *else* — the baked-in `localhost:4000`
 * that shipped in the web image, a leftover development API, a test origin.
 */
const DEVELOPMENT_HOSTS =
  /^https?:\/\/(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\]|.*\.test|.*\.local)(:\d+)?/i;

function isForeignDevelopmentHost(url, baseOrigin) {
  try {
    const origin = new URL(url).origin;
    if (baseOrigin !== null && origin === baseOrigin) return false;
    return DEVELOPMENT_HOSTS.test(origin);
  } catch {
    return false;
  }
}

/**
 * A raw translation key looks like `documents.upload.title` — lower-case
 * segments joined by dots, with no spaces. Ordinary prose does not, and the
 * few things that legitimately do (a filename, a hostname, a version) are
 * excluded explicitly rather than by loosening the pattern.
 */
const RAW_KEY = /\b[a-z][a-zA-Z0-9]*(\.[a-z][a-zA-Z0-9]*){2,}\b/g;
const NOT_A_KEY =
  /\.(com|org|net|io|test|example|ps|docx|pdf|json|js|css|png|svg|jpg)\b|^\d|localhost/i;

/**
 * WebKit's wording for a load the browser itself cancelled — and the one thing
 * this guard deliberately does not count as an uncaught exception.
 *
 * `<url> due to access control checks.` is what WebKit reports when a fetch or
 * a prefetch is cut short by a navigation away from the page that started it.
 * Checkpoint 20.8 measured it twice: on the profile screen's own `/users/me`,
 * issued by a React effect after hydration, and on a Next.js RSC prefetch of
 * `/ar/sessions`. Chromium and Firefox report the same cancellations quietly.
 * No step in nine hundred and sixty saw any user-visible consequence.
 *
 * The narrowing is deliberately tight, and it hides nothing this guard would
 * otherwise catch:
 *
 *  - **same origin only.** A genuine cross-origin block is a different URL and
 *    is still reported here, and a request to a development origin is caught
 *    by the forbidden-host rule regardless.
 *  - **a real CORS refusal of a same-origin request is not possible.** Same
 *    origin is the definition of not needing access control.
 *  - **a CSP refusal is reported separately**, through the `csp` channel, which
 *    is untouched.
 *  - **any other message is still an uncaught exception** and still fails the
 *    run, including anything with a stack, a name, or different wording.
 *
 * The harness also avoids *creating* these, by letting a page finish arriving
 * before leaving it (`settle` in `qa/lib/session.mjs`). This rule covers what
 * remains: a prefetch the framework started on its own schedule.
 */
const CANCELLED_LOAD = /^(\S+) due to access control checks\.$/;

export function isCancelledSameOriginLoad(message, baseOrigin) {
  const match = CANCELLED_LOAD.exec(message.trim());
  if (match === null || baseOrigin === null) return false;
  // WebKit prints the URL without its scheme, e.g. "/localhost:8543/api/...".
  const printed = match[1];
  const host = baseOrigin.replace(/^https?:\/\//, '');
  return printed.startsWith(`/${host}`) || printed.startsWith(baseOrigin);
}

export function watchPage(page, base = null) {
  let baseOrigin = null;
  try {
    baseOrigin = base === null ? null : new URL(base).origin;
  } catch {
    baseOrigin = null;
  }

  const findings = { exceptions: [], csp: [], mixed: [], forbidden: [], console: [] };

  page.on('pageerror', (error) => {
    const message = String(error.message).slice(0, 300);
    if (isCancelledSameOriginLoad(message, baseOrigin)) return;
    findings.exceptions.push(message);
  });

  page.on('console', (message) => {
    const text = message.text();
    if (/Content Security Policy|Refused to (load|connect|execute)/i.test(text)) {
      findings.csp.push(text.slice(0, 300));
    } else if (/Mixed Content/i.test(text)) {
      findings.mixed.push(text.slice(0, 300));
    } else if (
      // React's hydration failures are console errors, not exceptions. A
      // hydration mismatch leaves a page that looks right and does nothing,
      // which is the worst failure mode there is: it passes every screenshot.
      message.type() === 'error' &&
      /hydrat|Minified React error #(418|423|425)/i.test(text)
    ) {
      findings.exceptions.push(`hydration: ${text.slice(0, 250)}`);
    } else if (message.type() === 'error') {
      findings.console.push(text.slice(0, 250));
    }
  });

  page.on('request', (request) => {
    if (isForeignDevelopmentHost(request.url(), baseOrigin)) findings.forbidden.push(request.url());
  });

  return findings;
}

/** Translation keys rendered as text, which means a message is missing. */
export async function rawTranslationKeys(page) {
  const text = await page.evaluate(() => document.body.innerText);
  return [...new Set((text.match(RAW_KEY) ?? []).filter((match) => !NOT_A_KEY.test(match)))];
}

/**
 * Something that never stops loading.
 *
 * Asked after the journey step has settled: anything still announcing itself
 * as busy at that point is a spinner the user is looking at, not a transient.
 */
export async function stuckLoaders(page) {
  return page.evaluate(() => {
    const busy = [...document.querySelectorAll('[aria-busy="true"], [role="progressbar"]')];
    return busy
      .filter((element) => element.offsetParent !== null)
      .map((element) => element.getAttribute('aria-label') ?? element.tagName)
      .slice(0, 5);
  });
}

/** Anything that looks like a stack trace or an internal path, rendered to a user. */
export async function leakedInternals(page) {
  const text = await page.evaluate(() => document.body.innerText);
  const patterns = [
    [/\bat [A-Za-z$_][\w$.]*\s*\(/, 'a stack frame'],
    [/node_modules|\/app\/dist|webpack-internal/, 'an internal path'],
    [/\b(SELECT|INSERT|UPDATE)\s+[\w"]+\s+FROM\b/i, 'a SQL fragment'],
    [/PrismaClient|PostgresError|ECONNREFUSED/, 'a driver error'],
  ];
  return patterns.filter(([pattern]) => pattern.test(text)).map(([, what]) => what);
}

/** Everything above, as one verdict for one page. */
export async function inspect(page, findings) {
  const [keys, loaders, internals] = await Promise.all([
    rawTranslationKeys(page),
    stuckLoaders(page),
    leakedInternals(page),
  ]);
  const problems = [];
  for (const message of findings.exceptions) problems.push(`uncaught: ${message}`);
  for (const message of findings.csp) problems.push(`csp: ${message}`);
  for (const message of findings.mixed) problems.push(`mixed-content: ${message}`);
  for (const url of findings.forbidden) problems.push(`forbidden-host: ${url}`);
  for (const key of keys) problems.push(`raw-translation-key: ${key}`);
  for (const loader of loaders) problems.push(`stuck-loader: ${loader}`);
  for (const leak of internals) problems.push(`leaked-internal: ${leak}`);
  return problems;
}
