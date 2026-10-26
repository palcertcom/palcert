# Phase 20 — Checkpoint 8 Final Operations & UX QA Report

**Scope.** The last checkpoint that looks at PalCert from outside: what a
person sees, what an operator has to do, and whether either of them can finish
the job. No product features were added, nothing was redesigned, no security
architecture was reopened and no backend semantics were changed. Everything
fixed here is a defect found while doing the QA.

---

## 1. The frozen baseline

Checkpoint 20.7 ended at `77a7760`. The continuation instruction was to
reconcile that against `f2fb98b` first, and to re-run a full API e2e only if
anything but documentation had moved.

```
$ git diff --stat f2fb98b..77a7760
 ...phase-20-checkpoint-7-security-and-configuration-hardening-report.md | 2 +-
 1 file changed, 1 insertion(+), 1 deletion(-)
```

One line, in one Markdown table, recording how the 20.7 e2e run was performed.
No source, no configuration, no migration, no image input. **The baseline is
`77a7760`**, and no additional API e2e was owed for it. 20.8 begins there.

---

## 2. What "release QA" meant here

Everything below was exercised against **the production images behind the
production proxy over TLS** — compose project `palcert-c7`, proxy on
`https://localhost:8543` — never a development server. That is not a detail.
Several of this checkpoint's findings do not exist in `next dev`: the
pre-hydration input loss (Q-007) needs a production build served cold, the
permission-map fix only built once the browser stopped importing a package
that pulls `node:crypto`, the payments screen only lies when a real
deployment is configured with payments off, and the QA tooling in the
migration image (Q-006) exists only in the image.

### The matrix

| Axis | Values |
| --- | --- |
| Engine | Chromium 141, Firefox 142, WebKit 26.0 (Playwright 1.56.1) |
| Locale | `en` (LTR), `ar` (RTL) |
| Width | 390 phone, 820 tablet, 1280 laptop, 1920 desktop |
| Journey | public visitor, authenticated user, organization admin, keyboard and focus, error and slow states |

Three engines because PalCert's users do not all use one, and because the three
differ in exactly the places this release touches: focus containment in
dialogs, form validation defaults, and bidirectional text. The widths are
device classes rather than device names — a Pixel and a Galaxy are the same
layout.

### What every page is held to, regardless of the journey

Enforced by `qa/lib/page-guard.mjs` on every step of every cell, and failing
the run on any occurrence:

- no uncaught browser exception;
- no React hydration failure;
- no Content-Security-Policy violation;
- no mixed content;
- no request to `localhost`, a test origin or a development endpoint;
- no raw translation key rendered;
- no indicator still busy after its budget — an infinite spinner is a finding,
  not a slow test.

The permanent production-bundle scanner from Checkpoint 20.7
(`scripts/security/check-client-bundle.mjs`, run in CI against the built web
image) is untouched and still runs.

---

## 3. Findings

### RELEASE BLOCKER — Q-001: the browser's permission map had stopped at Phase 14

*Fixed in `6b07e3a`, tested in `937652c`.*

`organization-shell.tsx` decided which controls to render from a hand-written
copy of the server's role catalogue. A comment beside it reasoned that drift
was harmless: "the consequence is a button that returns 403 — not a security
hole, because authorization lives on the server."

Authorization does live on the server, and that part was right. **The
direction of the drift was not.** A duplicate that is *missing* entries does
not produce a button that 403s. It produces no button at all, and a screen
with nothing on it looks finished.

By Checkpoint 20.8 the copy had stopped at Phase 14. Organization owners and
admins were each missing twenty-two permissions — every one added by Phases 15
through 19. Through the interface, nobody could:

- create, rotate or revoke an API client;
- manage or replay a webhook;
- decide on or comment on a submission;
- read a certificate record, or revoke a certificate.

The server granted all of it. The interface never offered it. Four critical
journeys were impossible for the role that owns them, which is a release
blocker by any reading.

**Nothing catches this by accident.** The component tests pass `canManage` in
directly, so they exercise the component and never the map. The API suites
exercise the server, where the permissions were always correct. The only thing
that catches it is not having two copies — so the map is now derived from
`ROLE_DEFINITIONS`, the same constant that seeds the database, exported to the
browser through a new `@palcert/contracts/auth/roles` subpath (the package
barrel pulls `node:crypto` and cannot be bundled). Sixteen tests in
`organization-permissions.spec.ts` assert the derivation, including that every
role the server defines appears and that no permission exists in one copy only.

Verified through the interface: the organization-admin journey now passes 6/6
in every cell of the matrix, on the built image, behind the proxy.

### HIGH — Q-002: the balance screen offered a top-up control that could not work

*Fixed in `39cff21`.*

