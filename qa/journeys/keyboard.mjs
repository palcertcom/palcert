/**
 * Keyboard and focus — the half a scanner cannot see (Phase 20 Checkpoint 8).
 *
 * axe-core finds a missing label. It cannot find a dialog that leaves focus
 * behind it, a tab sequence that escapes into the page underneath, or a
 * control that only a mouse can reach. Those are the failures that make an
 * application unusable rather than merely imperfect, and they are checked
 * here by actually pressing keys.
 *
 * The rule this enforces: **every critical action must be operable without a
 * mouse.**
 */
import { inspect } from '../lib/page-guard.mjs';
import { settle } from '../lib/session.mjs';

export const name = 'keyboard-and-focus';
export const smoke = true;

/** Walk the tab sequence and describe where focus went. */
async function tabThrough(page, presses) {
  const seen = [];
  for (let index = 0; index < presses; index += 1) {
    await page.keyboard.press('Tab');
    seen.push(
      await page.evaluate(() => {
        const element = document.activeElement;
        if (element === null || element === document.body) return 'body';
        const name =
          element.getAttribute('aria-label') ??
          element.textContent?.trim().slice(0, 40) ??
          element.getAttribute('name') ??
          '';
        return `${element.tagName.toLowerCase()}${name === '' ? '' : `:${name}`}`;
      }),
    );
  }
  return seen;
}

