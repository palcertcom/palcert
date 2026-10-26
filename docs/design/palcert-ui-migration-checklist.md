# PalCert UI migration checklist

Branch `ui/figma-product-shell-v1`. Stages 1–3 (audit, design system, shell)
and the Arabic typography are approved. This file tracks the page migration
(Stages 4–7) and every item that must not be forgotten on the way.

Rules for every page: preserve every existing action; no fake controls, counts
or API features; the Figma screenshots are the visual authority; Arabic in IBM
Plex Sans Arabic; tables usable at 390 px; nothing pushed or merged to `main`.

## Gate before migration — clean full QA run

| | |
|---|---|
| Commit under test | `cee4a17` (web image `palcert/web:ui-shell-v1`, revision label verified) |
| Stack | staging release stack, `https://localhost:8743`, all services healthy |
| Throttle | cleared with `qa/clear-login-throttle.sh` (documented mode, alongside the run) |
| Matrix | chromium, firefox, webkit × en, ar × phone, tablet, laptop, desktop (24 cells) |
| Result | **960 of 960 steps clean, 0 with findings** |

"a slow submit cannot be sent twice" — seen failing once (chromium/en/laptop)
in an earlier run of the previous build. In this clean run it passed in all 24
cells; it also passed 120/120 in isolated reruns and 10/10 journey reruns.
**Recorded as not reproduced after the clean rerun.**

## Stages

- [x] **Stage 4 — Dashboard finalization**
- [x] **Stage 5 — Personal workspace** (stopped for screenshot review; Stage 6 waits for approval)
  - [x] Documents
  - [x] Document details
  - [x] Checks
  - [x] New check (multi-step)
  - [x] Check details
  - [x] Certificates
  - [x] Certificate details
  - [x] Balance (and payment return / cancelled)
  - [x] Notifications
  - [x] Notification preferences
  - [x] Personal submissions (list and details)
- [x] **Stage 6 — Organization workspace**
  - [x] Overview
  - [x] Profile
  - [x] Team — horizontal page overflow at 390 px **fixed** (DataTable; checked
        at 390 px in both locales)
  - [x] Invitations
  - [x] Document types
  - [x] Standards
  - [x] Standard versions (published and draft visibly distinct)
  - [x] Submission queue
  - [x] Submission details (technical determination and institutional
        decision kept separate)
  - [x] Verification
- [x] **Stage 7 — Integrations**
  - [x] API clients (show-once secret stays show-once)
  - [x] Webhooks (show-once signing secret stays show-once)
- [x] **Public landing**: server-rendered; accessible mobile menu
- [x] **Stage 8 — Auth, account and system screens** (profile incl. change
      password, sessions, unauthorized, forbidden, not-found, error)
- [x] **Stage 9 — Responsive, RTL and accessibility QA** (see below)
- [x] **Stage 10 — Route and capability audit**: `palcert-ui-route-matrix.md`

## Stage 5 screenshot check

34 captures (EN/AR, 390/768/1440) with axe, a horizontal-overflow probe and a
page-error listener. First pass found three problems, all fixed:

- `definition-list` on the New check review step: the price panel's list held
  a hint paragraph inside a term group. The hint is now a second definition.
- 15 px page overflow at 390 px on the same step: the two-column summary grid
  treated each price group as one cell and squeezed the balance label past
  the edge. The price figures now have their own wrapping layout.
- `color-contrast` on unread notification badges: gold text on the gold tint
  was 4.25 : 1. Gold badges now use `--pc-gold-text-strong` (5.10 : 1).

Final pass: 34 of 34 with no axe violations, no overflow, no page errors.

## Stage 9 — responsive, RTL and accessibility QA

**Page survey.** Every page type was opened as a signed-out visitor, as a
document author and as an organization owner: 6 public, 15 personal and
account, and 14 organization pages. Each ran in EN and AR, and each visit
checked axe (serious and critical), horizontal overflow, page errors, CSP and
hydration console messages, and 404/5xx asset responses.

| Browsers | Widths | Page visits | Findings |
|---|---|---|---|
| Chromium, Firefox, WebKit | 390, 768, 1440 | 630 | 0 |
| Chromium | 1280 | 70 | 0 |

**Journey matrix** (`qa/run.mjs`: 3 browsers × EN/AR × 390/820/1280/1920).
The first run on `05b17ed` found one real defect, plus one weakness in the
QA journey itself:

- `color-contrast`: a checked API-client scope's description was muted grey
  on the gold tint (4.39 : 1). Now it uses the body colour (`2d0a313`).
- "one-time secret shown with no copy control" was a false positive. The
  journey never created a client, because it looked for a label containing
  "name" and the label reads "What this is for". It then mistook the public
  `pcid_` client ID listed on the page for a secret. The journey now creates
  a real client, checks the one-time secret and its copy control, ignores
  public IDs, and revokes what it made (`200713c`). The organization journey
  then passed 144/144 steps, and all 24 clients it created are revoked.

**Final journey matrix** on `c1eb5af` (web image revision label
verified; staging stack on port 8743): **960 of 960 steps clean, 0 with
findings.** The numbers were public visitor 120, authenticated user 312,
organization admin 144, keyboard and focus 168, error and slow states 216.

**Visual review** found one more problem. In Arabic, the sidebar
organization switcher cut the beginning of a long Latin name
("tance University…"). It now uses `dir="auto"` and an end ellipsis, checked
in all three engines (`c1eb5af`).

## Known items carried forward

- Small buttons (`pc-btn-sm`, row actions) are 37 px tall in both locales by
  design; the Arabic check reports them, and their labels are not clipped.