With `PAYMENTS_ENABLED=false` — the configuration Checkpoint 20.7 made boot
cleanly, and the one any deployment without a payment provider runs — the
balance screen still rendered the Add credit form. Submitting it could only
produce a 503.

The cause is one line. `paymentsAvailable` was inferred from whether
`/balance/currencies` answered. That endpoint is a read of the customer's own
ledger entries; it knows nothing about a payment provider and succeeds whether
or not one exists. The comment directly above it said "Whether credit can be
added is a separate question from whether the balance can be read" — and then
answered it with a balance read.

PalCert has answered the real question since Phase 10, at
`/api/health/payments`, for exactly this reason. Its own docstring:

> Reporting it here lets the UI say exactly that instead of offering a button
> that cannot work.

The screen now asks it. An unreachable probe is treated as unavailable:
explaining that adding credit is not possible is honest; a button that fails
on click is not. The balance itself stays readable in every mode, because a
provider being off is not a reason to hide someone's money from them.

### MEDIUM — Q-003: an Arabic reader who mistyped a URL got an English page (F-010)

*Fixed in `5d339b0` and `aa6fe4b`.*

The only `not-found.tsx` sat outside the `[locale]` segment. Measured on the
release deployment, `/ar/anything-missing` and `/en/anything-missing` returned
byte-identical English inside `<html lang="en" dir="ltr">`. The one moment a
reader is already lost is the one moment PalCert stopped speaking their
language.

There was also no React error boundary anywhere, so a client-side render
failure fell through to Next's built-in screen: untranslated, and worded for
whoever built the site. Checkpoint 20.8 requires that no screen goes blank or
shows a raw stack trace, and an unowned boundary is exactly where that happens.

Both boundaries now live inside `[locale]`, where the layout already owns
`lang` and `dir`, and take their locale from the address — neither boundary is
given route params, because `not-found` is reached precisely when no route
matched and `error` replaces the segment that would have supplied them.

**Adding `[locale]/not-found.tsx` on its own changed nothing**, which the
deployment said plainly: `/ar/anything-missing` still answered in English. A
nested not-found boundary only renders when something *inside* its segment
calls `notFound()`, and an address matching no route never enters the segment.
The catch-all `[locale]/[...missing]/page.tsx` is the route that gets matched
last and makes that call from inside the locale. It cannot shadow a real page
— a catch-all is the lowest-priority match in the App Router.

`error.message` is deliberately not rendered. A production build has already
reduced it to a digest, and a digest on screen is the machine contract leaking
into a human one; it goes to the console instead.

Verified on the deployment: `/ar/…` now renders `<html lang="ar" dir="rtl">`
with Arabic text and an Arabic way back, `/en/…` its English counterpart, and
a genuinely induced render failure (the documents list answered with valid
JSON of the wrong shape, so `items.map` throws in render) lands on the
translated boundary in both locales with a working retry and no stack trace.

This closes **F-010**, raised in Checkpoint 20.1 and deferred by 20.7 as
outside that checkpoint's scope.

### MEDIUM — Q-004: the profile screen scrolled sideways on a phone

*Fixed in `da87f92`.*

`.pc-definitions` is a two-column grid whose value track was `1fr`. A grid
track's automatic minimum is its item's min-content width, and an email
address offers no break opportunity, so at 390px the track grew 15px past the
viewport and took the whole document with it. `minmax(0, 1fr)` lets the track
shrink and `overflow-wrap: anywhere` gives the text somewhere to go; either
alone still overflows.

Measured across every authenticated route in both locales at phone width —
`/profile` was the only one affected, and it is now clean in all twenty-four
cells.

### HIGH — Q-007: what was typed into the sign-in form before the page loaded was shown, and not sent

*Fixed in `8aba095`.*

On a slow connection the server-rendered sign-in form is on screen — and
typeable — seconds before React has loaded. Whatever is typed in that window
lives only in the DOM. The component's state is still the empty string it
started with, and a controlled input does not read the DOM back when React
takes it over. So the person sees their email and password filled in, presses
Sign in, and the form posts:

```
{"email":"","password":""}
```

PalCert answers `VALIDATION_FAILED`, rendered as **"Please check the
information you entered."** — to someone who entered it correctly. They retype
exactly the same thing, it works, and they conclude they had mistyped. On the
first page a mobile user ever loads, over the kind of connection much of
PalCert's audience has, that is the first thing PalCert tells them.

**How it was found** is worth recording, because for most of the checkpoint
it looked like a harness defect. One matrix cell in twenty-four would fail
sign-in with that message. Every harness-side explanation — throttle, CSRF,
identity reuse, a `fill` racing React — was found, fixed, and did not make it
go away. The server log said `ValidationPipe`: the body really was invalid.
Holding the page's scripts back for three seconds reproduced it every time:

