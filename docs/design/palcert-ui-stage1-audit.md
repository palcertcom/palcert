# PalCert UI redesign — Stage 1 design audit

Branch `ui/figma-product-shell-v1`, from `main` at `c951278`. No application
code has changed yet. This document is the architecture to agree before the
design system and shell are built.

Authority order, fixed: **visual** — the original PalCert screenshots;
**functional** — this repository's routes, APIs and permissions; **security** —
backend authorization, RBAC, RLS, MFA, CSRF, secret handling, billing and
institutional-decision boundaries.

---

## 1. Original design audit (all 13 screenshots inspected)

| Screenshot | What it shows | What PalCert takes from it |
| --- | --- | --- |
| `login.png` | Logo top-left over a thin gold rule; form column left (icon-in-circle fields, gold full-width button, "Forgot your password?" in gold); illustration and "Create a new account →" right; faint gold lattice pattern; gold line-wave along the bottom | AuthShell composition, field style, wave |
| `Sign up.png` | Same header; one white card with soft shadow over the lattice; centred form; wave behind the card's lower half | Register / reset / MFA card variant |
| `Graduate Page.png` | Cream sidebar (logo, Profile, "My Certifications" expanded to Verified / Pending / Refused, Messages); topbar = page icon + title, search with a send button, bell; gold rule under the topbar; centred welcome and one gold CTA; wave | Personal dashboard hero, sidebar and topbar structure |
| `Graduate details1–4, 4-1` | Five-step flow: a cream band with `01…05`, gold dots, a solid line for done steps and a dashed line for the current one, checkmarks on completed steps; one white card holding the step; icon fields; dashed upload zone; "Next →"; final step shows a total and "Submit Your Request" | `StepProgress`, New Check flow, upload zone |
| `University Page.png`, `-1` | Organization logo and name as the page title; section title plus filter chips (Approved / Pending / Cancelled); plain uppercase column headers; thin row dividers; small status pills (green "Verified"); kebab menu per row; numbered pagination; marketing footer | Table language, filter chips, org header |
| `Ministry Dashboard 1` | Dense approval table: checkboxes, status pills (amber "Pending"), outlined red "Cancelled" and gold "Accept" row actions; sidebar with sub-filters and "+ Add University" | Review-queue actions and density |
| `Ministry Dashboard 2` | Approved list with a "View Profile" outline button | Row secondary action |
| `Frame 36.png` | The palette rule: white 60 %, charcoal 30 %, gold 10 %, plus a cream neutral | Token set (§3) |

**Deliberately not copied**, because the functional authority differs:

- **Login by name.** PalCert signs in by email, and "Remember me" has no backend.
- **Phone on sign-up.** The register API has no phone field.
- **In-app card entry** (`Graduate details4-1`). PalCert takes payment through
  the provider's hosted checkout. Collecting card numbers in PalCert's own page
  would widen PCI scope. The pricing and total presentation is kept.
- **Identity-document uploads** (ID card, passport). No such workflow exists.
- **The marketing footer on application screens.** It costs a full screen of
  height on every page. A slim footer stays on public pages only.
- **"Search … ⟶" as a global search.** No search API exists. The affordance
  appears only where a list really filters (§5).

## 2. Palette extracted from the reference (sampled, not estimated)

`Frame 36.png` sampled pixel by pixel:

| Token | Value | Source / use |
| --- | --- | --- |
| `--pc-surface` | `#FFFFFF` | 60 % white |
| `--pc-text` | `#4C4C4C` | 30 % charcoal: body text, nav, icons |
| `--pc-gold` | `#C39547` | 10 % gold: primary buttons, active state, rules, wave |
| `--pc-background` / `--pc-surface-muted` | `#F7F3EE` | Cream: sidebar, step band, table header tint |
| `--pc-gold-hover` | gold darkened for hover and focus, and for gold **text** at AA contrast (≥ 4.5 : 1 on white; `#C39547` is decorative-only as text) |
| `--pc-text-strong` / `--pc-text-muted` | darker and lighter charcoal steps |
| `--pc-border` | warm hairline in the gold family (the thin gold rule and row dividers) |
| `--pc-success` / `--pc-warning` / `--pc-danger` | Pill colours seen in the tables: soft green "Verified", soft amber "Pending", red outline "Cancelled"; each paired with a label, never colour alone |

