# Backup runbook

What a PalCert backup is, how to take one, and how to know it is good — before
the day you need it.

## What a backup has to contain

Two halves that only mean something together:

| Half | Why |
| --- | --- |
| The PostgreSQL database | Every authoritative row: users, organizations, documents, analyses, reports, ledger entries, certificates, submissions, webhook configuration, API clients, the processing-job ledger. |
| The objects those rows point at | The document bytes themselves, and PalCert's own derived artifacts. Eleven columns across eight tables hold object keys; a row without its object is a reference to nothing. |

**Redis is deliberately not backed up.** It carries BullMQ transport messages
(identifiers only — the worker reloads everything from the database), rate-limit
counters, and a render cache. Durability lives in `processing_jobs`; the outbox
dispatcher republishes from it on a timer. PalCert starts correctly against an
empty Redis, and Checkpoint 20.4's drill proves it.

## Before the first backup: the backup role

```bash
BACKUP_DB_PASSWORD='<from the secret manager>' \
DATABASE_ADMIN_URL='postgresql://palcert:…@db:5432/palcert' \
  pnpm --filter @palcert/database provision-backup-role
```

The role is `palcert_backup`: **not a superuser**, no CREATEDB, no CREATEROLE,
`SELECT` only, owning nothing, with no `CREATE` on the schema. It does have
`BYPASSRLS`, and it has to: PalCert forces row-level security on 64 tables, so
without bypass capability `pg_dump` cannot read them. It does not fail quietly
— PostgreSQL refuses with *"query would be affected by row-level security
policy"* rather than writing 64 empty tables — but it does fail.

Verify the contract at any time:

```bash
BACKUP_DATABASE_URL='postgresql://palcert_backup:…@db:5432/palcert' \
  pnpm --filter @palcert/database verify-backup-role
```

That proves both directions: the application role **cannot** produce a backup,
and the dedicated role **can**, with rows in it.

## Taking a backup

```bash
pnpm --filter @palcert/api backup -- --out /var/backups/palcert
```

Reads `DATABASE_ADMIN_URL` (or the backup role's URL) and `STORAGE_*` from the
environment. Never prints a credential, a presigned URL, or any document's
content.

### What it does, and why the order matters

1. Opens a **repeatable-read** transaction and exports its snapshot id.
2. Runs `pg_dump --snapshot=<id>` against that same snapshot, so the dump is
   the database as it stood at one instant.
3. Reads the **reference closure** — every database-to-object reference —
   inside that same still-open transaction. The list of objects the backup must
   contain is therefore derived from the very rows that were dumped.
4. Copies those objects, by the exact version id the database recorded wherever
   one exists.
5. Reconciles, and refuses to call the result clean if any referenced object
   the database did not already record as deleted is absent.

Step 3 is what makes the two halves one unit. Step 5 is what makes the claim
checkable rather than hopeful.

### Exit codes

| Code | Meaning |
| --- | --- |
| 0 | Clean backup |
| 64 | Bad arguments |
| 65 | Dangling reference or checksum mismatch (see `--allow-dangling`) |
| 78 | Missing configuration |

## Validating a backup

**A zero exit from the backup command is not evidence.** Run the validator,
ideally as a scheduled job immediately after every backup:

```bash
pnpm --filter @palcert/api backup:verify -- --from /var/backups/palcert/palcert-… --deep
```

It needs no database and no object store. It checks that every component is
present, is the recorded length (a truncated transfer is named as *truncated*,
not merely "corrupt"), and matches its checksum; that the dump's own table of
contents is readable; and that the dump actually contains **row-level-security
policies, functions and grants** — a dump with tables but no policies would
restore an installation where every tenant could read every other tenant, and
would pass a row count.

`--deep` re-hashes every object. It costs a full read of the archive, which is
why it is a choice; use it on the scheduled validation, because silent
corruption on the backup medium is exactly what it catches.

## Schedule

Values below are **recommendations, not decisions**. Frequency and retention
are business choices about how much work may be lost and how long history must
be kept; an owner sets them.

| Setting | Recommended starting point | What it depends on |
| --- | --- | --- |
| Frequency | Every 6 hours | The chosen RPO. Scheduled logical backups cannot do better than the interval — see the limitation below. |
| Retention | 30 daily, 12 monthly | Regulatory requirements, and how far back a corruption might be noticed. |
| Off-site copy | Required | See below. |
| Encryption at rest | Required | The archive contains every document in the installation. |
| Immutability | Recommended | Object-lock or equivalent, so ransomware cannot rewrite history. |
| Restore drill | Quarterly, and after any schema-shaped release | A backup nobody has restored is a hypothesis. |

### Off-site is not optional

A backup on the same host, the same volume, or the same storage account as the
data it protects shares the failure that destroys both. Production backups must
land in a **separate failure domain** — a different region, a different
provider, or offline media — appropriate to the deployment. The release drill
simulates this with an independent database cluster and an independent object
store; that is a simulation, and production needs the real thing.

### Point-in-time recovery: what this is not

**Checkpoint 20.4 implements scheduled logical backups. It does not implement
WAL archiving or point-in-time recovery.** Recovery is to the instant of the
last good backup and no finer. Do not describe the current capability as PITR.

If an RPO shorter than the backup interval is required, continuous WAL
archiving is the mechanism, and it is a deployment-level addition: it needs
archive storage, a retention policy of its own, and its own restore drill.

## Backup security

- The archive contains every document in the installation. Treat it as the
  most sensitive artifact the deployment produces.
- Encrypt in transit and at rest. Restrict the storage location to the backup
  identity and the recovery operators.
- Separate the identity that *writes* backups from the one that *restores*
  them, so a compromised backup job cannot overwrite history.
- No tool here prints a credential, a presigned URL, or any document content;
  keep it that way when scripting around them.
- Secrets are **not** in the backup, which is deliberate and is what makes it
  safe to store. See the restore runbook for what must be recovered alongside
  it.

## Related

- [Restore runbook](restore.md)
- [Disaster recovery runbook](disaster-recovery.md)
- [Post-restore verification checklist](recovery-verification-checklist.md)