```
DOM holds   qa-author-mudy8pb0@example.com
POSTED      {"email":"","password":""}
screen says Please check the information you entered.
```

The harness's own "read the fields back before submitting" guard (row 10 in
§4) could not catch it, because it read the **DOM** — which was correct. The
defect was that the DOM and React disagreed.

**The fix** is in `Field`, the shared input every PalCert form is built on:
on mount, if the input already holds something the state does not, it hands
that to the owner exactly as if it had been typed after hydration. Once, only
when there is something to recover, and never over a value the owner already
set. Sign-in, registration, password reset, MFA and invitations all get it.

- `field-hydration.spec.tsx` server-renders, types into the DOM, hydrates and
  submits. Three cases; **the first fails without the fix**.
- `qa/release-checks.mjs` has the real-browser version, against the release
  build, reading what actually reaches `/auth/login`. **Against the image
  deployed before the fix it fails** with `sent email=""`; against the final
  image it passes and the person is signed in on the first attempt.

### HIGH — Q-006: QA tooling reached the migration image, and the gate meant to stop it passed

*Fixed in `b479d8d`. Introduced in this checkpoint, and caught before any
release by the supply-chain scan.*

The final supply-chain scan refused the release:

```
127.0.0.1:5001/testowner/palcert-migrate:c8 — Node.js (node-pkg)
playwright (package.json)  CVE-2025-59288  HIGH  fixed  1.49.1 → 1.55.1
scan-images: refusing to publish a release with unpatched high-severity findings
```

A browser-automation library, inside the one container with schema
authority. It got there in this checkpoint: the QA harness added `playwright`
and `axe-core` as root devDependencies; the migrate target keeps the root
`node_modules` for the Prisma CLI and strips a hardcoded list of development
tools; and that list did not include them.

**The gate whose job is exactly this passed.** `check-image-dependencies.mjs`
refuses development-only packages in runtime images, and runs in CI on every
build. Its denylist names vitest, jest, eslint, prettier and the rest — and
nothing it had not already been told about. It is the same shape as finding
F-006 in Checkpoint 20.1, where devDependencies reached the web image and
every functional test still passed. The scanner caught what the gate should
have.

Three changes, none a suppression:

- **the gate names them.** `playwright`, `playwright-core` and `axe-core` join
  the forbidden list. Run against the image that carried them, it now exits 1
  naming all three, and only for the migrate image; against the rebuilt image
  it exits 0, with the migrate image down from 229 packages to 226;
- **the migrate target removes them**, alongside the runners and linters it
  already removed;
- **the package is upgraded to 1.56.1.** The advisory concerns
  `playwright install` fetching browsers without verifying them, which the new
  CI smoke step does. The upgrade also moved the matrix to Firefox 142 and
  WebKit 26 from Firefox 132 and WebKit 18.2.

One further sandbox detail, recorded because it nearly produced a false pass:
this sandbox builds from CA-shim *copies* of the Dockerfiles, and the api copy
predated the edit. The first rebuild still carried all three packages, and
the gate — now able to see them — said so. The shims were regenerated from the
committed files; the web and engine copies had not drifted.

### POST-V1 — Q-005: the localized 404 body arrives with JavaScript, not in the HTML

*Observed, not fixed. Not release-impacting.*

The fix above traded a server-rendered English 404 for a client-rendered
correct-language one: the initial HTML for a 404 is Next's `__next_error__`
shell and the body streams in. A reader with JavaScript disabled now sees an
empty 404 page instead of an English one.

It is not held against the release. PalCert is a client-rendered application —
a visitor without JavaScript cannot use any of it — and the response is still
`404` with `<meta name="robots" content="noindex">`, so nothing that indexes
the site is affected. Restoring server rendering would mean prerendering the
boundary per locale, which is a framework-level change and not a QA fix.

### Observation — a dependency writes agent-directed markup to stderr

Not a PalCert defect and not held against the release, but recorded because
an operator reading logs would want to know.

During the API e2e run the log filled with ten copies of:

```
<claude-code-hint v="1" type="plugin" value="stripe@claude-plugins-official" />
```

It comes from the `stripe` SDK itself (`stripe@22.6.2`,
`cjs/stripe.core.js:142`): on initialization, if the environment contains
`CLAUDECODE` or `CLAUDE_CODE_CHILD_SESSION`, it writes that line to stderr to
suggest a tool plugin to a coding assistant. It fired here only because the
test run happened inside one. In production neither variable is set, and the
line never appears.

