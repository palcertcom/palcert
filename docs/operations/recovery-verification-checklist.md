# Post-restore verification checklist

Run top to bottom. **Workers and ingress stay down until §3 passes.**

Most of this is automated; the commands are given so an operator can run them
one at a time and see each answer, rather than trusting a single exit code.

---

## 1. The archive, before anything is written

- [ ] `backup:verify --deep` reports `OK`
- [ ] The manifest records `reconciliation.missingReferenced = 0`
- [ ] The manifest records `reconciliation.checksumMismatches = 0`
- [ ] The dump's contents include row-level-security policies, functions and grants

## 2. The destination, before the restore

- [ ] The database has **zero** tables in schema `public`
- [ ] Every role the archive grants to exists on the destination cluster
- [ ] The three buckets exist
- [ ] Redis is empty and is expected to be

## 3. Integrity, before any worker runs

```bash
pnpm --filter @palcert/database migrations:check -- --url "$RESTORE_DATABASE_ADMIN_URL"
pnpm --filter @palcert/api restore:verify -- --database "$RESTORE_DATABASE_ADMIN_URL" \
  --migrations packages/database/prisma/migrations
```

- [ ] Migration history matches the code exactly; nothing half-applied
- [ ] Structural counts match the source: tables, RLS-forced tables, policies,
      security-definer functions, indexes, constraints, grants
- [ ] Row-level security is **FORCEd**, not merely enabled
- [ ] The application role's grant matrix is still **uneven** — a uniform one
      is a privilege escalation that looks healthy
- [ ] The application role is not a superuser and cannot bypass RLS
- [ ] Ledger: no duplicate entries, no negative balance, amounts still integers
- [ ] Certificates: every one keeps a 64-character verification-code hash,
      hashes are unique, issued ones keep their claim hash and carry **no**
      leftover staging ciphertext
- [ ] No `SUCCEEDED` job is left holding a lease
- [ ] Every object the restored rows reference is present and hashes to what
      PalCert recorded

## 4. Runtimes

- [ ] API `/health/ready` → 200
- [ ] Document engine `/health/ready` → 200
- [ ] Web healthy
- [ ] Through the published proxy: `/health/ready` → 200
- [ ] `/metrics` through the proxy → **404** (it is internal; see
      [observability](observability.md))

## 5. The data, through the application

- [ ] A document version still carries the SHA-256 PalCert recorded, and a
      clean object key
- [ ] A persisted analysis exists for **both** DOCX and PDF
- [ ] A check report's canonical hash is byte-for-byte what it was
- [ ] **Public certificate verification**: present a code issued before the
      disaster to `/api/v1/public/certificates/{code}` → 200, with the
      certificate number and organization, and the code not echoed back
- [ ] An unknown code → 404
- [ ] The balance recomputed from the append-only ledger equals the
      pre-disaster balance
- [ ] A paid check is still attached to its purchase
- [ ] An API client and a webhook endpoint still belong to their organization
      and to no other
- [ ] Webhook configuration is still sealed ciphertext, and the API started —
      which together mean the keyring was recovered correctly
- [ ] Notification and domain-event history is intact

## 6. Only now: workers

- [ ] Start workers
- [ ] Jobs whose leases lapsed return to `PENDING` and are republished from the
      ledger
- [ ] The `SUCCEEDED` count does **not** change — completed business work is
      not repeated
- [ ] Redis refills from the outbox; nothing was restored into it

## 7. Only now: ingress

- [ ] Open ingress
- [ ] Watch `palcert_metrics_collector_up`, queue depth and backlog age

---

## If a check fails

Stop. Do not open ingress. A restored installation that is *nearly* right is
more dangerous than one that is plainly down, because people will act on what
it tells them. Escalate with the failing check's exact output; every tool here
names what it found rather than only that it failed.
