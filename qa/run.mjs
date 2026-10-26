#!/usr/bin/env node
/**
 * The browser and accessibility QA runner (Phase 20 Checkpoint 8).
 *
 *   BASE=https://localhost:8543 node qa/run.mjs
 *   BASE=… BROWSERS=chromium VIEWPORTS=laptop node qa/run.mjs --smoke
 *
 * Drives the production images behind the production proxy. Each journey is a
 * module in `qa/journeys/`; each runs once per engine × locale × viewport,
 * and every step is checked against the page guard as well as against whatever
 * the step itself asserts.
 */
import { readFileSync } from 'node:fs';
import {
  ENGINES,
  LOCALES,
  VIEWPORTS,
  selectedEngines,
  selectedLocales,
  selectedViewports,
} from './lib/browsers.mjs';
import { Results } from './lib/report.mjs';
import { watchPage } from './lib/page-guard.mjs';

const BASE = process.env.BASE ?? 'https://localhost:8543';
const SMOKE = process.argv.includes('--smoke');

const journeyModules = (
  process.env.JOURNEYS ?? 'public,authenticated,organization,keyboard,resilience'
)
  .split(',')
  .map((entry) => entry.trim())
  .filter((entry) => entry.length > 0);

const journeys = [];
for (const moduleName of journeyModules) {
  try {
    const loaded = await import(`./journeys/${moduleName}.mjs`);
    if (SMOKE && loaded.smoke !== true) continue;
    journeys.push(loaded);
  } catch (error) {
    if (error.code !== 'ERR_MODULE_NOT_FOUND') throw error;
    console.log(`qa: no journey module "${moduleName}" — skipping`);
  }
}

if (journeys.length === 0) {
  console.error('qa: no journeys selected — refusing to report a clean run of nothing');
  process.exit(64);
}

let fixture = null;
try {
  fixture = JSON.parse(readFileSync(process.env.FIXTURE ?? 'qa/.fixture.json', 'utf8'));
} catch {
  console.log('qa: no fixture file; journeys that need an account will skip and say so');
}

const engines = selectedEngines();
const locales = selectedLocales();
// The smoke runs one width. Both locales stay: a raw translation key or an
// RTL break is exactly the kind of regression a per-commit check should
// catch, and it costs one more pass of the same pages.
const viewports = SMOKE ? ['laptop'] : selectedViewports();

console.log(
  `qa: base=${BASE} engines=${engines.join(',')} locales=${locales.join(',')} ` +
    `viewports=${viewports.join(',')} journeys=${journeys.map((j) => j.name).join(',')}` +
    (SMOKE ? ' (smoke)' : ''),
);

const results = new Results();

for (const engineName of engines) {
  const engine = ENGINES[engineName];
  let browser;
  try {
    browser = await engine.type.launch(engine.launch);
  } catch (error) {
    // An engine that will not start is reported, never silently dropped —
    // "the matrix passed" must not be able to mean "the matrix was chromium".
    results.record({
      engine: engineName,
      locale: '-',
      viewport: '-',
      journey: 'engine',
      step: 'launch',
      problems: [`engine unavailable: ${String(error.message).split('\n')[0].slice(0, 160)}`],
    });
    continue;
  }

  for (const locale of locales) {
    for (const viewportName of viewports) {
      const context = await browser.newContext({
        ignoreHTTPSErrors: true,
        viewport: VIEWPORTS[viewportName],
        locale: locale === 'ar' ? 'ar' : 'en-GB',
        extraHTTPHeaders: { 'Accept-Language': LOCALES[locale].acceptLanguage },
      });

      for (const journey of journeys) {
        const page = await context.newPage();
        const findings = watchPage(page, BASE);

        const step = async (stepName, body) => {
          let problems;
          try {
            problems = await body();
          } catch (error) {
            problems = [`step threw: ${String(error.message).split('\n')[0].slice(0, 200)}`];
          }
          results.record({
            engine: engineName,
            locale,
            viewport: viewportName,
            journey: journey.name,
            step: stepName,
            problems,
          });
          // Findings are per page; clearing between steps keeps one broken
          // step from colouring every later one.
          findings.exceptions.length = 0;
          findings.csp.length = 0;
          findings.mixed.length = 0;
          findings.forbidden.length = 0;
          findings.console.length = 0;
        };

        try {
          await journey.run({
            page,
            context,
            base: BASE,
            locale,
            viewport: viewportName,
            findings,
            step,
            fixture,
          });
        } catch (error) {
          results.record({
            engine: engineName,
            locale,
            viewport: viewportName,
            journey: journey.name,
            step: 'journey',
            problems: [`journey aborted: ${String(error.message).split('\n')[0].slice(0, 220)}`],
          });
        }
        await page.close();
      }
      await context.close();
    }
  }
  await browser.close();
}

const clean = results.summary();
process.exit(clean ? 0 : 65);
