#!/usr/bin/env node
/**
 * The release checks that are not per-engine, per-locale or per-width
 * (Phase 20 Checkpoint 8).
 *
 *   CHROME_PATH=… BASE=https://localhost:8543 node qa/release-checks.mjs
 *   … node qa/release-checks.mjs --payments-disabled
 *
 * Three questions the browser matrix does not ask, because asking them
 * twenty-four times would tell you nothing twenty-three more times:
 *
 *  1. **Privacy through the interface.** An institution must not be able to
 *     discover a person's private work without that person submitting it.
 *     The API suites prove the server refuses; this proves the interface does
 *     not show it anyway — and carries the control that makes a clean result
 *     mean something, by checking the owner *can* see the same object.
 *  2. **Webhook UX.** A rejected destination must produce a sentence the
 *     operator can act on, and never signing material or the internals of the
 *     SSRF defence.
 *  3. **Payments in the other mode.** The matrix runs against a deployment
 *     with payments enabled. `--payments-disabled` is run against the same
 *     deployment reconfigured, and asserts the balance screen still loads,
 *     still shows the balance, and explains that adding credit is unavailable
 *     rather than spinning or blanking.
 *
 * And, from Checkpoint 20.9, one the matrix could not ask because its fixture
 * is seeded through the API: whether a person can upload a document through
 * the interface at all (section 6).
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { chromium, firefox, webkit } from 'playwright';
import { inspect, watchPage } from './lib/page-guard.mjs';
import { signIn } from './lib/session.mjs';

const BASE = process.env.BASE ?? 'https://localhost:8543';
const PAYMENTS_DISABLED = process.argv.includes('--payments-disabled');
const fixture = JSON.parse(readFileSync(process.env.FIXTURE ?? 'qa/.fixture.json', 'utf8'));

process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

/** A minimal, structurally valid PDF: the one `apps/api/test/support/fixtures.ts` builds. */
function minimalPdf(text) {
  const objects = [
    '1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj\n',
    '2 0 obj << /Type /Pages /Kids [3 0 R] /Count 1 >> endobj\n',
    '3 0 obj << /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Contents 4 0 R >> endobj\n',
  ];
  const stream = `BT /F1 12 Tf 72 770 Td (${text}) Tj ET`;
  objects.push(`4 0 obj << /Length ${stream.length} >> stream\n${stream}\nendstream endobj\n`);
  let body = '%PDF-1.7\n%\u00e2\u00e3\u00cf\u00d3\n';
  const offsets = [];
  for (const object of objects) {
    offsets.push(Buffer.byteLength(body, 'latin1'));
    body += object;
  }
  const xref = Buffer.byteLength(body, 'latin1');
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets) body += `${String(offset).padStart(10, '0')} 00000 n \n`;
  body += `trailer << /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(body, 'latin1');
}

let failures = 0;
function report(ok, what, detail = '') {
  if (!ok) failures += 1;
  console.log(
    `release-check: ${ok ? 'ok  ' : 'FAIL'} ${what}${detail === '' ? '' : `  ${detail}`}`,
  );
}

const browser = await chromium.launch({
  executablePath: process.env.CHROME_PATH,
  args: ['--ignore-certificate-errors'],
});

/**
 * One signed-in context per identity, reused.
 *
 * Signing in afresh for each check spent the per-IP login budget and the run
 * died half way through on a throttle it had caused itself — the same trap the
 * browser matrix fell into earlier in this checkpoint. Six sign-ins became two.
 */
const sessions = new Map();

async function open(email = null, locale = 'en') {
  const key = email === null ? null : `${email}|${locale}`;
  if (key !== null && sessions.has(key)) {
    const cached = sessions.get(key);
    const page = await cached.newPage();
    return { context: cached, page, findings: watchPage(page, BASE), shared: true };
  }

  const context = await browser.newContext({
    ignoreHTTPSErrors: true,
    viewport: { width: 1280, height: 800 },
    locale: locale === 'ar' ? 'ar' : 'en-GB',
  });
  const page = await context.newPage();
  const findings = watchPage(page, BASE);
  if (email !== null) {
    await signIn(page, BASE, locale, { email, password: fixture.password });
    sessions.set(key, context);
  }
  return { context, page, findings, shared: email !== null };
}

/** Close a page, keeping its context alive for the next check that needs it. */
async function done({ context, page, shared }) {
  await page.close();
  if (!shared) await context.close();
}

// --------------------------------------------------------------------------
// 3. Payments.
//
// Three states, and this environment can reach all three honestly:
//
//   A. the deployment as configured — whatever `/api/health/payments` says,
//      the screen must agree with it. Here that is `enabled: true,
//      available: false`, because the release stack has no route to Stripe.
//   B. enabled *and* reachable — the ordinary production state. It cannot be
//      produced here without calling a real payment service, which this
//      checkpoint forbids, and the fake provider is refused outright in
//      production mode (correctly — it would credit real balances against no
//      money). So PalCert's own availability response is stubbed in the
//      browser. Nothing else is stubbed: the real bundle takes the real
//      branch.
//   C. `--payments-disabled`, run against the same deployment actually
//      reconfigured and restarted.
//
// Together they mean neither outcome can pass by default.
// --------------------------------------------------------------------------
async function balanceScreen(page, findings, { stub = null } = {}) {
  if (stub !== null) {
    await page.route('**/api/health/payments', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(stub),
      }),
    );
  }
  await page.goto(`${BASE}/en/balance`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(1500);
  const text = await page.evaluate(() => document.body.innerText);
  return {
    guard: await inspect(page, findings),
    text,
    offered: await page.getByRole('button', { name: /add credit|continue|إضافة/i }).count(),
    unavailable: /not available at the moment|غير متاحة حالياً/i.test(text),
  };
}

