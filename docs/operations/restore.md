# Restore runbook

Rebuilding a PalCert installation from a backup. Written to be executable by an
operator who did not write the backup code.

**Read this whole page before starting.** The order is not arbitrary, and two
of the steps exist because the Checkpoint-20.4 drill found the failures they
prevent.

## Before you begin

| You need | Why |
| --- | --- |
| The backup directory | Both halves: `database/palcert.dump` and `objects/`. |
| A **clean** PostgreSQL database | The tool refuses a destination that already has a schema. |
| An object store with the three buckets | Quarantine, clean, derived. |
| **The runtime secrets** | See §4. Some of them are the difference between restored data and unreadable ciphertext. |
| The PalCert release that matches the backup | An older release cannot run a newer schema. |

## Abort conditions

Stop and escalate rather than pressing on if:

- `backup:verify` reports anything other than `OK`;
- the archive's manifest records `missingReferenced` or `checksumMismatches`
  above zero, and you have an older archive that does not;
- the destination database is not empty and you did not expect that;
- the restore reports a missing cluster role you cannot account for;
- `restore:verify` fails any check.

None of these is a reason to add `--allow-…`. Each flag exists so a decision
is deliberate and recorded; reaching for one to make an error go away is how a
partial recovery gets mistaken for a complete one.

---

## 1. Provision infrastructure

PostgreSQL, Redis and the object store. Redis starts **empty** — nothing is
restored into it, and nothing needs to be.

Create the buckets:

```bash
pnpm --filter @palcert/api storage:provision
```

## 2. Provision database roles

**Do this before the restore, not after.** Roles are cluster-level objects: the
dump records who owns what and who was granted what, but it cannot create the
roles themselves. Restoring into a fresh cluster without them fails part-way
through with a raw *"role does not exist"*, after the schema is half applied.

```bash
APP_DB_PASSWORD='…'     pnpm --filter @palcert/database provision-app-role
BACKUP_DB_PASSWORD='…'  pnpm --filter @palcert/database provision-backup-role
```

The restore checks this for you and names any role that is missing, before it
writes anything. If it does, come back here.

## 3. Validate the archive

Before touching the destination:

```bash
pnpm --filter @palcert/api backup:verify -- --from /var/backups/palcert/palcert-… --deep
```

## 4. Supply the runtime secrets

**Secrets are not in the backup.** That is deliberate — it is what makes an
archive safe to store off-site — and it means recovery is not complete without
them. They fall into three groups:

### Must be recovered, or data is unreadable

| Secret | What it seals | If lost |
| --- | --- | --- |
| `WEBHOOK_ENCRYPTION_KEYS` + `WEBHOOK_ENCRYPTION_ACTIVE_KID` | Every webhook URL and signing secret, under AES-256-GCM with a key id | **The API refuses to start.** Not a degraded mode — a refusal, by design. Every key id that any stored ciphertext references must be present, not merely the active one. |
| `AUTH_MFA_SECRET_KEY` | Every enrolled authenticator's TOTP secret | Every user with MFA is locked out and must re-enrol. |

The drill confirmed the webhook behaviour empirically: starting the API against
a restored database with a webhook endpoint in it and the wrong keyring
produced `WebhookKeyUnavailableError: webhook encryption key k2 is not
available`, and the process stopped. That is the right thing to do — delivering
under a key you cannot read is worse — but it means the keyring must travel
with your recovery plan.

### Should be rotated after a disaster

| Secret | Why rotation is safe |
| --- | --- |
| `API_CLIENT_REVEAL_SECRET_KEY` | Seals only the short-lived copy of a client secret kept so a lost HTTP response can be recovered. Rotating loses in-flight reveals and nothing else. API-client **authentication** does not depend on it: credentials are stored as verifiers. |
| `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET` | External-provider credentials. They gate no stored data. |

### Needed, but not for reading stored data

