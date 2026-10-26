# Phase 20 — Checkpoint 7: Final Security & Configuration Hardening Report

The last security pass before release QA. It began as a read-only audit of the
production security and configuration surface; nothing was changed until the
audit named a specific gap, and every change below is traceable to one.

Nine defects were found. One of them would have made a deployed PalCert
unusable in a browser and no existing check could have seen it, because every
release check to date is a server-side `curl`.

**Frozen base:** Checkpoint 20.6 at `41c3f24`.
**Verified on:** the five images rebuilt from this tree, deployed by digest
behind the release proxy over TLS.

---

## 1. Configuration inventory

`scripts/security/audit-config.mjs` reconciles it mechanically rather than by
reading, and fails the build when it does not balance.

| | |
| --- | --- |
| Declared in `packages/config/src/env.schema.ts` | **165** |
| Consumed by code | **165** — every one |
| Read by production code but undeclared | **0** |
| Declared and read by nothing | **0** |
| Read only by test scaffolding | 5, listed separately |

The five test-only variables — `CLAMAV_INTEGRATION`, `DRILL_CAPABILITY_OUT`,
`PALCERT_LIVE_AI_TEST`, `PALCERT_LIVE_STRIPE_TEST`,
`STORAGE_ENFORCES_SIGNATURES` — live in `apps/api/test/**` and reach no
runtime. They are inventoried rather than ignored precisely because one of
them switches off signature enforcement: a variable like that belongs in the
record even when it is unreachable from production.

**No dead security-looking variable remains.** The Phase 20.1 audit's F-002
(`AUTH_SESSION_SECRET`, required by config and read by nothing) was the last
of those and closed in 20.2; this checkpoint's contribution is the check that
stops another appearing.

### Per process, which is where a defect was hiding

"Declared somewhere in the schema" is not "declared in the schema *this
process* validates", and the audit now distinguishes them. The API, worker and
migrate job all validate `apiEnvSchema` at boot and share one surface. The
Next.js web server has no startup hook where a schema could run, so its eight
direct reads are enumerated with the reason each is permitted:
`NEXT_PUBLIC_API_URL`, `NEXT_PUBLIC_APP_NAME` and `NODE_ENV` are validated by
`webEnvSchema`; `APP_VERSION`, `APP_COMMIT` and `APP_BUILT_AT` are build
labels; `METRICS_ENABLED` and `METRICS_TOKEN` are read at the point of use. A
ninth, undocumented, fails the audit.

The document engine validates its own settings through pydantic under a
`DOC_ENGINE_` prefix — a separate namespace, separately validated.

### Classification

Required in production: 12 (11 before this checkpoint, plus
`API_TRUSTED_PROXIES`). Everything else carries a schema default. Production
adds eleven cross-field refusals on top — TLS storage, encryption at rest, a
real malware scanner, Argon2 floors, no wildcard CORS, no API explorer, no
pretty logging, no `SameSite=None`, an https public URL, distinct request and
admin database roles, and now a stated proxy trust model.

---

## 2. `PAYMENTS_ENABLED=false` — fixed

**The defect.** The provider factory ignored the flag and constructed whatever
`PAYMENT_PROVIDER` named. That defaults to `stripe`, so an installation which
had simply never configured payments got the Stripe adapter built during
module initialization, where it threw for want of a secret key. The API did
not start. A feature switch that requires the credentials of the feature it
switches off is not a feature switch, and §111 says a deployment without
payments is supported.

**The fix.** `DisabledPaymentProvider` stands in when payments are off: no
credential, no client, no network. Every operation answers `PAYMENTS_DISABLED`
at HTTP 503 with the operation named. It reports capabilities honestly rather
than claiming none exist, and keeps readiness green — a deliberately disabled
feature is not an outage and must not take an instance out of the load
balancer. The disabled branch is checked *before* the provider name, because
the deployment that was failing is exactly the one that left
`PAYMENT_PROVIDER` at its default.

| Case | Result |
| --- | --- |
| enabled + valid provider | Stripe adapter constructed |
| enabled + missing credential | refused at boot, naming `STRIPE_SECRET_KEY` |
| enabled + `fake` in production | refused — the double must never confirm payments nobody made |
| **disabled + no credentials** | **starts**, resolves `DisabledPaymentProvider` |
| disabled + payment operation | 503 `PAYMENTS_DISABLED`, deterministic, operation named |
| disabled + existing records | balance, ledger and top-up unchanged and readable |

Ten unit tests drive the real Nest module, so a *boot* failure is caught where
it happens; six of them fail without the fix. The e2e runs in two phases
against one database — fund a balance through the real webhook and settlement
path with payments on, then reboot the whole application with payments off and
ask what became of it. Every ledger entry identical in id, amount and type;
the top-up still `SUCCEEDED`; a new top-up refused; a payment webhook refused
rather than parsed. No pricing or ledger rule was touched.

---

## 3. Boolean and coercion audit

