/**
 * What a visitor with no account can do (Phase 20 Checkpoint 8).
 *
 * The most exposed surface PalCert has, and the one that must work in every
 * browser at every width: somebody handed a certificate and a link, checking
 * whether it is real.
 */
import { scan, blocking } from '../lib/accessibility.mjs';
import { inspect } from '../lib/page-guard.mjs';

/** Well-formed, resolves to nothing. */
const UNKNOWN_CODE = 'PC0000000000000000000000000000000D';

export const name = 'public-visitor';
export const smoke = true;

export async function run({ page, base, locale, findings, step }) {
  // --- the landing page ----------------------------------------------------
  await page.goto(`${base}/${locale}`, { waitUntil: 'networkidle' });
  await step('landing', async () => {
    const problems = await inspect(page, findings);
    const direction = await page.evaluate(() => document.documentElement.dir);
    const expected = locale === 'ar' ? 'rtl' : 'ltr';
    if (direction !== expected) {
      problems.push(`text direction is "${direction}", expected "${expected}"`);
    }
    const language = await page.evaluate(() => document.documentElement.lang);
    if (!language.startsWith(locale)) {
      // Without a correct `lang`, a screen reader pronounces Arabic as English.
      problems.push(`document language is "${language}", expected "${locale}"`);
    }
    // Nothing should overflow the viewport sideways at any width; a horizontal
    // scrollbar on a phone is how a layout announces it was never tried there.
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

  // --- verifying a certificate that does not exist -------------------------
  await page.goto(`${base}/${locale}/verify/${UNKNOWN_CODE}`, { waitUntil: 'networkidle' });
  await step('unknown certificate', async () => {
    const problems = await inspect(page, findings);
    const text = await page.evaluate(() => document.body.innerText);
    if (text.trim().length === 0) problems.push('the page rendered nothing at all');
    // An unknown code must produce a *deliberate* answer. A blank page, a
    // spinner or an error code shown raw are all failures of the same kind:
    // the visitor cannot tell what happened.
    if (/CERTIFICATE_NOT_FOUND|VALIDATION_FAILED|\b[A-Z_]{8,}\b/.test(text)) {
      problems.push('a machine error code is shown to the visitor');
    }
    problems.push(
      ...blocking(await scan(page)).map(
        (v) => `a11y ${v.impact}: ${v.id} (${v.count}) — ${v.help}`,
      ),
    );
    return problems;
  });

  // --- the sign-in page ----------------------------------------------------
  await page.goto(`${base}/${locale}/login`, { waitUntil: 'networkidle' });
  await step('sign-in form', async () => {
    const problems = await inspect(page, findings);
    // Found by accessible name, because that is how anyone not using a mouse
    // finds them.
    for (const [label, pattern] of [
      ['email', /email|البريد/i],
      ['password', /password|كلمة المرور/i],
    ]) {
      const count = await page.getByLabel(pattern).count();
      if (count === 0) problems.push(`no field with an accessible name matching ${label}`);
    }
    const submit = await page.getByRole('button', { name: /sign in|log in|تسجيل|دخول/i }).count();
    if (submit === 0) problems.push('no submit button with an accessible name');
    problems.push(
      ...blocking(await scan(page)).map(
        (v) => `a11y ${v.impact}: ${v.id} (${v.count}) — ${v.help}`,
      ),
    );
    return problems;
  });

  // --- blank submit --------------------------------------------------------
  await step('sign-in with nothing filled in', async () => {
    await page
      .getByRole('button', { name: /sign in|log in|تسجيل|دخول/i })
      .first()
      .click();
    await page.waitForTimeout(1500);
    const problems = await inspect(page, findings);
    const text = await page.evaluate(() => document.body.innerText);
    // Something has to say what is wrong. Silence on a blank submit is the
    // commonest way a form becomes unusable for somebody who cannot see that
    // the field outline turned red.
    const validationShown =
      (await page.locator('[aria-invalid="true"], [role="alert"]').count()) > 0 ||
      /required|enter|invalid|مطلوب|أدخل|غير صالح/i.test(text);
    if (!validationShown)
      problems.push('a blank submit produced no visible or announced validation');
    return problems;
  });

  // --- a sign-in that fails -----------------------------------------------
  //
  // Which failure arrives depends on how many attempts this address has
  // already made, and across a 24-cell matrix that is not something a single
  // step controls: sign-in is throttled per IP, deliberately, because it is
  // the brute-force guard on credentials. The first version of this step
  // asserted only the wrong-password wording, and duly failed on the later
  // matrix cells — against an application that was behaving perfectly and
  // showing a correctly translated "too many attempts, please wait" message.
  //
  // So it detects which state it is in and asserts what is right for that
  // one. Both are states this checkpoint requires to be deliberate, and
  // between them the matrix exercises the wrong-credentials path and the 429
  // path without either depending on the other.
  await step('a sign-in that fails explains itself', async () => {
    await page
      .getByLabel(/email|البريد/i)
      .first()
      .fill('nobody-here@example.com');
    await page
      .getByLabel(/password|كلمة المرور/i)
      .first()
      .fill('definitely-not-the-password');
    await page
      .getByRole('button', { name: /sign in|log in|تسجيل|دخول/i })
      .first()
      .click();
    await page.waitForTimeout(2500);

    const problems = await inspect(page, findings);
    const text = await page.evaluate(() => document.body.innerText);
    const throttled = /too many|wait a|try again later|محاولات كثيرة|انتظر/i.test(text);
    const rejected = /incorrect|invalid|could not|try again|خطأ|غير صحيح|تعذر/i.test(text);

    if (!throttled && !rejected) {
      problems.push('a failed sign-in showed no human-readable explanation');
    }
    if (throttled && !/wait|later|انتظر|لاحقًا|قليلا|قليلاً/i.test(text)) {
      problems.push('the rate-limit message does not say what to do next');
    }
    // Neither answer may distinguish "no such account" from "wrong password".
    if (/no account|not registered|unknown user|does not exist|لا يوجد حساب/i.test(text)) {
      problems.push('the failure message reveals whether the account exists');
    }
    // And neither may be a machine code.
    if (/\b(RATE_LIMITED|AUTH_[A-Z_]+|VALIDATION_FAILED)\b/.test(text)) {
      problems.push('a machine error code is shown instead of a message');
    }
    // The announcement matters as much as the text: a message a sighted user
    // sees and a screen-reader user does not is half a message.
    if (
      (throttled || rejected) &&
      (await page.locator('[role="alert"], [aria-live]').count()) === 0
    ) {
      problems.push('the failure message is not announced to assistive technology');
    }
    return problems;
  });
}