export async function run({ page, base, locale, findings, step, fixture }) {
  // --- the sign-in form, entirely from the keyboard -----------------------
  await page.goto(`${base}/${locale}/login`, { waitUntil: 'networkidle' });

  await step('every control on sign-in is reachable by Tab', async () => {
    const problems = await inspect(page, findings);
    const stops = await tabThrough(page, 12);
    // The two fields and the submit control must all appear in the sequence.
    const sequence = stops.join(' | ').toLowerCase();
    if (!sequence.includes('input')) problems.push('no input reached by tabbing');
    if (!sequence.includes('button')) problems.push('no button reached by tabbing');
    // Focus must be visible. An invisible focus ring is a keyboard user
    // navigating blind, and it is a WCAG 2.2 AA requirement in its own right.
    const visible = await page.evaluate(() => {
      const element = document.activeElement;
      if (element === null || element === document.body) return true;
      const style = getComputedStyle(element);
      const ring =
        style.outlineStyle !== 'none' && style.outlineWidth !== '0px'
          ? true
          : style.boxShadow !== 'none';
      return ring;
    });
    if (!visible) problems.push('the focused control shows no visible focus indicator');
    return problems;
  });

  await step('sign-in can be completed with the keyboard alone', async () => {
    const problems = await inspect(page, findings);
    if (fixture === null) {
      problems.push('no fixture file — cannot complete a real sign-in');
      return problems;
    }
    await page
      .getByLabel(/email|البريد/i)
      .first()
      .focus();
    await page.keyboard.type(fixture.author.email);
    await page.keyboard.press('Tab');
    await page.keyboard.type(fixture.password);
    // Enter from within the form, not a click.
    await page.keyboard.press('Enter');
    await page
      .waitForURL((url) => !url.pathname.endsWith('/login'), { timeout: 30_000 })
      .catch(() => {});
    if (page.url().includes('/login')) {
      problems.push('pressing Enter in the form did not submit it');
    }
    // Let the landing page finish arriving, for the same reason `signIn` does.
    await settle(page);
    return problems;
  });

  // --- skipping to the content --------------------------------------------
  await step('there is a way past the navigation', async () => {
    await page.goto(`${base}/${locale}/documents`, { waitUntil: 'networkidle' });
    const problems = await inspect(page, findings);
    await page.keyboard.press('Tab');
    const first = await page.evaluate(() =>
      (document.activeElement?.textContent ?? '').trim().toLowerCase(),
    );
    const hasSkip = /skip|main content|تخطي|المحتوى/i.test(first);
    const landmarks = await page.evaluate(() => ({
      main: document.querySelectorAll('main, [role="main"]').length,
      nav: document.querySelectorAll('nav, [role="navigation"]').length,
    }));
    // Either a skip link, or landmarks a screen reader can jump between. One
    // of the two is required; neither is a real barrier on every page load.
    if (!hasSkip && landmarks.main === 0) {
      problems.push(
        'no skip link and no main landmark — the navigation must be tabbed through every time',
      );
    }
    return problems;
  });

  // --- a dialog, if the product has one -----------------------------------
  //
  // As of v1 PalCert has none: no `role="dialog"`, no `aria-modal`, no
  // `showModal` anywhere in `apps/web/src`. Every create and confirm surface
  // is an inline form on the page it belongs to.
  //
  // That makes this step's subject absent, and an absent subject is how an
  // accessibility check passes without checking anything. So when there is no
  // dialog the step says so in its own name rather than reporting a silent
  // clean pass — the matrix log then reads "no dialog on this screen", which
  // is a fact a reader can act on, and the moment a dialog is introduced the
  // step becomes live on its own.
  const dialogPresent = await (async () => {
    if (fixture === null) return false;
    await page.goto(`${base}/${locale}/documents`, { waitUntil: 'networkidle' });
    const opener = page
      .getByRole('button', { name: /upload|new|add|create|رفع|جديد|إضافة|إنشاء/i })
      .first();
    if ((await opener.count()) === 0) return false;
    await opener.focus();
    await page.keyboard.press('Enter');
    await page.waitForTimeout(1200);
    return (await page.getByRole('dialog').count()) > 0;
  })();

  const dialogStep = dialogPresent
    ? 'a dialog takes focus, keeps it, names itself and gives it back'
    : 'a dialog takes focus… — NOT APPLICABLE: PalCert v1 has no modal dialogs';

  await step(dialogStep, async () => {
    const problems = await inspect(page, findings);
    if (!dialogPresent) return problems;

    await page.goto(`${base}/${locale}/documents`, { waitUntil: 'networkidle' });
    const opener = page
      .getByRole('button', { name: /upload|new|add|create|رفع|جديد|إضافة|إنشاء/i })
      .first();
    if ((await opener.count()) === 0) {
      // Not every screen has a dialog; that is not a failure.
      return problems;
    }

    // Opened from the keyboard, because that is the case that breaks.
    await opener.focus();
    await page.keyboard.press('Enter');
    await page.waitForTimeout(1200);

    const dialog = page.getByRole('dialog').first();
    if ((await dialog.count()) === 0) return problems;

    const named = await dialog.evaluate(
      (node) =>
        (node.getAttribute('aria-label') ?? '').trim().length > 0 ||
        node.getAttribute('aria-labelledby') !== null,
    );
    if (!named) problems.push('the dialog has no accessible name');

    const focusMoved = await page.evaluate(() => {
      const open = document.querySelector('[role="dialog"]');
      return open !== null && open.contains(document.activeElement);
    });
    if (!focusMoved) problems.push('opening the dialog did not move focus into it');

    // Tab far enough that an untrapped sequence would have escaped.
    let escaped = false;
    for (let index = 0; index < 20; index += 1) {
      await page.keyboard.press('Tab');
      const inside = await page.evaluate(() => {
        const open = document.querySelector('[role="dialog"]');
        return open === null || open.contains(document.activeElement);
      });
      if (!inside) {
        escaped = true;
        break;
      }
    }
    if (escaped) problems.push('the tab sequence escapes the dialog into the page behind it');

    // Escape must close it, and focus must come back somewhere sensible.
    await page.keyboard.press('Escape');
    await page.waitForTimeout(800);
    const stillOpen = (await page.getByRole('dialog').count()) > 0;
    if (stillOpen) {
      problems.push('Escape did not close the dialog');
    } else {
      const returned = await page.evaluate(
        () => document.activeElement !== null && document.activeElement !== document.body,
      );
      if (!returned) problems.push('focus was left on the document body after the dialog closed');
    }
    return problems;
  });

  // --- the critical actions, each reached and fired from the keyboard ------
  //
  // "Operable without a mouse" is not satisfied by a control that merely has a
  // tab stop. It has to be *reachable* by tabbing from the top of the page and
  // it has to *do something* when Enter is pressed on it. Both halves are
  // checked here, on the real screens, with no `click()` anywhere in the step.
  //
  // Two corrections were needed before this measured the product rather than
  // the harness, and both are the same mistake in different clothes — assuming
  // what the interface is made of:
  //
  //  - the create-document button is `disabled` until a name is typed, which
  //    is correct and means it has no tab stop. Tabbing to it before filling
  //    the form can only fail. The step types the name from the keyboard
  //    first, which is the actual journey anyway;
  //  - "start a check" is a link to `/checks/new`, not a button, because
  //    navigating is what a link is for. `getByRole('button')` could only ever
  //    report it missing. The step now accepts either.
  for (const action of [
    {
      what: 'create a document',
      path: '/documents',
      field: '#new-document-name',
      type: 'Keyboard QA document',
      name: /create|add|new|إنشاء|إضافة|جديد/i,
    },
    // Named exactly. `/check/` also matched the sidebar's "Checks" link once
    // the application shell gave every page a navigation — and pressing Enter
    // on a link to the page already open changes nothing, so the step
    // reported a dead control that was really the harness choosing the
    // wrong one.
    { what: 'start a check', path: '/checks', name: /new check|start a check|فحص جديد|بدء فحص/i },
    { what: 'sign out', path: '/profile', name: /sign out|log out|تسجيل الخروج|خروج/i },
  ]) {
    await step(`${action.what} is reachable and firable from the keyboard alone`, async () => {
      if (fixture === null) return [];
      await page.goto(`${base}/${locale}${action.path}`, { waitUntil: 'networkidle' });
      const problems = await inspect(page, findings);

      // A required field is filled from the keyboard, because a control that
      // is correctly disabled until the form is valid is not a defect.
      if (action.field !== undefined) {
        const input = page.locator(action.field).first();
        if ((await input.count()) === 0)
          return [...problems, `no ${action.field} on ${action.path}`];
        await input.focus();
        await page.keyboard.type(action.type);
      }

      // Either a button or a link: navigating is a link's job, and refusing to
      // accept one would be measuring the harness's assumptions.
      const target = page
        .getByRole('button', { name: action.name })
        .or(page.getByRole('link', { name: action.name }))
        .first();
      if ((await target.count()) === 0) {
        return [...problems, `no "${action.what}" control on ${action.path} — nothing to operate`];
      }

      // Reachable: tab from the top of the document until focus lands on it.
      await page.evaluate(() => {
        document.activeElement?.blur?.();
        window.scrollTo(0, 0);
      });
      if (action.field !== undefined) await page.locator(action.field).first().focus();

      let reached = false;
      for (let press = 0; press < 60 && !reached; press += 1) {
        await page.keyboard.press('Tab');
        reached = await target
          .evaluate((node) => node === document.activeElement)
          .catch(() => false);
      }
      if (!reached) {
        return [...problems, `"${action.what}" cannot be reached by tabbing — it needs a mouse`];
      }

      // Firable: Enter on the focused control must change something.
      const before = await page.evaluate(() => document.body.innerHTML.length);
      const wasAt = page.url();
      await page.keyboard.press('Enter');
      await page.waitForTimeout(2000);
      const after = await page.evaluate(() => document.body.innerHTML.length);

      if (before === after && page.url() === wasAt) {
        problems.push(`pressing Enter on "${action.what}" did nothing`);
      }
      return problems;
    });
  }
}