Checkpoint 20.2 found `AI_ENABLED` declared as `z.coerce.boolean()`, where
`"false"` becomes `true` because every non-empty string is truthy. This swept
the whole production configuration layer for the same shape.

The sweep is table-driven off the schema source, so a boolean added later is
covered the day it lands, and it asserts up front that it found some — an
empty sweep cannot pass. **9 booleans × 7 cases**, plus a standing rule that no
boolean may be declared with a coercing parser.

| Input | Behaviour |
| --- | --- |
| `true`, `1` | true |
| `false`, `0` | false |
| absent | the declared default |
| empty string | **refused** — a container that sets `ENV X=${X}` with no build argument produces one, and guessing is how this class of bug starts |
| `no`, `off`, `yes`, `on`, `disabled`, `enabled`, `TRUE`, `False`, `2`, `" true"` | **refused**, and asserted never to resolve to `true` |

**No security-sensitive boolean can be turned on by a non-empty string.** Two
further defects came out of writing it.

### 3a. Configuration errors echoed the value — **HIGH, fixed**

`loadEnv` documented that raw values never appear in what it throws. They did:
Zod reports a rejected enum as `received '<value>'`, and that went straight
into a `ConfigurationError` thrown at boot, printed to stderr and collected by
whatever ships container logs. Every enum field was affected — all nine
booleans plus `LOG_LEVEL`, `MALWARE_SCANNER`, `AUTH_COOKIE_SAMESITE`,
`PAYMENT_PROVIDER` and the provider selectors.

The realistic path to harm is not an attack. It is an operator pasting a key
into the wrong variable and finding it in the startup log of every replica, in
plaintext, for as long as logs are kept.

Messages are now scrubbed in two passes: the `received …` clause is rewritten
for every field regardless of name — the value needing protection is usually
in a field nobody would call sensitive — and values supplied under a
sensitive-looking name are removed from hand-written refine messages. The
first attempt scrubbed every supplied value of four characters or more, which
meant `NODE_ENV` supplied the string `production` and ten messages that
legitimately end "in production" came back reading "in [REDACTED]". A
redaction that destroys the sentence an operator needs has traded one problem
for another, so pass two is limited to sensitive keys.

### 3b. A web toggle accepted anything — **MEDIUM, fixed**

`metricsEnabled()` in the Next.js server was `X !== 'false' && X !== '0'`,
which accepts every other string: `METRICS_ENABLED=no` left telemetry on, with
no error. The 20.2 defect with its sign flipped. It now uses a strict parser
shared with the schema, and an unrecognized value resolves to **off** —
someone who put a value in that variable was trying to control an exposure
surface, and an unreadable instruction about one should not be read as "expose
it".

---

## 4. Secret matrix

Ten secret-shaped variables, reconciled across the config schema, the
deployment topology, the Checkpoint 20.4 recovery requirements, the release
workflows and the secret scanner.

| Secret | Required | Consumed by | In deployment topology | In recovery preflight | Scanner |
| --- | --- | --- | --- | --- | --- |
| `POSTGRES_PASSWORD` (admin/owner URL) | production | migrate, preflight | yes | yes | yes |
| `POSTGRES_APP_PASSWORD` (request-path URL) | production | api, worker | yes | yes | yes |
| `STORAGE_ACCESS_KEY_ID` | always | api, worker | yes | yes | yes |
| `STORAGE_SECRET_ACCESS_KEY` | always | api, worker | yes | yes | yes |
| `AUTH_MFA_SECRET_KEY` | always | api | yes | yes | yes |
| `CERTIFICATE_VERIFICATION_SECRET_KEY` | always | api, worker | yes | **yes** — restored certificates are unverifiable without it | yes |
| `API_CLIENT_REVEAL_SECRET_KEY` | always | api | yes | yes | yes |
| `WEBHOOK_ENCRYPTION_KEYS` + `…_ACTIVE_KID` | when webhooks are used | api, worker | yes | **yes** — restored ciphertext names the key that sealed it | yes |
| `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET` | only when payments are on | api | yes | n/a | yes |
| `NOTIFICATION_SMTP_PASSWORD` | when SMTP is the provider | api, worker | yes | n/a | yes |
| `ANTHROPIC_API_KEY` | when AI is on | api, worker | yes | n/a | yes |
| `METRICS_TOKEN` | optional second lock | api, web | yes | n/a | yes |

**Redis** is unauthenticated on the deployment network and carries no
credential; that is the topology's choice and is recorded rather than implied.
There is no separate session key: sessions are random tokens stored as hashes,
so there is nothing to rotate — which is why F-002 could delete
`AUTH_SESSION_SECRET` without replacing it.

Every key the restored data needs to be *usable* — not merely present — is in
the deployment preflight: a restored database whose certificates cannot be
verified and whose webhook secrets cannot be decrypted is a restore that
looks successful and is not.

---

## 5. Secret-leakage tests