{
  // A. what this deployment actually reports.
  const reported = await (await fetch(`${BASE}/api/health/payments`)).json();
  const possible = reported.enabled === true && reported.available === true;
  console.log(
    `release-check: note the deployment reports enabled=${reported.enabled} available=${reported.available}`,
  );

  const { context, page, findings, shared } = await open(fixture.author.email);

  const asConfigured = await balanceScreen(page, findings);
  report(
    asConfigured.guard.length === 0,
    'the balance screen is clean',
    asConfigured.guard.join('; '),
  );
  // The balance itself must be readable whatever the provider is doing: money
  // someone already has is not hidden because a company is unreachable.
  report(/balance|الرصيد/i.test(asConfigured.text), 'the balance is shown');
  report(
    asConfigured.offered > 0 === possible,
    'the screen agrees with what the API says about payments',
    `offered=${asConfigured.offered} possible=${possible}`,
  );
  report(
    asConfigured.unavailable === !possible,
    'the unavailable notice matches what the API says',
  );

  if (PAYMENTS_DISABLED) {
    report(reported.enabled === false, 'the deployment really is running with payments off');
    report(asConfigured.unavailable, 'adding credit is explained as unavailable, in words');
    report(asConfigured.offered === 0, 'no top-up control is offered while payments are off');
  } else {
    // B. the ordinary production state, reached by stubbing PalCert's own
    // availability response and nothing else.
    const reachable = await balanceScreen(page, findings, {
      stub: { enabled: true, available: true, provider: 'stripe' },
    });
    report(
      reachable.guard.length === 0,
      'the balance screen is clean when payments work',
      reachable.guard.join('; '),
    );
    report(reachable.offered > 0, 'a top-up control is offered when payments work');
    report(!reachable.unavailable, 'no unavailable notice is shown when payments work');
  }
  await done({ context, page, shared });
}

