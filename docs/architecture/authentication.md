# Authentication and session lifecycle

_Phase 1. See ADR-0011 (sessions), ADR-0012 (password hashing), ADR-0013 (MFA),
ADR-0014 (CSRF)._

## 1. Registration and verification

```
POST /auth/register
  ↓  password policy checked FIRST (identical work for new and existing addresses)
  ↓  user created: status = PENDING_VERIFICATION, role = SERVICE_USER (global)
  ↓  verification token issued (256-bit random; only its SHA-256 digest stored)
  ↓  mail produced through MailDeliveryPort
  ↓  202 Accepted — identical response whether or not the address existed

POST /auth/email/verify { token }
  ↓  token consumed atomically (conditional UPDATE; replay impossible)
  ↓  status PENDING_VERIFICATION → ACTIVE, email_verified_at set
```

Re-registering an existing address never modifies the account. It re-sends
verification only if the account is still awaiting it.

## 2. Login

```
POST /auth/login { email, password }
  ↓  throttle: per-IP and per-account counters consumed before any credential work
  ↓  email normalized (NFKC, lowercased)
  ↓  password verified — against a decoy hash when the account is unknown, so an
  │  unknown address costs roughly the same as a known one
  ↓  account status enforced   → ACCOUNT_SUSPENDED / ACCOUNT_DISABLED
  ↓  email verification enforced → EMAIL_NOT_VERIFIED
  ↓  account throttle counter cleared
  ↓  password rehashed if policy strengthened since it was written
  ↓  branch on MFA requirement
```

| Outcome | Session issued | Meaning |
| --- | --- | --- |
| `AUTHENTICATED` | `ACTIVE`, AAL1 | No second factor required |
| `MFA_REQUIRED` | `PENDING_MFA`, AAL1 | Answer the challenge |
| `MFA_ENROLLMENT_REQUIRED` | `PENDING_MFA`, AAL1 | Privileged account with no factor yet |

Every credential failure returns the single code `AUTHENTICATION_FAILED` with
one message. "Email unknown", "wrong password" and "malformed credentials" are
deliberately indistinguishable.

## 3. The pre-authentication state

A `PENDING_MFA` session is **not** an authenticated session. `SessionGuard`
rejects it on every route except those marked `@AllowsPendingMfa()` — the MFA
enrollment and challenge endpoints, and logout. It expires after
`AUTH_MFA_PENDING_MINUTES` (default 5).

Completing the challenge **rotates** the session: a new identifier is issued at
AAL2 and the pending one is revoked in the same operation. The pre-auth token is
useless afterwards.

## 4. Session lifecycle

```
create ─────► ACTIVE ──────► REVOKED
   │             ▲              ▲
   │             │              ├── logout / logout-all / revoke one
   └─► PENDING_MFA              ├── password change or reset
          (challenge)           ├── account suspended or disabled
                                └── idle or absolute expiry (reason = EXPIRED)
```

| Policy | Standard | Privileged |
| --- | --- | --- |
| Idle timeout | 60 min | 15 min |
| Absolute lifetime | 12 h | 8 h |

Idle expiry slides forward on each request, always bounded by the absolute
ceiling. Both are configuration, never constants in code.

**The revocation reason decides what the user is told.** Without that mapping
the answer would depend on which code path noticed first — a suspended user
might see "session revoked" from one request and "account suspended" from the
next.

| Reason | Error code |
| --- | --- |
| `EXPIRED` | `SESSION_EXPIRED` |
| `ACCOUNT_SUSPENDED` / `ACCOUNT_DISABLED` | `ACCOUNT_SUSPENDED` / `ACCOUNT_DISABLED` |
| `PASSWORD_CHANGED` / `PASSWORD_RESET` | `SESSION_REVOKED` ("your password changed") |
| everything else | `SESSION_REVOKED` |

## 5. When a session identifier changes

Sessions are replaced, never upgraded in place. A new identifier is issued on:

- successful login,
- MFA challenge completion,
- MFA enrollment confirmed from a pre-authentication session,
- password change.

This is what makes session fixation structurally impossible: a token an attacker
planted before authentication is never the token that ends up authenticated.

## 6. Password reset and change

| | Reset (forgotten) | Change (authenticated) |
| --- | --- | --- |
| Proof required | Emailed single-use token | Current password |
| Other sessions | All revoked | All revoked |
| This session | N/A — none exists | Rotated, stays usable |
| Response | Always 202, account existence never revealed | 200 |

## 7. Account status

```
PENDING_VERIFICATION ──verify──► ACTIVE ──suspend──► SUSPENDED
         │                          │                    │
         └──────disable─────────────┴────────────────────┴──► DISABLED (terminal)
                                                              ▲
                                            SUSPENDED ─reactivate─► ACTIVE
```

Leaving `ACTIVE` revokes every session immediately. Status is re-checked on
every request, not only at login, so a suspension takes effect on requests
already in flight.

## 8. What is never stored or logged

| Value | Storage |
| --- | --- |
| Password | Argon2id hash only |
| Session token | SHA-256 digest only |
| CSRF token | SHA-256 digest only |
| Verification / reset token | SHA-256 digest only |
| TOTP secret | AES-256-GCM ciphertext |
| Recovery code | SHA-256 digest only |

None of these appear in logs, security events, audit records or API responses.
Security-event metadata is filtered against a forbidden-key pattern before it is
written, so a careless caller cannot leak one by accident.