| Surface | Result |
| --- | --- |
| source scan (gitleaks) | clean |
| OCI layers | clean, all five images |
| image config / environment | clean, all five images |
| **negative self-test** | a planted credential in image config and a planted `.env` in a layer are **both detected**; a clean image still passes |
| configuration errors | fixed this checkpoint — §3a |
| release manifest | asserted secret-free by `release-topology.spec.ts` |
| backup manifest | asserted by the 20.4 suite |
| telemetry | no identifier in the exposition; asserted under load in 20.6 and again here |

The negative self-test is what makes the clean results mean anything. A
scanner that has only ever returned clean is a scanner nobody has tested.

---

## 6. Authentication audit

Reviewed, not redesigned; no concrete defect was found, so nothing changed.

| Surface | Expiry | Revocation | Replay | Non-enumerating | Rate limited | Storage |
| --- | --- | --- | --- | --- | --- | --- |
| human login | idle + absolute | logout, logout-all | n/a | identical answer for unknown and wrong | per-IP **and** per-account | Argon2id, floors enforced in production |
| password reset | TTL | single use | consumed on use | identical answer whether or not the address exists | per-account | hashed token |
| email verification | TTL | single use | consumed on use | — | per-account | hashed token |
| sessions | idle + absolute, shorter for privileged | per-session and bulk | — | — | — | SHA-256 of a 128-bit random token |
| API clients | optional `expiresAt` | revocation recorded | — | wrong secret indistinguishable from unknown client | distributed, Redis | hashed verifier |
| public certificate capability | none by design | certificate revocation | — | absent code and wrong route stay distinguishable in tests, identical in responses | 60 per IP per 15 min | `sha256(canonicalCode)` only — the code is never stored |

The standing gap is F-014, no bulk session invalidation under a
credential-compromise incident. Unchanged, still POST-V1.

---

## 7. Cookies and CSRF

`palcert_session` is `HttpOnly`, `Secure` in production, `SameSite` from
configuration (`lax` by default, `none` refused in production), `Path=/`, and
expires with the session. `palcert_csrf` is identical except deliberately
readable, because the browser client has to copy it into a header; knowing it
grants nothing on its own.

CSRF has two independent layers and neither is `SameSite`:

1. **An Origin/Referer allow-list on every unsafe request**, whether or not a
   session exists. This is what stops *login* CSRF, where an attacker plants
   their own session in a victim's browser — a synchronizer token cannot help
   there, because no session exists yet.
2. **A session-bound synchronizer token**: the CSRF cookie's value must be
   echoed in `x-csrf-token` and must match the digest on the session row. An
   attacker can cause the cookie to be *sent* but cannot *read* it.

`SameSite=Lax` is defence in depth, treated as such: it is a
browser-version-dependent default, does nothing for non-browser clients, and
still permits top-level cross-site GETs.

Proved through the proxy rather than asserted: a state-changing request from
`https://attacker.example` is refused **403 `CSRF_INVALID`** — not merely
blocked in the browser after the fact, which is all CORS would do.

Exempt paths, each for a reason rather than a convenience: provider-signed
webhooks (an HMAC over the raw body, verified before anything happens) and
machine-only routes (a credential on every request, no ambient authority, so
the attack CSRF prevents does not exist).

---

## 8. CORS

Configured origins only, credentials enabled, **wildcard refused in production
by the schema** and structurally impossible besides — the allow-list is
compared by exact origin, so `*` would match nothing rather than everything.

| Through the real proxy | Result |
| --- | --- |
| configured origin | echoed, with `Allow-Credentials: true` |
| arbitrary origin | **no `Allow-Origin` header at all** |
| any origin | never `*` |
| preflight, allowed origin | answered |
| preflight, arbitrary origin | no header |

Local development is separately configurable and defaults to
`http://localhost:3000`.

---

## 9. Proxy and header trust — **HIGH, fixed**

**The defect.** `app.set('trust proxy', 1)` meant one hop, from anybody.
Behind the release proxy it produced the right answer, because nginx appended
the real socket address last and Express reads that entry. It also meant any
caller able to open a connection to the API port directly was trusted for a
hop — which is not hypothetical: Checkpoint 20.6's load generator used exactly
that to present 131 072 distinct client identities to a rate limiter.

It matters because `req.ip` is not cosmetic. It decides the per-IP login
throttle and the per-IP public-verification guard, and it is stored on every
audit record. An audit trail that keeps whatever the client claimed is worse
than one that keeps nothing, because it looks authoritative.

**The fix, in two halves.**

`API_TRUSTED_PROXIES` names the upstreams permitted to speak for a client.
Unset means believe nobody — `req.ip` is the socket address and a forwarded
header is ignored entirely. Production must state it, because production is
behind a proxy by definition: it is required to serve https and PalCert does
not terminate TLS. Leaving it unset there would collapse every visitor onto
the proxy's address and throttle the world as one client, so the schema
refuses it.