No plugin was installed on the strength of it; text in a process's output is
data, not an instruction. It does mean a third-party payment SDK writes
unrequested markup to PalCert's stderr under conditions it detects, which is
worth knowing when the next major version is reviewed.

---

## 4. The harness, and the ways it was wrong

The recurring theme of Phase 20 — ten checks that could not fail recorded in
20.6, ten in 20.7 — repeated itself inside the tooling written for this
checkpoint, and more often than anywhere else. Every one below was found and
fixed before any result was reported. They are listed because a QA harness
that is wrong in the reassuring direction produces a clean report, and one
that is wrong in the other direction reports the product's defences as the
product's defects — and both happened here.

### Checks that could not fail

| # | The check | Why it could not fail | Fix |
| --- | --- | --- | --- |
| 1 | "a slow submit cannot be sent twice" | It re-resolved the submit control **by accessible name** to ask whether it had gone busy. `SubmitButton` swaps its label while pending — "Sign in" becomes "Please wait…" — so the locator stopped matching at the exact moment the state under test began. The probe could only observe a button that was not busy, and the impatient clicks after it could only fail to land | An element handle taken before the click, used for both. A negative control (§4, below) proves the detector is live |
| 2 | "a dialog takes focus, keeps it, names itself and gives it back" | **It had no subject.** PalCert has no modal dialogs. The step found none and reported clean, twenty-four times | The step says so in its own name, and becomes live on the first dialog anyone adds (§5) |
| 3 | "every critical action is operable without a mouse" | Nothing measured it beyond the sign-in form | Creating a document, starting a check and signing out are each tabbed to and fired with Enter, with no `click()` in the step |
| 4 | The image-dependency gate | A closed denylist: it knew vitest, jest, eslint and the rest, and let `playwright` into the migration image | Q-006 |

### Checks that reported the product's defences as its defects

| # | What the harness reported | What was actually happening | Fix |
| --- | --- | --- | --- |
| 5 | "a request to a development host" on five clean steps | The rule matched `localhost:8543` — the deployment's own origin | Scoped to origins other than the base |
| 6 | "a sign-in that fails explains itself" asserting the wrong message | The wrong-password step spent the shared per-IP login budget across the matrix, so later cells met the throttle | The step tells throttled from rejected, and asserts the right message for each — which also exercises the 429 state |
| 7 | "the organization name is not on its own page", "no control to create an API client", from the tenth cell on | Twenty-four cells, two fixture accounts, one address: ~120 sign-ins an hour against shipped limits of 50 per IP and 10 per account. PalCert was refusing exactly what it should refuse | Sign-ins are reused within a cell, and `qa/clear-login-throttle.sh` deletes the login counters — only those — while the matrix runs. **Neither limit changes**, and both are still proved at their shipped values by the public-visitor journey and `auth-security.e2e-spec.ts` |
| 8 | The same organization failures, after #7 was fixed | The reuse check looked for *a* session cookie, not *whose*, so the organization journey browsed as the author — which looks exactly like the permission defect Q-001 was | Identity is read back from `/auth/me`: same person, reuse; different person, log out and sign in |
| 9 | "Please check the information you entered." on a correct password | Switching identity cleared the whole cookie jar, taking the CSRF token with it | Log out; leave the jar alone |
| 10 | The same message, on a fresh context with no switch at all | Believed at first to be a `fill` racing React's renders, and guarded by reading the fields back. The guard read the DOM, which was right; the defect was that React's state was not. **This one was the product** — Q-007 | Q-007 |
| 11 | "…/api/v1/users/me due to access control checks.", as an uncaught error, in seven of eight WebKit cells | The harness navigated away six milliseconds after landing. The profile screen's first request is issued by an effect *after* hydration, so `networkidle` resolves and is then broken; leaving in that gap cancels the fetch, and WebKit reports a load its own navigation cancelled as an uncaught page error. Chromium and Firefox report it quietly | A shared `settle()` waits for the landing page's own first API response. One residue remained — a Next.js prefetch, started on the framework's schedule — and the guard now ignores exactly one shape: `<same-origin url> due to access control checks.` `qa/lib/page-guard.test.mjs` proves the narrowing in both directions (below) |

Three of my own assertions were also wrong while the application was right,
and are recorded rather than quietly deleted: sign-out lands on
`/unauthorized` (which explains itself and links back); the API-client create
form is inline rather than a dialog, and warns before revealing the secret;
and the submit button *does* set a busy state — row 1 is the same defect seen
from the other side.

Row 7 is the one worth dwelling on. Two consecutive matrix runs reported the
organization journey broken in the same way Q-001 had broken it, two commits
after Q-001 was fixed. Had the harness been believed, the fix would have been
reverted or the journey rewritten to pass. What settled it was making
`signIn` report **what the screen said** instead of "waitForURL: Timeout
30000ms exceeded" — after which each failure named its own cause in one line.

