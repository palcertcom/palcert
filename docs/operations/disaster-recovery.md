# Disaster recovery runbook

What to do when something is gone. Each scenario says what was actually lost,
because the first question is always the same one: **is this rebuildable
infrastructure, or is it authoritative data?**

| | |
| --- | --- |
| **Authoritative data** | PostgreSQL rows, and the objects those rows point at. Losing these without a backup is unrecoverable. |
| **Rebuildable** | Redis, application containers, the proxy, the document engine, the malware scanner, the images themselves. Losing these costs availability, not information. |

---

## Database loss

**Authoritative.** Follow the [restore runbook](restore.md) end to end.

Recovery is to the instant of the last good backup and no finer — PalCert takes
scheduled logical backups, not continuous WAL archiving. Everything committed
after that backup is gone. Decide and record how much that is before you start,
so the organization learns it from you rather than from a customer.

## Object-storage loss

**Authoritative**, and the half people forget. Restored rows pointing at
missing objects are a failed restore, not a partial one: a document check whose
document is gone cannot be re-run, and a certificate whose PDF is gone cannot
be re-issued from the same claim.

If the database survived, restore only the objects and then run:

```bash
pnpm --filter @palcert/api restore:verify -- --database "$DATABASE_ADMIN_URL" \
  --migrations packages/database/prisma/migrations
```

If objects are missing and no backup has them, the affected rows are known
precisely — the reference closure names every one, with the table and row id.
Triage from that list rather than guessing.

## Application-node loss

**Rebuildable.** Start replacements. No data action. Workers pick up abandoned
jobs when their leases lapse and republish from the ledger.

## Redis loss

**Rebuildable, and proved to be.** Redis holds BullMQ transport messages
(identifiers only — the worker reloads everything from the database),
rate-limit counters, and a render cache. Durability lives in `processing_jobs`.

Start an empty Redis. The outbox dispatcher republishes due work on its timer;
the reaper returns jobs whose leases lapsed to `PENDING`. Nothing is restored
into Redis and nothing should be. The Checkpoint-20.4 drill started the
restored stack against a cold Redis and watched the worker become healthy and
the outbox refill it, with the `SUCCEEDED` count unchanged.

Rate-limit counters resetting means a caller briefly gets a fresh allowance.
That is the correct trade against holding them durably.

## Worker loss

**Rebuildable.** Jobs that were `DISPATCHED` or `RUNNING` when the worker died
keep their lease until it expires; the reaper then returns them to `PENDING`
with one attempt spent, or marks them `DEAD` if attempts are exhausted.
Start replacement workers; nothing else is needed.

## Corrupted deployment

**Rebuildable.** Roll back to the previous image per the
[deployment runbook](deployment.md). Do **not** restore the database to undo a
bad application release — the schema is forward-compatible within a release
line, and a restore would discard good customer work to fix a code problem.

If the bad release applied a migration, that is the one case where the database
is involved, and it needs a deliberate decision rather than a reflex.

## Leaked or rotated runtime secret

Which secret decides everything. See §4 of the [restore runbook](restore.md).

- **`WEBHOOK_ENCRYPTION_KEYS`** — do not simply replace it. Every stored
  ciphertext names the key id that sealed it, so add the new key, make it
  active, and **keep the old ones** until every row has been re-sealed.
  Removing a key id that stored data still references stops the API starting.
- **`EMAIL_SETTINGS_ENCRYPTION_KEYS`** — same rule as the webhook keyring:
  add, activate, keep old keys until the API key and webhook secret have been
  re-saved in the dashboard. It is not in any database backup; restore it from
  the secret store. If a leak is suspected, also revoke the Resend API key in
  Resend and enter a new one ([email operations](email-resend.md)).
- **`AUTH_MFA_SECRET_KEY`** — rotating invalidates every enrolled
  authenticator. Plan the re-enrolment before rotating, not after.
- **`API_CLIENT_REVEAL_SECRET_KEY`** — safe to rotate. Only in-flight secret
  reveals are lost; API-client authentication is verifier-based.
- **Stripe credentials** — rotate at the provider. No stored data depends on
  them.

## Accidental deletion

PalCert deletes objects as a recorded lifecycle step, and the database says so
(`quarantine_deleted_at`). An object missing *without* that marker is a
genuine dangling reference, and the backup reconciliation is what finds it.

Where bucket versioning is enabled — and it should be — a deleted object's
prior version is still retrievable by version id, which the database records
alongside the key. That is often faster than a restore and touches nothing
else.

## Partial database/object inconsistency

The diagnosis tool is the reference closure, and it is the same query the
backup and the restore use:

```bash
pnpm --filter @palcert/api restore:verify -- --database "$DATABASE_ADMIN_URL" \
  --migrations packages/database/prisma/migrations
```

It names each row whose object is missing or whose bytes no longer hash to what
PalCert recorded. From there:

- **object missing, row healthy** → restore that object from a backup, or from
  a prior version if the bucket is versioned;
- **object present, hash wrong** → the object was overwritten or corrupted.
  Do not repair in place; restore the recorded version.
- **row references an object that never existed** → a bug, not a disaster.
  Capture the row id and escalate; do not delete the row to make the check
  pass.

---

## What is not yet covered

Stated plainly, because a disaster-recovery document that implies more than
exists is worse than none:

- **No point-in-time recovery.** Scheduled logical backups only. The RPO is the
  backup interval.
- **No automated failover.** Recovery is a human procedure with automated
  steps, and its duration is dominated by decision-making, not by the tools.
- **No cross-region replication.** The off-site requirement is stated in the
  [backup runbook](backup.md); implementing it is a deployment decision.

## Related

- [Backup runbook](backup.md) · [Restore runbook](restore.md) ·
  [Verification checklist](recovery-verification-checklist.md) ·
  [Deployment](deployment.md)