if (!PAYMENTS_DISABLED) {
  // ------------------------------------------------------------------------
  // 1. Privacy through the interface.
  //
  // A document is created for the author through PalCert's own API, with a
  // name nothing else in the deployment uses. Then two browsers look for it:
  // the organization owner's, which must not find it anywhere, and the
  // author's, which must. Without that second half a clean result would be
  // satisfied by an interface that shows nobody anything.
  //
  // The object is a document rather than a completed check: a check needs
  // credit, a finalized upload and an analyzer run, and the boundary being
  // exercised here — owner-scoped rows, never organization-scoped — is the
  // same one for both. `documents-isolation` and `checks-isolation` prove the
  // server side for each; this adds the half that is about the screen.
  // ------------------------------------------------------------------------
  const marker = `PRIVATE-${Date.now().toString(36).toUpperCase()}`;

  async function apiAs(email) {
    const login = await fetch(`${BASE}/api/v1/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: BASE },
      body: JSON.stringify({ email, password: fixture.password }),
    });
    if (login.status !== 200) throw new Error(`login ${email}: ${login.status}`);
    const cookie = (login.headers.getSetCookie?.() ?? [])
      .map((entry) => entry.split(';')[0])
      .filter((entry) => entry.startsWith('palcert_'))
      .join('; ');
    return { cookie, csrf: /palcert_csrf=([^;]+)/.exec(cookie)?.[1] ?? '' };
  }

  const authorSession = await apiAs(fixture.author.email);
  const created = await fetch(`${BASE}/api/v1/documents`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Origin: BASE,
      Cookie: authorSession.cookie,
      'x-csrf-token': authorSession.csrf,
    },
    body: JSON.stringify({ displayName: `${marker} thesis` }),
  });
  const createdDocument = await created.json();
  report(
    created.status === 201,
    'a private document was created for the author',
    `${created.status}`,
  );
  const documentId = createdDocument.id;

  // The institution's browser.
  {
    const { context, page, findings, shared } = await open(fixture.registrar.email);
    const org = fixture.registrar.organizationId;
    const seen = [];
    for (const path of [
      `/organizations/${org}`,
      `/organizations/${org}/submissions`,
      `/organizations/${org}/members`,
      `/documents`,
      `/documents/${documentId}`,
    ]) {
      await page.goto(`${BASE}/en${path}`, { waitUntil: 'networkidle' }).catch(() => {});
      await page.waitForTimeout(900);
      const body = await page.evaluate(() => document.body.innerText);
      if (body.includes(marker)) seen.push(path);
      // Whatever it shows instead, it must be a screen rather than a crash.
      const guard = await inspect(page, findings);
      report(
        guard.length === 0,
        `the institution's view of ${path} is a clean screen`,
        guard.join('; '),
      );
      if (body.trim().length < 15) report(false, `${path} is blank for the institution`);
    }
    report(
      seen.length === 0,
      'the institution cannot discover the private document anywhere in its interface',
      seen.join(', '),
    );
    await done({ context, page, shared });
  }

  // The control: the owner must see the very same object.
  {
    const { context, page, shared } = await open(fixture.author.email);
    await page.goto(`${BASE}/en/documents`, { waitUntil: 'networkidle' });
    await page.waitForTimeout(1200);
    const body = await page.evaluate(() => document.body.innerText);
    report(
      body.includes(marker),
      'CONTROL: the owner does see it, so the check above could have failed',
    );
    await done({ context, page, shared });
  }

  // ------------------------------------------------------------------------
  // 2. Webhook UX: a destination the SSRF defence rejects.
  // ------------------------------------------------------------------------
  {
    const { context, page, findings, shared } = await open(fixture.registrar.email);
    const org = fixture.registrar.organizationId;
    await page.goto(`${BASE}/en/organizations/${org}/webhooks`, { waitUntil: 'networkidle' });

    await page.locator('#webhook-description').fill('QA rejected destination');
    // A link-local address: the canonical target of an SSRF attempt.
    await page.locator('#webhook-url').fill('http://169.254.169.254/latest/meta-data/');
    await page.locator('fieldset input[type="checkbox"]').first().check();
    await page
      .getByRole('button', { name: /create|add|إنشاء/i })
      .last()
      .click();
    await page.waitForTimeout(2500);

    const guard = await inspect(page, findings);
    report(
      guard.length === 0,
      'the webhook screen stays clean after a rejection',
      guard.join('; '),
    );

    const body = await page.evaluate(() => document.body.innerText);
    report(
      !/169\.254\.169\.254 is|ECONNREFUSED|EAI_AGAIN|RFC1918|link-local|loopback address/i.test(
        body.replace('http://169.254.169.254/latest/meta-data/', ''),
      ),
      'the rejection does not expose the SSRF defence internals',
    );
    report(!/whsec_|\bpc_[A-Za-z0-9_-]{16,}/.test(body), 'no signing material is on screen');
    // It must say *something*: a form that silently does nothing is worse
    // than one that refuses.
    const refused = await page.evaluate(() =>
      Array.from(document.querySelectorAll('[role="alert"], .pc-error'))
        .map((node) => node.textContent?.trim() ?? '')
        .join(' '),
    );
    report(refused.length > 0, 'the refusal is announced to the operator', refused.slice(0, 90));
    await done({ context, page, shared });
  }
}