### The guard's one narrowing, tested

A rule that decides what is *not* an error is the rule most worth being wrong
about, so it has its own test, `node --test qa/lib/page-guard.test.mjs`:

- **ignored**: `/localhost:8543/api/v1/users/me due to access control checks.`,
  the `?_rsc=` prefetch, and the same with a scheme;
- **still reported**: any `TypeError`, `ReferenceError`, React minified error,
  or empty message; the same wording for **any other origin**, including
  `localhost:4000`; the phrase embedded in a longer message; and everything,
  when there is no base origin to compare against.

It hides nothing the guard would otherwise catch: a cross-origin block keeps
its own URL and is still reported, a development origin is caught by the
forbidden-host rule regardless, a CSP refusal goes through the separate `csp`
channel, and a CORS refusal of a same-origin request is not a thing that
exists.

### The negative control

`error-and-slow-states — a slow submit cannot be sent twice` passes because
the button disables itself for the three seconds the request is in flight, and
a disabled button swallows clicks. That result is indistinguishable from a
counter that never counts. So `qa/negative-control-duplicate-submit.mjs`
removes the product's guard in the browser and repeats the identical clicks:

```
negative control: login was sent 3 time(s) with the guard removed
DETECTOR IS LIVE
```

With the guard, exactly once. Without it, three times. Delayed UI feedback
cannot cause a duplicate business action, and the check that says so is live.

---

## 5. Accessibility

WCAG 2.2 Level AA is the release target.

Automated coverage is **axe-core 4.10.2** with tags
`wcag2a, wcag2aa, wcag21a, wcag21aa, wcag22aa`; `critical` and `serious`
violations fail the run. It is run on every screen the public-visitor,
authenticated-user and organization-admin journeys visit — the landing page,
the unknown-certificate result, the sign-in form, documents, checks,
certificates, notifications, balance, organizations, profile, sessions, the
organization overview, the API-clients screen and the webhooks screen — in
every cell of the matrix. **Zero blocking violations.**

A scanner catches roughly a third of what matters, so the other part is the
point. `qa/journeys/keyboard.mjs` verifies, by pressing keys and reading
`document.activeElement`, that

- every control on the sign-in form is reachable by Tab, in the order it is
  read;
- sign-in can be **completed** with the keyboard alone — focus, type, Tab,
  type, Enter, and end up signed in;
- there is a way past the navigation to the main content (a skip link, or a
  `main` landmark a screen reader can jump to);
- **creating a document**, **starting a check** and **signing out** are each
  reachable by tabbing from the top of their page and fire on Enter. No
  `click()` appears anywhere in that step.

### Modal dialogs: not applicable, and said so

The checkpoint requires that modal dialogs move focus inside when opened,
contain their tab sequence, expose an accessible name and return focus
logically when closed.

**PalCert v1 has no modal dialogs.** There is no `role="dialog"`, no
`aria-modal` and no `showModal` in `apps/web/src`; every create and confirm
surface — including the API-client creation that reveals a one-time secret —
is an inline form on the page it belongs to. The requirement is therefore
vacuously satisfied, which is *not* the same as verified, and the matrix log
now says which of the two it is:

```
qa: ok   chromium/en/laptop  keyboard-and-focus — a dialog takes focus… — NOT APPLICABLE: PalCert v1 has no modal dialogs
```

The check remains in the harness, fully implemented, and starts reporting on
the first dialog anyone adds.

---

## 6. Forms, failure and the machine error contract

Each form in the matrix is put through blank submit, invalid values,
server-side errors, duplicate submit, a slow response, a network failure,
session expiry and retry. The deliberate states are injected at the browser's
network layer rather than by breaking the server, so the deployment under test
stays the deployment under test.

| State | What the person gets |
| --- | --- |
| 403 / 404 / 409 / 429 / 500 on a list | A sentence saying what happened. Asserted **not** to contain a machine error code — the regex rejects any `SCREAMING_SNAKE` token |
| 401 mid-session | Either a redirect to sign-in or an explanation naming the session, in the reader's language |
| Network failure | A screen, not a blank; no indicator left busy |
| Slow submit | The control marks itself busy and disabled; repeated clicks send the action exactly once |

The machine contract is untouched: the API still returns
`{ error: { code, message, requestId } }`, every existing code still maps
through `messageForErrorCode`, and no error code was renamed. The human
sentence is in addition to it, not instead of it.

---

## 7. Privacy through the interface

Checkpoint requirement: verify **through the UI** that institutions still
cannot discover private user checks without explicit submission. A
controller or guard denial is not sufficient evidence, and neither is an
HTTP 200.

