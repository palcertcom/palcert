// Browser security against the final web image, through the release proxy
// (Phase 20 Checkpoint 7, requirement 2).
//
// Four route shapes, because they are rendered differently and a policy that
// works on one can break another: a prerendered route, a dynamic route, an
// authenticated route, and the public certificate page. The CSP work found
// exactly that — a nonce policy was flawless on dynamic routes and broke every
// prerendered one.
//
// Two assertions per page. No CSP violation in the console, and no
// `localhost:4000` anywhere the page fetches from — the second is the defect
// that shipped in the web image and that no server-side check could have seen.
import { chromium } from 'playwright';

const base = process.env.BASE ?? 'https://localhost:8543';
const routes = [
  { path: '/en', kind: 'prerendered' },
  { path: '/ar', kind: 'prerendered (RTL)' },
  { path: '/en/login', kind: 'prerendered, authenticated surface' },
  { path: '/en/verify/PC0000000000000000000000000000000C', kind: 'dynamic, public certificate' },
  { path: '/en/documents', kind: 'authenticated route (redirects when signed out)' },
];

const browser = await chromium.launch({
  executablePath: process.env.CHROME_PATH,
  args: ['--ignore-certificate-errors'],
});
const context = await browser.newContext({ ignoreHTTPSErrors: true });

let violations = 0;
let badOrigins = 0;
let failures = 0;

for (const route of routes) {
  const page = await context.newPage();
  const cspMessages = [];
  const requested = [];
  page.on('console', (message) => {
    if (/Content Security Policy|Refused to/i.test(message.text()))
      cspMessages.push(message.text());
  });
  page.on('request', (request) => requested.push(request.url()));

  const response = await page
    .goto(base + route.path, { waitUntil: 'networkidle', timeout: 45000 })
    .catch((error) => ({ error }));
  if (response?.error) {
    console.log(
      `FAIL ${route.path} (${route.kind}): navigation failed — ${response.error.message}`,
    );
    failures += 1;
    await page.close();
    continue;
  }

  // Every request the page made, including XHR/fetch. A same-origin
  // deployment must never reach for the visitor's own machine.
  const offending = [
    ...new Set(requested.filter((url) => /localhost:4000|127\.0\.0\.1:4000/.test(url))),
  ];
  // And the API calls it did make must be on this origin, under /api/.
  const apiCalls = requested.filter((url) => url.includes('/api/v1/'));
  const foreignApi = apiCalls.filter((url) => !url.startsWith(base));

  const rendered = await page.evaluate(() => document.body.innerText.trim().length > 0);

  violations += cspMessages.length;
  badOrigins += offending.length + foreignApi.length;
  const ok =
    cspMessages.length === 0 && offending.length === 0 && foreignApi.length === 0 && rendered;
  if (!ok) failures += 1;

  console.log(
    `${ok ? 'ok  ' : 'FAIL'} ${route.path.padEnd(48)} ${String(response.status()).padEnd(4)} ` +
      `${route.kind} | requests=${requested.length} api=${apiCalls.length} csp=${cspMessages.length} ` +
      `localhost4000=${offending.length} foreignApi=${foreignApi.length} rendered=${rendered}`,
  );
  for (const message of cspMessages.slice(0, 3)) console.log(`     ! ${message}`);
  for (const url of offending.slice(0, 3)) console.log(`     ! reached ${url}`);
  for (const url of foreignApi.slice(0, 3)) console.log(`     ! off-origin API call ${url}`);
  await page.close();
}

await browser.close();
console.log(
  failures === 0
    ? 'browser-security: clean — no CSP violation and no off-origin API call on any route'
    : `browser-security: ${failures} route(s) failed, ${violations} CSP violation(s), ${badOrigins} bad origin(s)`,
);
process.exit(failures === 0 ? 0 : 1);