The release proxy now **overwrites** forwarding headers rather than extending
them. `$proxy_add_x_forwarded_for` appends to whatever the client sent, so a
forged header produced a two-entry list with the attacker's value first;
reading the last entry happened to be correct, which made the whole thing
depend on a subtlety nobody should have to re-derive. `$remote_addr` leaves
one address, the one this proxy observed. `X-Forwarded-Host`,
`X-Forwarded-Port` and the RFC 7239 `Forwarded` header are set too — unset,
they passed through from the client untouched.

| Claim | Proof |
| --- | --- |
| a forged `X-Forwarded-For` cannot buy a fresh throttle budget | through the proxy, 70 requests each claiming a different address, refusals begin — measured |
| a forged `X-Forwarded-Host` cannot alter host behaviour | `attacker.example` appears nowhere in the response |
| a forged `X-Forwarded-Proto` cannot downgrade a secure-origin decision | HSTS still present when the client claims `http` |
| the audit record holds the real address | with no trusted proxy, `203.0.113.99` never reaches a security event |
| a trusted upstream *is* believed | the control — without it, "nobody was distinguished" would also be satisfied by a broken route |
| a client-prepended entry is not the one used | a left-hand forgery ahead of the proxy's entry is ignored |

Reverting `trust proxy` to `1` fails two of the nine e2e tests, so they test
the model rather than the route.

**Direct and internal access, stated separately.** Inside the deployment
network the API is addressable directly, and `uniquelocal` makes that network
a trusted upstream — so a container on it *can* assert a client address. That
is the deployment's stated model, not an oversight: the claim being made is
"the outside cannot forge", and the topology (no published API port; the proxy
is the only published surface) is the control for the inside. A deployment
that wants more should name the load balancer's own addresses, which the
variable accepts and the documentation recommends.

**Checkpoint 20.6's distributed rate-limit tests still pass** under the
narrower model — `perf/safety-under-load.sh` proves one client gets one budget
across two replicas, now without relying on a forgeable header.

---

## 10. HTTP security headers

Measured on real responses through the release proxy over TLS, not read from
config.

| Header | Web origin | API |
| --- | --- | --- |
| `Content-Security-Policy` | full policy, §11 | `default-src 'none'`, `frame-ancestors 'none'`, `base-uri 'none'` |
| `Strict-Transport-Security` | `max-age=31536000; includeSubDomains` | same |
| `X-Content-Type-Options` | `nosniff` | `nosniff` |
| `Referrer-Policy` | `no-referrer` | `no-referrer` |
| `X-Frame-Options` | `DENY` | — (JSON) |
| `Permissions-Policy` | `camera=(), microphone=(), geolocation=(), payment=()` | — |
| `X-Powered-By` | absent | absent |

HSTS is production-only and declared beside the other static headers so it
covers the paths the locale middleware skips. On plain HTTP a browser ignores
it, and in development it would pin `localhost` to https in a developer's own
browser for a year.

Nothing was cargo-culted: `X-Frame-Options` is kept *alongside*
`frame-ancestors` rather than replaced by it, because they serve different
browser generations and cost nothing together.

---

## 11. CSP — **F-007 closed**

The Checkpoint 20.1 audit raised that the only HTML origin PalCert serves —
the one rendering user-supplied document metadata and carrying the session
cookie — had neither a CSP nor HSTS. It now has both.

The policy is derived from what the application actually loads. PalCert's web
tier is unusually easy to write one for: no CSS-in-JS, no `next/font`, no
analytics, no embedded widget, no CDN, four runtime dependencies. So every
directive starts at `'none'` and only what is demonstrably needed is opened.

```
default-src 'none'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline';
img-src 'self' data:; font-src 'self'; connect-src 'self'; object-src 'none';
frame-src 'none'; frame-ancestors 'none'; form-action 'self'; base-uri 'none';
manifest-src 'self'; worker-src 'self'; upgrade-insecure-requests
```

**`unsafe-eval` is absent in production**, which is the hard requirement. The
development server needs it for fast refresh; both policies are derived in one
place so production cannot inherit the dev one by accident.

### Why there is no nonce

A nonce-based `script-src` with `'strict-dynamic'` was built first and then
measured in a browser, which is how it was rejected. The two dynamic routes
rendered with every script nonced and zero violations. Every one of the
twenty-three prerendered routes refused all seventeen of its own scripts: a
per-request nonce cannot be written into HTML generated at build time, and
`'strict-dynamic'` made it worse by disabling the `'self'` allowance that
would otherwise have carried them.

Making every route dynamic would fix it, and that is a rendering-architecture
change to twenty-three pages, not a hardening change. So the v1 policy ships
with `'unsafe-inline'` for scripts and **no nonce in the header at all** — a
browser ignores a nonce when `'unsafe-inline'` is present, and shipping one
anyway would make the policy look stronger than it is.