`CERTIFICATE_VERIFICATION_SECRET_KEY` seals the plaintext verification code
only while a certificate is being issued, and that ciphertext is erased in the
same statement that marks the certificate `ISSUED`. **Public verification of an
already-issued certificate does not use it**: the row keeps a SHA-256 of the
canonical code, and that hash is the only lookup authority. The drill proves
this — a restored installation verified a certificate whose code it had never
held. The key still matters for certificates caught mid-issuance.

## 5. Restore

```bash
pnpm --filter @palcert/api restore -- \
  --from /var/backups/palcert/palcert-… \
  --to-database "$RESTORE_DATABASE_ADMIN_URL" \
  --storage-prefix RESTORE_STORAGE
```

Nothing is written until the archive has been shown to be complete, the
destination has been shown to be clean, and every role the archive grants to
has been shown to exist.

Afterwards it recomputes the reference closure **from the restored database**
and checks every object it names — so the claim is about the installation in
front of you, not about what the archive said of itself.

**Object versions are re-pinned (Phase 20 Checkpoint 9).** PalCert reads every
finalized object by key *and* version id, which is what keeps a later
overwrite from changing what a report, certificate or download serves. No S3
API lets a writer choose a version id, so a restored object always comes back
under a new one. The restore therefore runs in this order:

1. tables and rows (`pg_restore` sections `pre-data` and `data`);
2. the objects, recording the version id the destination assigns to each;
3. every pinned column moved from the source's version id to the new one —
   before the immutability triggers exist, which would rightly refuse it;
4. indexes, constraints, triggers, policies and row-level security
   (`post-data`);
5. every reference read back **by its pinned version** and re-hashed.

The destination buckets must be versioned (`storage:provision` does this); a
restore into an unversioned bucket refuses with exit 78. Before this was
fixed, a restored installation served every row and failed every document
download, certificate read and report artifact with `NoSuchVersion` — found by
the v1 upgrade rehearsal, and now asserted by `disaster-recovery.e2e-spec.ts`.
If the restore fails between steps 1 and 4 the database has no row-level
security yet: do not start PalCert against it; drop it and restore again.

### Exit codes

| Code | Meaning |
| --- | --- |
| 0 | Restored and verified |
| 3 | The destination cluster is missing roles — go to §2 |
| 64 | Bad arguments |
| 65 | Archive unusable, destination not clean, or integrity failed |
| 69 | Destination unreachable |
| 70 | `pg_restore` failed |
| 78 | Missing configuration, or a destination bucket that is not versioned |

## 6. Verify migration compatibility

```bash
pnpm --filter @palcert/database migrations:check -- --url "$RESTORE_DATABASE_ADMIN_URL"
```

A database one migration behind the code starts, serves traffic, and fails only
on the paths that needed the missing object. If this reports pending
migrations, run the migration job now — before anything serves.

## 7. Verify integrity, with workers and ingress still down

```bash
pnpm --filter @palcert/api restore:verify -- \
  --database "$RESTORE_DATABASE_ADMIN_URL" \
  --migrations packages/database/prisma/migrations
```

**Do not start workers before this passes.** The first thing a worker does with
a half-restored installation is make it worse.

## 8. Start internal dependencies, then the application

In order: document engine → API → web. Not workers, and not ingress.

Keeping workers down is a deployment control, not an application feature:
start the application services by name, or scale the worker to zero, and leave
ingress closed at the proxy or load balancer.

## 9. Application verification

Work through the
[post-restore verification checklist](recovery-verification-checklist.md).

## 10. Start workers

Only once the restored state has been accepted. On start they will reap jobs
whose leases lapsed back to `PENDING` and republish from the ledger — Redis is
empty, and the outbox is what refills it.

Completed work is not repeated: a `SUCCEEDED` job is never claimable, which the
verification step checks explicitly.

## 11. Open ingress

Last.

## Related

- [Backup runbook](backup.md)
- [Disaster recovery runbook](disaster-recovery.md)
- [Post-restore verification checklist](recovery-verification-checklist.md)
