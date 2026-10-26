# PalCert UI — route and capability matrix

This checks the redesign on `ui/figma-product-shell-v1` against the Stage 1
inventory (`palcert-ui-stage1-audit.md` §3–4). Every route from that
inventory is still in `apps/web/src/app`, at the same URL, in both locales.

**Status values:**

- **redesigned**: new layout on the design system. The behaviour, API calls
  and controls are the same.
- **preserved**: unchanged page code. It takes the new look from the shared
  frame and components only.
- **moved**: the page is now reached from a different place.
- **permission-gated**: navigation offers the page only when the server says
  the user has the permission named. The API still authorises every request
  whatever the UI shows.

## Mechanical checks

Compared at three points: `origin/main` (`c951278`), the start of the
completion pass (`2c2639f`), and this branch's head. Each is a set of
distinct strings over `apps/web/src`, tests excluded.

| Check | `main` | `2c2639f` | head | Removed |
|---|---:|---:|---:|---|
| API client calls (`xxxApi.method(`) | 119 | 121 | 159 | none |
| Permission strings (`'area:object:action'`) | 34 | 45 | 70 | none |
| `data-testid="…"` hooks | 8 | 8 | 10 | none |
| Literal `href` targets | 27 | 40 | 50 | vs `main`: the Phase 0 health link (below); the standards-list link is still there, now built from a shared `base` variable |

The full endpoint-by-endpoint picture is in
[`palcert-api-ui-coverage.md`](./palcert-api-ui-coverage.md).

**The one link that went.** The old Phase 0 homepage printed a link to
`<api>/health/ready`. It was a developer placeholder, not a product
feature, and it was replaced when the homepage became the product landing
page. The endpoint is unchanged and still used by the proxy, Compose health
checks and monitoring.

## Public and authentication

| Route | Status | Way in now | Notes |
|---|---|---|---|
| `/[locale]` (signed out) | redesigned | typed URL; brand | Server-rendered landing page (SSR, metadata, OG). Accessible mobile menu below 68rem. |
| `/[locale]` (signed in) | redesigned | sidebar "Dashboard"; brand | Dashboard. Chosen server-side from session-cookie presence only. |
| `/login` | preserved | landing header and menu, AuthShell, every signed-out topbar | AuthShell (Stage 3). QA wording "Sign in" kept. |
| `/register` | preserved | landing "Create account", login cross-link | AuthShell |
| `/forgot-password`, `/reset-password` | preserved | login link; email | AuthShell |
| `/verify-email` | redesigned (errors) | email | Invalid token now shows `VERIFICATION_TOKEN_INVALID`, not a generic error. |
| `/mfa`, `/mfa/enroll` | preserved | login flow; profile | AuthShell |
| `/invitations/accept` | redesigned (errors) | email | Unknown token → `INVITATION_NOT_FOUND`. |
| `/verify`, `/verify/[code]` | **moved** (was unlinked) | landing header, mobile menu, footer, signed-out topbar | Public, own layout. Deliberately **not** in the authenticated sidebar. |
| `/unauthorized`, `/forbidden` | redesigned | automatic | `SystemMessage` card with a way back. |
| `not-found` (×2), `[...missing]`, `error.tsx` | redesigned | automatic | Real 404 status kept. |

## Personal workspace

| Route | Status | Way in now | Gate |
|---|---|---|---|
| `/documents`, `/documents/[id]` | redesigned · permission-gated · **moved** (was home only) | sidebar Personal › Documents | `document:read:self` |
| `/checks` | redesigned · permission-gated · **moved** (had no entry) | sidebar Personal › Checks | `check:read:self` |
| `/checks/new` | redesigned (step flow) | Checks list, document page, dashboard | — |
| `/checks/[id]` | redesigned | Checks list | Findings, SmartFix, AI review, billing, report all kept. |
| `/certificates`, `/certificates/[id]` | redesigned · permission-gated · **moved** (had no entry) | sidebar Personal › Certificates | `certificate:read:self` |
| `/submissions`, `/submissions/[id]` | redesigned · permission-gated · **moved** (was home only) | sidebar Personal › Submissions | `submission:read:self` |
| `/balance` (+ `payment-return`, `payment-cancelled`) | redesigned · permission-gated · **moved** (was billing only) | sidebar Personal › Balance | `balance:read:self`; top-up still follows `/api/health/payments` |
| `/notifications`, `/notifications/preferences` | redesigned · permission-gated | sidebar (real unread count), bell, inbox → preferences | `notification:read:self` |