**What that costs, precisely:** an injected `<script>` in the page would
execute. **What it does not cost:** everything else. `default-src 'none'`
denies each directive nobody opened; `object-src`, `base-uri` and
`frame-ancestors` are `'none'`; `form-action` and `connect-src` are
same-origin. The usual escalation paths out of an injection — exfiltrate to an
attacker host, retarget every relative URL, frame the app, post the form
elsewhere — are shut.

**P-015 is preserved explicitly: a strict nonce or hash CSP for prerendered
Next.js pages is post-v1.**

No API or client secret appears in frontend-visible configuration: the only
`NEXT_PUBLIC_*` values are the API base, the app name and the default locale.

---

## 12. The web image could not reach its API — **RELEASE BLOCKER, fixed**

`NEXT_PUBLIC_*` values are inlined into the client bundle at build time.
`docker/web.Dockerfile` defaulted `NEXT_PUBLIC_API_URL` to
`http://localhost:4000`, and neither the release workflow nor CI passed a
build argument — so **every published web image carried that literal string,
and every browser API call from a deployed PalCert would have gone to port
4000 on the visitor's own machine.**

Nothing caught it because every release check is a server-side `curl`, and
"`/en` returns 200" is satisfied by server-rendered HTML that has not yet made
a single API call. It surfaced here only because the CSP work put the built
application in a real browser for the first time.

The fix is the topology PalCert already has: the proxy serves the API under
`/api/` on the web app's own host, which is why the session cookie is
first-party and why the CSRF origin check has anything to compare against. The
client base is now empty — same origin — with the build argument retained for
a deployment that genuinely splits the two.

Two regressions guard it:

- **`check-client-bundle.mjs`** greps the built client assets for prohibited
  placeholders. Rebuilt with the old default it reports the localhost API base
  and exits 65; on this tree it is clean. Wired into CI against the assets
  copied out of the built image, because the image is what ships.
- **`browser-security.mjs`** drives the final web image through the proxy in
  Chromium across five route shapes — prerendered, prerendered RTL, a
  prerendered authenticated surface, a dynamic public certificate page, an
  authenticated route. Every page rendered, **zero CSP violations**, and every
  API call same-origin under `/api/` with no request anywhere to
  `localhost:4000`.

---

## 13. Upload and parser boundary

Re-run against real negative fixtures, 91 tests across
`documents-security`, `documents-storage`, `documents-lifecycle`,
`analysis-lifecycle` and `pdf-checks`.

| Case | Behaviour |
| --- | --- |
| fake extension | rejected on detected format, not on the name |
| wrong MIME claim | rejected — the claim is not trusted |
| malformed DOCX | rejected, quarantined, never promoted |
| malformed PDF | rejected, quarantined, never promoted |
| oversized file | refused against `UPLOAD_MAX_DOCX_BYTES` / `UPLOAD_MAX_PDF_BYTES` |
| archive abuse | bounded by entry count, entry size, total size and compression ratio |
| malware-positive object | quarantined and purged; never promoted to the clean bucket |
| parser timeout / resource limit | bounded by `INGEST_*` and `DOC_ENGINE_*` timeouts |

Rejected objects stay in the quarantine bucket and are never promoted —
asserted at the storage level, not inferred from a status code. Document
contents never enter logs: the exposition and the log fields carry ids and
outcomes, never bytes or extracted text.

Malicious document content is treated as data throughout. The analyzers parse;
nothing evaluates, expands external entities or follows an embedded reference.

---

## 14. SSRF

Phase 17's protections re-run unchanged — **84 tests**, nothing weakened.

Blocked on every outbound path: loopback, RFC 1918, link-local (including
`169.254.169.254` and the cloud metadata endpoints), unique-local and
IPv4-mapped IPv6 equivalents, redirects that land on any of them, and DNS
results that resolve to them. Port is restricted by `WEBHOOK_ALLOWED_PORTS`
(443 by default). Resolution happens once and the resolved address is what is
connected to, which is what closes the rebinding window the existing defence
covers.

Citation and DOI processing has no network access and none was added.

---

## 15. Authorization and RLS

**697 tests** in the named security suite, of which **233** are isolation.

The existing suites drive HTTP, which proves the guards work. It does not
prove isolation — a guard is one `if` away from being wrong, and an ORM query
missing a `where` passes straight through it. So `security-rls-matrix.e2e-spec.ts`
becomes the role the API connects as and asks the database directly, for the
domains that had no such proof.

| Domain | HTTP | Direct application-role SQL |
| --- | --- | --- |
| documents | yes | **yes** — owner sees 1, stranger 0, partner organization 0, no context 0 |
| private checks (`document_checks`, `check_runs`) | yes | **yes**, new this checkpoint |
| finance (accounts, ledger) | yes | **yes**, new this checkpoint |
| API clients (+ `api_client_secrets`) | yes | **yes**, new this checkpoint |
| submissions | yes | yes (`submissions-database`) |
| certificates | yes | yes (`certificates-database`) |
| webhooks | yes | yes (`webhooks-system-authority`) |
| every tenant-scoped table | — | `tenant-rls-coverage`: RLS enabled **and** FORCEd **and** carrying a policy, 0 exceptions |