The current turquoise identity (`--pc-accent: #0f766e`, dark mode `#2dd4bf`) is
retired. The default is light. The present OS-driven dark mode turns the
product charcoal and turquoise; it is replaced by an intentional PalCert dark
variant (charcoal surfaces, same gold) or removed. **Decision D3.**

## 3. Current route inventory (48 pages, every one found in `apps/web/src/app`)

**Public / authentication:** `/[locale]` (home), `/login`, `/register`,
`/forgot-password`, `/reset-password`, `/verify-email`, `/mfa`, `/mfa/enroll`,
`/invitations/accept`, `/verify`, `/verify/[code]` (public certificate
verification, with its own layout), `/unauthorized`, `/forbidden`,
`/[...missing]`, plus `error.tsx` and two `not-found.tsx` files.

**Personal:** `/documents`, `/documents/[documentId]`, `/checks`,
`/checks/new`, `/checks/[checkId]`, `/certificates`,
`/certificates/[certificateId]`, `/submissions`,
`/submissions/[submissionId]`, `/balance`, `/balance/payment-return`,
`/balance/payment-cancelled`, `/notifications`, `/notifications/preferences`.

**Account:** `/profile`, `/sessions`.

**Organization:** `/organizations`, `/organizations/new`, and under
`/organizations/[organizationId]`: overview, `/profile`, `/team`,
`/invitations`, `/document-types`, `/standards`, `/standards/[standardId]`,
`/standards/[standardId]/versions/[versionId]`, `/submissions`,
`/submissions/[submissionId]`, `/certificates/[certificateId]`,
`/verification`, `/api-clients`, `/webhooks`, `/webhooks/[endpointId]`.

**Differences from the brief's list:**

- **There is no organization certificates list page, and no API to back
  one**, only `/organizations/[id]/certificates/[certificateId]`. Organization
  certificates are reached from their submission. See D2.
- **Personal `/submissions` exists**: the author's side of official
  submissions. It belongs in the personal section.
- **Public `/verify` exists** and nothing links to it.

## 4. Capability matrix

The permission column is what gates the page or its controls today. Every
value comes from `permissions.has(...)` in the page or `OrganizationNav`, and
the backend authorizes every request regardless.

| Route | Feature | User | Gate (UI courtesy; backend authoritative) | Current way in | Design pattern |
| --- | --- | --- | --- | --- | --- |
| `/[locale]` | Home: Phase 0 text, API health link, 2 links, locale switch | anyone | — | typed URL | Graduate Page hero → **Dashboard** |
| `/login`, `/register` | Sign-in, sign-up | signed out | — | home has none; cross-links only | `login.png`, `Sign up.png` |
| `/forgot-password`, `/reset-password`, `/verify-email` | Recovery, verification | signed out | — | link from login; email | Sign-up card |
| `/mfa`, `/mfa/enroll` | MFA challenge, enrolment | signing in | — | login flow; profile | Sign-up card |
| `/profile`, `/sessions` | Account, password, MFA, sessions | signed in | — | many "back" links; sessions only from profile | Graduate "Profile" |
| `/documents`, `/documents/[id]` | Documents, versions, upload, processing | signed in | — | **home only** | University table; Graduate upload zone |
| `/checks`, `/checks/new`, `/checks/[id]` | Checks, findings, SmartFix, AI review, billing, report | signed in | — | **list: no entry**; `new` from document pages | Graduate five-step flow; table |
| `/certificates`, `/certificates/[id]` | Personal certificates | signed in | — | **list: no entry anywhere** | Graduate "My Certifications" |
| `/submissions`, `/submissions/[id]` | My official submissions | signed in | — | home only | University table |
| `/balance` (+ return, cancelled) | Balance, holds, transactions, top-up | signed in | payments availability from `/api/health/payments` | **only from check billing** | Payment step's total styling |
| `/notifications`, `/preferences` | Inbox, preferences | signed in | — | floating bell | Graduate "Messages" |
| `/organizations`, `/organizations/new` | My organizations, create | signed in | — | switcher and invitation acceptance only | Sidebar "Universities" |
| org overview | Summary | member | `organization:profile:read` | org nav | University header |
| org `/profile` | Organization profile | member | read / `organization:profile:update` | org nav | Form card |
| org `/team` | Members, roles | member | `organization:member:read`; update, remove, `role:assign` | org nav | Employees table |
| org `/invitations` | Invitations | member | `member:read` / `member:invite` | org nav | Table |
| org `/document-types` | Document types | member | `standard:document-type:read` / `:manage` | org nav | Table |
| org `/standards/**` | Standards, versions, sources, extraction, proposals, rules, validation, publication | member | `standard:definition:read`, `:create`, `version:create`, `version:publish`, `rule:write`, `source:create`, `extraction:read/run`, `proposal:decide`, `organization:ai-consent:manage` | org nav | Table; step band for version lifecycle |
| org `/submissions/**` | Review queue, comments, decision | reviewer | `submission:review:read` (+ decide permissions in the API) | org nav | **Ministry approval table** |
| org `/certificates/[id]` | Organization certificate | member | backend | from a submission | Detail card |
| org `/verification` | Verification status and request | member | `organization:verification:read` / `:request` | org nav | Status card |
| org `/api-clients` | API clients, show-once secrets | admin | `integration:api-client:read` / `:manage` / `:secret:issue` | org nav | Table |
| org `/webhooks/**` | Endpoints, verification, deliveries, replay, rotation | admin | `integration:webhook:read` / `:manage` / `:replay` / `:secret:rotate` | org nav | Table |
| `/verify`, `/verify/[code]` | Public certificate verification | anyone | — | **no entry link** | Public page with wave |
| `/unauthorized`, `/forbidden`, not-found, error | System states | — | — | automatic | Card with wave |