## Account

| Route | Status | Way in now | Notes |
|---|---|---|---|
| `/profile` | redesigned | sidebar Account, user menu | Details, MFA status and set-up, **change password** (new card, gated on `password:change:self`, uses the existing `POST /auth/password/change`). Role and status show as labels, not codes. |
| `/sessions` | redesigned · **moved** (was profile only) | sidebar Account › Sessions | `session:read:self` |
| `/profile` (security) | **new cards** | — | Unconfirmed-email banner with **resend**; **turn off two-step sign-in** (password + current code, exactly what `DELETE /auth/mfa` asks; hidden when a role requires it); **AI agreement** with withdraw. |
| `/login`, `/register`, `/verify-email` | **resend added** | — | Resend confirmation with a 60 s cooldown and wording that never says whether an address exists. `/login` and `/mfa` accept a safe same-site `?next=` return path. |

## Organization workspace

Every page below also sits inside `OrganizationShell` (identity line and
verification badge). Section links come from `organizationSections()`,
filtered by that organization's role permissions from the server.

| Route | Status | Gate (nav) | Notes |
|---|---|---|---|
| `/organizations` | redesigned · **moved** (was switcher only) | signed in | Sidebar when outside an organization; switcher. |
| `/organizations/new` | redesigned | signed in | From the organizations list. |
| org overview | redesigned · permission-gated | `organization:profile:read` | Shows only real list totals, no invented counts. |
| org `/profile` | redesigned · permission-gated | read / `organization:profile:update` | Read-only users get a disabled fieldset. |
| org `/team` | redesigned · permission-gated | `organization:member:read` (+ update, remove, `role:assign`, **`role:remove`**, **`ownership:transfer`**) | DataTable. Each role tag can be removed (with confirmation); ownership hand-over card offers only active non-owners and sends the user to sign in again when the API asks for a recent sign-in. |
| org `/invitations` | redesigned · permission-gated | `member:read` / `member:invite` | DataTable |
| org `/document-types` | redesigned · permission-gated | `standard:document-type:read` / `:manage` | Status column header corrected. **Edit name/description** added. |
| org `/standards` | redesigned · permission-gated | `standard:definition:read` / `:create` | DataTable. Published and draft are visibly distinct (`versionTone`). |
| org `/standards/[id]` | redesigned · permission-gated | as above + `version:create`, `definition:update`, `definition:archive`, `check-availability:manage` | **Check-catalogue card** (private / public, add or withdraw), **edit, archive, restore**. New-version form hidden while archived. |
| org `/standards/[id]/versions/[vid]` | redesigned · permission-gated | `version:publish`, `version:update`, `version:archive`, `rule:write`, `source:*`, `extraction:*`, `proposal:decide`, `ai-consent:manage` | Draft banner vs published banner. Every lifecycle action kept. **Added:** edit draft, archive, published-snapshot download, source download, rule provenance. |
| org `/submissions` | redesigned · permission-gated | `submission:review:read` | Review queue |
| org `/submissions/[id]` | redesigned · permission-gated | review read (+ decide permissions in the API) | Technical determination and institutional decision are separate cards. Decision history is a timeline. |
| org `/certificates` | **new** · permission-gated | `certificate:record:read` | The register, on the new `GET /organizations/:id/certificates` (search by number, standard or document type; status filter; cursor paging). Issued, unrevoked rows download their PDF. |
| org `/certificates/[id]` | redesigned | backend | Reached from its submission or the register. |
| org `/verification` | redesigned · permission-gated | `organization:verification:read` / `:request` | |