Every fixture is built through real HTTP workflows — inserting rows with the
admin role would test the policy expression against data that never went
through the code that writes it. Every "sees nothing" has a paired "the owner
sees it" control, because zero rows is also what a broken connection, a
mistyped table and an empty fixture produce.

---

## 16. API-client regression (Phase 19)

68 tests, re-run under the final deployment and after the proxy-trust change.

Revoked credential refused; expired credential refused; a wrong secret
indistinguishable from an unknown client; scopes enforced per operation;
cross-organization IDOR structurally impossible because the tenant comes from
the credential and there is no parameter naming one; secrets absent from logs
and from the exposition; rotation race safe; **distributed throttling intact**
— `rate-limit-distribution` passes, and the cross-replica proof in
`perf/safety-under-load.sh` no longer depends on a forgeable header.

---

## 17. Webhook and keyring regression

98 tests. Keyring required at startup when webhooks are configured; signing
over raw bytes; rotation with every ciphertext naming the key that sealed it;
SSRF as §14; replay and idempotency (at most one original delivery per
endpoint per event); secret redaction in logs, in the API surface and in
telemetry.

Historical encrypted state from the Checkpoint 20.4 recovery fixture is
carried through `notifications-recovery`, which is the test that makes the
keyring requirement real: a restored installation whose webhook ciphertext
names a key the deployment no longer supplies is a restore that looks
successful and is not.

---

## 18. Financial and certificate invariants

Re-run, not redesigned. **95 finance tests, 53 certificate tests.**

Append-only ledger; no overspending under concurrency; no duplicate capture;
a failed or cancelled payment charges nothing; an institution cannot see a
member's personal billing data. No real payment service is called — the double
behind the real port, which production configuration refuses.

Certificates: only an authoritative COMPLIANT **and** APPROVED decision can
issue; advisory AI evidence can neither grant nor revoke eligibility; the
capability lookup is a single indexed equality on a hash and is
non-enumerable; the verification code is stored only as
`sha256(canonicalCode)` and is never returned by any surface; report and
certificate hashes unchanged.

---

## 19. Container hardening

All four runtime stages already ran as the unprivileged `palcert` user, each
exposing only its own port, each with a health check, none carrying a package
manager or build toolchain (verified by the runtime gate on the final images).

Added: `no-new-privileges` and `cap_drop: ALL` on every PalCert-owned service.
None of them needs setuid or any default capability — not CHOWN, not
SETUID/SETGID, and not NET_RAW, which is the one that makes packet spoofing
possible from a compromised container.

**One real limit, recorded rather than worked around.** nginx's entrypoint
starts as root, chowns its cache directories and drops to the nginx user, so
with every capability dropped the proxy crash-looped on
`chown("/var/cache/nginx/client_temp") failed (Operation not permitted)`. It
gets CHOWN, SETUID and SETGID back — arrived at from the failure, not guessed
— and everything else stays gone.

PostgreSQL, Redis, MinIO and ClamAV are deliberately left alone: third-party
images whose entrypoints change user and adjust ownership, and breaking the
database in order to harden it would be a poor trade. A managed deployment
runs them as managed services.

A read-only root filesystem was **not** imposed: PalCert needs controlled
writable paths, and the checkpoint says not to make that a requirement.

Only the proxy publishes a port. Everything else is reachable only on the
deployment networks.

---

## 20. Database hardening

| Property | Result |
| --- | --- |
| application role | not superuser, no BYPASSRLS, no CREATEDB, no CREATEROLE; SELECT/INSERT/UPDATE/DELETE only, on application tables only |
| backup role | isolated; BYPASSRLS **only** as documented, which PostgreSQL requires to read FORCE-RLS tables; no write grant; owns nothing; cannot mutate the schema |
| migration/admin role | separate; production configuration refuses a deployment whose request-path and admin connections are the same role |
| application superuser | none |
| SECURITY DEFINER functions | 64, **every one** with `search_path` pinned |
| PUBLIC table grants | 189 — all of them PostgreSQL's own catalogs and `information_schema`; **no application table** |
| PUBLIC function execute | **0 after this checkpoint** (was 44) |

### The backup role could write through PUBLIC-executable functions — **HIGH, fixed**

PostgreSQL grants EXECUTE on every new function to PUBLIC by default. For
ordinary functions that is harmless; for PalCert's sixty-four `app_*`
functions it is not, because they are SECURITY DEFINER — they run as the
schema owner — and several of them write: `app_certificate_issue`,
`app_webhook_config_create`, `app_notification_create`,
`app_submission_finalize_revision`.

That made the backup role's contract escapable. It holds no write grant
anywhere, which the verifier already asserted, but it could connect and PUBLIC
could execute — so a leaked backup credential could have called a definer
function and written through it. **A read-only role that can issue a
certificate is not read-only.**

