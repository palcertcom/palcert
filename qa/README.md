# Browser and accessibility QA (Phase 20 Checkpoint 8)

Release QA for the parts of PalCert a person actually touches. It drives the
**production images behind the production proxy over TLS** — never a
development server — because the things this is looking for (hydration
failures, CSP violations, a bundle reaching for `localhost`, a locale that
only breaks when the real build inlines it) do not exist in `next dev`.

    BASE=https://localhost:8543 node qa/run.mjs                 # everything
    BASE=… BROWSERS=chromium node qa/run.mjs --smoke            # the CI-safe subset

## What it checks, on every page of every journey

Independent of what the journey is about, and failing the run if violated:

- no uncaught browser exception;
- no React hydration failure;
- no Content-Security-Policy violation;
- no mixed content;
- no request to `localhost`, a test origin or a development endpoint;
- no raw translation key rendered (`something.like.this` in the page text);
- no infinite spinner — a page that is still busy after its budget is a
  finding, not a slow test.

## The matrix

| Axis | Values |
| --- | --- |
| Engine | Chromium, Firefox, WebKit |
| Locale | `en` (LTR), `ar` (RTL) |
| Width | 390 phone, 820 tablet, 1280 laptop, 1920 desktop |

The full cross-product is a release gate, not something CI runs on every
commit. `--smoke` is the CI-safe subset: one engine, both locales, one width,
the public and authenticated shells only.

## Accessibility

WCAG 2.2 Level AA is the target. Automated coverage is axe-core; it catches
roughly a third of what matters, so the keyboard and focus checks in
`qa/journeys/keyboard.mjs` are not optional extras — they are the half a
scanner cannot see. Every critical action must be reachable and operable from
the keyboard alone, and every dialog must take focus, keep it, name itself and
give it back.

## Negative controls

A QA harness fails the same way the product does: quietly, by asserting
something that cannot be false. Checkpoint 20.8 found three of these in this
very directory — a forbidden-host rule that flagged the site's own origin, a
wrong-password step that spent the shared login budget and then measured the
throttle instead, and a busy-state probe that re-resolved the submit button by
its accessible name while the product was busy *changing that name*.

So the checks that would otherwise be unfalsifiable carry a control that is
run, not reasoned about:

    CHROME_PATH=… node qa/negative-control-duplicate-submit.mjs

`error-and-slow-states — a slow submit cannot be sent twice` passes because
the button disables itself for the three seconds the request is in flight, and
a disabled button swallows clicks. That result is indistinguishable from a
counter that never counts. The control removes the product's guard in the
browser and repeats the identical clicks: with the guard, the login is sent
once; without it, three times. The detector is live.

## The one accommodation the matrix needs

The full matrix signs in roughly a hundred and twenty times from a single
address inside an hour, using two fixture accounts. Two shipped limits object,
and both are right to: fifty login attempts per IP, and ten per account. Left
alone, cells from the fourth onward meet "too many attempts" and the harness
reports the resulting empty screens as product defects — which is exactly what
happened three times in Checkpoint 20.8 before it was understood.

    PROJECT=palcert-c7 bash qa/clear-login-throttle.sh &
    CHROME_PATH=… BASE=https://localhost:8543 node qa/run.mjs

That script deletes the `login:ip` and `login:account` counter keys, and only
those, every thirty seconds. **Nothing about the deployment changes**: both
limits keep their shipped values, and the image, the release topology and CI
are untouched. It makes one machine and two accounts look to the limiters like
the population they are standing in for.

The throttles are still proved at their shipped values, in two places the
script does not touch: the public-visitor journey's failed sign-in, which
asserts either a rejection or a throttle and the correct message for each, and
`auth-security.e2e-spec.ts` in the API suite.

## Arriving before leaving

`settle()` in `qa/lib/session.mjs` waits for a page's own first API response,
not just for `networkidle`. PalCert's screens ask for their data from a React
effect *after* hydration, so the network goes idle, then busy again. A step
that navigates away in that gap cancels the request, and WebKit reports a
load its own navigation cancelled as an uncaught page error. Every sign-in
settles; any new step that lands and immediately leaves should too.

The page guard ignores exactly one residue — a same-origin load WebKit
cancelled, which Next.js prefetches can still produce on their own schedule —
and that narrowing has a test run in CI:

    node --test qa/lib/page-guard.test.mjs
