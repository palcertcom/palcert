/**
 * Automated accessibility, against WCAG 2.2 Level AA (Phase 20 Checkpoint 8).
 *
 * axe-core is injected into the page rather than run through a wrapper, so the
 * harness has no build-time dependency on a Playwright integration package and
 * the version in use is visible in one place.
 *
 * **It is not the whole check and must not be read as one.** Automated rules
 * catch on the order of a third of real WCAG failures: they find a missing
 * label or a contrast ratio, and they cannot find a focus trap that never
 * closes, a dialog that leaves focus behind it, or a control that is reachable
 * only with a mouse. Those are in `qa/journeys/keyboard.mjs`, and the report
 * says which findings came from which.
 */
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';

const require = createRequire(import.meta.url);

function axeSource() {
  return readFileSync(require.resolve('axe-core/axe.min.js'), 'utf8');
}

/** The rule sets a Level AA release target implies, and nothing beyond it. */
const TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'];

export async function scan(page, { include = null } = {}) {
  await page.evaluate(axeSource());
  return page.evaluate(
    async ([tags, selector]) => {
      const options = { runOnly: { type: 'tag', values: tags }, resultTypes: ['violations'] };
      const context = selector === null ? document : { include: [[selector]] };
      const results = await window.axe.run(context, options);
      return results.violations.map((violation) => ({
        id: violation.id,
        impact: violation.impact,
        help: violation.help,
        // One example is enough to act on; a list of forty duplicates is not.
        nodes: violation.nodes.slice(0, 3).map((node) => node.target.join(' ')),
        count: violation.nodes.length,
      }));
    },
    [TAGS, include],
  );
}

/**
 * Which violations hold a release.
 *
 * `critical` and `serious` block: those are the ones that stop somebody
 * completing a task. `moderate` and `minor` are recorded and triaged rather
 * than treated as blockers, because holding v1 for a decorative contrast ratio
 * on a disabled hint is exactly the judgement this checkpoint says not to make.
 */
export function blocking(violations) {
  return violations.filter((violation) => ['critical', 'serious'].includes(violation.impact));
}