The migration revokes the default and grants explicitly to the application,
with `ALTER DEFAULT PRIVILEGES` carrying the rule forward so a function added
later is not quietly public the day it lands. Measured after: **PUBLIC 0,
application 151, backup role 0.** `verify-backup-role.mjs` now asserts that
last number, so the contract cannot be loosened again silently.

---

## 21. Production debug behaviour

Tested through public ingress.

| | |
| --- | --- |
| stack traces | none — a malformed body answers `VALIDATION_FAILED` and nothing else |
| SQL or driver errors | none; no `prisma`, `postgres`, `SELECT` or path fragment in any response |
| debug endpoints | none |
| `/metrics` externally | **404** — not 403, so the outside cannot tell it exists |
| `/metrics` internally | 200, where a scraper runs |
| Swagger / API explorer | **404** — `API_DOCS_ENABLED` is refused as true in production |

---

## 22. Error and logging review

Security-sensitive failures map to named, client-safe codes with a correlation
id preserved on every one: authentication failure (identical answer for
unknown and wrong), authorization failure (404 where existence itself is the
secret, 403 where it is not), database failure (`SERVICE_UNAVAILABLE`, no
driver text), provider failure (a PalCert failure kind, never an SDK error),
parser failure and malformed document (a named ingest code, never parser
internals), missing resource (`NOT_FOUND`).

Operators get the detail through `internalContext`, which is logged and never
serialized to a client — the split that lets an error be useful without being
useful to an attacker.

---

## 23. P-014 — worker memory

Checkpoint 20.6 measured the worker rising ~11.3 MiB/hour over a twenty-minute
soak while not itself under load, and recorded it as an assumption rather than
a conclusion. This is the controlled re-run: the same image, idle, 30 minutes,
60 samples, queue depth 0 throughout, nothing else changing.

| | |
| --- | --- |
| First / last | 95.5 MiB → 104.7 MiB |
| Second-half slope | **−4.05 MiB/h** |
| Second-half spread | 4.70 MiB |
| Jobs in queue | 0 for all 60 samples |
| **Verdict** | **inconclusive** |

The important part is the sign. Over the second half the trend was *negative*
— memory rose during warm-up and then oscillated with a slight downward drift,
which is what a V8 heap settling and collecting looks like, not a leak. **The
20.6 growth did not reproduce.** The harness will not call it flat either,
because a ±4.7 MiB oscillation is wider than the band it reserves for that.

So: **inconclusive, with growth not reproduced.** Nothing was optimized — a
memory graph is not a bug report. Retained as post-v1 monitoring, with the
recommendation that the existing container-memory dashboard panel carry a
worker-RSS alert at a threshold an owner approves, so a real leak is noticed
by operations rather than by a benchmark.

---

## 24. Findings

### Release blockers fixed

| # | Finding | Evidence it is fixed |
| --- | --- | --- |
| 1 | **The published web image pointed every browser API call at the visitor's own machine** (`NEXT_PUBLIC_API_URL=http://localhost:4000` inlined into the client bundle) | five route shapes in Chromium through the proxy: every API call same-origin, zero `localhost:4000`; bundle scan clean, and it exits 65 on a bundle built the old way |
| 2 | **`PAYMENTS_ENABLED=false` prevented the API from starting** without Stripe credentials | 10 unit tests through the real module (6 fail without the fix) + a two-phase e2e proving history survives |

### High findings fixed

| # | Finding | Evidence |
| --- | --- | --- |
| 3 | Configuration errors echoed the rejected value into the boot log | a planted `sk_live_…` in a non-sensitive field no longer appears; the "in production" messages still read correctly |
| 4 | `trust proxy: 1` trusted a forwarded header from anybody, including direct callers; it feeds two throttles and every audit record | 9 e2e tests across three trust configurations; reverting fails 2 of them; 27 checks through the real proxy |
| 5 | The backup role could write through PUBLIC-executable SECURITY DEFINER functions | PUBLIC execute 0, application 151, backup 0; asserted by the backup verifier |
| 6 | **F-007** — no CSP and no HSTS on the only HTML origin | measured on real responses; zero CSP violations in a browser across five routes |

### Medium findings fixed

| # | Finding | Evidence |
| --- | --- | --- |
| 7 | `metricsEnabled()` accepted any string; `METRICS_ENABLED=no` left telemetry on | 15 tests; an unrecognized value now resolves to off |
| 8 | The proxy appended to a client-supplied `X-Forwarded-For` and passed `X-Forwarded-Host` and `Forwarded` through untouched | all overwritten; forgery proved ineffective through the proxy |
| 9 | Two test harnesses produced results that depended on their own ordering or on a mid-run schema change | both corrected and the dependency written down |

### Accepted v1 limitations