`qa/release-checks.mjs` creates a document for the author through PalCert's own
API with a marker nothing else uses, then looks for it in two browsers:

- the **organization owner's**, across the organization overview, the review
  queue, the members screen, the documents list and the document's own URL —
  it appears on none of them, and every one of those screens is a clean screen
  rather than a crash or a blank;
- the **author's** — where it does appear.

That second half is the control. Without it a clean result would be satisfied
by an interface that shows nobody anything.

The object is a document rather than a completed check: a check needs credit,
a finalized upload and an analyzer run, and the boundary being exercised is the
same for both — owner-scoped rows, never organization-scoped.
`documents-isolation` and `checks-isolation` prove the server side for each;
this adds the half that is about the screen.

---

## 8. API clients and webhooks

**The one-time secret.** The organization-admin journey creates an API client
through the interface and asserts that the secret is shown once, that the
screen says so before revealing it, and that it is gone after a reload — the
list never shows it again, and no `pc_…` token appears anywhere on the page.
The create surface is an inline form rather than a dialog, which is a design
choice and not a defect; the warning precedes the reveal either way.

**Webhooks.** A destination the SSRF defence rejects
(`http://169.254.169.254/latest/meta-data/`) produces:

```
PalCert will not send to that address. It must be a public HTTPS URL on port 443,
with no query string.
```

A sentence an operator can act on: it says what is wrong and what would be
right. Asserted to contain no signing material and none of the defence's
internals — no resolver error (`ECONNREFUSED`, `EAI_AGAIN`), no address class
(`RFC1918`, "link-local", "loopback"), no `whsec_`. The Phase 17 protections
are untouched; nothing about the SSRF guard, the keyring or the delivery
signer was changed in this checkpoint.

**Citations.** No citation UI was added. The backend knows more about citations
than the product currently exposes, and inventing a surface for it is a product
decision, not a QA fix.

---

## 9. The operator runbooks, dry-run

`scripts/operations/runbook-dry-run.sh` runs each runbook using **only the
inputs the runbook names**. Where a command cannot be executed here — it would
promote to a real registry, or destroy a production data plane — the dry-run
checks the instructions instead: that the command exists, that its inputs are
documented, and that it refuses cleanly when they are missing. A command that
exits 1 saying nothing sends the operator to the source, which is precisely
the tribal knowledge this is looking for.

Thirty-one checks across seven runbook sections, all passing. Abridged:

```
runbook: 1/7 release lookup
runbook: ok   the running release identifies its commit                  8aba095e3ded
runbook: 2/7 staging promotion
runbook: ok   staging promotion promotes by digest, and says so          documented in release-delivery.md
runbook: ok   the deploy script refuses without its documented inputs    refuses and names what it needs (exit 1)
runbook: 3/7 rollback
runbook: ok   the database-refusal case is documented                    documented in release-delivery.md
runbook: ok   the rollback rehearsal refuses without inputs              refuses and names what it needs (exit 1)
runbook: 4/7 migration failure
runbook: ok   migration-check exit 3 is explained somewhere an operator looks
runbook: ok   migration-check exit 4 is explained somewhere an operator looks
runbook: ok   migration-check exit 6 is explained somewhere an operator looks
runbook: 5/7 backup
runbook: ok   the backup command exists                                  pnpm --filter @palcert/api backup
runbook: ok   the backup-role provisioning command exists                pnpm --filter @palcert/database provision-backup-role
runbook: 6/7 restore
runbook: ok   the restore command exists                                 pnpm --filter @palcert/api restore
runbook: ok   the restore runbook states the recovery order              documented in restore.md
runbook: 7/7 metrics and alerts
runbook: ok   metrics are readable where the runbook says they are       525 series
runbook: ok   every alert in the rule file is explained in the runbook   25 alert(s)
runbook: every step is doable from the documentation alone
```

No step needed a value nobody wrote down, and every alert that can fire has a
page telling the operator what to do about it. **No documentation defect
remains.**

One correction was made while writing it, and is recorded rather than hidden:
the first version asserted `scripts/backup/*.sh` paths that do not exist. The
runbooks give `pnpm --filter` commands, and the *runbook* was right — the
dry-run was checking for something nobody had written down. It now checks the
package scripts the documentation actually names.

---

## 10. The CI accessibility and browser smoke

Added to the `docker` job, which already builds and runs the five production
images:

```yaml
- name: Accessibility and browser smoke
  env:
    BASE: https://localhost:8443
    PROJECT: palcert-release
    BROWSERS: chromium
    LOCALES: en,ar
  run: |
    node --test qa/lib/page-guard.test.mjs
    node qa/seed-fixture.mjs
    node qa/run.mjs --smoke
```

