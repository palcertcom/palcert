/**
 * What an organization administrator does (Phase 20 Checkpoint 8).
 *
 * Two screens carry most of the risk here, and both are about secrets:
 *
 * **API clients.** The client secret is shown exactly once, at creation, and
 * can never be retrieved again. If that is not unmistakable, somebody
 * dismisses the dialog and loses the credential — and the only remedy is to
 * rotate, which they then have to discover. So the test is not "does the
 * secret appear" but "is it obvious that this is the only time it will".
 *
 * **Webhooks.** Signing material must never be rendered, and neither must the
 * internals of the SSRF defence — "connection refused to 169.254.169.254"
 * tells an attacker what was tried and what the boundary is.
 */
import { scan, blocking } from '../lib/accessibility.mjs';
import { inspect } from '../lib/page-guard.mjs';
import { signIn } from '../lib/session.mjs';

export const name = 'organization-admin';
export const smoke = false;

export async function run({ page, base, locale, findings, step, fixture }) {
  if (fixture === null) {
    await step('fixture', async () => ['no fixture file — this journey needs an organization']);
    return;
  }

  const organizationId = fixture.registrar.organizationId;

  await step('sign in as the organization owner', async () => {
    await signIn(page, base, locale, {
      email: fixture.registrar.email,
      password: fixture.password,
    });
    return inspect(page, findings);
  });

  await page.goto(`${base}/${locale}/organizations/${organizationId}`, {
    waitUntil: 'networkidle',
  });
  await step('organization overview', async () => {
    const problems = await inspect(page, findings);
    const text = await page.evaluate(() => document.body.innerText);
    if (!text.includes('QA University'))
      problems.push('the organization name is not on its own page');
    problems.push(
      ...blocking(await scan(page)).map(
        (v) => `a11y ${v.impact}: ${v.id} (${v.count}) — ${v.help}`,
      ),
    );
    return problems;
  });

  // --- API clients ---------------------------------------------------------
  await page.goto(`${base}/${locale}/organizations/${organizationId}/api-clients`, {
    waitUntil: 'networkidle',
  });
  await step('API clients screen', async () => {
    const problems = await inspect(page, findings);
    const heading = await page.getByRole('heading').count();
    if (heading === 0) problems.push('no heading on the API clients screen');
    problems.push(
      ...blocking(await scan(page)).map(
        (v) => `a11y ${v.impact}: ${v.id} (${v.count}) — ${v.help}`,
      ),
    );
    return problems;
  });

  await step('the one-time secret is unmistakable', async () => {
    const problems = await inspect(page, findings);
    const create = page.getByRole('button', { name: /create|new|add|إنشاء|جديد|إضافة/i }).first();
    if ((await create.count()) === 0) {
      problems.push('no control to create an API client');
      return problems;
    }
    await create.click();
    await page.waitForTimeout(1200);

    // The create form may be inline or a dialog — PalCert's is inline, which
    // is a legitimate choice and has no focus-trap problem by construction.
    // The first version of this step *required* a dialog and reported a
    // perfectly good inline form as a defect. What is required is that if it
    // is a dialog, it behaves like one.
    const dialog = page.getByRole('dialog').first();
    if ((await dialog.count()) > 0) {
      const label = await dialog.evaluate(
        (node) =>
          (node.getAttribute('aria-label') ?? '') +
          (node.getAttribute('aria-labelledby') === null ? '' : ' labelledby'),
      );
      if (label.trim().length === 0) problems.push('the dialog has no accessible name');
      // Focus must be inside the dialog once it opens.
      const focusInside = await page.evaluate(() => {
        const open = document.querySelector('[role="dialog"]');
        return open !== null && open.contains(document.activeElement);
      });
      if (!focusInside) problems.push('opening the dialog did not move focus into it');
    }

    // The warning has to arrive *before* the secret does. Telling somebody
    // afterwards that they had one chance is not a warning.
    const beforeText = await page.evaluate(() => document.body.innerText);
    if (!/once|only time|cannot show it again|save it|مرة واحدة|لن|احفظ/i.test(beforeText)) {
      problems.push('the form does not warn that the secret is shown only once, before showing it');
    }

    // The client's label: by a "name" label if there is one, otherwise the
    // form's first text field, so the journey really creates a client.
    const labelled = page.getByLabel(/name|اسم/i).first();
    const nameField =
      (await labelled.count()) > 0
        ? labelled
        : page.locator('form input[type="text"], form input:not([type])').first();
    if ((await nameField.count()) > 0) await nameField.fill('QA browser client');

    // Scope selection, whatever shape it takes.
    const scopeBox = page.getByRole('checkbox').first();
    if ((await scopeBox.count()) > 0) await scopeBox.check().catch(() => {});

    const submit = page
      .getByRole('button', { name: /create|save|confirm|إنشاء|حفظ|تأكيد/i })
      .last();
    await submit.click();
    await page.waitForTimeout(3000);

    // A client ID (`pcid_` + 32 hex) is public by design and listed on every
    // row, so it is not evidence that a secret is on screen.
    const text = (await page.evaluate(() => document.body.innerText)).replace(
      /\bpcid_[0-9a-f]{32}\b/g,
      '',
    );
    // The secret itself.
    const secretShown = /\bpc_[A-Za-z0-9_-]{16,}|[A-Za-z0-9_-]{32,}/.test(text);
    const warned =
      /only time|once|won'?t be shown|cannot be retrieved|copy it now|لن (يتم|تتمكن)|مرة واحدة|انسخ/i.test(
        text,
      );
    if (secretShown && !warned) {
      problems.push('the client secret is shown with no warning that this is the only time');
    }
    if (!secretShown && !warned) {
      problems.push(
        'no secret and no explanation after creating a client — the outcome is unclear',
      );
    }

    const copy = await page.getByRole('button', { name: /copy|نسخ/i }).count();
    if (secretShown && copy === 0) {
      problems.push('a one-time secret is shown with no copy control');
    }

    problems.push(
      ...blocking(await scan(page)).map(
        (v) => `a11y ${v.impact}: ${v.id} (${v.count}) — ${v.help}`,
      ),
    );

    // Clean up the way an administrator would: revoke the clients this
    // journey made, so repeated runs stay under the per-organization limit.
    const revoke = page
      .locator('[data-testid^="client-"]', { hasText: 'QA browser client' })
      .getByRole('button', { name: /revoke|إبطال/i });
    for (let attempt = 0; attempt < 5 && (await revoke.count()) > 0; attempt += 1) {
      page.once('dialog', (dialog) => void dialog.accept());
      await revoke.first().click();
      await page.waitForTimeout(1500);
    }
    return problems;
  });

  await step('the secret cannot be retrieved again', async () => {
    const problems = await inspect(page, findings);
    const dismiss = page.getByRole('button', { name: /done|close|dismiss|ok|تم|إغلاق/i }).first();
    if ((await dismiss.count()) > 0) {
      await dismiss.click();
      await page.waitForTimeout(1200);
    }
    // Reload the list. The secret must be gone for good.
    await page.reload({ waitUntil: 'networkidle' });
    const text = await page.evaluate(() => document.body.innerText);
    if (/\bpc_[A-Za-z0-9_-]{16,}/.test(text)) {
      problems.push('a client secret is still visible after reloading the list');
    }
    return problems;
  });

  // --- webhooks ------------------------------------------------------------
  for (const path of [
    `/organizations/${organizationId}/webhooks`,
    `/organizations/${organizationId}`,
  ]) {
    const response = await page.goto(`${base}/${locale}${path}`, { waitUntil: 'networkidle' });
    if (response.status() === 404) continue;
    if (!path.endsWith('/webhooks')) break;

    await step('webhooks screen', async () => {
      const problems = await inspect(page, findings);
      const text = await page.evaluate(() => document.body.innerText);
      // Signing material must never be rendered.
      if (/whsec_|signing secret[:\s]+[A-Za-z0-9]{8,}/i.test(text)) {
        problems.push('webhook signing material is rendered on screen');
      }
      // Nor the internals of the SSRF defence.
      if (/169\.254\.169\.254|ECONNREFUSED|EAI_AGAIN|private address|RFC1918/i.test(text)) {
        problems.push('SSRF internals are exposed in the UI');
      }
      problems.push(
        ...blocking(await scan(page)).map(
          (v) => `a11y ${v.impact}: ${v.id} (${v.count}) — ${v.help}`,
        ),
      );
      return problems;
    });
    break;
  }
}