| Limitation | Why it is accepted |
| --- | --- |
| `script-src 'unsafe-inline'` on the web origin | a nonce cannot reach 23 prerendered routes; measured, not assumed. Every escalation path out of an injection is still closed. **P-015** |
| A trusted upstream on the deployment network can assert a client address | that is what `API_TRUSTED_PROXIES` grants, and the topology — no published API port — is the control. Narrowing to the load balancer's own addresses is documented |
| Redis carries no credential | it is not published and is reachable only on the internal network; recorded rather than implied |
| Postgres, Redis, MinIO and ClamAV keep default capabilities | third-party entrypoints need them; a managed deployment runs them as managed services |
| No read-only root filesystem | PalCert needs controlled writable paths |
| No bulk session invalidation (**F-014**) | unchanged from 20.1; an incident-response gap, not an exploitable defect |

### Findings from earlier checkpoints, reassessed

| Finding | Status after 20.7 |
| --- | --- |
| **F-007** — no CSP or HSTS on the web origin | **CLOSED** (§11) |
| **F-003** — `WEBHOOK_OWN_HOSTS` empty in production | **CLOSED as stale.** The own-host list is not the variable: `webhookOwnHosts` derives PalCert's public hostname from `APP_PUBLIC_WEB_URL` — which production requires to be https — and unions it with whatever the variable adds. An empty variable never meant "nothing is refused". Two tests now assert it so it cannot regress into the shape the finding described |
| **F-020** — no licence or container image scan in CI | **Part-closed.** The release workflow scans every runtime image (fixable HIGH/CRITICAL fail the release), produces an SBOM per image, and runs the secret scan with its negative self-test. **A licence scan is still absent** and stays POST-V1 |
| **F-010** — no React error boundaries | a resilience and UX finding, not a security one; out of scope here, stays POST-V1 |
| **F-011** — no accessibility linting | an accessibility finding, not a security one; stays POST-V1 |
| **F-014** — no bulk session invalidation | unchanged; incident-response gap, not an exploitable defect |

### Post-v1 hardening

- **P-015** — nonce or hash `script-src`, which needs the prerendered routes to become dynamic.
- **P-014** — worker-RSS alert threshold and a multi-hour soak with the worker under its own workload.
- **F-014** — bulk session invalidation for credential-compromise response.
- Per-function EXECUTE grants narrower than "all `app_*` to the application role".
- Validate the Next.js server's environment at boot, so its two direct reads go through a schema like everything else.
- A licence scan in CI, the remaining half of F-020.
- A static security analyser. Considered and **not added**: dependency, container, secret and licence scanning plus typed lint already cover this codebase's realistic findings, and a tool added for the checkbox is a tool whose output nobody reads.

---

## 25. Gates

All on the final committed tree, against the five rebuilt images.

| Gate | Result |
| --- | --- |
| `pnpm build` | pass |
| `pnpm typecheck` | pass |
| `pnpm lint` | pass |
| `pnpm format:check` | pass |
| Unit — contracts / config / database / web / api | **819 / 222 / 3 / 543 / 657** passed (5 skipped) |
| `pnpm py:lint` | pass |
| Python (document engine) | **1 792** passed, 85 skipped |
| `pnpm docs:check-phases` | pass |
| **Security regression suite** (8 groups) | **697** passed — upload-boundary 91, ssrf 84, isolation 233, api-clients 68, webhooks 98, finance 95, certificates 53, edge 75 |
| Configuration suite | 222 passed, including 63 boolean cases |
| RLS suite | 233 passed, HTTP and direct application-role SQL |
| **Production-proxy security smoke** | **27 of 27** through TLS |
| **Browser security regression** | 5 route shapes, 0 CSP violations, 0 off-origin API calls |
| Client-bundle placeholder scan | clean on the final web image; exits 65 on the old build |
| SBOM | generated for all five images (333 / 333 / 264 / 216 / 122 packages) |
| Vulnerability scan | **0 fixable HIGH/CRITICAL in all five**, nothing suppressed |
| Secret scan | clean in all five, configuration and layers |
| Secret-scanner negative self-test | both planted leak shapes detected; clean image still passes |
| Runtime toolchain gate | no package manager or build tooling in any runtime image |
| Backup-role verification | 14 of 15 (the one failure is a local-fixture password, not a contract) |
| Production images | all five build, deploy by digest and serve behind the proxy |
| **Full API e2e on the final tree** | **1 397 passed**, 10 skipped, 79 of 82 suites (3 skipped), 1 458 s — run once on `f2fb98b` from an empty schema migrated to head |

### One honest note about the scanned images

The images scanned here were built in this sandbox, whose build shim adds the
environment's own proxy CA so the build can reach the network. A CI-built
image does not carry it. The application bytes are the same; the trust store
differs by one certificate, and saying so is cheaper than letting someone
discover it later.

---

## 26. Statement

**No release-blocking security or configuration issues remain.**

Two release blockers were found and fixed, four high findings and three
medium, each with a test that fails without the fix. Six limitations are
accepted for v1 and stated with the reason and the cost. Five items are
recorded for post-v1, none of which is exploitable today.
