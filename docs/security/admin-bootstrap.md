# Creating the first PalCert administrator

_See ADR-0015._

A fresh deployment has no users. The first `PALCERT_ADMIN` is created by an
explicit command run by an operator with deployment access. There is **no HTTP
endpoint** for this, and there never will be.

## Procedure

```bash
# 1. Apply migrations (seeds the role and permission catalogue).
pnpm db:deploy

# 2. Promote or create the administrator.
PALCERT_BOOTSTRAP_ADMIN_EMAIL=ops@palcert.com \
PALCERT_BOOTSTRAP_ADMIN_PASSWORD='<chosen out of band>' \
node dist/cli/bootstrap-admin.js
```

Output names the address only. No password, token or secret is ever printed.

## What the command guarantees

| Property | Why |
| --- | --- |
| Idempotent | Safe to leave in a deployment pipeline; re-running promotes rather than fails |
| Never resets an existing password | Otherwise anyone who can run it could take over an existing administrator |
| Prints no secret | The password is supplied by the operator and never echoed |
| Account starts verified and `ACTIVE` | The operator controls that mailbox by definition |
| MFA still required | `PALCERT_ADMIN` requires a second factor; the account can do nothing until one is enrolled |
| Audited | Writes an `ADMIN_BOOTSTRAP` audit record and a `ROLE_ASSIGNED` security event |

## First sign-in

1. Sign in at `/{locale}/login` → the response is `MFA_ENROLLMENT_REQUIRED`.
2. The constrained pre-authentication session can reach **only** the enrollment
   endpoints.
3. Scan the QR code, enter a code to confirm. Confirmation completes the login.
4. **Store the ten recovery codes.** They are displayed once and cannot be
   retrieved later.

## Choosing the password

Supply it out of band (a password manager, a sealed secret). PalCert never
generates or displays one. Minimum length is `AUTH_PASSWORD_MIN_LENGTH`
(12); a long passphrase is preferred to a short complex string.

## Afterwards

- Grant further staff roles through `POST /api/v1/admin/users/:id/roles`. That
  route requires `admin:role:assign` plus a recently authenticated session.
- Rotate the bootstrap credentials out of the deployment environment once the
  administrator has signed in.
- `PALCERT_SUPPORT` cannot assign roles or suspend accounts by design — grant
  `PALCERT_ADMIN` only to those who genuinely need it.