// --------------------------------------------------------------------------
// 4. A real render failure, in both languages.
//
// The documents list is answered with valid JSON of the wrong shape, so
// `items.map(...)` throws while React is rendering. That is a genuine crash —
// no product change, no test hook — and what it lands on is the boundary added
// in this checkpoint. Before it existed the same stub produced Next's built-in
// screen, untranslated; that is what makes a pass here mean something.
// --------------------------------------------------------------------------
for (const locale of ['en', 'ar']) {
  const { context, page, shared } = await open(fixture.author.email, locale);
  await page.route('**/api/v1/documents**', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ items: 'not-an-array', nextCursor: null }),
    }),
  );
  await page.goto(`${BASE}/${locale}/documents`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(3500);

  const seen = await page.evaluate(() => ({
    dir: document.documentElement.dir,
    text: document.body.innerText,
    retry: Array.from(document.querySelectorAll('button')).length,
  }));
  const expected =
    locale === 'ar' ? /حدث خطأ في هذه الشاشة/ : /Something went wrong on this screen/;

  report(expected.test(seen.text), `a render failure is explained in ${locale}`);
  report(seen.dir === (locale === 'ar' ? 'rtl' : 'ltr'), `the boundary keeps ${locale} direction`);
  report(seen.retry > 0, `the boundary offers a way forward in ${locale}`);
  // Never the machine contract, and never a stack.
  report(
    !/\bat\s+\w+\s*\(|\.tsx?:\d+|TypeError|is not a function/.test(seen.text),
    `no stack trace or raw exception reaches the reader in ${locale}`,
  );
  await done({ context, page, shared });
}

// --------------------------------------------------------------------------
// 5. Typing before the page is ready.
//
// On a slow connection the server's sign-in form is on screen, and typeable,
// before React has loaded. Checkpoint 20.8 found that whatever was typed in
// that window was shown in the fields and then *not sent*: the form posted
// `{"email":"","password":""}` and PalCert answered "Please check the
// information you entered" to someone who had entered it correctly.
//
// Reproduced here by holding every script back for three seconds — the
// server-rendered form is visible, the person types, React arrives, they press
// Sign in. What matters is what reaches the server, so that is what is read.
// --------------------------------------------------------------------------
{
  const context = await browser.newContext({ ignoreHTTPSErrors: true, locale: 'en-GB' });
  const page = await context.newPage();
  await page.route('**/_next/static/chunks/**', async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 3000));
    await route.continue().catch(() => {});
  });
  let posted = null;
  page.on('request', (request) => {
    if (request.url().endsWith('/api/v1/auth/login') && request.method() === 'POST') {
      posted = request.postDataJSON();
    }
  });

  await page.goto(`${BASE}/en/login`, { waitUntil: 'domcontentloaded' });
  await page.getByLabel(/email/i).first().fill(fixture.author.email);
  await page
    .getByLabel(/password/i)
    .first()
    .fill(fixture.password);
  // React arrives.
  await page.waitForLoadState('networkidle').catch(() => {});
  await page.waitForTimeout(1500);
  await page
    .getByRole('button', { name: /sign in/i })
    .first()
    .click();
  // Every script is still held back three seconds, including the ones the
  // next page needs, so arriving takes a while. Wait for it rather than
  // guessing a number, and if it never comes, say what the screen said.
  const arrived = await page
    .waitForURL((url) => !url.pathname.endsWith('/login'), { timeout: 30_000 })
    .then(() => true)
    .catch(() => false);
  const screenSaid = arrived
    ? ''
    : await page
        .evaluate(() =>
          Array.from(document.querySelectorAll('[role="alert"]'))
            .map((node) => node.textContent?.trim() ?? '')
            .join(' | '),
        )
        .catch(() => '');

  report(
    posted?.email === fixture.author.email &&
      typeof posted?.password === 'string' &&
      posted.password.length > 0,
    'what was typed before the page was ready is what gets sent',
    posted === null ? 'nothing was sent' : `sent email=${JSON.stringify(posted.email)}`,
  );
  report(arrived, 'and the person is signed in on the first attempt', screenSaid);
  await context.close();
}