## 5. Findings

**Features with no navigation entry**, reachable only by typing a URL:

- `/certificates`, the personal certificate list
- `/checks`, the checks list
- `/verify`, public verification
- `/organizations` (in practice): reached only through the switcher inside an
  organization, or after accepting an invitation
- `/balance`: only from a check's billing panel
- `/sessions`: only from Profile
- `/notifications`: only through the bell floating above every page
- `/profile`: only through back links on other screens

**Duplicated or fragmented navigation:**

- The only global header is a lone `NotificationBell` in `[locale]/layout.tsx`.
- The home page carries two ad-hoc links plus its own locale switch.
- Organizations have a second, separate horizontal nav (`OrganizationNav`) and
  their own switcher.
- Every page hand-writes its own "back to …" links.

**Visually inconsistent with the reference (all pages):**

- the turquoise accent, a system dark theme, and a 52 rem centred column (`.pc-page`)
- small, flat typography
- browser-default links
- raw forms floating on the page background
- a 951-line `globals.css` organised by phase (Phase 1, 2, 3, 7, 8 …)

**Pages requiring organization context:** everything under
`/organizations/[organizationId]/…`. `OrganizationShell` loads the profile and
memberships and derives permissions from `ROLE_DEFINITIONS` for that
organization only.

**Pages needing permission-aware visibility:**

- all organization sections (already filtered in `OrganizationNav`)
- per-control gates inside team, invitations, document types, standards,
  versions, API clients, webhooks, profile and verification (listed in §4)
- globally, the PalCert staff roles (`PALCERT_ADMIN`, `PALCERT_FINANCE`,
  `PALCERT_SUPPORT`, `PALCERT_AUDITOR`), which `/users/me` returns as roles and
  server-computed permissions

## 6. Old design personas → current PalCert

| Old persona | Current PalCert | Notes |
| --- | --- | --- |
| **Graduate** | Personal workspace: Documents, Checks, Certificates, Submissions, Balance, Notifications, Profile | "My Certifications → Verified / Pending / Refused" becomes Certificates filtered by **real backend states**. "Start Now" becomes Start a Check. |
| **University** | Organization workspace: overview, profile, team, invitations, document types, standards, submissions, verification, integrations | The organization name and logo area becomes the organization header. |
| **Ministry** | **No web equivalent today.** The nearest real workflows are the organization **submission review queue** (approve / reject, backed by the API and permissions) and the **PalCert staff API** (`/admin/organizations` verification queue, approve, suspend, reactivate; `/admin/users` roles; `/admin/finance`), which has no web UI | I will use the Ministry table language for the submission queue. Building a staff console is new web functionality. **Decision D1.** |

## 7. Proposed information architecture

