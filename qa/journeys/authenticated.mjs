/**
 * What a signed-in person does (Phase 20 Checkpoint 8).
 *
 * Sign in through the form, move around the application shell, and look at the
 * screens where a person's own work lives. Every navigation is a full page
 * visit through the deployed build, so a route that only works when Next has
 * been warmed by a previous click is caught rather than hidden.
 */
import { scan, blocking } from '../lib/accessibility.mjs';
import { inspect } from '../lib/page-guard.mjs';
import { signIn } from '../lib/session.mjs';

export const name = 'authenticated-user';
export const smoke = true;

/** The screens a signed-in person reaches from the shell. */
const SHELL = [
  ['documents', '/documents'],
  ['checks', '/checks'],
  ['certificates', '/certificates'],
  ['notifications', '/notifications'],
  ['balance', '/balance'],
  ['organizations', '/organizations'],
  ['profile', '/profile'],
  ['sessions', '/sessions'],
];

export async function run({ page, base, locale, findings, step, fixture }) {
  if (fixture === null) {
    await step('fixture', async () => ['no fixture file — this journey needs an account']);
    return;
  }

  await step('sign in through the form', async () => {
    await signIn(page, base, locale, { email: fixture.author.email, password: fixture.password });
    const problems = await inspect(page, findings);
    if (page.url().includes('/login'))
      problems.push('still on the sign-in page after submitting valid credentials');
    return problems;
  });

  for (const [label, path] of SHELL) {
    await page.goto(`${base}/${locale}${path}`, { waitUntil: 'networkidle' });
    await step(label, async () => {
      const problems = await inspect(page, findings);

      // Signed in, so nothing here may bounce to the sign-in page.
      if (page.url().includes('/login')) problems.push('redirected to sign-in while signed in');

      const text = await page.evaluate(() => document.body.innerText);
      if (text.trim().length < 20) problems.push('the screen rendered almost nothing');

      // A first-time account has no documents, no checks and no certificates.
      // Every one of these screens is therefore an *empty* state, and an empty
      // state that says nothing is indistinguishable from one that is broken.
      const hasHeading = (await page.getByRole('heading').count()) > 0;
      if (!hasHeading) problems.push('no heading — the screen does not say what it is');

      const overflow = await page.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
      );
      if (overflow > 2) problems.push(`horizontal overflow of ${overflow}px`);

      problems.push(
        ...blocking(await scan(page)).map(
          (v) => `a11y ${v.impact}: ${v.id} (${v.count}) — ${v.help}`,
        ),
      );
      return problems;
    });
  }

  // --- deep link, refresh, and back/forward through a real hydration -------
  await step('refresh keeps the session and the screen', async () => {
    await page.goto(`${base}/${locale}/documents`, { waitUntil: 'networkidle' });
    await page.reload({ waitUntil: 'networkidle' });
    const problems = await inspect(page, findings);
    if (page.url().includes('/login')) problems.push('a refresh signed the person out');
    return problems;
  });

  await step('back and forward', async () => {
    await page.goto(`${base}/${locale}/checks`, { waitUntil: 'networkidle' });
    await page.goBack({ waitUntil: 'networkidle' });
    await page.goForward({ waitUntil: 'networkidle' });
    const problems = await inspect(page, findings);
    if (!page.url().includes('/checks')) problems.push(`forward landed on ${page.url()}`);
    return problems;
  });

  // --- a route that does not exist ----------------------------------------
  await step('a URL that does not exist', async () => {
    const response = await page.goto(`${base}/${locale}/definitely-not-a-route`, {
      waitUntil: 'networkidle',
    });
    const problems = await inspect(page, findings);
    if (response.status() !== 404) problems.push(`expected 404, got ${response.status()}`);
    const text = await page.evaluate(() => document.body.innerText);
    if (text.trim().length < 10) problems.push('the not-found page is blank');
    return problems;
  });

  // --- signing out ---------------------------------------------------------
  await step('sign out', async () => {
    await page.goto(`${base}/${locale}/profile`, { waitUntil: 'networkidle' });
    const signOut = page
      .getByRole('button', { name: /sign out|log ?out|تسجيل الخروج|خروج/i })
      .first();
    const problems = await inspect(page, findings);
    if ((await signOut.count()) === 0) {
      problems.push('no sign-out control with an accessible name on the profile screen');
      return problems;
    }
    await signOut.click();
    await page.waitForTimeout(2500);
    // After signing out, a protected screen must not be reachable.
    await page.goto(`${base}/${locale}/documents`, { waitUntil: 'networkidle' });

    // Either answer is correct: bounced straight to sign-in, or a refusal page
    // that explains and offers the way back. PalCert does the second —
    // `/unauthorized` says "Please sign in / You need to sign in to view this
    // page" with a link — and the first version of this step only accepted the
    // first, so it reported a deliberate, well-written refusal as a leak. What
    // must not happen is the documents screen itself.
    const url = page.url();
    const refused = url.includes('/login') || url.includes('/unauthorized');
    if (!refused) {
      problems.push(`a protected screen was still reachable after signing out (${url})`);
    }
    if (url.includes('/unauthorized')) {
      const text = await page.evaluate(() => document.body.innerText);
      if (!/sign in|تسجيل الدخول/i.test(text)) {
        problems.push('the refusal page does not say what to do next');
      }
      if ((await page.getByRole('link').count()) === 0) {
        problems.push('the refusal page is a dead end — no link back');
      }
    }
    return problems;
  });
}
