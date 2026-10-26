/**
 * Negative control for "a slow submit cannot be sent twice".
 *
 * The step passes because the submit button disables itself while the request
 * is in flight, and a disabled button swallows clicks. That makes the passing
 * result indistinguishable from a counter that never counts — so this removes
 * the product's guard, in the browser only, and repeats the identical clicks.
 * If the counter is live, it must now report more than one attempt.
 */
import { readFileSync } from 'node:fs';
import { chromium } from 'playwright';

const BASE = 'https://localhost:8543';
const fixture = JSON.parse(readFileSync('qa/.fixture.json', 'utf8'));
const browser = await chromium.launch({
  executablePath: process.env.CHROME_PATH,
  args: ['--ignore-certificate-errors'],
});
const page = await browser.newPage({ ignoreHTTPSErrors: true });

let attempts = 0;
await page.route('**/api/v1/auth/login', async (route) => {
  attempts += 1;
  await new Promise((r) => setTimeout(r, 3000));
  await route.continue();
});

await page.goto(`${BASE}/en/login`, { waitUntil: 'networkidle' });
// Strip the guard: whatever React sets, clear it again.
await page.evaluate(() => {
  const button = document.querySelector('button[type="submit"]');
  new MutationObserver(() => {
    button.disabled = false;
    button.removeAttribute('aria-busy');
  }).observe(button, { attributes: true });
});
await page.getByLabel(/email/i).first().fill(fixture.author.email);
await page
  .getByLabel(/password/i)
  .first()
  .fill(fixture.password);

const submit = await page
  .getByRole('button', { name: /sign in/i })
  .first()
  .elementHandle();
await submit.click();
await page.waitForTimeout(300);
await submit.click({ force: true, timeout: 2000 }).catch(() => {});
await submit.click({ force: true, timeout: 2000 }).catch(() => {});
await page.waitForTimeout(6000);

console.log(`negative control: login was sent ${attempts} time(s) with the guard removed`);
console.log(attempts > 1 ? 'DETECTOR IS LIVE' : 'DETECTOR IS VACUOUS');
await browser.close();