```
PalCert                      [page title / org name]     🔔  EN|ع  [User ▾]
─────────────────────────────────────────────────────────────────────────
Dashboard                  │ Breadcrumbs
PERSONAL                   │ Page title                     Primary action
  Documents                │ description
  Checks                   │
  Certificates             │ …
  Submissions              │
  Balance                  │
  Notifications (n unread) │
ORGANIZATION               │
  [switcher: org name ▾]   │   ← only when the user belongs to ≥ 1 organization;
  Overview … Verification  │     links filtered by ROLE_DEFINITIONS for that org
  (+ Create organization)  │
INTEGRATIONS               │   ← org admins only (api-client / webhook read)
  API clients, Webhooks    │
ACCOUNT                    │
  Profile, Sessions        │   (language and sign-out also live in the user menu)
```

- The organization section follows the **last-used organization**, taken from
  the route when you are inside one, otherwise remembered in `localStorage`
  (a convenience only). Outside any organization it shows the switcher and the
  organizations list.
- **Search:** no global search API exists, so the topbar gets no search box.
  List pages get a filter field only where the list supports one (checks by
  status, notifications unread, and so on).
- **Counts** come only from real endpoints: the notification unread count
  (`/notifications/unread-count`); other counts only where a list response
  already carries them. No invented numbers.

## 8. Decisions needed before Stage 2

- **D1 — Ministry / PalCert staff console.** Build a `/admin` area for
  `PALCERT_ADMIN` / `FINANCE` / `SUPPORT` / `AUDITOR` over the **existing**
  admin APIs (organization verification queue and approve, suspend and
  reactivate; user roles; finance), gated by the permissions `/users/me`
  returns? It is the one place the Ministry screens map one-to-one. My
  recommendation is to **defer it to its own change**, because it is new
  functionality with its own tests and security review, and to use the
  Ministry language only for the organization review queue in this redesign.
- **D2 — Organization certificates list. Resolved by the code.** The API has
  no listing endpoint for organization certificates:
  `organizations/:organizationId/certificates` serves only `:certificateId`
  and `:certificateId/events`. So the organization navigation gets **no**
  "Certificates" entry, which would lead nowhere real. Organization
  certificates stay reached from the submission they belong to, with a clear
  "View certificate" action there. A list would need a new endpoint first; it
  is a separate change.
- **D3 — Dark mode.** Ship light only (the reference is light), or an
  intentional PalCert dark variant behind a System / Light / Dark control?
  Recommendation: **light only for v1 of the redesign.** OS dark mode no longer
  restyles the product, and a dark variant can come later as its own change.
- **D4 — Illustration.** The login illustration (person with laptop and
  documents) is a raster asset I don't have in reusable form. Recommendation:
  **reproduce the gold wave and lattice as inline SVG/CSS** (resolution-free,
  CSP-safe, no image weight), and use an original line-icon composition in
  PalCert gold in place of the illustration unless you can supply the source
  artwork.

## 9. Constraints carried into implementation

- `qa/journeys/*.mjs` (960-step matrix and release checks) select by role and
  accessible name, for example buttons matching `/sign in|log in|تسجيل|دخول/`,
  `/upload|new|add|create/` and `/sign out/`. The redesign keeps those
  names and roles. Any intentional change of wording updates the journeys in
  the same commit.
- CSP is frozen (`script-src 'self' 'unsafe-inline'`, `connect-src 'self'`,
  `style-src` as configured). So there are no external fonts or CDNs: fonts are
  system stacks with a proper Arabic stack, and artwork is inline SVG or CSS.
- Show-once secrets (API clients, webhooks) keep their existing components and
  must never enter shell or global state.
- Payments-disabled: no active top-up call to action when
  `/api/health/payments` reports disabled or unavailable (the Phase 20 fix).
- Permission filtering stays the existing pattern: organization permissions
  from `ROLE_DEFINITIONS` per membership, global permissions from `/users/me`.
  No new hand-written permission map.

## 10. Staging plan after approval

Stages 2–10 as specified, one commit per architectural unit:

1. tokens and base components
2. AuthShell and AppShell (sidebar, topbar, user menu, locale switch,
   notifications, organization context, drawer)
3. Dashboard
4. personal workflows
5. organization workflows
6. integrations
7. account and system pages
8. RTL, responsive and accessibility pass with the existing QA matrix
9. production-like verification with a web image under a temporary tag
   (`palcert/web:ui-shell-v1`), leaving release images untouched

No push to `main`, no force-push, no merge without approval.