## Integrations

| Route | Status | Gate (nav) | Notes |
|---|---|---|---|
| org `/api-clients` | redesigned · permission-gated · **moved** (own sidebar group) | `integration:api-client:read` / `:manage` / `:secret:issue` | The secret is shown once, in a panel, and never re-fetched. Idempotency keys unchanged. |
| org `/webhooks` | redesigned · permission-gated · **moved** | `integration:webhook:read` / `:manage` | |
| org `/webhooks/[id]` | redesigned · permission-gated | `:manage` / `:replay` / `:secret:rotate` | Verification, deliveries (header count fixed), replay and rotation all kept. The signing secret is shown once. SSRF checks and delivery authority stay server-side and are untouched. **Added:** rename, management log. |

## Staff administration (new)

Reached from the sidebar's *Administration* group, which exists only when
the signed-in user holds a global staff permission. Every page repeats the
check (`AdminGate`) and the API authorises every request regardless.
Actions that change something open a dialog, ask for a reason where the API
takes one, and show a sign-in-again path on `REAUTHENTICATION_REQUIRED`.

| Route | Gate | Content |
|---|---|---|
| `/admin` | `admin:organization:read` + `admin:user:read` | Real counts from `GET /admin/overview` (organizations by status and verification, pending requests, users by status), with links into the queues. |
| `/admin/organizations` | `admin:organization:read` | All organizations, or the verification queue (`?view=queue`). |
| `/admin/organizations/[id]` | read; `:verify`, `:suspend` for actions | Detail from `GET /admin/organizations/:id` (real member count), verification history (internal notes only with `:verify`), approve / reject, suspend / reactivate. |
| `/admin/users` | `admin:user:read` | Accounts, newest first, search by part of an email or name. |
| `/admin/users/[id]` | read; `:suspend`, `admin:role:grant` / `:remove` | Account detail, suspend / reactivate, grant or remove global roles (never `API_CLIENT`; no actions on one's own account). |
| `/admin/finance` | `finance:*` | Prices (draft, activate, retire), ledger integrity check, refund look-up, customer look-up. |
| `/admin/finance/customers/[userId]` | `finance:*` | Balance, adjustment (reason code + note), payments with refund, purchases. |

No password reset, impersonation or role bypass: the API has none.

## Capabilities with an API but no Web UI

None that a person needs. The remaining 28 endpoints without a page are
machine integrations, probes, provider callbacks, or single-item reads
whose data the UI already receives from a list; each is named with its
reason in [`palcert-api-ui-coverage.md`](./palcert-api-ui-coverage.md).

## Certificate attestation routes

Added with the attestation feature ([architecture](../architecture/attestations.md)).
All are in both locales and right-to-left in Arabic.

| Route | Who | Gate |
|---|---|---|
| `/[locale]/attestations` | certificate holder | `attestation:read:self` (personal navigation) |
| `/[locale]/attestations/new` (`?draft=`, `?renew=`) | certificate holder | `attestation:submit:self` |
| `/[locale]/attestations/[requestId]` | certificate holder | `attestation:read:self` |
| `/[locale]/organizations/[organizationId]/attestations` | institution | `attestation:request:read` (organization navigation) |
| `/[locale]/organizations/[organizationId]/attestations/[requestId]` | institution | `attestation:request:read`; actions by `…:review`, `…:approve`, `attestation:record:revoke` |
| `/[locale]/organizations/[organizationId]/attestation-types` | institution | `attestation:type:manage` (organization navigation); fee by `attestation:fee:manage` |
| `/[locale]/organizations/[organizationId]/attestation-revenue` | institution | `attestation:finance:read` (linked from the queue) |
| `/[locale]/admin/attestations` | PalCert staff | `admin:attestation-finance:read` (staff navigation) |
| `/[locale]/admin/organizations/[organizationId]/attestation-commission` | PalCert staff | read: `admin:attestation-finance:read`; change: `admin:attestation-commission:manage` |
| `/[locale]/verify/attestation/[token]` | anyone | public, no sign-in |