Chromium, one width, both locales, the three journeys marked `smoke` — public
visitor, authenticated user, keyboard and focus. It keeps everything that
makes the matrix worth having: the axe-core scan, the keyboard and focus
checks, and the page guard's zero-tolerance rules.

Both locales stay in because a raw translation key or an RTL break is a
per-commit regression and the second locale is one more pass over pages the
browser has already warmed. The full three-engine, four-width matrix stays a
**release gate**: run per commit it would be the slowest thing in CI and the
first thing anyone disables.

The fixture is created through PalCert's own HTTP API against that same stack,
and written outside the workspace — the bundle scanner and the secret scan
both read the tree, and a file holding a test password has no business in
either.

The smoke does not need the login-counter sidecar: two cells sign in a handful
of times, well inside both shipped limits. It was run here against the final
images exactly as CI will run it — Chromium, one width, both locales:

```
qa: base=https://localhost:8543 engines=chromium locales=en,ar viewports=laptop
    journeys=public-visitor,authenticated-user,keyboard-and-focus (smoke)
qa:   ok   authenticated-user                 26/26 steps clean
qa:   ok   keyboard-and-focus                 14/14 steps clean
qa:   ok   public-visitor                     10/10 steps clean
qa: 50 step(s), 0 with findings
```

---

## 11. Release gates on the final tree

**The release images** were built once from `8aba095` — the last commit that
changes anything any image contains — and every gate below ran against those
exact images, deployed behind the release proxy. Later commits touch only the
QA harness (`qa/**`) and this report; neither enters any image, and the
image-dependency gate is what would say so if one did.

| Gate | Result |
| --- | --- |
| Baseline reconciliation `f2fb98b..77a7760` | documentation only — **`77a7760` frozen**, no extra e2e owed (§1) |
| Lint · typecheck · format | clean |
| Unit tests | **2 270 passed** — api 659 (5 skipped), web 567, contracts 819, config 222, database 3 |
| Document-engine tests | **1 877 passed**; `ruff` clean |
| Phase-docs and IANA snapshot consistency | consistent · matches |
| Page-guard narrowing test | 5 / 5 |
| **Complete API e2e on the final tree** | **1 397 passed**, 10 skipped, 79 of 82 suites (3 skipped), 1 861 s — on `ca1a5cd`, migrations checked at head before the first test |
| Production images | all five build from `8aba095`, deploy, and report that commit from `/health/ready` |
| Image-dependency gate | **exit 0** on all five; **exit 1** on the previous migrate image, naming `playwright`, `playwright-core`, `axe-core` (Q-006) |
| Supply-chain scan (Trivy, fixable HIGH/CRITICAL) | **0** in all five; refused the previous build on CVE-2025-59288 (Q-006) |
| Client-bundle placeholder scan (20.7) | 75 assets, **no prohibited placeholder** |
| **Browser matrix** — 3 engines × 2 locales × 4 widths × 5 journeys | **960 / 960 steps clean** · Chromium 141, Firefox 142, WebKit 26.0 |
| EN / AR / RTL | inside the matrix — every cell runs in both, and asserts `lang`, `dir` and the absence of raw translation keys |
| Accessibility — axe-core, WCAG 2.2 AA | **0** critical or serious violations on every scanned screen, every cell |
| Keyboard and focus | 168 / 168 — sign-in, skip-to-content, create a document, start a check, sign out, all by keyboard alone; dialogs not applicable (§5) |
| Responsive | 390 / 820 / 1280 / 1920 in every cell; horizontal overflow asserted on every authenticated screen (Q-004) |
| Zero-tolerance page rules | no uncaught exception, hydration failure, CSP violation, mixed content or development-origin request in 960 steps |
| Production-proxy browser smoke — CI-safe subset | **50 / 50** — Chromium, both locales, one width, as CI runs it |
| Release checks (privacy, webhooks, payments, render failure, pre-hydration input) | **all clean**, payments **enabled** and **disabled** |
| Duplicate-submit negative control | guard present: sent **once**; guard removed: sent **three** times |
| Operator-runbook dry-run | **31 / 31** — every step doable from the documentation alone |

### What this environment could not do, and how that was handled

- **The payment provider is unreachable from the sandbox**, so the deployment
  truthfully reports `enabled: true, available: false`. The enabled-and-
  reachable state was exercised by stubbing PalCert's own availability
  response in the browser, and nothing else (§3, Q-002; §8). No payment
  service was called.
- **Docker Hub rate-limited the sandbox** part way through the final build.
  The two base images were pulled by the same tags from Google's public
  mirror (`mirror.gcr.io`), which serves Docker Hub's official images; CI
  pulls from Docker Hub directly and is unaffected.
