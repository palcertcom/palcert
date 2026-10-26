/**
 * Wait until the page that was just landed on has finished asking for its own
 * data (Phase 20 Checkpoint 8).
 *
 * `networkidle` is not enough. The landing page's first request is issued by a
 * React effect *after* hydration, so idleness is reached, then broken again a
 * moment later. A caller that navigates away in that gap cancels a request in
 * flight, and WebKit reports a fetch its own navigation cancelled as an
 * uncaught page error — "…/api/v1/users/me due to access control checks." —
 * which the page guard, correctly, refuses to ignore. Chromium and Firefox
 * report the same cancellation quietly; the profile screen was reproducibly
 * the victim, in seven of eight WebKit cells.
 *
 * Nothing is suppressed: the rule still fails the run on any uncaught error.
 * The harness stops creating one, by doing what a person does — letting a
 * screen finish arriving before leaving it.
 */
export async function settle(page) {
  await page.waitForLoadState('networkidle').catch(() => {});
  await page
    .waitForResponse((response) => response.url().includes('/api/v1/'), { timeout: 4_000 })
    .catch(() => {});
  await page.waitForLoadState('networkidle').catch(() => {});
}

/**
 * Signing a browser in, the way a person does (Phase 20 Checkpoint 8).
 *
 * Through the login form, not by injecting a cookie. A journey that starts
 * from a planted session proves nothing about whether anyone can get one, and
 * the login form is itself one of the critical journeys.
 */
export async function signIn(page, base, locale, { email, password }) {
  // Already signed in **as this person** in this browser context? Then don't
  // do it again.
  //
  // Journeys share one context per matrix cell and three of the five sign in
  // as the same account, so the login form was submitted four times a cell —
  // close to a hundred sign-ins from one address inside an hour, against a
  // per-IP limit of fifty. Cells from the tenth onward failed on "too many
  // attempts" and the matrix reported the resulting empty screens as product
  // defects.
  //
  // "As this person" is the whole of it. A first version skipped whenever the
  // context held *any* session cookie, so the organization journey inherited
  // the author's session and browsed an organization it does not belong to —
  // which looks exactly like the defect the journey is meant to catch. The
  // identity is read back from PalCert rather than assumed.
  //
  // The form is still exercised once per identity per context, in every cell,
  // both locales, all three engines; and the throttle is still exercised on
  // purpose by the public-visitor journey's failed sign-in.
  const current = await page.request
    .get(`${base}/api/v1/auth/me`)
    .then((response) => (response.ok() ? response.json() : null))
    .catch(() => null);
  if (current !== null && current.email?.toLowerCase() === email.toLowerCase()) return;
  if (current !== null) {
    // Someone else is signed in here. Leave properly rather than layering one
    // session on another.
    //
    // The session cookie goes; the CSRF cookie stays. Clearing everything
    // instead took the CSRF token with it, and the next sign-in was refused
    // with "Please check the information you entered." — PalCert's wording for
    // a request that did not validate, which reads exactly like a wrong
    // password and is nothing of the kind. Logging out is what removes a
    // session; throwing away the whole cookie jar is not.
    const cookies = await page.context().cookies(base);
    const csrf = cookies.find((cookie) => cookie.name === 'palcert_csrf')?.value ?? '';
    await page.request.post(`${base}/api/v1/auth/logout`, {
      headers: { Origin: base, 'x-csrf-token': csrf },
      failOnStatusCode: false,
    });
  }

  // Two attempts, and only for one reason.
  //
  // A sign-in that does not land is otherwise reported as
  // "waitForURL: Timeout 30000ms exceeded", which says nothing about why — and
  // in this checkpoint the why was always the same: the matrix compressing a
  // population's worth of sign-ins into one address and two accounts, and
  // meeting the throttle it had filled itself. So the failure is read off the
  // screen rather than guessed at: if PalCert says "too many attempts", the
  // counter-clearing sidecar is given a sweep and the form is submitted once
  // more. Anything else is reported with the message PalCert actually showed,
  // which is what a person would have to go on.
  for (let attempt = 0; attempt < 2; attempt += 1) {
    await page.goto(`${base}/${locale}/login`, { waitUntil: 'domcontentloaded' });

    // By label, not by CSS. If a field cannot be found by its accessible name,
    // that is itself the finding — a screen reader cannot find it either.
    const emailField = page.getByLabel(/email|البريد/i).first();
    const passwordField = page.getByLabel(/password|كلمة المرور/i).first();
    await emailField.waitFor({ state: 'visible', timeout: 20_000 });
    await emailField.fill(email);
    await passwordField.fill(password);

    // Read the fields back before submitting.
    //
    // Added when intermittent "Please check the information you entered."
    // failures were believed to be a `fill` racing React's renders. They were
    // not: the product lost text typed before hydration (Checkpoint 20.8,
    // Q-007), and this read-back could not see it, because it reads the DOM —
    // which was correct. It is kept because it is cheap and cannot mask that
    // defect (a regression would still post empty strings and still fail the
    // step), but the real guard is `qa/release-checks.mjs` §5 and
    // `field-hydration.spec.tsx`.
    for (let retype = 0; retype < 3; retype += 1) {
      const [typedEmail, typedPassword] = await Promise.all([
        emailField.inputValue(),
        passwordField.inputValue(),
      ]);
      if (typedEmail === email && typedPassword === password) break;
      await emailField.fill('');
      await emailField.pressSequentially(email, { delay: 10 });
      await passwordField.fill('');
      await passwordField.pressSequentially(password, { delay: 10 });
    }

    const submit = page.getByRole('button', { name: /sign in|log in|تسجيل الدخول|دخول/i }).first();
    await submit.click();

    // Landing somewhere that is not the login page is the signal; which page it
    // is belongs to the journey, not to this helper.
    const landed = await page
      .waitForURL((url) => !url.pathname.endsWith('/login'), { timeout: 25_000 })
      .then(() => true)
      .catch(() => false);

    if (landed) {
      await settle(page);
      return;
    }

    const said = await page
      .evaluate(() =>
        Array.from(document.querySelectorAll('[role="alert"], .pc-error'))
          .map((node) => node.textContent?.trim() ?? '')
          .join(' ')
          .slice(0, 160),
      )
      .catch(() => '');

    const throttled = /too many|later|محاولات|لاحق/i.test(said);
    if (!throttled || attempt === 1) {
      throw new Error(
        `sign-in as ${email} did not land${said === '' ? ' and the screen said nothing' : `: ${said}`}`,
      );
    }
    await page.waitForTimeout(25_000);
  }
}
