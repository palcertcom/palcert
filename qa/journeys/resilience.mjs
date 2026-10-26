/**
 * What the application does when things go wrong (Phase 20 Checkpoint 8).
 *
 * The deliberate states: loading, empty, 401, 403, 404, 409, 429, 5xx and a
 * network that simply stops. None of them may produce an infinite spinner, a
 * blank screen or a stack trace — and the slow ones may not let an impatient
 * person cause the same business action twice.
 *
 * Failures are injected at the browser's network layer rather than by breaking
 * the server, so the deployment under test stays the deployment under test and
 * the other journeys can run beside this one.
 */
import { inspect } from '../lib/page-guard.mjs';
import { signIn } from '../lib/session.mjs';

export const name = 'error-and-slow-states';
export const smoke = false;

/** Make one API route answer with a given status, for this page only. */
async function stub(
  page,
  pattern,
  status,
  body = { error: { code: 'STUBBED', message: 'stubbed' } },
) {
  await page.route(pattern, (route) =>
    route.fulfill({
      status,
      contentType: 'application/json',
      body: JSON.stringify(body),
    }),
  );
}

export async function run({ page, base, locale, findings, step, fixture }) {
  if (fixture === null) {
    await step('fixture', async () => ['no fixture file — this journey needs an account']);
    return;
  }

  await step('sign in', async () => {
    await signIn(page, base, locale, { email: fixture.author.email, password: fixture.password });
    return inspect(page, findings);
  });

  // --- the server answers with each deliberate failure --------------------
  for (const [label, status] of [
    ['403 forbidden', 403],
    ['404 not found', 404],
    ['409 conflict', 409],
    ['429 too many requests', 429],
    ['500 server error', 500],
  ]) {
    await step(`documents list under ${label}`, async () => {
      await page.unrouteAll?.({ behavior: 'ignoreErrors' }).catch(() => {});
      await stub(page, '**/api/v1/documents**', status);
      await page.goto(`${base}/${locale}/documents`, { waitUntil: 'networkidle' });
      await page.waitForTimeout(1500);

      const problems = await inspect(page, findings);
      const text = await page.evaluate(() => document.body.innerText);

      if (text.trim().length < 15) problems.push('the screen is blank');
      // Something has to tell the person what happened.
      const explained = text.trim().length > 40;
      if (!explained) problems.push('no explanation of the failure');
      // And it must not be the machine contract.
      if (/\bSTUBBED\b|\b[A-Z][A-Z_]{7,}\b/.test(text)) {
        problems.push('a machine error code is shown to the user');
      }
      return problems;
    });
  }

  // --- the session expires underneath the person --------------------------
  await step('session expiry is handled, not ignored', async () => {
    await page.unrouteAll?.({ behavior: 'ignoreErrors' }).catch(() => {});
    await stub(page, '**/api/v1/**', 401, {
      error: { code: 'UNAUTHENTICATED', message: 'Session expired' },
    });
    await page.goto(`${base}/${locale}/documents`, { waitUntil: 'networkidle' });
    await page.waitForTimeout(2500);

    const problems = await inspect(page, findings);
    const text = await page.evaluate(() => document.body.innerText);
    const sentToLogin = page.url().includes('/login');
    const explained = /sign in|session|expired|تسجيل الدخول|انتهت|الجلسة/i.test(text);
    if (!sentToLogin && !explained) {
      problems.push('an expired session neither redirected to sign-in nor explained itself');
    }
    return problems;
  });

  // --- the network stops --------------------------------------------------
  await step('a network failure does not leave a spinner', async () => {
    await page.unrouteAll?.({ behavior: 'ignoreErrors' }).catch(() => {});
    await page.route('**/api/v1/**', (route) => route.abort('failed'));
    await page.goto(`${base}/${locale}/documents`, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(4000);

    const problems = await inspect(page, findings);
    const text = await page.evaluate(() => document.body.innerText);
    if (text.trim().length < 15) problems.push('the screen is blank after a network failure');
    // `inspect` already flags a visible busy indicator; this names the case.
    const stillBusy = await page.locator('[aria-busy="true"], [role="progressbar"]').count();
    if (stillBusy > 0)
      problems.push('a loading indicator is still showing after the request failed');
    return problems;
  });

  // --- a slow response must not admit two of the same action --------------
  await step('a slow submit cannot be sent twice', async () => {
    await page.unrouteAll?.({ behavior: 'ignoreErrors' }).catch(() => {});

    let attempts = 0;
    await page.route('**/api/v1/auth/login', async (route) => {
      attempts += 1;
      // Three seconds is long enough that a person concludes nothing happened
      // and clicks again, which is exactly the behaviour being tested.
      await new Promise((resolve) => setTimeout(resolve, 3000));
      await route.continue();
    });

    await page.goto(`${base}/${locale}/login`, { waitUntil: 'networkidle' });
    await page
      .getByLabel(/email|البريد/i)
      .first()
      .fill(fixture.author.email);
    await page
      .getByLabel(/password|كلمة المرور/i)
      .first()
      .fill(fixture.password);

    // The element handle is taken *before* the click and everything afterwards
    // goes through it, never through the role locator again.
    //
    // `SubmitButton` swaps its label while the request is in flight — "Sign in"
    // becomes "Please wait…" — so `getByRole('button', { name: /sign in/ })`
    // stops matching the moment the state under test begins. Re-querying by
    // name could therefore only ever observe a button that was *not* busy, and
    // the two impatient clicks below could only ever fail to land: a step that
    // reported both halves of its own subject as absent. The handle refers to
    // the same DOM node whatever it says on it.
    const submit = await page
      .getByRole('button', { name: /sign in|log in|تسجيل|دخول/i })
      .first()
      .elementHandle();
    if (submit === null) return ['no submit control on the sign-in form'];
    await submit.click();

    // While it is in flight the control must say so — disabled, busy, or
    // replaced by a progress state. A button that looks idle during a
    // three-second request is an invitation to click it again.
    //
    // Sampled repeatedly rather than once: React applies the busy state after
    // the click handler runs, and a single probe at a fixed delay races it.
    let guarded = false;
    for (let sample = 0; sample < 20 && !guarded; sample += 1) {
      guarded = await submit
        .evaluate(
          (node) =>
            node.disabled === true ||
            node.getAttribute('aria-disabled') === 'true' ||
            node.getAttribute('aria-busy') === 'true',
        )
        .catch(() => false);
      if (!guarded) await page.waitForTimeout(100);
    }

    const problems = await inspect(page, findings);

    // The page guard treats a visible busy indicator as a stuck loader, which
    // is right everywhere except here: this step stalls the request *on
    // purpose*, so a button correctly advertising `aria-busy` is the behaviour
    // under test rather than a symptom.
    const withoutExpectedBusyButton = problems.filter(
      (problem) => problem !== 'stuck-loader: BUTTON',
    );
    problems.length = 0;
    problems.push(...withoutExpectedBusyButton);

    // Click twice more regardless, which is what an impatient person does.
    // `force` because a disabled control is not actionable — and a disabled
    // control is the hoped-for outcome, so a click that Playwright politely
    // declines to make would prove nothing.
    await submit.click({ force: true, timeout: 2000 }).catch(() => {});
    await submit.click({ force: true, timeout: 2000 }).catch(() => {});
    await page.waitForTimeout(6000);

    if (!guarded) {
      problems.push(
        'the submit control gave no busy or disabled state while the request was in flight',
      );
    }
    if (attempts > 1) {
      problems.push(`the same action was sent ${attempts} times from repeated clicks`);
    }
    return problems;
  });
}