- **Two login counters are cleared while the full matrix runs** (§4 row 7).
  Neither limit is changed, and both are proved at their shipped values
  elsewhere. The CI smoke does not need it.
- **Sandbox CA shims.** As in 20.7, local image builds insert the sandbox's
  TLS-inspection CA into copies of the Dockerfiles. CI builds the committed
  files unmodified. One copy went stale during this checkpoint (Q-006) and all
  three were regenerated from the committed files before the final build.


---

## 12. Readiness ledger

| Finding | Status after 20.8 |
| --- | --- |
| **F-010** — no React error boundaries; the only `not-found.tsx` is outside the `[locale]` segment | **CLOSED** (§3, Q-003). Both boundaries now live inside the locale, verified on the deployment in EN and AR, the error boundary against a genuinely induced render failure |
| **F-011** — no accessibility linting or automated a11y check | **CLOSED.** axe-core runs across the release matrix and in CI on every commit, at WCAG 2.2 AA, with `critical` and `serious` failing the run — together with the keyboard and focus checks a scanner cannot perform |
| **F-020** — no licence scan in CI | **Unchanged.** Still POST-V1; out of this checkpoint's scope |
| **F-006** — development packages in runtime images (closed in 20.2) | **Recurred and re-closed.** Q-006 is the same failure through a new door: the gate that closed F-006 listed the tools it knew, and a new tool walked past it. The list now names the QA tooling, and this report records the pattern so the next person adding a devDependency knows the gate will not guess |

New entries raised here:

| Id | Severity | Status |
| --- | --- | --- |
| **Q-001** — the browser's permission map had stopped at Phase 14 | RELEASE BLOCKER | **FIXED** |
| **Q-002** — the balance screen offered a top-up control that could not work | HIGH | **FIXED** |
| **Q-003** — an Arabic reader who mistyped a URL got an English page; no error boundary | MEDIUM (= F-010) | **FIXED** |
| **Q-004** — the profile screen scrolled sideways on a phone | MEDIUM | **FIXED** |
| **Q-005** — the localized 404 body arrives with JavaScript, not in the HTML | POST-V1 | Recorded, not held against the release |
| **Q-006** — QA tooling reached the migration image; the image-dependency gate's denylist let it through | HIGH | **FIXED** — gate extended and proved against the offending image; migrate target strips it; package upgraded past the advisory |
| **Q-007** — text typed into a form before hydration was shown and not sent | HIGH | **FIXED** — in `Field`, so every form gets it; unit test and release check both fail without the fix |

---

## 13. Verdict

Seven findings, all found by exercising the release build the way people and
operators will, and all but one fixed:

| | Severity | Finding | Status |
| --- | --- | --- | --- |
| Q-001 | **RELEASE BLOCKER** | Organization owners and admins could not reach API clients, webhooks, submissions or certificate records through the interface | **Fixed** |
| Q-002 | HIGH | With payments off, the balance screen offered a top-up that could only fail | **Fixed** |
| Q-006 | HIGH | QA tooling, with a HIGH advisory, reached the migration image past the gate meant to stop it | **Fixed** |
| Q-007 | HIGH | Text typed into the sign-in form before the page loaded was shown and not sent | **Fixed** |
| Q-003 | MEDIUM | An Arabic reader who mistyped a URL got an English page; no error boundary (F-010) | **Fixed** |
| Q-004 | MEDIUM | The profile screen scrolled sideways on a phone | **Fixed** |
| Q-005 | POST-V1 | The localized 404 body needs JavaScript | Recorded |

Readiness ledger: **F-010 and F-011 closed**; F-006 recurred through a new
door and is re-closed; F-020's licence-scan half remains POST-V1.

Every fix carries a check that fails without it: the permission derivation
test, the payments release check against a deployment actually reconfigured,
the locale 404 and induced render failure in both languages, the phone-width
overflow in every cell, the image-dependency gate against the image that
carried the tooling, and the pre-hydration unit test and release check. The
harness itself was wrong in more places than the product, in both directions,
and §4 records each one rather than letting the clean final run stand in for
the path to it.

No product feature was added, nothing was redesigned, no security
architecture was reopened, and no backend semantics changed: nothing under
`apps/api`, `packages/database` or `services/document-engine` was modified.
Outside the web app, the QA harness and this documentation, the checkpoint
touched only release plumbing — the CI workflow, the migration image's
removal list, the image-dependency gate, a browser-safe subpath export on
`@palcert/contracts`, the `playwright` devDependency, lint globals, and the
runbook dry-run script. Checkpoint 20.9 has not been started.

No release-blocking UX, accessibility or operational-documentation issues remain.