// --------------------------------------------------------------------------
// 6. A document uploaded through the interface, in every engine.
//
// Checkpoint 20.9 found that nobody could. The API signed each upload URL for
// `https://localhost:9000` -- a port nothing published -- and the web app's
// CSP, `connect-src 'self'`, would have refused it anyway: the browser
// reported a CSP violation and the person saw "Something went wrong". Behind
// that was a second fault: the release stack's object store had no KMS, so
// the `AES256` encryption production insists on was refused with a 501 and
// no object could have been stored even had the request arrived.
//
// Nine hundred and sixty matrix steps passed through all of it, because the
// matrix's documents are seeded through the API and no step pushes bytes from
// a browser. This does, end to end: the upload leaves the page, is scanned and
// promoted by the worker, the version reaches Ready, and the bytes that come
// back from Download are the bytes that went up.
// --------------------------------------------------------------------------
if (!PAYMENTS_DISABLED) {
  const login = await fetch(`${BASE}/api/v1/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: BASE },
    body: JSON.stringify({ email: fixture.author.email, password: fixture.password }),
  });
  const cookies = (login.headers.getSetCookie?.() ?? [])
    .map((entry) => entry.split(';')[0])
    .filter((entry) => entry.startsWith('palcert_'))
    .map((entry) => {
      const split = entry.indexOf('=');
      return { name: entry.slice(0, split), value: entry.slice(split + 1), url: BASE };
    });
  const csrf = cookies.find((cookie) => cookie.name === 'palcert_csrf')?.value ?? '';
  report(login.status === 200, 'the author can sign in for the upload check', `${login.status}`);

  for (const [engine, type, launch] of [
    [
      'chromium',
      chromium,
      { executablePath: process.env.CHROME_PATH, args: ['--ignore-certificate-errors'] },
    ],
    ['firefox', firefox, {}],
    ['webkit', webkit, {}],
  ]) {
    const created = await fetch(`${BASE}/api/v1/documents`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Origin: BASE,
        Cookie: cookies.map((cookie) => `${cookie.name}=${cookie.value}`).join('; '),
        'x-csrf-token': csrf,
      },
      body: JSON.stringify({ displayName: `Upload through ${engine}` }),
    });
    const documentId = (await created.json()).id;

    const engineBrowser = await type.launch(launch);
    const context = await engineBrowser.newContext({
      ignoreHTTPSErrors: true,
      acceptDownloads: true,
      locale: 'en-GB',
    });
    await context.addCookies(cookies);
    const page = await context.newPage();
    const findings = watchPage(page, BASE);
    const storage = [];
    page.on('response', (response) => {
      if (response.request().method() === 'PUT') {
        storage.push(`${new URL(response.url()).origin} ${response.status()}`);
      }
    });

    const bytes = minimalPdf(`Uploaded through ${engine} at ${Date.now()}`);
    await page.goto(`${BASE}/en/documents/${documentId}`, { waitUntil: 'networkidle' });
    await page
      .locator('input[type="file"]')
      .first()
      .setInputFiles({
        name: `${engine}.pdf`,
        mimeType: 'application/pdf',
        buffer: bytes,
      });
    await page
      .getByRole('button', { name: /^upload$/i })
      .first()
      .click();

    // Scanning and promotion are the worker's; poll the screen, not a timer.
    // The *current* step, not the page text: the stage list names Ready as
    // the last step from the moment an upload starts.
    let ready = false;
    for (let waited = 0; waited < 90_000 && !ready; waited += 2_000) {
      await page.waitForTimeout(2_000);
      const current = await page
        .locator('.pc-stages li[aria-current="step"]')
        .first()
        .textContent({ timeout: 1_000 })
        .catch(() => null);
      ready = current?.trim() === 'Ready';
    }
    const guard = await inspect(page, findings);
    report(
      storage.length === 1 && storage[0] === `${BASE} 200`,
      `${engine}: the upload goes to the web origin and is stored`,
      storage.join(', ') || 'no upload request was made',
    );
    report(ready, `${engine}: the uploaded version reaches Ready`);
    report(guard.length === 0, `${engine}: the upload raises no page fault`, guard.join('; '));

    if (ready) {
      const arrived = page.waitForEvent('download', { timeout: 30_000 }).catch(() => null);
      await page
        .getByRole('button', { name: /^download$/i })
        .first()
        .click();
      const download = await arrived;
      let same = false;
      if (download !== null) {
        const saved = await download.path().catch(() => null);
        same =
          saved !== null &&
          createHash('sha256').update(readFileSync(saved)).digest('hex') ===
            createHash('sha256').update(bytes).digest('hex');
      }
      report(same, `${engine}: Download returns exactly the bytes that were uploaded`);
    }
    await engineBrowser.close();
  }

  // The route to storage is for presigned requests and nothing else.
  const listing = await fetch(`${BASE}/palcert-documents/`);
  report(
    listing.status === 404,
    'a bucket cannot be listed through the proxy',
    `${listing.status}`,
  );
  const unsigned = await fetch(`${BASE}/palcert-documents/any-object`);
  report(unsigned.status === 403, 'an unsigned object request is refused', `${unsigned.status}`);
  report(
    /sandbox/.test(unsigned.headers.get('content-security-policy') ?? '') &&
      unsigned.headers.get('x-content-type-options') === 'nosniff',
    'whatever storage serves on the web origin is sandboxed and never sniffed',
  );
  const deletion = await fetch(`${BASE}/palcert-documents/any-object`, { method: 'DELETE' });
  report(
    deletion.status === 403,
    'the proxy refuses any method but GET and PUT',
    `${deletion.status}`,
  );
}

await browser.close();

// A summary line that cannot read "ok" without the checks having run.
console.log(
  `release-check: ${failures === 0 ? 'all checks clean' : `${failures} check(s) failed`}` +
    (PAYMENTS_DISABLED ? ' (payments disabled mode)' : ''),
);
process.exit(failures === 0 ? 0 : 65);
