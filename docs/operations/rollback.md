# Rollback

`scripts/release/check-rollback-safety.mjs` and
`scripts/release/migration-preflight.sh` send operators here when they refuse.
The procedures themselves live beside the rest of the release process; this
page says which one applies.

| Situation | What to do | Where |
| --- | --- | --- |
| The release is bad; both releases expect the same schema | Roll the **application** back: deploy the earlier release's frozen digests with `deploy.sh` | [release-delivery.md §8](release-delivery.md#8-rolling-the-application-back) |
| The gate refused: the newer release applied a migration the earlier one does not know | **This is a decision, not a command.** Either confirm the extra migrations are additive and the earlier release tolerates them, then roll back the application with `--i-have-confirmed-schema-compatibility`; or forward-fix | [release-delivery.md §9](release-delivery.md#9-rollback-refused-because-of-the-database) |
| Rolling back to a release before institution service revenue (`20261024000000`) | Run `scripts/release/check-service-revenue-rollback.sh` as well as the schema gate. It reads the revenue records; rates set to 0% or frozen withdrawals do not make a rollback safe | [institution-service-revenue.md](../architecture/institution-service-revenue.md#rolling-the-application-back) |
| No earlier release is safe to run | Forward fix: a new release that corrects the fault | [deployment.md §4](deployment.md#4-rollback) |
| The data is damaged, not only the application | Restore from backup into a clean data plane, then deploy a release whose schema matches | [restore.md](restore.md), [disaster-recovery.md](disaster-recovery.md) |
| The images are needed and the registry lost them | Do not rebuild the commit; redeploy a release whose images survive | [release-delivery.md §10–11](release-delivery.md#10-emergency-redeploy-from-retained-artifacts) |

**PalCert has no down-migrations.** Going back across a migration is a restore,
never a reverse script. The rollback gate exists so that nobody discovers that
halfway through an incident.

Both halves are rehearsed: `scripts/release/rollback-rehearsal.sh` deploys a
prior release, upgrades it and rolls it back, asking the running system which
release it is at every step; `scripts/release/test-rollback-refusal.sh` shows
the gate refusing a target that predates a migration the database has applied.

This page was added in Checkpoint 20.9. Both scripts had named it before it
existed; the procedures were already documented under the links above.
